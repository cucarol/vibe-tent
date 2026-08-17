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
  focusedNodeId: string | null;
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
  return { document, focusedNodeId: current.focusedNodeId };
}

export function selectPresentationNode(
  current: WorkbenchPresentationState,
  nodeId: string | null,
  placementId?: string | null
): WorkbenchPresentationState {
  return {
    focusedNodeId: nodeId,
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
  return current.focusedNodeId === nodeId
    ? current
    : { ...current, focusedNodeId: nodeId };
}

export function placePresentationNode(
  current: WorkbenchPresentationState,
  nodeId: string,
  snapshot?: CanvasNodeSnapshot
): WorkbenchPresentationState {
  return {
    focusedNodeId: nodeId,
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
    focusedNodeId: nodeId,
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
    focusedNodeId: rootNodeId,
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

export function canonicalPresentationRootNodeIds(
  nodes: readonly WorkbenchNodeView[],
  nodeIds: readonly string[]
): string[] {
  const known = new Map(nodes.map((node) => [node.nodeId, node] as const));
  const requested = [...new Set(nodeIds)];
  if (requested.some((nodeId) => !known.has(nodeId))) return [];
  const selected = new Set(requested);
  return requested.filter((nodeId) => {
    const seen = new Set<string>();
    let parentId = known.get(nodeId)?.parentNodeId ?? null;
    while (parentId) {
      if (selected.has(parentId)) return false;
      if (seen.has(parentId)) break;
      seen.add(parentId);
      parentId = known.get(parentId)?.parentNodeId ?? null;
    }
    return true;
  });
}

export type PresentationRoot = {
  nodeId: string;
  sources: readonly CanvasSubtreeNodeSource[];
};

export function collectReadyPresentationRoots(
  nodes: readonly WorkbenchNodeView[],
  nodeIds: readonly string[]
): PresentationRoot[] | null {
  const rootNodeIds = canonicalPresentationRootNodeIds(nodes, nodeIds);
  if (nodeIds.length > 0 && rootNodeIds.length === 0) return null;
  const roots = rootNodeIds.flatMap((nodeId) => {
    const sources = collectReadyPresentationSubtreeSources(nodes, nodeId);
    return sources ? [{ nodeId, sources }] : [];
  });
  return roots.length === rootNodeIds.length ? roots : null;
}

function placePresentationRootAtFreePoint(
  current: WorkbenchPresentationState,
  root: PresentationRoot,
  base: { x: number; y: number }
): WorkbenchPresentationState {
  const overlaps = (candidate: WorkbenchPresentationState) => {
    const margin = 20;
    const added = candidate.document.placements.slice(current.document.placements.length);
    return added.some((nextPlacement) => {
      const nextSize = canvasPlacementSize(nextPlacement);
      const nextX = nextPlacement.x ?? 0;
      const nextY = nextPlacement.y ?? 0;
      return current.document.placements.some((placement) => {
        const size = canvasPlacementSize(placement);
        const x = placement.x ?? 0;
        const y = placement.y ?? 0;
        return nextX < x + size.width + margin &&
          nextX + nextSize.width + margin > x &&
          nextY < y + size.height + margin &&
          nextY + nextSize.height + margin > y;
      });
    });
  };
  for (let slot = 0; ; slot += 1) {
    const point = {
      x: base.x + (slot % 2) * (NODE_CARD.width + 32),
      y: base.y + Math.floor(slot / 2) * (NODE_CARD.height + 32),
    };
    const candidate = dropPresentationSubtreeOrLeaf(
      current,
      root.nodeId,
      root.sources,
      point
    );
    if (!overlaps(candidate)) return candidate;
  }
}

export function dropPresentationRootSet(
  current: WorkbenchPresentationState,
  roots: readonly PresentationRoot[],
  point: { x: number; y: number }
): WorkbenchPresentationState {
  return roots.reduce(
    (next, root) => placePresentationRootAtFreePoint(next, root, point),
    current
  );
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
  return placePresentationRootAtFreePoint(
    current,
    { nodeId: rootNodeId, sources },
    base
  );
}
