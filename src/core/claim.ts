// 认领与占用互斥。
// 运行时 oracle：active Task envelope（queued|running|waiting|delivered）独占 box 子树。
// Node frontmatter 不再承载 owner/status；协作真相仅在 Task/Session/Delivery。

import type { TaskEnvelope } from "./task.js";
import { isActiveTaskState, legacyStatusToState, type TaskState } from "./task-model.js";
import { Box } from "./types.js";
import { LoadedTent } from "./tree.js";

export interface ClaimCheck {
  ok: boolean;
  /** 不 ok 时,挡路的那个已占用框（active task 的 claim 根）。 */
  blocker?: Box;
  reason?: string;
  /** Active task that occupies the range, when known. */
  task?: TaskEnvelope;
}

export interface CanClaimOptions {
  /**
   * asSub claim under a dispatcher that already occupies an ancestor via active task:
   * allow only when every occupied ancestor is held by this durable role (task.role).
   * Child itself and descendants must still be free (peer mutual exclusion).
   */
  allowAncestorClaimedBy?: string;
  /**
   * Active-task oracle. When provided with `tent`, occupation is enforced.
   * When omitted, only structural gates run.
   */
  tasks?: readonly TaskEnvelope[];
  /** Required together with `tasks` for ancestor/descendant occupation checks. */
  tent?: LoadedTent;
}

/** Envelope is active occupation (full state, with legacy status fallback). */
export function envelopeIsActiveOccupation(task: TaskEnvelope): boolean {
  const state: TaskState =
    task.state ||
    (task.status === "pending" || task.status === "taken"
      ? legacyStatusToState(task.status)
      : "failed");
  return isActiveTaskState(state);
}

/**
 * 能否把 box 认领给某角色?
 * 结构门：invalid / archived（isUsableBox）。
 * 占用门：仅 active task envelope 子树互斥。
 */
export function canClaim(box: Box, options?: CanClaimOptions): ClaimCheck {
  const structural = structuralClaimGate(box);
  if (!structural.ok) return structural;

  const tasks = options?.tasks;
  const tent = options?.tent;
  if (!tasks || tasks.length === 0 || !tent) {
    return { ok: true };
  }

  const allowAncestorBy = (options?.allowAncestorClaimedBy || "").trim();
  const hit = findActiveOccupation(tent, box, tasks, {
    allowAncestorClaimedBy: allowAncestorBy || undefined,
  });
  if (!hit) return { ok: true };
  return {
    ok: false,
    blocker: hit.blocker,
    task: hit.task,
    reason: hit.reason,
  };
}

/** Structural gates shared by claim and dispatch (no occupation). */
export function structuralClaimGate(box: Box): ClaimCheck {
  if (box.invalid) {
    return { ok: false, blocker: box, reason: `Invalid subtree: ${box.invalidReason || "missing type definition"}` };
  }
  if (box.archived) {
    return { ok: false, blocker: box, reason: "Archived subtree cannot be claimed." };
  }
  // V0.2: every valid non-archived concept may enter the task lifecycle.
  // Type is semantic only; no coordination capability gate.
  return { ok: true };
}

export interface ActiveOccupationHit {
  blocker: Box;
  task: TaskEnvelope;
  reason: string;
  /** self | ancestor | descendant | root */
  relation: "self" | "ancestor" | "descendant" | "root";
}

/**
 * Find an active task that occupies `box` or an overlapping ancestor/descendant range.
 * asSub: ancestor occupation by `allowAncestorClaimedBy` role is skipped.
 */
export function findActiveOccupation(
  tent: LoadedTent,
  box: Box,
  tasks: readonly TaskEnvelope[],
  options?: { allowAncestorClaimedBy?: string }
): ActiveOccupationHit | undefined {
  const allowAncestorBy = (options?.allowAncestorClaimedBy || "").trim();
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    for (const claimId of task.claims) {
      if (claimId === "root") {
        return {
          blocker: box,
          task,
          relation: "root",
          reason: `Tent root is occupied by active task for ${task.role}.`,
        };
      }
      const claimed = tent.byId.get(claimId);
      if (!claimed) continue;
      if (claimed.id === box.id) {
        return {
          blocker: claimed,
          task,
          relation: "self",
          reason: `${box.name} is already occupied by active task for ${task.role}.`,
        };
      }
      if (isAncestor(claimed, box)) {
        if (allowAncestorBy && task.role === allowAncestorBy) {
          continue;
        }
        return {
          blocker: claimed,
          task,
          relation: "ancestor",
          reason: `Ancestor ${claimed.name} is occupied by active task for ${task.role}.`,
        };
      }
      if (isAncestor(box, claimed)) {
        return {
          blocker: claimed,
          task,
          relation: "descendant",
          reason: `Descendant ${claimed.name} is occupied by active task for ${task.role}.`,
        };
      }
    }
  }
  return undefined;
}

/** True when any active task claims this box id (not ancestor/descendant fan-out). */
export function boxHasDirectActiveTask(
  boxId: string,
  tasks: readonly TaskEnvelope[]
): boolean {
  return tasks.some(
    (t) => envelopeIsActiveOccupation(t) && (t.claims.includes(boxId) || t.claims.includes("root"))
  );
}

/**
 * Active task that claims tent root (`claims` includes `"root"`).
 * Root occupation covers the entire tent and must not be skipped by box-only scans.
 */
export function findActiveRootTask(
  tasks: readonly TaskEnvelope[]
): TaskEnvelope | undefined {
  return tasks.find(
    (t) => envelopeIsActiveOccupation(t) && t.claims.includes("root")
  );
}

/**
 * Any active task envelope (root or box claim). Used when dispatching tent root:
 * root occupies the whole tent, so any active task blocks a second root dispatch.
 */
export function findAnyActiveTask(
  tasks: readonly TaskEnvelope[]
): TaskEnvelope | undefined {
  return tasks.find((t) => envelopeIsActiveOccupation(t));
}

/** Boxes that currently host a direct active-task claim (for status / panels). */
export function occupiedBoxesFromTasks(tent: LoadedTent, tasks: readonly TaskEnvelope[]): Box[] {
  const out = new Map<string, Box>();
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    for (const claimId of task.claims) {
      // Root is not a box id; callers that need tent-root occupation use findActiveRootTask.
      if (claimId === "root") continue;
      const box = tent.byId.get(claimId);
      if (box) out.set(box.id, box);
    }
  }
  return [...out.values()];
}

/**
 * Structural freeze only (invalid / archived).
 * Active-task occupation is checked via findActiveOccupation / canClaim — not Node locks.
 */
export function isFrozen(box: Box): boolean {
  return box.invalid || box.archived;
}

function isAncestor(ancestor: Box, child: Box): boolean {
  let parent = child.parent;
  while (parent) {
    if (parent.id === ancestor.id) return true;
    parent = parent.parent;
  }
  return false;
}
