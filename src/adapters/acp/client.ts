// Provider-neutral ACP stdio client — handshake + prompt + permission map.
// No provider argv/auth/env/model knowledge; adapters supply launch + auth hooks.

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import type { RuntimeEvent } from "../../runtime/types.js";
import type {
  AcpAuthenticateParams,
  AcpJsonRpcNotification,
  AcpJsonRpcResponse,
  AcpPermissionOption,
  AcpPermissionPolicy,
  AcpSessionUpdate,
} from "./types.js";
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
} from "./types.js";

/** Slack after store-authoritative permission timeout before client fail-safe denies. */
export const PERMISSION_FAILSAFE_SLACK_MS = 5_000;
const LOAD_REPLAY_QUIET_MS = 100;
const LOAD_REPLAY_MAX_WAIT_MS = 2_000;

export type AcpClientOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  sessionId: string;
  promptTimeoutMs?: number;
  permissionPolicy: AcpPermissionPolicy;
  permissionTimeoutMs?: number;
  /**
   * Human-readable label for errors / waiting summaries (e.g. "Grok ACP").
   * Default: "ACP". Never used for argv/auth selection.
   */
  label?: string;
  /** Emit RuntimeEvent fragments (caller fills sessionId where needed). */
  emit: (ev: RuntimeEvent) => void;
  /**
   * After initialize, select auth method from server-advertised list.
   * Return authenticate RPC params, or throw. Omit to skip authenticate.
   */
  authenticate?: (
    authMethods: Array<{ id: string }>
  ) => Promise<AcpAuthenticateParams>;
  /**
   * When permissionPolicy is "ask", resolve allow/deny via Local Service
   * tool-approval store (never agent self-approve). Return "allow" | "deny".
   * Store expiry is authoritative; missing callback → deny (cancelled).
   */
  onPermissionAsk?: (info: {
    toolTitle: string;
    toolCallId?: string;
    options: AcpPermissionOption[];
  }) => Promise<"allow" | "deny">;
  /**
   * Bounded fail-safe when onPermissionAsk does not settle past store timeout + slack.
   * Must cancel/expire the same store item so nothing remains user-approvable.
   */
  onPermissionAskFailSafe?: (info: {
    toolTitle: string;
    toolCallId?: string;
    options: AcpPermissionOption[];
  }) => Promise<void>;
};

export type AcpStartResult = {
  pid: number;
  providerSessionId: string;
  stopReason?: string;
  assistantText: string;
};

/** connect() mode: session/new (default) vs native session/load resume. */
export type AcpConnectMode = "new" | "load";

export type AcpConnectOptions = {
  mode?: AcpConnectMode;
  /**
   * Provider ACP sessionId to load. Required when mode is "load".
   * Must equal the machine-local resume token (providerSessionId).
   */
  providerSessionId?: string;
};

export type AcpConnectResult = {
  pid: number;
  providerSessionId: string;
  /** True when initialize advertised agentCapabilities.loadSession. */
  loadSessionSupported: boolean;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class AcpClient {
  private proc: ChildProcess | null = null;
  private lines: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Accumulated agent_message_chunk only — used as managed delivery report. */
  private assistantText = "";
  private stderrTail = "";
  private closed = false;
  private stopRequested = false;
  /** Dedupe spontaneous exit vs prompt-failure / intentional stop terminal events. */
  private terminalEmitted = false;
  private providerSessionId: string | undefined;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private exitWaiters: Array<() => void> = [];
  private readonly label: string;
  /**
   * Only chunks received while our own session/prompt request is pending belong
   * to the next delivery. Load replay (including notifications arriving after
   * the load response) and unsolicited provider updates stay diagnostic-only.
   */
  private collectingPromptResponse = false;
  /** Defensive quarantine for bridges that resolve load before their final replay notification. */
  private quarantiningLoadReplay = false;
  private lastLoadReplayUpdateAt = 0;
  /** Cached from initialize agentCapabilities.loadSession (default false). */
  private loadSessionSupported = false;
  /** Concurrent ask-policy requests keep the session waiting until all resolve. */
  private permissionAsksInFlight = 0;

  constructor(private readonly options: AcpClientOptions) {
    this.label =
      typeof options.label === "string" && options.label.trim()
        ? options.label.trim()
        : "ACP";
  }

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
   * Spawn ACP process + initialize/authenticate, then session/new or session/load.
   * Emits session.live when the ACP session exists. Does not block on prompt.
   *
   * Load mode requires agentCapabilities.loadSession === true from this initialize
   * handshake (fail-loud otherwise). History notifications are isolated and never
   * accumulate into assistantText / prompt delivery.
   */
  async connect(options?: AcpConnectOptions): Promise<AcpConnectResult> {
    const mode: AcpConnectMode = options?.mode === "load" ? "load" : "new";
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
      })) as {
        authMethods?: Array<{ id: string }>;
        agentCapabilities?: { loadSession?: boolean };
      };

      this.loadSessionSupported =
        init.agentCapabilities?.loadSession === true;

      if (this.options.authenticate) {
        const authParams = await this.options.authenticate(
          init.authMethods ?? []
        );
        // headless is always set by the client; adapter may add extra _meta fields.
        const meta =
          authParams._meta &&
          typeof authParams._meta === "object" &&
          !Array.isArray(authParams._meta)
            ? { ...(authParams._meta as Record<string, unknown>), headless: true }
            : { headless: true };
        await this.request("authenticate", {
          ...authParams,
          _meta: meta,
        });
      }

      let providerSessionId: string;
      if (mode === "load") {
        if (!this.loadSessionSupported) {
          throw new Error(
            `${this.label} does not advertise agentCapabilities.loadSession; cannot session/load`
          );
        }
        const loadId =
          typeof options?.providerSessionId === "string"
            ? options.providerSessionId.trim()
            : "";
        if (!loadId) {
          throw new Error(
            `${this.label} session/load requires providerSessionId (resume token)`
          );
        }
        this.assistantText = "";
        this.quarantiningLoadReplay = true;
        this.lastLoadReplayUpdateAt = Date.now();
        try {
          await this.request(
            "session/load",
            {
              sessionId: loadId,
              cwd: this.options.cwd,
              mcpServers: [],
            },
            60_000
          );
          await this.waitForLoadReplayQuiescence();
        } finally {
          this.quarantiningLoadReplay = false;
          this.assistantText = "";
        }
        this.providerSessionId = loadId;
        providerSessionId = loadId;
      } else {
        const session = (await this.request(
          "session/new",
          { cwd: this.options.cwd, mcpServers: [] },
          60_000
        )) as { sessionId?: string };
        if (!session.sessionId) {
          throw new Error(`${this.label} session/new 未返回 sessionId`);
        }
        this.providerSessionId = session.sessionId;
        providerSessionId = session.sessionId;
      }

      this.options.emit({
        type: "session.live",
        sessionId: this.options.sessionId,
        pid,
      });

      return {
        pid,
        providerSessionId,
        loadSessionSupported: this.loadSessionSupported,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const detail = this.stderrTail
        ? `${message} (stderr: ${this.stderrTail.slice(-500)})`
        : message;
      throw new Error(detail);
    }
  }

  /**
   * Send session/prompt with managed bootstrap (Context Card + user prompt).
   * Accumulates agent_message_chunk only for the final report text.
   * Safe to call after connect(); failures throw (caller emits session.failed).
   */
  async sendPrompt(bootstrapPrompt: string): Promise<AcpStartResult> {
    if (!this.providerSessionId) {
      throw new Error(`${this.label} session 尚未建立，无法 prompt`);
    }
    const pid = this.proc?.pid;
    if (pid == null) {
      throw new Error(`${this.label} 进程不可用`);
    }
    // Fresh accumulation per prompt — never mix reconnect/retry chunks.
    this.assistantText = "";
    this.collectingPromptResponse = true;
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

      if (this.stopRequested) {
        throw new Error("session interrupted before prompt completed");
      }

      return {
        pid,
        providerSessionId: this.providerSessionId,
        stopReason: result.stopReason,
        assistantText: this.assistantText.trim(),
      };
    } catch (err) {
      if (this.stopRequested) {
        throw new Error("session interrupted before prompt completed");
      }
      const message = err instanceof Error ? err.message : String(err);
      const detail = this.stderrTail
        ? `${message} (stderr: ${this.stderrTail.slice(-500)})`
        : message;
      throw new Error(detail);
    } finally {
      this.collectingPromptResponse = false;
    }
  }

  /** Keep process alive after bootstrap for probe/stop (caller owns lifecycle). */
  async stop(reason: "user" | "interrupt" | "shutdown"): Promise<void> {
    void reason;
    if (this.closed && this.stopRequested) return;
    this.stopRequested = true;
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

  /**
   * Emit session.failed once (prompt failure / logical error). Dedupes against
   * spontaneous child-exit terminal emission.
   */
  reportFailed(error: string): void {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.options.emit({
      type: "session.failed",
      sessionId: this.options.sessionId,
      error,
    });
  }

  /**
   * Emit session.exited once (clean managed completion path). Dedupes against
   * spontaneous child-exit and reportFailed.
   */
  reportExited(exitCode: number | null = 0): void {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.options.emit({
      type: "session.exited",
      sessionId: this.options.sessionId,
      exitCode,
    });
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
        `无法启动 ${this.label} 进程: ${this.options.command} ${this.options.args.join(" ")}`
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
            ? `${this.label} 进程信号退出: ${signal}`
            : `${this.label} 进程退出 code=${code}`
        )
      );
      // Spontaneous child exit (no intentional stop / already-reported terminal):
      // always emit a managed terminal event even when no JSON-RPC request is pending,
      // so service can taskFail / release occupation. Dedupe against prompt failure.
      // Non-zero / abnormal signal → failed (occupation release). Clean 0 → exited.
      if (!this.stopRequested && !this.terminalEmitted) {
        this.terminalEmitted = true;
        if (
          (signal && signal !== "SIGTERM" && signal !== "SIGINT") ||
          (code !== 0 && code != null)
        ) {
          this.options.emit({
            type: "session.failed",
            sessionId: this.options.sessionId,
            error: signal
              ? `${this.label} spontaneous exit signal:${signal}`
              : `${this.label} spontaneous exit code=${code}`,
          });
        } else {
          this.options.emit({
            type: "session.exited",
            sessionId: this.options.sessionId,
            exitCode: code,
          });
        }
      }
      for (const w of this.exitWaiters) w();
      this.exitWaiters = [];
    });

    child.on("error", (err) => {
      this.closed = true;
      this.rejectAllPending(
        new Error(`${this.label} 进程错误: ${err.message}`)
      );
      if (!this.stopRequested && !this.terminalEmitted) {
        this.terminalEmitted = true;
        this.options.emit({
          type: "session.failed",
          sessionId: this.options.sessionId,
          error: `${this.label} 进程错误: ${err.message}`,
        });
      }
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
          message: `Client-side requests are disabled for Tent ${this.label} adapter.`,
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
    if (this.quarantiningLoadReplay) {
      this.lastLoadReplayUpdateAt = Date.now();
      return;
    }
    // Tent is not a transcript router. Updates outside a prompt initiated by
    // this client are neither delivery text nor user-facing diagnostics.
    if (!this.collectingPromptResponse) return;
    const kind = update.sessionUpdate ?? "";
    if (kind === "agent_message_chunk" && update.content?.text) {
      // Final report body only — thoughts are diagnostics, not delivery summary.
      this.assistantText += update.content.text;
      this.options.emit({
        type: "session.stdout_tail",
        sessionId: this.options.sessionId,
        text: `[${kind}] ${update.content.text}`,
      });
      return;
    }
    if (kind === "agent_thought_chunk" && update.content?.text) {
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

  private async waitForLoadReplayQuiescence(): Promise<void> {
    const deadline = Date.now() + LOAD_REPLAY_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const observed = this.lastLoadReplayUpdateAt;
      await sleep(LOAD_REPLAY_QUIET_MS);
      if (
        this.lastLoadReplayUpdateAt === observed &&
        Date.now() - observed >= LOAD_REPLAY_QUIET_MS
      ) {
        return;
      }
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
    const toolCallId =
      typeof params.toolCall?.toolCallId === "string"
        ? params.toolCall.toolCallId
        : undefined;
    const policy = this.options.permissionPolicy;
    const tracksAsk = policy === "ask";
    if (tracksAsk) this.permissionAsksInFlight += 1;

    try {
      let decision: "allow" | "deny" = "deny";
      if (policy === "allow") {
        decision = "allow";
      } else if (policy === "deny") {
        decision = "deny";
      } else {
        // ask — never auto-yolo; Local Service store is the sole expiry authority.
        this.options.emit({
          type: "session.waiting_user",
          sessionId: this.options.sessionId,
          summary: `${this.label} 请求工具权限: ${toolTitle}（policy=ask）`,
        });
        try {
          if (this.options.onPermissionAsk) {
            const timeoutMs =
              this.options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
            // Do not invent a second timeout outcome here: store waitForDecision /
            // expireOne is authoritative. Fail-safe only if the bridge hangs past
            // store timeout + slack — and must expire the same store item.
            const askInfo = { toolTitle, toolCallId, options };
            let settled = false;
            const askPromise = this.options
              .onPermissionAsk(askInfo)
              .then((d) => {
                settled = true;
                return d;
              });
            const failSafePromise = sleep(
              timeoutMs + PERMISSION_FAILSAFE_SLACK_MS
            ).then(async (): Promise<"deny"> => {
              if (settled) return "deny";
              if (this.options.onPermissionAskFailSafe) {
                try {
                  await this.options.onPermissionAskFailSafe(askInfo);
                } catch {
                  // best-effort store cancel
                }
              }
              return "deny";
            });
            decision = await Promise.race([askPromise, failSafePromise]);
          } else {
            // No service bridge → deny (safe default; never promote ask→allow).
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
    } finally {
      if (tracksAsk) {
        this.permissionAsksInFlight = Math.max(0, this.permissionAsksInFlight - 1);
        // A single resolved request cannot release another concurrent ask.
        if (
          this.permissionAsksInFlight === 0 &&
          !this.stopRequested &&
          !this.closed
        ) {
          this.options.emit({
            type: "session.live",
            sessionId: this.options.sessionId,
            pid: this.proc?.pid,
          });
        }
      }
    }
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = 30_000
  ): Promise<unknown> {
    if (this.closed || !this.proc?.stdin) {
      return Promise.reject(
        new Error(`${this.label} 已关闭，无法调用 ${method}`)
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} ${method} 超时（${timeoutMs}ms）`));
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
