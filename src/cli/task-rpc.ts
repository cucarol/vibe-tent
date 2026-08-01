// Task lifecycle commands via Local Service RPC (architecture §4 / task-api §3).
// External agent claim/deliver MUST go through this path — no direct core mutation.

import type { ServiceClient } from "../service/client.js";
import { attachOrBootstrapService, type CliAttachOptions } from "./service-attach.js";
import { ensureMountedWorkspace } from "./workspace-context.js";

export type TaskRpcGlobalOptions = {
  workspace?: string;
  cwd?: string;
  dataDir?: string;
  attachOnly?: boolean;
  serviceEntry?: string;
  packageRoot?: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injected client (tests); skips attach when set. */
  client?: ServiceClient;
};

export type TaskCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Run a `tent task <sub>` command. Returns structured result for tests;
 * CLI main prints and sets process.exitCode.
 */
export async function runTaskCommand(
  sub: string,
  args: string[],
  globals: TaskRpcGlobalOptions = {}
): Promise<TaskCommandResult> {
  try {
    const { positionals, flags, repeatable } = parseTaskFlags(args);
    const json = globals.json === true || flags.json === "true";
    const workspaceFlag = flags.workspace || globals.workspace;
    const attachOpts: CliAttachOptions = {
      dataDir: flags["data-dir"] || globals.dataDir,
      attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
      serviceEntry: flags["service-entry"] || globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env,
    };

    const client =
      globals.client ??
      (
        await attachOrBootstrapService(attachOpts)
      ).client;

    const ctx = await ensureMountedWorkspace(client, {
      cwd: globals.cwd,
      workspace: workspaceFlag,
    });
    const workspaceId = ctx.workspaceId;

    switch (sub) {
      case "list": {
        if (positionals.length > 0) {
          return failUsage("Usage: tent task list [--workspace <path>] [--json]");
        }
        const result = await client.taskList(workspaceId);
        return okPrint(result, json, formatTaskList);
      }
      case "get": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage("Usage: tent task get <taskPath> [--workspace <path>] [--json]");
        }
        const result = await client.taskGet(workspaceId, taskPath);
        return okPrint(result, json, (r) => formatTaskGet(r as { task: TaskLike }));
      }
      case "claim": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage(
            "Usage: tent task claim <taskPath> [--session <sessionId>] [--workspace <path>] [--json]"
          );
        }
        const sessionId = flags.session || flags["session-id"];
        const result = await client.taskClaim(workspaceId, taskPath, sessionId);
        return okPrint(result, json, (r) => {
          const row = r as { taskPath: string; state?: string; sessionId?: string };
          return (
            `✓ Claimed via service RPC\n` +
            `taskPath: ${row.taskPath}\n` +
            `state: ${row.state ?? "running"}\n` +
            (row.sessionId ? `sessionId: ${row.sessionId}\n` : "")
          );
        });
      }
      case "deliver": {
        const taskPath = positionals[0];
        if (!taskPath) {
          return failUsage(
            "Usage: tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--workspace <path>] [--json]"
          );
        }
        if (positionals.length > 1) {
          return failUsage(
            "Usage: tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--workspace <path>] [--json]"
          );
        }
        if (!Object.prototype.hasOwnProperty.call(flags, "summary")) {
          return failUsage("tent task deliver requires --summary <text> or --summary -");
        }
        let summary = flags.summary ?? "";
        if (summary === "-") summary = await readStdinText();
        if (!summary.trim()) {
          return failUsage("tent task deliver: --summary must be non-empty");
        }
        const commits = parseCommitsFlag(flags.commits);
        const result = await client.taskDeliver(workspaceId, taskPath, {
          summary,
          commits,
          decision: flags.decision,
        });
        return okPrint(result, json, (r) => {
          const row = r as {
            taskPath: string;
            state?: string;
            autoIntegrated?: boolean;
            delivery?: { id?: string; status?: string; path?: string };
          };
          return (
            `✓ Delivered via service RPC\n` +
            `taskPath: ${row.taskPath}\n` +
            `state: ${row.state ?? "delivered"}\n` +
            (row.delivery?.id ? `deliveryId: ${row.delivery.id}\n` : "") +
            (row.delivery?.status ? `deliveryStatus: ${row.delivery.status}\n` : "") +
            (row.autoIntegrated != null ? `autoIntegrated: ${row.autoIntegrated}\n` : "")
          );
        });
      }
      case "dispatch": {
        // Public ordinary dispatch (cx-b9bf58):
        //   tent task dispatch --target role:<id>|route:<routeId> --node <nodeId>… --prompt <text>|-
        // Node refs map to transient RPC nodeIds[] (→ contextCard.refs.nodes sole persist).
        // Settings route ids are the public machine execution selector.
        const usage =
          "Usage: tent task dispatch --target role:<roleIdOrName>|route:<routeId> --node <nodeId> [--node <nodeId> ...] --prompt <text>|- [--workspace <path>] [--json]";

        const retiredPublic = detectRetiredDispatchFlags(flags);
        if (retiredPublic) {
          return failUsage(
            `Public ordinary dispatch no longer accepts ${retiredPublic}; ` +
              `use --target role:<roleIdOrName>|route:<routeId> with --node and --prompt.\n` +
              usage
          );
        }
        if (positionals.length > 0) {
          return failUsage(
            "Public ordinary dispatch no longer accepts positional <boxId> <role> grammar; " +
              "use --target and --node.\n" +
              usage
          );
        }

        const targetRaw = String(flags.target ?? "").trim();
        if (!targetRaw) {
          return failUsage(`--target is required\n${usage}`);
        }
        const targetMatch = /^(role|route):(.+)$/i.exec(targetRaw);
        if (!targetMatch) {
          return failUsage(
            `--target must be role:<roleIdOrName> or route:<routeId> (got ${JSON.stringify(targetRaw)})\n` +
              usage
          );
        }
        const targetKind = targetMatch[1]!.toLowerCase() as "role" | "route";
        const targetId = targetMatch[2]!.trim();
        if (!targetId) {
          return failUsage(
            `--target ${targetKind}: requires a non-empty id\n${usage}`
          );
        }

        const rawNodes = repeatable.node ?? [];
        // Every --node occurrence must be non-empty; do not silently drop blanks
        // when another valid Node is present in the same batch.
        for (const value of rawNodes) {
          if (!String(value ?? "").trim()) {
            return failUsage(
              `Every --node value must be a non-empty nodeId (got empty/whitespace)\n${usage}`
            );
          }
        }
        const nodeIds = collectDispatchNodeIds(rawNodes);
        if (nodeIds.length === 0) {
          return failUsage(
            `At least one --node <nodeId> is required in this batch\n${usage}`
          );
        }

        if (!Object.prototype.hasOwnProperty.call(flags, "prompt")) {
          return failUsage(`--prompt is required (<text> or -)\n${usage}`);
        }
        let prompt = flags.prompt ?? "";
        if (prompt === "-") prompt = await readStdinText();
        if (!prompt.trim()) {
          return failUsage("tent task dispatch: --prompt must be non-empty");
        }

        // Caller authority from environment / current actor only (no public --by / --as-sub).
        // Role caller → parentActor=reviewer=that Role + callerKind=role (downstream review).
        // User-direct → parentActor=reviewer=user + callerKind=user.
        // Git-lane meaning of asSub is derived, not a public knob: Role caller dispatching
        // role:* or route:* → asSub:true (Task targets parent Role lane); user-direct omits it.
        const envRole = String(
          (globals.env?.TENT_ROLE ?? process.env.TENT_ROLE ?? "") as string
        ).trim();
        const roleCaller = Boolean(envRole && envRole !== "user");
        const parentActor = roleCaller
          ? ({ kind: "role" as const, id: envRole })
          : ({ kind: "user" as const, id: "user" });
        const callerKind: "user" | "role" = roleCaller ? "role" : "user";
        const asSub = roleCaller ? true : undefined;

        // Internal RPC fields required by current Service wire only:
        // - role target: durable Role handoff, queued, never startSession
        // - route target: current Service wire uses profileId + assigneeKind=agentProfile +
        //   startSession for the selected Settings route.
        // nodeIds is the sole public Node selection and persists only through
        // Context Card refs.nodes. No single-Node compatibility field is emitted.
        const common = {
          nodeIds,
          prompt,
          parentActor,
          reviewer: parentActor,
          callerKind,
          ...(asSub ? { asSub: true as const } : {}),
        };
        const dispatchArgs =
          targetKind === "role"
            ? {
                ...common,
                role: targetId,
              }
            : {
                ...common,
                assigneeKind: "agentProfile" as const,
                profileId: targetId,
                startSession: true as const,
              };

        const result = await client.taskDispatch(workspaceId, dispatchArgs);
        return okPrint(result, json, (r) => formatTaskDispatch(r));
      }
      case "accept": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage(
            "Usage: tent task accept <taskPath> --actor <user|role> [--commits sha,sha] [--outputs id,id] [--workspace <path>] [--json]"
          );
        }
        const actor = flags.actor || flags.by || process.env.TENT_ROLE;
        if (!actor) return failUsage("tent task accept requires --actor <user|role>");
        const commits = parseCommitsFlag(flags.commits);
        const outputNodeIds =
          parseCommitsFlag(flags.outputs) ?? parseCommitsFlag(flags["output-ids"]);
        const result = await client.taskAccept(workspaceId, taskPath, actor, commits, {
          outputNodeIds,
        });
        return okPrint(result, json, (r) => {
          const row = r as {
            taskPath: string;
            state?: string;
            boundOutputIds?: string[];
          };
          const bound =
            row.boundOutputIds && row.boundOutputIds.length
              ? `boundOutputs: ${row.boundOutputIds.join(",")}\n`
              : "";
          return (
            `✓ Accepted via service RPC\n` +
            `taskPath: ${row.taskPath}\n` +
            `state: ${row.state ?? "accepted"}\n` +
            bound
          );
        });
      }
      case "reject": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage(
            "Usage: tent task reject <taskPath> --actor <user|role> [--note <text>] [--resume|--no-resume] [--workspace <path>] [--json]"
          );
        }
        const actor = flags.actor || flags.by || process.env.TENT_ROLE;
        if (!actor) return failUsage("tent task reject requires --actor <user|role>");
        const resume =
          flags.resume === "true" ? true : flags["no-resume"] === "true" ? false : undefined;
        const result = await client.taskReject(workspaceId, taskPath, actor, {
          note: flags.note,
          resume,
        });
        return okPrint(result, json, (r) => {
          const row = r as { taskPath: string; state?: string };
          return `✓ Rejected via service RPC\ntaskPath: ${row.taskPath}\nstate: ${row.state ?? "?"}\n`;
        });
      }
      case "cancel": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage("Usage: tent task cancel <taskPath> [--workspace <path>] [--json]");
        }
        const result = await client.taskCancel(workspaceId, taskPath);
        return okPrint(result, json, (r) => {
          const row = r as { taskPath: string; state?: string };
          return `✓ Cancelled via service RPC\ntaskPath: ${row.taskPath}\nstate: ${row.state ?? "interrupted"}\n`;
        });
      }
      case "interrupt": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage("Usage: tent task interrupt <taskPath> [--workspace <path>] [--json]");
        }
        const result = await client.taskInterrupt(workspaceId, taskPath);
        return okPrint(result, json, (r) => {
          const row = r as { taskPath: string; task?: { state?: string }; state?: string };
          return (
            `✓ Interrupted via service RPC\n` +
            `taskPath: ${row.taskPath}\n` +
            `state: ${row.task?.state ?? row.state ?? "interrupted"}\n`
          );
        });
      }
      case "ask-user":
      case "askUser": {
        const taskPath = positionals[0];
        if (!taskPath) {
          return failUsage(
            "Usage: tent task ask-user <taskPath> --question <text>|- [--choices id=label,id=label] [--workspace <path>] [--json]"
          );
        }
        if (!Object.prototype.hasOwnProperty.call(flags, "question")) {
          return failUsage("tent task ask-user requires --question <text> or --question -");
        }
        let question = flags.question ?? "";
        if (question === "-") question = await readStdinText();
        if (!question.trim()) {
          return failUsage("tent task ask-user: --question must be non-empty");
        }
        const choices = parseChoicesFlag(flags.choices);
        const result = await client.taskAskUser(workspaceId, taskPath, {
          question,
          choices,
        });
        return okPrint(result, json, (r) => {
          const row = r as {
            taskPath: string;
            state?: string;
            ask?: { id?: string; question?: string; status?: string };
          };
          return (
            `✓ UserAsk created via service RPC\n` +
            `taskPath: ${row.taskPath}\n` +
            `state: ${row.state ?? "waiting"}\n` +
            (row.ask?.id ? `askId: ${row.ask.id}\n` : "") +
            (row.ask?.status ? `askStatus: ${row.ask.status}\n` : "")
          );
        });
      }
      case "user-ask":
      case "userAsk": {
        // tent task user-ask list|get|reply|deny
        const action = positionals[0];
        if (!action || action === "list") {
          const result = await client.userAskListPending(workspaceId);
          return okPrint(result, json, (r) => formatUserAskList(r));
        }
        if (action === "get") {
          const askId = positionals[1];
          if (!askId) {
            return failUsage(
              "Usage: tent task user-ask get <askId> [--workspace <path>] [--json]"
            );
          }
          const result = await client.userAskGet(askId);
          return okPrint(result, json, (r) => formatUserAskGet(r));
        }
        if (action === "reply") {
          const askId = positionals[1];
          if (!askId) {
            return failUsage(
              "Usage: tent task user-ask reply <askId> [--answer <text>|-] [--choice <id>] [--workspace <path>] [--json]"
            );
          }
          let answer = flags.answer;
          if (answer === "-") answer = await readStdinText();
          const choiceId = flags.choice || flags["choice-id"] || flags.choiceId;
          if (!(answer?.trim() || choiceId?.trim())) {
            return failUsage(
              "tent task user-ask reply requires --answer and/or --choice"
            );
          }
          const result = await client.userAskReply(askId, {
            answer,
            choiceId,
            actor: flags.actor || "user",
          });
          return okPrint(result, json, (r) => {
            const row = r as {
              ask?: { id?: string; status?: string };
              state?: string;
              continued?: boolean;
            };
            return (
              `✓ UserAsk answered via service RPC\n` +
              (row.ask?.id ? `askId: ${row.ask.id}\n` : "") +
              (row.ask?.status ? `askStatus: ${row.ask.status}\n` : "") +
              (row.state ? `taskState: ${row.state}\n` : "") +
              (row.continued != null ? `continued: ${row.continued}\n` : "")
            );
          });
        }
        if (action === "deny") {
          const askId = positionals[1];
          if (!askId) {
            return failUsage(
              "Usage: tent task user-ask deny <askId> [--workspace <path>] [--json]"
            );
          }
          const result = await client.userAskDeny(askId, flags.actor || "user");
          return okPrint(result, json, (r) => {
            const row = r as {
              ask?: { id?: string; status?: string };
              state?: string;
            };
            return (
              `✓ UserAsk denied via service RPC\n` +
              (row.ask?.id ? `askId: ${row.ask.id}\n` : "") +
              (row.ask?.status ? `askStatus: ${row.ask.status}\n` : "") +
              (row.state ? `taskState: ${row.state}\n` : "")
            );
          });
        }
        return failUsage(
          "Usage: tent task user-ask list|get|reply|deny …\n" + taskHelpText()
        );
      }
      case "send-input":
      case "sendInput": {
        const taskPath = positionals[0];
        if (!taskPath) {
          return failUsage(
            "Usage: tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]"
          );
        }
        let text = flags.text;
        if (text === "-") text = await readStdinText();
        const contextRefs = parseRefsFlag(
          flags.refs || flags["context-refs"] || flags.contextRefs
        );
        if (!(text?.trim() || (contextRefs && contextRefs.length > 0))) {
          return failUsage(
            "tent task send-input requires --text and/or --refs (stable entity ids)"
          );
        }
        const result = await client.taskSendInput(workspaceId, taskPath, {
          text,
          contextRefs,
          actor: flags.actor || "user",
        });
        return okPrint(result, json, (r) => {
          const row = r as {
            taskPath?: string;
            state?: string;
            input?: { id?: string; status?: string };
            accepted?: boolean;
            enqueued?: boolean;
            continued?: boolean;
            continueError?: string;
          };
          return (
            `✓ TaskInput accepted via service RPC\n` +
            `taskPath: ${row.taskPath ?? taskPath}\n` +
            (row.state ? `state: ${row.state}\n` : "") +
            (row.input?.id ? `inputId: ${row.input.id}\n` : "") +
            (row.input?.status ? `inputStatus: ${row.input.status}\n` : "") +
            (row.accepted != null ? `accepted: ${row.accepted}\n` : "") +
            (row.enqueued != null ? `enqueued: ${row.enqueued}\n` : "") +
            (row.continued != null ? `continued: ${row.continued}\n` : "") +
            (row.continueError ? `continueError: ${row.continueError}\n` : "")
          );
        });
      }
      case "task-input":
      case "taskInput": {
        // tent task task-input list|get|ack — always workspace-scoped via --workspace
        const action = positionals[0];
        if (!action || action === "list") {
          const taskPathFilter =
            flags.task ||
            flags["task-path"] ||
            flags.taskPath ||
            positionals[1];
          if (!taskPathFilter) {
            return failUsage(
              "Usage: tent task task-input list <taskPath> | --task <taskPath> [--workspace <path>] [--json]"
            );
          }
          const result = await client.taskInputListPending(
            workspaceId,
            taskPathFilter
          );
          return okPrint(result, json, (r) => formatTaskInputList(r));
        }
        if (action === "get") {
          const inputId = positionals[1];
          const taskPathFilter =
            flags.task || flags["task-path"] || flags.taskPath;
          if (!inputId || !taskPathFilter) {
            return failUsage(
              "Usage: tent task task-input get <inputId> --task <taskPath> [--workspace <path>] [--json]"
            );
          }
          const result = await client.taskInputGet(
            workspaceId,
            taskPathFilter,
            inputId
          );
          return okPrint(result, json, (r) => formatTaskInputGet(r));
        }
        if (action === "ack") {
          const inputId = positionals[1];
          const taskPathFilter =
            flags.task || flags["task-path"] || flags.taskPath;
          if (!inputId || !taskPathFilter) {
            return failUsage(
              "Usage: tent task task-input ack <inputId> --task <taskPath> [--actor <role|sessionId>] [--workspace <path>] [--json]"
            );
          }
          const result = await client.taskInputAck(
            workspaceId,
            taskPathFilter,
            inputId,
            flags.actor
          );
          return okPrint(result, json, (r) => {
            const row = r as {
              input?: { id?: string; status?: string; taskPath?: string };
            };
            return (
              `✓ TaskInput acked via service RPC\n` +
              (row.input?.id ? `inputId: ${row.input.id}\n` : "") +
              (row.input?.status ? `status: ${row.input.status}\n` : "") +
              (row.input?.taskPath ? `taskPath: ${row.input.taskPath}\n` : "")
            );
          });
        }
        return failUsage(
          "Usage: tent task task-input list|get|ack …\n" + taskHelpText()
        );
      }
      case "help":
      case "--help":
      case "-h":
        return { exitCode: 0, stdout: taskHelpText(), stderr: "" };
      default:
        return failUsage(
          `Unknown task subcommand: ${sub || "(empty)"}\n` + taskHelpText()
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}

type TaskLike = {
  path?: string;
  id?: string;
  role?: string;
  state?: string;
  status?: string;
  /** Node ids from TaskProjection.referencedNodeIds (Context Card refs). */
  referencedNodeIds?: string[];
  sessionId?: string;
  prompt?: string;
};

/** Human-readable dispatch result; prints managed Session id/state when present. */
function formatTaskDispatch(result: unknown): string {
  const row = result as {
    taskPath: string;
    state?: string;
    relayPrompt?: string;
    asSub?: boolean;
    parentActor?: { kind?: string; id?: string };
    reviewer?: { kind?: string; id?: string };
    assigneeKind?: string;
    assignee?: string;
    session?:
      | {
          sessionId?: string;
          id?: string;
          state?: string;
          profileId?: string;
          session?: {
            sessionId?: string;
            id?: string;
            state?: string;
            profileId?: string;
          };
        }
      | null;
  };
  // task.dispatch with startSession nests projectStartSessionResult under `session`,
  // whose own `session` field holds sessionId/state. Accept a flat shape too.
  const nested = row.session && "session" in row.session ? row.session.session : undefined;
  const sessionView = nested ?? row.session ?? undefined;
  const sessionId =
    sessionView && (sessionView.sessionId || sessionView.id)
      ? String(sessionView.sessionId || sessionView.id)
      : undefined;
  const sessionState = sessionView?.state ? String(sessionView.state) : undefined;
  const sessionProfileId = sessionView?.profileId ? String(sessionView.profileId) : undefined;
  const parentLabel =
    row.parentActor?.kind && row.parentActor?.id
      ? `${row.parentActor.kind}:${row.parentActor.id}`
      : undefined;
  const reviewerLabel =
    row.reviewer?.kind && row.reviewer?.id
      ? `${row.reviewer.kind}:${row.reviewer.id}`
      : undefined;

  return (
    `✓ Dispatched via service RPC\n` +
    `taskPath: ${row.taskPath}\n` +
    `state: ${row.state ?? "queued"}\n` +
    (row.assigneeKind ? `assigneeKind: ${row.assigneeKind}\n` : "") +
    (row.assignee ? `assignee: ${row.assignee}\n` : "") +
    (parentLabel ? `parentActor: ${parentLabel}\n` : "") +
    (reviewerLabel ? `reviewer: ${reviewerLabel}\n` : "") +
    (row.asSub ? `asSub: true\n` : "") +
    (sessionId ? `sessionId: ${sessionId}\n` : "") +
    (sessionState ? `sessionState: ${sessionState}\n` : "") +
    (sessionProfileId ? `sessionProfileId: ${sessionProfileId}\n` : "") +
    (row.relayPrompt ? `\n--- Relay prompt ---\n${row.relayPrompt}` : "")
  );
}

function formatTaskList(result: unknown): string {
  const row = result as { workspaceId?: string; tasks?: TaskLike[] };
  const tasks = row.tasks ?? [];
  if (tasks.length === 0) {
    return `workspaceId: ${row.workspaceId ?? "?"}\ntasks: (none)\n`;
  }
  const lines = [`workspaceId: ${row.workspaceId ?? "?"}`, `tasks: ${tasks.length}`, ""];
  for (const t of tasks) {
    lines.push(
      `- ${t.path ?? t.id ?? "?"}` +
        `\tstate=${t.state ?? t.status ?? "?"}` +
        `\trole=${t.role ?? "?"}` +
        `\tnodes=${(t.referencedNodeIds ?? []).join(",") || "-"}` +
        (t.sessionId ? `\tsession=${t.sessionId}` : "")
    );
  }
  return lines.join("\n") + "\n";
}

function formatTaskGet(result: { task: TaskLike }): string {
  const t = result.task;
  const lines = [
    `path: ${t.path ?? "?"}`,
    `id: ${t.id ?? "?"}`,
    `role: ${t.role ?? "?"}`,
    `state: ${t.state ?? t.status ?? "?"}`,
    `status: ${t.status ?? "?"}`,
    `nodes: ${(t.referencedNodeIds ?? []).join(", ") || "-"}`,
  ];
  if (t.sessionId) lines.push(`sessionId: ${t.sessionId}`);
  if (t.prompt) {
    lines.push("", "--- prompt ---", t.prompt.trimEnd());
  }
  return lines.join("\n") + "\n";
}

function okPrint(
  result: unknown,
  json: boolean,
  human: (r: unknown) => string
): TaskCommandResult {
  const stdout = json ? JSON.stringify(result, null, 2) + "\n" : human(result);
  return { exitCode: 0, stdout, stderr: "" };
}

function failUsage(msg: string): TaskCommandResult {
  return { exitCode: 1, stdout: "", stderr: msg + "\n" };
}

function parseCommitsFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const commits = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return commits;
}

/** Parse `id=label,id=label` into UserAsk choices. */
function parseChoicesFlag(
  raw: string | undefined
): Array<{ id: string; label: string }> | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  const choices: Array<{ id: string; label: string }> = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid --choices entry (expected id=label): ${trimmed}`);
    }
    const id = trimmed.slice(0, eq).trim();
    const label = trimmed.slice(eq + 1).trim();
    if (!id || !label) {
      throw new Error(`Invalid --choices entry (empty id/label): ${trimmed}`);
    }
    choices.push({ id, label });
  }
  return choices.length ? choices : undefined;
}

/** Parse `id,id` into U2A contextRefs (stable entity ids). */
function parseRefsFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    refs.push(id);
  }
  return refs.length ? refs : undefined;
}

function formatUserAskList(result: unknown): string {
  const row = result as {
    asks?: Array<{
      id?: string;
      taskPath?: string;
      question?: string;
      status?: string;
    }>;
  };
  const asks = row.asks ?? [];
  if (asks.length === 0) return "asks: (none)\n";
  const lines = [`asks: ${asks.length}`, ""];
  for (const a of asks) {
    lines.push(
      `- ${a.id ?? "?"}` +
        `\ttask=${a.taskPath ?? "?"}` +
        `\tstatus=${a.status ?? "?"}` +
        `\tq=${(a.question ?? "").slice(0, 80)}`
    );
  }
  return lines.join("\n") + "\n";
}

function formatUserAskGet(result: unknown): string {
  const row = result as {
    ask?: {
      id?: string;
      taskPath?: string;
      question?: string;
      status?: string;
      answer?: string;
      choiceId?: string;
      choices?: Array<{ id: string; label: string }>;
    };
  };
  const a = row.ask ?? {};
  const lines = [
    `id: ${a.id ?? "?"}`,
    `taskPath: ${a.taskPath ?? "?"}`,
    `status: ${a.status ?? "?"}`,
    `question: ${a.question ?? ""}`,
  ];
  if (a.choiceId) lines.push(`choiceId: ${a.choiceId}`);
  if (a.answer) lines.push(`answer: ${a.answer}`);
  if (a.choices?.length) {
    lines.push("choices:");
    for (const c of a.choices) lines.push(`  - ${c.id}=${c.label}`);
  }
  return lines.join("\n") + "\n";
}

function formatTaskInputList(result: unknown): string {
  const row = result as {
    inputs?: Array<{
      id?: string;
      taskPath?: string;
      status?: string;
      text?: string;
      contextRefs?: string[];
      lastError?: string;
      uncertainAt?: string;
    }>;
  };
  const inputs = row.inputs ?? [];
  if (inputs.length === 0) return "inputs: (none)\n";
  const lines = [`inputs: ${inputs.length}`, ""];
  for (const i of inputs) {
    const preview =
      (i.text ?? "").slice(0, 60) ||
      (i.contextRefs?.length ? `refs=${i.contextRefs.join(",")}` : "");
    lines.push(
      `- ${i.id ?? "?"}` +
        `\ttask=${i.taskPath ?? "?"}` +
        `\tstatus=${i.status ?? "?"}` +
        (i.uncertainAt ? `\tuncertainAt=${i.uncertainAt}` : "") +
        (i.lastError ? `\terror=${i.lastError.slice(0, 80)}` : "") +
        (preview ? `\t${preview}` : "")
    );
  }
  return lines.join("\n") + "\n";
}

function formatTaskInputGet(result: unknown): string {
  const row = result as {
    input?: {
      id?: string;
      workspaceId?: string;
      taskPath?: string;
      status?: string;
      text?: string;
      contextRefs?: string[];
      deliveredAt?: string;
      consumedAt?: string;
      cancelledAt?: string;
    };
  };
  const i = row.input ?? {};
  const lines = [
    `id: ${i.id ?? "?"}`,
    `workspaceId: ${i.workspaceId ?? "?"}`,
    `taskPath: ${i.taskPath ?? "?"}`,
    `status: ${i.status ?? "?"}`,
  ];
  if (i.text) lines.push(`text: ${i.text}`);
  if (i.contextRefs?.length) lines.push(`contextRefs: ${i.contextRefs.join(", ")}`);
  if (i.deliveredAt) lines.push(`deliveredAt: ${i.deliveredAt}`);
  if (i.consumedAt) lines.push(`consumedAt: ${i.consumedAt}`);
  if (i.cancelledAt) lines.push(`cancelledAt: ${i.cancelledAt}`);
  return lines.join("\n") + "\n";
}

const BOOLEAN_FLAGS = new Set([
  "json",
  "attach-only",
  "resume",
  "no-resume",
  "yes",
  "as-sub",
]);

/** Flags that may appear more than once (values collected in order). */
const REPEATABLE_FLAGS = new Set(["node"]);

/**
 * Retired public ordinary-dispatch knobs (cx-b9bf58). Detected for fail-loud rejection.
 * No compatibility alias — use --target / --node / --prompt only.
 */
const RETIRED_PUBLIC_DISPATCH_FLAGS: Array<{ flag: string; aliases: string[] }> = [
  { flag: "--profile", aliases: ["profile"] },
  { flag: "--agent", aliases: ["agent"] },
  { flag: "--delivery-policy", aliases: ["delivery-policy", "deliveryPolicy"] },
  { flag: "--as-sub", aliases: ["as-sub", "asSub"] },
  { flag: "--by", aliases: ["by", "from", "dispatched-by", "dispatchedBy"] },
  { flag: "--caller-kind", aliases: ["caller-kind", "callerKind"] },
  { flag: "--assignee-kind", aliases: ["assignee-kind", "assigneeKind"] },
];

function detectRetiredDispatchFlags(flags: Record<string, string>): string | null {
  for (const entry of RETIRED_PUBLIC_DISPATCH_FLAGS) {
    for (const alias of entry.aliases) {
      if (Object.prototype.hasOwnProperty.call(flags, alias)) {
        return entry.flag;
      }
    }
  }
  return null;
}

/** Deduplicate --node values while preserving first-seen order. */
function collectDispatchNodeIds(raw: string[] | undefined): string[] {
  const nodes: string[] = [];
  const seen = new Set<string>();
  for (const value of raw ?? []) {
    const id = String(value ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nodes.push(id);
  }
  return nodes;
}

export function parseTaskFlags(args: string[]): {
  positionals: string[];
  flags: Record<string, string>;
  /** Multi-value flags (e.g. repeated --node). */
  repeatable: Record<string, string[]>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const repeatable: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = "true";
      } else if (REPEATABLE_FLAGS.has(name)) {
        const value = args[i + 1] ?? "";
        i++;
        if (!repeatable[name]) repeatable[name] = [];
        repeatable[name]!.push(value);
        // Last occurrence also lands in flags for simple presence checks.
        flags[name] = value;
      } else {
        flags[name] = args[i + 1] ?? "";
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags, repeatable };
}

function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export function taskHelpText(): string {
  return `tent task — collaboration lifecycle via Local Service (RPC)

New-architecture path: attach → mount workspace → task.* RPC.
Local Service is the sole mutation entry; CLI does not kill the service on exit.

Commands:
  tent task list [--workspace <path>] [--json]
  tent task get <taskPath> [--workspace <path>] [--json]
  tent task claim <taskPath> [--session <sessionId>] [--workspace <path>] [--json]
  tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--workspace <path>] [--json]
  tent task dispatch --target role:<roleIdOrName>|route:<routeId> --node <nodeId> [--node <nodeId> ...] --prompt <text>|- [--workspace <path>] [--json]
      # --target role:*  durable Role handoff (queued; never starts managed ACP at dispatch)
      # --target route:* machine Settings route + managed Session start
      # --node           repeatable Node refs (at least one); sole source for contextCard.refs.nodes
      # parentActor/reviewer from TENT_ROLE (role caller) or user-direct; no public --by
      # Role caller also derives internal asSub (parent Role Git lane); not a public flag
      # Rejected (no alias): --profile, --agent, --delivery-policy, --as-sub, --by, --caller-kind,
      #   --assignee-kind, and old positional <boxId> <role> grammar
  tent task accept <taskPath> --actor <user|role> [--commits sha,sha] [--workspace <path>] [--json]
  tent task reject <taskPath> --actor <user|role> [--note <text>] [--resume|--no-resume] [--workspace <path>] [--json]
  tent task cancel <taskPath> [--workspace <path>] [--json]
  tent task interrupt <taskPath> [--workspace <path>] [--json]
  tent task ask-user <taskPath> --question <text>|- [--choices id=label,…] [--workspace <path>] [--json]
  tent task user-ask list|get <askId>|reply <askId>|deny <askId> […] [--workspace <path>] [--json]
  tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]
  tent task task-input list <taskPath>|get <inputId>|ack <inputId> --task <taskPath> [--actor <role|sessionId>] [--workspace <path>] [--json]

Service options:
  --data-dir <path>       Machine-local service data area (default: %APPDATA%/Tent)
  --attach-only           Fail if no healthy service (do not bootstrap)
  --service-entry <path>  Path to service.mjs when bootstrapping

Task mutations are Local Service RPC only. Formal delivery is Delivery-only
via tent task deliver (no direct-core or report compatibility path).
Derived role-init remains available because it regenerates bootstrap context only.
`;
}
