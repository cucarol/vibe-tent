// External agent session lifecycle via Local Service RPC (V0.2 pull-host).
// Surface: tent agent enter|status|leave — machine-callable JSON, idempotent.
// Does not start ACP; leave never deliver/accept.

import type { ServiceClient } from "../service/client.js";
import { attachOrBootstrapService, type CliAttachOptions } from "./service-attach.js";
import {
  ensureMountedWorkspace,
  resolveWorkspacePaths,
} from "./workspace-context.js";
import { findTentSystemRoot, NOT_INSIDE_TENT_MESSAGE } from "../core/status.js";

export type AgentRpcGlobalOptions = {
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
  /**
   * When true (hook aliases), missing Tent workspace exits 0 with empty/minimal output.
   * Public enter/status/leave fail-loud outside a Tent unless this is set.
   */
  silentOutsideTent?: boolean;
};

export type AgentCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Run `tent agent <sub>` (or internal hook aliases session-start / session-end / session-status).
 */
export async function runAgentCommand(
  sub: string,
  args: string[],
  globals: AgentRpcGlobalOptions = {}
): Promise<AgentCommandResult> {
  const normalized = normalizeAgentSub(sub);
  if (!normalized) {
    return failUsage(
      `Unknown agent subcommand: ${sub || "(empty)"}\n` + agentHelpText()
    );
  }

  try {
    const { positionals, flags } = parseAgentFlags(args);
    const json = globals.json === true || flags.json === "true";
    const silent =
      globals.silentOutsideTent === true ||
      flags.silent === "true" ||
      flags["silent-outside"] === "true";

    // Non-Tent hook path: silent success (exit 0) so host agents never break outside Tent.
    const cwd = pathResolve(globals.cwd);
    const workspaceFlag = flags.workspace || globals.workspace;
    const tentProbe = await probeTentPresence({
      cwd,
      workspace: workspaceFlag,
    });
    if (!tentProbe.ok) {
      if (silent || isHookAlias(sub)) {
        return silentOutsideResult(normalized, json);
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: tentProbe.message + "\n",
      };
    }

    const attachOpts: CliAttachOptions = {
      dataDir: flags["data-dir"] || globals.dataDir,
      attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
      serviceEntry: flags["service-entry"] || globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env,
    };

    const client =
      globals.client ?? (await attachOrBootstrapService(attachOpts)).client;

    const ctx = await ensureMountedWorkspace(client, {
      cwd,
      workspace: workspaceFlag,
    });
    const workspaceId = ctx.workspaceId;

    switch (normalized) {
      case "enter": {
        if (positionals.length > 0) {
          return failUsage(
            "Usage: tent agent enter [--session <ss-…>] [--role <name>] [--profile <id>] [--key <externalKey>] [--task <taskId>] [--json]"
          );
        }
        const sessionId = flags.session || flags["session-id"] || flags.sessionId;
        const roleName =
          flags.role || flags["role-name"] || flags.roleName || process.env.TENT_ROLE;
        const profileId = flags.profile || flags["profile-id"] || flags.profileId;
        const externalKey =
          flags.key || flags["external-key"] || flags.externalKey || flags.external;
        const lastTaskId =
          flags.task || flags["task-id"] || flags.taskId || flags["last-task-id"];
        const assigneeKindRaw = flags["assignee-kind"] || flags.assigneeKind;
        const assigneeKind =
          assigneeKindRaw === "agentProfile" || assigneeKindRaw === "role"
            ? assigneeKindRaw
            : undefined;

        const result = await client.sessionEnter({
          workspaceId,
          sessionId,
          profileId,
          roleName,
          externalKey,
          lastTaskId,
          cwd: ctx.workspaceRoot,
          assigneeKind,
        });
        return okPrint(result, json, (r) => formatEnter(r));
      }
      case "status": {
        if (positionals.length > 1) {
          return failUsage(
            "Usage: tent agent status [sessionId] [--workspace <path>] [--json]"
          );
        }
        const sessionId =
          positionals[0] || flags.session || flags["session-id"] || flags.sessionId;
        const result = await client.sessionStatus({
          workspaceId,
          sessionId,
        });
        return okPrint(result, json, (r) => formatStatus(r));
      }
      case "leave": {
        const sessionId =
          positionals[0] || flags.session || flags["session-id"] || flags.sessionId;
        if (!sessionId || positionals.length > 1) {
          return failUsage(
            "Usage: tent agent leave <sessionId> [--workspace <path>] [--json]"
          );
        }
        const result = await client.sessionLeave(sessionId, workspaceId);
        return okPrint(result, json, (r) => formatLeave(r));
      }
      default:
        return failUsage(agentHelpText());
    }
  } catch (error) {
    // Hook aliases must not crash the host agent outside unexpected Tent errors either —
    // only silentOutside applies to missing Tent; other errors still surface.
    const message = error instanceof Error ? error.message : String(error);
    if (isHookAlias(sub) && /Not inside a Tent/i.test(message)) {
      return silentOutsideResult("status", globals.json === true);
    }
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}

export function agentHelpText(): string {
  return `tent agent — external / pull-host session lifecycle (Local Service RPC)

Usage:
  tent agent enter   [--session <ss-…>] [--role <name>] [--profile <id>]
                     [--key <externalKey>] [--task <taskId>] [--json]
  tent agent status  [sessionId] [--json]
  tent agent leave   <sessionId> [--json]

Semantics:
  enter   Register or reuse a SessionRegistry row with state=external.
          Does not start ACP or any managed agent process. Idempotent.
  status  Probe session + list incomplete (active) tasks bound to it.
  leave   End external session binding only. Never deliver or accept.
          Reports incompleteTasks still open for the caller to handle.

Hook aliases (same RPC; silent exit 0 when cwd is not a Tent workspace):
  tent agent session-start   → enter
  tent agent session-status  → status
  tent agent session-end     → leave

Common flags:
  --workspace <path>   Workspace root (default: resolve from cwd)
  --data-dir <path>    Service data area override
  --attach-only        Do not bootstrap Local Service
  --json               Machine-readable result
`;
}

/** Map public + internal hook subcommands to enter|status|leave. */
export function normalizeAgentSub(
  sub: string
): "enter" | "status" | "leave" | null {
  const s = (sub || "").trim().toLowerCase();
  if (s === "enter" || s === "session-start" || s === "sessionstart" || s === "start") {
    return "enter";
  }
  if (s === "status" || s === "session-status" || s === "sessionstatus") {
    return "status";
  }
  if (s === "leave" || s === "session-end" || s === "sessionend" || s === "end") {
    return "leave";
  }
  return null;
}

function isHookAlias(sub: string): boolean {
  const s = (sub || "").trim().toLowerCase();
  return (
    s === "session-start" ||
    s === "sessionstart" ||
    s === "session-status" ||
    s === "sessionstatus" ||
    s === "session-end" ||
    s === "sessionend"
  );
}

async function probeTentPresence(options: {
  cwd?: string;
  workspace?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await resolveWorkspacePaths({
      cwd: options.cwd,
      workspace: options.workspace,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Also treat pure "not inside tent" from findTentSystemRoot.
    if (!options.workspace) {
      const systemRoot = await findTentSystemRoot(options.cwd || process.cwd());
      if (!systemRoot) {
        return { ok: false, message: NOT_INSIDE_TENT_MESSAGE };
      }
    }
    return { ok: false, message };
  }
}

function silentOutsideResult(
  kind: "enter" | "status" | "leave",
  json: boolean
): AgentCommandResult {
  const payload =
    kind === "enter"
      ? { skipped: true, reason: "not-a-tent-workspace", session: null }
      : kind === "status"
        ? { skipped: true, reason: "not-a-tent-workspace", sessions: [], incompleteTasks: [] }
        : {
            skipped: true,
            reason: "not-a-tent-workspace",
            left: false,
            alreadyLeft: true,
            incompleteTasks: [],
            delivered: false,
            accepted: false,
          };
  if (json) {
    return { exitCode: 0, stdout: JSON.stringify(payload) + "\n", stderr: "" };
  }
  // Hooks: no stdout noise when silent outside Tent.
  return { exitCode: 0, stdout: "", stderr: "" };
}

function formatEnter(result: unknown): string {
  const row = result as {
    session?: {
      sessionId?: string;
      state?: string;
      profileId?: string;
      roleName?: string;
      alive?: boolean;
    };
    reused?: boolean;
  };
  const s = row.session ?? {};
  return (
    `✓ External session enter\n` +
    `sessionId: ${s.sessionId ?? "?"}\n` +
    `state: ${s.state ?? "external"}\n` +
    (s.roleName ? `role: ${s.roleName}\n` : "") +
    (s.profileId ? `profileId: ${s.profileId}\n` : "") +
    (row.reused != null ? `reused: ${row.reused}\n` : "")
  );
}

function formatStatus(result: unknown): string {
  const row = result as {
    session?: {
      sessionId?: string;
      state?: string;
      alive?: boolean;
      roleName?: string;
      lastTaskId?: string;
    };
    sessions?: Array<{ sessionId?: string; state?: string; roleName?: string }>;
    incompleteTasks?: Array<{ path?: string; state?: string; role?: string; id?: string }>;
    open?: boolean;
  };
  const lines: string[] = [];
  if (row.session) {
    const s = row.session;
    lines.push(
      `sessionId: ${s.sessionId ?? "?"}`,
      `state: ${s.state ?? "?"}`,
      `alive: ${s.alive ?? false}`,
      ...(s.roleName ? [`role: ${s.roleName}`] : []),
      ...(s.lastTaskId ? [`lastTaskId: ${s.lastTaskId}`] : []),
      ...(row.open != null ? [`open: ${row.open}`] : [])
    );
  } else if (row.sessions) {
    lines.push(`externalSessions: ${row.sessions.length}`);
    for (const s of row.sessions) {
      lines.push(
        `- ${s.sessionId ?? "?"} state=${s.state ?? "?"}` +
          (s.roleName ? ` role=${s.roleName}` : "")
      );
    }
  }
  const tasks = row.incompleteTasks ?? [];
  lines.push("", `incompleteTasks: ${tasks.length}`);
  for (const t of tasks) {
    lines.push(
      `- ${t.path ?? t.id ?? "?"} state=${t.state ?? "?"} role=${t.role ?? "?"}`
    );
  }
  return lines.join("\n") + "\n";
}

function formatLeave(result: unknown): string {
  const row = result as {
    sessionId?: string;
    state?: string;
    left?: boolean;
    alreadyLeft?: boolean;
    incompleteTasks?: Array<{ path?: string; state?: string; role?: string }>;
    delivered?: boolean;
    accepted?: boolean;
  };
  const tasks = row.incompleteTasks ?? [];
  const lines = [
    `✓ External session leave`,
    `sessionId: ${row.sessionId ?? "?"}`,
    `state: ${row.state ?? "stopped"}`,
    `left: ${row.left ?? false}`,
    ...(row.alreadyLeft ? [`alreadyLeft: true`] : []),
    `delivered: ${row.delivered ?? false}`,
    `accepted: ${row.accepted ?? false}`,
    "",
    `incompleteTasks: ${tasks.length}`,
  ];
  for (const t of tasks) {
    lines.push(
      `- ${t.path ?? "?"} state=${t.state ?? "?"} role=${t.role ?? "?"}`
    );
  }
  if (tasks.length > 0) {
    lines.push(
      "",
      "Note: leave did not deliver/accept. Finish incomplete tasks with tent task deliver / accept as needed."
    );
  }
  return lines.join("\n") + "\n";
}

function okPrint(
  result: unknown,
  json: boolean,
  human: (r: unknown) => string
): AgentCommandResult {
  const stdout = json ? JSON.stringify(result, null, 2) + "\n" : human(result);
  return { exitCode: 0, stdout, stderr: "" };
}

function failUsage(msg: string): AgentCommandResult {
  return { exitCode: 1, stdout: "", stderr: msg + "\n" };
}

function pathResolve(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  return cwd;
}

function parseAgentFlags(args: string[]): {
  positionals: string[];
  flags: Record<string, string>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags };
}
