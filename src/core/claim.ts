// Task Node reference helpers + structural dispatch gates (V0.2 cx-tsw53f).
// Node refs are non-exclusive: multiple active Tasks may reference the same Node,
// ancestor, descendant, or workspace/root context. Code isolation is worktree/Git,
// not a Node-tree mutex.
// Archive/purge still fail only on *direct* active Node refs (see boxHasDirectActiveTask).

import type { TaskEnvelope } from "./task.js";
import { isActiveTaskState, legacyStatusToState, type TaskState } from "./task-model.js";
import { Box } from "./types.js";
import { LoadedTent } from "./tree.js";
import {
  listDirectActiveTasksForNode,
  taskDirectlyReferencesNode,
  taskHasWorkspaceOnlyContext,
  taskReferencedNodeIds,
} from "./task-node-refs.js";

export interface ClaimCheck {
  ok: boolean;
  /** Structural blocker box when not ok. */
  blocker?: Box;
  reason?: string;
  /** Optional task context (not used for mutual exclusion). */
  task?: TaskEnvelope;
}

export interface CanClaimOptions {
  /**
   * @deprecated V0.2: ordinary reference concurrency is legal; asSub ancestor
   * occupation exception is removed. Kept as a no-op for call-site compatibility.
   */
  allowAncestorClaimedBy?: string;
  /**
   * Active tasks (informational). Occupation mutual exclusion is retired;
   * only structural gates run.
   */
  tasks?: readonly TaskEnvelope[];
  /** Optional tent (unused for occupation; retained for call-site compatibility). */
  tent?: LoadedTent;
}

/** Envelope is active (queued|running|waiting|delivered, with legacy status fallback). */
export function envelopeIsActiveOccupation(task: TaskEnvelope): boolean {
  const state: TaskState =
    task.state ||
    (task.status === "pending" || task.status === "taken"
      ? legacyStatusToState(task.status)
      : "failed");
  return isActiveTaskState(state);
}

/**
 * Structural gate for dispatch/claim: invalid / archived deny new work.
 * Node reference concurrency is legal — no mutual exclusion.
 */
export function canClaim(box: Box, _options?: CanClaimOptions): ClaimCheck {
  return structuralClaimGate(box);
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
  /** self only in V0.2 direct-ref semantics (legacy relation names retained). */
  relation: "self" | "ancestor" | "descendant" | "root";
}

/**
 * @deprecated V0.2 non-exclusive refs: ancestor/descendant/root no longer block.
 * Returns a direct-ref hit only when some active Task references `box` itself.
 * Callers that still need archive/purge direct-ref checks should prefer
 * `boxHasDirectActiveTask` / `listDirectActiveTasksForNode`.
 */
export function findActiveOccupation(
  tent: LoadedTent,
  box: Box,
  tasks: readonly TaskEnvelope[],
  _options?: { allowAncestorClaimedBy?: string }
): ActiveOccupationHit | undefined {
  void tent;
  void _options;
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.contextCard == null) continue;
    if (taskDirectlyReferencesNode(task, box.id)) {
      return {
        blocker: box,
        task,
        relation: "self",
        reason: `${box.name} is directly referenced by active task ${task.id || task.path} (${task.role}).`,
      };
    }
  }
  return undefined;
}

/**
 * True when any active task *directly* references this box id.
 * Workspace/root context alone does not count as a direct Node ref.
 * Used by archive/purge gates — ancestor/descendant refs do not block.
 */
export function boxHasDirectActiveTask(
  boxId: string,
  tasks: readonly TaskEnvelope[]
): boolean {
  return listDirectActiveTasksForNode(boxId, tasks).length > 0;
}

/**
 * Active tasks with no direct Node refs (stable workspace context only).
 * Not a Tent-wide lock — multiple concurrent workspace-context Tasks are legal.
 * Derived from empty contextCard.refs.nodes (no second source flag).
 */
export function findActiveRootTask(
  tasks: readonly TaskEnvelope[]
): TaskEnvelope | undefined {
  return tasks.find((t) => {
    if (!envelopeIsActiveOccupation(t)) return false;
    if (t.contextCard == null) return false;
    return taskHasWorkspaceOnlyContext(t);
  });
}

/**
 * Any active task envelope. Informational only — no longer blocks root dispatch.
 */
export function findAnyActiveTask(
  tasks: readonly TaskEnvelope[]
): TaskEnvelope | undefined {
  return tasks.find((t) => envelopeIsActiveOccupation(t));
}

/** Boxes that currently host a direct active-task Node ref (for status / panels). */
export function occupiedBoxesFromTasks(tent: LoadedTent, tasks: readonly TaskEnvelope[]): Box[] {
  const out = new Map<string, Box>();
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.contextCard == null) continue; // unmigrated: not in occupation set
    for (const nodeId of taskReferencedNodeIds(task)) {
      const box = tent.byId.get(nodeId);
      if (box) out.set(box.id, box);
    }
  }
  return [...out.values()];
}

/**
 * Structural freeze only (invalid / archived).
 * Active-task Node refs are non-exclusive — not Node locks.
 */
export function isFrozen(box: Box): boolean {
  return box.invalid || box.archived;
}
