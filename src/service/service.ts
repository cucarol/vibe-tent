// Local Tent Service process host — sole mutation runtime for desktop product path.
// B5: wires AgentRuntime + A2A store + loopback token into the B2 skeleton.

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
import { ensureDefaultProfiles } from "./profiles.js";
import { createAgentRuntime, type AgentRuntime } from "../runtime/agent-runtime.js";
import type { AgentProfileConfig } from "../runtime/types.js";

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
  /** Extra / override AgentProfiles (machine-local). */
  profiles?: AgentProfileConfig[];
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
  ctx: HandlerContext;
  endpoint: ServiceEndpointRecord | null;
  stop: () => Promise<void>;
}

const SERVICE_VERSION = "0.1.0-b5";

export async function startLocalTentService(options: LocalTentServiceOptions = {}): Promise<LocalTentService> {
  const dataDir = options.dataDir ?? defaultServiceDataDir();
  const version = options.version ?? SERVICE_VERSION;
  const startedAt = new Date().toISOString();
  const getPid = options.getPid ?? (() => process.pid);
  const token = options.token ?? generateServiceToken();

  const events = new EventBus();
  const mutations = new MutationBus();
  const workspaceHost = new WorkspaceHost({ events });
  const a2a = new A2AApprovalStore(dataDir);
  await a2a.ensureLoaded();

  const profiles = options.profiles ?? (await ensureDefaultProfiles(dataDir));
  const runtime = createAgentRuntime({ dataDir, profiles });
  // Reconcile orphan sessions after crash / restart.
  await runtime.reconcileOnBoot();

  const ctx: HandlerContext = {
    host: workspaceHost,
    mutations,
    events,
    version,
    startedAt,
    getPid,
    runtime,
    a2a,
    dataDir,
    integrateCommits: options.integrateCommits,
  };

  // Bridge runtime events → EventEnvelope (no chat tokens).
  runtime.subscribeAll((ev) => mapRuntimeEventToService(ctx, ev));

  const httpServer: ServiceHttpServer = await createServiceHttpServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    ctx,
    events,
    token,
  });

  let endpoint: ServiceEndpointRecord | null = null;
  if (options.writeEndpoint !== false) {
    endpoint = {
      pid: getPid(),
      host: httpServer.host,
      port: httpServer.port,
      startedAt,
      version,
      token,
    };
    await writeServiceEndpoint(dataDir, endpoint);
  }

  events.emit("service.health", "", {
    action: "started",
    url: httpServer.url,
    pid: getPid(),
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    events.emit("service.health", "", { action: "stopping" });
    try {
      await runtime.shutdown();
    } catch {
      // best-effort
    }
    await workspaceHost.dispose();
    await httpServer.close();
    if (options.writeEndpoint !== false) {
      await removeServiceEndpoint(dataDir);
    }
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
    ctx,
    endpoint,
    stop,
  };
}
