// Machine-local Agent native hook/config projection (V0.2).
// Injects SessionStart → `tent agent session-start --host <agent>` and
// Stop → `tent agent session-end --host <agent>` into verified agent config surfaces only.
// Never touches permissions, MCP, or ACP adapters.
//
// Why session-start/session-end (not bare enter/leave):
// - leave requires a sessionId positional; two independent hook processes cannot close that loop.
// - bare enter/leave fail-loud outside a Tent workspace.
// - CLI hook aliases parse session identity/cwd from native hook stdin and silently skip non-Tent.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Agents this projection layer knows about (product surface ids). */
export const AGENT_HOOK_IDS = ["claude", "codex", "antigravity", "copilot"] as const;
export type AgentHookId = (typeof AGENT_HOOK_IDS)[number];

/** CLI aliases accepted by `--agent` (agy → antigravity). */
const AGENT_ALIASES: Record<string, AgentHookId> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  antigravity: "antigravity",
  agy: "antigravity",
  copilot: "copilot",
  "github-copilot": "copilot",
};

/**
 * Stable managed command identity for install/doctor/remove.
 * Only the formal projected form counts:
 *   tent agent session-start --host <agent>
 *   tent agent session-end --host <agent>
 * Bare enter/leave (unpublished) are never matched, upgraded, or removed —
 * so user-authored commands with those tokens are left alone.
 */
export const TENT_HOOK_SESSION_START_STEM = "agent session-start";
export const TENT_HOOK_SESSION_END_STEM = "agent session-end";

/** Marker embedded in managed Codex handler statusMessage (not used as sole match key). */
export const TENT_HOOK_MARKER = "tent-managed-hook";

export type HookLifecycleEvent = "SessionStart" | "Stop";

export type AgentHookSupport = "lifecycle" | "unsupported";

export type AgentHookActionStatus =
  | "installed"
  | "removed"
  | "skipped"
  | "ok"
  | "missing"
  | "partial"
  | "unsupported"
  | "error";

export interface AgentHookPathsOptions {
  /** Override home (tests). Default: os.homedir(). */
  home?: string;
  /**
   * Optional absolute path to the tent executable / entry used in projected commands.
   * Default: bare `tent` on PATH (product expectation).
   */
  tentCommand?: string;
}

export interface AgentHookAgentResult {
  agent: AgentHookId;
  support: AgentHookSupport;
  status: AgentHookActionStatus;
  /** Config file path when the agent has a known projection target. */
  path?: string;
  /** Human-readable detail (unsupported reason, parse error, skip reason). */
  reason?: string;
  /** Which managed lifecycle events are present after the operation. */
  present?: HookLifecycleEvent[];
  /** Which managed lifecycle events are still missing. */
  missing?: HookLifecycleEvent[];
}

export interface AgentHooksBatchResult {
  action: "install" | "doctor" | "remove";
  results: AgentHookAgentResult[];
}

export interface AgentHooksRunOptions extends AgentHookPathsOptions {
  /** Agent ids; omit / empty = all known agents. */
  agents?: AgentHookId[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isAgentHookId(value: string): value is AgentHookId {
  return (AGENT_HOOK_IDS as readonly string[]).includes(value);
}

/** Parse CLI `--agent` value; supports `all` and aliases (`agy`). */
export function parseAgentHookId(value: string): AgentHookId {
  const key = value.trim().toLowerCase();
  const id = AGENT_ALIASES[key];
  if (!id) {
    throw new Error(
      `Unknown agent: ${value} (allowed: all, ${AGENT_HOOK_IDS.join(", ")}, agy)`
    );
  }
  return id;
}

export function resolveAgentHookSelection(raw?: string[]): AgentHookId[] {
  if (!raw || raw.length === 0) return [...AGENT_HOOK_IDS];
  const out: AgentHookId[] = [];
  const seen = new Set<AgentHookId>();
  for (const item of raw) {
    const trimmed = item.trim().toLowerCase();
    if (trimmed === "all") {
      return [...AGENT_HOOK_IDS];
    }
    const id = parseAgentHookId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** User-level Claude Code settings path (verified: ~/.claude/settings.json). */
export function claudeSettingsPath(home?: string): string {
  return path.join(home ?? os.homedir(), ".claude", "settings.json");
}

/**
 * User-level Codex hooks path.
 * Verified from local Codex binary: user hooks serialize as hooks.json under Codex home;
 * event names SessionStart / Stop match the embedded ManagedHooks schema.
 */
export function codexHooksPath(home?: string): string {
  return path.join(home ?? os.homedir(), ".codex", "hooks.json");
}

/**
 * Projected SessionStart command for a host agent.
 * Example: `tent agent session-start --host claude`
 */
export function managedSessionStartCommand(
  agent: AgentHookId,
  tentCommand?: string
): string {
  const base = (tentCommand ?? "tent").trim() || "tent";
  const tent = base === "tent" ? "tent" : quoteIfNeeded(base);
  return `${tent} agent session-start --host ${agent}`;
}

/**
 * Projected Stop/SessionEnd command for a host agent.
 * Example: `tent agent session-end --host claude`
 */
export function managedSessionEndCommand(
  agent: AgentHookId,
  tentCommand?: string
): string {
  const base = (tentCommand ?? "tent").trim() || "tent";
  const tent = base === "tent" ? "tent" : quoteIfNeeded(base);
  return `${tent} agent session-end --host ${agent}`;
}

/**
 * True if a hook command is Tent-managed formal projection:
 * `…tent… agent session-start|session-end --host <id>`.
 * Does not match bare enter/leave or session-* without --host.
 */
export function isManagedHookCommand(command: string | undefined | null): boolean {
  if (!command || typeof command !== "string") return false;
  const c = command.trim();
  if (managedCommandHost(c) === null) return false;
  if (!/tent/i.test(c)) return false;
  return (
    /\bagent\s+session-start\b/i.test(c) || /\bagent\s+session-end\b/i.test(c)
  );
}

/** Formal session-start projection (requires --host). */
export function isManagedEnterCommand(command: string | undefined | null): boolean {
  if (!isManagedHookCommand(command)) return false;
  return /\bagent\s+session-start\b/i.test(String(command));
}

/** Formal session-end projection (requires --host). */
export function isManagedLeaveCommand(command: string | undefined | null): boolean {
  if (!isManagedHookCommand(command)) return false;
  return /\bagent\s+session-end\b/i.test(String(command));
}

/** Extract `--host <id>` from a command, if present. */
export function managedCommandHost(command: string | undefined | null): string | null {
  if (!command || typeof command !== "string") return null;
  const m = command.match(/--host(?:\s+|=)([^\s"']+)/i);
  return m?.[1] ?? null;
}

/** True when command is formal session-start for the given host agent. */
export function isManagedSessionStartForHost(
  command: string | undefined | null,
  agent: AgentHookId
): boolean {
  if (!isManagedEnterCommand(command)) return false;
  return managedCommandHost(command) === agent;
}

/** True when command is formal session-end for the given host agent. */
export function isManagedSessionEndForHost(
  command: string | undefined | null,
  agent: AgentHookId
): boolean {
  if (!isManagedLeaveCommand(command)) return false;
  return managedCommandHost(command) === agent;
}

/** Install Tent-managed lifecycle hooks (idempotent merge; never touches permissions). */
export async function installAgentHooks(
  options: AgentHooksRunOptions = {}
): Promise<AgentHooksBatchResult> {
  const agents = resolveAgentHookSelection(options.agents);
  const home = options.home ?? os.homedir();
  const results: AgentHookAgentResult[] = [];
  for (const agent of agents) {
    results.push(await installOne(agent, home, options.tentCommand));
  }
  return { action: "install", results };
}

/** Doctor: report presence of managed lifecycle hooks without mutating. */
export async function doctorAgentHooks(
  options: AgentHooksRunOptions = {}
): Promise<AgentHooksBatchResult> {
  const agents = resolveAgentHookSelection(options.agents);
  const home = options.home ?? os.homedir();
  const results: AgentHookAgentResult[] = [];
  for (const agent of agents) {
    results.push(await doctorOne(agent, home, options.tentCommand));
  }
  return { action: "doctor", results };
}

/** Remove only Tent-managed lifecycle hook entries (idempotent). */
export async function removeAgentHooks(
  options: AgentHooksRunOptions = {}
): Promise<AgentHooksBatchResult> {
  const agents = resolveAgentHookSelection(options.agents);
  const home = options.home ?? os.homedir();
  const results: AgentHookAgentResult[] = [];
  for (const agent of agents) {
    results.push(await removeOne(agent, home));
  }
  return { action: "remove", results };
}

// ---------------------------------------------------------------------------
// Per-agent dispatch
// ---------------------------------------------------------------------------

async function installOne(
  agent: AgentHookId,
  home: string,
  tentCommand?: string
): Promise<AgentHookAgentResult> {
  switch (agent) {
    case "claude":
      return projectClaudeLike({
        agent,
        configPath: claudeSettingsPath(home),
        mode: "install",
        tentCommand,
        wrapRoot: true,
      });
    case "codex":
      return projectClaudeLike({
        agent,
        configPath: codexHooksPath(home),
        mode: "install",
        tentCommand,
        wrapRoot: false,
        codexCommandShape: true,
      });
    case "antigravity":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for Antigravity/agy; not guessed."
      );
    case "copilot":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for GitHub Copilot CLI; not guessed."
      );
    default: {
      const _exhaustive: never = agent;
      throw new Error(`Unknown agent: ${String(_exhaustive)}`);
    }
  }
}

async function doctorOne(
  agent: AgentHookId,
  home: string,
  tentCommand?: string
): Promise<AgentHookAgentResult> {
  switch (agent) {
    case "claude":
      return projectClaudeLike({
        agent,
        configPath: claudeSettingsPath(home),
        mode: "doctor",
        tentCommand,
        wrapRoot: true,
      });
    case "codex":
      return projectClaudeLike({
        agent,
        configPath: codexHooksPath(home),
        mode: "doctor",
        tentCommand,
        wrapRoot: false,
        codexCommandShape: true,
      });
    case "antigravity":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for Antigravity/agy; not guessed."
      );
    case "copilot":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for GitHub Copilot CLI; not guessed."
      );
    default: {
      const _exhaustive: never = agent;
      throw new Error(`Unknown agent: ${String(_exhaustive)}`);
    }
  }
}

async function removeOne(agent: AgentHookId, home: string): Promise<AgentHookAgentResult> {
  switch (agent) {
    case "claude":
      return projectClaudeLike({
        agent,
        configPath: claudeSettingsPath(home),
        mode: "remove",
        wrapRoot: true,
      });
    case "codex":
      return projectClaudeLike({
        agent,
        configPath: codexHooksPath(home),
        mode: "remove",
        wrapRoot: false,
        codexCommandShape: true,
      });
    case "antigravity":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for Antigravity/agy; not guessed."
      );
    case "copilot":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for GitHub Copilot CLI; not guessed."
      );
    default: {
      const _exhaustive: never = agent;
      throw new Error(`Unknown agent: ${String(_exhaustive)}`);
    }
  }
}

function unsupportedResult(agent: AgentHookId, reason: string): AgentHookAgentResult {
  return {
    agent,
    support: "unsupported",
    status: "unsupported",
    reason,
  };
}

// ---------------------------------------------------------------------------
// Shared Claude-compatible hooks bag projection
// (Claude settings.json `hooks` key; Codex user hooks.json root)
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

interface ProjectClaudeLikeOptions {
  agent: AgentHookId;
  configPath: string;
  mode: "install" | "doctor" | "remove";
  tentCommand?: string;
  /** When true, hooks live under root.hooks (Claude settings). When false, root is the hooks bag (Codex hooks.json). */
  wrapRoot: boolean;
  /** Codex command handlers prefer async:false + timeoutSec in managed schema. */
  codexCommandShape?: boolean;
}

async function projectClaudeLike(
  options: ProjectClaudeLikeOptions
): Promise<AgentHookAgentResult> {
  const { agent, configPath, mode, tentCommand, wrapRoot, codexCommandShape } = options;
  const enterCmd = managedSessionStartCommand(agent, tentCommand);
  const leaveCmd = managedSessionEndCommand(agent, tentCommand);
  const matchEnter = (cmd: string | undefined | null) =>
    isManagedSessionStartForHost(cmd, agent);
  const matchLeave = (cmd: string | undefined | null) =>
    isManagedSessionEndForHost(cmd, agent);

  let root: JsonObject = {};
  let existed = false;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    existed = true;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        agent,
        support: "lifecycle",
        status: "error",
        path: configPath,
        reason: `Config is not a JSON object: ${configPath}`,
      };
    }
    root = parsed as JsonObject;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") {
      root = {};
      existed = false;
    } else if (err instanceof SyntaxError) {
      return {
        agent,
        support: "lifecycle",
        status: "error",
        path: configPath,
        reason: `Invalid JSON in ${configPath}: ${err.message}`,
      };
    } else {
      throw err;
    }
  }

  // Never mutate permissions or non-hooks keys in place until we write a clone.
  const nextRoot: JsonObject = { ...root };
  const hooksBag = wrapRoot ? asObject(nextRoot.hooks) : nextRoot;
  // Working copy of the hooks bag (event → matcher groups).
  const hooks: JsonObject = wrapRoot ? { ...hooksBag } : { ...hooksBag };

  const presentBefore = detectManagedEvents(hooks, agent);
  if (mode === "doctor") {
    return doctorFromPresent(agent, configPath, presentBefore, existed);
  }

  if (mode === "remove") {
    const changed = removeManagedFromHooks(hooks);
    if (!changed && presentBefore.length === 0) {
      return {
        agent,
        support: "lifecycle",
        status: "skipped",
        path: configPath,
        reason: existed ? "no managed hooks present" : "config file absent",
        present: [],
        missing: ["SessionStart", "Stop"],
      };
    }
    await writeHooksRoot(configPath, nextRoot, hooks, wrapRoot, root);
    return {
      agent,
      support: "lifecycle",
      status: "removed",
      path: configPath,
      present: [],
      missing: ["SessionStart", "Stop"],
    };
  }

  // install — only formal session-start/end --host; never rewrite bare enter/leave.
  const enterHandler = buildCommandHandler(enterCmd, codexCommandShape === true);
  const leaveHandler = buildCommandHandler(leaveCmd, codexCommandShape === true);
  const addedEnter = ensureManagedEvent(hooks, "SessionStart", enterHandler, matchEnter);
  const addedLeave = ensureManagedEvent(hooks, "Stop", leaveHandler, matchLeave);
  const presentAfter = detectManagedEvents(hooks, agent);

  if (!addedEnter && !addedLeave && presentAfter.length === 2) {
    return {
      agent,
      support: "lifecycle",
      status: "skipped",
      path: configPath,
      reason: "managed hooks already present",
      present: presentAfter,
      missing: missingEvents(presentAfter),
    };
  }

  await writeHooksRoot(configPath, nextRoot, hooks, wrapRoot, root);
  return {
    agent,
    support: "lifecycle",
    status: "installed",
    path: configPath,
    present: presentAfter,
    missing: missingEvents(presentAfter),
  };
}

function doctorFromPresent(
  agent: AgentHookId,
  configPath: string,
  present: HookLifecycleEvent[],
  existed: boolean
): AgentHookAgentResult {
  const missing = missingEvents(present);
  if (present.length === 2) {
    return {
      agent,
      support: "lifecycle",
      status: "ok",
      path: configPath,
      present,
      missing: [],
    };
  }
  if (present.length === 0) {
    return {
      agent,
      support: "lifecycle",
      status: "missing",
      path: configPath,
      reason: existed ? "managed hooks not found" : "config file absent",
      present: [],
      missing,
    };
  }
  return {
    agent,
    support: "lifecycle",
    status: "partial",
    path: configPath,
    reason: `present=${present.join(",")} missing=${missing.join(",")}`,
    present,
    missing,
  };
}

async function writeHooksRoot(
  configPath: string,
  nextRoot: JsonObject,
  hooks: JsonObject,
  wrapRoot: boolean,
  previousRoot: JsonObject
): Promise<void> {
  // Strip empty event arrays / empty hooks bag so remove is tidy.
  pruneEmptyHookEvents(hooks);

  let toWrite: JsonObject;
  if (wrapRoot) {
    toWrite = { ...nextRoot };
    if (Object.keys(hooks).length === 0) {
      // Remove hooks key only if we emptied it; preserve other root keys.
      if ("hooks" in toWrite) delete toWrite.hooks;
    } else {
      toWrite.hooks = hooks;
    }
  } else {
    toWrite = hooks;
  }

  // If nothing to write and file never existed, skip creating an empty file on remove.
  if (!wrapRoot && Object.keys(toWrite).length === 0) {
    try {
      await fs.unlink(configPath);
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code !== "ENOENT") throw err;
    }
    return;
  }

  // Preserve non-hooks root fields from previous (already in nextRoot for wrapRoot).
  void previousRoot;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const body = `${JSON.stringify(toWrite, null, 2)}\n`;
  await fs.writeFile(configPath, body, "utf8");
}

// ---------------------------------------------------------------------------
// Hooks bag helpers (Claude / Codex shared shape)
// ---------------------------------------------------------------------------

/**
 * Claude / Codex hook bag:
 * {
 *   "SessionStart": [ { "matcher"?: string, "hooks": [ { "type":"command", "command":"..." } ] } ],
 *   "Stop": [ ... ]
 * }
 */
function detectManagedEvents(hooks: JsonObject, agent: AgentHookId): HookLifecycleEvent[] {
  const present: HookLifecycleEvent[] = [];
  if (eventHasManaged(hooks, "SessionStart", (c) => isManagedSessionStartForHost(c, agent))) {
    present.push("SessionStart");
  }
  if (eventHasManaged(hooks, "Stop", (c) => isManagedSessionEndForHost(c, agent))) {
    present.push("Stop");
  }
  return present;
}

function missingEvents(present: HookLifecycleEvent[]): HookLifecycleEvent[] {
  const set = new Set(present);
  const out: HookLifecycleEvent[] = [];
  if (!set.has("SessionStart")) out.push("SessionStart");
  if (!set.has("Stop")) out.push("Stop");
  return out;
}

function eventHasManaged(
  hooks: JsonObject,
  event: HookLifecycleEvent,
  match: (command: string | undefined | null) => boolean
): boolean {
  const groups = hooks[event];
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const handlers = (group as JsonObject).hooks;
    if (!Array.isArray(handlers)) continue;
    for (const h of handlers) {
      if (!h || typeof h !== "object" || Array.isArray(h)) continue;
      const cmd = (h as JsonObject).command;
      if (typeof cmd === "string" && match(cmd)) return true;
    }
  }
  return false;
}

/**
 * Ensure a managed command handler exists under the event.
 * Returns true if the bag was mutated.
 */
function ensureManagedEvent(
  hooks: JsonObject,
  event: HookLifecycleEvent,
  handler: JsonObject,
  match: (command: string | undefined | null) => boolean
): boolean {
  if (eventHasManaged(hooks, event, match)) return false;

  const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
  // Prefer appending into the first group that has a hooks array; else create a new group.
  let placed = false;
  const nextGroups = groups.map((group) => {
    if (placed) return group;
    if (!group || typeof group !== "object" || Array.isArray(group)) return group;
    const g = { ...(group as JsonObject) };
    const handlers = Array.isArray(g.hooks) ? [...(g.hooks as unknown[])] : [];
    handlers.push(handler);
    g.hooks = handlers;
    placed = true;
    return g;
  });
  if (!placed) {
    nextGroups.push({ hooks: [handler] });
  }
  hooks[event] = nextGroups;
  return true;
}

/** Remove only formal Tent-managed handlers; returns true if anything was removed. */
function removeManagedFromHooks(hooks: JsonObject): boolean {
  let changed = false;
  for (const event of ["SessionStart", "Stop"] as const) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const nextGroups: unknown[] = [];
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group)) {
        nextGroups.push(group);
        continue;
      }
      const g = { ...(group as JsonObject) };
      const handlers = Array.isArray(g.hooks) ? (g.hooks as unknown[]) : [];
      const kept = handlers.filter((h) => {
        if (!h || typeof h !== "object" || Array.isArray(h)) return true;
        const cmd = (h as JsonObject).command;
        if (typeof cmd === "string" && isManagedHookCommand(cmd)) {
          changed = true;
          return false;
        }
        return true;
      });
      if (kept.length === 0) {
        // Drop empty matcher group entirely (only if it had only managed hooks).
        if (handlers.length > 0) {
          // group removed
          continue;
        }
        nextGroups.push(g);
        continue;
      }
      g.hooks = kept;
      nextGroups.push(g);
    }
    if (nextGroups.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = nextGroups;
    }
  }
  return changed;
}

function pruneEmptyHookEvents(hooks: JsonObject): void {
  for (const key of Object.keys(hooks)) {
    const val = hooks[key];
    if (Array.isArray(val) && val.length === 0) {
      delete hooks[key];
    }
  }
}

function buildCommandHandler(command: string, codexShape: boolean): JsonObject {
  if (codexShape) {
    // Matches Codex ConfiguredHookHandler command shape (async required in managed schema).
    return {
      type: "command",
      command,
      async: false,
      statusMessage: TENT_HOOK_MARKER,
    };
  }
  // Claude Code: verified type/command/timeout; statusMessage not required.
  return {
    type: "command",
    command,
    // timeout generous enough for Local Service attach; not a permission field.
    timeout: 60,
  };
}

function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function quoteIfNeeded(command: string): string {
  if (!/[\s"]/.test(command)) return command;
  if (command.includes('"')) return command;
  return `"${command}"`;
}

// ---------------------------------------------------------------------------
// CLI formatting helpers (kept pure for tests)
// ---------------------------------------------------------------------------

export function formatAgentHooksResults(batch: AgentHooksBatchResult): string {
  const lines: string[] = [`✓ agent-hooks ${batch.action}`];
  for (const r of batch.results) {
    const bits = [`  - ${r.agent}: ${r.status}`];
    if (r.path) bits.push(`path=${r.path}`);
    if (r.present && r.present.length > 0) bits.push(`present=${r.present.join(",")}`);
    if (r.missing && r.missing.length > 0) bits.push(`missing=${r.missing.join(",")}`);
    if (r.reason) bits.push(`(${r.reason})`);
    lines.push(bits.join(" "));
  }
  return lines.join("\n");
}
