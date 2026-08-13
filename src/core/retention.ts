// Operational retention (task-api §6 MVP).
// Safe purge of terminal tasks + non-ready results; never touches active work.
// Paths are always under temp/<role>/{tasks,results}/ via FsAdapter — no free-form paths.

import { withTentMutation, type FsAdapter } from "./adapter.js";
import { loadTaskResult, type TaskResultRecord } from "./task-result.js";
import { collectReferencedTaskResultIds } from "./output.js";
import { loadTaskRecord, type TaskRecord } from "./task.js";
import {
  isActiveTaskState,
  TERMINAL_TASK_STATES,
  type TaskResultStatus,
  type TaskState,
} from "./task-model.js";
import { join, loadTent } from "./tree.js";

/** Default heat retention for terminal operational records (task-api §6). */
export const DEFAULT_KEEP_TERMINAL_DAYS = 30;

/** Inclusive upper bound for keepTerminalTasksDays (prevents unbounded retention params). */
export const MAX_KEEP_TERMINAL_DAYS = 3650;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const TERMINAL_RESULT_STATUSES: ReadonlySet<TaskResultStatus> = new Set([
  "accepted",
  "rejected",
]);

export type RetentionCandidateKind = "task-group" | "orphan-result";

export type RetentionCandidate = {
  kind: RetentionCandidateKind;
  /** Present for task-group candidates. */
  taskId?: string;
  taskPath?: string;
  taskState?: TaskState;
  /** TaskResult paths that would be removed with this candidate. */
  resultPaths: string[];
  /** Whole days since last activity (updatedAt || createdAt). */
  ageDays: number;
  reason: string;
};

export type RetentionSkipped = {
  path: string;
  reason: string;
};

export type RetentionOptions = {
  /**
   * Days to keep terminal operational records.
   * Default 30. `0` means immediately eligible (explicit test / cleanup).
   * Must be a non-negative integer ≤ MAX_KEEP_TERMINAL_DAYS.
   */
  keepTerminalTasksDays?: number;
  /** Override "now" for deterministic tests (ISO string or Date). */
  now?: string | Date;
};

export type RetentionPreviewResult = {
  keepTerminalTasksDays: number;
  cutoff: string;
  candidates: RetentionCandidate[];
  skipped: RetentionSkipped[];
  warnings: string[];
  /** Aggregate counts for clients. */
  candidateTaskCount: number;
  candidateTaskResultCount: number;
};

export type RetentionPurgeResult = RetentionPreviewResult & {
  purged: {
    taskPaths: string[];
    resultPaths: string[];
  };
  deletedCount: number;
};

export class RetentionError extends Error {
  code: "INVALID_KEEP_DAYS" | "PROVENANCE_PIN_SCAN_FAILED";
  constructor(code: "INVALID_KEEP_DAYS" | "PROVENANCE_PIN_SCAN_FAILED", message: string) {
    super(message);
    this.code = code;
    this.name = "RetentionError";
  }
}

/**
 * Normalize keepTerminalTasksDays: default 30, non-negative integer, bounded.
 */
export function normalizeKeepTerminalTasksDays(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_KEEP_TERMINAL_DAYS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new RetentionError(
      "INVALID_KEEP_DAYS",
      "keepTerminalTasksDays must be a non-negative integer"
    );
  }
  if (raw < 0) {
    throw new RetentionError(
      "INVALID_KEEP_DAYS",
      "keepTerminalTasksDays must be a non-negative integer"
    );
  }
  if (raw > MAX_KEEP_TERMINAL_DAYS) {
    throw new RetentionError(
      "INVALID_KEEP_DAYS",
      `keepTerminalTasksDays must be ≤ ${MAX_KEEP_TERMINAL_DAYS}`
    );
  }
  return raw;
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

export function isPurgeableTaskResultStatus(status: TaskResultStatus): boolean {
  return TERMINAL_RESULT_STATUSES.has(status);
}

/**
 * Preview terminal operational candidates. Read-only — never mutates disk.
 * Bad operational files stay on disk and appear in skipped/warnings.
 */
export async function previewOperationalRetention(
  fs: FsAdapter,
  options: RetentionOptions = {}
): Promise<RetentionPreviewResult> {
  const keepTerminalTasksDays = normalizeKeepTerminalTasksDays(options.keepTerminalTasksDays);
  const nowMs = resolveNowMs(options.now);
  const cutoffMs = nowMs - keepTerminalTasksDays * MS_PER_DAY;
  const cutoff = new Date(cutoffMs).toISOString();

  const skipped: RetentionSkipped[] = [];
  const warnings: string[] = [];

  const { tasks, skipped: taskSkipped } = await scanTasks(fs);
  skipped.push(...taskSkipped);
  const { results, skipped: resultSkipped } = await scanResults(fs);
  skipped.push(...resultSkipped);

  for (const s of skipped) {
    warnings.push(`skipped ${s.path}: ${s.reason}`);
  }

  const tasksById = new Map<string, TaskRecord>();
  const taskIdCounts = new Map<string, number>();
  for (const t of tasks) {
    if (t.id) {
      tasksById.set(t.id, t);
      taskIdCounts.set(t.id, (taskIdCounts.get(t.id) ?? 0) + 1);
    }
  }

  const resultsByTaskId = new Map<string, TaskResultRecord[]>();
  for (const d of results) {
    const list = resultsByTaskId.get(d.taskId) ?? [];
    list.push(d);
    resultsByTaskId.set(d.taskId, list);
  }

  const candidates: RetentionCandidate[] = [];
  const claimedTaskResultPaths = new Set<string>();

  // Output provenance pin: any live Output.resultId (including archived Outputs)
  // protects that TaskResult and its Task group. Not a general permanent history system.
  // Fail closed: if pin scan cannot load the tent, refuse all destructive selection
  // rather than purge without knowing which Results are still referenced.
  let pinnedTaskResultIds: Set<string>;
  try {
    const tent = await loadTent(fs);
    pinnedTaskResultIds = collectReferencedTaskResultIds(tent);
  } catch (err) {
    throw new RetentionError(
      "PROVENANCE_PIN_SCAN_FAILED",
      `Output provenance pin scan failed; refusing retention preview/purge: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  const pinnedTaskIds = new Set<string>();
  for (const d of results) {
    if (pinnedTaskResultIds.has(d.id) && d.taskId) pinnedTaskIds.add(d.taskId);
  }

  // 1) Terminal tasks past retention → purge as a group with their results.
  for (const task of tasks) {
    if (!isTerminalTaskState(task.state)) continue;
    if (isActiveTaskState(task.state)) continue; // belt-and-suspenders
    if (task.id && (taskIdCounts.get(task.id) ?? 0) > 1) {
      const message = `duplicate task id ${task.id}; refusing ambiguous retention group`;
      skipped.push({ path: task.path, reason: message });
      warnings.push(`skipped ${task.path}: ${message}`);
      continue;
    }

    const related = task.id ? resultsByTaskId.get(task.id) ?? [] : [];
    const activityValues = [taskActivityMs(task), ...related.map(resultActivityMs)];
    if (activityValues.some((value) => value === undefined)) {
      if (keepTerminalTasksDays > 0) {
        skipped.push({
          path: task.path,
          reason:
            "task group has missing createdAt/updatedAt; not eligible while keepTerminalTasksDays > 0",
        });
        warnings.push(
          `skipped ${task.path}: task group has missing createdAt/updatedAt; not eligible while keepTerminalTasksDays > 0`
        );
        continue;
      }
    }
    const activityMs = Math.max(...activityValues.map((value) => value ?? 0));
    if (activityMs > cutoffMs) continue;

    const protectedResults = related.filter((d) => !isPurgeableTaskResultStatus(d.status));
    if (protectedResults.length > 0) {
      warnings.push(
        `task-group ${task.path} has ${protectedResults.length} non-terminal result(ies); refusing group purge`
      );
      continue;
    }

    // Pin: Output.resultId references any related TaskResult, or task id is pinned via TaskResult.
    const pinnedRelated = related.filter((d) => pinnedTaskResultIds.has(d.id));
    if (
      pinnedRelated.length > 0 ||
      (task.id !== undefined && pinnedTaskIds.has(task.id))
    ) {
      const pinIds = pinnedRelated.map((d) => d.id).join(",") || task.id || "";
      warnings.push(
        `task-group ${task.path} pinned by Output.resultId (${pinIds}); refusing group purge`
      );
      continue;
    }

    const ageDays = ageDaysFrom(activityMs, nowMs);
    const resultPaths = related.map((d) => d.path);
    for (const p of resultPaths) claimedTaskResultPaths.add(p);

    candidates.push({
      kind: "task-group",
      taskId: task.id,
      taskPath: task.path,
      taskState: task.state,
      resultPaths,
      ageDays,
      reason: `terminal task state=${task.state} ageDays=${ageDays} ≥ keep=${keepTerminalTasksDays}`,
    });
  }

  // 2) Orphan non-ready results (task missing or unknown taskId) past retention.
  for (const d of results) {
    if (claimedTaskResultPaths.has(d.path)) continue;
    if (!isPurgeableTaskResultStatus(d.status)) continue;

    const parent = tasksById.get(d.taskId);
    if (parent) {
      // TaskResult still attached to a known task — only purged with that task group.
      continue;
    }

    if (pinnedTaskResultIds.has(d.id)) {
      warnings.push(
        `orphan result ${d.path} pinned by Output.resultId; refusing purge`
      );
      continue;
    }

    const activity = resultActivityMs(d);
    if (activity === undefined) {
      if (keepTerminalTasksDays > 0) {
        skipped.push({
          path: d.path,
          reason: "missing createdAt/updatedAt; not eligible while keepTerminalTasksDays > 0",
        });
        warnings.push(
          `skipped ${d.path}: missing createdAt/updatedAt; not eligible while keepTerminalTasksDays > 0`
        );
        continue;
      }
    }
    const activityMs = activity ?? 0;
    if (activityMs > cutoffMs) continue;

    const ageDays = ageDaysFrom(activityMs, nowMs);
    candidates.push({
      kind: "orphan-result",
      taskId: d.taskId,
      resultPaths: [d.path],
      ageDays,
      reason: `orphan non-ready result status=${d.status} ageDays=${ageDays} ≥ keep=${keepTerminalTasksDays}`,
    });
  }

  candidates.sort((a, b) => {
    const ap = a.taskPath || a.resultPaths[0] || "";
    const bp = b.taskPath || b.resultPaths[0] || "";
    return ap.localeCompare(bp);
  });

  let candidateTaskResultCount = 0;
  let candidateTaskCount = 0;
  for (const c of candidates) {
    if (c.kind === "task-group") candidateTaskCount += 1;
    candidateTaskResultCount += c.resultPaths.length;
  }

  return {
    keepTerminalTasksDays,
    cutoff,
    candidates,
    skipped,
    warnings,
    candidateTaskCount,
    candidateTaskResultCount,
  };
}

/**
 * Purge candidates selected by the same rules as preview.
 * Deletes task + its results as a group; orphan terminal results independently.
 * Never deletes active tasks or ready results.
 */
export async function purgeOperationalRetention(
  fs: FsAdapter,
  options: RetentionOptions = {}
): Promise<RetentionPurgeResult> {
  return withTentMutation(fs, async () => {
    const preview = await previewOperationalRetention(fs, options);
    const purgedTaskPaths: string[] = [];
    const purgedTaskResultPaths: string[] = [];

    for (const c of preview.candidates) {
      if (c.kind === "task-group" && c.taskPath) {
        // Re-validate immediately before delete (TOCTOU safety within mutation lock).
        try {
          const live = await loadTaskRecord(fs, c.taskPath);
          if (!isTerminalTaskState(live.state) || isActiveTaskState(live.state)) {
            preview.warnings.push(
              `refused purge of ${c.taskPath}: state is ${live.state} (not terminal)`
            );
            continue;
          }
        } catch (err) {
          preview.warnings.push(
            `refused purge of ${c.taskPath}: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }

        let resultValidationFailed = false;
        for (const dp of c.resultPaths) {
          try {
            const liveD = await loadTaskResult(fs, dp);
            if (!isPurgeableTaskResultStatus(liveD.status)) {
              preview.warnings.push(
                `refused purge of task group ${c.taskPath}: result ${dp} status=${liveD.status}`
              );
              resultValidationFailed = true;
              break;
            }
          } catch (err) {
            preview.warnings.push(
              `refused purge of task group ${c.taskPath}: ${err instanceof Error ? err.message : String(err)}`
            );
            resultValidationFailed = true;
            break;
          }
        }
        if (resultValidationFailed) continue;

        // Delete the parent first. If a later result delete fails, the remaining
        // record is an orphan that a future retention pass can safely retry.
        // The inverse order could leave a surviving task pointing at missing history.
        try {
          if (await fs.exists(c.taskPath)) {
            await fs.remove(c.taskPath);
            purgedTaskPaths.push(c.taskPath);
          }
        } catch (err) {
          preview.warnings.push(
            `failed to purge task ${c.taskPath}: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }

        for (const dp of c.resultPaths) {
          try {
            if (await fs.exists(dp)) {
              await fs.remove(dp);
              purgedTaskResultPaths.push(dp);
            }
          } catch (err) {
            preview.warnings.push(
              `failed to purge orphaned result ${dp}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        continue;
      }

      if (c.kind === "orphan-result") {
        for (const dp of c.resultPaths) {
          try {
            const liveD = await loadTaskResult(fs, dp);
            if (!isPurgeableTaskResultStatus(liveD.status)) {
              preview.warnings.push(
                `refused purge of result ${dp}: status=${liveD.status}`
              );
              continue;
            }
            if (await fs.exists(dp)) {
              await fs.remove(dp);
              purgedTaskResultPaths.push(dp);
            }
          } catch (err) {
            preview.warnings.push(
              `failed to purge result ${dp}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    }

    const deletedCount = purgedTaskPaths.length + purgedTaskResultPaths.length;
    return {
      ...preview,
      purged: {
        taskPaths: purgedTaskPaths,
        resultPaths: purgedTaskResultPaths,
      },
      deletedCount,
    };
  });
}

// ---- scanning (report bad files; do not swallow) ----

async function scanTasks(
  fs: FsAdapter
): Promise<{ tasks: TaskRecord[]; skipped: RetentionSkipped[] }> {
  const tasks: TaskRecord[] = [];
  const skipped: RetentionSkipped[] = [];
  if (!(await fs.exists("temp"))) return { tasks, skipped };

  for (const namespace of await fs.listDir("temp")) {
    if (!namespace.isDir || (namespace.name !== "roles" && namespace.name !== "sessions")) continue;
    const namespaceRoot = join("temp", namespace.name);
    for (const ownerEntry of await fs.listDir(namespaceRoot)) {
      if (!ownerEntry.isDir) continue;
      if (!isSafeRoleSegment(ownerEntry.name)) {
      skipped.push({
          path: join(namespaceRoot, ownerEntry.name),
          reason: `unsafe ${namespace.name} directory name`,
      });
      continue;
    }
      await scanTaskDir(fs, join(namespaceRoot, ownerEntry.name, "tasks"), tasks, skipped);
    }
  }
  return { tasks, skipped };
}

async function scanTaskDir(
  fs: FsAdapter,
  taskDir: string,
  tasks: TaskRecord[],
  skipped: RetentionSkipped[]
): Promise<void> {
  if (!(await fs.exists(taskDir))) return;
  for (const entry of await fs.listDir(taskDir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path = join(taskDir, entry.name);
    try {
      tasks.push(await loadTaskRecord(fs, path));
    } catch (err) {
      skipped.push({
        path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function scanResults(
  fs: FsAdapter
): Promise<{ results: TaskResultRecord[]; skipped: RetentionSkipped[] }> {
  const results: TaskResultRecord[] = [];
  const skipped: RetentionSkipped[] = [];
  if (!(await fs.exists("temp"))) return { results, skipped };

  for (const namespace of await fs.listDir("temp")) {
    if (!namespace.isDir || (namespace.name !== "roles" && namespace.name !== "sessions")) continue;
    const namespaceRoot = join("temp", namespace.name);
    for (const ownerEntry of await fs.listDir(namespaceRoot)) {
      if (!ownerEntry.isDir) continue;
      if (!isSafeRoleSegment(ownerEntry.name)) {
      skipped.push({
          path: join(namespaceRoot, ownerEntry.name),
          reason: `unsafe ${namespace.name} directory name`,
      });
      continue;
    }
      await scanTaskResultDir(
        fs,
        join(namespaceRoot, ownerEntry.name, "results"),
        results,
        skipped
      );
    }
  }
  return { results, skipped };
}

async function scanTaskResultDir(
  fs: FsAdapter,
  dir: string,
  results: TaskResultRecord[],
  skipped: RetentionSkipped[]
): Promise<void> {
  if (!(await fs.exists(dir))) return;
  for (const entry of await fs.listDir(dir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path = join(dir, entry.name);
    try {
      results.push(await loadTaskResult(fs, path));
    } catch (err) {
      skipped.push({
        path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function isSafeRoleSegment(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (/[\\/]/.test(name)) return false;
  if (name.includes("\0")) return false;
  return true;
}

function taskActivityMs(task: TaskRecord): number | undefined {
  return parseIsoMs(task.updatedAt) ?? parseIsoMs(task.createdAt);
}

function resultActivityMs(d: TaskResultRecord): number | undefined {
  return parseIsoMs(d.createdAt);
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return ms;
}

function resolveNowMs(now: string | Date | undefined): number {
  if (now === undefined) return Date.now();
  if (now instanceof Date) {
    const ms = now.getTime();
    if (!Number.isFinite(ms)) throw new RetentionError("INVALID_KEEP_DAYS", "Invalid now Date");
    return ms;
  }
  const ms = Date.parse(now);
  if (!Number.isFinite(ms)) {
    throw new RetentionError("INVALID_KEEP_DAYS", "Invalid now ISO timestamp");
  }
  return ms;
}

function ageDaysFrom(activityMs: number, nowMs: number): number {
  const delta = Math.max(0, nowMs - activityMs);
  return Math.floor(delta / MS_PER_DAY);
}
