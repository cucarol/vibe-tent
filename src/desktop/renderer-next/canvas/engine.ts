/**
 * CanvasEngine adapter interface.
 *
 * The foundation does not pick X6 or any graph library. Concrete engines
 * (DOM prototype, X6 spike, …) implement this port. UI shell depends only
 * on the interface so engine swaps stay isolated.
 */

import type {
  CanvasDocument,
  CanvasPlacement,
  PlacementId,
} from "../types/identity.js";

export type CanvasViewport = {
  x: number;
  y: number;
  zoom: number;
};

export type CanvasEngineEvents = {
  onPlacementSelect?: (placementId: PlacementId | null) => void;
  onViewportChange?: (viewport: CanvasViewport) => void;
  onPlacementMove?: (
    placementId: PlacementId,
    position: { x: number; y: number }
  ) => void;
};

/**
 * Host element contract — engines mount into a provided container.
 * No assumption about React vs raw DOM beyond HTMLElement.
 */
export type CanvasEngineMount = {
  container: HTMLElement;
  document: CanvasDocument;
  events?: CanvasEngineEvents;
};

export type CanvasEngine = {
  readonly id: string;
  mount(opts: CanvasEngineMount): void;
  unmount(): void;
  /** Replace local document projection (UI state only). */
  setDocument(document: CanvasDocument): void;
  getDocument(): CanvasDocument;
  focusPlacement(placementId: PlacementId | null): void;
  setViewport(viewport: CanvasViewport): void;
  /** Optional hit-test helper for shell chrome. */
  findPlacementAt?(point: { x: number; y: number }): PlacementId | null;
};

/**
 * Null / placeholder engine used until a real adapter is wired.
 * Keeps App shell and tests free of graph library deps.
 */
export class PlaceholderCanvasEngine implements CanvasEngine {
  readonly id = "placeholder";
  private document: CanvasDocument = { version: 1, placements: [] };
  private container: HTMLElement | null = null;
  private events: CanvasEngineEvents | undefined;

  mount(opts: CanvasEngineMount): void {
    this.container = opts.container;
    this.document = opts.document;
    this.events = opts.events;
    this.renderPlaceholder();
  }

  unmount(): void {
    if (this.container) this.container.replaceChildren();
    this.container = null;
    this.events = undefined;
  }

  setDocument(document: CanvasDocument): void {
    this.document = document;
    this.renderPlaceholder();
  }

  getDocument(): CanvasDocument {
    return this.document;
  }

  focusPlacement(placementId: PlacementId | null): void {
    this.document = {
      ...this.document,
      focusedPlacementId: placementId,
    };
    this.events?.onPlacementSelect?.(placementId);
    this.renderPlaceholder();
  }

  setViewport(viewport: CanvasViewport): void {
    this.document = { ...this.document, viewport };
    this.events?.onViewportChange?.(viewport);
  }

  findPlacementAt(_point: { x: number; y: number }): PlacementId | null {
    return this.document.focusedPlacementId ?? null;
  }

  private renderPlaceholder(): void {
    if (!this.container) return;
    const count = this.document.placements.length;
    const focused = this.document.focusedPlacementId ?? "—";
    this.container.replaceChildren();
    const el = document.createElement("div");
    el.className = "canvas-engine-placeholder";
    el.dataset.engine = this.id;
    el.setAttribute("role", "img");
    el.setAttribute(
      "aria-label",
      `Canvas placeholder · ${count} placements · focus ${focused}`
    );
    el.textContent = `CanvasEngine · placeholder · placements: ${count}`;
    this.container.appendChild(el);
  }
}

/** Helper for pure tests — no DOM. */
export function listPlacementIds(doc: CanvasDocument): PlacementId[] {
  return doc.placements.map((p: CanvasPlacement) => p.placementId);
}

export function placementEntityRef(
  doc: CanvasDocument,
  placementId: PlacementId
): string | undefined {
  return doc.placements.find((p) => p.placementId === placementId)?.entityRef;
}
