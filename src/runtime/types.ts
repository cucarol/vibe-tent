// Service-internal AgentRuntimePort IDL.
// Not a client command surface — Desktop/CLI/MCP use task.* only.

import type {
  AgentConnectionConfig,
  AgentConnectionSnapshot,
} from "./agent-connection.js";

export type { FakeConnectionOptions, AgentConnectionConfig, AgentConnectionSnapshot } from "./agent-connection.js";

export type SessionState =
  | "reserved"
  | "starting"
  | "live"
  | "waiting-user"
  | "stopped"
  | "failed"
  | "external";

export type StopReason = "user" | "interrupt" | "shutdown";

export const ACP_PERMISSION_REQUEST_COUNT_MAX = 255;
export const ACP_OBSERVATION_TEXT_BYTES = 256;
export const ACP_OBSERVATION_SIGNAL_BYTES = 32;

/** Machine-local bounded ACP facts; intentionally absent from public projections. */
export type AcpRuntimeObservation = {
  permissionRequestCount: number;
  permissionPolicy: "allow" | "ask" | "deny";
  permissionDecision?: "allow" | "deny";
  permissionOutcome?: "allow_once" | "cancelled";
  promptStopReason?: string;
  spontaneousChildExit: boolean;
  exitCode?: number | null;
  signal?: string;
};

export type RuntimeEvent =
  | { type: "session.starting"; sessionId: string }
  | { type: "session.live"; sessionId: string; pid?: number }
  | { type: "session.waiting_user"; sessionId: string; summary: string }
  | { type: "session.exited"; sessionId: string; exitCode: number | null }
  | { type: "session.failed"; sessionId: string; error: string }
  | { type: "session.stdout_tail"; sessionId: string; text: string }
  | {
      type: "session.acp_observation";
      sessionId: string;
      observation: AcpRuntimeObservation;
    }
  | {
      type: "session.config_options";
      sessionId: string;
      sessionConfig: import("../adapters/acp/types.js").AcpSessionConfigSnapshot;
    }
  /**
   * Managed ACP: first session/prompt finished successfully (end_turn).
   * `assistantText` is the final user-facing assistant reply only: last non-empty
   * contiguous agent_message_chunk segment after tool/status/thought separators
   * (not intermediate narrations, thoughts, or tool/status diagnostics).
   * Local Service may auto-submit this as the TaskResult report — never a chat-UI message.
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
  /** Collaboration lane already prepared by service/core. */
  workspaceLane?: WorkspaceLaneRef;
  /**
   * Machine-local launch binding for this process.
   * Usually cwd mirrors workspaceLane.worktree; not a task field.
   */
  runtimeWorkspace?: RuntimeWorkspace;
  /** Initial text for the agent (relay / task pointer). Not multi-turn chat. */
  bootstrapPrompt?: string;
  /**
   * Ephemeral local image path refs for managed ACP bootstrap projection.
   * Paths only — never base64. Not written to SessionRecord / task / route disk.
   * Projected to ACP image blocks only when live initialize
   * agentCapabilities.promptCapabilities.image === true.
   */
  bootstrapImageRefs?: import("../adapters/acp/image-prompt.js").BootstrapImageRef[];
  /**
   * Absolute tent system root (`.tent`) for safe image byte reads at prompt time.
   * Ephemeral only — never SessionRecord. Required when bootstrapImageRefs is non-empty.
   */
  bootstrapImageSystemRoot?: string;
  /** Alias of runtimeWorkspace.cwd when set. */
  cwd?: string;
  /** Process-scoped env; no secret plaintext for disk. */
  env?: Record<string, string>;
  /** Optional task id projection only (never a session row on the task). */
  currentTaskId?: string;
  /** Mounted workspace key for multi-mount stop validation. */
  workspace?: string;
}

export interface ReserveSessionRequest {
  /** Exact ss- identity allocated before the Task is written. */
  sessionId: string;
  /** Machine-local Settings connection selected for this new Session. */
  connectionId: string;
  /** Exact Task identity that will be durably bound to this Session. */
  currentTaskId: string;
  workspace: string;
  workspaceLane?: WorkspaceLaneRef;
  runtimeWorkspace?: RuntimeWorkspace;
  cwd?: string;
}

export interface ResumeSessionRequest {
  sessionId: string;
  runtimeWorkspace?: RuntimeWorkspace;
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Optional post-load bootstrap (managed ACP). History replay from session/load
   * must never auto-submit; only a subsequent session/prompt may.
   */
  bootstrapPrompt?: string;
  /**
   * Ephemeral image path refs for post-load bootstrap projection (same rules as start).
   * Never persisted on the session registry row.
   */
  bootstrapImageRefs?: import("../adapters/acp/image-prompt.js").BootstrapImageRef[];
  /** Absolute tent system root for post-load image reads (ephemeral). */
  bootstrapImageSystemRoot?: string;
  /** Rebind a durable Role Session to its current task before prompting. */
  currentTaskId?: string;
}

export interface SessionHandle {
  sessionId: string;
  connectionId?: string;
  adapterId?: string;
  state: SessionState;
  pid?: number;
  roleId?: string;
  runtimeWorkspace?: RuntimeWorkspace;
  /** One-time caller capability returned only by session.enter; never persisted. */
  sessionToken?: string;
  /**
   * True when this handle reuses provider-native same-context continuity.
   * False when Tent started an independent Session (honest recovery / no cache claim).
   * Omitted on legacy rows / first cold start without a continuity claim.
   */
  providerContextRestored?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionProbe {
  sessionId: string;
  state: SessionState;
  isAlive: boolean;
  canResume: boolean;
  pid?: number;
  lastError?: string;
  exitCode?: number | null;
  /**
   * Internal turn fact (managed ACP only). True while a session/prompt is
   * settling. Distinct from `isAlive`: a live role session may be turn-idle
   * between prompts. Omitted / false when no managed turn is in flight.
   */
  isTurnActive?: boolean;
}

/** Durable machine-local session row (architecture §3.3 / agent-runtime §6). */
export interface SessionRecord {
  id: string;
  /** Managed Sessions only. External durable Role Sessions have no Connection. */
  connectionId?: string;
  adapterId?: string;
  /**
   * Immutable non-secret launch configuration captured when the session starts.
   * Resume uses this snapshot so later route edits cannot reinterpret an old
   * provider token. launchSecretRef is resolved again at resume time; secret values
   * are never stored here. Missing snapshot is unrecoverable and fails loud.
   */
  connectionSnapshot?: AgentConnectionSnapshot;
  /** Bounded Agent-owned ACP capabilities/auth/config facts for this Session. */
  acpSession?: import("../adapters/acp/types.js").AcpSessionConfigSnapshot;
  /** Internal-only ACP cancellation/exit evidence; never public projection. */
  acpObservation?: AcpRuntimeObservation;
  roleId?: string;
  state: SessionState;
  pid?: number;
  resumeToken?: string;
  runtimeWorkspace?: RuntimeWorkspace;
  workspace?: string;
  workspaceLane?: WorkspaceLaneRef;
  createdAt: string;
  updatedAt: string;
  currentTaskId?: string;
  exitCode?: number | null;
  lastError?: string;
  stopReason?: StopReason;
  /**
   * Continuity honesty marker for managed reject-resume / resume projections.
   * - true: provider-native same-context path (live rebind or successful resumeSession)
   * - false: independent new Session (no silent cache continuity claim)
   * Omitted on legacy rows and ordinary first starts that make no continuity claim.
   */
  providerContextRestored?: boolean;
  /**
   * Stable reason for how this Session was bound (reject-resume path or explicit
   * task.replaceSession). Optional audit field — not a second Task state.
   */
  restoreReason?: string;
  /**
   * When this Session replaced a prior managed Session on the same Task
   * (task.replaceSession), the retired Tent session id. Audit linkage only.
   */
  replacedSessionId?: string;
  /**
   * When this Session was retired by task.replaceSession, the newly bound
   * Tent session id. Audit linkage only; late events must still ignore rebound Tasks.
   */
  replacedBySessionId?: string;
  /**
   * Stable pull-host / external-GUI idempotency key within a workspace.
   * First-class field on the external Session row.
   */
  externalKey?: string;
  /**
   * Stable-prefix generation last injected on this Session
   * (`cg-v1-<sha256>`). Used for prompt-cache reuse: same generation → delta only.
   * Not a new lifecycle entity — machine-local Session projection (cx-5q6za6).
   */
  contextGeneration?: string;
}

/**
 * Machine-local Agent Connection — binary paths, argv templates, auth refs.
 * Lives only in the Service data area; never in workspace Git or Node bodies.
 */
/**
 * Optional service hook: resolve machine-local secrets into process env for one start.
 * Called by AgentRuntime before LaunchPlan construction. Must not persist secrets.
 * Returns a partial env map merged last into LaunchPlan.env, so the launch-secret value cannot
 * be shadowed by non-secret Connection/request configuration.
 */
export type ResolveConnectionEnv = (
  route: AgentConnectionConfig
) => Promise<Record<string, string>> | Record<string, string>;

/**
 * Optional service hook: resolve one LaunchSecretStore id → plaintext for MCP env/header injection.
 * Process-scoped only — never written to SessionRecord / Connection disk / events / logs.
 */
export type ResolveLaunchSecretRef = (
  launchSecretRef: string
) => Promise<string | undefined> | string | undefined;

/**
 * Pull-host / external GUI session registration (no ACP spawn).
 * Writes a SessionRegistry row with state=external; never starts a process.
 */
export interface EnterExternalSessionRequest {
  /** Service-preallocated or client-supplied ss- id. When omitted, runtime allocates. */
  sessionId?: string;
  roleId?: string;
  /** Mounted workspace key for multi-mount filtering. */
  workspace?: string;
  runtimeWorkspace?: RuntimeWorkspace;
  cwd?: string;
  workspaceLane?: WorkspaceLaneRef;
  /** Optional task id projection only. */
  currentTaskId?: string;
  /**
   * Idempotency key for external GUI sessions (e.g. provider session handle).
   * When set, a second enter with the same key reuses the live external row.
   */
  externalKey?: string;
}

export interface AgentRuntimePort {
  reserveSession(req: ReserveSessionRequest): Promise<SessionHandle>;
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

/** Synthetic adapter id retained only for external transport diagnostics. */
export const EXTERNAL_ADAPTER_ID = "external";

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
 * First-class `externalKey` only.
 */
export function recordExternalKey(rec: {
  externalKey?: string;
}): string | undefined {
  const key = rec.externalKey?.trim();
  return key || undefined;
}
