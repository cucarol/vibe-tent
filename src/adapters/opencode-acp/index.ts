// OpenCode ACP adapter: native `opencode acp` stdio transport.

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
  resolvePlanOrProcessEnv,
  resumeManagedAcpSession,
  startManagedAcpSession,
  type AcpPermissionAskHooks,
} from "../acp/index.js";
import {
  OPENCODE_ACP_ADAPTER_ID,
  type OpenCodeAcpPermissionPolicy,
  type OpenCodeAcpRouteOptions,
} from "./types.js";

export {
  OPENCODE_ACP_ADAPTER_ID,
  type OpenCodeAcpPermissionPolicy,
  type OpenCodeAcpRouteOptions,
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

  constructor(options: OpenCodeAcpAdapterOptions = {}) {
    this.resolveEnvValue =
      options.resolveEnvValue ??
      ((envKey, planEnv) => resolvePlanOrProcessEnv(envKey, planEnv));
    this.onPermissionAsk = options.onPermissionAsk;
  }

  capabilities(): ProviderCapabilities {
    // Verified: local `opencode acp` advertises agentCapabilities.loadSession.
    return loadSessionAcpCapabilities("external-app");
  }

  resolveLaunch(plan: ConnectionLaunchPlan): ResolvedLaunch {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const env: Record<string, string> = {
      ...plan.env,
      TENT_SESSION_ID: plan.sessionId,
      TENT_CONNECTION_ID: plan.connectionId,
    };
    if (opts.envKey) {
      const value = this.resolveEnvValue(opts.envKey, plan.env);
      if (!value?.trim()) {
        throw new Error(
          `未配置环境变量 ${opts.envKey}：opencode-acp Agent Connection 明确要求该值` +
          `（仅 service 进程 / ConnectionLaunchPlan.env）。`
        );
      }
      env[opts.envKey] = value;
    }
    const command = plan.command?.trim();
    if (!command) {
      throw new Error("Agent Connection is missing canonical command");
    }
    if (!Array.isArray(plan.args)) {
      throw new Error("Agent Connection is missing canonical args");
    }

    return {
      command,
      args: [...plan.args],
      cwd: plan.cwd,
      env,
      stopSignal: "SIGTERM",
    };
  }

  async startManagedSession(
    plan: ConnectionLaunchPlan,
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
    plan: ConnectionLaunchPlan,
    token: ResumeToken,
    emit: (event: RuntimeEvent) => void
  ): Promise<ManagedSession> {
    const providerSessionId = (
      token.providerSessionId ?? token.raw
    ).trim();
    if (!providerSessionId) {
      throw new Error(
        "opencode-acp resume requires non-empty provider session id"
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
    plan: ConnectionLaunchPlan,
    emit: (event: RuntimeEvent) => void
  ): AcpClient {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const launch = this.resolveLaunch(plan);
    const sessionProj = readAcpSessionProjection(plan.extras);
    const imageOpts = readBootstrapImageClientOptions(plan);
    const coreChildOpts = readCoreChildEnvClientOptions(plan);
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
      ...imageOpts,
      ...coreChildOpts,
      label: "OpenCode ACP",
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

export function createOpenCodeAcpAdapter(
  options?: OpenCodeAcpAdapterOptions
): OpenCodeAcpProviderAdapter {
  return new OpenCodeAcpProviderAdapter(options);
}
