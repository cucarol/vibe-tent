// Process-level ownership for one machine-local service data directory.
// The lease contains diagnostics only; never endpoint tokens or credentials.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ServiceLeaseRecord {
  instanceId: string;
  pid: number;
  startedAt: string;
}

export interface ServiceDataDirLease extends ServiceLeaseRecord {
  path: string;
  release: () => Promise<void>;
}

export interface AcquireServiceLeaseOptions {
  pid?: number;
  now?: () => Date;
  makeInstanceId?: () => string;
  isProcessAlive?: (pid: number) => boolean;
}

export class ServiceDataDirBusyError extends Error {
  readonly owner: ServiceLeaseRecord;

  constructor(dataDir: string, owner: ServiceLeaseRecord) {
    super(
      `Local Tent Service data directory is already owned by pid ${owner.pid} ` +
        `(instance ${owner.instanceId}): ${dataDir}`
    );
    this.name = "ServiceDataDirBusyError";
    this.owner = owner;
  }
}

export function serviceLeasePath(dataDir: string): string {
  return path.join(dataDir, "service.lock");
}

/**
 * Acquire a complete-file lease atomically. A hard link publishes an already
 * written candidate, so contenders never observe a partially written owner.
 */
export async function acquireServiceDataDirLease(
  dataDir: string,
  options: AcquireServiceLeaseOptions = {}
): Promise<ServiceDataDirLease> {
  const pid = options.pid ?? process.pid;
  const instanceId = options.makeInstanceId?.() ?? randomUUID();
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const record: ServiceLeaseRecord = { instanceId, pid, startedAt };
  const lockPath = serviceLeasePath(dataDir);

  await fs.mkdir(dataDir, { recursive: true });
  const candidate = `${lockPath}.candidate-${instanceId}`;
  await fs.writeFile(candidate, JSON.stringify(record, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
  });

  try {
    for (;;) {
      try {
        await fs.link(candidate, lockPath);
        break;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;

        const owner = await readLeaseRecord(lockPath);
        if (owner && isProcessAlive(owner.pid)) {
          throw new ServiceDataDirBusyError(dataDir, owner);
        }

        // Reclaim stale or malformed state by rename. Exactly one contender can
        // move this path; losers retry and observe the winner's lease.
        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          await fs.rename(lockPath, stalePath);
          try {
            await fs.rm(stalePath, { force: true });
          } catch {
            // Quarantined stale diagnostics may remain; they do not own the lock.
          }
        } catch (error) {
          if (hasCode(error, "ENOENT")) continue;
          throw error;
        }
      }
    }
  } finally {
    try {
      await fs.rm(candidate, { force: true });
    } catch {
      // Candidate files never confer ownership; cleanup must not mask the
      // acquired lease or the live-owner error.
    }
  }

  let released = false;
  return {
    ...record,
    path: lockPath,
    release: async () => {
      if (released) return;
      const owner = await readLeaseRecord(lockPath);
      if (owner?.instanceId === instanceId) {
        await fs.rm(lockPath, { force: true });
      }
      released = true;
    },
  };
}

async function readLeaseRecord(file: string): Promise<ServiceLeaseRecord | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ServiceLeaseRecord>;
    if (
      typeof value.instanceId !== "string" ||
      !value.instanceId ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      typeof value.startedAt !== "string"
    ) {
      return null;
    }
    return value as ServiceLeaseRecord;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is definitively gone. Permission failures are conservatively live:
    // blocking startup is safer than two writers sharing machine state.
    return !hasCode(error, "ESRCH");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
