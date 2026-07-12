// ProviderAdapter surface (B0 agent-runtime.md §5).
// Adapters depend on runtime types only — never core lifecycle modules.

import type { RuntimeEvent } from "../runtime/types.js";

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

export interface ProviderAdapter {
  readonly id: string;
  readonly displayNameKey: string;
  capabilities(): ProviderCapabilities;
  resolveLaunch(plan: LaunchPlan): ResolvedLaunch | Promise<ResolvedLaunch>;
  parseResumeToken?(raw: string): ResumeToken;
  mapExit(code: number | null, signal?: string): RuntimeEvent;
  discoverSessions?(): Promise<DiscoveredSession[]>;
}
