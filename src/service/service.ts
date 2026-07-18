// Local Tent Service process host — sole mutation runtime for desktop product path.
// B5: wires AgentRuntime + A2A store + tool-approval store + loopback token into the B2 skeleton.

import { createServiceHttpServer, type ServiceHttpServer } from "./http-server.js";
import { EventBus } from "./events.js";
import { MutationBus } from "./mutation-bus.js";
import { WorkspaceHost } from "./workspace-host.js";
import { mapRuntimeEventToService, type HandlerContext } from "./handlers.js";
import {
  defaultServiceDataDir,
  removeServiceEndpoint,
  writeServiceEndpoint,
  type ServiceEndpointRecord,
} from "./data-dir.js";
import { generateServiceToken } from "./auth.js";
import { A2AApprovalStore } from "./a2a-store.js";
import {
  makeToolApprovalId,
  ToolApprovalStore,
} from "./tool-approval-store.js";
import { UserAskStore } from "./user-ask-store.js";
import { TaskInputStore } from "./task-input-store.js";
import { ensureDefaultProfiles } from "./profiles.js";
import { AgentProfileCatalog } from "./profile-catalog.js";
import type { CredentialProtector } from "./credential-protector.js";
import { CredentialStore } from "./credential-store.js";
import { createAgentRuntime, type AgentRuntime } from "../runtime/agent-runtime.js";
import type { AgentProfileConfig } from "../runtime/types.js";
import {
  createGrokAcpAdapter,
  DEFAULT_PERMISSION_TIMEOUT_MS,
} from "../adapters/grok-acp/index.js";
import { createCodexAcpAdapter } from "../adapters/codex-acp/index.js";
import { createClaudeAcpAdapter } from "../adapters/claude-acp/index.js";
import { createAntigravityAcpAdapter } from "../adapters/antigravity-acp/index.js";
import { createOpenCodeAcpAdapter } from "../adapters/opencode-acp/index.js";
import { createCopilotAcpAdapter } from "../adapters/copilot-acp/index.js";
import type { AcpPermissionAskHooks } from "../adapters/acp/index.js";
import { createFakeAdapter } from "../adapters/fake/index.js";
import { loadTaskEnvelopes } from "../core/task.js";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireServiceDataDirLease,
  type ServiceDataDirLease,
} from "./service-lease.js";

export interface LocalTentServiceOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  version?: string;
  /** When false, skip writing machine-local service.json (tests). */
  writeEndpoint?: boolean;
  getPid?: () => number;
  /** Override token (tests); otherwise generated and stored in endpoint. */
  token?: string;
  /** Explicit in-memory AgentProfiles for tests/harness; skips catalog persistence. */
  profiles?: AgentProfileConfig[];
  /**
   * Inject CredentialStore protector (offline tests). Production uses Windows DPAPI.
   * When omitted, CredentialStore uses createPlatformCredentialProtector (fail-loud off Windows).
   */
  credentialProtector?: CredentialProtector;
  /**
   * Package root for bundled skills (tests inject). Default: resolve from this module.
   */
  packageRoot?: string;
  /**
   * Home for machine-local user paths such as skill install dirs (tests inject).
   * Default: os.homedir() — never hard-coded user paths.
   */
  home?: string;
  /**
   * Optional commit integrate hook for accept/bypass paths (tests).
   * Production uses real workspace Git via handlers → integrateWorkspaceCommits.
   */
  integrateCommits?: (workspaceRoot: string, commits: string[], role: string) => Promise<void>;
}

export interface LocalTentService {
  url: string;
  host: string;
  port: number;
  dataDir: string;
  /** Loopback client token — machine-local only. */
  token: string;
  events: EventBus;
  hostApi: WorkspaceHost;
  runtime: AgentRuntime;
  credentials: CredentialStore;
  ctx: HandlerContext;
  endpoint: ServiceEndpointRecord | null;
  stop: () => Promise<void>;
}

const SERVICE_VERSION = "0.1.0-b5";

export async function startLocalTentService(options: LocalTentServiceOptions = {}): Promise<LocalTentService> {
  const dataDir = options.dataDir ?? defaultServiceDataDir();
  const serviceLease = await acquireServiceDataDirLease(dataDir);
  const startupCleanups: Array<{ phase: number; action: () => Promise<void> }> = [];
  try {
    return await startOwnedLocalTentService(
      options,
      dataDir,
      serviceLease,
      (phase, action) => startupCleanups.push({ phase, action })
    );
  } catch (error) {
    startupCleanups.sort((a, b) => a.phase - b.phase);
    for (const cleanup of startupCleanups) {
      try {
        await cleanup.action();
      } catch {
        // Preserve the startup error; every later cleanup still gets a chance.
      }
    }
    await serviceLease.release();
    throw error;
  }
}

async function startOwnedLocalTentService(
  options: LocalTentServiceOptions,
  dataDir: string,
  serviceLease: ServiceDataDirLease,
  registerStartupCleanup: (phase: number, action: () => Promise<void>) => void
): Promise<LocalTentService> {
  const version = options.version ?? SERVICE_VERSION;
  const startedAt = new Date().toISOString();
  const getPid = options.getPid ?? (() => process.pid);
  const token = options.token ?? generateServiceToken();

  const events = new EventBus();
  const mutations = new MutationBus();
  const workspaceHost = new WorkspaceHost({ events });
  registerStartupCleanup(30, () => workspaceHost.dispose());
  const a2a = new A2AApprovalStore(dataDir);
  await a2a.ensureLoaded();
  const toolApprovals = new ToolApprovalStore(dataDir);
  await toolApprovals.ensureLoaded();
  const userAsks = new UserAskStore(dataDir);
  await userAsks.ensureLoaded();
  const taskInputs = new TaskInputStore(dataDir);
  await taskInputs.ensureLoaded();

  const credentials = new CredentialStore(dataDir, {
    protector: options.credentialProtector,
  });
  await credentials.ensureLoaded();

  // options.profiles: in-memory inject for tests (skip ensureDefaultProfiles disk seed).
  // Injected catalogs never persist CRUD to dataDir/agent-profiles.json.
  const profilesInjected = options.profiles !== undefined;
  const profiles = profilesInjected
    ? options.profiles!
    : await ensureDefaultProfiles(dataDir);

  // Mutable holder so onPermissionAsk can read runtime after it is created.
  const runtimeHolder: { current: AgentRuntime | null } = { current: null };

  /**
   * Bridge ACP permissionPolicy=ask → machine-local tool approval store.
   * Distinct from A2A spawn approval. Never agent self-approve.
   * ToolApprovalStore waitForDecision / expiresAt is the sole timeout authority;
   * late approve after expire fails. ACP client has no second permission timer.
   */
  const acpPermissionHooks: AcpPermissionAskHooks = {
    onPermissionAsk: async (info) => {
      const runtime = runtimeHolder.current;
      if (!runtime) return "deny";
      const rec = await runtime.registry.read(info.sessionId);
      const workspaceId =
        rec?.workspace ?? workspaceHost.getForegroundId() ?? "";
      if (!workspaceId) return "deny";

      let taskPath: string | undefined;
      let taskId: string | undefined;
      let role: string | undefined = rec?.roleName;
      try {
        const mount = workspaceHost.get(workspaceId);
        if (mount) {
          const tasks = await loadTaskEnvelopes(mount.env.fs);
          const task = tasks.find(
            (t) =>
              t.sessionId === info.sessionId ||
              (!!rec?.lastTaskId &&
                (t.id === rec.lastTaskId || t.path === rec.lastTaskId))
          );
          if (task) {
            taskPath = task.path;
            taskId = task.id || task.path;
            role = task.role || role;
          }
        }
      } catch {
        // binding is best-effort; still record pending for session
      }

      // Always read the current runtime profile — never close over boot profiles array.
      const profile = rec?.profileId
        ? runtime.getProfile(rec.profileId)
        : undefined;
      const timeoutMs =
        typeof profile?.acp?.permissionTimeoutMs === "number" &&
        profile.acp.permissionTimeoutMs > 0
          ? profile.acp.permissionTimeoutMs
          : DEFAULT_PERMISSION_TIMEOUT_MS;

      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + timeoutMs);
      const item = await toolApprovals.add({
        id: makeToolApprovalId(),
        workspaceId,
        sessionId: info.sessionId,
        taskId,
        taskPath,
        role,
        toolTitle: info.toolTitle || "tool",
        toolCallId: info.toolCallId,
        options: (info.options ?? []).map((o) => ({
          optionId: o.optionId,
          kind: o.kind,
          name: o.name,
        })),
        status: "pending",
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });

      events.emit(
        "toolApproval.pending",
        workspaceId,
        {
          approvalId: item.id,
          sessionId: item.sessionId,
          taskPath: item.taskPath,
          role: item.role,
          toolTitle: item.toolTitle,
          expiresAt: item.expiresAt,
        },
        "service"
      );

      // Authoritative wait: store mutates status to expired on timeout.
      const decision = await toolApprovals.waitForDecision(item.id, timeoutMs);
      return decision === "approved" ? "allow" : "deny";
    },
  };

  const runtime = createAgentRuntime({
    dataDir,
    profiles,
    adapters: [
      createFakeAdapter(),
      createGrokAcpAdapter(acpPermissionHooks),
      createCodexAcpAdapter(acpPermissionHooks),
      createClaudeAcpAdapter(acpPermissionHooks),
      createAntigravityAcpAdapter(acpPermissionHooks),
      createOpenCodeAcpAdapter(acpPermissionHooks),
      createCopilotAcpAdapter(acpPermissionHooks),
    ],
    resolveProfileEnv: async (profile) => {
      const ref =
        typeof profile.acp?.credentialRef === "string"
          ? profile.acp.credentialRef.trim()
          : "";
      if (!ref) return {};
      const envKey =
        typeof profile.acp?.envKey === "string" ? profile.acp.envKey.trim() : "";
      if (!envKey) {
        throw new Error(
          `Profile ${profile.id} has credentialRef but no acp.envKey (cannot inject secret into process env)`
        );
      }
      // resolve() fail-loud when missing; map message without secret material.
      const secret = await credentials.resolve(ref);
      if (!secret) {
        throw new Error(
          `Credential not found or empty for profile ${profile.id} (credentialRef=${ref})`
        );
      }
      return { [envKey]: secret };
    },
    resolveCredentialRef: async (credentialRef) => {
      const id = typeof credentialRef === "string" ? credentialRef.trim() : "";
      if (!id) return undefined;
      // Fail-loud: do not swallow vault/resolver errors (AgentRuntime redacts to profile/server/ref).
      const secret = await credentials.resolve(id);
      return typeof secret === "string" && secret ? secret : undefined;
    },
  });
  runtimeHolder.current = runtime;
  registerStartupCleanup(10, async () => {
    try {
      await runtime.shutdown();
    } catch {
      // best-effort startup rollback
    }
  });

  const profileCatalog = new AgentProfileCatalog(dataDir, runtime, profiles, {
    // Normal boot: persist CRUD to this service dataDir.
    // options.profiles inject: in-memory only — no agent-profiles.json writes.
    persistToDisk: !profilesInjected,
  });

  // Reconcile orphan sessions after crash / restart.
  await runtime.reconcileOnBoot();

  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const home = options.home ?? os.homedir();

  const ctx: HandlerContext = {
    host: workspaceHost,
    mutations,
    events,
    version,
    startedAt,
    getPid,
    runtime,
    a2a,
    toolApprovals,
    userAsks,
    taskInputs,
    credentials,
    dataDir,
    profileCatalog,
    packageRoot,
    home,
    integrateCommits: options.integrateCommits,
  };

  // Bridge runtime events → EventEnvelope (no chat tokens).
  // Projection is serialized per sessionId with one bounded retry on failure.
  // Keep service-owned references so shutdown cannot return while terminal
  // runtime events are still mutating task/session projections in the background.
  const runtimeProjections = new Set<Promise<void>>();
  const unsubscribeRuntimeEvents = runtime.subscribeAll((ev) => {
    const projection = mapRuntimeEventToService(ctx, ev);
    runtimeProjections.add(projection);
    void projection.then(
      () => runtimeProjections.delete(projection),
      () => runtimeProjections.delete(projection)
    );
  });

  const drainRuntimeProjections = async (): Promise<void> => {
    // A projection may enqueue another runtime event (for example an idempotent
    // stop during failure cleanup), so drain snapshots until the set stays empty.
    while (runtimeProjections.size > 0) {
      await Promise.allSettled([...runtimeProjections]);
    }
  };
  registerStartupCleanup(20, async () => {
    await drainRuntimeProjections();
    unsubscribeRuntimeEvents();
  });

  const httpServer: ServiceHttpServer = await createServiceHttpServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    ctx,
    events,
    token,
  });
  // Quiesce the transport before startup rollback tears down dependencies that
  // an already accepted request may still be using.
  registerStartupCleanup(5, () => httpServer.close());

  let endpoint: ServiceEndpointRecord | null = null;
  if (options.writeEndpoint !== false) {
    endpoint = {
      instanceId: serviceLease.instanceId,
      pid: getPid(),
      host: httpServer.host,
      port: httpServer.port,
      startedAt,
      version,
      token,
    };
    await writeServiceEndpoint(dataDir, endpoint);
    registerStartupCleanup(50, () =>
      removeServiceEndpoint(dataDir, serviceLease.instanceId)
    );
  }

  events.emit("service.health", "", {
    action: "started",
    url: httpServer.url,
    pid: getPid(),
  });

  let stopPromise: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      let firstError: unknown;
      const attempt = async (action: () => void | Promise<void>, bestEffort = false) => {
        try {
          await action();
        } catch (error) {
          if (!bestEffort && firstError === undefined) firstError = error;
        }
      };

      try {
        events.emit("service.health", "", { action: "stopping" });
        // Stop accepting work and drain finite requests before their runtime and
        // workspace dependencies are disposed. Active SSE streams are terminated
        // by the HTTP server and therefore cannot hold shutdown open.
        await attempt(() => httpServer.close());
        // Tool asks are process-bound. Close their store before stopping ACP
        // children so service-owned waiters/timers cannot outlive shutdown.
        await attempt(() => toolApprovals.shutdown(), true);
        await attempt(() => userAsks.shutdown(), true);
        await attempt(() => taskInputs.shutdown(), true);
        await attempt(() => runtime.shutdown(), true);
        await attempt(() => drainRuntimeProjections());
        unsubscribeRuntimeEvents();
        await attempt(() => workspaceHost.dispose());
      } finally {
        if (options.writeEndpoint !== false) {
          await attempt(() => removeServiceEndpoint(dataDir, serviceLease.instanceId));
        }
        await attempt(() => serviceLease.release());
      }
      if (firstError !== undefined) throw firstError;
    })();
    return stopPromise;
  };

  return {
    url: httpServer.url,
    host: httpServer.host,
    port: httpServer.port,
    dataDir,
    token,
    events,
    hostApi: workspaceHost,
    runtime,
    credentials,
    ctx,
    endpoint,
    stop,
  };
}

/** Resolve repo/package root from this module location (src/service or dist). */
function defaultPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/service → repo root; bundled service.mjs may sit at package root.
  if (path.basename(here) === "service" && path.basename(path.dirname(here)) === "src") {
    return path.resolve(here, "../..");
  }
  return path.resolve(here);
}
