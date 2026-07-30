// Discover / bootstrap Local Tent Service for desktop shell (architecture §2).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  defaultServiceDataDir,
  readServiceEndpoint,
  serviceBaseUrl,
  type ServiceEndpointRecord,
} from "../../service/data-dir.js";
import {
  assertServiceProtocolCompatible,
  isServiceProtocolCompatible,
} from "../../service/protocol.js";
import { ServiceRpcClient } from "./rpc-client.js";

export type AttachResult = {
  url: string;
  endpoint: ServiceEndpointRecord;
  /** True when this attach path started a new service process. */
  started: boolean;
  client: ServiceRpcClient;
  /** Child handle when we spawned the service (null if attached to existing). */
  child: ChildProcess | null;
};

export type AttachOptions = {
  dataDir?: string;
  /** Path to service.mjs or tent-service entry. */
  serviceEntry?: string;
  /** Max wait for health after spawn (ms). */
  readyTimeoutMs?: number;
  /** Poll interval while waiting (ms). */
  pollMs?: number;
  fetchImpl?: typeof fetch;
  spawnFn?: typeof spawn;
  /** When true, do not spawn — only attach to existing. */
  attachOnly?: boolean;
  env?: NodeJS.ProcessEnv;
};

/**
 * Attach to a healthy Local Tent Service, or bootstrap one if missing.
 * Desktop main owns discover/start; renderer never spawns service.
 */
export async function attachOrStartService(options: AttachOptions = {}): Promise<AttachResult> {
  const dataDir = options.dataDir ?? defaultServiceDataDir(options.env);
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 200;
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnFn = options.spawnFn ?? spawn;

  const existing = await tryAttach(dataDir, fetchImpl);
  if (existing) {
    return { ...existing, started: false, child: null };
  }
  await rejectIncompatibleHealthyService(dataDir, fetchImpl);

  if (options.attachOnly) {
    throw new Error(`No healthy Local Tent Service endpoint in ${dataDir}`);
  }

  const entry = options.serviceEntry ?? (await resolveDefaultServiceEntry());
  // Prefer node for .mjs; tsx/node for .ts. Always use absolute entry path.
  const entryAbs = path.resolve(entry);
  const child = spawnFn(process.execPath, [entryAbs, "start", "--data-dir", dataDir], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: serviceChildEnv(options.env, dataDir),
    windowsHide: true,
    cwd: path.dirname(entryAbs),
  });

  let spawnLog = "";
  child.stdout?.on("data", (c: Buffer) => {
    spawnLog += c.toString("utf8");
  });
  child.stderr?.on("data", (c: Buffer) => {
    spawnLog += c.toString("utf8");
  });
  child.on("error", (err) => {
    spawnLog += String(err);
  });

  // Detach so closing Electron does not kill the service.
  child.unref();

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    const attached = await tryAttach(dataDir, fetchImpl);
    if (attached) {
      // Close pipes after attach so we don't hold the child.
      child.stdout?.destroy();
      child.stderr?.destroy();
      return { ...attached, started: true, child };
    }
    await sleep(pollMs);
  }

  if (child.exitCode !== null && child.exitCode !== 0) {
    throw new Error(
      `Local Tent Service exited before an endpoint became healthy ` +
        `(code=${child.exitCode}). entry=${entryAbs}\n${spawnLog}`
    );
  }
  throw new Error(
    `Timed out waiting for Local Tent Service after spawn (entry=${entryAbs}, dataDir=${dataDir})\n${spawnLog}`
  );
}

export function serviceChildEnv(
  overrides: NodeJS.ProcessEnv | undefined,
  dataDir: string
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    TENT_SERVICE_DATA_DIR: dataDir,
    // The packaged runtime is Tent.exe (Electron), so opt into its Node mode
    // when spawning the standalone service entry.
    ELECTRON_RUN_AS_NODE: "1",
  };
}

export async function tryAttach(
  dataDir: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ url: string; endpoint: ServiceEndpointRecord; client: ServiceRpcClient } | null> {
  const endpoint = await readServiceEndpoint(dataDir);
  if (!endpoint) return null;
  // B5 loopback token is required for RPC/SSE; health stays open without it.
  if (!endpoint.token || typeof endpoint.token !== "string" || !endpoint.token.trim()) {
    return null;
  }
  const url = serviceBaseUrl(endpoint.host, endpoint.port);
  const client = new ServiceRpcClient({ baseUrl: url, token: endpoint.token, fetchImpl });
  try {
    const health = await client.health();
    if (health.status !== "ok") return null;
    assertServiceProtocolCompatible(health);
    return { url, endpoint, client };
  } catch (err) {
    if (err instanceof Error && /protocol/i.test(err.message)) {
      throw err;
    }
    return null;
  }
}

async function rejectIncompatibleHealthyService(
  dataDir: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const endpoint = await readServiceEndpoint(dataDir);
  if (!endpoint?.token || typeof endpoint.token !== "string" || !endpoint.token.trim()) {
    return;
  }
  const url = serviceBaseUrl(endpoint.host, endpoint.port);
  const client = new ServiceRpcClient({ baseUrl: url, token: endpoint.token, fetchImpl });
  try {
    const health = await client.health();
    if (health.status !== "ok") return;
    if (!isServiceProtocolCompatible(health)) {
      assertServiceProtocolCompatible(health);
    }
  } catch (err) {
    if (err instanceof Error && /protocol/i.test(err.message)) {
      throw err;
    }
  }
}

export async function resolveDefaultServiceEntry(cwd = process.cwd()): Promise<string> {
  const candidates = [
    path.join(cwd, "service.mjs"),
    path.join(cwd, "dist", "service.mjs"),
    path.join(cwd, "desktop", "service.mjs"),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* try next */
    }
  }
  // Fall back to source CLI via tsx when developing from repo root.
  const src = path.join(cwd, "src", "service", "cli.ts");
  try {
    await fs.access(src);
    return src;
  } catch {
    return path.join(cwd, "service.mjs");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
