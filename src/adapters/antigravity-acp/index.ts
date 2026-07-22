// Antigravity ACP adapter: official `agy` CLI through the third-party `agy-acp` bridge.
// Tent does not own the bridge's conversation database and never starts `agy` directly.

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
  readBootstrapImageClientOptions,
  resolvePlanOrProcessEnv,
  startManagedAcpSession,
  type AcpPermissionAskHooks,
} from "../acp/index.js";
import {
  ANTIGRAVITY_ACP_ADAPTER_ID,
  ANTIGRAVITY_ACP_BRIDGE,
  type AntigravityAcpPermissionPolicy,
  type AntigravityAcpProfileOptions,
} from "./types.js";

export {
  ANTIGRAVITY_ACP_ADAPTER_ID,
  ANTIGRAVITY_ACP_BRIDGE,
  type AntigravityAcpPermissionPolicy,
  type AntigravityAcpProfileOptions,
} from "./types.js";

export interface AntigravityAcpAdapterOptions extends AcpPermissionAskHooks {
  resolveEnvValue?: (
    envKey: string,
    planEnv: Record<string, string>
  ) => string | undefined;
}

export function defaultAntigravityAcpExecutable(): string {
  return process.platform === "win32" ? "agy-acp.exe" : ANTIGRAVITY_ACP_BRIDGE;
}

export class AntigravityAcpProviderAdapter implements ProviderAdapter {
  readonly id = ANTIGRAVITY_ACP_ADAPTER_ID;
  readonly displayNameKey = "adapter.antigravityAcp.displayName";
  private readonly resolveEnvValue: (
    envKey: string,
    planEnv: Record<string, string>
  ) => string | undefined;
  private readonly onPermissionAsk?: AntigravityAcpAdapterOptions["onPermissionAsk"];

  constructor(options: AntigravityAcpAdapterOptions = {}) {
    this.resolveEnvValue =
      options.resolveEnvValue ??
      ((envKey, planEnv) => resolvePlanOrProcessEnv(envKey, planEnv));
    this.onPermissionAsk = options.onPermissionAsk;
  }

  capabilities(): ProviderCapabilities {
    return mainstreamAcpCapabilities();
  }

  resolveLaunch(plan: LaunchPlan): ResolvedLaunch {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
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
          `未配置环境变量 ${opts.envKey}：antigravity-acp profile 明确要求该值。` +
            `Tent 通过第三方 agy-acp bridge 连接官方 agy CLI；secret 只能放在 service 进程环境。`
        );
      }
      env[opts.envKey] = value;
    }

    return {
      command: plan.command?.trim() || opts.executable || defaultAntigravityAcpExecutable(),
      args: plan.args ? [...plan.args] : [],
      cwd: plan.cwd,
      env,
      stopSignal: "SIGTERM",
    };
  }

  async startManagedSession(
    plan: LaunchPlan,
    emit: (event: RuntimeEvent) => void
  ): Promise<ManagedSession> {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const launch = this.resolveLaunch(plan);
    const sessionProj = readAcpSessionProjection(plan.extras);
    const imageOpts = readBootstrapImageClientOptions(plan);
    const hooks = bindAcpPermissionHooks(plan.sessionId, opts.permissionPolicy, {
      onPermissionAsk: this.onPermissionAsk,
    });
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
      ...imageOpts,
      label: "Antigravity ACP (third-party agy-acp bridge)",
      emit,
      onPermissionAsk: hooks.onPermissionAsk,
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

export function createAntigravityAcpAdapter(
  options?: AntigravityAcpAdapterOptions
): AntigravityAcpProviderAdapter {
  return new AntigravityAcpProviderAdapter(options);
}

export function antigravityAcpProfileTemplate(overrides?: {
  id?: string;
  executable?: string;
  envKey?: string;
  permissionPolicy?: AntigravityAcpPermissionPolicy;
}): {
  id: string;
  adapterId: string;
  displayNameKey: string;
  acp: AntigravityAcpProfileOptions;
} {
  return {
    id: overrides?.id ?? "antigravity-acp-default",
    adapterId: ANTIGRAVITY_ACP_ADAPTER_ID,
    displayNameKey: "profile.antigravityAcp.default",
    acp: {
      executable: overrides?.executable,
      envKey: overrides?.envKey,
      permissionPolicy: overrides?.permissionPolicy ?? "deny",
    },
  };
}
