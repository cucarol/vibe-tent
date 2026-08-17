// Task Node references are sourced only from the canonical root nodeIds[] selection.

import { isActiveTaskState, type TaskState } from "./task-model.js";
import {
  normalizeTaskNodeSelection,
  type TaskNodeSelection,
} from "./task-node-selection.js";

export type TaskNodeRefSource = TaskNodeSelection & {
  id?: string;
  path?: string;
  createdAt?: string;
  state: TaskState;
};

export const MISSING_TASK_NODE_SELECTION =
  "MISSING_TASK_NODE_SELECTION: Task.nodeIds is required.";

function normalizedSelection(task: TaskNodeRefSource): TaskNodeSelection {
  const label = task.id || task.path || "(unknown)";
  try {
    return normalizeTaskNodeSelection({
      nodeIds: task.nodeIds,
    });
  } catch (error) {
    const wrapped = new Error(`${MISSING_TASK_NODE_SELECTION} task=${label}`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
}

/** Ordered root Node ids referenced by a Task. */
export function taskReferencedNodeIds(task: TaskNodeRefSource): string[] {
  const selection = normalizedSelection(task);
  return [...selection.nodeIds];
}

/** Whether a Task directly selects nodeId as one of its roots. */
export function taskDirectlyReferencesNode(task: TaskNodeRefSource, nodeId: string): boolean {
  if (!nodeId) return false;
  return normalizedSelection(task).nodeIds.includes(nodeId);
}

/** Active Tasks that reference nodeId, returned in deterministic order. */
export function listDirectActiveTasksForNode<T extends TaskNodeRefSource>(
  nodeId: string,
  tasks: readonly T[]
): T[] {
  const matches = tasks.filter(
    (task) => isActiveTaskState(task.state) && taskDirectlyReferencesNode(task, nodeId)
  );
  return sortTasksDeterministically(matches);
}

export function sortTasksDeterministically<T extends TaskNodeRefSource>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => {
    const ca = a.createdAt || "";
    const cb = b.createdAt || "";
    if (ca !== cb) return ca.localeCompare(cb);
    const ia = a.id || "";
    const ib = b.id || "";
    if (ia !== ib) return ia.localeCompare(ib);
    return (a.path || "").localeCompare(b.path || "");
  });
}
