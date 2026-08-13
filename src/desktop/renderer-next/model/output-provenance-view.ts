import type {
  OutputProvenance,
  OutputProvenanceIncompleteReason,
} from "../../../service/types.js";
import type { ArtifactKind, ArtifactRef } from "../../../core/artifact.js";

const INCOMPLETE_REASONS = new Set<OutputProvenanceIncompleteReason>([
  "result_missing",
  "task_missing",
  "source_missing",
  "mismatch",
]);

const ARTIFACT_KINDS = new Set<ArtifactKind>(["path", "directory", "commit", "url"]);

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

function canonicalArtifactRefs(value: unknown): ArtifactRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs: ArtifactRef[] = [];
  let previous: ArtifactRef | null = null;
  for (const item of value) {
    if (
      !isRecord(item) ||
      Object.keys(item).some((key) => key !== "kind" && key !== "target" && key !== "label") ||
      typeof item.kind !== "string" ||
      !ARTIFACT_KINDS.has(item.kind as ArtifactKind) ||
      typeof item.target !== "string" ||
      !(item.label === undefined || typeof item.label === "string")
    ) {
      return null;
    }
    const kind = item.kind as ArtifactKind;
    const target = item.target;
    const label = item.label;
    if (label !== undefined && (!label || label !== label.trim())) return null;
    if (kind === "path" || kind === "directory") {
      if (
        !target ||
        target !== target.trim() ||
        target.includes("\\") ||
        target.includes("\0") ||
        target.startsWith("/") ||
        /^[a-zA-Z]:/.test(target) ||
        target.split("/").some((segment) => !segment || segment === "." || segment === "..")
      ) {
        return null;
      }
    } else if (kind === "commit") {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(target)) return null;
    } else {
      try {
        const parsed = new URL(target);
        if (
          (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
          parsed.username ||
          parsed.password ||
          parsed.href !== target
        ) {
          return null;
        }
      } catch {
        return null;
      }
    }
    const ref: ArtifactRef = { kind, target, ...(label === undefined ? {} : { label }) };
    if (
      previous &&
      (previous.kind > ref.kind ||
        (previous.kind === ref.kind && previous.target >= ref.target))
    ) {
      return null;
    }
    refs.push(ref);
    previous = ref;
  }
  return refs;
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
    !(raw.resultId === null || (typeof raw.resultId === "string" && raw.resultId)) ||
    !isNullableRecord(raw.result) ||
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
  if ((raw.bound && !raw.resultId) || (!raw.bound && raw.resultId !== null)) {
    return { state: "error", message: "output.provenance binding pointer is corrupt" };
  }

  const result = raw.result;
  const artifactRefs = isRecord(result) ? canonicalArtifactRefs(result.artifactRefs) : null;
  if (
    isRecord(result) &&
    (typeof result.id !== "string" ||
      !result.id ||
      result.id !== raw.resultId ||
      typeof result.status !== "string" ||
      !result.status ||
      typeof result.taskId !== "string" ||
      !result.taskId ||
      artifactRefs === null)
  ) {
    return { state: "error", message: "output.provenance result join is corrupt" };
  }

  const task = raw.task;
  if (
    isRecord(task) &&
    (typeof task.id !== "string" ||
      !task.id ||
      typeof task.state !== "string" ||
      !task.state ||
      !(task.path === undefined || typeof task.path === "string") ||
      (isRecord(result) && task.id !== result.taskId))
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
      !(sourceNode.archived === undefined || typeof sourceNode.archived === "boolean"))
  ) {
    return { state: "error", message: "output.provenance source Node is corrupt" };
  }

  const value = raw as unknown as OutputProvenance;
  return {
    state: "ready",
    value: isRecord(result)
      ? { ...value, result: { ...value.result!, artifactRefs: artifactRefs! } }
      : value,
  };
}
