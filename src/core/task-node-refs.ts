// Task Node refs: sole persisted source is Task.contextCard.refs.nodes[].
// Durable cx-* id is authoritative; path is a refreshable hint only.

import { isNodeId } from "./id.js";
import { isActiveTaskState, type TaskState } from "./task-model.js";
import type {
  TaskContextCardRef,
  TaskContextCardV1,
} from "./task-context-card.js";

/**
 * Fields needed to resolve Node refs without importing TaskEnvelope (avoids cycles).
 * Runtime occupation / collaboration reads only contextCard.refs.nodes.
 */
export type ContextCardNodeRefSource = {
  path?: string;
  id?: string;
  createdAt?: string;
  state: TaskState;
  contextCard:
    | TaskContextCardV1
    | {
        refs?: {
          nodes?: TaskContextCardRef[] | null;
        } | null;
      }
    | null;
};

/** Normalize one canonical cx-* Node ref; fake root and arbitrary ids are invalid. */
export function normalizeContextCardNodeRef(raw: {
  id: string;
  path?: string;
  revision?: string;
}): TaskContextCardRef {
  const id = raw.id.trim();
  if (!isNodeId(id)) {
    throw new Error(`Task node ref id must be a canonical cx-* Node id; got ${JSON.stringify(id)}.`);
  }
  const out: TaskContextCardRef = { id };
  if (typeof raw.path === "string" && raw.path.trim()) {
    out.path = raw.path.trim().replace(/\\/g, "/");
  }
  if (typeof raw.revision === "string" && raw.revision.trim()) {
    out.revision = raw.revision.trim();
  }
  return out;
}

/** Parse refs.nodes from a Context Card object and reject non-canonical identities. */
export function parseContextCardNodeRefs(value: unknown): TaskContextCardRef[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("Task.contextCard.refs.nodes must be an array.");
  }
  const out: TaskContextCardRef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Task.contextCard.refs.nodes[${i}] must be an object with id.`);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string") {
      throw new Error(`Task.contextCard.refs.nodes[${i}].id must be a canonical cx-* Node id.`);
    }
    const ref = normalizeContextCardNodeRef({
      id: rec.id,
      path: typeof rec.path === "string" ? rec.path : undefined,
      revision: typeof rec.revision === "string" ? rec.revision : undefined,
    });
    if (seen.has(ref.id)) {
      throw new Error(`Task.contextCard.refs.nodes contains duplicate Node id: ${ref.id}.`);
    }
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}

export const MISSING_CONTEXT_CARD_NODES =
  "MISSING_CONTEXT_CARD: Task.contextCard.refs.nodes is required.";

/** Authoritative exact Node ids referenced by a Task. */
export function taskReferencedNodeIds(task: ContextCardNodeRefSource): string[] {
  const label = task.id || task.path || "(unknown)";
  if (task.contextCard == null) {
    throw new Error(`${MISSING_CONTEXT_CARD_NODES} task=${label}`);
  }
  const nodes = task.contextCard.refs?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(`${MISSING_CONTEXT_CARD_NODES} task=${label}`);
  }
  const refs = parseContextCardNodeRefs(nodes);
  if (refs.length === 0) {
    throw new Error(`${MISSING_CONTEXT_CARD_NODES} task=${label} requires at least one Node.`);
  }
  return refs.map((node) => node.id);
}

export function taskDirectlyReferencesNode(task: ContextCardNodeRefSource, nodeId: string): boolean {
  if (!isNodeId(nodeId)) return false;
  return taskReferencedNodeIds(task).includes(nodeId);
}

function taskIsActiveOccupation(task: ContextCardNodeRefSource): boolean {
  return isActiveTaskState(task.state);
}

/** Active Tasks that directly reference nodeId, deterministic order. */
export function listDirectActiveTasksForNode<T extends ContextCardNodeRefSource>(
  nodeId: string,
  tasks: readonly T[]
): T[] {
  const matches = tasks.filter((task) => {
    if (!taskIsActiveOccupation(task)) return false;
    return taskDirectlyReferencesNode(task, nodeId);
  });
  return sortTasksDeterministically(matches);
}

export function sortTasksDeterministically<T extends ContextCardNodeRefSource>(tasks: readonly T[]): T[] {
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
