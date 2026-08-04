/**
 * Pure CanvasDocument local-view operations.
 * Placements are machine-local UI state — never domain truth.
 * Drag / pan / zoom / remove-from-canvas only touch this document.
 */

import type {
  CanvasDocument,
  CanvasPlacement,
  EntityRef,
  PlacementId,
} from "../types/identity.js";
import { createEmptyCanvasDocument } from "../types/identity.js";

export type Viewport = NonNullable<CanvasDocument["viewport"]>;

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export const NODE_CARD = {
  width: 200,
  height: 72,
  gapX: 48,
  gapY: 20,
  padX: 24,
  padY: 24,
} as const;

export function withViewport(
  doc: CanvasDocument,
  viewport: Partial<Viewport>
): CanvasDocument {
  const base = doc.viewport ?? DEFAULT_VIEWPORT;
  return {
    ...doc,
    viewport: {
      x: viewport.x ?? base.x,
      y: viewport.y ?? base.y,
      zoom: viewport.zoom ?? base.zoom,
    },
  };
}

export function listPlacementIds(doc: CanvasDocument): PlacementId[] {
  return doc.placements.map((p) => p.placementId);
}

export function placementEntityRef(
  doc: CanvasDocument,
  placementId: PlacementId
): EntityRef | undefined {
  return doc.placements.find((p) => p.placementId === placementId)?.entityRef;
}

export function findPlacement(
  doc: CanvasDocument,
  placementId: PlacementId
): CanvasPlacement | undefined {
  return doc.placements.find((p) => p.placementId === placementId);
}

export function findPlacementsByEntity(
  doc: CanvasDocument,
  entityRef: EntityRef
): CanvasPlacement[] {
  return doc.placements.filter((p) => p.entityRef === entityRef);
}

export function hasEntityPlacement(
  doc: CanvasDocument,
  entityRef: EntityRef
): boolean {
  return doc.placements.some((p) => p.entityRef === entityRef);
}

export function movePlacement(
  doc: CanvasDocument,
  placementId: PlacementId,
  position: { x: number; y: number }
): CanvasDocument {
  return {
    ...doc,
    placements: doc.placements.map((p) =>
      p.placementId === placementId
        ? { ...p, x: position.x, y: position.y }
        : p
    ),
  };
}

export function removePlacement(
  doc: CanvasDocument,
  placementId: PlacementId
): CanvasDocument {
  const placements = doc.placements.filter((p) => p.placementId !== placementId);
  const focused =
    doc.focusedPlacementId === placementId ? null : doc.focusedPlacementId;
  return { ...doc, placements, focusedPlacementId: focused };
}

export function removeEntityFromCanvas(
  doc: CanvasDocument,
  entityRef: EntityRef
): CanvasDocument {
  const removed = new Set(
    doc.placements
      .filter((p) => p.entityRef === entityRef)
      .map((p) => p.placementId)
  );
  const placements = doc.placements.filter((p) => p.entityRef !== entityRef);
  const focused =
    doc.focusedPlacementId && removed.has(doc.focusedPlacementId)
      ? null
      : doc.focusedPlacementId;
  return { ...doc, placements, focusedPlacementId: focused };
}

export function setFocusedPlacement(
  doc: CanvasDocument,
  placementId: PlacementId | null
): CanvasDocument {
  return { ...doc, focusedPlacementId: placementId };
}

export function newPlacementId(prefix = "pl"): PlacementId {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/**
 * Merge new placements without rearranging existing ones.
 * For each entityRef already present, keep the existing placement(s).
 * Only insert placements for entityRefs that are not yet on the canvas.
 */
export function mergePlacementsPreserveExisting(
  doc: CanvasDocument,
  candidates: readonly CanvasPlacement[]
): CanvasDocument {
  const existingEntities = new Set(
    doc.placements
      .map((p) => p.entityRef)
      .filter((r): r is EntityRef => typeof r === "string" && r.length > 0)
  );
  const toAdd = candidates.filter(
    (c) => !c.entityRef || !existingEntities.has(c.entityRef)
  );
  if (toAdd.length === 0) return doc;
  return { ...doc, placements: [...doc.placements, ...toAdd] };
}

/**
 * Diff domain entity ids vs current placements.
 * Missing on canvas → pending (not auto-placed).
 * On canvas but gone from domain → ghost.
 */
export function diffDomainVsCanvas(
  doc: CanvasDocument,
  domainEntityIds: readonly EntityRef[]
): { pending: EntityRef[]; ghost: EntityRef[] } {
  const domain = new Set(domainEntityIds);
  const onCanvas = new Set(
    doc.placements
      .map((p) => p.entityRef)
      .filter((r): r is EntityRef => typeof r === "string" && r.length > 0)
  );
  const pending: EntityRef[] = [];
  const ghost: EntityRef[] = [];
  for (const id of domain) {
    if (!onCanvas.has(id)) pending.push(id);
  }
  for (const id of onCanvas) {
    if (!domain.has(id)) ghost.push(id);
  }
  return { pending, ghost };
}

export function emptyCanvasTabDocument(): CanvasDocument {
  return withViewport(createEmptyCanvasDocument(), DEFAULT_VIEWPORT);
}
