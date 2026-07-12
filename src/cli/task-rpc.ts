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
        const boxId = positionals[0];
        const role = positionals[1];
        const promptParts = positionals.slice(2);
        if (!boxId || !role) {
          return failUsage(
            "Usage: tent task dispatch <boxId> <role> [localPrompt...] [--prompt <text>|-] [--workspace <path>] [--json]"
          );
        }
        if (Object.prototype.hasOwnProperty.call(flags, "prompt") && promptParts.length > 0) {
          return failUsage(
            "Usage: tent task dispatch <boxId> <role> [localPrompt...] [--prompt <text>|-] [--workspace <path>] [--json]"
          );
        }
        let prompt = typeof flags.prompt === "string" ? flags.prompt : promptParts.join(" ");
        if (prompt === "-") prompt = await readStdinText();
        const result = await client.taskDispatch(workspaceId, {
          boxId,
          role,
          prompt,
          dispatchedBy: flags.by || flags.from || flags["dispatched-by"] || process.env.TENT_ROLE || "user",
          deliveryPolicy: flags["delivery-policy"] || flags.deliveryPolicy,
        });
        return okPrint(result, json, (r) => {
          const row = r as { taskPath: string; state?: string; relayPrompt?: string };
          return (
            `✓ Dispatched via service RPC\n` +
            `taskPath: ${row.taskPath}\n` +
            `state: ${row.state ?? "queued"}\n` +
            (row.relayPrompt ? `\n--- Relay prompt ---\n${row.relayPrompt}` : "")
          );
        });
      }
      case "accept": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage(
            "Usage: tent task accept <taskPath> --actor <user|role> [--commits sha,sha] [--workspace <path>] [--json]"
          );
        }
        const actor = flags.actor || flags.by || process.env.TENT_ROLE;
        if (!actor) return failUsage("tent task accept requires --actor <user|role>");
        const commits = parseCommitsFlag(flags.commits);
        const result = await client.taskAccept(workspaceId, taskPath, actor, commits);
        return okPrint(result, json, (r) => {
          const row = r as { taskPath: string; state?: string };
          return `✓ Accepted via service RPC\ntaskPath: ${row.taskPath}\nstate: ${row.state ?? "accepted"}\n`;
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

const BOOLEAN_FLAGS = new Set([
  "json",
  "attach-only",
  "resume",
  "no-resume",
  "yes",
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
  tent task dispatch <boxId> <role> [prompt...] [--prompt <text>|-] [--workspace <path>] [--json]
  tent task accept <taskPath> --actor <user|role> [--commits sha,sha] [--workspace <path>] [--json]
  tent task reject <taskPath> --actor <user|role> [--note <text>] [--resume|--no-resume] [--workspace <path>] [--json]
  tent task cancel <taskPath> [--workspace <path>] [--json]

Service options:
  --data-dir <path>       Machine-local service data area (default: %APPDATA%/Tent)
  --attach-only           Fail if no healthy service (do not bootstrap)
  --service-entry <path>  Path to service.mjs when bootstrapping

Legacy CLI (direct core write, not service RPC):
  tent dispatch / task-ack / report / complete / stamp …
  Prefer \`tent task *\` for Desktop co-located agents and in-workspace tents.
`;
}
