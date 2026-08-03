import { isActiveTaskState, type TaskState } from "./task-model.js";
import {
  normalizeTaskNodeSelection,
  type TaskNodeSelection,
} from "./task-node-selection.js";

export type TaskNodeOccupationSource = TaskNodeSelection & {
  id: string;
  state: TaskState;
  createdAt?: string;
  path?: string;
};

export class TaskNodeOccupiedError extends Error {
  nodeId: string;
  taskId: string;

  constructor(nodeId: string, taskId: string) {
    super(`Node ${nodeId} is already occupied by active Task ${taskId}.`);
    this.name = "TaskNodeOccupiedError";
    this.nodeId = nodeId;
    this.taskId = taskId;
  }
}

function normalizedSelection(task: TaskNodeOccupationSource): TaskNodeSelection {
  return normalizeTaskNodeSelection({
    workNodeIds: task.workNodeIds,
    contextNodeIds: task.contextNodeIds,
  });
}

export function taskOccupiesNode(task: TaskNodeOccupationSource, nodeId: string): boolean {
  return isActiveTaskState(task.state) && normalizedSelection(task).workNodeIds.includes(nodeId);
}

export function taskReadsNode(task: TaskNodeOccupationSource, nodeId: string): boolean {
  return normalizedSelection(task).contextNodeIds.includes(nodeId);
}

export function listActiveTaskOccupants<T extends TaskNodeOccupationSource>(
  nodeId: string,
  tasks: readonly T[]
): T[] {
  return tasks
    .filter((task) => taskOccupiesNode(task, nodeId))
    .sort((left, right) => {
      const created = (left.createdAt || "").localeCompare(right.createdAt || "");
      if (created !== 0) return created;
      const id = left.id.localeCompare(right.id);
      if (id !== 0) return id;
      return (left.path || "").localeCompare(right.path || "");
    });
}

export function assertTaskWorkNodesAvailable(
  selection: TaskNodeSelection,
  tasks: readonly TaskNodeOccupationSource[],
  ignoreTaskId?: string
): void {
  const normalized = normalizeTaskNodeSelection(selection);
  for (const nodeId of normalized.workNodeIds) {
    const occupant = listActiveTaskOccupants(
      nodeId,
      tasks.filter((task) => task.id !== ignoreTaskId)
    )[0];
    if (occupant) throw new TaskNodeOccupiedError(nodeId, occupant.id);
  }
}
