// Grok ACP ProviderAdapter — first real push provider for Tent Desktop MVP.
// Machine-local credentials via process env; CPA base URL in ~/.grok/config.toml only.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  LaunchPlan,
  ManagedSession,
  ProviderAdapter,
  ProviderCapabilities,
  ResolvedLaunch,
  ResumeToken,
} from "../types.js";
import type { RuntimeEvent, StopReason } from "../../runtime/types.js";
import { GrokAcpClient } from "./client.js";
import {
  DEFAULT_GROK_BASE_URL_ENV_KEY,
  DEFAULT_GROK_ENV_KEY,
  DEFAULT_GROK_MODEL,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
  GROK_ACP_ADAPTER_ID,
  type GrokAcpPermissionPolicy,
  type GrokAcpProfileOptions,
} from "./types.js";

export {
  GROK_ACP_ADAPTER_ID,
  DEFAULT_GROK_MODEL,
  DEFAULT_GROK_ENV_KEY,
  DEFAULT_GROK_BASE_URL_ENV_KEY,
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  type GrokAcpProfileOptions,
  type GrokAcpPermissionPolicy,
} from "./types.js";

export interface GrokAcpAdapterOptions {
  /**
   * Resolve API key for envKey. Default: process.env[envKey].
   * Tests inject without mutating real process secrets.
   */
  resolveApiKey?: (envKey: string, planEnv: Record<string, string>) => string | undefined;
  /**
   * Resolve CPA base URL for baseUrlEnvKey / profile.baseUrl.
   * Default: planEnv[key] ?? process.env[key] ?? profile.baseUrl.
   */
  resolveBaseUrl?: (
    baseUrlEnvKey: string,
    planEnv: Record<string, string>,
    profileBaseUrl?: string
  ) => string | undefined;
  /**
   * Optional permission ask resolver (tests / future service UI).
   * When omitted and policy=ask, permissions deny after timeout.
   */
  onPermissionAsk?: (info: {
    sessionId: string;
    toolTitle: string;
  }) => Promise<"allow" | "deny">;
}

function defaultGrokExecutable(): string {
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE || os.homedir();
    return path.join(home, ".grok", "bin", "grok.exe");
  }
  const home = process.env.HOME || os.homedir();
  return path.join(home, ".grok", "bin", "grok");
}

function normalizeGrokOpts(raw: unknown): Required<
  Pick<
    GrokAcpProfileOptions,
    | "model"
    | "envKey"
    | "baseUrlEnvKey"
    | "promptTimeoutMs"
    | "permissionPolicy"
    | "permissionTimeoutMs"
  >
> &
  GrokAcpProfileOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as GrokAcpProfileOptions;
  const policy = o.permissionPolicy;
  const permissionPolicy: GrokAcpPermissionPolicy =
    policy === "allow" || policy === "ask" || policy === "deny" ? policy : "deny";
  return {
    executable: o.executable,
    model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : DEFAULT_GROK_MODEL,
    envKey:
      typeof o.envKey === "string" && o.envKey.trim()
        ? o.envKey.trim()
        : DEFAULT_GROK_ENV_KEY,
    baseUrlEnvKey:
      typeof o.baseUrlEnvKey === "string" && o.baseUrlEnvKey.trim()
        ? o.baseUrlEnvKey.trim()
        : DEFAULT_GROK_BASE_URL_ENV_KEY,
    baseUrl: typeof o.baseUrl === "string" && o.baseUrl.trim() ? o.baseUrl.trim() : undefined,
    promptTimeoutMs:
      typeof o.promptTimeoutMs === "number" && o.promptTimeoutMs > 0
        ? o.promptTimeoutMs
        : DEFAULT_PROMPT_TIMEOUT_MS,
    permissionPolicy,
    permissionTimeoutMs:
      typeof o.permissionTimeoutMs === "number" && o.permissionTimeoutMs > 0
        ? o.permissionTimeoutMs
        : DEFAULT_PERMISSION_TIMEOUT_MS,
  };
}

/** Strip trailing slashes; reject empty / whitespace. */
export function normalizeCpaBaseUrl(raw: string | undefined): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const t = raw.trim().replace(/\/+$/, "");
  return t || undefined;
}

class GrokManagedSession implements ManagedSession {
  constructor(
    readonly sessionId: string,
    private readonly client: GrokAcpClient,
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

  async waitBootstrap(): Promise<void> {
    await this.bootstrapDone;
  }

  async stop(reason: StopReason): Promise<void> {
    this.stopRequested = true;
    await this.client.stop(reason);
  }
}

export class GrokAcpProviderAdapter implements ProviderAdapter {
  readonly id = GROK_ACP_ADAPTER_ID;
  readonly displayNameKey = "adapter.grokAcp.displayName";
  private readonly resolveApiKey: (
    envKey: string,
    planEnv: Record<string, string>
  ) => string | undefined;
  private readonly resolveBaseUrl: (
    baseUrlEnvKey: string,
    planEnv: Record<string, string>,
    profileBaseUrl?: string
  ) => string | undefined;
  private readonly onPermissionAsk?: GrokAcpAdapterOptions["onPermissionAsk"];

  constructor(options: GrokAcpAdapterOptions = {}) {
    this.resolveApiKey =
      options.resolveApiKey ??
      ((envKey, planEnv) => planEnv[envKey] ?? process.env[envKey]);
    this.resolveBaseUrl =
      options.resolveBaseUrl ??
      ((baseUrlEnvKey, planEnv, profileBaseUrl) =>
        normalizeCpaBaseUrl(
          planEnv[baseUrlEnvKey] ?? process.env[baseUrlEnvKey] ?? profileBaseUrl
        ));
    this.onPermissionAsk = options.onPermissionAsk;
  }

  capabilities(): ProviderCapabilities {
    return {
      canSpawn: true,
      canResume: false,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "env",
      observeLevel: "structured",
    };
  }

  /**
   * Launch plan validation only. Real ACP needs bidirectional stdio —
   * AgentRuntime uses startManagedSession instead of ProcessSupervisor.
   */
  resolveLaunch(plan: LaunchPlan): ResolvedLaunch {
    const opts = normalizeGrokOpts(plan.extras?.grokAcp ?? plan.extras);
    const command = plan.command || opts.executable || defaultGrokExecutable();
    const model = opts.model;
    const envKey = opts.envKey;
    const baseUrlEnvKey = opts.baseUrlEnvKey;
    const apiKey = this.resolveApiKey(envKey, plan.env);
    const baseUrl = this.resolveBaseUrl(baseUrlEnvKey, plan.env, opts.baseUrl);

    if (!apiKey || !apiKey.trim()) {
      throw new Error(
        `未配置环境变量 ${envKey}：grok-acp 需要本机 CPA Grok API key（仅 service 进程环境）。` +
          `不会回退官方 xAI（api.x.ai），也不会回退 fake provider。` +
          `请在启动 Local Service 前设置 ${envKey}` +
          (baseUrlEnvKey ? `（可选 ${baseUrlEnvKey}=CPA base URL）` : "") +
          `；切勿把 key/URL 写入 workspace/box/task。`
      );
    }

    if (!plan.command && opts.executable) {
      if (!fs.existsSync(opts.executable)) {
        throw new Error(
          `Grok 可执行文件不存在: ${opts.executable}。请在 machine-local AgentProfile.grokAcp.executable 中配置正确路径。`
        );
      }
    } else if (!plan.command) {
      if (!fs.existsSync(command)) {
        throw new Error(
          `未找到 Grok 可执行文件: ${command}。请安装 grok CLI 或在 AgentProfile 中设置 grokAcp.executable。`
        );
      }
    }

    // Explicit model on argv — never silent default inside opaque wrapper.
    // When plan.args is fully custom (tests/mock), preserve it; otherwise build
    // `grok agent --model <m> [--xai-api-base-url <cpa>] stdio`.
    let args: string[];
    if (plan.args && plan.args.length > 0) {
      args = [...plan.args];
      // If caller used default-shaped args without base URL flag, inject when we have one.
      if (
        baseUrl &&
        !args.includes("--xai-api-base-url") &&
        args.includes("agent") &&
        args.includes("stdio")
      ) {
        const stdioIdx = args.indexOf("stdio");
        args.splice(stdioIdx, 0, "--xai-api-base-url", baseUrl);
      }
    } else {
      args = ["agent", "--model", model];
      if (baseUrl) {
        args.push("--xai-api-base-url", baseUrl);
      }
      args.push("stdio");
    }

    const env: Record<string, string> = {
      ...plan.env,
      [envKey]: apiKey,
      // Grok CLI auth method may read XAI_API_KEY; value is the CPA key, not a second secret store.
      XAI_API_KEY: apiKey,
      TENT_SESSION_ID: plan.sessionId,
      TENT_PROFILE_ID: plan.profileId,
      TENT_GROK_MODEL: model,
    };
    if (plan.roleName) env.TENT_ROLE_NAME = plan.roleName;

    if (baseUrl) {
      // Propagate CPA base URL through common env names Grok / OpenAI-compat stacks read.
      env[baseUrlEnvKey] = baseUrl;
      env.XAI_API_BASE_URL = baseUrl;
      env.OPENAI_BASE_URL = baseUrl;
      env.OPENAI_API_BASE = baseUrl;
      env.TENT_GROK_BASE_URL = baseUrl;
    }

    const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
    if (!env.GROK_HOME) {
      env.GROK_HOME = path.join(home, ".grok");
    }

    return {
      command,
      args,
      cwd: plan.cwd,
      env,
      stopSignal: "SIGTERM",
    };
  }

  async startManagedSession(
    plan: LaunchPlan,
    emit: (ev: RuntimeEvent) => void
  ): Promise<ManagedSession> {
    const opts = normalizeGrokOpts(plan.extras?.grokAcp ?? plan.extras);
    // Fail-loud on missing key / binary before spawn (Chinese errors from resolveLaunch).
    const launch = this.resolveLaunch(plan);
    const bootstrap =
      plan.bootstrapPrompt?.trim() ||
      "Tent session started. Read the task envelope via Tent Task API; do not invent missing content.";

    const client = new GrokAcpClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      sessionId: plan.sessionId,
      model: opts.model,
      promptTimeoutMs: opts.promptTimeoutMs,
      permissionPolicy: opts.permissionPolicy,
      permissionTimeoutMs: opts.permissionTimeoutMs,
      emit,
      onPermissionAsk:
        opts.permissionPolicy === "ask"
          ? async (info) => {
              if (!this.onPermissionAsk) return "deny";
              return this.onPermissionAsk({
                sessionId: plan.sessionId,
                toolTitle: info.toolTitle,
              });
            }
          : undefined,
    });

    // Handshake must succeed before startSession returns live (fail-loud).
    await client.connect();

    // Managed bootstrap runs in background — Tent is not a chat router.
    // On successful end_turn, emit session.prompt_complete so Local Service can
    // auto-deliver the final assistant reply as the task report.
    const promptDone = client
      .sendPrompt(bootstrap)
      .then((result) => {
        const stopReason = (result.stopReason || "end_turn").toLowerCase();
        const assistantText = (result.assistantText || "").trim();
        // Only successful end_turn with non-empty message is a deliverable report.
        // cancelled / max_tokens / refused / interrupted → no delivery (service maps failure).
        if (stopReason !== "end_turn") {
          emit({
            type: "session.failed",
            sessionId: plan.sessionId,
            error: `ACP session/prompt stopReason=${result.stopReason || "unknown"} (no auto-delivery)`,
          });
          return;
        }
        if (!assistantText) {
          emit({
            type: "session.failed",
            sessionId: plan.sessionId,
            error: "ACP assistant response empty (no auto-delivery)",
          });
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
        // Stop/interrupt should not look like a provider crash when user cancelled.
        if (/interrupted|session stopped/i.test(message)) {
          emit({
            type: "session.failed",
            sessionId: plan.sessionId,
            error: `session interrupted: ${message}`,
          });
          return;
        }
        emit({ type: "session.failed", sessionId: plan.sessionId, error: message });
        try {
          await client.stop("interrupt");
        } catch {
          // ignore
        }
      });

    return new GrokManagedSession(plan.sessionId, client, promptDone);
  }

  parseResumeToken(raw: string): ResumeToken {
    return { raw, providerSessionId: raw };
  }

  mapExit(code: number | null, signal?: string): RuntimeEvent {
    if (signal && signal !== "SIGTERM" && signal !== "SIGINT") {
      return { type: "session.failed", sessionId: "", error: `signal:${signal}` };
    }
    if (code === 0 || (code === null && (signal === "SIGTERM" || signal === "SIGINT"))) {
      return { type: "session.exited", sessionId: "", exitCode: code };
    }
    if (code !== 0 && code != null) {
      return { type: "session.failed", sessionId: "", error: `exit:${code}` };
    }
    return { type: "session.exited", sessionId: "", exitCode: code };
  }
}

export function createGrokAcpAdapter(
  options?: GrokAcpAdapterOptions
): GrokAcpProviderAdapter {
  return new GrokAcpProviderAdapter(options);
}

/** Machine-local profile template — secrets only via env key *names* / optional machine-local baseUrl, never workspace. */
export function grokAcpProfileTemplate(overrides?: {
  id?: string;
  executable?: string;
  model?: string;
  envKey?: string;
  baseUrlEnvKey?: string;
  baseUrl?: string;
  permissionPolicy?: GrokAcpPermissionPolicy;
  promptTimeoutMs?: number;
}): {
  id: string;
  adapterId: string;
  displayNameKey: string;
  grokAcp: GrokAcpProfileOptions;
} {
  return {
    id: overrides?.id ?? "grok-acp-default",
    adapterId: GROK_ACP_ADAPTER_ID,
    displayNameKey: "profile.grokAcp.default",
    grokAcp: {
      executable: overrides?.executable,
      model: overrides?.model ?? DEFAULT_GROK_MODEL,
      envKey: overrides?.envKey ?? DEFAULT_GROK_ENV_KEY,
      baseUrlEnvKey: overrides?.baseUrlEnvKey ?? DEFAULT_GROK_BASE_URL_ENV_KEY,
      baseUrl: overrides?.baseUrl,
      permissionPolicy: overrides?.permissionPolicy ?? "deny",
      promptTimeoutMs: overrides?.promptTimeoutMs,
    },
  };
}
