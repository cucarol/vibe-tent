import { isNodeId } from "./id.js";
import {
  orderedTaskNodeIds,
  type TaskNodeSelection,
} from "./task-node-selection.js";
import type { Node } from "./types.js";

export type TaskNodeSnapshot = {
  id: string;
  path: string;
  type: string;
  tags: string[];
  archived: boolean;
  body: string;
  etag: string;
};

export class TaskNodeSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskNodeSnapshotError";
  }
}

function normalizeNodePath(value: string): string {
  const path = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !path ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new TaskNodeSnapshotError("Task Node snapshot path must be a canonical relative Node path.");
  }
  return path;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TaskNodeSnapshotError("Task Node snapshot tags must be an array.");
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new TaskNodeSnapshotError("Task Node snapshot tags must contain non-empty strings.");
    }
    const tag = item.trim();
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export function normalizeTaskNodeSnapshot(value: unknown): TaskNodeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskNodeSnapshotError("Task Node snapshot must be an object.");
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(["id", "path", "type", "tags", "archived", "body", "etag"]);
  if (Object.keys(record).some((key) => !expected.has(key))) {
    throw new TaskNodeSnapshotError("Task Node snapshot contains unknown fields.");
  }
  if (
    typeof record.id !== "string" ||
    record.id !== record.id.trim() ||
    record.id !== record.id.toLowerCase() ||
    !isNodeId(record.id)
  ) {
    throw new TaskNodeSnapshotError("Task Node snapshot id must be a canonical cx-* Node id.");
  }
  if (typeof record.path !== "string") {
    throw new TaskNodeSnapshotError("Task Node snapshot path must be a string.");
  }
  if (typeof record.type !== "string" || !record.type.trim()) {
    throw new TaskNodeSnapshotError("Task Node snapshot type must be a non-empty string.");
  }
  if (typeof record.body !== "string") {
    throw new TaskNodeSnapshotError("Task Node snapshot body must be a string.");
  }
  if (typeof record.archived !== "boolean") {
    throw new TaskNodeSnapshotError("Task Node snapshot archived must be a boolean.");
  }
  if (typeof record.etag !== "string" || !/^[a-f0-9]{24}$/.test(record.etag)) {
    throw new TaskNodeSnapshotError("Task Node snapshot etag must be a canonical content etag.");
  }
  return {
    id: record.id.trim(),
    path: normalizeNodePath(record.path),
    type: record.type.trim(),
    tags: normalizeTags(record.tags),
    archived: record.archived,
    body: record.body,
    etag: record.etag,
  };
}

export function captureTaskNodeSnapshot(node: Node, etag: string): TaskNodeSnapshot {
  return normalizeTaskNodeSnapshot({
    id: node.id,
    path: node.path,
    type: node.type,
    tags: node.tags,
    archived: node.archived,
    body: node.body,
    etag,
  });
}

export function normalizeTaskNodeSnapshots(
  value: unknown,
  selection: TaskNodeSelection
): TaskNodeSnapshot[] {
  if (!Array.isArray(value)) {
    throw new TaskNodeSnapshotError("Task Node snapshots must be an array.");
  }
  const snapshots = value.map(normalizeTaskNodeSnapshot);
  const rootIds = orderedTaskNodeIds(selection);
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    if (seen.has(snapshot.id)) {
      throw new TaskNodeSnapshotError(`Task Node snapshots contain duplicate Node id: ${snapshot.id}.`);
    }
    seen.add(snapshot.id);
  }
  if (rootIds.length === 0) {
    if (snapshots.length !== 0) {
      throw new TaskNodeSnapshotError(
        "Prompt-only Task Node snapshots must be empty when nodeIds is empty."
      );
    }
    return snapshots;
  }
  const snapshotIndexById = new Map(snapshots.map((snapshot, index) => [snapshot.id, index] as const));
  const rootPaths = new Map<string, string>();
  let previousRootIndex = -1;
  for (const rootId of rootIds) {
    const index = snapshotIndexById.get(rootId);
    if (index === undefined) {
      throw new TaskNodeSnapshotError(
        `Task Node snapshots must include every selected root Node id: ${rootId}.`
      );
    }
    if (index <= previousRootIndex) {
      throw new TaskNodeSnapshotError(
        "Task Node snapshots must preserve the ordered root nodeIds[] sequence."
      );
    }
    rootPaths.set(rootId, snapshots[index]!.path);
    previousRootIndex = index;
  }
  const selectedRootPaths = [...rootPaths.values()];
  for (const snapshot of snapshots) {
    const underSelectedRoot = selectedRootPaths.some(
      (rootPath) => snapshot.path === rootPath || snapshot.path.startsWith(`${rootPath}/`)
    );
    if (!underSelectedRoot) {
      throw new TaskNodeSnapshotError(
        `Task Node snapshots must stay within the selected root subtrees: ${snapshot.path}.`
      );
    }
  }
  return snapshots;
}
