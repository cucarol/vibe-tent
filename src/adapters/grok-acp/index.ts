// Grok ACP ProviderAdapter — first real push provider for Tent Desktop MVP.
// Machine-local credentials + Grok2API/OpenAI-compatible base URL via process env.

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
import type { RuntimeEvent } from "../../runtime/types.js";
import {
  bindAcpPermissionHooks,
  loadSessionAcpCapabilities,
  mapAcpProcessExit,
  parseAcpResumeToken,
  readAcpExtras,
  readAcpSessionProjection,
  readBootstrapImageClientOptions,
  resumeManagedAcpSession,
  startManagedAcpSession,
} from "../acp/index.js";
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
   * Optional permission ask resolver (Local Service tool-approval bridge / tests).
   * When omitted and policy=ask, permissions deny (safe default; never auto-allow).
   * Distinct from A2A spawn approval — this is ACP session/request_permission only.
   * Store expiry is the sole authority; late approve after expire must fail.
   */
  onPermissionAsk?: (info: {
    sessionId: string;
    toolTitle: string;
    toolCallId?: string;
    options: Array<{ optionId: string; kind?: string; name?: string }>;
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

function defaultGrokIsolatedHome(): string {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, ".grok-acp", "home");
}

function injectFlagBeforeStdio(args: string[], flag: string, value?: string): void {
  if (args.includes(flag)) return;
  const stdioIdx = args.indexOf("stdio");
  if (stdioIdx < 0) return;
  args.splice(stdioIdx, 0, flag, ...(value === undefined ? [] : [value]));
}

const DISABLED_COMPATIBILITY_ENV = [
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
  "GROK_CLAUDE_SESSIONS_ENABLED",
  "GROK_CURSOR_SKILLS_ENABLED",
  "GROK_CURSOR_RULES_ENABLED",
  "GROK_CURSOR_AGENTS_ENABLED",
  "GROK_CURSOR_MCPS_ENABLED",
  "GROK_CURSOR_HOOKS_ENABLED",
  "GROK_CURSOR_SESSIONS_ENABLED",
] as const;

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
    // Verified: local `grok agent stdio` advertises agentCapabilities.loadSession.
    return loadSessionAcpCapabilities("env");
  }

  /**
   * Launch plan validation only. Real ACP needs bidirectional stdio —
   * AgentRuntime uses startManagedSession instead of ProcessSupervisor.
   */
  resolveLaunch(plan: LaunchPlan): ResolvedLaunch {
    // @deprecated Pre-canonical runtime plans may still pass extras.grokAcp — prefer extras.acp.
    const opts = normalizeGrokOpts(readAcpExtras(plan.extras, ["grokAcp"]));
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
          `Grok 可执行文件不存在: ${opts.executable}。请在 machine-local AgentProfile.acp.executable 中配置正确路径。`
        );
      }
    } else if (!plan.command) {
      if (!fs.existsSync(command)) {
        throw new Error(
          `未找到 Grok 可执行文件: ${command}。请安装 grok CLI 或在 AgentProfile 中设置 acp.executable。`
        );
      }
    }

    // Tent is the ACP client. Do not launch the one-shot invoke-grok-acp wrapper
    // (it is another ACP client). Instead absorb its transparent provider launch
    // contract here: isolated Grok config, no leader, and both proxy base URLs.
    // When plan.args is custom (tests/explicit executable), preserve it and only
    // complete the same grok-agent-stdio flag contract.
    let args: string[];
    if (plan.args && plan.args.length > 0) {
      args = [...plan.args];
      if (args.includes("agent") && args.includes("stdio")) {
        injectFlagBeforeStdio(args, "--no-leader");
        if (baseUrl) {
          injectFlagBeforeStdio(args, "--cli-chat-proxy-base-url", baseUrl);
          injectFlagBeforeStdio(args, "--xai-api-base-url", baseUrl);
        }
      }
    } else {
      args = ["agent", "--model", model, "--no-leader"];
      if (baseUrl) {
        args.push(
          "--cli-chat-proxy-base-url",
          baseUrl,
          "--xai-api-base-url",
          baseUrl
        );
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
      env.GROK_MODELS_BASE_URL = baseUrl;
      env.GROK_MODELS_LIST_URL = `${baseUrl}/models`;
    }

    // Resolve the executable before these child-only overrides. Managed workers
    // use the dedicated config (chat-completions main model + Responses search
    // helper) and do not inherit unrelated Claude/Cursor skills, hooks or MCPs.
    const isolatedHome = defaultGrokIsolatedHome();
    env.USERPROFILE = isolatedHome;
    env.HOME = isolatedHome;
    env.GROK_HOME = path.join(isolatedHome, ".grok");
    for (const key of DISABLED_COMPATIBILITY_ENV) {
      env[key] = "false";
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
    const client = this.createClient(plan, emit);
    return startManagedAcpSession({ plan, emit, client });
  }

  /**
   * Native ACP resume: new bridge process + session/load (never session/new).
   * Requires agentCapabilities.loadSession on the live initialize handshake.
   */
  async resumeManagedSession(
    plan: LaunchPlan,
    token: ResumeToken,
    emit: (ev: RuntimeEvent) => void
  ): Promise<ManagedSession> {
    const providerSessionId = (
      token.providerSessionId ?? token.raw
    ).trim();
    if (!providerSessionId) {
      throw new Error("grok-acp resume requires non-empty provider session id");
    }
    const client = this.createClient(plan, emit);
    return resumeManagedAcpSession({
      plan,
      emit,
      client,
      providerSessionId,
      bootstrapPrompt: plan.bootstrapPrompt,
    });
  }

  private createClient(
    plan: LaunchPlan,
    emit: (ev: RuntimeEvent) => void
  ): GrokAcpClient {
    const opts = normalizeGrokOpts(readAcpExtras(plan.extras, ["grokAcp"]));
    // Fail-loud on missing key / binary before spawn (Chinese errors from resolveLaunch).
    const launch = this.resolveLaunch(plan);
    const sessionProj = readAcpSessionProjection(plan.extras);
    const imageOpts = readBootstrapImageClientOptions(plan);

    const permHooks = bindAcpPermissionHooks(plan.sessionId, opts.permissionPolicy, {
      onPermissionAsk: this.onPermissionAsk,
    });

    return new GrokAcpClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      sessionId: plan.sessionId,
      model: opts.model,
      promptTimeoutMs: opts.promptTimeoutMs,
      permissionPolicy: opts.permissionPolicy,
      mcpServers: sessionProj.mcpServers,
      skills: sessionProj.skills,
      ...imageOpts,
      emit,
      onPermissionAsk: permHooks.onPermissionAsk,
    });
  }

  parseResumeToken(raw: string): ResumeToken {
    return parseAcpResumeToken(raw);
  }

  mapExit(code: number | null, signal?: string): RuntimeEvent {
    return mapAcpProcessExit(code, signal);
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
  acp: GrokAcpProfileOptions;
} {
  return {
    id: overrides?.id ?? "grok-acp-default",
    adapterId: GROK_ACP_ADAPTER_ID,
    displayNameKey: "profile.grokAcp.default",
    acp: {
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
