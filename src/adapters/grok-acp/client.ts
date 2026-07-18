// Grok ACP stdio client — thin wrapper over shared AcpClient.
// Provider auth (xai.api_key / cached_token) stays here; transport is provider-neutral.

import {
  AcpClient,
  type AcpClientOptions,
  type AcpConnectOptions,
  type AcpConnectResult,
  type AcpStartResult,
} from "../acp/client.js";
import type { AcpMcpServerWire, AcpSkillMetaRef } from "../acp/mcp-skills.js";
import type { AcpPermissionOption } from "../acp/types.js";
import type { RuntimeEvent } from "../../runtime/types.js";
import type { GrokAcpPermissionPolicy } from "./types.js";

export type GrokAcpClientOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  sessionId: string;
  /** Retained for call-site compatibility; not used by the stdio transport. */
  model: string;
  promptTimeoutMs?: number;
  permissionPolicy: GrokAcpPermissionPolicy;
  /** Snapshot mcpServers for session/new|load (may hold secrets; never log). */
  mcpServers?: AcpMcpServerWire[];
  /** Skill name/path refs for `_meta.tent.skills` (no SKILL.md bodies). */
  skills?: AcpSkillMetaRef[];
  /** Emit RuntimeEvent fragments (caller fills sessionId where needed). */
  emit: (ev: RuntimeEvent) => void;
  /**
   * When permissionPolicy is "ask", resolve allow/deny via Local Service
   * tool-approval store (never agent self-approve). Return "allow" | "deny".
   * Store expiry is the sole authority; missing callback → deny (cancelled).
   */
  onPermissionAsk?: (info: {
    toolTitle: string;
    toolCallId?: string;
    options: AcpPermissionOption[];
  }) => Promise<"allow" | "deny">;
};

export type GrokAcpStartResult = AcpStartResult;

/**
 * Grok-branded ACP client. Delegates JSON-RPC/stdio lifecycle to {@link AcpClient};
 * only Grok auth method selection is provider-specific.
 */
export class GrokAcpClient {
  private readonly inner: AcpClient;

  constructor(options: GrokAcpClientOptions) {
    void options.model;
    const acpOptions: AcpClientOptions = {
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      sessionId: options.sessionId,
      promptTimeoutMs: options.promptTimeoutMs,
      permissionPolicy: options.permissionPolicy,
      mcpServers: options.mcpServers,
      skills: options.skills,
      label: "Grok ACP",
      emit: options.emit,
      onPermissionAsk: options.onPermissionAsk,
      authenticate: async (authMethods) => {
        const ids = new Set(authMethods.map((m) => m.id));
        const methodId = ids.has("xai.api_key")
          ? "xai.api_key"
          : ids.has("cached_token")
            ? "cached_token"
            : null;
        if (!methodId) {
          throw new Error(
            "Grok ACP 未提供可用的认证方式（需要 xai.api_key 或 cached_token）。请确认 grok CLI 与 CPA 配置。"
          );
        }
        return { methodId };
      },
    };
    this.inner = new AcpClient(acpOptions);
  }

  get pid(): number | undefined {
    return this.inner.pid;
  }

  get providerSession(): string | undefined {
    return this.inner.providerSession;
  }

  get lastAssistantText(): string {
    return this.inner.lastAssistantText;
  }

  get lastStderrTail(): string {
    return this.inner.lastStderrTail;
  }

  isAlive(): boolean {
    return this.inner.isAlive();
  }

  connect(options?: AcpConnectOptions): Promise<AcpConnectResult> {
    return this.inner.connect(options);
  }

  sendPrompt(bootstrapPrompt: string): Promise<GrokAcpStartResult> {
    return this.inner.sendPrompt(bootstrapPrompt);
  }

  stop(reason: "user" | "interrupt" | "shutdown"): Promise<void> {
    return this.inner.stop(reason);
  }

  reportFailed(error: string): void {
    this.inner.reportFailed(error);
  }

  reportExited(exitCode?: number | null): void {
    this.inner.reportExited(exitCode);
  }
}
