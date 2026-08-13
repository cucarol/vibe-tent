// Pi ACP ProviderAdapter — third-party `pi-acp` bridge (stdio JSON-RPC).
// Bridge package: npm `pi-acp` → spawns `pi --mode rpc` (@earendil-works/pi-coding-agent).
// Evidence (this host, 2026-07-23): initialize advertises loadSession=true;
// session/new returns a provider sessionId when `pi` is on PATH.
// Never starts real npx/network in default tests — ConnectionLaunchPlan command/args override to mock.

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
  PI_ACP_ADAPTER_ID,
  PI_ACP_NPX_PACKAGE,
  type PiAcpPermissionPolicy,
  type PiAcpRouteOptions,
} from "./types.js";

export {
  PI_ACP_ADAPTER_ID,
  PI_ACP_NPX_PACKAGE,
  type PiAcpPermissionPolicy,
  type PiAcpRouteOptions,
} from "./types.js";

export interface PiAcpAdapterOptions extends AcpPermissionAskHooks {
  /**
   * Resolve secret for an explicitly configured acp.envKey.
   * Default: plan.env[envKey] ?? process.env[envKey].
   * Omitting envKey relies on pi's local provider/login configuration.
   */
  resolveEnvValue?: (
    envKey: string,
    planEnv: Record<string, string>
  ) => string | undefined;
}

export class PiAcpProviderAdapter implements ProviderAdapter {
  readonly id = PI_ACP_ADAPTER_ID;
  readonly displayNameKey = "adapter.piAcp.displayName";
  private readonly resolveEnvValue: (
    envKey: string,
    planEnv: Record<string, string>
  ) => string | undefined;
  private readonly onPermissionAsk?: PiAcpAdapterOptions["onPermissionAsk"];

  constructor(options: PiAcpAdapterOptions = {}) {
    this.resolveEnvValue =
      options.resolveEnvValue ??
      ((envKey, planEnv) => resolvePlanOrProcessEnv(envKey, planEnv));
    this.onPermissionAsk = options.onPermissionAsk;
  }

  capabilities(): ProviderCapabilities {
    // Verified 2026-07-23: pi-acp@0.0.31 initialize advertises
    // agentCapabilities.loadSession=true; session/new returns ACP sessionId.
    // Runtime still gates each resume on the live initialize handshake.
    return loadSessionAcpCapabilities("external-app");
  }

  /**
   * Launch plan validation / env injection only.
   * Real ACP needs bidirectional stdio — AgentRuntime uses startManagedSession.
   */
  resolveLaunch(plan: ConnectionLaunchPlan): ResolvedLaunch {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const { command, args } = resolveNpxAcpLaunch({
      planCommand: plan.command,
      planArgs: plan.args,
    });

    const env: Record<string, string> = {
      ...plan.env,
      TENT_SESSION_ID: plan.sessionId,
      TENT_CONNECTION_ID: plan.connectionId,
    };
    // Explicit envKey only: missing value fails loud; never invent a default key name.
    if (opts.envKey) {
      const secret = this.resolveEnvValue(opts.envKey, plan.env);
      if (!secret || !secret.trim()) {
        throw new Error(
          `未配置环境变量 ${opts.envKey}：pi-acp Agent Connection 明确要求该值` +
          `（仅 service 进程 / ConnectionLaunchPlan.env）。省略 envKey 可复用本机 pi 登录/配置。`
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
        "pi-acp resume requires non-empty provider session id"
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
      label: "Pi ACP",
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

export function createPiAcpAdapter(
  options?: PiAcpAdapterOptions
): PiAcpProviderAdapter {
  return new PiAcpProviderAdapter(options);
}
