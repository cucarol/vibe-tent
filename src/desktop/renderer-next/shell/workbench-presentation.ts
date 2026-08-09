import {
  dropNodeSnapshotAt,
  placeEntityInVisibleViewport,
} from "../model/canvas-document.js";
import {
  type CanvasNodeSnapshot,
} from "../model/canvas-node-snapshot.js";
import type { CanvasDocument } from "../types/identity.js";
import { focusWorkbenchNode } from "./workbench-selection.js";
import {
  createCanvasSubtreeProjectionInstance,
  type CanvasSubtreeNodeSource,
  type SubtreeDirection,
} from "../model/canvas-subtree-projection.js";

export type WorkbenchPresentationState = {
  document: CanvasDocument;
  selectedNodeId: string | null;
};

export type WorkbenchPresentationUpdate = (
  current: WorkbenchPresentationState
) => WorkbenchPresentationState;

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
