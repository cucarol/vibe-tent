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
    "model" | "envKey" | "promptTimeoutMs" | "permissionPolicy" | "permissionTimeoutMs"
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
  private readonly onPermissionAsk?: GrokAcpAdapterOptions["onPermissionAsk"];

  constructor(options: GrokAcpAdapterOptions = {}) {
    this.resolveApiKey =
      options.resolveApiKey ??
      ((envKey, planEnv) => planEnv[envKey] ?? process.env[envKey]);
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
    const apiKey = this.resolveApiKey(envKey, plan.env);

    if (!apiKey || !apiKey.trim()) {
      throw new Error(
        `未配置环境变量 ${envKey}：grok-acp 需要本机 CPA Grok API key（仅 service 进程环境）。` +
          `不会回退官方 xAI（api.x.ai），也不会回退 fake provider。` +
          `请在启动 Local Service 前设置 ${envKey}；CPA base URL 由 ~/.grok/config.toml 管理，切勿写入 workspace/box/task。`
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
    const args =
      plan.args && plan.args.length > 0
        ? plan.args
        : ["agent", "--model", model, "stdio"];

    const env: Record<string, string> = {
      ...plan.env,
      [envKey]: apiKey,
      // Grok CLI auth method may read XAI_API_KEY; value is the CPA key, not a second secret store.
      // Base URL still comes from ~/.grok/config.toml (CPA), not hard-coded api.x.ai.
      XAI_API_KEY: apiKey,
      TENT_SESSION_ID: plan.sessionId,
      TENT_PROFILE_ID: plan.profileId,
      TENT_GROK_MODEL: model,
    };
    if (plan.roleName) env.TENT_ROLE_NAME = plan.roleName;

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

    // Task pointer / relay prompt runs in background — Tent is not a chat router;
    // observe via RuntimeEvent only. Keep process for probe/stop.
    const promptDone = client.sendPrompt(bootstrap).then(
      () => undefined,
      async (err) => {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: "session.failed", sessionId: plan.sessionId, error: message });
        try {
          await client.stop("interrupt");
        } catch {
          // ignore
        }
      }
    );

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

/** Machine-local profile template — secrets only via envKey name, never values. */
export function grokAcpProfileTemplate(overrides?: {
  id?: string;
  executable?: string;
  model?: string;
  envKey?: string;
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
      permissionPolicy: overrides?.permissionPolicy ?? "deny",
      promptTimeoutMs: overrides?.promptTimeoutMs,
    },
  };
}
