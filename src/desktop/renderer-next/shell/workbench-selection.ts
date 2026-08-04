import { setFocusedPlacement } from "../model/canvas-document.js";
import type { CanvasDocument } from "../types/identity.js";

/**
 * Keep shell selection and Excalidraw selection on one local presentation fact.
 * A Canvas-originated placement wins; Outline selection locates the first local
 * placement for the node. Selecting a node that is not on Canvas clears the
 * previous Canvas focus instead of leaving a contradictory highlight behind.
 */
export function focusWorkbenchNode(
  document: CanvasDocument,
  nodeId: string | null,
  placementId?: string | null
): CanvasDocument {
  if (!nodeId) return setFocusedPlacement(document, null);
  const exactPlacement = placementId
    ? document.placements.find(
        (placement) =>
          placement.placementId === placementId && placement.entityRef === nodeId
      )
    : undefined;
  const placement = exactPlacement
    ?? document.placements.find((candidate) => candidate.entityRef === nodeId);
  return setFocusedPlacement(document, placement?.placementId ?? null);
}

export function initializeWorkbenchSelection(
  document: CanvasDocument,
  requestedNodeId: string | null
): { document: CanvasDocument; selectedNodeId: string | null } {
  const focusedNodeId = document.focusedPlacementId
    ? document.placements.find(
        (placement) => placement.placementId === document.focusedPlacementId
      )?.entityRef ?? null
    : null;
  const selectedNodeId = requestedNodeId ?? focusedNodeId;
  return {
    document: focusWorkbenchNode(document, selectedNodeId),
    selectedNodeId,
  };
}
