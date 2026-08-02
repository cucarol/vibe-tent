// Claude ACP ProviderAdapter — pinned official claude-agent-acp bridge via npx.
// No ACP authenticate RPC; relies on local Claude login and/or injected env when envKey set.
// Never starts real npx/network in tests — ConnectionLaunchPlan command/args override to mock.

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
  CLAUDE_ACP_ADAPTER_ID,
  CLAUDE_ACP_NPX_PACKAGE,
  type ClaudeAcpPermissionPolicy,
  type ClaudeAcpRouteOptions,
} from "./types.js";

export {
  CLAUDE_ACP_ADAPTER_ID,
  CLAUDE_ACP_NPX_PACKAGE,
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  type ClaudeAcpRouteOptions,
  type ClaudeAcpPermissionPolicy,
} from "./types.js";

export interface ClaudeAcpAdapterOptions extends AcpPermissionAskHooks {
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

export class ClaudeAcpProviderAdapter implements ProviderAdapter {
  readonly id = CLAUDE_ACP_ADAPTER_ID;
  readonly displayNameKey = "adapter.claudeAcp.displayName";
  private readonly resolveEnvValue: (
    envKey: string,
    planEnv: Record<string, string>
  ) => string | undefined;
  private readonly onPermissionAsk?: ClaudeAcpAdapterOptions["onPermissionAsk"];

  constructor(options: ClaudeAcpAdapterOptions = {}) {
    this.resolveEnvValue =
      options.resolveEnvValue ??
      ((envKey, planEnv) => resolvePlanOrProcessEnv(envKey, planEnv));
    this.onPermissionAsk = options.onPermissionAsk;
  }

  capabilities(): ProviderCapabilities {
    // The verified package spec is pinned in types.ts. Version 0.62.0 advertises
    // load + resume; provider session ids are native Claude session ids.
    return loadSessionAcpCapabilities("external-app");
  }

  /**
   * Launch plan validation / optional env injection only.
   * Real ACP needs bidirectional stdio — AgentRuntime uses startManagedSession.
   * Does not call ACP authenticate; depends on local Claude login or injected env.
   */
  resolveLaunch(plan: ConnectionLaunchPlan): ResolvedLaunch {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const { command, args } = resolveNpxAcpLaunch({
      planCommand: plan.command,
      planArgs: plan.args,
      executable: opts.executable,
      defaultPackage: CLAUDE_ACP_NPX_PACKAGE,
    });

    const env: Record<string, string> = {
      ...plan.env,
      TENT_SESSION_ID: plan.sessionId,
      TENT_CONNECTION_ID: plan.connectionId,
    };
    // Optional explicit envKey: missing value fails loud; omit envKey to rely on local login.
    if (opts.envKey) {
      const secret = this.resolveEnvValue(opts.envKey, plan.env);
      if (!secret || !secret.trim()) {
        throw new Error(
          `未配置环境变量 ${opts.envKey}：claude-acp Agent Connection 明确要求该密钥` +
            `（仅 service 进程 / ConnectionLaunchPlan.env）。请设置 ${opts.envKey} 后重试；切勿把 secret 写入 workspace/Node/Task。`
        );
      }
      env[opts.envKey] = secret;
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
   * Native ACP resume: new bridge process + session/resume (never session/new,
   * never session/load). Claude Agent ACP 0.62+ advertises sessionCapabilities.resume
   * and implements resume without replaying the full transcript; session/load
   * additionally replays history and is the wrong transport for Tent managed
   * continuity (Tent is not a transcript UI). Live initialize must advertise
   * sessionCapabilities.resume or this fails loud — no session/new fallback.
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
      throw new Error(
        "claude-acp resume requires non-empty provider session id"
      );
    }
    const client = this.createClient(plan, emit);
    return resumeManagedAcpSession({
      plan,
      emit,
      client,
      providerSessionId,
      resumeTransport: "resume",
      bootstrapPrompt: plan.bootstrapPrompt,
    });
  }

  private createClient(
    plan: ConnectionLaunchPlan,
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

    // No authenticate hook — Claude bridge uses local login and/or injected env.
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
      label: "Claude ACP",
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

export function createClaudeAcpAdapter(
  options?: ClaudeAcpAdapterOptions
): ClaudeAcpProviderAdapter {
  return new ClaudeAcpProviderAdapter(options);
}
