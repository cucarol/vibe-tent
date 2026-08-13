// Grok ACP ProviderAdapter — first real push provider for Tent Desktop MVP.
// Machine-local credentials + Grok2API/OpenAI-compatible base URL via process env.

import * as os from "node:os";
import * as path from "node:path";
import type {
  ConnectionLaunchPlan,
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
  readCoreChildEnvClientOptions,
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
  type GrokAcpRouteOptions,
} from "./types.js";

export {
  GROK_ACP_ADAPTER_ID,
  DEFAULT_GROK_MODEL,
  DEFAULT_GROK_ENV_KEY,
  DEFAULT_GROK_BASE_URL_ENV_KEY,
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  type GrokAcpRouteOptions,
  type GrokAcpPermissionPolicy,
} from "./types.js";

export interface GrokAcpAdapterOptions {
  /**
   * Resolve API key for envKey. Default: process.env[envKey].
   * Tests inject without mutating real process secrets.
   */
  resolveApiKey?: (envKey: string, planEnv: Record<string, string>) => string | undefined;
  /**
   * Resolve the canonical machine-local provider endpoint.
   */
  resolveEndpoint?: (endpoint: string | undefined) => string | undefined;
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

export function defaultGrokExecutable(): string {
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
    GrokAcpRouteOptions,
    | "model"
    | "envKey"
    | "promptTimeoutMs"
    | "permissionPolicy"
    | "permissionTimeoutMs"
  >
> &
  GrokAcpRouteOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as GrokAcpRouteOptions;
  const policy = o.permissionPolicy;
  const permissionPolicy: GrokAcpPermissionPolicy =
    policy === "allow" || policy === "ask" || policy === "deny" ? policy : "deny";
  return {
    model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : DEFAULT_GROK_MODEL,
    envKey:
      typeof o.envKey === "string" && o.envKey.trim()
        ? o.envKey.trim()
        : DEFAULT_GROK_ENV_KEY,
    endpoint: typeof o.endpoint === "string" && o.endpoint.trim() ? o.endpoint.trim() : undefined,
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
  private readonly resolveEndpoint: (endpoint: string | undefined) => string | undefined;
  private readonly onPermissionAsk?: GrokAcpAdapterOptions["onPermissionAsk"];

  constructor(options: GrokAcpAdapterOptions = {}) {
    this.resolveApiKey =
      options.resolveApiKey ??
      ((envKey, planEnv) => planEnv[envKey] ?? process.env[envKey]);
    this.resolveEndpoint = options.resolveEndpoint ?? normalizeCpaBaseUrl;
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
  resolveLaunch(plan: ConnectionLaunchPlan): ResolvedLaunch {
    const opts = normalizeGrokOpts(readAcpExtras(plan.extras));
    const command = plan.command?.trim();
    if (!command) throw new Error("Agent Connection is missing canonical command");
    if (!Array.isArray(plan.args)) throw new Error("Agent Connection is missing canonical args");
    const model = opts.model;
    const envKey = opts.envKey;
    const apiKey = this.resolveApiKey(envKey, plan.env);
    const endpoint = this.resolveEndpoint(opts.endpoint);

    if (!apiKey || !apiKey.trim()) {
      throw new Error(
        `未配置环境变量 ${envKey}：grok-acp 需要本机 CPA Grok API key（仅 service 进程环境）。` +
          `不会回退官方 xAI（api.x.ai），也不会回退 fake provider。` +
          `请在启动 Local Service 前设置 ${envKey}` +
          `；切勿把 key/URL 写入 workspace/Node/Task。`
      );
    }

    // Tent is the ACP client. Do not launch the one-shot invoke-grok-acp wrapper
    // (it is another ACP client). Instead absorb its transparent provider launch
    // contract here: isolated Grok config, no leader, and both proxy base URLs.
    const args = [...plan.args];

    const env: Record<string, string> = {
      ...plan.env,
      [envKey]: apiKey,
      // Grok CLI auth method may read XAI_API_KEY; value is the CPA key, not a second secret store.
      XAI_API_KEY: apiKey,
      TENT_SESSION_ID: plan.sessionId,
      TENT_CONNECTION_ID: plan.connectionId,
      TENT_GROK_MODEL: model,
    };

    if (endpoint) {
      // Propagate CPA base URL through common env names Grok / OpenAI-compat stacks read.
      env.XAI_API_BASE_URL = endpoint;
      env.OPENAI_BASE_URL = endpoint;
      env.OPENAI_API_BASE = endpoint;
      env.TENT_GROK_BASE_URL = endpoint;
      env.GROK_MODELS_BASE_URL = endpoint;
      env.GROK_MODELS_LIST_URL = `${endpoint}/models`;
    }

    // Resolve the exact command before these child-only overrides. Managed workers
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
    plan: ConnectionLaunchPlan,
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
    plan: ConnectionLaunchPlan,
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
    plan: ConnectionLaunchPlan,
    emit: (ev: RuntimeEvent) => void
  ): GrokAcpClient {
    const opts = normalizeGrokOpts(readAcpExtras(plan.extras));
    // Fail-loud on missing key / binary before spawn (Chinese errors from resolveLaunch).
    const launch = this.resolveLaunch(plan);
    const sessionProj = readAcpSessionProjection(plan.extras);
    const imageOpts = readBootstrapImageClientOptions(plan);
    const coreChildOpts = readCoreChildEnvClientOptions(plan);

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
      ...coreChildOpts,
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

/** Machine-local Connection template with exact command + complete argv. */
export function grokAcpRouteTemplate(overrides?: {
  connectionId?: string;
  command?: string;
  args?: string[];
  model?: string;
  envKey?: string;
  endpoint?: string;
  permissionPolicy?: GrokAcpPermissionPolicy;
  promptTimeoutMs?: number;
}): {
  connectionId: string;
  provider: string;
  adapterId: string;
  command: string;
  args: string[];
  model: string;
  envKey: string;
  endpoint?: string;
  permissionPolicy: GrokAcpPermissionPolicy;
  promptTimeoutMs?: number;
} {
  return {
    connectionId: overrides?.connectionId ?? "grok-acp-default",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: overrides?.command ?? defaultGrokExecutable(),
    args: overrides?.args ?? [
      "agent",
      "--model",
      overrides?.model ?? DEFAULT_GROK_MODEL,
      "--no-leader",
      ...(overrides?.endpoint
        ? ["--cli-chat-proxy-base-url", overrides.endpoint, "--xai-api-base-url", overrides.endpoint]
        : []),
      "stdio",
    ],
    model: overrides?.model ?? DEFAULT_GROK_MODEL,
    envKey: overrides?.envKey ?? DEFAULT_GROK_ENV_KEY,
    endpoint: overrides?.endpoint,
    permissionPolicy: overrides?.permissionPolicy ?? "deny",
    promptTimeoutMs: overrides?.promptTimeoutMs,
  };
}
