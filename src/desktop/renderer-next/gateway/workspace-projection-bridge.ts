import type { ServiceGateway } from "./service-gateway.js";

type ProjectionInvalidationGateway = Pick<
  ServiceGateway,
  "onInvalidation" | "startEventBridge" | "stopEventBridge"
>;

const PROJECTION_KEYS = new Set([
  "*",
  "graph.projection",
  "node.collaboration",
  "node.collaborations",
  "output.provenance",
  "service.health",
]);

/**
 * Subscribe before the first authoritative read so an event arriving during
 * bootstrap always schedules a newer read instead of falling into a gap.
 */
export function startWorkspaceProjectionBridge(
  gateway: ProjectionInvalidationGateway,
  workspaceId: string,
  refresh: () => Promise<void>
): () => void {
  const unsubscribe = gateway.onInvalidation((hint) => {
    if (hint.event?.workspaceId && hint.event.workspaceId !== workspaceId) return;
    if (hint.keys.some((key) => PROJECTION_KEYS.has(key))) void refresh();
  });
  gateway.startEventBridge();
  void refresh();
  return () => {
    gateway.stopEventBridge();
    unsubscribe();
  };
}
