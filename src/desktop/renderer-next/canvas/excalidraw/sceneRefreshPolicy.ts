import type { CanvasEdgeLayerVisibility, GraphEdgeSource } from "../../model/canvas-edges.js";
import type { CanvasDocument } from "../../types/identity.js";

export type LiveSceneInputs = {
  document: CanvasDocument;
  graph: GraphEdgeSource | null | undefined;
  edgeLayers: CanvasEdgeLayerVisibility;
};

export function shouldRefreshCanvasV5Scene(
  previous: LiveSceneInputs,
  next: LiveSceneInputs,
  lastInternallyPublishedDocument: CanvasDocument | null
): boolean {
  const edgeLayersChanged = (
    Object.keys(next.edgeLayers) as (keyof CanvasEdgeLayerVisibility)[]
  ).some((key) => previous.edgeLayers[key] !== next.edgeLayers[key]);
  const externalDocumentChanged =
    previous.document !== next.document &&
    next.document !== lastInternallyPublishedDocument;
  return previous.graph !== next.graph || edgeLayersChanged || externalDocumentChanged;
}
