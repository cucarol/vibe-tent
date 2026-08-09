import type { ExcalidrawElementLike } from "./documentToExcalidraw.js";

export const TENT_PRESENTATION_HISTORY_KIND = "tent-presentation-history" as const;
export const TENT_PRESENTATION_HISTORY_ELEMENT_ID = "tent:presentation-history" as const;

type PresentationHistoryCustomData = {
  kind: typeof TENT_PRESENTATION_HISTORY_KIND;
  revision: string;
};

export function isCanvasPresentationHistoryElement(
  value: unknown
): value is ExcalidrawElementLike & { customData: PresentationHistoryCustomData } {
  if (!value || typeof value !== "object") return false;
  const element = value as ExcalidrawElementLike;
  const custom = element.customData;
  return element.id === TENT_PRESENTATION_HISTORY_ELEMENT_ID &&
    custom?.kind === TENT_PRESENTATION_HISTORY_KIND &&
    typeof custom.revision === "string" &&
    custom.revision.length > 0;
}

export function activeCanvasPresentationRevision(
  elements: readonly unknown[]
): string | null {
  const marker = elements.find(isCanvasPresentationHistoryElement);
  return marker && marker.isDeleted !== true ? marker.customData.revision : null;
}

export function canvasPresentationHistoryMarker(
  elements: readonly unknown[]
): ExcalidrawElementLike | null {
  return (elements.find(isCanvasPresentationHistoryElement) as ExcalidrawElementLike | undefined) ?? null;
}

export function advanceCanvasPresentationHistory(
  elements: readonly unknown[],
  revision: string
): ExcalidrawElementLike[] {
  const current = canvasPresentationHistoryMarker(elements);
  const now = Date.now();
  const nextMarker: ExcalidrawElementLike = current
    ? {
      ...current,
      isDeleted: false,
      version: typeof current.version === "number" ? current.version + 1 : 1,
      versionNonce: Math.floor(Math.random() * 2_147_483_647),
      updated: now,
      customData: { kind: TENT_PRESENTATION_HISTORY_KIND, revision },
    }
    : {
      id: TENT_PRESENTATION_HISTORY_ELEMENT_ID,
      type: "rectangle",
      x: -1_000_000,
      y: -1_000_000,
      width: 1,
      height: 1,
      angle: 0,
      strokeColor: "transparent",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 0,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1_973_341,
      version: 1,
      versionNonce: Math.floor(Math.random() * 2_147_483_647),
      isDeleted: false,
      boundElements: [],
      updated: now,
      link: null,
      locked: true,
      customData: { kind: TENT_PRESENTATION_HISTORY_KIND, revision },
    };
  let replaced = false;
  const next = elements.map((element) => {
    if (!isCanvasPresentationHistoryElement(element)) return element as ExcalidrawElementLike;
    replaced = true;
    return nextMarker;
  });
  return replaced ? next : [...next, nextMarker];
}

export function preserveCanvasPresentationHistoryMarker(
  elements: readonly unknown[],
  sourceElements: readonly unknown[]
): unknown[] {
  const marker = canvasPresentationHistoryMarker(sourceElements);
  if (!marker || elements.some(isCanvasPresentationHistoryElement)) return [...elements];
  return [...elements, marker];
}
