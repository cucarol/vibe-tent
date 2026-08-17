import { isNodeId } from "./id.js";

export type TaskNodeSelection = {
  nodeIds: string[];
};

export class TaskNodeSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskNodeSelectionError";
  }
}

function normalizeNodeIds(value: unknown, field: keyof TaskNodeSelection): string[] {
  if (!Array.isArray(value)) {
    throw new TaskNodeSelectionError(`Task ${field} must be an array.`);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item !== item.trim() ||
      item !== item.toLowerCase() ||
      !isNodeId(item)
    ) {
      throw new TaskNodeSelectionError(
        `Task ${field} must contain canonical lowercase cx-* Node ids.`
      );
    }
    if (seen.has(item)) {
      throw new TaskNodeSelectionError(`Task ${field} contains duplicate Node id: ${item}.`);
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

export function normalizeTaskNodeSelection(value: unknown): TaskNodeSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskNodeSelectionError("Task Node selection must be an object.");
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(["nodeIds"]);
  if (Object.keys(record).some((key) => !expected.has(key))) {
    throw new TaskNodeSelectionError("Task Node selection contains unknown fields.");
  }
  const nodeIds = normalizeNodeIds(record.nodeIds, "nodeIds");
  return { nodeIds };
}

export function orderedTaskNodeIds(selection: TaskNodeSelection): string[] {
  const normalized = normalizeTaskNodeSelection(selection);
  return [...normalized.nodeIds];
}

export function taskReferencesNode(selection: TaskNodeSelection, nodeId: string): boolean {
  return orderedTaskNodeIds(selection).includes(nodeId);
}
