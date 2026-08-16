// Output Node helpers: provenance through one exact accepted TaskResult id.
// Authoritative link is Output frontmatter `resultId` only — no taskId/source Node denorm,
// artifactRefs copy, or generic relation substitute (Canvas P0 / cx-f2kxd4).

import { withTentMutation, type FsAdapter } from "./adapter.js";
import type { ArtifactRef } from "./artifact.js";
import { loadTaskResults, type TaskResultRecord } from "./task-result.js";
import { NODE_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { loadTaskRecords, type TaskRecord } from "./task.js";
import { isTaskResultId } from "./task-model.js";
import { nodeNotePath, loadTent, type LoadedTent } from "./tree.js";
import type { Node } from "./types.js";

/** Reserved Output provenance field — not writable through generic Node edits. */
export const OUTPUT_PROVENANCE_FIELD = "resultId" as const;

export type OutputProvenanceErrorCode =
  | "OUTPUT_NOT_FOUND"
  | "OUTPUT_INVALID"
  | "OUTPUT_ARCHIVED"
  | "OUTPUT_NOT_OUTPUT_TYPE"
  | "OUTPUT_ALREADY_BOUND"
  | "INVALID_RESULT_ID"
  | "INVALID_SELECTOR"
  /** Compensating restore of Output raw snapshots failed after a provenance-bind error. */
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

/** Live join half of Output → TaskResult → Task → its first work Node. */
export type OutputProvenanceLive = {
  result: {
    id: string;
    status: string;
    taskId: string;
    artifactRefs: ArtifactRef[];
  } | null;
  task: { id: string; state: string; path?: string } | null;
  sourceNode: { nodeId: string; path?: string; type?: string; archived?: boolean } | null;
};

export type OutputProvenanceIncompleteReason =
  | "result_missing"
  | "task_missing"
  | "source_missing"
  | "mismatch";

/**
 * Read model for `output.provenance`.
 * Unbound Output: bound=false, resultId=null, live halves null, incomplete empty.
 * Bound + missing heat records: FM resultId kept; live null + incomplete reasons.
 */
export type OutputProvenance = {
  workspaceId?: string;
  outputId: string;
  path: string;
  bound: boolean;
  /** Authoritative FM link; null when unbound. */
  resultId: string | null;
  result: OutputProvenanceLive["result"];
  task: OutputProvenanceLive["task"];
  sourceNode: OutputProvenanceLive["sourceNode"];
  incomplete: OutputProvenanceIncompleteReason[];
};

/** Nodes use one ordinary optional type; Output provenance is exact `output`. */
export function isOutputNodeType(type: string | undefined | null): boolean {
  return typeof type === "string" && type.trim() === "output";
}

/** Read authoritative resultId from Output frontmatter; undefined when unbound / empty. */
export function readOutputTaskResultId(fm: Record<string, unknown>): string | undefined {
  const raw = fm[OUTPUT_PROVENANCE_FIELD];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

/**
 * Collect every non-empty resultId on Output Nodes (including archived).
 * Used by operational retention to pin referenced TaskResult + Task groups.
 */
export function collectReferencedTaskResultIds(tent: LoadedTent): Set<string> {
  const out = new Set<string>();
  for (const node of tent.byId.values()) {
    const resultId = readOutputTaskResultId(node.fm as Record<string, unknown>);
    if (resultId && isTaskResultId(resultId)) out.add(resultId);
  }
  return out;
}

/**
 * Validate one Output for binding to `resultId` without writing.
 * Unbound or already bound to the same id → ok (idempotent).
 * Bound to a different id → OUTPUT_ALREADY_BOUND.
 */
export function assertOutputBindable(
  node: Node,
  resultId: string
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
  if (!isOutputNodeType(node.type)) {
    throw new OutputProvenanceError(
      "OUTPUT_NOT_OUTPUT_TYPE",
      `Node type must be output to bind provenance (got ${node.type}): ${node.id}`,
      { outputId: node.id, type: node.type }
    );
  }
  if (!isTaskResultId(resultId)) {
    throw new OutputProvenanceError(
      "INVALID_RESULT_ID",
      `Invalid result id for provenance bind: ${resultId}`
    );
  }
  const existing = readOutputTaskResultId(node.fm as Record<string, unknown>);
  if (existing && existing !== resultId) {
    throw new OutputProvenanceError(
      "OUTPUT_ALREADY_BOUND",
      `Output ${node.id} is already bound to ${existing}; cannot rebind to ${resultId}`,
      { outputId: node.id, existingTaskResultId: existing, resultId }
    );
  }
  return { alreadyBound: existing === resultId };
}

/**
 * All-or-nothing validation for an explicit Result-to-Output update.
 * Dedupes ids; empty/undefined → no-op list.
 */
export function validateOutputResultBinding(
  tent: LoadedTent,
  outputNodeIds: readonly string[] | undefined,
  resultId: string
): { outputIds: string[]; nodes: Node[] } {
  if (!outputNodeIds || outputNodeIds.length === 0) {
    return { outputIds: [], nodes: [] };
  }
  if (!isTaskResultId(resultId)) {
    throw new OutputProvenanceError(
      "INVALID_RESULT_ID",
      `Invalid result id for provenance bind: ${resultId}`
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
    assertOutputBindable(node, resultId);
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
  previousTaskResultId: string | undefined;
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
      const prev = snap.previousTaskResultId;
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
 * Bind many Outputs to one accepted TaskResult after full validation.
 *
 * Cross-file atomicity via compensating rollback:
 * 1) validate all
 * 2) snapshot original raw for every file that will change
 * 3) write each resultId
 * 4) on any write failure, restore all prior snapshots (fail loud if restore fails)
 *
 * Idempotent same-result binds do not write and are not snapshotted.
 * `snapshots` is returned so outer accept can roll back if TaskResult/Task persistence fails later.
 */
export async function bindOutputsToTaskResultUnlocked(
  fs: FsAdapter,
  tent: LoadedTent,
  outputNodeIds: readonly string[] | undefined,
  resultId: string
): Promise<{
  boundIds: string[];
  changedIds: string[];
  snapshots: OutputBindSnapshot[];
}> {
  const { outputIds, nodes } = validateOutputResultBinding(tent, outputNodeIds, resultId);

  type Planned = {
    node: Node;
    outputId: string;
    notePath: string;
    raw: string;
    previousTaskResultId: string | undefined;
  };
  const planned: Planned[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const outputId = outputIds[i];
    const { alreadyBound } = assertOutputBindable(node, resultId);
    if (alreadyBound) continue;
    const notePath = nodeNotePath(node.path);
    const raw = await fs.readFile(notePath);
    planned.push({
      node,
      outputId,
      notePath,
      raw,
      previousTaskResultId: readOutputTaskResultId(node.fm as Record<string, unknown>),
    });
  }

  const snapshots: OutputBindSnapshot[] = [];
  const changedIds: string[] = [];

  try {
    for (const item of planned) {
      const { data, body, keyOrder } = parseFrontmatter(item.raw);
      data[OUTPUT_PROVENANCE_FIELD] = resultId;
      const nextRaw = serializeFrontmatter(data, body, outputKeyOrder(keyOrder));
      await fs.writeFile(item.notePath, nextRaw);
      // Only record snapshot after a successful write so rollback targets real changes.
      snapshots.push({
        outputId: item.outputId,
        notePath: item.notePath,
        raw: item.raw,
        node: item.node,
        previousTaskResultId: item.previousTaskResultId,
      });
      (item.node.fm as Record<string, unknown>)[OUTPUT_PROVENANCE_FIELD] = resultId;
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

/** Explicit post-review provenance action; accepting a Result never calls this. */
export async function bindOutputsToTaskResult(
  fs: FsAdapter,
  outputNodeIds: readonly string[],
  resultId: string
): Promise<{ boundIds: string[]; changedIds: string[] }> {
  return withTentMutation(fs, async () => {
    const tent = await loadTent(fs);
    const bound = await bindOutputsToTaskResultUnlocked(
      fs,
      tent,
      outputNodeIds,
      resultId
    );
    return { boundIds: bound.boundIds, changedIds: bound.changedIds };
  });
}

/**
 * Build Output provenance read model from a resolved Output node + operational indexes.
 * Never infers by path/name/time; missing heat records → incomplete, not invented joins.
 */
export function projectOutputProvenance(
  node: Node,
  indexes: {
    resultsById: Map<string, TaskResultRecord>;
    tasksById: Map<string, TaskRecord>;
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
  if (!isOutputNodeType(node.type)) {
    throw new OutputProvenanceError(
      "OUTPUT_NOT_OUTPUT_TYPE",
      `Node type must be output for provenance query (got ${node.type}): ${node.id}`,
      { outputId: node.id, type: node.type }
    );
  }

  const resultId = readOutputTaskResultId(node.fm as Record<string, unknown>) ?? null;
  const base: OutputProvenance = {
    outputId: node.id,
    path: node.path,
    bound: false,
    resultId: null,
    result: null,
    task: null,
    sourceNode: null,
    incomplete: [],
  };

  if (!resultId) {
    return base;
  }

  base.bound = true;
  base.resultId = resultId;

  if (!isTaskResultId(resultId)) {
    base.incomplete.push("result_missing");
    return base;
  }

  const result = indexes.resultsById.get(resultId);
  if (!result) {
    base.incomplete.push("result_missing");
    // Without live TaskResult we cannot walk Task/source by id-only authority.
    return base;
  }

  base.result = {
    id: result.id,
    status: result.status,
    taskId: result.taskId,
    artifactRefs: result.artifactRefs.map((ref) => ({ ...ref })),
  };

  const task = indexes.tasksById.get(result.taskId);

  if (!task) {
    base.incomplete.push("task_missing");
  } else {
    base.task = {
      id: task.id || task.path,
      state: task.state,
      path: task.path,
    };
    // Lightweight consistency: result.taskId should match task identity when both exist.
    const taskKey = task.id || task.path;
    if (result.taskId && taskKey && result.taskId !== taskKey && result.taskId !== task.path) {
      if (!base.incomplete.includes("mismatch")) base.incomplete.push("mismatch");
    }
    const sourceId = task.workNodeIds[0];
    if (!sourceId) {
      base.incomplete.push("source_missing");
      return base;
    }
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
  resultsById: Map<string, TaskResultRecord>;
  tasksById: Map<string, TaskRecord>;
}> {
  const loadedTent = tent ?? (await loadTent(fs));
  const results = await loadTaskResults(fs);
  const tasks = await loadTaskRecords(fs);
  const resultsById = new Map<string, TaskResultRecord>();
  for (const result of results) resultsById.set(result.id, result);
  const tasksById = new Map<string, TaskRecord>();
  for (const t of tasks) {
    if (t.id) tasksById.set(t.id, t);
  }
  return { tent: loadedTent, resultsById, tasksById };
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
    resultsById: Map<string, TaskResultRecord>;
    tasksById: Map<string, TaskRecord>;
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
