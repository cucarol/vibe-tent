import {
  normalizeTaskNodeSelection,
  type TaskNodeSelection,
} from "./task-node-selection.js";
import {
  normalizeTaskNodeSnapshots,
  type TaskNodeSnapshot,
} from "./task-node-snapshot.js";

export type TaskNodeContext = TaskNodeSelection & {
  nodeSnapshots: TaskNodeSnapshot[];
};

export class TaskNodeContextError extends Error {
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TaskNodeContextError";
    this.cause = cause;
  }
}

export function normalizeTaskNodeContext(value: unknown): TaskNodeContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskNodeContextError("Task Node context must be an object.");
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(["workNodeIds", "contextNodeIds", "nodeSnapshots"]);
  if (Object.keys(record).some((key) => !expected.has(key))) {
    throw new TaskNodeContextError("Task Node context contains unknown fields.");
  }
  try {
    const selection = normalizeTaskNodeSelection({
      workNodeIds: record.workNodeIds,
      contextNodeIds: record.contextNodeIds,
    });
    return {
      ...selection,
      nodeSnapshots: normalizeTaskNodeSnapshots(record.nodeSnapshots, selection),
    };
  } catch (error) {
    throw new TaskNodeContextError(
      error instanceof Error ? error.message : "Invalid Task Node context.",
      error
    );
  }
}
