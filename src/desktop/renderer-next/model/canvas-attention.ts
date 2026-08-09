import type { CanvasDocument } from "../types/identity.js";

/**
 * Runtime attention is authoritative at Node scope, but Canvas renders one
 * exact visible placement per Node so duplicate projections never echo it.
 */
export function canvasAttentionPlacementIds(
  document: CanvasDocument,
  visiblePlacementIds: readonly string[],
  attentionNodeIds: ReadonlySet<string>
): ReadonlySet<string> {
  if (attentionNodeIds.size === 0) return new Set<string>();
  const visible = new Set(visiblePlacementIds);
  const chosen = new Map<string, string>();

  for (const placement of document.placements) {
    if (
      placement.kind !== "node" ||
      !placement.entityRef ||
      !visible.has(placement.placementId) ||
      !attentionNodeIds.has(placement.entityRef) ||
      chosen.has(placement.entityRef)
    ) continue;
    chosen.set(placement.entityRef, placement.placementId);
  }

  const focused = document.focusedPlacementId
    ? document.placements.find(
        (placement) => placement.placementId === document.focusedPlacementId
      )
    : null;
  if (
    focused?.kind === "node" &&
    focused.entityRef &&
    visible.has(focused.placementId) &&
    attentionNodeIds.has(focused.entityRef)
  ) {
    chosen.set(focused.entityRef, focused.placementId);
  }

  return new Set(chosen.values());
}
