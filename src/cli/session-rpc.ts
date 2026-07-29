// External Session lifecycle via Local Service RPC (V0.2 pull-host).
// Surface: tent session enter|status|leave — machine-callable JSON, idempotent.
// Hook aliases: tent session session-start|session-end [--host <agent>]
// Does not start ACP; leave never deliver/accept.

import type { ServiceClient } from "../service/client.js";
import { attachOrBootstrapService, type CliAttachOptions } from "./service-attach.js";
import {
  ensureMountedWorkspace,
  resolveWorkspacePaths,
} from "./workspace-context.js";
import { findTentSystemRoot, NOT_INSIDE_TENT_MESSAGE } from "../core/status.js";

export type SessionRpcGlobalOptions = {
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
  /**
   * Optional native-hook stdin JSON (tests). When omitted, hook aliases read process.stdin.
   */
  stdinText?: string;
  /** Skip reading process.stdin (unit tests that inject stdinText or none). */
  skipStdin?: boolean;
};

export type SessionCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Native hook / provider stdin fields we accept for session identity. */
export type NativeHookStdin = {
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  workspace?: string;
  workspace_root?: string;
  workspaceRoot?: string;
  [key: string]: unknown;
};

/**
 * Run `tent session <sub>` (or internal hook aliases session-start / session-end / session-status).
 */
export async function runSessionCommand(
  sub: string,
  args: string[],
  globals: SessionRpcGlobalOptions = {}
): Promise<SessionCommandResult> {
  const normalized = normalizeSessionSub(sub);
  if (!normalized) {
    return failUsage(
      `Unknown session subcommand: ${sub || "(empty)"}\n` + sessionHelpText()
    );
  }

  const hookAlias = isHookAlias(sub);

  try {
    const { positionals, flags } = parseSessionFlags(args);
    const json = globals.json === true || flags.json === "true";
    const silent =
      globals.silentOutsideTent === true ||
      flags.silent === "true" ||
      flags["silent-outside"] === "true";

    // Hook path: optionally merge native stdin JSON (session_id / cwd / workspace).
    const hookMeta = hookAlias
      ? await loadHookMeta(flags, globals)
      : { stdin: null as NativeHookStdin | null, host: undefined as string | undefined };

    const cwd =
      pathResolve(globals.cwd) ||
      pathResolve(
        typeof hookMeta.stdin?.cwd === "string" ? hookMeta.stdin.cwd : undefined
      ) ||
      pathResolve(
        typeof hookMeta.stdin?.workspace === "string"
          ? hookMeta.stdin.workspace
          : undefined
      ) ||
      pathResolve(
        typeof hookMeta.stdin?.workspace_root === "string"
          ? hookMeta.stdin.workspace_root
          : undefined
      ) ||
      pathResolve(
        typeof hookMeta.stdin?.workspaceRoot === "string"
          ? hookMeta.stdin.workspaceRoot
          : undefined
      );

    const workspaceFlag =
      flags.workspace ||
      globals.workspace ||
      (typeof hookMeta.stdin?.workspace === "string"
        ? hookMeta.stdin.workspace
        : undefined) ||
      (typeof hookMeta.stdin?.workspace_root === "string"
        ? hookMeta.stdin.workspace_root
        : undefined) ||
      (typeof hookMeta.stdin?.workspaceRoot === "string"
        ? hookMeta.stdin.workspaceRoot
        : undefined);

    // Non-Tent hook path: silent success (exit 0) so host agents never break outside Tent.
    const tentProbe = await probeTentPresence({
      cwd,
      workspace: workspaceFlag,
    });
    if (!tentProbe.ok) {
      if (silent || hookAlias) {
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

    // Stable externalKey for hooks: host + native session id, else host + workspace fallback.
    // Public enter/status/leave may still pass --key explicitly.
    const explicitKey =
      flags.key || flags["external-key"] || flags.externalKey || flags.external;
    const host =
      flags.host ||
      flags.agent ||
      hookMeta.host ||
      process.env.TENT_HOOK_HOST ||
      process.env.TENT_AGENT_HOST;
    const nativeSessionId = pickNativeSessionId(hookMeta.stdin, flags);
    const derivedKey = hookAlias
      ? buildHookExternalKey({
          host,
          nativeSessionId,
          workspaceRoot: ctx.workspaceRoot,
          workspaceId,
        })
      : undefined;
    const externalKey = explicitKey || derivedKey;

    switch (normalized) {
      case "enter": {
        if (positionals.length > 0) {
          return failUsage(
            "Usage: tent session enter [--session <ss-…>] [--role <name>] [--profile <id>] [--key <externalKey>] [--host <agent>] [--task <taskId>] [--json]"
          );
        }
        if (hookAlias && !externalKey) {
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              "session-start requires --host <agent> (or native session id + host) to form a stable externalKey; refusing to create orphan external rows\n",
          };
        }
        const sessionId =
          flags.session || flags["session-id"] || flags.sessionId;
        // Only accept Tent ss- ids as sessionId; native provider ids go into externalKey.
        const tentSessionId =
          sessionId && isTentSessionId(sessionId) ? sessionId : undefined;
        const roleName =
          flags.role ||
          flags["role-name"] ||
          flags.roleName ||
          process.env.TENT_ROLE;
        const profileId =
          flags.profile || flags["profile-id"] || flags.profileId;
        const lastTaskId =
          flags.task ||
          flags["task-id"] ||
          flags.taskId ||
          flags["last-task-id"];
        const assigneeKindRaw = flags["assignee-kind"] || flags.assigneeKind;
        const assigneeKind =
          assigneeKindRaw === "agentProfile" || assigneeKindRaw === "role"
            ? assigneeKindRaw
            : undefined;

        const result = await client.sessionEnter({
          workspaceId,
          sessionId: tentSessionId,
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
            "Usage: tent session status [sessionId] [--key <externalKey>] [--host <agent>] [--workspace <path>] [--json]"
          );
        }
        const sessionIdPos =
          positionals[0] ||
          flags.session ||
          flags["session-id"] ||
          flags.sessionId;
        const tentSessionId =
          sessionIdPos && isTentSessionId(sessionIdPos)
            ? sessionIdPos
            : undefined;
        // Positional non-ss- token is treated as externalKey when --key omitted.
        const keyFromPos =
          sessionIdPos && !isTentSessionId(sessionIdPos)
            ? sessionIdPos
            : undefined;
        const result = await client.sessionStatus({
          workspaceId,
          sessionId: tentSessionId,
          externalKey: explicitKey || keyFromPos || derivedKey,
        });
        return okPrint(result, json, (r) => formatStatus(r));
      }
      case "leave": {
        const sessionIdPos =
          positionals[0] ||
          flags.session ||
          flags["session-id"] ||
          flags.sessionId;
        const tentSessionId =
          sessionIdPos && isTentSessionId(sessionIdPos)
            ? sessionIdPos
            : undefined;
        const keyFromPos =
          sessionIdPos && !isTentSessionId(sessionIdPos)
            ? sessionIdPos
            : undefined;
        const leaveKey = explicitKey || keyFromPos || derivedKey;
        if (!tentSessionId && !leaveKey) {
          if (hookAlias) {
            return {
              exitCode: 1,
              stdout: "",
              stderr:
                "session-end requires --host <agent> (with native stdin session id or workspace fallback) or --key <externalKey>; cannot leave without a stable identity\n",
            };
          }
          return failUsage(
            "Usage: tent session leave [<sessionId>] [--key <externalKey>] [--host <agent>] [--workspace <path>] [--json]"
          );
        }
        const result = await client.sessionLeave({
          sessionId: tentSessionId,
          externalKey: leaveKey,
          workspaceId,
        });
        return okPrint(result, json, (r) => formatLeave(r));
      }
      default:
        return failUsage(sessionHelpText());
    }
  } catch (error) {
    // Hook aliases: only missing Tent is silent; real Tent errors still fail loud.
    const message = error instanceof Error ? error.message : String(error);
    if (hookAlias && /Not inside a Tent/i.test(message)) {
      return silentOutsideResult("status", globals.json === true);
    }
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}

export function sessionHelpText(): string {
  return `tent session — external / pull-host session lifecycle (Local Service RPC)

Usage:
  tent session enter   [--session <ss-…>] [--role <name>] [--profile <id>]
                       [--key <externalKey>] [--host <agent>] [--task <taskId>] [--json]
  tent session status  [sessionId|externalKey] [--key <externalKey>] [--json]
  tent session leave   [sessionId|externalKey] [--key <externalKey>] [--json]

Semantics:
  enter   Register or reuse a SessionRegistry row with state=external.
          Does not start ACP or any managed agent process. Idempotent.
  status  Probe session + list incomplete (active) tasks bound to it.
  leave   End external session binding only. Never deliver or accept.
          Reports incompleteTasks still open for the caller to handle.

Hook aliases (projection contract with Agent Hook task):
  tent session session-start --host <agent>   → enter via stable externalKey
  tent session session-end   --host <agent>   → leave via same externalKey
  tent session session-status --host <agent>  → status via same externalKey

  Reads native hook stdin JSON when present (session_id / sessionId / cwd /
  workspace). externalKey = host + ":" + nativeSessionId, or host + ":ws:" +
  workspaceRoot when no native id (explicit, testable fallback — not silent orphans).
  Outside a Tent workspace: silent exit 0. Inside a real Tent: other errors fail loud.

Common flags:
  --workspace <path>   Workspace root (default: resolve from cwd / stdin)
  --host <agent>       Host/agent name for hook externalKey (alias: --agent)
  --key <externalKey>  Explicit externalKey (overrides derived)
  --data-dir <path>    Service data area override
  --attach-only        Do not bootstrap Local Service
  --json               Machine-readable result
`;
}

/** Map public + internal hook subcommands to enter|status|leave. */
export function normalizeSessionSub(
  sub: string
): "enter" | "status" | "leave" | null {
  const s = (sub || "").trim().toLowerCase();
  if (
    s === "enter" ||
    s === "session-start" ||
    s === "sessionstart" ||
    s === "start"
  ) {
    return "enter";
  }
  if (s === "status" || s === "session-status" || s === "sessionstatus") {
    return "status";
  }
  if (
    s === "leave" ||
    s === "session-end" ||
    s === "sessionend" ||
    s === "end"
  ) {
    return "leave";
  }
  return null;
}

export function isHookAlias(sub: string): boolean {
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

/**
 * Build the stable externalKey used by hook closed-loop (start → status → end)
 * without requiring callers to persist enter's random ss- id.
 *
 * - With native session id: `<host>:<nativeSessionId>`
 * - Without: `<host>:ws:<normalizedWorkspaceRoot>` (explicit fallback)
 * - Missing host → undefined (caller must refuse enter to avoid orphan rows)
 */
export function buildHookExternalKey(opts: {
  host?: string;
  nativeSessionId?: string;
  workspaceRoot?: string;
  workspaceId?: string;
}): string | undefined {
  const host = normalizeHostToken(opts.host);
  if (!host) return undefined;
  const native = (opts.nativeSessionId || "").trim();
  if (native) {
    return `${host}:${native}`;
  }
  const ws =
    (opts.workspaceRoot || "").trim() || (opts.workspaceId || "").trim();
  if (!ws) return undefined;
  return `${host}:ws:${normalizeWorkspaceToken(ws)}`;
}

/** Parse native hook stdin JSON; tolerates empty / non-JSON (returns null). */
export function parseNativeHookStdin(text: string | undefined | null): NativeHookStdin | null {
  if (text == null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as NativeHookStdin;
  } catch {
    return null;
  }
}

export function pickNativeSessionId(
  stdin: NativeHookStdin | null | undefined,
  flags: Record<string, string> = {}
): string | undefined {
  const fromFlags =
    flags["native-session"] ||
    flags.nativeSession ||
    flags["provider-session"] ||
    flags.providerSession;
  if (fromFlags && fromFlags.trim()) return fromFlags.trim();
  if (!stdin) return undefined;
  const candidates = [
    stdin.session_id,
    stdin.sessionId,
    (stdin as { SESSION_ID?: string }).SESSION_ID,
    (stdin as { sessionID?: string }).sessionID,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

function normalizeHostToken(host?: string): string | undefined {
  const h = (host || "").trim().toLowerCase();
  if (!h) return undefined;
  // Keep externalKey filesystem / JSON friendly.
  return h.replace(/[^a-z0-9._+-]+/g, "-").replace(/^-+|-+$/g, "") || undefined;
}

function normalizeWorkspaceToken(ws: string): string {
  // Stable across Windows drive-letter case and slash style.
  return ws.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isTentSessionId(id: string): boolean {
  return id.startsWith("ss-") && id.length > 3;
}

async function loadHookMeta(
  flags: Record<string, string>,
  globals: SessionRpcGlobalOptions
): Promise<{ stdin: NativeHookStdin | null; host?: string }> {
  const host =
    flags.host ||
    flags.agent ||
    process.env.TENT_HOOK_HOST ||
    process.env.TENT_AGENT_HOST;
  let text = globals.stdinText;
  if (text === undefined && !globals.skipStdin) {
    text = await readStdinIfAny();
  }
  return { stdin: parseNativeHookStdin(text), host };
}

/**
 * Read process.stdin when piped; if TTY / empty, return "".
 * Hooks that pass no body still work via --host + workspace fallback.
 */
function readStdinIfAny(): Promise<string> {
  return new Promise((resolve, reject) => {
    // No pipe / interactive: do not block waiting for EOF.
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    let settled = false;
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // Bound wait so a hung pipe cannot freeze hook leave forever.
    const timer = setTimeout(() => done(data), 500);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done(data);
    });
    process.stdin.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // Already ended before listeners (rare but seen under node:test).
    if (process.stdin.readableEnded) {
      clearTimeout(timer);
      done(data);
    }
  });
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
): SessionCommandResult {
  const payload =
    kind === "enter"
      ? { skipped: true, reason: "not-a-tent-workspace", session: null }
      : kind === "status"
        ? {
            skipped: true,
            reason: "not-a-tent-workspace",
            sessions: [],
            incompleteTasks: [],
          }
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
      externalKey?: string;
    };
    reused?: boolean;
  };
  const s = row.session ?? {};
  return (
    `✓ External session enter\n` +
    `sessionId: ${s.sessionId ?? "?"}\n` +
    `state: ${s.state ?? "external"}\n` +
    (s.externalKey ? `externalKey: ${s.externalKey}\n` : "") +
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
      externalKey?: string;
    };
    sessions?: Array<{
      sessionId?: string;
      state?: string;
      roleName?: string;
      externalKey?: string;
    }>;
    incompleteTasks?: Array<{
      path?: string;
      state?: string;
      role?: string;
      id?: string;
    }>;
    open?: boolean;
  };
  const lines: string[] = [];
  if (row.session) {
    const s = row.session;
    lines.push(
      `sessionId: ${s.sessionId ?? "?"}`,
      `state: ${s.state ?? "?"}`,
      `alive: ${s.alive ?? false}`,
      ...(s.externalKey ? [`externalKey: ${s.externalKey}`] : []),
      ...(s.roleName ? [`role: ${s.roleName}`] : []),
      ...(s.lastTaskId ? [`lastTaskId: ${s.lastTaskId}`] : []),
      ...(row.open != null ? [`open: ${row.open}`] : [])
    );
  } else if (row.sessions) {
    lines.push(`externalSessions: ${row.sessions.length}`);
    for (const s of row.sessions) {
      lines.push(
        `- ${s.sessionId ?? "?"} state=${s.state ?? "?"}` +
          (s.externalKey ? ` key=${s.externalKey}` : "") +
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
    externalKey?: string;
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
    ...(row.externalKey ? [`externalKey: ${row.externalKey}`] : []),
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
): SessionCommandResult {
  const stdout = json ? JSON.stringify(result, null, 2) + "\n" : human(result);
  return { exitCode: 0, stdout, stderr: "" };
}

function failUsage(msg: string): SessionCommandResult {
  return { exitCode: 1, stdout: "", stderr: msg + "\n" };
}

function pathResolve(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  return cwd;
}

function parseSessionFlags(args: string[]): {
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
