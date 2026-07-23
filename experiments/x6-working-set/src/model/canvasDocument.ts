import type {
  CanvasDocument,
  Placement,
  PlacementId,
  Viewport,
  VisualAnnotation,
  VisualGroup,
} from "./types.js";

export function emptyCanvasDocument(viewport?: Partial<Viewport>): CanvasDocument {
  return {
    version: 1,
    viewport: {
      x: viewport?.x ?? 0,
      y: viewport?.y ?? 0,
      zoom: viewport?.zoom ?? 1,
    },
    placements: [],
    visualGroups: [],
    annotations: [],
  };
}

/** Structural guard: CanvasDocument must not grow domain fields. */
export function assertCanvasDocumentShape(doc: CanvasDocument): void {
  const keys = Object.keys(doc).sort();
  const allowed = ["annotations", "placements", "version", "viewport", "visualGroups"];
  if (keys.join(",") !== allowed.join(",")) {
    throw new Error(`CanvasDocument unexpected keys: ${keys.join(", ")}`);
  }
  if (doc.version !== 1) throw new Error("CanvasDocument.version must be 1");
  for (const p of doc.placements) {
    if (!p.placementId || !p.entityRef) {
      throw new Error("placement requires placementId and entityRef");
    }
    if (p.placementId === p.entityRef) {
      // Allowed only if deliberately equal — spike prefers distinct prefixes.
    }
  }
}

export function findPlacement(
  doc: CanvasDocument,
  placementId: PlacementId
): Placement | undefined {
  return doc.placements.find((p) => p.placementId === placementId);
}

export function placementsByEntity(
  doc: CanvasDocument,
  entityRef: string
): Placement[] {
  return doc.placements.filter((p) => p.entityRef === entityRef);
}

export function updatePlacement(
  doc: CanvasDocument,
  placementId: PlacementId,
  patch: Partial<Pick<Placement, "x" | "y" | "width" | "height" | "visualGroupId">>
): CanvasDocument {
  return {
    ...doc,
    placements: doc.placements.map((p) =>
      p.placementId === placementId ? { ...p, ...patch } : p
    ),
  };
}

export function setViewport(doc: CanvasDocument, viewport: Viewport): CanvasDocument {
  return { ...doc, viewport: { ...viewport } };
}

export function cloneDocument(doc: CanvasDocument): CanvasDocument {
  return {
    version: 1,
    viewport: { ...doc.viewport },
    placements: doc.placements.map((p) => ({ ...p })),
    visualGroups: doc.visualGroups.map((g) => ({ ...g })),
    annotations: doc.annotations.map((a) => ({ ...a })),
  };
}

export function applyGroupAssign(
  doc: CanvasDocument,
  placementIds: PlacementId[],
  visualGroupId: string | undefined
): CanvasDocument {
  const set = new Set(placementIds);
  return {
    ...doc,
    placements: doc.placements.map((p) => {
      if (!set.has(p.placementId)) return p;
      if (visualGroupId === undefined) {
        const next = { ...p };
        delete next.visualGroupId;
        return next;
      }
      return { ...p, visualGroupId };
    }),
  };
}

export function upsertVisualGroup(doc: CanvasDocument, group: VisualGroup): CanvasDocument {
  const idx = doc.visualGroups.findIndex((g) => g.id === group.id);
  if (idx < 0) {
    return { ...doc, visualGroups: [...doc.visualGroups, group] };
  }
  const visualGroups = doc.visualGroups.slice();
  visualGroups[idx] = group;
  return { ...doc, visualGroups };
}

export function upsertAnnotation(
  doc: CanvasDocument,
  annotation: VisualAnnotation
): CanvasDocument {
  const idx = doc.annotations.findIndex((a) => a.id === annotation.id);
  if (idx < 0) {
    return { ...doc, annotations: [...doc.annotations, annotation] };
  }
  const annotations = doc.annotations.slice();
  annotations[idx] = annotation;
  return { ...doc, annotations };
}
