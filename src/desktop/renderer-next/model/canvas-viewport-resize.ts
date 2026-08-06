import type { CanvasPlacement } from "../types/identity.js";
import type { Viewport } from "./canvas-document.js";

export type CanvasViewportSize = { width: number; height: number };

export type CanvasViewportFrameScheduler = {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frameId: number) => void;
};

/**
 * Apply the latest local viewport only after the Canvas engine has mounted.
 * Reading at frame time prevents a resize or pan between API delivery and
 * mount completion from reapplying an older camera.
 */
export function schedulePostMountCanvasViewportSync(options: {
  scheduler: CanvasViewportFrameScheduler;
  isCurrent: () => boolean;
  readViewport: () => Viewport;
  applyViewport: (viewport: Viewport) => void;
}): () => void {
  const frameId = options.scheduler.requestFrame(() => {
    if (!options.isCurrent()) return;
    options.applyViewport(options.readViewport());
  });
  return () => options.scheduler.cancelFrame(frameId);
}

/**
 * Preserve the previously visible world centre across a host resize, then make
 * the focused placement fully visible with the smallest additional pan.
 */
export function viewportAfterCanvasResize(args: {
  viewport: Viewport;
  previousSize: CanvasViewportSize;
  nextSize: CanvasViewportSize;
  focusedPlacement?: CanvasPlacement | null;
  focusVisibility?: "always" | "if-visible-before-resize";
  margin?: number;
}): Viewport {
  const zoom = Number.isFinite(args.viewport.zoom) && args.viewport.zoom > 0
    ? args.viewport.zoom
    : 1;
  const next = {
    x: args.viewport.x + (args.nextSize.width - args.previousSize.width) / 2,
    y: args.viewport.y + (args.nextSize.height - args.previousSize.height) / 2,
    zoom,
  };
  const placement = args.focusedPlacement;
  if (!placement) return next;

  const margin = Math.max(0, args.margin ?? 24);
  const width = (placement.width ?? 0) * zoom;
  const height = (placement.height ?? 0) * zoom;
  const placementX = placement.x ?? 0;
  const placementY = placement.y ?? 0;
  if (args.focusVisibility === "if-visible-before-resize") {
    const previousLeft = placementX * zoom + args.viewport.x;
    const previousTop = placementY * zoom + args.viewport.y;
    const previousRight = previousLeft + width;
    const previousBottom = previousTop + height;
    const intersectedPreviousViewport =
      previousRight > 0 &&
      previousLeft < args.previousSize.width &&
      previousBottom > 0 &&
      previousTop < args.previousSize.height;
    if (!intersectedPreviousViewport) return next;
  }
  let left = placementX * zoom + next.x;
  let top = placementY * zoom + next.y;
  let right = left + width;
  let bottom = top + height;

  const availableWidth = Math.max(0, args.nextSize.width - margin * 2);
  if (width > availableWidth) {
    next.x += args.nextSize.width / 2 - (left + right) / 2;
  } else if (left < margin) {
    next.x += margin - left;
  } else if (right > args.nextSize.width - margin) {
    next.x -= right - (args.nextSize.width - margin);
  }

  left = placementX * zoom + next.x;
  right = left + width;
  const availableHeight = Math.max(0, args.nextSize.height - margin * 2);
  if (height > availableHeight) {
    next.y += args.nextSize.height / 2 - (top + bottom) / 2;
  } else if (top < margin) {
    next.y += margin - top;
  } else if (bottom > args.nextSize.height - margin) {
    next.y -= bottom - (args.nextSize.height - margin);
  }
  return next;
}
