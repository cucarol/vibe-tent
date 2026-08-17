import type { GraphProjection } from "../../../service/types.js";
import type { CanvasDocument } from "../types/identity.js";
import { materializeMissingCanvasNodeSnapshots } from "./canvas-node-snapshot.js";

/**
 * Reconcile a successful local-storage load with an already authoritative
 * graph. This closes the retry ordering where graph projection may settle
 * before storage becomes readable.
 */
export function reconcileLoadedCanvasDocument(
  document: CanvasDocument,
  graph: GraphProjection | null
): { document: CanvasDocument; changed: boolean } {
  if (!graph) {
    return { document, changed: false };
  }
  const materialized = materializeMissingCanvasNodeSnapshots(
    document,
    graph.nodes
  );
  return {
    document: materialized.document,
    changed: materialized.changed,
  };
}
