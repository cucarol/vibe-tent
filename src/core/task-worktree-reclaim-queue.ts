// Narrow pending-reclaim queue for terminal Task worktree GC.
// Only entries enqueued by this feature's terminal transitions are retried on
// restart — never infer opt-in from historical terminal Task envelopes.

import type { FsAdapter } from "./adapter.js";
import { TEMP_DIR } from "./paths.js";
import { join } from "./tree.js";

/** Relative to tent system root (FsAdapter root). */
export const TASK_WORKTREE_RECLAIM_PENDING_PATH = join(
  TEMP_DIR,
  "task-worktree-reclaim-pending.json"
);

export type TaskWorktreeReclaimPendingEntry = {
  taskId: string;
  taskPath: string;
  workspaceRoot: string;
  enqueuedAt: string;
  /** Last terminal transition that requested reclaim (diagnostic only). */
  trigger?: string;
};

type PendingFile = {
  version: 1;
  entries: TaskWorktreeReclaimPendingEntry[];
};

/**
 * Per-FsAdapter FIFO critical section for queue RMW.
 * WeakMap keys are adapter identity only — unrelated workspaces/adapters do not
 * share a chain (no process-wide bottleneck). Same pattern as in-process stores.
 */
const queueChains = new WeakMap<object, Promise<unknown>>();

function withQueueCriticalSection<T>(fs: FsAdapter, fn: () => Promise<T>): Promise<T> {
  const key = fs as object;
  const prev = queueChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  queueChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

function emptyFile(): PendingFile {
  return { version: 1, entries: [] };
}

async function readPending(fs: FsAdapter): Promise<PendingFile> {
  if (!(await fs.exists(TASK_WORKTREE_RECLAIM_PENDING_PATH))) {
    return emptyFile();
  }
  try {
    const raw = await fs.readFile(TASK_WORKTREE_RECLAIM_PENDING_PATH);
    const parsed = JSON.parse(raw) as PendingFile;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.entries)
    ) {
      return emptyFile();
    }
    const entries: TaskWorktreeReclaimPendingEntry[] = [];
    for (const e of parsed.entries) {
      if (
        e &&
        typeof e.taskId === "string" &&
        e.taskId.trim() &&
        typeof e.taskPath === "string" &&
        e.taskPath.trim() &&
        typeof e.workspaceRoot === "string" &&
        e.workspaceRoot.trim() &&
        typeof e.enqueuedAt === "string"
      ) {
        entries.push({
          taskId: e.taskId.trim(),
          taskPath: e.taskPath.trim(),
          workspaceRoot: e.workspaceRoot.trim(),
          enqueuedAt: e.enqueuedAt,
          ...(typeof e.trigger === "string" && e.trigger.trim()
            ? { trigger: e.trigger.trim() }
            : {}),
        });
      }
    }
    return { version: 1, entries };
  } catch {
    // Corrupt queue → fail closed to empty (do not mass-scan Tasks as fallback).
    return emptyFile();
  }
}

async function writePending(fs: FsAdapter, file: PendingFile): Promise<void> {
  const body = JSON.stringify({ version: 1, entries: file.entries }, null, 2) + "\n";
  // Ensure temp/ exists (FsAdapter may not create parents for free-form paths).
  if (!(await fs.exists(TEMP_DIR))) {
    await fs.writeFile(join(TEMP_DIR, ".keep"), "");
  }
  await fs.writeFile(TASK_WORKTREE_RECLAIM_PENDING_PATH, body);
}

/**
 * Record that this feature observed a terminal transition for a reclaimable lane.
 * Idempotent per taskId (latest path/trigger wins). Restart recovery only retries
 * these entries — never every historical terminal envelope.
 */
export async function enqueueTaskWorktreeReclaimPending(
  fs: FsAdapter,
  entry: {
    taskId: string;
    taskPath: string;
    workspaceRoot: string;
    enqueuedAt?: string;
    trigger?: string;
  }
): Promise<TaskWorktreeReclaimPendingEntry> {
  const taskId = entry.taskId.trim();
  const taskPath = entry.taskPath.trim();
  const workspaceRoot = entry.workspaceRoot.trim();
  if (!taskId || !taskPath || !workspaceRoot) {
    throw new Error("enqueueTaskWorktreeReclaimPending requires taskId, taskPath, workspaceRoot");
  }
  return withQueueCriticalSection(fs, async () => {
    const file = await readPending(fs);
    const next: TaskWorktreeReclaimPendingEntry = {
      taskId,
      taskPath,
      workspaceRoot,
      enqueuedAt: entry.enqueuedAt ?? new Date().toISOString(),
      ...(entry.trigger?.trim() ? { trigger: entry.trigger.trim() } : {}),
    };
    const without = file.entries.filter((e) => e.taskId !== taskId);
    without.push(next);
    without.sort((a, b) => a.taskId.localeCompare(b.taskId));
    await writePending(fs, { version: 1, entries: without });
    return next;
  });
}

/** Drop a pending entry after successful reclaim or permanent NOT_APPLICABLE. */
export async function dequeueTaskWorktreeReclaimPending(
  fs: FsAdapter,
  taskId: string
): Promise<boolean> {
  const id = taskId.trim();
  if (!id) return false;
  return withQueueCriticalSection(fs, async () => {
    const file = await readPending(fs);
    const next = file.entries.filter((e) => e.taskId !== id);
    if (next.length === file.entries.length) return false;
    await writePending(fs, { version: 1, entries: next });
    return true;
  });
}

/** Read-only list of pending reclaim entries (for mount recovery). */
export async function listTaskWorktreeReclaimPending(
  fs: FsAdapter
): Promise<TaskWorktreeReclaimPendingEntry[]> {
  return withQueueCriticalSection(fs, async () => {
    const file = await readPending(fs);
    return [...file.entries];
  });
}

/** Entries whose workspaceRoot matches the mounted root (path-normalized). */
export async function listTaskWorktreeReclaimPendingForWorkspace(
  fs: FsAdapter,
  workspaceRoot: string,
  sameRoot: (a: string, b: string) => boolean
): Promise<TaskWorktreeReclaimPendingEntry[]> {
  const root = workspaceRoot.trim();
  const all = await listTaskWorktreeReclaimPending(fs);
  return all.filter((e) => sameRoot(e.workspaceRoot, root));
}
