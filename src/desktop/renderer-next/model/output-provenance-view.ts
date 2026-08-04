import type {
  OutputProvenance,
  OutputProvenanceIncompleteReason,
} from "../../../service/types.js";

const INCOMPLETE_REASONS = new Set<OutputProvenanceIncompleteReason>([
  "delivery_missing",
  "task_missing",
  "source_missing",
  "mismatch",
]);

export type OutputProvenanceView =
  | { state: "not-output" }
  | { state: "loading" }
  | { state: "stale"; message: string }
  | { state: "error"; message: string }
  | { state: "ready"; value: OutputProvenance };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableRecord(value: unknown): boolean {
  return value === null || isRecord(value);
}

export function normalizeOutputProvenance(
  raw: unknown,
  expectedWorkspaceId: string,
  expectedOutputId: string
): OutputProvenanceView {
  if (!isRecord(raw)) {
    return { state: "error", message: "output.provenance payload is not an object" };
  }
  if (
    raw.workspaceId !== expectedWorkspaceId ||
    raw.outputId !== expectedOutputId ||
    typeof raw.path !== "string" ||
    typeof raw.bound !== "boolean" ||
    !(raw.deliveryId === null || (typeof raw.deliveryId === "string" && raw.deliveryId)) ||
    !isNullableRecord(raw.delivery) ||
    !isNullableRecord(raw.task) ||
    !isNullableRecord(raw.sourceNode) ||
    !Array.isArray(raw.incomplete) ||
    raw.incomplete.some(
      (reason) =>
        typeof reason !== "string" ||
        !INCOMPLETE_REASONS.has(reason as OutputProvenanceIncompleteReason)
    )
  ) {
    return { state: "error", message: "output.provenance identity or payload is corrupt" };
  }
  if ((raw.bound && !raw.deliveryId) || (!raw.bound && raw.deliveryId !== null)) {
    return { state: "error", message: "output.provenance binding pointer is corrupt" };
  }

  const delivery = raw.delivery;
  if (
    isRecord(delivery) &&
    (typeof delivery.id !== "string" ||
      !delivery.id ||
      delivery.id !== raw.deliveryId ||
      typeof delivery.status !== "string" ||
      !delivery.status ||
      typeof delivery.taskId !== "string" ||
      !delivery.taskId ||
      typeof delivery.sourceNodeId !== "string" ||
      !delivery.sourceNodeId)
  ) {
    return { state: "error", message: "output.provenance delivery join is corrupt" };
  }

  const task = raw.task;
  if (
    isRecord(task) &&
    (typeof task.id !== "string" ||
      !task.id ||
      typeof task.state !== "string" ||
      !task.state ||
      !(task.path === undefined || typeof task.path === "string") ||
      (isRecord(delivery) && task.id !== delivery.taskId))
  ) {
    return { state: "error", message: "output.provenance task join is corrupt" };
  }

  const sourceNode = raw.sourceNode;
  if (
    isRecord(sourceNode) &&
    (typeof sourceNode.nodeId !== "string" ||
      !sourceNode.nodeId ||
      !(sourceNode.path === undefined || typeof sourceNode.path === "string") ||
      !(sourceNode.type === undefined || typeof sourceNode.type === "string") ||
      !(sourceNode.archived === undefined || typeof sourceNode.archived === "boolean") ||
      (isRecord(delivery) && sourceNode.nodeId !== delivery.sourceNodeId))
  ) {
    return { state: "error", message: "output.provenance source Node join is corrupt" };
  }

  return { state: "ready", value: raw as OutputProvenance };
}
