// ProviderAdapter surface (B0 agent-runtime.md §5).
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

export interface LaunchPlan {
  sessionId: string;
  profileId: string;
  roleName?: string;
  cwd: string;
  env: Record<string, string>;
  bootstrapPrompt?: string;
  /** Profile-level command/args overrides. */
  command?: string;
  args?: string[];
  /** Opaque profile extras (e.g. fake options). Adapters interpret their own keys. */
  extras?: Record<string, unknown>;
}

export interface ResolvedLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
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
  isAlive(): boolean;
  stop(reason: StopReason): Promise<void>;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayNameKey: string;
  capabilities(): ProviderCapabilities;
  resolveLaunch(plan: LaunchPlan): ResolvedLaunch | Promise<ResolvedLaunch>;
  /**
   * Optional structured transport (ACP stdio). When implemented, runtime uses this
   * instead of ProcessSupervisor spawn with stdio:ignore.
   */
  startManagedSession?(
    plan: LaunchPlan,
    emit: (ev: RuntimeEvent) => void
  ): Promise<ManagedSession>;
  parseResumeToken?(raw: string): ResumeToken;
  mapExit(code: number | null, signal?: string): RuntimeEvent;
  discoverSessions?(): Promise<DiscoveredSession[]>;
}
