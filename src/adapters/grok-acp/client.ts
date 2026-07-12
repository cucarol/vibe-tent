// ACP stdio client for Grok CLI — handshake + prompt + permission map.
// No network calls; never contacts api.x.ai. CPA base URL stays in ~/.grok/config.toml.

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import type { RuntimeEvent } from "../../runtime/types.js";
import type {
  AcpJsonRpcNotification,
  AcpJsonRpcResponse,
  AcpPermissionOption,
  AcpSessionUpdate,
  GrokAcpPermissionPolicy,
} from "./types.js";
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
} from "./types.js";

export type GrokAcpClientOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  sessionId: string;
  model: string;
  promptTimeoutMs?: number;
  permissionPolicy: GrokAcpPermissionPolicy;
  permissionTimeoutMs?: number;
  /** Emit RuntimeEvent fragments (caller fills sessionId where needed). */
  emit: (ev: RuntimeEvent) => void;
  /**
   * When permissionPolicy is "ask", resolve allow/deny.
   * Return "allow" | "deny". Timeout → deny.
   */
  onPermissionAsk?: (info: {
    toolTitle: string;
    options: AcpPermissionOption[];
  }) => Promise<"allow" | "deny">;
};

export type GrokAcpStartResult = {
  pid: number;
  providerSessionId: string;
  stopReason?: string;
  assistantText: string;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class GrokAcpClient {
  private proc: ChildProcess | null = null;
  private lines: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private assistantText = "";
  private stderrTail = "";
  private closed = false;
  private providerSessionId: string | undefined;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private exitWaiters: Array<() => void> = [];

  constructor(private readonly options: GrokAcpClientOptions) {}

  get pid(): number | undefined {
    return this.proc?.pid ?? undefined;
  }

  get providerSession(): string | undefined {
    return this.providerSessionId;
  }

  get lastAssistantText(): string {
    return this.assistantText;
  }

  get lastStderrTail(): string {
    return this.stderrTail;
  }

  isAlive(): boolean {
    const pid = this.proc?.pid;
    if (pid == null || pid <= 0 || this.closed) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn ACP process + initialize/authenticate/session/new.
   * Emits session.live when the ACP session exists. Does not block on prompt.
   */
  async connect(): Promise<{ pid: number; providerSessionId: string }> {
    this.spawnProcess();
    const pid = this.proc!.pid!;
    this.options.emit({
      type: "session.starting",
      sessionId: this.options.sessionId,
    });

    try {
      const init = (await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      })) as { authMethods?: Array<{ id: string }> };

      const authMethods = new Set((init.authMethods ?? []).map((m) => m.id));
      const methodId = authMethods.has("xai.api_key")
        ? "xai.api_key"
        : authMethods.has("cached_token")
          ? "cached_token"
          : null;
      if (!methodId) {
        throw new Error(
          "Grok ACP 未提供可用的认证方式（需要 xai.api_key 或 cached_token）。请确认 grok CLI 与 CPA 配置。"
        );
      }

      await this.request("authenticate", {
        methodId,
        _meta: { headless: true },
      });

      const session = (await this.request(
        "session/new",
        { cwd: this.options.cwd, mcpServers: [] },
        60_000
      )) as { sessionId?: string };
      if (!session.sessionId) {
        throw new Error("Grok ACP session/new 未返回 sessionId");
      }
      this.providerSessionId = session.sessionId;

      this.options.emit({
        type: "session.live",
        sessionId: this.options.sessionId,
        pid,
      });

      return { pid, providerSessionId: session.sessionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const detail = this.stderrTail
        ? `${message} (stderr: ${this.stderrTail.slice(-500)})`
        : message;
      throw new Error(detail);
    }
  }

  /**
   * Send session/prompt with task pointer / relay text. Maps session/update events.
   * Safe to call after connect(); failures emit session.failed.
   */
  async sendPrompt(bootstrapPrompt: string): Promise<GrokAcpStartResult> {
    if (!this.providerSessionId) {
      throw new Error("Grok ACP session 尚未建立，无法 prompt");
    }
    const pid = this.proc?.pid;
    if (pid == null) {
      throw new Error("Grok ACP 进程不可用");
    }
    try {
      const promptTimeout =
        this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
      const result = (await this.request(
        "session/prompt",
        {
          sessionId: this.providerSessionId,
          prompt: [{ type: "text", text: bootstrapPrompt }],
        },
        promptTimeout
      )) as { stopReason?: string };

      return {
        pid,
        providerSessionId: this.providerSessionId,
        stopReason: result.stopReason,
        assistantText: this.assistantText.trim(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const detail = this.stderrTail
        ? `${message} (stderr: ${this.stderrTail.slice(-500)})`
        : message;
      throw new Error(detail);
    }
  }

  /** Keep process alive after bootstrap for probe/stop (caller owns lifecycle). */
  async stop(reason: "user" | "interrupt" | "shutdown"): Promise<void> {
    void reason;
    if (this.closed) return;
    this.closed = true;
    this.rejectAllPending(new Error("session stopped"));

    const proc = this.proc;
    if (!proc || proc.killed) {
      this.cleanupStreams();
      return;
    }

    try {
      proc.kill("SIGTERM");
    } catch {
      // already dead
    }

    await Promise.race([
      this.waitExit(),
      sleep(1500).then(() => this.forceKill()),
    ]);
    this.cleanupStreams();
  }

  private spawnProcess(): void {
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    });

    if (child.pid == null) {
      throw new Error(
        `无法启动 Grok ACP 进程: ${this.options.command} ${this.options.args.join(" ")}`
      );
    }

    this.proc = child;
    this.lines = readline.createInterface({ input: child.stdout! });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      this.options.emit({
        type: "session.stdout_tail",
        sessionId: this.options.sessionId,
        text,
      });
    });

    this.lines.on("line", (line) => this.onLine(line));

    child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.closed = true;
      this.rejectAllPending(
        new Error(
          signal
            ? `Grok ACP 进程信号退出: ${signal}`
            : `Grok ACP 进程退出 code=${code}`
        )
      );
      for (const w of this.exitWaiters) w();
      this.exitWaiters = [];
    });

    child.on("error", (err) => {
      this.closed = true;
      this.rejectAllPending(
        new Error(`Grok ACP 进程错误: ${err.message}`)
      );
    });
  }

  private onLine(line: string): void {
    let message: AcpJsonRpcResponse | AcpJsonRpcNotification;
    try {
      message = JSON.parse(line) as AcpJsonRpcResponse | AcpJsonRpcNotification;
    } catch {
      return;
    }

    if ("method" in message && message.method === "session/update") {
      this.handleSessionUpdate(
        (message.params as { update?: AcpSessionUpdate } | undefined)?.update
      );
      return;
    }

    if (
      "method" in message &&
      message.method === "session/request_permission" &&
      message.id !== undefined
    ) {
      void this.handlePermissionRequest(
        message.id,
        message.params as {
          options?: AcpPermissionOption[];
          toolCall?: { title?: string; toolCallId?: string };
        }
      );
      return;
    }

    if ("method" in message && message.id !== undefined && message.method) {
      // Unexpected server→client request: refuse rather than hang.
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: "Client-side requests are disabled for Tent grok-acp adapter.",
        },
      });
      return;
    }

    if (!("id" in message) || message.id === undefined) return;
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ("error" in message && message.error) {
      pending.reject(
        new Error(message.error.message || JSON.stringify(message.error))
      );
    } else {
      pending.resolve(("result" in message ? message.result : undefined) ?? {});
    }
  }

  private handleSessionUpdate(update: AcpSessionUpdate | undefined): void {
    if (!update) return;
    const kind = update.sessionUpdate ?? "";
    if (
      (kind === "agent_message_chunk" || kind === "agent_thought_chunk") &&
      update.content?.text
    ) {
      this.assistantText += update.content.text;
      // Diagnostics only — Tent is not a chat UI.
      this.options.emit({
        type: "session.stdout_tail",
        sessionId: this.options.sessionId,
        text: `[${kind}] ${update.content.text}`,
      });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const title =
        (typeof update.title === "string" && update.title) ||
        update.toolCallId ||
        "tool";
      const status = typeof update.status === "string" ? update.status : "";
      this.options.emit({
        type: "session.stdout_tail",
        sessionId: this.options.sessionId,
        text: `[${kind}] ${title}${status ? ` (${status})` : ""}\n`,
      });
      return;
    }
    if (kind) {
      this.options.emit({
        type: "session.stdout_tail",
        sessionId: this.options.sessionId,
        text: `[session/update] ${kind}\n`,
      });
    }
  }

  private async handlePermissionRequest(
    id: number | string,
    params: {
      options?: AcpPermissionOption[];
      toolCall?: { title?: string; toolCallId?: string };
    }
  ): Promise<void> {
    const options = params.options ?? [];
    const toolTitle =
      params.toolCall?.title || params.toolCall?.toolCallId || "tool";
    const policy = this.options.permissionPolicy;

    let decision: "allow" | "deny" = "deny";
    if (policy === "allow") {
      decision = "allow";
    } else if (policy === "deny") {
      decision = "deny";
    } else {
      // ask — never auto-yolo
      this.options.emit({
        type: "session.waiting_user",
        sessionId: this.options.sessionId,
        summary: `Grok ACP 请求工具权限: ${toolTitle}（policy=ask）`,
      });
      try {
        if (this.options.onPermissionAsk) {
          decision = await Promise.race([
            this.options.onPermissionAsk({ toolTitle, options }),
            sleep(
              this.options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
            ).then((): "deny" => "deny"),
          ]);
        } else {
          decision = "deny";
        }
      } catch {
        decision = "deny";
      }
    }

    const outcome =
      decision === "allow"
        ? selectAllowOnce(options)
        : { outcome: "cancelled" as const };

    this.write({
      jsonrpc: "2.0",
      id,
      result: { outcome },
    });

    this.options.emit({
      type: "session.stdout_tail",
      sessionId: this.options.sessionId,
      text: `[permission] ${toolTitle} → ${decision === "allow" ? "allow_once" : "deny/cancelled"}\n`,
    });
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = 30_000
  ): Promise<unknown> {
    if (this.closed || !this.proc?.stdin) {
      return Promise.reject(new Error(`Grok ACP 已关闭，无法调用 ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Grok ACP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private write(payload: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(JSON.stringify(payload) + "\n");
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private waitExit(): Promise<void> {
    if (!this.proc || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  private async forceKill(): Promise<void> {
    const proc = this.proc;
    const pid = proc?.pid;
    if (!proc || pid == null) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
        setTimeout(resolve, 1500);
      });
    } else {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  private cleanupStreams(): void {
    try {
      this.lines?.close();
    } catch {
      // ignore
    }
    this.lines = null;
  }
}

function selectAllowOnce(options: AcpPermissionOption[]): {
  outcome: "selected";
  optionId: string;
} | { outcome: "cancelled" } {
  // Never prefer allow_always — no unconditional yolo.
  const once =
    options.find((o) => o.kind === "allow_once") ||
    options.find((o) => o.optionId === "allow_once");
  if (once?.optionId) {
    return { outcome: "selected", optionId: once.optionId };
  }
  // If server only offers allow_always, still refuse to escalate — cancel.
  return { outcome: "cancelled" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
