// Operational retention (task-api §6 MVP).
// Safe purge of terminal tasks + non-ready deliveries; never touches active work.
// Paths are always under temp/<role>/{tasks,deliveries}/ via FsAdapter — no free-form paths.

import { withTentMutation, type FsAdapter } from "./adapter.js";
import { loadDelivery, type DeliveryRecord } from "./delivery.js";
import { collectReferencedDeliveryIds } from "./output.js";
import { loadTaskEnvelope, type TaskEnvelope } from "./task.js";
import {
  isActiveTaskState,
  TERMINAL_TASK_STATES,
  type DeliveryStatus,
  type TaskState,
} from "./task-model.js";
import { join, loadTent } from "./tree.js";

/** Default heat retention for terminal operational records (task-api §6). */
export const DEFAULT_KEEP_TERMINAL_DAYS = 30;

/** Inclusive upper bound for keepTerminalTasksDays (prevents unbounded retention params). */
export const MAX_KEEP_TERMINAL_DAYS = 3650;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const TERMINAL_DELIVERY_STATUSES: ReadonlySet<DeliveryStatus> = new Set([
  "accepted",
  "rejected",
]);

export type RetentionCandidateKind = "task-group" | "orphan-delivery";

export type RetentionCandidate = {
  kind: RetentionCandidateKind;
  /** Present for task-group candidates. */
  taskId?: string;
  taskPath?: string;
  taskState?: TaskState;
  /** Delivery paths that would be removed with this candidate. */
  deliveryPaths: string[];
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
  candidateDeliveryCount: number;
};

export type RetentionPurgeResult = RetentionPreviewResult & {
  purged: {
    taskPaths: string[];
    deliveryPaths: string[];
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

export function isPurgeableDeliveryStatus(status: DeliveryStatus): boolean {
  return TERMINAL_DELIVERY_STATUSES.has(status);
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
  const { deliveries, skipped: deliverySkipped } = await scanDeliveries(fs);
  skipped.push(...deliverySkipped);

  for (const s of skipped) {
    warnings.push(`skipped ${s.path}: ${s.reason}`);
  }

  const tasksById = new Map<string, TaskEnvelope>();
  const taskIdCounts = new Map<string, number>();
  for (const t of tasks) {
    if (t.id) {
      tasksById.set(t.id, t);
      taskIdCounts.set(t.id, (taskIdCounts.get(t.id) ?? 0) + 1);
    }
  }

  const deliveriesByTaskId = new Map<string, DeliveryRecord[]>();
  for (const d of deliveries) {
    const list = deliveriesByTaskId.get(d.taskId) ?? [];
    list.push(d);
    deliveriesByTaskId.set(d.taskId, list);
  }

  const candidates: RetentionCandidate[] = [];
  const claimedDeliveryPaths = new Set<string>();

  // Output provenance pin: any live Output.deliveryId (including archived Outputs)
  // protects that Delivery and its Task group. Not a general permanent history system.
  // Fail closed: if pin scan cannot load the tent, refuse all destructive selection
  // rather than purge without knowing which Deliveries are still referenced.
  let pinnedDeliveryIds: Set<string>;
  try {
    const tent = await loadTent(fs);
    pinnedDeliveryIds = collectReferencedDeliveryIds(tent);
  } catch (err) {
    throw new RetentionError(
      "PROVENANCE_PIN_SCAN_FAILED",
      `Output provenance pin scan failed; refusing retention preview/purge: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  const pinnedTaskIds = new Set<string>();
  for (const d of deliveries) {
    if (pinnedDeliveryIds.has(d.id) && d.taskId) pinnedTaskIds.add(d.taskId);
  }

  // 1) Terminal tasks past retention → purge as a group with their deliveries.
  for (const task of tasks) {
    if (!isTerminalTaskState(task.state)) continue;
    if (isActiveTaskState(task.state)) continue; // belt-and-suspenders
    if (task.id && (taskIdCounts.get(task.id) ?? 0) > 1) {
      const message = `duplicate task id ${task.id}; refusing ambiguous retention group`;
      skipped.push({ path: task.path, reason: message });
      warnings.push(`skipped ${task.path}: ${message}`);
      continue;
    }

    const related = task.id ? deliveriesByTaskId.get(task.id) ?? [] : [];
    const activityValues = [taskActivityMs(task), ...related.map(deliveryActivityMs)];
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

    const protectedDeliveries = related.filter((d) => !isPurgeableDeliveryStatus(d.status));
    if (protectedDeliveries.length > 0) {
      warnings.push(
        `task-group ${task.path} has ${protectedDeliveries.length} non-terminal delivery(ies); refusing group purge`
      );
      continue;
    }

    // Pin: Output.deliveryId references any related Delivery, or task id is pinned via Delivery.
    const pinnedRelated = related.filter((d) => pinnedDeliveryIds.has(d.id));
    if (
      pinnedRelated.length > 0 ||
      (task.id !== undefined && pinnedTaskIds.has(task.id))
    ) {
      const pinIds = pinnedRelated.map((d) => d.id).join(",") || task.id || "";
      warnings.push(
        `task-group ${task.path} pinned by Output.deliveryId (${pinIds}); refusing group purge`
      );
      continue;
    }

    const ageDays = ageDaysFrom(activityMs, nowMs);
    const deliveryPaths = related.map((d) => d.path);
    for (const p of deliveryPaths) claimedDeliveryPaths.add(p);

    candidates.push({
      kind: "task-group",
      taskId: task.id,
      taskPath: task.path,
      taskState: task.state,
      deliveryPaths,
      ageDays,
      reason: `terminal task state=${task.state} ageDays=${ageDays} ≥ keep=${keepTerminalTasksDays}`,
    });
  }

  // 2) Orphan non-ready deliveries (task missing or unknown taskId) past retention.
  for (const d of deliveries) {
    if (claimedDeliveryPaths.has(d.path)) continue;
    if (!isPurgeableDeliveryStatus(d.status)) continue;

    const parent = tasksById.get(d.taskId);
    if (parent) {
      // Delivery still attached to a known task — only purged with that task group.
      continue;
    }

    if (pinnedDeliveryIds.has(d.id)) {
      warnings.push(
        `orphan delivery ${d.path} pinned by Output.deliveryId; refusing purge`
      );
      continue;
    }

    const activity = deliveryActivityMs(d);
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
      kind: "orphan-delivery",
      taskId: d.taskId,
      deliveryPaths: [d.path],
      ageDays,
      reason: `orphan non-ready delivery status=${d.status} ageDays=${ageDays} ≥ keep=${keepTerminalTasksDays}`,
    });
  }

  candidates.sort((a, b) => {
    const ap = a.taskPath || a.deliveryPaths[0] || "";
    const bp = b.taskPath || b.deliveryPaths[0] || "";
    return ap.localeCompare(bp);
  });

  let candidateDeliveryCount = 0;
  let candidateTaskCount = 0;
  for (const c of candidates) {
    if (c.kind === "task-group") candidateTaskCount += 1;
    candidateDeliveryCount += c.deliveryPaths.length;
  }

  return {
    keepTerminalTasksDays,
    cutoff,
    candidates,
    skipped,
    warnings,
    candidateTaskCount,
    candidateDeliveryCount,
  };
}

/**
 * Purge candidates selected by the same rules as preview.
 * Deletes task + its deliveries as a group; orphan terminal deliveries independently.
 * Never deletes active tasks or ready deliveries.
 */
export async function purgeOperationalRetention(
  fs: FsAdapter,
  options: RetentionOptions = {}
): Promise<RetentionPurgeResult> {
  return withTentMutation(fs, async () => {
    const preview = await previewOperationalRetention(fs, options);
    const purgedTaskPaths: string[] = [];
    const purgedDeliveryPaths: string[] = [];

    for (const c of preview.candidates) {
      if (c.kind === "task-group" && c.taskPath) {
        // Re-validate immediately before delete (TOCTOU safety within mutation lock).
        try {
          const live = await loadTaskEnvelope(fs, c.taskPath);
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

        let deliveryValidationFailed = false;
        for (const dp of c.deliveryPaths) {
          try {
            const liveD = await loadDelivery(fs, dp);
            if (!isPurgeableDeliveryStatus(liveD.status)) {
              preview.warnings.push(
                `refused purge of task group ${c.taskPath}: delivery ${dp} status=${liveD.status}`
              );
              deliveryValidationFailed = true;
              break;
            }
          } catch (err) {
            preview.warnings.push(
              `refused purge of task group ${c.taskPath}: ${err instanceof Error ? err.message : String(err)}`
            );
            deliveryValidationFailed = true;
            break;
          }
        }
        if (deliveryValidationFailed) continue;

        // Delete the parent first. If a later delivery delete fails, the remaining
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

        for (const dp of c.deliveryPaths) {
          try {
            if (await fs.exists(dp)) {
              await fs.remove(dp);
              purgedDeliveryPaths.push(dp);
            }
          } catch (err) {
            preview.warnings.push(
              `failed to purge orphaned delivery ${dp}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        continue;
      }

      if (c.kind === "orphan-delivery") {
        for (const dp of c.deliveryPaths) {
          try {
            const liveD = await loadDelivery(fs, dp);
            if (!isPurgeableDeliveryStatus(liveD.status)) {
              preview.warnings.push(
                `refused purge of delivery ${dp}: status=${liveD.status}`
              );
              continue;
            }
            if (await fs.exists(dp)) {
              await fs.remove(dp);
              purgedDeliveryPaths.push(dp);
            }
          } catch (err) {
            preview.warnings.push(
              `failed to purge delivery ${dp}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    }

    const deletedCount = purgedTaskPaths.length + purgedDeliveryPaths.length;
    return {
      ...preview,
      purged: {
        taskPaths: purgedTaskPaths,
        deliveryPaths: purgedDeliveryPaths,
      },
      deletedCount,
    };
  });
}

// ---- scanning (report bad files; do not swallow) ----

async function scanTasks(
  fs: FsAdapter
): Promise<{ tasks: TaskEnvelope[]; skipped: RetentionSkipped[] }> {
  const tasks: TaskEnvelope[] = [];
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
  tasks: TaskEnvelope[],
  skipped: RetentionSkipped[]
): Promise<void> {
  if (!(await fs.exists(taskDir))) return;
  for (const entry of await fs.listDir(taskDir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path = join(taskDir, entry.name);
    try {
      tasks.push(await loadTaskEnvelope(fs, path));
    } catch (err) {
      skipped.push({
        path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function scanDeliveries(
  fs: FsAdapter
): Promise<{ deliveries: DeliveryRecord[]; skipped: RetentionSkipped[] }> {
  const deliveries: DeliveryRecord[] = [];
  const skipped: RetentionSkipped[] = [];
  if (!(await fs.exists("temp"))) return { deliveries, skipped };

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
      await scanDeliveryDir(
        fs,
        join(namespaceRoot, ownerEntry.name, "deliveries"),
        deliveries,
        skipped
      );
    }
  }
  return { deliveries, skipped };
}

async function scanDeliveryDir(
  fs: FsAdapter,
  dir: string,
  deliveries: DeliveryRecord[],
  skipped: RetentionSkipped[]
): Promise<void> {
  if (!(await fs.exists(dir))) return;
  for (const entry of await fs.listDir(dir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path = join(dir, entry.name);
    try {
      deliveries.push(await loadDelivery(fs, path));
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

function taskActivityMs(task: TaskEnvelope): number | undefined {
  return parseIsoMs(task.updatedAt) ?? parseIsoMs(task.createdAt);
}

function deliveryActivityMs(d: DeliveryRecord): number | undefined {
  return parseIsoMs(d.updatedAt) ?? parseIsoMs(d.createdAt);
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
