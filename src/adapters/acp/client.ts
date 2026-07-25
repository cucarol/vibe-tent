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
  DEFAULT_PROMPT_TIMEOUT_MS,
} from "./types.js";
import type { AcpMcpServerWire, AcpSkillMetaRef } from "./mcp-skills.js";
import {
  acpTransportSupportsImage,
  type AcpPromptContentBlock,
  type BootstrapImageRef,
  projectBootstrapImagesToAcpPrompt,
} from "./image-prompt.js";
import {
  isAssistantMessageChunkKind,
  sealAssistantMessageSegment,
  selectFinalAssistantReport,
} from "./assistant-report.js";

const LOAD_REPLAY_QUIET_MS = 100;
const LOAD_REPLAY_MAX_WAIT_MS = 2_000;
const RPC_ERROR_DATA_MAX_CHARS = 600;
const RPC_ERROR_SAFE_KEYS = new Set([
  "code",
  "kind",
  "message",
  "reason",
  "stderr",
  "type",
  // ACP SDK / bridge internals often put the real failure here while message is
  // the opaque "Internal error" (e.g. Claude Agent ACP session resume).
  "details",
  "errorKind",
]);

function formatRpcError(error: NonNullable<AcpJsonRpcResponse["error"]>): string {
  const message = error.message || "ACP JSON-RPC error";
  const code = Number.isFinite(error.code) ? ` [JSON-RPC ${error.code}]` : "";
  const data = summarizeRpcErrorData(error.data);
  return `${message}${code}${data ? ` (${data})` : ""}`;
}

/**
 * Keep provider diagnostics useful without persisting arbitrary payloads.
 * ACP error data may contain tool args, headers, prompts, or credentials.
 */
function summarizeRpcErrorData(data: unknown): string | undefined {
  if (data == null) return undefined;
  if (
    typeof data === "string" ||
    typeof data === "number" ||
    typeof data === "boolean"
  ) {
    return `data=${String(data).slice(0, RPC_ERROR_DATA_MAX_CHARS)}`;
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    return `dataType=${Array.isArray(data) ? "array" : typeof data}`;
  }

  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!RPC_ERROR_SAFE_KEYS.has(key)) continue;
    if (
      value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      safe[key] =
        value == null
          ? null
          : typeof value === "string"
          ? value.slice(0, RPC_ERROR_DATA_MAX_CHARS)
          : value;
    }
  }
  if (Object.keys(safe).length === 0) return undefined;
  return `data=${JSON.stringify(safe).slice(0, RPC_ERROR_DATA_MAX_CHARS)}`;
}

export type AcpClientOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  sessionId: string;
  promptTimeoutMs?: number;
  permissionPolicy: AcpPermissionPolicy;
  /**
   * Human-readable label for errors / waiting summaries (e.g. "Grok ACP").
   * Default: "ACP". Never used for argv/auth selection.
   */
  label?: string;
  /**
   * ACP session/new and session/load mcpServers from the start/resume snapshot.
   * Default []. Running sessions do not hot-update this list.
   * May contain secret values for the in-process JSON-RPC request only — never log.
   */
  mcpServers?: AcpMcpServerWire[];
  /**
   * Skill name/path refs for session `_meta.tent.skills` (no SKILL.md bodies).
   * Tent metadata only — not a claim of universal provider-side skill activation.
   * Optional; omitted when profile has no enabled skills.
   */
  skills?: AcpSkillMetaRef[];
  /**
   * Ephemeral local image path refs for managed bootstrap (paths only).
   * Projected at session/prompt time only when live initialize
   * promptCapabilities.image === true; never persisted by the client.
   */
  bootstrapImageRefs?: BootstrapImageRef[];
  /**
   * Absolute tent system root for safe image reads + valid file:// URIs.
   * Ephemeral only — never SessionRecord.
   */
  bootstrapImageSystemRoot?: string;
  /**
   * Read image bytes under tent system root. Required to attach images when
   * transport supports image. Failures fall back to Markdown pointers.
   */
  readBootstrapImageBinary?: (relativePath: string) => Promise<Uint8Array>;
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
   * Store expiry is the sole authority; missing callback → deny (cancelled).
   * Client does not apply its own permission timeout.
   */
  onPermissionAsk?: (info: {
    toolTitle: string;
    toolCallId?: string;
    options: AcpPermissionOption[];
  }) => Promise<"allow" | "deny">;
};

export type AcpStartResult = {
  pid: number;
  providerSessionId: string;
  stopReason?: string;
  assistantText: string;
};

/**
 * connect() mode:
 * - `new` — session/new (default)
 * - `load` — session/load (history may stream; quarantined, never delivered)
 * - `resume` — session/resume (no history replay; requires sessionCapabilities.resume)
 */
export type AcpConnectMode = "new" | "load" | "resume";

export type AcpConnectOptions = {
  mode?: AcpConnectMode;
  /**
   * Provider ACP sessionId to load/resume. Required when mode is "load" or "resume".
   * Must equal the machine-local resume token (providerSessionId).
   */
  providerSessionId?: string;
};

export type AcpConnectResult = {
  pid: number;
  providerSessionId: string;
  /** True when initialize advertised agentCapabilities.loadSession. */
  loadSessionSupported: boolean;
  /**
   * True when initialize advertised agentCapabilities.sessionCapabilities.resume
   * as an object (including `{}`).
   */
  resumeSessionSupported: boolean;
};

/**
 * ACP: sessionCapabilities.resume is optional. Omitted / null = unsupported.
 * Supplying `{}` (or any non-null object) means the agent supports session/resume.
 */
export function isSessionResumeAdvertised(
  sessionCapabilities: unknown
): boolean {
  if (
    !sessionCapabilities ||
    typeof sessionCapabilities !== "object" ||
    Array.isArray(sessionCapabilities)
  ) {
    return false;
  }
  const resume = (sessionCapabilities as { resume?: unknown }).resume;
  return resume != null && typeof resume === "object" && !Array.isArray(resume);
}

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
  /**
   * Sealed assistant message segments for the in-flight session/prompt.
   * Contiguous agent_message_chunk text forms one segment; tool/status/thought
   * (and any other non-message update) seals the open segment. Delivery summary
   * is the last non-empty segment (see selectFinalAssistantReport).
   */
  private assistantMessageSegments: string[] = [];
  /** Open (unsealed) agent_message_chunk buffer for the current segment. */
  private assistantMessageCurrent = "";
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
  /**
   * Cached from initialize agentCapabilities.sessionCapabilities.resume
   * (object including `{}`; default false until connect).
   */
  private resumeSessionSupported = false;
  /**
   * Cached from initialize agentCapabilities.promptCapabilities.image.
   * Only explicit true counts; omit/false → unsupported (no guessing).
   */
  private promptImageSupported = false;
  /** Concurrent ask-policy requests keep the session waiting until all resolve. */
  private permissionAsksInFlight = 0;
  /** Stop/exit cancellation for in-flight onPermissionAsk waiters. */
  private readonly permissionWaitCancels = new Set<() => void>();

  constructor(private readonly options: AcpClientOptions) {
    this.label =
      typeof options.label === "string" && options.label.trim()
        ? options.label.trim()
        : "ACP";
  }

  /**
   * Build session/new or session/load params from the start/resume snapshot.
   * mcpServers always present (array; may be empty).
   * Skill name/path refs go under `_meta.tent.skills` as Tent metadata only
   * (not a guarantee that every provider activates skills from this field).
   * Must not log returned params (mcpServers may hold secret values).
   */
  private sessionStartParams(
    base: Record<string, unknown>
  ): Record<string, unknown> {
    const mcpServers = Array.isArray(this.options.mcpServers)
      ? this.options.mcpServers
      : [];
    const params: Record<string, unknown> = {
      ...base,
      mcpServers,
    };
    const skills = Array.isArray(this.options.skills) ? this.options.skills : [];
    if (skills.length > 0) {
      params._meta = {
        tent: {
          skills,
        },
      };
    }
    return params;
  }

  get pid(): number | undefined {
    return this.proc?.pid ?? undefined;
  }

  get providerSession(): string | undefined {
    return this.providerSessionId;
  }

  get lastAssistantText(): string {
    return this.finalizeAssistantReport();
  }

  get lastStderrTail(): string {
    return this.stderrTail;
  }

  /**
   * True only when initialize advertised agentCapabilities.promptCapabilities.image === true.
   * Default false until connect(); custom/unclear transports stay false.
   */
  get supportsPromptImage(): boolean {
    return this.promptImageSupported;
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
   * Seal any open segment and return the managed delivery report for this turn:
   * last non-empty assistant message segment (not intermediate narrations).
   */
  private finalizeAssistantReport(): string {
    if (this.assistantMessageCurrent) {
      const sealed = sealAssistantMessageSegment(
        this.assistantMessageSegments,
        this.assistantMessageCurrent
      );
      this.assistantMessageSegments = sealed.segments;
      this.assistantMessageCurrent = sealed.current;
    }
    return selectFinalAssistantReport(this.assistantMessageSegments);
  }

  /** Reset per-prompt accumulation (never mix reconnect/retry chunks). */
  private resetAssistantReport(): void {
    this.assistantMessageSegments = [];
    this.assistantMessageCurrent = "";
  }

  /**
   * Non-message session/update kinds seal the open assistant segment so later
   * message chunks become a new final-report candidate.
   */
  private sealOpenAssistantSegment(): void {
    if (!this.assistantMessageCurrent) return;
    const sealed = sealAssistantMessageSegment(
      this.assistantMessageSegments,
      this.assistantMessageCurrent
    );
    this.assistantMessageSegments = sealed.segments;
    this.assistantMessageCurrent = sealed.current;
  }

  /**
   * Spawn ACP process + initialize/authenticate, then session/new, session/load,
   * or session/resume. Emits session.live when the ACP session exists. Does not
   * block on prompt.
   *
   * - Load mode requires agentCapabilities.loadSession === true. History
   *   notifications are quarantined and never enter assistantText / delivery.
   * - Resume mode requires agentCapabilities.sessionCapabilities.resume (object,
   *   including `{}`). Does not replay history (Tent is not a transcript UI).
   * Both load and resume fail loud and never fall back to session/new.
   */
  async connect(options?: AcpConnectOptions): Promise<AcpConnectResult> {
    const mode: AcpConnectMode =
      options?.mode === "load" || options?.mode === "resume"
        ? options.mode
        : "new";
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
        agentCapabilities?: {
          loadSession?: boolean;
          sessionCapabilities?: { resume?: unknown };
          promptCapabilities?: { image?: boolean };
        };
      };

      this.loadSessionSupported =
        init.agentCapabilities?.loadSession === true;
      this.resumeSessionSupported = isSessionResumeAdvertised(
        init.agentCapabilities?.sessionCapabilities
      );
      // Strict: only explicit true. Missing promptCapabilities → no image blocks.
      this.promptImageSupported = acpTransportSupportsImage(
        init.agentCapabilities
      );

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
      if (mode === "load" || mode === "resume") {
        const method = mode === "resume" ? "session/resume" : "session/load";
        if (mode === "load" && !this.loadSessionSupported) {
          throw new Error(
            `${this.label} does not advertise agentCapabilities.loadSession; cannot session/load`
          );
        }
        if (mode === "resume" && !this.resumeSessionSupported) {
          throw new Error(
            `${this.label} does not advertise agentCapabilities.sessionCapabilities.resume; cannot session/resume`
          );
        }
        const loadId =
          typeof options?.providerSessionId === "string"
            ? options.providerSessionId.trim()
            : "";
        if (!loadId) {
          throw new Error(
            `${this.label} ${method} requires providerSessionId (resume token)`
          );
        }
        this.resetAssistantReport();
        // Only session/load is expected to stream full transcript history.
        // session/resume must not quarantine-wait for replay (none by contract).
        if (mode === "load") {
          this.quarantiningLoadReplay = true;
          this.lastLoadReplayUpdateAt = Date.now();
        }
        try {
          await this.request(
            method,
            this.sessionStartParams({
              sessionId: loadId,
              cwd: this.options.cwd,
            }),
            60_000
          );
          if (mode === "load") {
            await this.waitForLoadReplayQuiescence();
          }
        } finally {
          this.quarantiningLoadReplay = false;
          this.resetAssistantReport();
        }
        // Preserve the same provider session id — never invent a new one.
        this.providerSessionId = loadId;
        providerSessionId = loadId;
      } else {
        const session = (await this.request(
          "session/new",
          this.sessionStartParams({ cwd: this.options.cwd }),
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
        resumeSessionSupported: this.resumeSessionSupported,
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
   * Optional image refs are projected only when live initialize advertised
   * promptCapabilities.image === true; otherwise Markdown pointers + a short note.
   * Collects agent_message_chunk segments; delivery report is the last non-empty
   * segment after tool/status/thought separators (shared assistant-report contract).
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
    this.resetAssistantReport();
    this.collectingPromptResponse = true;
    try {
      const promptTimeout =
        this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
      // Keep the ordinary text-only path synchronous. Besides avoiding needless
      // work, this preserves stdin error ordering for callers that immediately
      // observe the request after sendPrompt().
      const prompt =
        Array.isArray(this.options.bootstrapImageRefs) &&
        this.options.bootstrapImageRefs.length > 0
          ? await this.buildPromptBlocks(bootstrapPrompt)
          : [{ type: "text" as const, text: bootstrapPrompt }];
      const result = (await this.request(
        "session/prompt",
        {
          sessionId: this.providerSessionId,
          prompt,
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
        assistantText: this.finalizeAssistantReport(),
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

  /**
   * Project bootstrap text (+ optional image refs) to ACP content blocks.
   * Image bytes are process-scoped for this RPC only — never stored on the client.
   * Sole gate: cached live promptCapabilities.image from initialize.
   */
  private async buildPromptBlocks(
    bootstrapPrompt: string
  ): Promise<AcpPromptContentBlock[]> {
    const refs = Array.isArray(this.options.bootstrapImageRefs)
      ? this.options.bootstrapImageRefs
      : [];
    if (refs.length === 0) {
      return [{ type: "text", text: bootstrapPrompt }];
    }
    const projected = await projectBootstrapImagesToAcpPrompt({
      bootstrapText: bootstrapPrompt,
      imageRefs: refs,
      transportSupportsImage: this.promptImageSupported,
      readBinary: this.options.readBootstrapImageBinary,
      systemRoot: this.options.bootstrapImageSystemRoot,
    });
    return projected.prompt;
  }

  /** Keep process alive after bootstrap for probe/stop (caller owns lifecycle). */
  async stop(reason: "user" | "interrupt" | "shutdown"): Promise<void> {
    void reason;
    if (this.closed && this.stopRequested) return;
    this.stopRequested = true;
    this.closed = true;
    this.cancelPermissionWaiters();
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

    await this.waitForExitOrForceKill(1500);
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

    child.stdin?.on("error", (err) => {
      this.rejectAllPending(
        new Error(`${this.label} stdin 写入失败: ${err.message}`)
      );
    });

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
      this.cancelPermissionWaiters();
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
      this.cancelPermissionWaiters();
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
      pending.reject(new Error(formatRpcError(message.error)));
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
    if (isAssistantMessageChunkKind(kind) && update.content?.text) {
      // Contiguous message chunks form one segment; other updates seal it.
      // Delivery summary uses only the last non-empty segment at prompt end.
      this.assistantMessageCurrent += update.content.text;
      this.options.emit({
        type: "session.stdout_tail",
        sessionId: this.options.sessionId,
        text: `[${kind}] ${update.content.text}`,
      });
      return;
    }
    // Any non-message update seals the open segment (tool/status/thought/…).
    if (kind) {
      this.sealOpenAssistantSegment();
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
            // Sole expiry authority is ToolApprovalStore (via onPermissionAsk).
            // Client only cancels waiters on stop/exit — no second timeout.
            const askInfo = { toolTitle, toolCallId, options };
            decision = await this.waitForPermissionDecision(askInfo);
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

  private waitForPermissionDecision(askInfo: {
    toolTitle: string;
    toolCallId?: string;
    options: AcpPermissionOption[];
  }): Promise<"allow" | "deny"> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: "allow" | "deny") => {
        if (settled) return;
        settled = true;
        this.permissionWaitCancels.delete(cancel);
        resolve(decision);
      };
      const cancel = () => finish("deny");
      this.permissionWaitCancels.add(cancel);

      void Promise.resolve()
        .then(() => this.options.onPermissionAsk!(askInfo))
        .then(
          (decision) => finish(decision),
          () => finish("deny")
        );
    });
  }

  private cancelPermissionWaiters(): void {
    for (const cancel of [...this.permissionWaitCancels]) cancel();
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
      this.write({ jsonrpc: "2.0", id, method, params }, (err) => {
        this.failPendingWrite(id, method, err);
      });
    });
  }

  /**
   * Drop a still-pending request after stdin write cannot deliver it.
   * Safe if the id was already settled (response / timeout / rejectAllPending).
   */
  private failPendingWrite(id: number, method: string, err: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(
      new Error(`${this.label} ${method} 发送失败: ${err.message}`)
    );
  }

  private write(payload: unknown, onError?: (err: Error) => void): void {
    const stdin = this.proc?.stdin;
    if (
      !stdin ||
      stdin.destroyed ||
      !stdin.writable ||
      stdin.writableEnded
    ) {
      onError?.(new Error(`${this.label} stdin 不可写`));
      return;
    }
    try {
      stdin.write(JSON.stringify(payload) + "\n", (err) => {
        if (!err) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private waitExit(): Promise<void> {
    const proc = this.proc;
    if (
      !proc ||
      this.exitCode !== null ||
      this.exitSignal !== null ||
      proc.exitCode !== null ||
      proc.signalCode !== null
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  private async waitForExitOrForceKill(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      this.waitExit().then(() => "exit" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") await this.forceKill();
  }

  private async forceKill(): Promise<void> {
    const proc = this.proc;
    const pid = proc?.pid;
    if (!proc || pid == null) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve();
        };
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("exit", finish);
        killer.on("error", finish);
        timer = setTimeout(finish, 1500);
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
