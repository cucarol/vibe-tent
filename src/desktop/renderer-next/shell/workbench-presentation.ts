import {
  placeEntityInVisibleViewport,
  removeEntityFromCanvas,
} from "../model/canvas-document.js";
import type { CanvasDocument } from "../types/identity.js";
import { focusWorkbenchNode } from "./workbench-selection.js";

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

export function placePresentationNode(
  current: WorkbenchPresentationState,
  nodeId: string
): WorkbenchPresentationState {
  return {
    selectedNodeId: nodeId,
    document: placeEntityInVisibleViewport(current.document, nodeId).document,
  };
}

export function removePresentationNode(
  current: WorkbenchPresentationState,
  nodeId: string
): WorkbenchPresentationState {
  return {
    selectedNodeId: nodeId,
    document: removeEntityFromCanvas(current.document, nodeId),
  };
}
