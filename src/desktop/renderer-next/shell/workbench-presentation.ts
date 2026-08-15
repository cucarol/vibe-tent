import {
  DEFAULT_VIEWPORT,
  NODE_CARD,
  VISIBLE_NODE_PLACEMENT,
  canvasPlacementSize,
  dropNodeSnapshotAt,
  placeEntityInVisibleViewport,
} from "../model/canvas-document.js";
import {
  captureCanvasNodeSnapshot,
  type CanvasNodeSnapshot,
  type CanvasSnapshotSource,
} from "../model/canvas-node-snapshot.js";
import type { CanvasDocument } from "../types/identity.js";
import { focusWorkbenchNode } from "./workbench-selection.js";
import {
  createCanvasSubtreeProjectionInstance,
  type CanvasSubtreeNodeSource,
  type SubtreeDirection,
} from "../model/canvas-subtree-projection.js";
import type { WorkbenchNodeView } from "./workbench-types.js";

export type WorkbenchPresentationState = {
  document: CanvasDocument;
  selectedNodeId: string | null;
};

export type WorkbenchPresentationUpdate = (
  current: WorkbenchPresentationState
) => WorkbenchPresentationState;

export function canvasSnapshotSourceFromWorkbenchNode(
  node: WorkbenchNodeView | null | undefined
): CanvasSnapshotSource | null {
  if (!node) return null;
  return {
    nodeId: node.nodeId,
    etag: node.etag,
    name: node.name,
    ...(node.title?.trim() ? { title: node.title } : {}),
    path: node.path,
    type: node.type ?? "",
    tags: node.tags,
    mode: node.mode,
    archived: node.archived,
    invalid: node.invalid,
  };
}

/**
 * Capture one ready root and every reachable ready descendant in authoritative
 * sibling order. An unavailable descendant prunes only its own branch; the
 * ready parent and ready sibling branches still form a valid local projection.
 */
export function collectReadyPresentationSubtreeSources(
  nodes: readonly WorkbenchNodeView[],
  rootNodeId: string
): CanvasSubtreeNodeSource[] | null {
  const root = nodes.find((node) => node.nodeId === rootNodeId);
  if (!root || (root.projectionState !== undefined && root.projectionState !== "ready")) {
    return null;
  }
  const byParent = new Map<string, WorkbenchNodeView[]>();
  for (const node of nodes) {
    if (!node.parentNodeId) continue;
    const siblings = byParent.get(node.parentNodeId) ?? [];
    siblings.push(node);
    byParent.set(node.parentNodeId, siblings);
  }
  const sources: CanvasSubtreeNodeSource[] = [];
  const queue = [root];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node.nodeId)) return null;
    seen.add(node.nodeId);
    const source = canvasSnapshotSourceFromWorkbenchNode(node);
    if (
      !source ||
      (node.projectionState !== undefined && node.projectionState !== "ready")
    ) {
      continue;
    }
    sources.push({
      nodeId: node.nodeId,
      parentNodeId: node.parentNodeId,
      snapshot: { ...captureCanvasNodeSnapshot(source), etag: source.etag },
    });
    queue.push(...(byParent.get(node.nodeId) ?? []));
  }
  return sources;
}

export function canCreateNodePlacement(
  workspaceProjection: "loading" | "fresh" | "stale" | "unresolved" | "error" | "unmounted",
  nodeProjection: "ready" | "loading" | "stale" | "unresolved" | "error" | undefined
): boolean {
  return workspaceProjection === "fresh" &&
    (nodeProjection === undefined || nodeProjection === "ready");
}

export function canDropNodeIntoPresentation(
  hasPresentationOwner: boolean,
  workspaceProjection: "loading" | "fresh" | "stale" | "unresolved" | "error" | "unmounted",
  nodeProjection: "ready" | "loading" | "stale" | "unresolved" | "error" | undefined
): boolean {
  return hasPresentationOwner &&
    canCreateNodePlacement(workspaceProjection, nodeProjection);
}

export function canvasPlacementSourceAuthority(
  workspaceProjection: "loading" | "fresh" | "stale" | "unresolved" | "error" | "unmounted",
  selectedNodeProjection: "ready" | "loading" | "stale" | "unresolved" | "error" | null | undefined
): "fresh" | "unknown" {
  if (workspaceProjection !== "fresh") return "unknown";
  // null means the exact Node is absent from a genuinely fresh graph, which is
  // the only authoritative deletion signal. An existing Node must itself be
  // ready; a conflicting row-level state cannot authorize snapshot sync.
  return selectedNodeProjection === null ||
    selectedNodeProjection === undefined ||
    selectedNodeProjection === "ready"
    ? "fresh"
    : "unknown";
}

export function withPresentationDocument(
  current: WorkbenchPresentationState,
  document: CanvasDocument
): WorkbenchPresentationState {
  return { document, selectedNodeId: current.selectedNodeId };
}

export function selectPresentationNode(
  current: WorkbenchPresentationState,
  nodeId: string | null,
  placementId?: string | null
): WorkbenchPresentationState {
  return {
    selectedNodeId: nodeId,
    document: focusWorkbenchNode(current.document, nodeId, placementId),
  };
}

/**
 * Authoritative tree browsing changes the selected Node without touching the
 * Canvas camera or focused placement. The asymmetric selection contract keeps
 * spatial work stable while the user inspects the Node tree.
 */
export function selectPresentationNodeFromOutline(
  current: WorkbenchPresentationState,
  nodeId: string
): WorkbenchPresentationState {
  return current.selectedNodeId === nodeId
    ? current
    : { ...current, selectedNodeId: nodeId };
}

export function placePresentationNode(
  current: WorkbenchPresentationState,
  nodeId: string,
  snapshot?: CanvasNodeSnapshot
): WorkbenchPresentationState {
  return {
    selectedNodeId: nodeId,
    document: placeEntityInVisibleViewport(
      current.document,
      nodeId,
      undefined,
      snapshot
    ).document,
  };
}

export function dropPresentationNode(
  current: WorkbenchPresentationState,
  nodeId: string,
  snapshot: CanvasNodeSnapshot,
  point: { x: number; y: number }
): WorkbenchPresentationState {
  return {
    selectedNodeId: nodeId,
    document: dropNodeSnapshotAt(current.document, nodeId, snapshot, point).document,
  };
}

export function dropPresentationSubtree(
  current: WorkbenchPresentationState,
  rootNodeId: string,
  sources: readonly CanvasSubtreeNodeSource[],
  point: { x: number; y: number },
  direction: SubtreeDirection = "right"
): WorkbenchPresentationState {
  const dropped = createCanvasSubtreeProjectionInstance(
    current.document,
    rootNodeId,
    sources,
    point,
    direction
  );
  return {
    selectedNodeId: rootNodeId,
    document: dropped.document,
  };
}

export function dropPresentationSubtreeOrLeaf(
  current: WorkbenchPresentationState,
  rootNodeId: string,
  sources: readonly CanvasSubtreeNodeSource[],
  point: { x: number; y: number }
): WorkbenchPresentationState {
  const root = sources[0];
  if (!root) return current;
  if (sources.length > 1) {
    return dropPresentationSubtree(current, rootNodeId, sources, point);
  }
  return dropPresentationNode(current, rootNodeId, root.snapshot, point);
}

/**
 * Keyboard/right-pane placement uses the same duplicate-preserving leaf versus
 * subtree materialization as Outline drag, choosing only a free visible origin.
 */
export function placePresentationSubtreeOrLeaf(
  current: WorkbenchPresentationState,
  rootNodeId: string,
  sources: readonly CanvasSubtreeNodeSource[]
): WorkbenchPresentationState {
  const viewport = current.document.viewport ?? DEFAULT_VIEWPORT;
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const base = {
    x: (VISIBLE_NODE_PLACEMENT.insetX - viewport.x) / zoom,
    y: (VISIBLE_NODE_PLACEMENT.insetY - viewport.y) / zoom,
  };
  const overlaps = (point: { x: number; y: number }) => current.document.placements.some((placement) => {
    const size = canvasPlacementSize(placement);
    const x = placement.x ?? 0;
    const y = placement.y ?? 0;
    const margin = 20;
    return point.x < x + size.width + margin &&
      point.x + NODE_CARD.width + margin > x &&
      point.y < y + size.height + margin &&
      point.y + NODE_CARD.height + margin > y;
  });
  let point = base;
  const slotLimit = Math.max(12, current.document.placements.length * 4 + 4);
  for (let slot = 0; slot < slotLimit; slot += 1) {
    const candidate = {
      x: base.x + (slot % 2) * (NODE_CARD.width + 32),
      y: base.y + Math.floor(slot / 2) * (NODE_CARD.height + 32),
    };
    point = candidate;
    if (!overlaps(candidate)) break;
  }
  return dropPresentationSubtreeOrLeaf(current, rootNodeId, sources, point);
}
