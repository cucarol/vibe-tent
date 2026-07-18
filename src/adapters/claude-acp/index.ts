// Claude ACP ProviderAdapter — npx @agentclientprotocol/claude-agent-acp bridge.
// No ACP authenticate RPC; relies on local Claude login and/or injected env when envKey set.
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
  mapAcpProcessExit,
  mainstreamAcpCapabilities,
  normalizeSharedAcpOpts,
  parseAcpResumeToken,
  readAcpExtras,
  readAcpSessionProjection,
  resolveNpxAcpLaunch,
  resolvePlanOrProcessEnv,
  startManagedAcpSession,
  type AcpPermissionAskHooks,
} from "../acp/index.js";
import {
  CLAUDE_ACP_ADAPTER_ID,
  CLAUDE_ACP_NPX_PACKAGE,
  type ClaudeAcpPermissionPolicy,
  type ClaudeAcpProfileOptions,
} from "./types.js";

export {
  CLAUDE_ACP_ADAPTER_ID,
  CLAUDE_ACP_NPX_PACKAGE,
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  type ClaudeAcpProfileOptions,
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
    return mainstreamAcpCapabilities();
  }

  /**
   * Launch plan validation / optional env injection only.
   * Real ACP needs bidirectional stdio — AgentRuntime uses startManagedSession.
   * Does not call ACP authenticate; depends on local Claude login or injected env.
   */
  resolveLaunch(plan: LaunchPlan): ResolvedLaunch {
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
      TENT_PROFILE_ID: plan.profileId,
    };
    if (plan.roleName) env.TENT_ROLE_NAME = plan.roleName;
    // Optional explicit envKey: missing value fails loud; omit envKey to rely on local login.
    if (opts.envKey) {
      const secret = this.resolveEnvValue(opts.envKey, plan.env);
      if (!secret || !secret.trim()) {
        throw new Error(
          `未配置环境变量 ${opts.envKey}：claude-acp 已在 AgentProfile.acp.envKey 中明确要求该密钥` +
            `（仅 service 进程 / LaunchPlan.env）。请设置 ${opts.envKey} 后重试；切勿把 secret 写入 workspace/box/task。`
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
    plan: LaunchPlan,
    emit: (ev: RuntimeEvent) => void
  ): Promise<ManagedSession> {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const launch = this.resolveLaunch(plan);
    const sessionProj = readAcpSessionProjection(plan.extras);

    const permHooks = bindAcpPermissionHooks(plan.sessionId, opts.permissionPolicy, {
      onPermissionAsk: this.onPermissionAsk,
    });

    // No authenticate hook — Claude bridge uses local login and/or injected env.
    const client = new AcpClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      sessionId: plan.sessionId,
      promptTimeoutMs: opts.promptTimeoutMs,
      permissionPolicy: opts.permissionPolicy,
      mcpServers: sessionProj.mcpServers,
      skills: sessionProj.skills,
      label: "Claude ACP",
      emit,
      onPermissionAsk: permHooks.onPermissionAsk,
    });

    return startManagedAcpSession({ plan, emit, client });
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

/** Machine-local profile template — no default envKey/model invented. */
export function claudeAcpProfileTemplate(overrides?: {
  id?: string;
  executable?: string;
  model?: string;
  envKey?: string;
  permissionPolicy?: ClaudeAcpPermissionPolicy;
  promptTimeoutMs?: number;
}): {
  id: string;
  adapterId: string;
  displayNameKey: string;
  acp: ClaudeAcpProfileOptions;
} {
  return {
    id: overrides?.id ?? "claude-acp-default",
    adapterId: CLAUDE_ACP_ADAPTER_ID,
    displayNameKey: "profile.claudeAcp.default",
    acp: {
      executable: overrides?.executable,
      model: overrides?.model,
      envKey: overrides?.envKey,
      permissionPolicy: overrides?.permissionPolicy ?? "deny",
      promptTimeoutMs: overrides?.promptTimeoutMs,
    },
  };
}
