/**
 * Local placement chrome: size, presentation (compact/expanded), remove-from-canvas.
 * All operations are CanvasDocument-only — never domain parent/body/type writes.
 */

import type { CanvasDocument, PlacementId } from "../types/identity.js";
import { NODE_CARD, findPlacement } from "./canvas-document.js";

export type PlacementPresentation = "compact" | "expanded";

export const PLACEMENT_SIZE_BOUNDS = {
  minWidth: 140,
  maxWidth: 420,
  minHeight: 56,
  maxHeight: 280,
  defaultWidth: NODE_CARD.width,
  defaultHeight: NODE_CARD.height,
  /** Expanded compact→expanded bump so summary has room without long markdown. */
  expandedMinHeight: 96,
} as const;

export function clampPlacementSize(size: {
  width?: number;
  height?: number;
}): { width: number; height: number } {
  const width = Number.isFinite(size.width)
    ? Math.min(
        PLACEMENT_SIZE_BOUNDS.maxWidth,
        Math.max(PLACEMENT_SIZE_BOUNDS.minWidth, Math.round(size.width!))
      )
    : PLACEMENT_SIZE_BOUNDS.defaultWidth;
  const height = Number.isFinite(size.height)
    ? Math.min(
        PLACEMENT_SIZE_BOUNDS.maxHeight,
        Math.max(PLACEMENT_SIZE_BOUNDS.minHeight, Math.round(size.height!))
      )
    : PLACEMENT_SIZE_BOUNDS.defaultHeight;
  return { width, height };
}

export function getPlacementPresentation(
  meta: Readonly<Record<string, unknown>> | undefined
): PlacementPresentation {
  return meta?.presentation === "expanded" ? "expanded" : "compact";
}

export function resizePlacement(
  doc: CanvasDocument,
  placementId: PlacementId,
  size: { width: number; height: number }
): CanvasDocument {
  const clamped = clampPlacementSize(size);
  return {
    ...doc,
    placements: doc.placements.map((p) =>
      p.placementId === placementId
        ? { ...p, width: clamped.width, height: clamped.height }
        : p
    ),
  };
}

export function setPlacementPresentation(
  doc: CanvasDocument,
  placementId: PlacementId,
  presentation: PlacementPresentation
): CanvasDocument {
  return {
    ...doc,
    placements: doc.placements.map((p) => {
      if (p.placementId !== placementId) return p;
      const meta = { ...(p.meta ?? {}), presentation };
      let height = p.height ?? NODE_CARD.height;
      if (presentation === "expanded") {
        height = Math.max(height, PLACEMENT_SIZE_BOUNDS.expandedMinHeight);
      }
      const size = clampPlacementSize({
        width: p.width ?? NODE_CARD.width,
        height,
      });
      return { ...p, meta, width: size.width, height: size.height };
    }),
  };
}

/** Double-click toggle between compact and expanded local presentation. */
export function togglePlacementPresentation(
  doc: CanvasDocument,
  placementId: PlacementId
): CanvasDocument {
  const p = findPlacement(doc, placementId);
  if (!p) return doc;
  const next =
    getPlacementPresentation(p.meta) === "expanded" ? "compact" : "expanded";
  return setPlacementPresentation(doc, placementId, next);
}

/**
 * Short expanded summary from already-projected fields only.
 * Never injects long Markdown body into the card.
 */
export function compactExpandedSummary(input: {
  type?: string;
  tags?: readonly string[];
  path?: string;
  childCount?: number;
}): string {
  const parts: string[] = [];
  if (input.type) parts.push(input.type);
  if (typeof input.childCount === "number" && input.childCount > 0) {
    parts.push(`${input.childCount} child${input.childCount === 1 ? "" : "ren"}`);
  }
  if (input.tags && input.tags.length > 0) {
    parts.push(input.tags.slice(0, 3).join(" · "));
  }
  if (parts.length === 0 && input.path) {
    const leaf = input.path.split("/").filter(Boolean).pop();
    if (leaf) parts.push(leaf);
  }
  return parts.join(" · ") || "—";
}
