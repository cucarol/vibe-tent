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
import {
  type CanvasNodeSnapshot,
  withCanvasNodeSnapshot,
} from "./canvas-node-snapshot.js";

export type Viewport = NonNullable<CanvasDocument["viewport"]>;

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export const NODE_CARD = {
  width: 176,
  height: 52,
} as const;

export const VISIBLE_NODE_PLACEMENT = {
  insetX: 96,
  insetY: 150,
} as const;

/**
 * Resolve the geometry used by Canvas spatial consumers. Tent Nodes always
 * use the product's fixed card size, even when an older persisted placement
 * still carries legacy dimensions. Non-Node drawing geometry remains intact.
 */
export function canvasPlacementSize(
  placement: Pick<CanvasPlacement, "kind" | "width" | "height">
): { width: number; height: number } {
  if (placement.kind === "node") {
    return { width: NODE_CARD.width, height: NODE_CARD.height };
  }
  return {
    width: typeof placement.width === "number" && Number.isFinite(placement.width)
      ? placement.width
      : 0,
    height: typeof placement.height === "number" && Number.isFinite(placement.height)
      ? placement.height
      : 0,
  };
}

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

/**
 * Put one Node placement inside the currently visible Excalidraw viewport.
 * The viewport stores Excalidraw's pixel translation (`scroll * zoom`), so
 * the inverse transform below produces a scene point at a stable screen
 * inset. Existing placements are focused instead of duplicated.
 */
export function placeEntityInVisibleViewport(
  doc: CanvasDocument,
  entityRef: EntityRef,
  createPlacementId: () => PlacementId = () => newPlacementId("pl-node"),
  snapshot?: CanvasNodeSnapshot
): { document: CanvasDocument; placementId: PlacementId; added: boolean } {
  const existing = doc.placements.find((placement) => placement.entityRef === entityRef);
  if (existing) {
    return {
      document: setFocusedPlacement(doc, existing.placementId),
      placementId: existing.placementId,
      added: false,
    };
  }

  const viewport = doc.viewport ?? DEFAULT_VIEWPORT;
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const placementId = createPlacementId();
  const baseX = (VISIBLE_NODE_PLACEMENT.insetX - viewport.x) / zoom;
  const baseY = (VISIBLE_NODE_PLACEMENT.insetY - viewport.y) / zoom;
  const overlaps = (x: number, y: number) => doc.placements.some((candidate) => {
    const candidateX = candidate.x ?? 0;
    const candidateY = candidate.y ?? 0;
    const { width: candidateWidth, height: candidateHeight } = canvasPlacementSize(candidate);
    const margin = 20;
    return x < candidateX + candidateWidth + margin &&
      x + NODE_CARD.width + margin > candidateX &&
      y < candidateY + candidateHeight + margin &&
      y + NODE_CARD.height + margin > candidateY;
  });
  let x = baseX;
  let y = baseY;
  const slotLimit = Math.max(12, doc.placements.length * 4 + 4);
  for (let slot = 0; slot < slotLimit; slot += 1) {
    const candidateX = baseX + (slot % 2) * (NODE_CARD.width + 32);
    const candidateY = baseY + Math.floor(slot / 2) * (NODE_CARD.height + 32);
    // If every scanned slot is obstructed, the final bounded candidate is a
    // safer fallback than silently returning to the known-conflicting base.
    x = candidateX;
    y = candidateY;
    if (!overlaps(candidateX, candidateY)) {
      break;
    }
  }
  const placementBase: CanvasPlacement = {
    placementId,
    entityRef,
    kind: "node",
    x,
    y,
    width: NODE_CARD.width,
    height: NODE_CARD.height,
  };
  const placement = snapshot
    ? withCanvasNodeSnapshot(placementBase, snapshot)
    : placementBase;
  return {
    document: {
      ...doc,
      placements: [...doc.placements, placement],
      focusedPlacementId: placementId,
    },
    placementId,
    added: true,
  };
}

/**
 * Whiteboard drop semantics: every drop creates a new local placement at the
 * exact scene point, even when another placement already references the Node.
 */
export function dropNodeSnapshotAt(
  doc: CanvasDocument,
  entityRef: EntityRef,
  snapshot: CanvasNodeSnapshot,
  point: { x: number; y: number },
  createPlacementId: () => PlacementId = () => newPlacementId("pl-node")
): { document: CanvasDocument; placementId: PlacementId } {
  const placementId = createPlacementId();
  const placement = withCanvasNodeSnapshot({
    placementId,
    entityRef,
    kind: "node",
    x: point.x,
    y: point.y,
    width: NODE_CARD.width,
    height: NODE_CARD.height,
  }, snapshot);
  return {
    placementId,
    document: {
      ...doc,
      placements: [...doc.placements, placement],
      focusedPlacementId: placementId,
    },
  };
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
