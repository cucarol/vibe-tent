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
    const { positionals, flags } = parseTaskFlags(args);
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
        // Optional RPC mapping of dispatch (no second lifecycle in CLI).
        // Two user-facing forms (do not infer profile from a bare role-like string):
        //   tent task dispatch <boxId> <role> [localPrompt...]
        //   tent task dispatch <boxId> --profile <profileId> [localPrompt...]
        const usageRole =
          "Usage: tent task dispatch <boxId> <role> [localPrompt...] [--prompt <text>|-] [--delivery-policy review|bypass|agent-decide] [--as-sub --by <role>] [--workspace <path>] [--json]";
        const usageProfile =
          "Usage: tent task dispatch <boxId> --profile <profileId> [localPrompt...] [--prompt <text>|-] [--delivery-policy review|bypass|agent-decide] [--as-sub --by <role>] [--workspace <path>] [--json]";
        const usageBoth = `${usageRole}\n   or: ${usageProfile.replace(/^Usage: /, "")}`;

        // Low-level Service fields are not the primary CLI UX.
        if (
          Object.prototype.hasOwnProperty.call(flags, "assignee-kind") ||
          Object.prototype.hasOwnProperty.call(flags, "assigneeKind")
        ) {
          return failUsage(
            "Do not pass --assignee-kind; use <role> for durable role dispatch or --profile <profileId> for managed one-shot agentProfile dispatch"
          );
        }
        if (Object.prototype.hasOwnProperty.call(flags, "start-session") ||
            Object.prototype.hasOwnProperty.call(flags, "startSession")) {
          return failUsage(
            "Do not pass --start-session; managed --profile dispatch always starts a session"
          );
        }

        const boxId = positionals[0];
        if (!boxId) {
          return failUsage(usageBoth);
        }

        const hasProfileFlag = Object.prototype.hasOwnProperty.call(flags, "profile");
        const profileIdRaw = hasProfileFlag ? String(flags.profile ?? "").trim() : "";
        if (hasProfileFlag && !profileIdRaw) {
          return failUsage(`--profile requires <profileId>\n${usageProfile}`);
        }
        const isProfileForm = hasProfileFlag;

        // Role form needs <role>; profile form treats every positional after boxId as prompt.
        const role = isProfileForm ? undefined : positionals[1];
        const promptParts = isProfileForm ? positionals.slice(1) : positionals.slice(2);
        if (!isProfileForm && !role) {
          return failUsage(usageBoth);
        }
        if (Object.prototype.hasOwnProperty.call(flags, "prompt") && promptParts.length > 0) {
          return failUsage(
            "Pass prompt either as positionals or via --prompt <text>|- , not both\n" + usageBoth
          );
        }
        let prompt = typeof flags.prompt === "string" ? flags.prompt : promptParts.join(" ");
        if (prompt === "-") prompt = await readStdinText();
        const asSub = flags["as-sub"] === "true";
        const explicitBy = (flags.by || flags.from || flags["dispatched-by"] || "").trim();
        // --by / --from / --dispatched-by name a dispatching *role*, not the user actor.
        // Plain user-originated dispatch needs no --by; reject explicit "user" so it is
        // never misclassified as callerKind=role.
        if (explicitBy && explicitBy === "user") {
          return failUsage(
            "--by/--from/--dispatched-by must name a dispatching role, not user; omit the flag for plain user-originated dispatch"
          );
        }
        const tentRole = (process.env.TENT_ROLE || "").trim();
        const dispatchedBy = explicitBy || tentRole || "user";
        if (asSub && (!dispatchedBy || dispatchedBy === "user")) {
          return failUsage("--as-sub requires --by <dispatching-role> or TENT_ROLE");
        }
        // Profile form always starts managed ACP; role form never auto-starts.
        // A2A attribution: any dispatch attributed to a role (explicit --by/--from/
        // --dispatched-by, implicit TENT_ROLE, or --as-sub) must send callerKind=role.
        // Plain user-originated dispatch (no role attribution) sends callerKind=user.
        // Both profile and role forms pass callerKind so Service policy is correct.
        const roleAttributed =
          asSub || Boolean(explicitBy) || Boolean(tentRole && tentRole !== "user");
        const callerKind: "user" | "role" = roleAttributed ? "role" : "user";

        const result = await client.taskDispatch(
          workspaceId,
          isProfileForm
            ? {
                boxId,
                assigneeKind: "agentProfile",
                profileId: profileIdRaw,
                prompt,
                dispatchedBy,
                asSub: asSub || undefined,
                deliveryPolicy: flags["delivery-policy"] || flags.deliveryPolicy,
                startSession: true,
                callerKind,
              }
            : {
                boxId,
                role,
                prompt,
                dispatchedBy,
                asSub: asSub || undefined,
                deliveryPolicy: flags["delivery-policy"] || flags.deliveryPolicy,
                callerKind,
              }
        );
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
              "Usage: tent task task-input ack <inputId> --task <taskPath> --actor <role|sessionId> [--workspace <path>] [--json]"
            );
          }
          if (!flags.actor) {
            return failUsage(
              "tent task task-input ack requires --actor matching the task role or verified session id"
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
  claims?: string[];
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

  return (
    `✓ Dispatched via service RPC\n` +
    `taskPath: ${row.taskPath}\n` +
    `state: ${row.state ?? "queued"}\n` +
    (row.assigneeKind ? `assigneeKind: ${row.assigneeKind}\n` : "") +
    (row.assignee ? `assignee: ${row.assignee}\n` : "") +
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
        `\tclaims=${(t.claims ?? []).join(",") || "-"}` +
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
    `claims: ${(t.claims ?? []).join(", ") || "-"}`,
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

export function parseTaskFlags(args: string[]): {
  positionals: string[];
  flags: Record<string, string>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = "true";
      } else {
        flags[name] = args[i + 1] ?? "";
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
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
  tent task dispatch <boxId> <role> [prompt...] [--prompt <text>|-] [--delivery-policy review|bypass|agent-decide] [--as-sub --by <role>] [--workspace <path>] [--json]
  tent task dispatch <boxId> --profile <profileId> [prompt...] [--prompt <text>|-] [--delivery-policy review|bypass|agent-decide] [--as-sub --by <role>] [--workspace <path>] [--json]
      # role form: durable role assignee (queued; no auto session)
      # --profile form: one-shot agentProfile + startSession (prints sessionId/sessionState); does not register a role
      # Do not pass --assignee-kind; a bare role-like string is never inferred as a profile
  tent task accept <taskPath> --actor <user|role> [--commits sha,sha] [--workspace <path>] [--json]
  tent task reject <taskPath> --actor <user|role> [--note <text>] [--resume|--no-resume] [--workspace <path>] [--json]
  tent task cancel <taskPath> [--workspace <path>] [--json]
  tent task ask-user <taskPath> --question <text>|- [--choices id=label,…] [--workspace <path>] [--json]
  tent task user-ask list|get <askId>|reply <askId>|deny <askId> […] [--workspace <path>] [--json]
  tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]
  tent task task-input list <taskPath>|get <inputId>|ack <inputId> --task <taskPath> --actor <role|sessionId> [--workspace <path>] [--json]

Service options:
  --data-dir <path>       Machine-local service data area (default: %APPDATA%/Tent)
  --attach-only           Fail if no healthy service (do not bootstrap)
  --service-entry <path>  Path to service.mjs when bootstrapping

Legacy CLI direct core write is blocked on in-workspace <workspace>/.tent
(fail-loud; use tent task * / Desktop Service). External tent roots keep
dispatch / task-ack / complete / stamp … for the migration window only.
Formal delivery is Delivery-only via tent task deliver (no tent report).
Derived role-init remains available because it regenerates bootstrap context only.
`;
}
