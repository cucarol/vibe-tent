// Machine-local service data area (architecture §3.3). Not collaboration facts.

import * as fs from "node:fs/promises";
import { isIP } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { isNotFoundError, writeJsonAtomic } from "../machine-state.js";

export interface ServiceEndpointRecord {
  /** Service-process ownership id; absent only in legacy endpoint files. */
  instanceId?: string;
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  version: string;
  token?: string;
}

export function defaultServiceDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TENT_SERVICE_DATA_DIR) return path.resolve(env.TENT_SERVICE_DATA_DIR);
  if (process.platform === "win32") {
    const base = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "Tent");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Tent");
  }
  const xdg = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdg, "tent");
}

export function serviceEndpointPath(dataDir: string): string {
  return path.join(dataDir, "service.json");
}

/** Build an HTTP base URL from a validated endpoint host (IPv6 needs brackets). */
export function serviceBaseUrl(host: string, port: number): string {
  const authorityHost = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${authorityHost}:${port}`;
}

/** Local Service discovery and listeners accept literal loopback IPs only. */
export function isLoopbackServiceHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith("127.");
  if (family === 6) {
    return normalized === "::1" || /^::ffff:127\./.test(normalized);
  }
  return false;
}

export async function writeServiceEndpoint(dataDir: string, record: ServiceEndpointRecord): Promise<string> {
  const file = serviceEndpointPath(dataDir);
  await writeJsonAtomic(file, record);
  return file;
}

export async function readServiceEndpoint(dataDir: string): Promise<ServiceEndpointRecord | null> {
  const file = serviceEndpointPath(dataDir);
  try {
    const raw = await fs.readFile(file, "utf8");
    let data: ServiceEndpointRecord;
    try {
      data = JSON.parse(raw) as ServiceEndpointRecord;
    } catch {
      // Regeneratable endpoint — ignore malformed JSON without durable backup noise.
      return null;
    }
    if (
      !Number.isInteger(data.pid) ||
      data.pid <= 0 ||
      !Number.isInteger(data.port) ||
      data.port <= 0 ||
      data.port > 65535 ||
      typeof data.host !== "string" ||
      !isLoopbackServiceHost(data.host) ||
      typeof data.startedAt !== "string" ||
      typeof data.version !== "string" ||
      (data.token !== undefined && typeof data.token !== "string") ||
      (data.instanceId !== undefined &&
        (typeof data.instanceId !== "string" || !data.instanceId))
    ) {
      return null;
    }
    return data;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

export async function removeServiceEndpoint(
  dataDir: string,
  expectedInstanceId?: string
): Promise<void> {
  try {
    if (expectedInstanceId) {
      const endpoint = await readServiceEndpoint(dataDir);
      if (endpoint?.instanceId !== expectedInstanceId) return;
    }
    await fs.rm(serviceEndpointPath(dataDir), { force: true });
  } catch {
    // ignore
  }
}
