import {
  normalizeTaskNodeContext,
  type TaskNodeContext,
} from "./task-node-context.js";

export const TASK_CONTEXT_CARD_SCHEMA_VERSION = "v3" as const;

export type TaskContextCard = TaskNodeContext & {
  schemaVersion: typeof TASK_CONTEXT_CARD_SCHEMA_VERSION;
  contextGeneration?: string;
};

export type BuildTaskContextCardInput = TaskNodeContext & {
  contextGeneration?: string;
};

export class TaskContextCardSchemaError extends Error {
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TaskContextCardSchemaError";
    this.cause = cause;
  }
}

export function normalizeTaskContextCard(value: unknown): TaskContextCard {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskContextCardSchemaError("Task Context Card must be an object.");
  }
  const record = value as Record<string, unknown>;
  const expected = new Set([
    "schemaVersion",
    "nodeIds",
    "nodeSnapshots",
    "contextGeneration",
  ]);
  if (Object.keys(record).some((key) => !expected.has(key))) {
    throw new TaskContextCardSchemaError("Task Context Card contains retired or unknown fields.");
  }
  if (record.schemaVersion !== TASK_CONTEXT_CARD_SCHEMA_VERSION) {
    throw new TaskContextCardSchemaError(
      `Task Context Card schemaVersion must be ${TASK_CONTEXT_CARD_SCHEMA_VERSION}.`
    );
  }
  if (
    record.contextGeneration !== undefined &&
    (typeof record.contextGeneration !== "string" ||
      !/^cg-v1-[a-f0-9]{64}$/.test(record.contextGeneration))
  ) {
    throw new TaskContextCardSchemaError(
      "Task Context Card contextGeneration must be a canonical cg-v1 digest when present."
    );
  }
  try {
    const nodeContext = normalizeTaskNodeContext({
      nodeIds: record.nodeIds,
      nodeSnapshots: record.nodeSnapshots,
    });
    return {
      schemaVersion: TASK_CONTEXT_CARD_SCHEMA_VERSION,
      ...nodeContext,
      ...(record.contextGeneration !== undefined
        ? { contextGeneration: record.contextGeneration }
        : {}),
    };
  } catch (error) {
    throw new TaskContextCardSchemaError(
      error instanceof Error ? error.message : "Invalid Task Node context.",
      error
    );
  }
}

export function buildTaskContextCardRecord(input: BuildTaskContextCardInput): TaskContextCard {
  const nodeContext = normalizeTaskNodeContext({
    nodeIds: input.nodeIds,
    nodeSnapshots: input.nodeSnapshots,
  });
  return normalizeTaskContextCard({
    schemaVersion: TASK_CONTEXT_CARD_SCHEMA_VERSION,
    ...nodeContext,
    ...(input.contextGeneration ? { contextGeneration: input.contextGeneration } : {}),
  });
}

export function serializeTaskContextCard(card: TaskContextCard): Record<string, unknown> {
  const normalized = normalizeTaskContextCard(card);
  return {
    schemaVersion: normalized.schemaVersion,
    nodeIds: [...normalized.nodeIds],
    nodeSnapshots: normalized.nodeSnapshots.map((snapshot) => ({
      ...snapshot,
      tags: [...snapshot.tags],
    })),
    ...(normalized.contextGeneration
      ? { contextGeneration: normalized.contextGeneration }
      : {}),
  };
}

export function formatTaskContextCardMarkdown(card: TaskContextCard): string {
  const normalized = normalizeTaskContextCard(card);
  const lines = [
    "Tent Task Context Card v3",
    `nodeIds: ${normalized.nodeIds.join(", ") || "(none)"}`,
    ...(normalized.contextGeneration
      ? [`contextGeneration: ${normalized.contextGeneration}`]
      : []),
  ];
  for (const snapshot of normalized.nodeSnapshots) {
    lines.push(
      "",
      `--- Node ${snapshot.id} ---`,
      `path: ${snapshot.path}`,
      `type: ${snapshot.type}`,
      `archived: ${snapshot.archived ? "true" : "false"}`,
      `tags: ${snapshot.tags.join(", ") || "(none)"}`,
      `etag: ${snapshot.etag}`,
      "body:",
      snapshot.body
    );
  }
  return lines.join("\n").trimEnd();
}
