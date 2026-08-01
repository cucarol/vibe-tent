// Narrow pending-reclaim queue for terminal Task worktree GC.
// Terminal transitions enqueue exact Task rows; exact session-settle or explicit
// reconcile retries those entries. This is not an inventory scanner.

import type { FsAdapter } from "./adapter.js";
import { TEMP_DIR } from "./paths.js";
import { join } from "./tree.js";

/** Relative to tent system root (FsAdapter root). */
export const TASK_WORKTREE_RECLAIM_PENDING_PATH = join(
  TEMP_DIR,
  "task-worktree-reclaim-pending.json"
);

export type TaskWorktreeReclaimEntryStatus = "pending" | "needs-attention";

/** Last refuse diagnostic persisted on a queue row (diagnosable, not UI). */
export type TaskWorktreeReclaimLastDiagnostic = {
  code: string;
  reason: string;
  /** ISO timestamp of the attempt that produced this diagnostic. */
  attemptedAt: string;
};

export type TaskWorktreeReclaimPendingEntry = {
  taskId: string;
  taskPath: string;
  workspaceRoot: string;
  enqueuedAt: string;
  /** Last terminal transition / explicit trigger that requested reclaim (diagnostic only). */
  trigger?: string;
  /**
   * `pending` — eligible for exact retry after the bound Session settles.
   * `needs-attention` — last attempt refused; kept for diagnosis until an
   * explicit exact-task reconcile or a new terminal observation retries it.
   * Missing on legacy rows reads as `pending`.
   */
  status?: TaskWorktreeReclaimEntryStatus;
  /** Present when status is needs-attention (or last refuse while still pending). */
  lastDiagnostic?: TaskWorktreeReclaimLastDiagnostic;
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

function parseLastDiagnostic(
  raw: unknown
): TaskWorktreeReclaimLastDiagnostic | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Task worktree reclaim diagnostic");
  }
  const d = raw as Record<string, unknown>;
  if (
    typeof d.code !== "string" ||
    !d.code.trim() ||
    typeof d.reason !== "string" ||
    typeof d.attemptedAt !== "string" ||
    !d.attemptedAt.trim()
  ) {
    throw new Error("Invalid Task worktree reclaim diagnostic");
  }
  return {
    code: d.code.trim(),
    reason: d.reason,
    attemptedAt: d.attemptedAt.trim(),
  };
}

function parseEntry(raw: unknown): TaskWorktreeReclaimPendingEntry {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Task worktree reclaim pending entry");
  }
  const e = raw as Record<string, unknown>;
  if (
    typeof e.taskId !== "string" ||
    !e.taskId.trim() ||
    typeof e.taskPath !== "string" ||
    !e.taskPath.trim() ||
    typeof e.workspaceRoot !== "string" ||
    !e.workspaceRoot.trim() ||
    typeof e.enqueuedAt !== "string"
  ) {
    throw new Error("Invalid Task worktree reclaim pending entry");
  }
  const statusRaw = e.status;
  if (
    statusRaw !== undefined &&
    statusRaw !== "needs-attention" &&
    statusRaw !== "pending"
  ) {
    throw new Error("Invalid Task worktree reclaim pending status");
  }
  const status: TaskWorktreeReclaimEntryStatus | undefined =
    statusRaw === "needs-attention" || statusRaw === "pending"
      ? statusRaw
      : undefined;
  const lastDiagnostic = parseLastDiagnostic(e.lastDiagnostic);
  return {
    taskId: e.taskId.trim(),
    taskPath: e.taskPath.trim(),
    workspaceRoot: e.workspaceRoot.trim(),
    enqueuedAt: e.enqueuedAt,
    ...(typeof e.trigger === "string" && e.trigger.trim()
      ? { trigger: e.trigger.trim() }
      : {}),
    ...(status ? { status } : {}),
    ...(lastDiagnostic ? { lastDiagnostic } : {}),
  };
}

async function readPending(fs: FsAdapter): Promise<PendingFile> {
  if (!(await fs.exists(TASK_WORKTREE_RECLAIM_PENDING_PATH))) {
    return emptyFile();
  }
  const raw = await fs.readFile(TASK_WORKTREE_RECLAIM_PENDING_PATH);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid Task worktree reclaim queue JSON");
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("Invalid Task worktree reclaim queue schema");
  }
  const entries = parsed.entries.map(parseEntry);
  const seenTaskIds = new Set<string>();
  for (const entry of entries) {
    if (seenTaskIds.has(entry.taskId)) {
      throw new Error(
        `Duplicate Task worktree reclaim pending entry ${entry.taskId}`
      );
    }
    seenTaskIds.add(entry.taskId);
  }
  return { version: 1, entries };
}

async function writePending(fs: FsAdapter, file: PendingFile): Promise<void> {
  const bodyObj: Record<string, unknown> = {
    version: 1,
    entries: file.entries,
  };
  const body = JSON.stringify(bodyObj, null, 2) + "\n";
  // Ensure temp/ exists (FsAdapter may not create parents for free-form paths).
  if (!(await fs.exists(TEMP_DIR))) {
    await fs.writeFile(join(TEMP_DIR, ".keep"), "");
  }
  await fs.writeFile(TASK_WORKTREE_RECLAIM_PENDING_PATH, body);
}

/**
 * Record that this feature observed a terminal transition for a reclaimable lane.
 * Idempotent per taskId (latest path/trigger wins; clears needs-attention so a
 * fresh terminal observation can retry). Rows survive restart for explicit
 * exact-task reconciliation; startup never scans or consumes them.
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
      status: "pending",
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

/**
 * Persist a refuse diagnostic on an existing (or create thin) queue row.
 * Sets status=needs-attention. Serialized RMW. Does not remove the row.
 */
export async function recordTaskWorktreeReclaimNeedsAttention(
  fs: FsAdapter,
  input: {
    taskId: string;
    taskPath: string;
    workspaceRoot: string;
    code: string;
    reason: string;
    attemptedAt?: string;
    trigger?: string;
  }
): Promise<TaskWorktreeReclaimPendingEntry | undefined> {
  const taskId = input.taskId.trim();
  const taskPath = input.taskPath.trim();
  const workspaceRoot = input.workspaceRoot.trim();
  const code = input.code.trim();
  if (!taskId || !taskPath || !workspaceRoot || !code) return undefined;
  const attemptedAt = input.attemptedAt ?? new Date().toISOString();
  const lastDiagnostic: TaskWorktreeReclaimLastDiagnostic = {
    code,
    reason: input.reason,
    attemptedAt,
  };
  return withQueueCriticalSection(fs, async () => {
    const file = await readPending(fs);
    const existing = file.entries.find((e) => e.taskId === taskId);
    const next: TaskWorktreeReclaimPendingEntry = {
      taskId,
      taskPath: existing?.taskPath ?? taskPath,
      workspaceRoot: existing?.workspaceRoot ?? workspaceRoot,
      enqueuedAt: existing?.enqueuedAt ?? attemptedAt,
      ...(existing?.trigger || input.trigger?.trim()
        ? { trigger: (input.trigger?.trim() || existing?.trigger)! }
        : {}),
      status: "needs-attention",
      lastDiagnostic,
    };
    const without = file.entries.filter((e) => e.taskId !== taskId);
    without.push(next);
    without.sort((a, b) => a.taskId.localeCompare(b.taskId));
    await writePending(fs, { version: 1, entries: without });
    return next;
  });
}

/** Read-only list of exact pending reclaim entries. */
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

/**
 * Test/helper: replace entire queue file under the critical section.
 * Production paths use finer-grained exact-entry APIs.
 */
export async function replaceTaskWorktreeReclaimQueueForTests(
  fs: FsAdapter,
  file: {
    entries?: TaskWorktreeReclaimPendingEntry[];
  }
): Promise<void> {
  return withQueueCriticalSection(fs, async () => {
    await writePending(fs, {
      version: 1,
      entries: file.entries ?? [],
    });
  });
}
