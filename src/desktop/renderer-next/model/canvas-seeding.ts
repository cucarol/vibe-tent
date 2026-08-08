import type { GraphProjection } from "../../../service/types.js";
import type { CanvasDocument } from "../types/identity.js";
import { NODE_CARD } from "./canvas-document.js";
import { depthByNodeId } from "./workbench-nodes.js";
import {
  captureCanvasNodeSnapshot,
  materializeMissingCanvasNodeSnapshots,
  withCanvasNodeSnapshot,
} from "./canvas-node-snapshot.js";

/** Seed only the first authoritative Node when no local Canvas state exists. */
export function seedCanvasDocumentFromGraph(graph: GraphProjection): CanvasDocument {
  const node = graph.nodes[0];
  const placements = node
    ? [withCanvasNodeSnapshot({
        placementId: `pl-default-${node.nodeId}`,
        entityRef: node.nodeId,
        kind: "node",
        x: 90 + (depthByNodeId(graph).get(node.nodeId) ?? 0) *
          (NODE_CARD.width + NODE_CARD.gapX),
        y: 110,
        width: NODE_CARD.width,
        height: NODE_CARD.height,
      }, captureCanvasNodeSnapshot({
        nodeId: node.nodeId,
        etag: node.etag,
        name: node.name,
        ...(node.title ? { title: node.title } : {}),
        path: node.path,
        type: node.type,
        tags: node.tags,
        mode: node.mode,
        archived: node.archived,
        invalid: node.invalid,
      }))]
    : [];
  return {
    version: 1,
    backgroundMode: "blank",
    focusedPlacementId: placements[0]?.placementId ?? null,
    viewport: { x: 0, y: 0, zoom: 1 },
    placements,
  };
}

/**
 * Reconcile a successful local-storage load with an already authoritative
 * graph. This closes the retry ordering where graph projection may settle
 * before storage becomes readable.
 */
export function reconcileLoadedCanvasDocument(
  loadKind: "empty" | "loaded",
  document: CanvasDocument,
  graph: GraphProjection | null
): { document: CanvasDocument; seeded: boolean; changed: boolean } {
  if (!graph) {
    return { document, seeded: loadKind === "loaded", changed: false };
  }
  if (
    loadKind === "empty" &&
    document.placements.length === 0 &&
    graph.nodes.length > 0
  ) {
    return {
      document: seedCanvasDocumentFromGraph(graph),
      seeded: true,
      changed: true,
    };
  }
  const materialized = materializeMissingCanvasNodeSnapshots(
    document,
    graph.nodes
  );
  return {
    document: materialized.document,
    seeded: loadKind === "loaded",
    changed: materialized.changed,
  };
}
