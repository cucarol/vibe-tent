// Task Node occupation helpers + structural dispatch gates.
// One exact Node may be occupied by only one active Task. Ancestors, descendants,
// siblings, and workspace context remain independent and may run concurrently.

import type { TaskEnvelope } from "./task.js";
import { isActiveTaskState } from "./task-model.js";
import { Node } from "./types.js";
import { LoadedTent } from "./tree.js";
import {
  listDirectActiveTasksForNode,
  taskDirectlyReferencesNode,
  taskReferencedNodeIds,
} from "./task-node-refs.js";

export interface ClaimCheck {
  ok: boolean;
  /** Structural blocker node when not ok. */
  blocker?: Node;
  reason?: string;
  /** Optional task context (not used for mutual exclusion). */
  task?: TaskEnvelope;
}

export interface CanClaimOptions {
  /** Active Task envelopes used for exact-Node occupation checks. */
  tasks?: readonly TaskEnvelope[];
}

/** Envelope is active while its canonical state occupies its exact Nodes. */
export function envelopeIsActiveOccupation(task: TaskEnvelope): boolean {
  return isActiveTaskState(task.state);
}

/**
 * Dispatch/claim gate: invalid / archived Nodes deny new work, and an exact Node
 * already referenced by an active Task is occupied. Parent/child refs do not block.
 */
export function canClaim(node: Node, options?: CanClaimOptions): ClaimCheck {
  const structural = structuralClaimGate(node);
  if (!structural.ok) return structural;
  const occupied = options?.tasks
    ? listDirectActiveTasksForNode(node.id, options.tasks)[0]
    : undefined;
  if (occupied) {
    return {
      ok: false,
      blocker: node,
      task: occupied,
      reason: `${node.name} is occupied by active task ${occupied.id || occupied.path} (${occupied.assigneeKind}:${occupied.assigneeId}).`,
    };
  }
  return structural;
}

/** Structural gates shared by claim and dispatch (no occupation). */
export function structuralClaimGate(node: Node): ClaimCheck {
  if (node.invalid) {
    return { ok: false, blocker: node, reason: `Invalid subtree: ${node.invalidReason || "missing type definition"}` };
  }
  if (node.archived) {
    return { ok: false, blocker: node, reason: "Archived subtree cannot be claimed." };
  }
  // Every valid non-archived Node may enter the Task lifecycle.
  // Type is semantic only; no coordination capability gate.
  return { ok: true };
}

export interface ActiveOccupationHit {
  blocker: Node;
  task: TaskEnvelope;
  reason: string;
  relation: "self";
}

/**
 * Returns a direct-ref hit only when an active Task occupies `node` itself.
 * Callers that still need archive/purge direct-ref checks should prefer
 * `nodeHasDirectActiveTask` / `listDirectActiveTasksForNode`.
 */
export function findActiveOccupation(
  node: Node,
  tasks: readonly TaskEnvelope[]
): ActiveOccupationHit | undefined {
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.contextCard == null) continue;
    if (taskDirectlyReferencesNode(task, node.id)) {
      return {
        blocker: node,
        task,
        relation: "self",
        reason: `${node.name} is directly referenced by active task ${task.id || task.path} (${task.assigneeKind}:${task.assigneeId}).`,
      };
    }
  }
  return undefined;
}

/**
 * True when any active task occupies this exact node id.
 * Workspace/root context alone does not count as a direct Node ref.
 * Used by archive/purge gates — ancestor/descendant refs do not block.
 */
export function nodeHasDirectActiveTask(
  nodeId: string,
  tasks: readonly TaskEnvelope[]
): boolean {
  return listDirectActiveTasksForNode(nodeId, tasks).length > 0;
}

/**
 * Any active task envelope. Informational only — no longer blocks root dispatch.
 */
export function findAnyActiveTask(
  tasks: readonly TaskEnvelope[]
): TaskEnvelope | undefined {
  return tasks.find((t) => envelopeIsActiveOccupation(t));
}

/** Nodes that currently host a direct active-task Node ref (for status / panels). */
export function occupiedNodesFromTasks(tent: LoadedTent, tasks: readonly TaskEnvelope[]): Node[] {
  const out = new Map<string, Node>();
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.contextCard == null) continue;
    for (const nodeId of taskReferencedNodeIds(task)) {
      const node = tent.byId.get(nodeId);
      if (node) out.set(node.id, node);
    }
  }
  return [...out.values()];
}

/**
 * Content freeze remains invalid / archived only. Task occupation is enforced at
 * dispatch/claim and structural mutation boundaries, not as Node frontmatter.
 */
export function isFrozen(node: Node): boolean {
  return node.invalid || node.archived;
}
