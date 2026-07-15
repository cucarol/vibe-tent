// Provider-neutral managed ACP session: connect + bootstrap prompt + delivery events.
// Adapters supply a connected-ready client (AcpClient or thin wrapper); no argv/auth here.

import type { ManagedSession, ResumeToken } from "../types.js";
import type { RuntimeEvent, StopReason } from "../../runtime/types.js";
import type { LaunchPlan } from "../types.js";
import type { AcpPermissionOption, AcpPermissionPolicy } from "./types.js";
import type { AcpStartResult } from "./client.js";

const DEFAULT_BOOTSTRAP =
  "Tent session started. Read the task envelope via Tent Task API; do not invent missing content.";

/** Minimal client surface used by the managed bootstrap helper. */
export type ManagedAcpClient = {
  readonly pid: number | undefined;
  readonly providerSession: string | undefined;
  isAlive(): boolean;
  connect(): Promise<{ pid: number; providerSessionId: string }>;
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
  onPermissionAskFailSafe?: (info: {
    sessionId: string;
    toolTitle: string;
    toolCallId?: string;
    options: Array<{ optionId: string; kind?: string; name?: string }>;
  }) => Promise<void>;
};

export class AcpManagedSession implements ManagedSession {
  constructor(
    readonly sessionId: string,
    private readonly client: ManagedAcpClient,
    private readonly bootstrapDone: Promise<void>,
    private stopRequested = false
  ) {}

  get pid(): number | undefined {
    return this.client.pid;
  }

  get providerSessionId(): string | undefined {
    return this.client.providerSession;
  }

  isAlive(): boolean {
    return !this.stopRequested && this.client.isAlive();
  }

  /** Tests / callers may await bootstrap completion (prompt path finished). */
  async waitBootstrap(): Promise<void> {
    await this.bootstrapDone;
  }

  async stop(reason: StopReason): Promise<void> {
    this.stopRequested = true;
    await this.client.stop(
      reason === "user" || reason === "interrupt" || reason === "shutdown"
        ? reason
        : "interrupt"
    );
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
  onPermissionAskFailSafe?: (info: {
    toolTitle: string;
    toolCallId?: string;
    options: AcpPermissionOption[];
  }) => Promise<void>;
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
    onPermissionAskFailSafe:
      permissionPolicy === "ask" && hooks.onPermissionAskFailSafe
        ? async (info) => {
            await hooks.onPermissionAskFailSafe!(mapInfo(info));
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

/**
 * Handshake (connect) then run managed bootstrap prompt in the background.
 * On successful end_turn + non-empty assistant text → session.prompt_complete.
 * Failure / interrupt / empty → reportFailed + stop; never leaves an orphan live process.
 */
export async function startManagedAcpSession(
  input: StartManagedAcpSessionInput
): Promise<AcpManagedSession> {
  const { plan, emit, client } = input;
  const bootstrap =
    plan.bootstrapPrompt?.trim() ||
    input.defaultBootstrapPrompt?.trim() ||
    DEFAULT_BOOTSTRAP;

  // Handshake must succeed before startSession returns live (fail-loud).
  await client.connect();

  const promptDone = client
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

  return new AcpManagedSession(plan.sessionId, client, promptDone);
}

export function parseAcpResumeToken(raw: string): ResumeToken {
  return { raw, providerSessionId: raw };
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

/** Shared capabilities for mainstream npx ACP bridges (codex / claude). */
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
