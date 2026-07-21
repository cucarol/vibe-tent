// Service-internal AgentRuntimePort IDL (B0 agent-runtime.md §4).
// Not a client command surface — Desktop/CLI/MCP use task.* only.

export type SessionState =
  | "starting"
  | "live"
  | "waiting-user"
  | "stopped"
  | "failed"
  | "external";

export type StopReason = "user" | "interrupt" | "shutdown";

export type RuntimeEvent =
  | { type: "session.starting"; sessionId: string }
  | { type: "session.live"; sessionId: string; pid?: number }
  | { type: "session.waiting_user"; sessionId: string; summary: string }
  | { type: "session.exited"; sessionId: string; exitCode: number | null }
  | { type: "session.failed"; sessionId: string; error: string }
  | { type: "session.stdout_tail"; sessionId: string; text: string }
  /**
   * Managed ACP: first session/prompt finished successfully (end_turn).
   * `assistantText` is the accumulated agent_message_chunk body only (not thoughts).
   * Local Service may auto-deliver this as the task report — never a chat-UI message.
   */
  | {
      type: "session.prompt_complete";
      sessionId: string;
      assistantText: string;
      stopReason?: string;
    };

export type Unsubscribe = () => void;

export interface WorkspaceLaneRef {
  workspace: string;
  worktree: string;
  branch: string;
  /** Formal integration branch (main/master/…); optional on older rows. */
  targetBranch?: string;
}

export interface RuntimeWorkspace {
  cwd: string;
}

export interface StartSessionRequest {
  /** Service-preallocated ss- id. */
  sessionId: string;
  /** Machine-local AgentProfile id. */
  profileId: string;
  roleName?: string;
  /**
   * Collaboration assignee kind. Durable role sessions use "role" (default when omitted).
   * One-shot agentProfile tasks must set "agentProfile" so live-role checks do not
   * treat the profile assignee label as a durable role.
   */
  assigneeKind?: "role" | "agentProfile";
  /** Collaboration lane already prepared by service/core. */
  workspaceLane?: WorkspaceLaneRef;
  /**
   * Machine-local launch binding for this process.
   * Usually cwd mirrors workspaceLane.worktree; not a task field.
   */
  runtimeWorkspace?: RuntimeWorkspace;
  /** Initial text for the agent (relay / task pointer). Not multi-turn chat. */
  bootstrapPrompt?: string;
  /** Alias of runtimeWorkspace.cwd when set. */
  cwd?: string;
  /** Process-scoped env; no secret plaintext for disk. */
  env?: Record<string, string>;
  /** Optional task id projection only (never a session row on the task). */
  lastTaskId?: string;
  /** Mounted workspace key for multi-mount stop validation. */
  workspace?: string;
}

export interface ResumeSessionRequest {
  sessionId: string;
  resumeToken?: string;
  runtimeWorkspace?: RuntimeWorkspace;
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Optional post-load bootstrap (managed ACP). History replay from session/load
   * must never auto-deliver; only a subsequent session/prompt may.
   */
  bootstrapPrompt?: string;
}

export interface SessionHandle {
  sessionId: string;
  profileId: string;
  adapterId: string;
  state: SessionState;
  pid?: number;
  roleName?: string;
  assigneeKind?: "role" | "agentProfile";
  runtimeWorkspace?: RuntimeWorkspace;
  createdAt: string;
  updatedAt: string;
}

export interface SessionProbe {
  sessionId: string;
  state: SessionState;
  alive: boolean;
  resumeCapable: boolean;
  pid?: number;
  lastError?: string;
  exitCode?: number | null;
}

/** Durable machine-local session row (architecture §3.3 / agent-runtime §6). */
export interface SessionRecord {
  id: string;
  profileId: string;
  adapterId: string;
  /**
   * Immutable non-secret launch configuration captured when the session starts.
   * Resume uses this snapshot so later profile edits cannot reinterpret an old
   * provider token. credentialRef is resolved again at resume time; secret values
   * are never stored here. Missing on legacy rows falls back to the live catalog.
   */
  profileSnapshot?: AgentProfileConfig;
  roleName?: string;
  /**
   * When "agentProfile", roleName holds the profileId label for attribution only —
   * not a durable role registry entry. Missing reads as role for older rows.
   */
  assigneeKind?: "role" | "agentProfile";
  state: SessionState;
  pid?: number;
  resumeToken?: string;
  runtimeWorkspace?: RuntimeWorkspace;
  workspace?: string;
  workspaceLane?: WorkspaceLaneRef;
  createdAt: string;
  updatedAt: string;
  lastTaskId?: string;
  exitCode?: number | null;
  lastError?: string;
  stopReason?: StopReason;
  /**
   * Stable pull-host / external-GUI idempotency key within a workspace.
   * First-class field on the session row — not profile env.
   */
  externalKey?: string;
}

/**
 * Machine-local launch profile — binary paths, argv templates, auth refs.
 * Lives only in service data area; never in workspace git / concept bodies.
 */
export interface AgentProfileConfig {
  id: string;
  adapterId: string;
  /** Optional human label (machine-local editor); preferred over displayNameKey for projection. */
  displayName?: string;
  displayNameKey?: string;
  /** Optional default command override (generic / fake / mock-acp profiles). */
  command?: string;
  args?: string[];
  /**
   * Non-secret process env for launch. Never store API keys / tokens here —
   * real providers read secrets from the service process environment via envKey.
   */
  env?: Record<string, string>;
  /**
   * Fake-provider only knobs. Real providers must not use this bag.
   * Kept on profile so tests never hit paid networks.
   */
  fake?: FakeProfileOptions;
  /**
   * Canonical shared ACP machine-local options (executable path, model, envKey name,
   * credentialRef id, timeouts). Used by whitelist ACP adapterIds (grok-acp, codex-acp, …).
   * Secret values stay in CredentialStore / process env; only env key *names* and
   * credential *refs* are stored here (never plaintext).
   *
   * On load, legacy disk field `grokAcp` is migrated into `acp` (canonical save writes only `acp`).
   */
  acp?: import("../adapters/acp/types.js").AcpProfileOptions;
  /**
   * Enabled machine-local Skill references (name + optional absolute path under allowed roots).
   * Never stores SKILL.md body. Captured into session profileSnapshot at start.
   */
  skills?: import("../adapters/acp/mcp-skills.js").AgentProfileSkillRef[];
  /**
   * MCP server descriptions projected into ACP session/new|load mcpServers.
   * Secrets only as envKey/credentialRef names — never plaintext. Not hot-updated mid-session.
   */
  mcpServers?: import("../adapters/acp/mcp-skills.js").AgentProfileMcpServer[];
}

/**
 * Optional service hook: resolve machine-local secrets into process env for one start.
 * Called by AgentRuntime before LaunchPlan construction. Must not persist secrets.
 * Returns a partial env map merged last into LaunchPlan.env, so the vault value cannot
 * be shadowed by non-secret profile/request configuration.
 */
export type ResolveProfileEnv = (
  profile: AgentProfileConfig
) => Promise<Record<string, string>> | Record<string, string>;

/**
 * Optional service hook: resolve one CredentialStore id → plaintext for MCP env/header injection.
 * Process-scoped only — never written to SessionRecord / profile disk / events / logs.
 */
export type ResolveCredentialRef = (
  credentialRef: string
) => Promise<string | undefined> | string | undefined;

export interface FakeProfileOptions {
  /** Sleep before clean exit when not waiting for stop (default 30_000). */
  sleepMs?: number;
  /** Exit code on natural completion (default 0). */
  exitCode?: number;
  /** When true, child loops until SIGTERM / force-kill (default true for supervisor tests). */
  waitForSignal?: boolean;
  /** Emit a short stdout line for diagnostics (default true). */
  emitStdout?: boolean;
  /** Fail resolveLaunch with this message (simulates missing binary / bad config). */
  failLaunch?: string;
  /** When true, canResume=true and resumeToken is stored. */
  canResume?: boolean;
}

/**
 * Pull-host / external GUI session registration (no ACP spawn).
 * Writes a SessionRegistry row with state=external; never starts a process.
 */
export interface EnterExternalSessionRequest {
  /** Service-preallocated or client-supplied ss- id. When omitted, runtime allocates. */
  sessionId?: string;
  /**
   * Machine-local profile label for attribution only.
   * Defaults to EXTERNAL_PROFILE_ID — not used to launch ACP.
   */
  profileId?: string;
  roleName?: string;
  assigneeKind?: "role" | "agentProfile";
  /** Mounted workspace key for multi-mount filtering. */
  workspace?: string;
  runtimeWorkspace?: RuntimeWorkspace;
  cwd?: string;
  workspaceLane?: WorkspaceLaneRef;
  /** Optional task id projection only. */
  lastTaskId?: string;
  /**
   * Idempotency key for external GUI sessions (e.g. provider session handle).
   * When set, a second enter with the same key reuses the live external row.
   */
  externalKey?: string;
}

export interface AgentRuntimePort {
  startSession(req: StartSessionRequest): Promise<SessionHandle>;
  resumeSession(req: ResumeSessionRequest): Promise<SessionHandle>;
  /**
   * Register or reuse a pull-host external session (state=external, no process).
   * Idempotent for the same sessionId / externalKey while the row is still external.
   */
  enterExternalSession(req: EnterExternalSessionRequest): Promise<SessionHandle>;
  stopSession(sessionId: string, reason: StopReason): Promise<void>;
  probe(sessionId: string): Promise<SessionProbe>;
  subscribe(sessionId: string, sink: (ev: RuntimeEvent) => void): Unsubscribe;
}

/** Synthetic adapter/profile ids for pull-host external GUI sessions (no spawn). */
export const EXTERNAL_ADAPTER_ID = "external";
export const EXTERNAL_PROFILE_ID = "external";

export const SESSION_ID_PREFIX = "ss-";

const SESSION_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function makeSessionId(rand: () => number = Math.random, len = 8): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += SESSION_ALPHABET[Math.floor(rand() * SESSION_ALPHABET.length)];
  }
  return SESSION_ID_PREFIX + s;
}

export function isSessionId(id: string): boolean {
  return id.startsWith(SESSION_ID_PREFIX) && id.length > SESSION_ID_PREFIX.length;
}

/**
 * Resolve the stable externalKey for a session row.
 * First-class `externalKey` only — no profile-env fallback.
 */
export function recordExternalKey(rec: {
  externalKey?: string;
}): string | undefined {
  const key = rec.externalKey?.trim();
  return key || undefined;
}
