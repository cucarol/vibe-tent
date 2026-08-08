import { NODE_CARD } from "../../model/canvas-document.js";
import type { ExcalidrawElementLike } from "./documentToExcalidraw.js";

export type TentPlacementDrag = {
  pointerId: number;
  placementId: string;
  nodeId: string;
  elementId: string;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  zoom: number;
};

export type TentPlacementDragResult = {
  elements: readonly unknown[];
  x: number;
  y: number;
  moved: boolean;
};

/**
 * Keep native Excalidraw keyboard ownership after a Tent placement pointer
 * gesture. Outline reveal remains visual/roving state and must not steal DOM
 * focus from the Canvas command owner.
 */
export function focusExcalidrawKeyboardOwner(host: ParentNode): boolean {
  const container = host.querySelector<HTMLElement>(".excalidraw-container");
  if (!container) return false;
  container.focus({ preventScroll: true });
  return true;
}

export function createTentPlacementDrag(input: TentPlacementDrag): TentPlacementDrag {
  return {
    ...input,
    zoom: Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1,
  };
}

/**
 * Moves one fixed Tent placement in scene coordinates. This is intentionally
 * unaware of graph/Node facts: it only adapts a pointer gesture into local
 * placement geometry while Excalidraw keeps owning camera and drawing tools.
 */
export function moveTentPlacementForPointer(
  elements: readonly unknown[],
  drag: TentPlacementDrag,
  clientX: number,
  clientY: number
): TentPlacementDragResult {
  const deltaX = (clientX - drag.startClientX) / drag.zoom;
  const deltaY = (clientY - drag.startClientY) / drag.zoom;
  const x = drag.originX + deltaX;
  const y = drag.originY + deltaY;
  const moved = Math.hypot(deltaX, deltaY) >= 2;
  if (!moved) {
    return { elements, x: drag.originX, y: drag.originY, moved: false };
  }

  let changed = false;
  const nextElements = elements.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const element = raw as ExcalidrawElementLike;
    if (element.id !== drag.elementId || element.isDeleted === true) return raw;
    if (
      element.x === x &&
      element.y === y &&
      element.width === NODE_CARD.width &&
      element.height === NODE_CARD.height &&
      (element.angle ?? 0) === 0
    ) {
      return raw;
    }
    changed = true;
    return {
      ...element,
      x,
      y,
      width: NODE_CARD.width,
      height: NODE_CARD.height,
      angle: 0,
      version: typeof element.version === "number" ? element.version + 1 : 2,
      versionNonce:
        typeof element.versionNonce === "number" ? element.versionNonce + 1 : 2,
    };
  });
  return {
    elements: changed ? nextElements : elements,
    x,
    y,
    moved: true,
  };
}

export function restoreTentPlacementAfterCancel(
  elements: readonly unknown[],
  drag: TentPlacementDrag
): readonly unknown[] {
  let changed = false;
  const nextElements = elements.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const element = raw as ExcalidrawElementLike;
    if (element.id !== drag.elementId || element.isDeleted === true) return raw;
    if (
      element.x === drag.originX &&
      element.y === drag.originY &&
      element.width === NODE_CARD.width &&
      element.height === NODE_CARD.height &&
      (element.angle ?? 0) === 0
    ) {
      return raw;
    }
    changed = true;
    return {
      ...element,
      x: drag.originX,
      y: drag.originY,
      width: NODE_CARD.width,
      height: NODE_CARD.height,
      angle: 0,
      version: typeof element.version === "number" ? element.version + 1 : 2,
      versionNonce:
        typeof element.versionNonce === "number" ? element.versionNonce + 1 : 2,
    };
  });
  return changed ? nextElements : elements;
}
