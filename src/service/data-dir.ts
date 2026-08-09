// Machine-local service data area (architecture §3.3). Not collaboration facts.

import * as fs from "node:fs/promises";
import { isIP } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { isNotFoundError } from "../machine-state.js";

export const MAX_SERVICE_ENDPOINT_CANDIDATES = 32;
export const MAX_SERVICE_ENDPOINT_FILE_BYTES = 16 * 1024;
const SERVICE_ENDPOINT_PREFIX = "service.endpoint.";
const SERVICE_ENDPOINT_SUFFIX = ".json";
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ServiceEndpointRecord {
  /** Exact Service-process ownership id; also names its immutable generation. */
  instanceId: string;
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

export function serviceEndpointPath(
  dataDir: string,
  instanceId: string,
  startedAt: string
): string {
  const generation = endpointGenerationName(instanceId, startedAt);
  return path.join(dataDir, generation);
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
  const validated = parseServiceEndpointRecord(record);
  if (!validated) throw new Error("Invalid Local Tent Service endpoint record");
  const file = serviceEndpointPath(dataDir, validated.instanceId, validated.startedAt);
  await fs.mkdir(dataDir, { recursive: true });
  const body = JSON.stringify(validated, null, 2) + "\n";
  if (Buffer.byteLength(body, "utf8") > MAX_SERVICE_ENDPOINT_FILE_BYTES) {
    throw new Error("Local Tent Service endpoint record exceeds the byte limit");
  }
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temp, body, { encoding: "utf8", flag: "wx" });
  try {
    // A hard link publishes a complete immutable generation and fails instead
    // of replacing an existing target. A Desktop-held older generation can
    // therefore never block a replacement Service from publishing its own.
    await fs.link(temp, file);
  } finally {
    try {
      await fs.rm(temp, { force: true });
    } catch {
      // A temp file never participates in discovery or Service ownership.
    }
  }
  void cleanupOverflowServiceEndpointGenerations(dataDir);
  return file;
}

export async function readServiceEndpoint(dataDir: string): Promise<ServiceEndpointRecord | null> {
  return (await readServiceEndpointCandidates(dataDir))[0] ?? null;
}

/**
 * Return at most the newest bounded set of validated immutable generations.
 * The legacy mutable `service.json` singleton is intentionally not read.
 */
export async function readServiceEndpointCandidates(
  dataDir: string
): Promise<ServiceEndpointRecord[]> {
  const names = await newestEndpointGenerationNames(dataDir);
  const records: ServiceEndpointRecord[] = [];
  for (const name of names) {
    const file = path.join(dataDir, name);
    try {
      const raw = await readBoundedEndpointFile(file);
      if (raw === null) continue;
      const value = parseServiceEndpointRecord(JSON.parse(raw));
      if (!value || endpointGenerationName(value.instanceId, value.startedAt) !== name) {
        continue;
      }
      records.push(value);
    } catch (error) {
      if (isNotFoundError(error) || error instanceof SyntaxError) continue;
      // A locked/corrupt stale generation cannot block discovery of newer ones.
      continue;
    }
  }
  return records;
}

export async function removeServiceEndpoint(
  dataDir: string,
  expected: Pick<ServiceEndpointRecord, "instanceId" | "startedAt">
): Promise<void> {
  try {
    await fs.rm(
      serviceEndpointPath(dataDir, expected.instanceId, expected.startedAt),
      { force: true }
    );
  } catch {
    // Exact-owner cleanup is best-effort. A locked old generation must not
    // affect the live Service or any later replacement generation.
  }
}

export function parseServiceEndpointRecord(value: unknown): ServiceEndpointRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Partial<ServiceEndpointRecord>;
  if (
    typeof data.instanceId !== "string" ||
    !INSTANCE_ID_PATTERN.test(data.instanceId) ||
    !Number.isInteger(data.pid) ||
    (data.pid ?? 0) <= 0 ||
    !Number.isInteger(data.port) ||
    (data.port ?? 0) <= 0 ||
    (data.port ?? 0) > 65535 ||
    typeof data.host !== "string" ||
    !isLoopbackServiceHost(data.host) ||
    typeof data.startedAt !== "string" ||
    !isCanonicalServiceStartedAt(data.startedAt) ||
    typeof data.version !== "string" ||
    (data.token !== undefined && typeof data.token !== "string")
  ) {
    return null;
  }
  return data as ServiceEndpointRecord;
}

function endpointGenerationName(instanceId: string, startedAt: string): string {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error("Invalid Local Tent Service instance id");
  }
  if (!isCanonicalServiceStartedAt(startedAt)) {
    throw new Error("Invalid Local Tent Service startedAt");
  }
  const startedMs = Date.parse(startedAt);
  return `${SERVICE_ENDPOINT_PREFIX}${Math.trunc(startedMs)
    .toString()
    .padStart(16, "0")}.${instanceId}${SERVICE_ENDPOINT_SUFFIX}`;
}

function isCanonicalServiceStartedAt(value: string): boolean {
  const startedMs = Date.parse(value);
  return (
    Number.isFinite(startedMs) &&
    startedMs >= 0 &&
    new Date(startedMs).toISOString() === value
  );
}

async function newestEndpointGenerationNames(dataDir: string): Promise<string[]> {
  const newest: string[] = [];
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    directory = await fs.opendir(dataDir);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  for await (const entry of directory) {
    if (!entry.isFile() || !isEndpointGenerationName(entry.name)) continue;
    const insertAt = newest.findIndex((name) => entry.name > name);
    if (insertAt < 0) newest.push(entry.name);
    else newest.splice(insertAt, 0, entry.name);
    if (newest.length > MAX_SERVICE_ENDPOINT_CANDIDATES) newest.pop();
  }
  return newest;
}

function isEndpointGenerationName(name: string): boolean {
  if (!name.startsWith(SERVICE_ENDPOINT_PREFIX) || !name.endsWith(SERVICE_ENDPOINT_SUFFIX)) {
    return false;
  }
  const middle = name.slice(SERVICE_ENDPOINT_PREFIX.length, -SERVICE_ENDPOINT_SUFFIX.length);
  const separator = middle.indexOf(".");
  if (separator <= 0) return false;
  const timestamp = middle.slice(0, separator);
  const instanceId = middle.slice(separator + 1);
  return /^\d{16}$/.test(timestamp) && INSTANCE_ID_PATTERN.test(instanceId);
}

async function readBoundedEndpointFile(file: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.allocUnsafe(MAX_SERVICE_ENDPOINT_FILE_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        used,
        buffer.length - used,
        null
      );
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used === 0 || used > MAX_SERVICE_ENDPOINT_FILE_BYTES) return null;
    return buffer.subarray(0, used).toString("utf8");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function cleanupOverflowServiceEndpointGenerations(dataDir: string): Promise<void> {
  try {
    const newest: string[] = [];
    const directory = await fs.opendir(dataDir);
    for await (const entry of directory) {
      if (!entry.isFile() || !isEndpointGenerationName(entry.name)) continue;
      const insertAt = newest.findIndex((name) => entry.name > name);
      if (insertAt < 0) {
        if (newest.length >= MAX_SERVICE_ENDPOINT_CANDIDATES) {
          await fs.rm(path.join(dataDir, entry.name), { force: true }).catch(() => undefined);
        } else {
          newest.push(entry.name);
        }
        continue;
      }
      newest.splice(insertAt, 0, entry.name);
      if (newest.length > MAX_SERVICE_ENDPOINT_CANDIDATES) {
        const overflow = newest.pop();
        if (overflow) {
          await fs.rm(path.join(dataDir, overflow), { force: true }).catch(() => undefined);
        }
      }
    }
  } catch {
    // Overflow cleanup is best-effort; locked stale generations never block startup.
  }
}
