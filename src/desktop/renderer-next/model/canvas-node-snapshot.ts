import type { CanvasDocument, CanvasPlacement } from "../types/identity.js";

export const CANVAS_NODE_SNAPSHOT_META_KEY = "tentNodeSnapshot" as const;
export const OUTLINE_NODE_DRAG_TYPE = "application/x-tent-node-ref" as const;

/**
 * Frozen, machine-local presentation captured when a Node is placed.
 * It intentionally contains only fields available in graph.projection. Body,
 * etag, Task and collaboration facts are not part of a Canvas snapshot.
 */
export type CanvasNodeSnapshot = {
  version: 1;
  nodeId: string;
  name: string;
  title?: string;
  path: string;
  type: string;
  tags: readonly string[];
  mode: "editable" | "archived";
  archived: boolean;
  invalid: boolean;
};

export type CanvasSnapshotSource = Omit<CanvasNodeSnapshot, "version">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function captureCanvasNodeSnapshot(
  source: CanvasSnapshotSource
): CanvasNodeSnapshot {
  return {
    version: 1,
    nodeId: source.nodeId,
    name: source.name,
    ...(source.title?.trim() ? { title: source.title } : {}),
    path: source.path,
    type: source.type,
    tags: [...source.tags],
    mode: source.mode,
    archived: source.archived,
    invalid: source.invalid,
  };
}

export function readCanvasNodeSnapshot(
  placement: Pick<CanvasPlacement, "entityRef" | "meta">
): CanvasNodeSnapshot | null {
  const value = placement.meta?.[CANVAS_NODE_SNAPSHOT_META_KEY];
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    typeof value.nodeId !== "string" ||
    !value.nodeId ||
    value.nodeId !== placement.entityRef ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    typeof value.type !== "string" ||
    !Array.isArray(value.tags) ||
    value.tags.some((tag) => typeof tag !== "string") ||
    (value.mode !== "editable" && value.mode !== "archived") ||
    typeof value.archived !== "boolean" ||
    typeof value.invalid !== "boolean" ||
    !(value.title === undefined || typeof value.title === "string")
  ) {
    return null;
  }
  return value as unknown as CanvasNodeSnapshot;
}

export function hasCanvasNodeSnapshotMeta(
  placement: Pick<CanvasPlacement, "meta">
): boolean {
  return Boolean(
    placement.meta &&
    Object.prototype.hasOwnProperty.call(
      placement.meta,
      CANVAS_NODE_SNAPSHOT_META_KEY
    )
  );
}

export function withCanvasNodeSnapshot(
  placement: CanvasPlacement,
  snapshot: CanvasNodeSnapshot
): CanvasPlacement {
  return {
    ...placement,
    meta: {
      ...(placement.meta ?? {}),
      [CANVAS_NODE_SNAPSHOT_META_KEY]: snapshot,
    },
  };
}

export function canvasSnapshotVisibleFieldsChanged(
  snapshot: CanvasNodeSnapshot,
  current: CanvasSnapshotSource | null | undefined
): boolean {
  if (!current) return false;
  return snapshot.name !== current.name ||
    (snapshot.title ?? "") !== (current.title ?? "") ||
    snapshot.path !== current.path ||
    snapshot.type !== current.type ||
    snapshot.mode !== current.mode ||
    snapshot.archived !== current.archived ||
    snapshot.invalid !== current.invalid ||
    snapshot.tags.length !== current.tags.length ||
    snapshot.tags.some((tag, index) => tag !== current.tags[index]);
}

/** Capture missing legacy placement snapshots once; never refresh existing ones. */
export function materializeMissingCanvasNodeSnapshots(
  document: CanvasDocument,
  sources: readonly CanvasSnapshotSource[]
): { document: CanvasDocument; changed: boolean } {
  const byId = new Map(sources.map((source) => [source.nodeId, source] as const));
  let changed = false;
  const placements = document.placements.map((placement) => {
    if (
      placement.kind !== "node" ||
      !placement.entityRef ||
      hasCanvasNodeSnapshotMeta(placement)
    ) {
      return placement;
    }
    const source = byId.get(placement.entityRef);
    if (!source) return placement;
    changed = true;
    return withCanvasNodeSnapshot(placement, captureCanvasNodeSnapshot(source));
  });
  return changed ? { document: { ...document, placements }, changed } : { document, changed };
}
