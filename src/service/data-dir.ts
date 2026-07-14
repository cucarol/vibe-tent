// Machine-local service data area (architecture §3.3). Not collaboration facts.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isNotFoundError, writeJsonAtomic } from "../machine-state.js";

export interface ServiceEndpointRecord {
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
    if (typeof data.pid !== "number" || typeof data.port !== "number" || typeof data.host !== "string") {
      return null;
    }
    return data;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

export async function removeServiceEndpoint(dataDir: string): Promise<void> {
  try {
    await fs.rm(serviceEndpointPath(dataDir), { force: true });
  } catch {
    // ignore
  }
}
