// Cross-process Tent mutation.lock with ownership tokens.
// Release only removes a lock file that still carries this holder's token,
// so a stale reclaim by another process cannot be undone by the old holder.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

/** Lock older than this may be reclaimed (mtime-based). */
export const MUTATION_LOCK_STALE_MS = 120_000;

export interface MutationLockRecord {
  ownerToken: string;
  pid: number;
  createdAt: string;
}

export interface WithFileMutationLockOptions {
  /** Busy error when a non-stale lock is held. */
  busyMessage: string;
  /** Thrown when acquire fails after reclaim attempts. */
  acquireFailedMessage: string;
  /** Override for tests. */
  now?: () => number;
  /** Override for tests. */
  makeOwnerToken?: () => string;
  /** Stale threshold in ms (default 120s). */
  staleMs?: number;
}

/**
 * Acquire `lockPath` with `wx`, run `action`, release only if ownership matches.
 * Stale reclaim uses rename (not blind delete) so contenders never share a path.
 */
export async function withFileMutationLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: WithFileMutationLockOptions
): Promise<T> {
  const now = options.now ?? Date.now;
  const makeOwnerToken = options.makeOwnerToken ?? randomUUID;
  const staleMs = options.staleMs ?? MUTATION_LOCK_STALE_MS;
  const ownerToken = makeOwnerToken();
  const record: MutationLockRecord = {
    ownerToken,
    pid: process.pid,
    createdAt: new Date(now()).toISOString(),
  };

  await fs.mkdir(dirnameOf(lockPath), { recursive: true });

  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      handle = await fs.open(lockPath, "wx");
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const stale = await isStaleLockFile(lockPath, now, staleMs);
      if (!stale || attempt >= 2) {
        throw new Error(options.busyMessage);
      }
      // Quarantine then retry; only one contender wins the rename.
      const quarantine = `${lockPath}.stale-${randomUUID()}`;
      try {
        await fs.rename(lockPath, quarantine);
        await fs.rm(quarantine, { force: true }).catch(() => undefined);
      } catch (renameError) {
        if (isNotFound(renameError)) continue;
        throw renameError;
      }
    }
  }
  if (!handle) throw new Error(options.acquireFailedMessage);

  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await releaseMutationLockIfOwned(lockPath, ownerToken);
  }
}

/** Remove lock only when the on-disk ownerToken still matches this holder. */
export async function releaseMutationLockIfOwned(
  lockPath: string,
  ownerToken: string
): Promise<boolean> {
  const current = await readMutationLockRecord(lockPath);
  if (!current || current.ownerToken !== ownerToken) {
    return false;
  }
  try {
    await fs.rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function readMutationLockRecord(
  lockPath: string
): Promise<MutationLockRecord | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const value = JSON.parse(raw) as Partial<MutationLockRecord>;
    if (
      typeof value.ownerToken !== "string" ||
      !value.ownerToken ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      typeof value.createdAt !== "string"
    ) {
      return null;
    }
    return value as MutationLockRecord;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    return null;
  }
}

async function isStaleLockFile(
  lockPath: string,
  now: () => number,
  staleMs: number
): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    return now() - stat.mtimeMs > staleMs;
  } catch (error) {
    if (isNotFound(error)) return true;
    return true;
  }
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? "." : p.slice(0, i);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT";
}
