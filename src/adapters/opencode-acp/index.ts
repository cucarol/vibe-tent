// OpenCode ACP adapter: native `opencode acp` stdio transport.

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
  resolvePlanOrProcessEnv,
  startManagedAcpSession,
  type AcpPermissionAskHooks,
} from "../acp/index.js";
import {
  OPENCODE_ACP_ADAPTER_ID,
  type OpenCodeAcpPermissionPolicy,
  type OpenCodeAcpProfileOptions,
} from "./types.js";

export {
  OPENCODE_ACP_ADAPTER_ID,
  type OpenCodeAcpPermissionPolicy,
  type OpenCodeAcpProfileOptions,
} from "./types.js";

export interface OpenCodeAcpAdapterOptions extends AcpPermissionAskHooks {
  resolveEnvValue?: (
    envKey: string,
    planEnv: Record<string, string>
  ) => string | undefined;
}

export function defaultOpenCodeExecutable(): string {
  return process.platform === "win32" ? "opencode.exe" : "opencode";
}

export class OpenCodeAcpProviderAdapter implements ProviderAdapter {
  readonly id = OPENCODE_ACP_ADAPTER_ID;
  readonly displayNameKey = "adapter.openCodeAcp.displayName";
  private readonly resolveEnvValue: (
    envKey: string,
    planEnv: Record<string, string>
  ) => string | undefined;
  private readonly onPermissionAsk?: OpenCodeAcpAdapterOptions["onPermissionAsk"];
  private readonly onPermissionAskFailSafe?: OpenCodeAcpAdapterOptions["onPermissionAskFailSafe"];

  constructor(options: OpenCodeAcpAdapterOptions = {}) {
    this.resolveEnvValue =
      options.resolveEnvValue ??
      ((envKey, planEnv) => resolvePlanOrProcessEnv(envKey, planEnv));
    this.onPermissionAsk = options.onPermissionAsk;
    this.onPermissionAskFailSafe = options.onPermissionAskFailSafe;
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
          `未配置环境变量 ${opts.envKey}：opencode-acp profile 明确要求该值` +
            `（仅 service 进程 / LaunchPlan.env）。`
        );
      }
      env[opts.envKey] = value;
    }

    return {
      command: plan.command?.trim() || opts.executable || defaultOpenCodeExecutable(),
      args: plan.args ? [...plan.args] : ["acp"],
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
    const hooks = bindAcpPermissionHooks(plan.sessionId, opts.permissionPolicy, {
      onPermissionAsk: this.onPermissionAsk,
      onPermissionAskFailSafe: this.onPermissionAskFailSafe,
    });
    const client = new AcpClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      sessionId: plan.sessionId,
      promptTimeoutMs: opts.promptTimeoutMs,
      permissionPolicy: opts.permissionPolicy,
      permissionTimeoutMs: opts.permissionTimeoutMs,
      label: "OpenCode ACP",
      emit,
      onPermissionAsk: hooks.onPermissionAsk,
      onPermissionAskFailSafe: hooks.onPermissionAskFailSafe,
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

export function createOpenCodeAcpAdapter(
  options?: OpenCodeAcpAdapterOptions
): OpenCodeAcpProviderAdapter {
  return new OpenCodeAcpProviderAdapter(options);
}

export function openCodeAcpProfileTemplate(overrides?: {
  id?: string;
  executable?: string;
  envKey?: string;
  permissionPolicy?: OpenCodeAcpPermissionPolicy;
}): {
  id: string;
  adapterId: string;
  displayNameKey: string;
  acp: OpenCodeAcpProfileOptions;
} {
  return {
    id: overrides?.id ?? "opencode-acp-default",
    adapterId: OPENCODE_ACP_ADAPTER_ID,
    displayNameKey: "profile.openCodeAcp.default",
    acp: {
      executable: overrides?.executable,
      envKey: overrides?.envKey,
      permissionPolicy: overrides?.permissionPolicy ?? "deny",
    },
  };
}
