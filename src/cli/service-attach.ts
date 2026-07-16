// CLI-side Local Service attach / bootstrap (architecture §1 / §8 B4).
// No Electron dependency. Token stays machine-local (service.json); never workspace.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  defaultServiceDataDir,
  readServiceEndpoint,
  type ServiceEndpointRecord,
} from "../service/data-dir.js";
import { createServiceClient, type ServiceClient } from "../service/client.js";

export type CliAttachResult = {
  url: string;
  endpoint: ServiceEndpointRecord;
  /** True when this attach path started a new service process. */
  started: boolean;
  client: ServiceClient;
  /** Child handle when we spawned the service (null if attached to existing). */
  child: ChildProcess | null;
  dataDir: string;
};

export type CliAttachOptions = {
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
  /** Package / repo root hint for resolving service.mjs. */
  packageRoot?: string;
};

/**
 * Attach to a healthy Local Tent Service, or bootstrap one if missing.
 * CLI must not kill the service when the short-lived process exits.
 */
export async function attachOrBootstrapService(
  options: CliAttachOptions = {}
): Promise<CliAttachResult> {
  const dataDir = options.dataDir ?? defaultServiceDataDir(options.env);
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 200;
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnFn = options.spawnFn ?? spawn;

  const existing = await tryAttachService(dataDir, fetchImpl);
  if (existing) {
    return { ...existing, started: false, child: null, dataDir };
  }

  if (options.attachOnly) {
    throw new Error(
      `No healthy Local Tent Service endpoint in ${dataDir}. ` +
        `Start tent-service, or omit --attach-only to let CLI bootstrap one.`
    );
  }

  const entry = options.serviceEntry ?? (await resolveDefaultServiceEntry(options.packageRoot));
  const entryAbs = path.resolve(entry);
  const child = spawnFn(process.execPath, [entryAbs, "start", "--data-dir", dataDir], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: cliServiceChildEnv(options.env, dataDir),
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

  // Detach so CLI exit does not kill the service.
  child.unref();

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    const attached = await tryAttachService(dataDir, fetchImpl);
    if (attached) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      return { ...attached, started: true, child, dataDir };
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

export function cliServiceChildEnv(
  overrides: NodeJS.ProcessEnv | undefined,
  dataDir: string
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    TENT_SERVICE_DATA_DIR: dataDir,
    // Harmless for plain Node; required when parent is Electron-as-node.
    ELECTRON_RUN_AS_NODE: "1",
  };
}

/**
 * Read machine-local endpoint + token; probe /health.
 * Returns null when missing, unhealthy, or token absent.
 */
export async function tryAttachService(
  dataDir: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ url: string; endpoint: ServiceEndpointRecord; client: ServiceClient } | null> {
  const endpoint = await readServiceEndpoint(dataDir);
  if (!endpoint) return null;
  if (!endpoint.token || typeof endpoint.token !== "string" || !endpoint.token.trim()) {
    return null;
  }
  const url = `http://${endpoint.host}:${endpoint.port}`;
  const client = createServiceClient({ baseUrl: url, token: endpoint.token, fetchImpl });
  try {
    const health = (await client.health()) as { status?: string };
    if (health.status !== "ok") return null;
    return { url, endpoint, client };
  } catch {
    return null;
  }
}

export async function resolveDefaultServiceEntry(packageRootHint?: string): Promise<string> {
  const roots: string[] = [];
  if (packageRootHint) roots.push(packageRootHint);
  roots.push(process.cwd());
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/cli → repo root; bundled cli.mjs → package root
    if (path.basename(here) === "cli" && path.basename(path.dirname(here)) === "src") {
      roots.push(path.resolve(here, "../.."));
    } else {
      roots.push(here);
    }
  } catch {
    // ignore
  }

  const relativeCandidates = [
    "service.mjs",
    path.join("dist", "service.mjs"),
    path.join("desktop", "service.mjs"),
    path.join("src", "service", "cli.ts"),
  ];

  for (const root of roots) {
    for (const rel of relativeCandidates) {
      const candidate = path.join(root, rel);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return path.join(roots[0] ?? process.cwd(), "service.mjs");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
