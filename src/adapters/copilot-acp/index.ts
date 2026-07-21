// GitHub Copilot CLI ACP adapter — official `copilot --acp --stdio` transport.

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
  resolveNpxAcpLaunch,
  resolvePlanOrProcessEnv,
  resumeManagedAcpSession,
  startManagedAcpSession,
  type AcpPermissionAskHooks,
} from "../acp/index.js";
import {
  COPILOT_ACP_ADAPTER_ID,
  COPILOT_ACP_NPX_PACKAGE,
  type CopilotAcpPermissionPolicy,
  type CopilotAcpProfileOptions,
} from "./types.js";

export {
  COPILOT_ACP_ADAPTER_ID,
  COPILOT_ACP_NPX_PACKAGE,
  type CopilotAcpPermissionPolicy,
  type CopilotAcpProfileOptions,
} from "./types.js";

export interface CopilotAcpAdapterOptions extends AcpPermissionAskHooks {
  resolveEnvValue?: (
    envKey: string,
    planEnv: Record<string, string>
  ) => string | undefined;
}

export class CopilotAcpProviderAdapter implements ProviderAdapter {
  readonly id = COPILOT_ACP_ADAPTER_ID;
  readonly displayNameKey = "adapter.copilotAcp.displayName";
  private readonly resolveEnvValue: (
    envKey: string,
    planEnv: Record<string, string>
  ) => string | undefined;
  private readonly onPermissionAsk?: CopilotAcpAdapterOptions["onPermissionAsk"];

  constructor(options: CopilotAcpAdapterOptions = {}) {
    this.resolveEnvValue =
      options.resolveEnvValue ??
      ((envKey, planEnv) => resolvePlanOrProcessEnv(envKey, planEnv));
    this.onPermissionAsk = options.onPermissionAsk;
  }

  capabilities(): ProviderCapabilities {
    // Verified 2026-07-21: GitHub Copilot CLI/ACP 1.0.73 initialize advertises
    // agentCapabilities.loadSession; high confidence sessionId is ACP-native (CLI resume-homologous).
    return loadSessionAcpCapabilities("external-app");
  }

  resolveLaunch(plan: LaunchPlan): ResolvedLaunch {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const hasCommandOverride = !!plan.command?.trim();
    const base = resolveNpxAcpLaunch({
      planCommand: plan.command,
      planArgs: plan.args,
      executable: opts.executable,
      defaultPackage: COPILOT_ACP_NPX_PACKAGE,
    });
    const args = [...base.args];
    if (!plan.args && !hasCommandOverride) args.push("--acp", "--stdio");
    if (!plan.args && !hasCommandOverride && opts.model) {
      args.push("--model", opts.model);
    }

    const env: Record<string, string> = {
      ...plan.env,
      TENT_SESSION_ID: plan.sessionId,
      TENT_PROFILE_ID: plan.profileId,
    };
    if (plan.roleName) env.TENT_ROLE_NAME = plan.roleName;
    if (opts.envKey) {
      const value = this.resolveEnvValue(opts.envKey, plan.env);
      if (!value?.trim()) {
        throw new Error(
          `未配置环境变量 ${opts.envKey}：copilot-acp profile 明确要求该值` +
            `（仅 service 进程 / LaunchPlan.env）。省略 envKey 可复用本机 Copilot 登录。`
        );
      }
      env[opts.envKey] = value;
    }

    return {
      command: base.command,
      args,
      cwd: plan.cwd,
      env,
      stopSignal: "SIGTERM",
    };
  }

  async startManagedSession(
    plan: LaunchPlan,
    emit: (event: RuntimeEvent) => void
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
    emit: (event: RuntimeEvent) => void
  ): Promise<ManagedSession> {
    const providerSessionId = (
      token.providerSessionId ?? token.raw
    ).trim();
    if (!providerSessionId) {
      throw new Error(
        "copilot-acp resume requires non-empty provider session id"
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
    emit: (event: RuntimeEvent) => void
  ): AcpClient {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const launch = this.resolveLaunch(plan);
    const sessionProj = readAcpSessionProjection(plan.extras);
    const hooks = bindAcpPermissionHooks(plan.sessionId, opts.permissionPolicy, {
      onPermissionAsk: this.onPermissionAsk,
    });
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
      label: "GitHub Copilot ACP",
      emit,
      onPermissionAsk: hooks.onPermissionAsk,
    });
  }

  parseResumeToken(raw: string): ResumeToken {
    return parseAcpResumeToken(raw);
  }

  mapExit(code: number | null, signal?: string): RuntimeEvent {
    return mapAcpProcessExit(code, signal);
  }
}

export function createCopilotAcpAdapter(
  options?: CopilotAcpAdapterOptions
): CopilotAcpProviderAdapter {
  return new CopilotAcpProviderAdapter(options);
}

export function copilotAcpProfileTemplate(overrides?: {
  id?: string;
  executable?: string;
  model?: string;
  envKey?: string;
  permissionPolicy?: CopilotAcpPermissionPolicy;
}): {
  id: string;
  adapterId: string;
  displayNameKey: string;
  acp: CopilotAcpProfileOptions;
} {
  return {
    id: overrides?.id ?? "copilot-acp-default",
    adapterId: COPILOT_ACP_ADAPTER_ID,
    displayNameKey: "profile.copilotAcp.default",
    acp: {
      executable: overrides?.executable,
      model: overrides?.model,
      envKey: overrides?.envKey,
      permissionPolicy: overrides?.permissionPolicy ?? "deny",
    },
  };
}
