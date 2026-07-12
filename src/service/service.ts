// Local Tent Service process host — sole mutation runtime for desktop product path.

import { createServiceHttpServer, type ServiceHttpServer } from "./http-server.js";
import { EventBus } from "./events.js";
import { MutationBus } from "./mutation-bus.js";
import { WorkspaceHost } from "./workspace-host.js";
import type { HandlerContext } from "./handlers.js";
import {
  defaultServiceDataDir,
  removeServiceEndpoint,
  writeServiceEndpoint,
  type ServiceEndpointRecord,
} from "./data-dir.js";

export interface LocalTentServiceOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  version?: string;
  /** When false, skip writing machine-local service.json (tests). */
  writeEndpoint?: boolean;
  getPid?: () => number;
}

export interface LocalTentService {
  url: string;
  host: string;
  port: number;
  dataDir: string;
  events: EventBus;
  hostApi: WorkspaceHost;
  ctx: HandlerContext;
  endpoint: ServiceEndpointRecord | null;
  stop: () => Promise<void>;
}

const SERVICE_VERSION = "0.1.0-b2";

export async function startLocalTentService(options: LocalTentServiceOptions = {}): Promise<LocalTentService> {
  const dataDir = options.dataDir ?? defaultServiceDataDir();
  const version = options.version ?? SERVICE_VERSION;
  const startedAt = new Date().toISOString();
  const getPid = options.getPid ?? (() => process.pid);

  const events = new EventBus();
  const mutations = new MutationBus();
  const workspaceHost = new WorkspaceHost({ events });

  const ctx: HandlerContext = {
    host: workspaceHost,
    mutations,
    events,
    version,
    startedAt,
    getPid,
  };

  const httpServer: ServiceHttpServer = await createServiceHttpServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    ctx,
    events,
  });

  let endpoint: ServiceEndpointRecord | null = null;
  if (options.writeEndpoint !== false) {
    endpoint = {
      pid: getPid(),
      host: httpServer.host,
      port: httpServer.port,
      startedAt,
      version,
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
    events,
    hostApi: workspaceHost,
    ctx,
    endpoint,
    stop,
  };
}
