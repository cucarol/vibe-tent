// Task Node references are sourced only from the canonical Node selection.
// Work Nodes are exclusive write scope; context Nodes are shared read scope.

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
  "MISSING_TASK_NODE_SELECTION: Task.workNodeIds and Task.contextNodeIds are required.";

function normalizedSelection(task: TaskNodeRefSource): TaskNodeSelection {
  const label = task.id || task.path || "(unknown)";
  try {
    return normalizeTaskNodeSelection({
      workNodeIds: task.workNodeIds,
      contextNodeIds: task.contextNodeIds,
    });
  } catch (error) {
    const wrapped = new Error(`${MISSING_TASK_NODE_SELECTION} task=${label}`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
}

/** Ordered work-then-context Node ids referenced by a Task. */
export function taskReferencedNodeIds(task: TaskNodeRefSource): string[] {
  const selection = normalizedSelection(task);
  return [...selection.workNodeIds, ...selection.contextNodeIds];
}

/** Whether a Task owns nodeId in its exclusive work scope. */
export function taskDirectlyReferencesNode(task: TaskNodeRefSource, nodeId: string): boolean {
  if (!nodeId) return false;
  return normalizedSelection(task).workNodeIds.includes(nodeId);
}

/** Active Tasks that own nodeId, returned in deterministic order. */
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
