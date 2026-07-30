// Narrow pending-reclaim queue for terminal Task worktree GC.
// Terminal transitions enqueue exact Task rows; mount retries those entries.
// Compatible extension: one historical scan cursor + needs-attention diagnostics
// on the same file — never a second GC subsystem, never global worktree prune.

import type { FsAdapter } from "./adapter.js";
import { AGENT_PROFILES_TEMP_DIR, TEMP_DIR } from "./paths.js";
import { join } from "./tree.js";

/** Relative to tent system root (FsAdapter root). */
export const TASK_WORKTREE_RECLAIM_PENDING_PATH = join(
  TEMP_DIR,
  "task-worktree-reclaim-pending.json"
);

/**
 * Max Task envelope paths examined (and candidates considered) per historical
 * background batch. Exported for tests — keep small so mount stays non-blocking.
 */
export const TASK_WORKTREE_RECLAIM_HISTORICAL_BATCH_SIZE = 8;

export type TaskWorktreeReclaimEntryStatus = "pending" | "needs-attention";

/** Last refuse diagnostic persisted on a queue row (diagnosable, not UI). */
export type TaskWorktreeReclaimLastDiagnostic = {
  code: string;
  reason: string;
  /** ISO timestamp of the attempt that produced this diagnostic. */
  attemptedAt: string;
};

export type TaskWorktreeReclaimScanDecision = {
  taskPath: string;
  code: string;
  reason: string;
  /** ISO timestamp of the scan decision. */
  attemptedAt: string;
};

export type TaskWorktreeReclaimPendingEntry = {
  taskId: string;
  taskPath: string;
  workspaceRoot: string;
  enqueuedAt: string;
  /** Last terminal transition / scan trigger that requested reclaim (diagnostic only). */
  trigger?: string;
  /**
   * `pending` — eligible for retry on mount / settle / historical attempt.
   * `needs-attention` — last attempt refused; kept for diagnosis; same-boot
   * historical loop must not spin on it.
   * Missing on legacy rows reads as `pending`.
   */
  status?: TaskWorktreeReclaimEntryStatus;
  /** Present when status is needs-attention (or last refuse while still pending). */
  lastDiagnostic?: TaskWorktreeReclaimLastDiagnostic;
};

/**
 * One historical inventory pass cursor (deterministic taskPath order).
 * Absent / incomplete → scan not finished. Corrupt parse never invents complete.
 */
export type TaskWorktreeReclaimHistoricalScan = {
  /** True only after a full pass over stable taskPath order completed. */
  complete: boolean;
  /**
   * Exclusive resume cursor: next batch examines paths with
   * `path.localeCompare(nextTaskPath) > 0`. Absent → start from the beginning.
   */
  nextTaskPath?: string;
  /** Workspace root the cursor was advanced for (diagnostic / multi-root filter). */
  workspaceRoot?: string;
  /**
   * Latest bounded scan decision/diagnostic only. The cursor and queue rows are
   * the durable coverage proof; this never grows into a historical log.
   */
  lastDecision?: TaskWorktreeReclaimScanDecision;
};

type PendingFile = {
  version: 1;
  entries: TaskWorktreeReclaimPendingEntry[];
  historicalScan?: TaskWorktreeReclaimHistoricalScan;
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

function parseScanDecision(
  raw: unknown
): TaskWorktreeReclaimScanDecision | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Task worktree reclaim scan decision");
  }
  const d = raw as Record<string, unknown>;
  if (
    typeof d.taskPath !== "string" ||
    !d.taskPath.trim() ||
    typeof d.code !== "string" ||
    !d.code.trim() ||
    typeof d.reason !== "string" ||
    typeof d.attemptedAt !== "string" ||
    !d.attemptedAt.trim()
  ) {
    throw new Error("Invalid Task worktree reclaim scan decision");
  }
  return {
    taskPath: d.taskPath.trim(),
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

/**
 * Parse historical scan. Fail-closed: never invent `complete: true` from garbage.
 * Unknown / partial shapes → incomplete (resume from start or known cursor only).
 */
function parseHistoricalScan(
  raw: unknown
): TaskWorktreeReclaimHistoricalScan | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Task worktree reclaim historical scan");
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.complete !== "boolean") {
    throw new Error("Invalid Task worktree reclaim historical completion");
  }
  const lastDecision = parseScanDecision(s.lastDecision);
  if (
    s.workspaceRoot !== undefined &&
    (typeof s.workspaceRoot !== "string" || !s.workspaceRoot.trim())
  ) {
    throw new Error("Invalid Task worktree reclaim historical workspace");
  }
  if (
    s.nextTaskPath !== undefined &&
    (typeof s.nextTaskPath !== "string" || !s.nextTaskPath.trim())
  ) {
    throw new Error("Invalid Task worktree reclaim historical cursor");
  }
  if (s.complete === true) {
    return {
      complete: true,
      ...(typeof s.workspaceRoot === "string" && s.workspaceRoot.trim()
        ? { workspaceRoot: s.workspaceRoot.trim() }
        : {}),
      ...(lastDecision ? { lastDecision } : {}),
    };
  }
  const next =
    typeof s.nextTaskPath === "string" && s.nextTaskPath.trim()
      ? s.nextTaskPath.trim()
      : undefined;
  return {
    complete: false,
    ...(next ? { nextTaskPath: next } : {}),
    ...(typeof s.workspaceRoot === "string" && s.workspaceRoot.trim()
      ? { workspaceRoot: s.workspaceRoot.trim() }
      : {}),
    ...(lastDecision ? { lastDecision } : {}),
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
  const historicalScan = parseHistoricalScan(parsed.historicalScan);
  return {
    version: 1,
    entries,
    ...(historicalScan ? { historicalScan } : {}),
  };
}

async function writePending(fs: FsAdapter, file: PendingFile): Promise<void> {
  const bodyObj: Record<string, unknown> = {
    version: 1,
    entries: file.entries,
  };
  if (file.historicalScan) {
    bodyObj.historicalScan = {
      complete: file.historicalScan.complete === true,
      ...(file.historicalScan.nextTaskPath
        ? { nextTaskPath: file.historicalScan.nextTaskPath }
        : {}),
      ...(file.historicalScan.workspaceRoot
        ? { workspaceRoot: file.historicalScan.workspaceRoot }
        : {}),
      ...(file.historicalScan.lastDecision
        ? { lastDecision: file.historicalScan.lastDecision }
        : {}),
    };
  }
  const body = JSON.stringify(bodyObj, null, 2) + "\n";
  // Ensure temp/ exists (FsAdapter may not create parents for free-form paths).
  if (!(await fs.exists(TEMP_DIR))) {
    await fs.writeFile(join(TEMP_DIR, ".keep"), "");
  }
  await fs.writeFile(TASK_WORKTREE_RECLAIM_PENDING_PATH, body);
}

/**
 * List Task envelope paths under temp/ in stable localeCompare order.
 * Paths only — callers load envelopes per bounded batch.
 */
export async function listTaskEnvelopePathsForReclaimScan(
  fs: FsAdapter
): Promise<string[]> {
  const paths: string[] = [];
  if (!(await fs.exists(TEMP_DIR))) return paths;

  for (const entry of await fs.listDir(TEMP_DIR)) {
    if (!entry.isDir) continue;
    if (entry.name === AGENT_PROFILES_TEMP_DIR) {
      const profilesRoot = join(TEMP_DIR, AGENT_PROFILES_TEMP_DIR);
      if (!(await fs.exists(profilesRoot))) continue;
      for (const profileEntry of await fs.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        const taskDir = join(profilesRoot, profileEntry.name, "tasks");
        if (!(await fs.exists(taskDir))) continue;
        for (const f of await fs.listDir(taskDir)) {
          if (!f.isDir && f.name.endsWith(".md")) {
            paths.push(join(taskDir, f.name));
          }
        }
      }
      continue;
    }
    const taskDir = join(TEMP_DIR, entry.name, "tasks");
    if (!(await fs.exists(taskDir))) continue;
    for (const f of await fs.listDir(taskDir)) {
      if (!f.isDir && f.name.endsWith(".md")) {
        paths.push(join(taskDir, f.name));
      }
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

/** Paths strictly after the exclusive cursor (stable taskPath order). */
export function taskPathsAfterHistoricalCursor(
  allPaths: string[],
  nextTaskPath?: string
): string[] {
  if (!nextTaskPath) return [...allPaths];
  return allPaths.filter((p) => p.localeCompare(nextTaskPath) > 0);
}

/**
 * Record that this feature observed a terminal transition for a reclaimable lane.
 * Idempotent per taskId (latest path/trigger wins; clears needs-attention so a
 * fresh terminal observation can retry). Restart recovery retries these entries.
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
    await writePending(fs, {
      version: 1,
      entries: without,
      ...(file.historicalScan ? { historicalScan: file.historicalScan } : {}),
    });
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
    await writePending(fs, {
      version: 1,
      entries: next,
      ...(file.historicalScan ? { historicalScan: file.historicalScan } : {}),
    });
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
    await writePending(fs, {
      version: 1,
      entries: without,
      ...(file.historicalScan ? { historicalScan: file.historicalScan } : {}),
    });
    return next;
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

/** Read historical scan cursor/completion (serialized). */
export async function readTaskWorktreeReclaimHistoricalScan(
  fs: FsAdapter
): Promise<TaskWorktreeReclaimHistoricalScan | undefined> {
  return withQueueCriticalSection(fs, async () => {
    const file = await readPending(fs);
    return file.historicalScan ? { ...file.historicalScan } : undefined;
  });
}

export type HistoricalScanBatchPersistInput = {
  workspaceRoot: string;
  /**
   * Envelope paths examined this batch, in stable order (length ≤ batch size).
   * Last path becomes the exclusive resume cursor when the batch is non-empty.
   */
  examinedTaskPaths: string[];
  /** Eligible candidates discovered in this batch (idempotent merge by taskId). */
  newCandidates: Array<{
    taskId: string;
    taskPath: string;
    workspaceRoot: string;
    enqueuedAt?: string;
    trigger?: string;
  }>;
  /**
   * Permanent non-candidate decisions for examined paths. Every examined path
   * must be proven by either an exact candidate row or one of these decisions.
   */
  decisions?: TaskWorktreeReclaimScanDecision[];
  /** True when no further paths remain after examinedTaskPaths. */
  scanComplete: boolean;
};

export type HistoricalScanBatchPersistResult = {
  historicalScan: TaskWorktreeReclaimHistoricalScan;
  /** Candidates newly added or refreshed to pending this write. */
  enqueued: TaskWorktreeReclaimPendingEntry[];
  entries: TaskWorktreeReclaimPendingEntry[];
};

/**
 * Atomically persist newly discovered historical candidates + advanced cursor.
 * Crash between batches cannot skip: uncommitted cursor means re-examine the
 * same window; committed cursor never jumps past unpersisted candidates.
 */
export async function persistHistoricalReclaimScanBatch(
  fs: FsAdapter,
  input: HistoricalScanBatchPersistInput
): Promise<HistoricalScanBatchPersistResult> {
  const workspaceRoot = input.workspaceRoot.trim();
  if (!workspaceRoot) {
    throw new Error("persistHistoricalReclaimScanBatch requires workspaceRoot");
  }
  return withQueueCriticalSection(fs, async () => {
    const file = await readPending(fs);
    // Already complete: idempotent no-op (do not re-open the pass).
    if (file.historicalScan?.complete === true) {
      return {
        historicalScan: { ...file.historicalScan },
        enqueued: [],
        entries: [...file.entries],
      };
    }

    const byId = new Map<string, TaskWorktreeReclaimPendingEntry>();
    for (const e of file.entries) {
      byId.set(e.taskId, e);
    }
    const enqueued: TaskWorktreeReclaimPendingEntry[] = [];
    const now = new Date().toISOString();
    const candidatesByPath = new Map<
      string,
      HistoricalScanBatchPersistInput["newCandidates"][number]
    >();
    const candidateTaskIds = new Set<string>();
    for (const c of input.newCandidates) {
      const taskId = c.taskId.trim();
      const taskPath = c.taskPath.trim();
      const root = (c.workspaceRoot || workspaceRoot).trim();
      if (!taskId || !taskPath || !root) {
        throw new Error("Invalid historical reclaim candidate");
      }
      if (candidatesByPath.has(taskPath) || candidateTaskIds.has(taskId)) {
        throw new Error("Duplicate historical reclaim candidate");
      }
      candidatesByPath.set(taskPath, c);
      candidateTaskIds.add(taskId);
      const existing = byId.get(taskId);
      // Already queued (pending or needs-attention): historical discovery must
      // not re-enqueue or re-spin. Terminal observation / mount / settle own
      // retry of existing rows.
      if (existing) {
        if (existing.taskPath !== taskPath) {
          throw new Error(
            `Historical reclaim candidate path mismatch for ${taskId}`
          );
        }
        continue;
      }
      const next: TaskWorktreeReclaimPendingEntry = {
        taskId,
        taskPath,
        workspaceRoot: root,
        enqueuedAt: c.enqueuedAt ?? now,
        ...(c.trigger?.trim()
          ? { trigger: c.trigger.trim() }
          : { trigger: "historical.scan" }),
        status: "pending",
      };
      byId.set(taskId, next);
      enqueued.push(next);
    }

    const entries = [...byId.values()].sort((a, b) =>
      a.taskId.localeCompare(b.taskId)
    );
    const examined = input.examinedTaskPaths
      .map((p) => p.trim())
      .filter(Boolean);
    if (examined.length > TASK_WORKTREE_RECLAIM_HISTORICAL_BATCH_SIZE) {
      throw new Error("Historical reclaim batch exceeds configured bound");
    }
    for (let i = 0; i < examined.length; i += 1) {
      if (
        !examined[i] ||
        (i > 0 && examined[i - 1].localeCompare(examined[i]) >= 0)
      ) {
        throw new Error("Historical reclaim examined paths must be unique and sorted");
      }
    }
    const decisions = (input.decisions ?? []).map((decision) => {
      const parsed = parseScanDecision(decision);
      if (!parsed) throw new Error("Invalid historical reclaim scan decision");
      return parsed;
    });
    const decisionsByPath = new Map(decisions.map((d) => [d.taskPath, d]));
    if (decisionsByPath.size !== decisions.length) {
      throw new Error("Duplicate historical reclaim scan decision");
    }
    const examinedSet = new Set(examined);
    for (const candidatePath of candidatesByPath.keys()) {
      if (!examinedSet.has(candidatePath)) {
        throw new Error(
          `Historical reclaim candidate was not examined: ${candidatePath}`
        );
      }
    }
    for (const decision of decisions) {
      if (decision.code !== "NOT_APPLICABLE") {
        throw new Error(
          `Historical reclaim cursor decision must be NOT_APPLICABLE: ${decision.taskPath}`
        );
      }
      if (!examinedSet.has(decision.taskPath)) {
        throw new Error(
          `Historical reclaim decision was not examined: ${decision.taskPath}`
        );
      }
    }
    for (const taskPath of examined) {
      const candidate = candidatesByPath.get(taskPath);
      const hasExistingCandidate =
        candidate !== undefined && byId.has(candidate.taskId.trim());
      const hasDecision = decisionsByPath.has(taskPath);
      if (hasExistingCandidate === hasDecision) {
        throw new Error(
          `Historical reclaim cursor proof missing or ambiguous for ${taskPath}`
        );
      }
    }
    const latestDecision = decisions.at(-1) ?? file.historicalScan?.lastDecision;
    let historicalScan: TaskWorktreeReclaimHistoricalScan;
    if (input.scanComplete) {
      historicalScan = {
        complete: true,
        workspaceRoot,
        ...(latestDecision ? { lastDecision: latestDecision } : {}),
      };
    } else if (examined.length > 0) {
      historicalScan = {
        complete: false,
        nextTaskPath: examined[examined.length - 1],
        workspaceRoot,
        ...(latestDecision ? { lastDecision: latestDecision } : {}),
      };
    } else {
      // Empty batch without complete is a no-op cursor advance (should not happen).
      historicalScan = file.historicalScan
        ? { ...file.historicalScan, workspaceRoot }
        : { complete: false, workspaceRoot };
    }

    await writePending(fs, { version: 1, entries, historicalScan });
    return { historicalScan, enqueued, entries };
  });
}

/**
 * Persist one bounded scanner diagnostic without advancing the cursor. Used
 * when a path cannot be classified safely (for example an unreadable envelope).
 */
export async function recordHistoricalReclaimScanDiagnostic(
  fs: FsAdapter,
  input: {
    workspaceRoot: string;
    taskPath: string;
    code: string;
    reason: string;
    attemptedAt?: string;
  }
): Promise<TaskWorktreeReclaimHistoricalScan> {
  const workspaceRoot = input.workspaceRoot.trim();
  const taskPath = input.taskPath.trim();
  const code = input.code.trim();
  if (!workspaceRoot || !taskPath || !code) {
    throw new Error("Invalid historical reclaim scan diagnostic");
  }
  return withQueueCriticalSection(fs, async () => {
    const file = await readPending(fs);
    const historicalScan: TaskWorktreeReclaimHistoricalScan = {
      complete: false,
      ...(file.historicalScan?.nextTaskPath
        ? { nextTaskPath: file.historicalScan.nextTaskPath }
        : {}),
      workspaceRoot,
      lastDecision: {
        taskPath,
        code,
        reason: input.reason,
        attemptedAt: input.attemptedAt ?? new Date().toISOString(),
      },
    };
    await writePending(fs, {
      version: 1,
      entries: file.entries,
      historicalScan,
    });
    return historicalScan;
  });
}

/**
 * Test/helper: replace entire queue file under the critical section.
 * Production historical/terminal paths use finer-grained APIs.
 */
export async function replaceTaskWorktreeReclaimQueueForTests(
  fs: FsAdapter,
  file: {
    entries?: TaskWorktreeReclaimPendingEntry[];
    historicalScan?: TaskWorktreeReclaimHistoricalScan;
  }
): Promise<void> {
  return withQueueCriticalSection(fs, async () => {
    await writePending(fs, {
      version: 1,
      entries: file.entries ?? [],
      ...(file.historicalScan ? { historicalScan: file.historicalScan } : {}),
    });
  });
}
