import {
  normalizeTaskNodeContext,
  type TaskNodeContext,
} from "./task-node-context.js";
import { canonicalSha256 } from "./canonical-digest.js";

export const TASK_CONTEXT_CARD_SCHEMA_VERSION = "v2" as const;

export type TaskContextCard = TaskNodeContext & {
  schemaVersion: typeof TASK_CONTEXT_CARD_SCHEMA_VERSION;
  contextGeneration?: string;
  taskDeltaDigest: string;
};

export type BuildTaskContextCardInput = TaskNodeContext & {
  contextGeneration?: string;
  userPrompt: string;
  taskInputDelta?: string;
  checkpoint?: string;
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
    "workNodeIds",
    "contextNodeIds",
    "nodeSnapshots",
    "contextGeneration",
    "taskDeltaDigest",
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
  if (typeof record.taskDeltaDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.taskDeltaDigest)) {
    throw new TaskContextCardSchemaError(
      "Task Context Card taskDeltaDigest must be a lowercase sha256 digest."
    );
  }
  try {
    const nodeContext = normalizeTaskNodeContext({
      workNodeIds: record.workNodeIds,
      contextNodeIds: record.contextNodeIds,
      nodeSnapshots: record.nodeSnapshots,
    });
    return {
      schemaVersion: TASK_CONTEXT_CARD_SCHEMA_VERSION,
      ...nodeContext,
      ...(record.contextGeneration !== undefined
        ? { contextGeneration: record.contextGeneration }
        : {}),
      taskDeltaDigest: record.taskDeltaDigest,
    };
  } catch (error) {
    throw new TaskContextCardSchemaError(
      error instanceof Error ? error.message : "Invalid Task Node context.",
      error
    );
  }
}

export function computeTaskContextCardDeltaDigest(input: {
  nodeContext: TaskNodeContext;
  userPrompt: string;
  taskInputDelta?: string;
  checkpoint?: string;
}): string {
  const nodeContext = normalizeTaskNodeContext({
    workNodeIds: input.nodeContext.workNodeIds,
    contextNodeIds: input.nodeContext.contextNodeIds,
    nodeSnapshots: input.nodeContext.nodeSnapshots,
  });
  return canonicalSha256({
    schemaVersion: TASK_CONTEXT_CARD_SCHEMA_VERSION,
    ...nodeContext,
    userPrompt: input.userPrompt,
    taskInputDelta: input.taskInputDelta?.trim() || "",
    checkpoint: input.checkpoint?.trim() || "",
  });
}

export function buildTaskContextCardV2(input: BuildTaskContextCardInput): TaskContextCard {
  const nodeContext = normalizeTaskNodeContext({
    workNodeIds: input.workNodeIds,
    contextNodeIds: input.contextNodeIds,
    nodeSnapshots: input.nodeSnapshots,
  });
  return normalizeTaskContextCard({
    schemaVersion: TASK_CONTEXT_CARD_SCHEMA_VERSION,
    ...nodeContext,
    ...(input.contextGeneration ? { contextGeneration: input.contextGeneration } : {}),
    taskDeltaDigest: computeTaskContextCardDeltaDigest({
      nodeContext,
      userPrompt: input.userPrompt,
      taskInputDelta: input.taskInputDelta,
      checkpoint: input.checkpoint,
    }),
  });
}

export function serializeTaskContextCard(card: TaskContextCard): Record<string, unknown> {
  const normalized = normalizeTaskContextCard(card);
  return {
    schemaVersion: normalized.schemaVersion,
    workNodeIds: [...normalized.workNodeIds],
    contextNodeIds: [...normalized.contextNodeIds],
    nodeSnapshots: normalized.nodeSnapshots.map((snapshot) => ({
      ...snapshot,
      tags: [...snapshot.tags],
    })),
    ...(normalized.contextGeneration
      ? { contextGeneration: normalized.contextGeneration }
      : {}),
    taskDeltaDigest: normalized.taskDeltaDigest,
  };
}

export function formatTaskContextCardV2Prompt(card: TaskContextCard): string {
  const normalized = normalizeTaskContextCard(card);
  const work = new Set(normalized.workNodeIds);
  const lines = [
    "Tent Task Context Card v2",
    `workNodeIds: ${normalized.workNodeIds.join(", ")}`,
    `contextNodeIds: ${normalized.contextNodeIds.join(", ") || "(none)"}`,
    ...(normalized.contextGeneration
      ? [`contextGeneration: ${normalized.contextGeneration}`]
      : []),
    `taskDeltaDigest: ${normalized.taskDeltaDigest}`,
  ];
  for (const snapshot of normalized.nodeSnapshots) {
    lines.push(
      "",
      `--- ${work.has(snapshot.id) ? "Work" : "Context"} Node ${snapshot.id} ---`,
      `path: ${snapshot.path}`,
      `type: ${snapshot.type}`,
      `tags: ${snapshot.tags.join(", ") || "(none)"}`,
      `etag: ${snapshot.etag}`,
      "body:",
      snapshot.body
    );
  }
  return lines.join("\n").trimEnd();
}
