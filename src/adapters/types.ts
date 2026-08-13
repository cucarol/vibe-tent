// ProviderAdapter surface.
// Adapters depend on runtime types only — never core lifecycle modules.

import type { RuntimeEvent, StopReason } from "../runtime/types.js";

export interface ProviderCapabilities {
  canSpawn: boolean;
  canResume: boolean;
  canStopGraceful: boolean;
  needsTty: boolean;
  supportsWorktreeCwd: boolean;
  authModel: "none" | "env" | "os-keychain" | "external-app";
  observeLevel: "process" | "log" | "structured";
}

/** Ephemeral execution inputs resolved from one machine Agent Connection. */
export interface ConnectionLaunchPlan {
  sessionId: string;
  connectionId: string;
  cwd: string;
  env: Record<string, string>;
  /**
   * Core-owned reserved Tent keys (set only by AgentRuntime).
   * Adapters/ProcessSupervisor pass this as the sole reserved overlay — never
   * promote arbitrary env values for these keys.
   */
  coreEnv?: Partial<
    Record<
      import("../runtime/child-env.js").ReservedTentChildEnvKey,
      string
    >
  >;
  /**
   * Credential resolver outputs for diagnostic redaction (never persist/log).
   * Includes values that may not sit under secret-named env keys.
   */
  diagnosticSecrets?: string[];
  bootstrapPrompt?: string;
  /**
   * Ephemeral local image path refs for managed ACP bootstrap (paths only, no base64).
   * Adapters project these at session/prompt time; never persist on SessionRecord.
   */
  bootstrapImageRefs?: import("./acp/image-prompt.js").BootstrapImageRef[];
  /** Route-level command/args overrides. */
  command?: string;
  args?: string[];
  /** Opaque route extras (e.g. fake options). Adapters interpret their own keys. */
  extras?: Record<string, unknown>;
}

export interface ResolvedLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /**
   * Core-owned reserved Tent keys (Service data-dir, session id, …).
   * Only AgentRuntime (or equivalent Core path) may set these; arbitrary
   * launch.env cannot smuggle reserved keys into the child.
   */
  coreEnv?: Partial<
    Record<
      import("../runtime/child-env.js").ReservedTentChildEnvKey,
      string
    >
  >;
  /**
   * Explicit credential / secret values for diagnostic redaction
   * (resolver outputs). Never logged; used only to scrub stderr/events.
   */
  diagnosticSecrets?: string[];
  /** Prefer non-argv bootstrap channels on Windows. */
  bootstrapFile?: string;
  /** Optional graceful stop signal (default SIGTERM). */
  stopSignal?: NodeJS.Signals;
}

export interface ResumeToken {
  raw: string;
  providerSessionId?: string;
}

export interface DiscoveredSession {
  resumeToken: string;
  label?: string;
  cwd?: string;
}

/**
 * Adapter-owned live session (ACP stdio, etc.).
 * When present, AgentRuntime skips ProcessSupervisor for that session.
 * PID stays machine-local in the session registry — never written to workspace.
 */
export interface ManagedSession {
  readonly sessionId: string;
  readonly pid?: number;
  /** Provider-native session id (e.g. ACP sessionId); machine-local only. */
  readonly providerSessionId?: string;
  /** Bounded Agent-owned ACP negotiation facts, when this is an ACP Session. */
  readonly acpSession?: import("./acp/types.js").AcpSessionConfigSnapshot;
  isAlive(): boolean;
  /**
   * Internal turn fact (not session liveness): true while a managed
   * session/prompt (bootstrap or U2A follow-up) is in flight.
   * Session may stay live/idle between turns; missing impl → not busy.
   */
  isTurnActive?(): boolean;
  stop(reason: StopReason): Promise<void>;
  /**
   * Optional follow-up session/prompt on a live managed session (U2A resume).
   * Used for persisted TaskInput follow-ups — not multi-turn chat. Adapters without structured
   * prompt transport leave this undefined; service falls back to resumeSession.
   */
  sendFollowUpPrompt?(prompt: string): Promise<void>;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayNameKey: string;
  capabilities(): ProviderCapabilities;
  resolveLaunch(plan: ConnectionLaunchPlan): ResolvedLaunch | Promise<ResolvedLaunch>;
  /**
   * Optional structured transport (ACP stdio). When implemented, runtime uses this
   * instead of ProcessSupervisor spawn with stdio:ignore.
   */
  startManagedSession?(
    plan: ConnectionLaunchPlan,
    emit: (ev: RuntimeEvent) => void
  ): Promise<ManagedSession>;
  /**
   * Provider-native managed resume (e.g. ACP `session/load` on a new bridge process).
   * Distinct from `startManagedSession` — must not silently fall back to session/new.
   * Only adapters with `capabilities().canResume === true` implement this.
   */
  resumeManagedSession?(
    plan: ConnectionLaunchPlan,
    token: ResumeToken,
    emit: (ev: RuntimeEvent) => void
  ): Promise<ManagedSession>;
  parseResumeToken?(raw: string): ResumeToken;
  mapExit(code: number | null, signal?: string): RuntimeEvent;
  discoverSessions?(): Promise<DiscoveredSession[]>;
}
