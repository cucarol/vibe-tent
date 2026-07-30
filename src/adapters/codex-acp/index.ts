// Codex ACP ProviderAdapter — npx @agentclientprotocol/codex-acp bridge.
// No ACP authenticate RPC; auth via injected DEFAULT_AUTH_REQUEST env when envKey set.
// Never starts real npx/network in tests — LaunchPlan command/args override to mock.

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
  AcpClient,
  bindAcpPermissionHooks,
  loadSessionAcpCapabilities,
  mapAcpProcessExit,
  normalizeSharedAcpOpts,
  parseAcpResumeToken,
  readAcpExtras,
  readAcpSessionProjection,
  readBootstrapImageClientOptions,
  readCoreChildEnvClientOptions,
  resolveNpxAcpLaunch,
  resolvePlanOrProcessEnv,
  resumeManagedAcpSession,
  startManagedAcpSession,
  type AcpPermissionAskHooks,
} from "../acp/index.js";
import {
  CODEX_ACP_ADAPTER_ID,
  CODEX_ACP_NPX_PACKAGE,
  CODEX_DEFAULT_AUTH_REQUEST_ENV,
  type CodexAcpPermissionPolicy,
  type CodexAcpProfileOptions,
} from "./types.js";

export {
  CODEX_ACP_ADAPTER_ID,
  CODEX_ACP_NPX_PACKAGE,
  CODEX_DEFAULT_AUTH_REQUEST_ENV,
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  type CodexAcpProfileOptions,
  type CodexAcpPermissionPolicy,
} from "./types.js";

export interface CodexAcpAdapterOptions extends AcpPermissionAskHooks {
  /**
   * Resolve secret for an explicitly configured acp.envKey.
   * Default: plan.env[envKey] ?? process.env[envKey].
   * Tests inject without mutating real process secrets.
   */
  resolveEnvValue?: (
    envKey: string,
    planEnv: Record<string, string>
  ) => string | undefined;
}

/**
 * Build DEFAULT_AUTH_REQUEST JSON for Codex ACP child env.
 * Secret value is placed only under _meta; callers must not log the result.
 */
export function buildCodexDefaultAuthRequest(apiKey: string): string {
  return JSON.stringify({
    methodId: "api-key",
    _meta: {
      "api-key": {
        apiKey,
      },
    },
  });
}

export class CodexAcpProviderAdapter implements ProviderAdapter {
  readonly id = CODEX_ACP_ADAPTER_ID;
  readonly displayNameKey = "adapter.codexAcp.displayName";
  private readonly resolveEnvValue: (
    envKey: string,
    planEnv: Record<string, string>
  ) => string | undefined;
  private readonly onPermissionAsk?: CodexAcpAdapterOptions["onPermissionAsk"];

  constructor(options: CodexAcpAdapterOptions = {}) {
    this.resolveEnvValue =
      options.resolveEnvValue ??
      ((envKey, planEnv) => resolvePlanOrProcessEnv(envKey, planEnv));
    this.onPermissionAsk = options.onPermissionAsk;
  }

  capabilities(): ProviderCapabilities {
    // Verified 2026-07-21: @agentclientprotocol/codex-acp@1.1.5 initialize
    // advertises agentCapabilities.loadSession; sessionId is ACP-native (CLI resume-homologous).
    return loadSessionAcpCapabilities("external-app");
  }

  /**
   * Launch plan validation / env injection only.
   * Real ACP needs bidirectional stdio — AgentRuntime uses startManagedSession.
   * Does not call ACP authenticate; injects DEFAULT_AUTH_REQUEST when envKey is set.
   */
  resolveLaunch(plan: LaunchPlan): ResolvedLaunch {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const { command, args } = resolveNpxAcpLaunch({
      planCommand: plan.command,
      planArgs: plan.args,
      executable: opts.executable,
      defaultPackage: CODEX_ACP_NPX_PACKAGE,
    });

    const env: Record<string, string> = {
      ...plan.env,
      TENT_SESSION_ID: plan.sessionId,
      TENT_PROFILE_ID: plan.profileId,
    };
    if (plan.roleName) env.TENT_ROLE_NAME = plan.roleName;
    // Explicit envKey only: missing value fails loud; never invent a default key name.
    if (opts.envKey) {
      const secret = this.resolveEnvValue(opts.envKey, plan.env);
      if (!secret || !secret.trim()) {
        throw new Error(
          `未配置环境变量 ${opts.envKey}：codex-acp 已在 AgentProfile.acp.envKey 中明确要求该密钥` +
            `（仅 service 进程 / LaunchPlan.env）。请设置 ${opts.envKey} 后重试；切勿把 secret 写入 workspace/box/task。`
        );
      }
      env[opts.envKey] = secret;
      // Inject auth request JSON for the bridge; do not call ACP authenticate RPC.
      env[CODEX_DEFAULT_AUTH_REQUEST_ENV] = buildCodexDefaultAuthRequest(secret);
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
      throw new Error(
        "codex-acp resume requires non-empty provider session id"
      );
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
  ): AcpClient {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const launch = this.resolveLaunch(plan);
    const sessionProj = readAcpSessionProjection(plan.extras);
    const imageOpts = readBootstrapImageClientOptions(plan);
    const coreChildOpts = readCoreChildEnvClientOptions(plan);

    const permHooks = bindAcpPermissionHooks(plan.sessionId, opts.permissionPolicy, {
      onPermissionAsk: this.onPermissionAsk,
    });

    // No authenticate hook — Codex bridge uses env DEFAULT_AUTH_REQUEST / local login.
    return new AcpClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      sessionId: plan.sessionId,
      promptTimeoutMs: opts.promptTimeoutMs,
      permissionPolicy: opts.permissionPolicy,
      mcpServers: sessionProj.mcpServers,
      skills: sessionProj.skills,
      ...imageOpts,
      ...coreChildOpts,
      label: "Codex ACP",
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

export function createCodexAcpAdapter(
  options?: CodexAcpAdapterOptions
): CodexAcpProviderAdapter {
  return new CodexAcpProviderAdapter(options);
}

/** Machine-local profile template — no default envKey/model invented. */
export function codexAcpProfileTemplate(overrides?: {
  id?: string;
  executable?: string;
  model?: string;
  envKey?: string;
  permissionPolicy?: CodexAcpPermissionPolicy;
  promptTimeoutMs?: number;
}): {
  id: string;
  adapterId: string;
  displayNameKey: string;
  acp: CodexAcpProfileOptions;
} {
  return {
    id: overrides?.id ?? "codex-acp-default",
    adapterId: CODEX_ACP_ADAPTER_ID,
    displayNameKey: "profile.codexAcp.default",
    acp: {
      executable: overrides?.executable,
      model: overrides?.model,
      envKey: overrides?.envKey,
      permissionPolicy: overrides?.permissionPolicy ?? "deny",
      promptTimeoutMs: overrides?.promptTimeoutMs,
    },
  };
}
