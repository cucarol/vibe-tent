// Provider-neutral managed ACP session: connect + bootstrap prompt + delivery events.
// Adapters supply a connected-ready client (AcpClient or thin wrapper); no argv/auth here.

import type {
  LaunchPlan,
  ManagedSession,
  ProviderCapabilities,
  ResumeToken,
} from "../types.js";
import type { RuntimeEvent, StopReason } from "../../runtime/types.js";
import type { AcpPermissionOption, AcpPermissionPolicy } from "./types.js";
import type {
  AcpConnectOptions,
  AcpConnectResult,
  AcpStartResult,
} from "./client.js";

const DEFAULT_BOOTSTRAP =
  "Tent session started. Read the task envelope via Tent Task API; do not invent missing content.";

/** Minimal client surface used by the managed bootstrap helper. */
export type ManagedAcpClient = {
  readonly pid: number | undefined;
  readonly providerSession: string | undefined;
  isAlive(): boolean;
  connect(options?: AcpConnectOptions): Promise<AcpConnectResult>;
  sendPrompt(bootstrapPrompt: string): Promise<AcpStartResult>;
  stop(reason: "user" | "interrupt" | "shutdown"): Promise<void>;
  reportFailed(error: string): void;
};

export type AcpPermissionAskHooks = {
  onPermissionAsk?: (info: {
    sessionId: string;
    toolTitle: string;
    toolCallId?: string;
    options: Array<{ optionId: string; kind?: string; name?: string }>;
  }) => Promise<"allow" | "deny">;
};

export class AcpManagedSession implements ManagedSession {
  /** Depth of in-flight managed session/prompt turns (bootstrap + U2A). */
  private turnBusyDepth = 0;
  private bootstrapDone: Promise<void>;

  constructor(
    readonly sessionId: string,
    private readonly client: ManagedAcpClient,
    private readonly emit: (ev: RuntimeEvent) => void,
    private stopRequested = false
  ) {
    this.bootstrapDone = Promise.resolve();
  }

  get pid(): number | undefined {
    return this.client.pid;
  }

  get providerSessionId(): string | undefined {
    return this.client.providerSession;
  }

  isAlive(): boolean {
    return !this.stopRequested && this.client.isAlive();
  }

  /**
   * Turn busy ≠ session live. Session may remain alive between turns;
   * busy means a managed prompt is still settling (tools/response not done).
   */
  isTurnBusy(): boolean {
    return this.turnBusyDepth > 0;
  }

  /** Tests / callers may await bootstrap completion (prompt path finished). */
  async waitBootstrap(): Promise<void> {
    await this.bootstrapDone;
  }

  /**
   * U2A follow-up: send a fixed-format user answer as the next session/prompt.
   * Same delivery rules as bootstrap — end_turn + non-empty text → prompt_complete.
   */
  async sendFollowUpPrompt(prompt: string): Promise<void> {
    if (this.stopRequested || !this.client.isAlive()) {
      throw new Error(`Managed session not alive for follow-up: ${this.sessionId}`);
    }
    const text = prompt.trim();
    if (!text) throw new Error("sendFollowUpPrompt requires non-empty prompt");
    // Wait for any in-flight bootstrap/prior prompt before sending the next one.
    await this.bootstrapDone;
    // Only sessionId is read from plan for prompt_complete emission.
    const plan: LaunchPlan = {
      sessionId: this.sessionId,
      profileId: "",
      cwd: "",
      env: {},
    };
    await this.runTurn(() =>
      runManagedBootstrapPrompt(plan, this.emit, this.client, text)
    );
  }

  async stop(reason: StopReason): Promise<void> {
    this.stopRequested = true;
    await this.client.stop(
      reason === "user" || reason === "interrupt" || reason === "shutdown"
        ? reason
        : "interrupt"
    );
  }

  /**
   * Start a background managed prompt and keep turn-busy until it settles.
   * Used for bootstrap / post-load first prompt (fire-and-forget from startSession).
   */
  beginBackgroundTurn(work: () => Promise<void>): Promise<void> {
    const turn = this.runTurn(work);
    this.bootstrapDone = turn;
    return turn;
  }

  /** Track turn busy/idle around one managed session/prompt. */
  private async runTurn(work: () => Promise<void>): Promise<void> {
    this.turnBusyDepth += 1;
    try {
      await work();
    } finally {
      this.turnBusyDepth = Math.max(0, this.turnBusyDepth - 1);
    }
  }
}

export async function stopAcpClientQuiet(
  client: Pick<ManagedAcpClient, "stop">
): Promise<void> {
  try {
    await client.stop("interrupt");
  } catch {
    // best-effort — process may already be dead
  }
}

/**
 * Bind adapter-level permission ask hooks to AcpClient callbacks (sessionId filled).
 * Same ask/allow/deny mapping as Grok: missing ask handler → deny; never yolo.
 */
export function bindAcpPermissionHooks(
  sessionId: string,
  permissionPolicy: AcpPermissionPolicy,
  hooks: AcpPermissionAskHooks
): {
  onPermissionAsk?: (info: {
    toolTitle: string;
    toolCallId?: string;
    options: AcpPermissionOption[];
  }) => Promise<"allow" | "deny">;
} {
  const mapInfo = (info: {
    toolTitle: string;
    toolCallId?: string;
    options: AcpPermissionOption[];
  }) => ({
    sessionId,
    toolTitle: info.toolTitle,
    toolCallId: info.toolCallId,
    options: (info.options ?? []).map((o) => ({
      optionId: o.optionId,
      kind: o.kind,
      name: o.name,
    })),
  });

  return {
    onPermissionAsk:
      permissionPolicy === "ask"
        ? async (info) => {
            if (!hooks.onPermissionAsk) return "deny";
            return hooks.onPermissionAsk(mapInfo(info));
          }
        : undefined,
  };
}

export type StartManagedAcpSessionInput = {
  plan: LaunchPlan;
  emit: (ev: RuntimeEvent) => void;
  client: ManagedAcpClient;
  /** Override default bootstrap text when plan.bootstrapPrompt is empty. */
  defaultBootstrapPrompt?: string;
};

export type ResumeManagedAcpSessionInput = {
  plan: LaunchPlan;
  emit: (ev: RuntimeEvent) => void;
  client: ManagedAcpClient;
  /** Provider ACP sessionId (machine-local resume token). */
  providerSessionId: string;
  /**
   * When set, send a fresh session/prompt after load.
   * History replay from load is never delivered; only this prompt may.
   * When omitted/empty, session stays live with no bootstrap prompt.
   */
  bootstrapPrompt?: string;
};

/**
 * Run managed bootstrap prompt after a successful connect/load.
 * On successful end_turn + non-empty assistant text → session.prompt_complete.
 * Failure / interrupt / empty → reportFailed + stop; never leaves an orphan live process.
 */
function runManagedBootstrapPrompt(
  plan: LaunchPlan,
  emit: (ev: RuntimeEvent) => void,
  client: ManagedAcpClient,
  bootstrap: string
): Promise<void> {
  return client
    .sendPrompt(bootstrap)
    .then(async (result) => {
      const stopReason = (result.stopReason || "end_turn").toLowerCase();
      const assistantText = (result.assistantText || "").trim();
      // Only successful end_turn with non-empty message is a deliverable report.
      if (stopReason !== "end_turn") {
        client.reportFailed(
          `ACP session/prompt stopReason=${result.stopReason || "unknown"} (no auto-delivery)`
        );
        await stopAcpClientQuiet(client);
        return;
      }
      if (!assistantText) {
        client.reportFailed("ACP assistant response empty (no auto-delivery)");
        await stopAcpClientQuiet(client);
        return;
      }
      emit({
        type: "session.prompt_complete",
        sessionId: plan.sessionId,
        assistantText,
        stopReason: result.stopReason || "end_turn",
      });
    })
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (/interrupted|session stopped/i.test(message)) {
        client.reportFailed(`session interrupted: ${message}`);
        await stopAcpClientQuiet(client);
        return;
      }
      client.reportFailed(message);
      await stopAcpClientQuiet(client);
    });
}

/**
 * Handshake (session/new) then run managed bootstrap prompt in the background.
 * On successful end_turn + non-empty assistant text → session.prompt_complete.
 * Failure / interrupt / empty → reportFailed + stop; never leaves an orphan live process.
 */
export async function startManagedAcpSession(
  input: StartManagedAcpSessionInput
): Promise<AcpManagedSession> {
  const { plan, emit, client } = input;
  // Explicit empty bootstrapPrompt means: go live without a first session/prompt
  // (reject-resume restores the process, then injects U2A ## Review Feedback).
  // Omitted/undefined still falls back to default bootstrap for normal startSession.
  const bootstrap =
    plan.bootstrapPrompt !== undefined
      ? plan.bootstrapPrompt.trim()
      : input.defaultBootstrapPrompt?.trim() || DEFAULT_BOOTSTRAP;

  // Handshake must succeed before startSession returns live (fail-loud), and a
  // failed initialize/auth/session-new must not leave an orphan bridge process.
  try {
    await client.connect({ mode: "new" });
  } catch (err) {
    await stopAcpClientQuiet(client);
    throw err;
  }

  const session = new AcpManagedSession(plan.sessionId, client, emit);
  // Session is live after connect; turn busy tracks the in-flight bootstrap only.
  if (bootstrap) {
    session.beginBackgroundTurn(() =>
      runManagedBootstrapPrompt(plan, emit, client, bootstrap)
    );
  }
  return session;
}

/**
 * Native ACP resume: new bridge process + initialize + session/load (never session/new).
 * Fail-loud when loadSession is unsupported or load fails; always cleans up the process.
 * History notifications from load are isolated by AcpClient and never auto-deliver.
 */
export async function resumeManagedAcpSession(
  input: ResumeManagedAcpSessionInput
): Promise<AcpManagedSession> {
  const { plan, emit, client, providerSessionId } = input;
  const loadId = providerSessionId.trim();
  if (!loadId) {
    throw new Error("resumeManagedAcpSession requires non-empty providerSessionId");
  }

  try {
    await client.connect({ mode: "load", providerSessionId: loadId });
  } catch (err) {
    // Honest failure: never fall back to session/new. Kill orphan bridge process.
    await stopAcpClientQuiet(client);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message);
  }

  const bootstrap = input.bootstrapPrompt?.trim() || plan.bootstrapPrompt?.trim() || "";
  // Optional post-load prompt only — empty means stay live without auto-delivery.
  const session = new AcpManagedSession(plan.sessionId, client, emit);
  if (bootstrap) {
    session.beginBackgroundTurn(() =>
      runManagedBootstrapPrompt(plan, emit, client, bootstrap)
    );
  }
  return session;
}

export function parseAcpResumeToken(raw: string): ResumeToken {
  return { raw, providerSessionId: raw };
}

/**
 * Capabilities for bridges verified to advertise agentCapabilities.loadSession
 * (Grok, OpenCode, Codex, Claude Agent ACP, GitHub Copilot ACP).
 * Runtime still gates each resume on the live initialize handshake.
 */
export function loadSessionAcpCapabilities(
  authModel: ProviderCapabilities["authModel"] = "external-app"
): ProviderCapabilities {
  return {
    canSpawn: true,
    canResume: true,
    canStopGraceful: true,
    needsTty: false,
    supportsWorktreeCwd: true,
    authModel,
    observeLevel: "structured",
  };
}

export function mapAcpProcessExit(
  code: number | null,
  signal?: string
): RuntimeEvent {
  if (signal && signal !== "SIGTERM" && signal !== "SIGINT") {
    return { type: "session.failed", sessionId: "", error: `signal:${signal}` };
  }
  if (
    code === 0 ||
    (code === null && (signal === "SIGTERM" || signal === "SIGINT"))
  ) {
    return { type: "session.exited", sessionId: "", exitCode: code };
  }
  if (code !== 0 && code != null) {
    return { type: "session.failed", sessionId: "", error: `exit:${code}` };
  }
  return { type: "session.exited", sessionId: "", exitCode: code };
}

/**
 * Shared capabilities for ACP bridges without verified loadSession
 * (currently antigravity-acp / agy-acp only among product adapters).
 */
export function mainstreamAcpCapabilities(): {
  canSpawn: true;
  canResume: false;
  canStopGraceful: true;
  needsTty: false;
  supportsWorktreeCwd: true;
  authModel: "external-app";
  observeLevel: "structured";
} {
  return {
    canSpawn: true,
    canResume: false,
    canStopGraceful: true,
    needsTty: false,
    supportsWorktreeCwd: true,
    authModel: "external-app",
    observeLevel: "structured",
  };
}
