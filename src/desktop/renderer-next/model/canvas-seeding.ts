import type { GraphProjection } from "../../../service/types.js";
import type { CanvasDocument } from "../types/identity.js";
import { depthByNodeId } from "./workbench-nodes.js";

/** Seed only the first authoritative Node when no local Canvas state exists. */
export function seedCanvasDocumentFromGraph(graph: GraphProjection): CanvasDocument {
  const node = graph.nodes[0];
  const placements = node
    ? [{
        placementId: `pl-default-${node.nodeId}`,
        entityRef: node.nodeId,
        kind: "node",
        x: 90 + (depthByNodeId(graph).get(node.nodeId) ?? 0) * 320,
        y: 110,
        width: 264,
        height: 138,
      }]
    : [];
  return {
    version: 1,
    backgroundMode: "grid",
    focusedPlacementId: placements[0]?.placementId ?? null,
    viewport: { x: 0, y: 0, zoom: 1 },
    placements,
  };
}
