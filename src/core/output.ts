// Output Node helpers: V0.2 provenance through one exact Delivery id.
// Authoritative link is Output frontmatter `deliveryId` only — no taskId/sourceNodeId denorm,
// artifactRefs copy, or generic relation substitute (Canvas P0 / cx-f2kxd4).

import type { FsAdapter } from "./adapter.js";
import type { ArtifactRef } from "./artifact.js";
import { loadDeliveries, type DeliveryRecord } from "./delivery.js";
import { NODE_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { loadTaskEnvelopes, type TaskEnvelope } from "./task.js";
import { isDeliveryId } from "./task-model.js";
import { nodeNotePath, loadTent, type LoadedTent } from "./tree.js";
import type { Node } from "./types.js";
import { splitType } from "./typeRegistry.js";

/** Reserved Output provenance field — only formal accept/bind may write. */
export const OUTPUT_PROVENANCE_FIELD = "deliveryId" as const;

export type OutputProvenanceErrorCode =
  | "OUTPUT_NOT_FOUND"
  | "OUTPUT_INVALID"
  | "OUTPUT_ARCHIVED"
  | "OUTPUT_NOT_OUTPUT_TYPE"
  | "OUTPUT_ALREADY_BOUND"
  | "INVALID_DELIVERY_ID"
  | "INVALID_SELECTOR"
  /** Compensating restore of Output raw snapshots failed after a bind/accept error. */
  | "BIND_ROLLBACK_FAILED";

export class OutputProvenanceError extends Error {
  code: OutputProvenanceErrorCode;
  details?: Record<string, unknown>;
  constructor(
    code: OutputProvenanceErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.name = "OutputProvenanceError";
    this.details = details;
  }
}

/** Live join half of Output → Delivery → Task → sourceNode (ids only; never path inference). */
export type OutputProvenanceLive = {
  delivery: {
    id: string;
    status: string;
    taskId: string;
    sourceNodeId: string;
    artifactRefs: ArtifactRef[];
  } | null;
  task: { id: string; state: string; path?: string } | null;
  sourceNode: { nodeId: string; path?: string; type?: string; archived?: boolean } | null;
};

export type OutputProvenanceIncompleteReason =
  | "delivery_missing"
  | "task_missing"
  | "source_missing"
  | "mismatch";

/**
 * Read model for `output.provenance`.
 * Unbound Output: bound=false, deliveryId=null, live halves null, incomplete empty.
 * Bound + missing heat records: FM deliveryId kept; live null + incomplete reasons.
 */
export type OutputProvenance = {
  workspaceId?: string;
  outputId: string;
  path: string;
  bound: boolean;
  /** Authoritative FM link; null when unbound. */
  deliveryId: string | null;
  delivery: OutputProvenanceLive["delivery"];
  task: OutputProvenanceLive["task"];
  sourceNode: OutputProvenanceLive["sourceNode"];
  incomplete: OutputProvenanceIncompleteReason[];
};

/** True when primary type base is `output` (including `output-asset`, …). */
export function isOutputPrimaryType(type: string | undefined | null): boolean {
  if (!type || typeof type !== "string") return false;
  return splitType(type).base === "output";
}

/** Read authoritative deliveryId from Output frontmatter; undefined when unbound / empty. */
export function readOutputDeliveryId(fm: Record<string, unknown>): string | undefined {
  const raw = fm[OUTPUT_PROVENANCE_FIELD];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

/**
 * Collect every non-empty deliveryId on Output Nodes (including archived).
 * Used by operational retention to pin referenced Delivery + Task groups.
 */
export function collectReferencedDeliveryIds(tent: LoadedTent): Set<string> {
  const out = new Set<string>();
  for (const node of tent.byId.values()) {
    const deliveryId = readOutputDeliveryId(node.fm as Record<string, unknown>);
    if (deliveryId && isDeliveryId(deliveryId)) out.add(deliveryId);
  }
  return out;
}

/**
 * Validate one Output for binding to `deliveryId` without writing.
 * Unbound or already bound to the same id → ok (idempotent).
 * Bound to a different id → OUTPUT_ALREADY_BOUND.
 */
export function assertOutputBindable(
  node: Node,
  deliveryId: string
): { alreadyBound: boolean } {
  if (!node.id) {
    throw new OutputProvenanceError("OUTPUT_INVALID", `Output has no id: ${node.path}`);
  }
  if (node.invalid) {
    throw new OutputProvenanceError(
      "OUTPUT_INVALID",
      `Output is invalid: ${node.path}`,
      { outputId: node.id, detail: node.invalidReason }
    );
  }
  if (node.archived || node.mode === "archived") {
    throw new OutputProvenanceError(
      "OUTPUT_ARCHIVED",
      `Output is archived and cannot bind provenance: ${node.id}`,
      { outputId: node.id }
    );
  }
  if (!isOutputPrimaryType(node.type)) {
    throw new OutputProvenanceError(
      "OUTPUT_NOT_OUTPUT_TYPE",
      `Node primary type must be output to bind provenance (got ${node.type}): ${node.id}`,
      { outputId: node.id, type: node.type }
    );
  }
  if (!isDeliveryId(deliveryId)) {
    throw new OutputProvenanceError(
      "INVALID_DELIVERY_ID",
      `Invalid delivery id for provenance bind: ${deliveryId}`
    );
  }
  const existing = readOutputDeliveryId(node.fm as Record<string, unknown>);
  if (existing && existing !== deliveryId) {
    throw new OutputProvenanceError(
      "OUTPUT_ALREADY_BOUND",
      `Output ${node.id} is already bound to ${existing}; cannot rebind to ${deliveryId}`,
      { outputId: node.id, existingDeliveryId: existing, deliveryId }
    );
  }
  return { alreadyBound: existing === deliveryId };
}

/**
 * All-or-nothing validate of outputNodeIds for accept binding.
 * Dedupes ids; empty/undefined → no-op list.
 */
export function validateOutputBindingsForAccept(
  tent: LoadedTent,
  outputNodeIds: readonly string[] | undefined,
  deliveryId: string
): { outputIds: string[]; nodes: Node[] } {
  if (!outputNodeIds || outputNodeIds.length === 0) {
    return { outputIds: [], nodes: [] };
  }
  if (!isDeliveryId(deliveryId)) {
    throw new OutputProvenanceError(
      "INVALID_DELIVERY_ID",
      `Invalid delivery id for provenance bind: ${deliveryId}`
    );
  }
  const seen = new Set<string>();
  const outputIds: string[] = [];
  const nodes: Node[] = [];
  for (const raw of outputNodeIds) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new OutputProvenanceError(
        "INVALID_SELECTOR",
        "outputNodeIds entries must be non-empty Node ids"
      );
    }
    const id = raw.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    if (tent.duplicateIds.has(id)) {
      throw new OutputProvenanceError(
        "OUTPUT_INVALID",
        `Duplicate node id '${id}' found; repair before binding provenance.`,
        { outputId: id }
      );
    }
    const node = tent.byId.get(id);
    if (!node) {
      throw new OutputProvenanceError("OUTPUT_NOT_FOUND", `Output Node not found: ${id}`, {
        outputId: id,
      });
    }
    assertOutputBindable(node, deliveryId);
    outputIds.push(id);
    nodes.push(node);
  }
  return { outputIds, nodes };
}

/**
 * Pre-write snapshot of an Output identity file for compensating rollback.
 * Restoring `raw` is the sole authority for undoing a partial bind.
 */
export type OutputBindSnapshot = {
  outputId: string;
  notePath: string;
  raw: string;
  node: Node;
  previousDeliveryId: string | undefined;
};

/**
 * Restore Output identity files from raw snapshots (mutation-lock caller).
 * Fail-loud if any restore write fails — partial provenance must not remain silent.
 */
export async function restoreOutputBindSnapshots(
  fs: FsAdapter,
  snapshots: readonly OutputBindSnapshot[]
): Promise<void> {
  if (snapshots.length === 0) return;
  const failures: Array<{ outputId: string; notePath: string; error: string }> = [];
  // Restore in reverse write order (last written first).
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snap = snapshots[i];
    try {
      await fs.writeFile(snap.notePath, snap.raw);
      const prev = snap.previousDeliveryId;
      if (prev === undefined) {
        delete (snap.node.fm as Record<string, unknown>)[OUTPUT_PROVENANCE_FIELD];
      } else {
        (snap.node.fm as Record<string, unknown>)[OUTPUT_PROVENANCE_FIELD] = prev;
      }
    } catch (err) {
      failures.push({
        outputId: snap.outputId,
        notePath: snap.notePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (failures.length > 0) {
    throw new OutputProvenanceError(
      "BIND_ROLLBACK_FAILED",
      `Failed to roll back Output provenance bind for ${failures.length} file(s); disk may be partially bound.`,
      { failures }
    );
  }
}

/**
 * Bind many Outputs to one Delivery after full validation (accept final mutation).
 *
 * Cross-file atomicity via compensating rollback:
 * 1) validate all
 * 2) snapshot original raw for every file that will change
 * 3) write each deliveryId
 * 4) on any write failure, restore all prior snapshots (fail loud if restore fails)
 *
 * Idempotent same-delivery binds do not write and are not snapshotted.
 * `snapshots` is returned so outer accept can roll back if Delivery/Task persistence fails later.
 */
export async function bindOutputsToDeliveryUnlocked(
  fs: FsAdapter,
  tent: LoadedTent,
  outputNodeIds: readonly string[] | undefined,
  deliveryId: string
): Promise<{
  boundIds: string[];
  changedIds: string[];
  snapshots: OutputBindSnapshot[];
}> {
  const { outputIds, nodes } = validateOutputBindingsForAccept(tent, outputNodeIds, deliveryId);

  type Planned = {
    node: Node;
    outputId: string;
    notePath: string;
    raw: string;
    previousDeliveryId: string | undefined;
  };
  const planned: Planned[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const outputId = outputIds[i];
    const { alreadyBound } = assertOutputBindable(node, deliveryId);
    if (alreadyBound) continue;
    const notePath = nodeNotePath(node.path);
    const raw = await fs.readFile(notePath);
    planned.push({
      node,
      outputId,
      notePath,
      raw,
      previousDeliveryId: readOutputDeliveryId(node.fm as Record<string, unknown>),
    });
  }

  const snapshots: OutputBindSnapshot[] = [];
  const changedIds: string[] = [];

  try {
    for (const item of planned) {
      const { data, body, keyOrder } = parseFrontmatter(item.raw);
      data[OUTPUT_PROVENANCE_FIELD] = deliveryId;
      const nextRaw = serializeFrontmatter(data, body, outputKeyOrder(keyOrder));
      await fs.writeFile(item.notePath, nextRaw);
      // Only record snapshot after a successful write so rollback targets real changes.
      snapshots.push({
        outputId: item.outputId,
        notePath: item.notePath,
        raw: item.raw,
        node: item.node,
        previousDeliveryId: item.previousDeliveryId,
      });
      (item.node.fm as Record<string, unknown>)[OUTPUT_PROVENANCE_FIELD] = deliveryId;
      changedIds.push(item.outputId);
    }
  } catch (err) {
    try {
      await restoreOutputBindSnapshots(fs, snapshots);
    } catch (rollbackErr) {
      if (rollbackErr instanceof OutputProvenanceError) throw rollbackErr;
      throw new OutputProvenanceError(
        "BIND_ROLLBACK_FAILED",
        `Output provenance bind failed and rollback also failed: ${
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        } (original: ${err instanceof Error ? err.message : String(err)})`,
        {
          originalError: err instanceof Error ? err.message : String(err),
        }
      );
    }
    throw err;
  }

  return { boundIds: outputIds, changedIds, snapshots };
}

/**
 * Build Output provenance read model from a resolved Output node + operational indexes.
 * Never infers by path/name/time; missing heat records → incomplete, not invented joins.
 */
export function projectOutputProvenance(
  node: Node,
  indexes: {
    deliveriesById: Map<string, DeliveryRecord>;
    tasksById: Map<string, TaskEnvelope>;
    tent: LoadedTent;
  }
): OutputProvenance {
  if (node.invalid) {
    throw new OutputProvenanceError(
      "OUTPUT_INVALID",
      `Output is invalid: ${node.path}`,
      { outputId: node.id, detail: node.invalidReason }
    );
  }
  if (!isOutputPrimaryType(node.type)) {
    throw new OutputProvenanceError(
      "OUTPUT_NOT_OUTPUT_TYPE",
      `Node primary type must be output for provenance query (got ${node.type}): ${node.id}`,
      { outputId: node.id, type: node.type }
    );
  }

  const deliveryId = readOutputDeliveryId(node.fm as Record<string, unknown>) ?? null;
  const base: OutputProvenance = {
    outputId: node.id,
    path: node.path,
    bound: false,
    deliveryId: null,
    delivery: null,
    task: null,
    sourceNode: null,
    incomplete: [],
  };

  if (!deliveryId) {
    return base;
  }

  base.bound = true;
  base.deliveryId = deliveryId;

  if (!isDeliveryId(deliveryId)) {
    base.incomplete.push("delivery_missing");
    return base;
  }

  const delivery = indexes.deliveriesById.get(deliveryId);
  if (!delivery) {
    base.incomplete.push("delivery_missing");
    // Without live Delivery we cannot walk Task/source by id-only authority.
    return base;
  }

  base.delivery = {
    id: delivery.id,
    status: delivery.status,
    taskId: delivery.taskId,
    sourceNodeId: delivery.sourceNodeId,
    artifactRefs: delivery.artifactRefs.map((ref) => ({ ...ref })),
  };

  const task = indexes.tasksById.get(delivery.taskId);

  if (!task) {
    base.incomplete.push("task_missing");
  } else {
    base.task = {
      id: task.id || task.path,
      state: task.state,
      path: task.path,
    };
    // Lightweight consistency: delivery.taskId should match task identity when both exist.
    const taskKey = task.id || task.path;
    if (delivery.taskId && taskKey && delivery.taskId !== taskKey && delivery.taskId !== task.path) {
      if (!base.incomplete.includes("mismatch")) base.incomplete.push("mismatch");
    }
    if (!task.workNodeIds.includes(delivery.sourceNodeId)) {
      if (!base.incomplete.includes("mismatch")) base.incomplete.push("mismatch");
    }
  }

  const sourceId = delivery.sourceNodeId.trim();
  if (!sourceId) {
    base.incomplete.push("source_missing");
  } else {
    const source = indexes.tent.byId.get(sourceId);
    if (!source) {
      base.incomplete.push("source_missing");
      base.sourceNode = { nodeId: sourceId };
    } else {
      base.sourceNode = {
        nodeId: source.id,
        path: source.path,
        type: source.type,
        archived: source.archived || source.mode === "archived",
      };
    }
  }

  return base;
}

/** Load operational indexes once for provenance joins. */
export async function loadProvenanceIndexes(
  fs: FsAdapter,
  tent?: LoadedTent
): Promise<{
  tent: LoadedTent;
  deliveriesById: Map<string, DeliveryRecord>;
  tasksById: Map<string, TaskEnvelope>;
}> {
  const loadedTent = tent ?? (await loadTent(fs));
  const deliveries = await loadDeliveries(fs);
  const tasks = await loadTaskEnvelopes(fs);
  const deliveriesById = new Map<string, DeliveryRecord>();
  for (const d of deliveries) deliveriesById.set(d.id, d);
  const tasksById = new Map<string, TaskEnvelope>();
  for (const t of tasks) {
    if (t.id) tasksById.set(t.id, t);
  }
  return { tent: loadedTent, deliveriesById, tasksById };
}

/**
 * Resolve Output by its canonical Node id, then project provenance.
 * Archived Outputs remain readable.
 */
export async function resolveOutputProvenance(
  fs: FsAdapter,
  selector: { nodeId: string },
  preloaded?: {
    tent: LoadedTent;
    deliveriesById: Map<string, DeliveryRecord>;
    tasksById: Map<string, TaskEnvelope>;
  }
): Promise<OutputProvenance> {
  const indexes = preloaded ?? (await loadProvenanceIndexes(fs));
  const node = resolveOutputNode(indexes.tent, selector);
  return projectOutputProvenance(node, indexes);
}

export function resolveOutputNode(
  tent: LoadedTent,
  selector: { nodeId: string }
): Node {
  const nodeId = selector.nodeId.trim();
  if (!nodeId) {
    throw new OutputProvenanceError("INVALID_SELECTOR", "output.provenance requires nodeId");
  }
  if (tent.duplicateIds.has(nodeId)) {
    throw new OutputProvenanceError(
      "OUTPUT_INVALID",
      `Duplicate Node id '${nodeId}' found; repair before provenance query.`,
      { nodeId }
    );
  }
  const node = tent.byId.get(nodeId);
  if (!node) {
    throw new OutputProvenanceError("OUTPUT_NOT_FOUND", `Output Node not found: ${nodeId}`, {
      nodeId,
    });
  }
  return node;
}

function outputKeyOrder(existing: string[]): string[] {
  const preferred = [...NODE_FRONTMATTER_KEY_ORDER, OUTPUT_PROVENANCE_FIELD];
  return [
    ...preferred,
    ...existing.filter((key) => !preferred.includes(key)),
  ];
}
