/**
 * Stable identity types for the next renderer foundation.
 *
 * Frozen boundary: entityRef (Service/domain identity) is never the same
 * Node as placementId (local Canvas layout instance). Draft field shapes
 * from exploration nodes must not be hard-coded here.
 */

/** Opaque Service/domain entity reference (Node, Task, TaskResult, …). */
export type EntityRef = string;

/** Local Canvas placement instance id — UI-only; may point at an EntityRef. */
export type PlacementId = string;

/** Machine-local Canvas presentation preference, never a Service fact. */
export type CanvasBackgroundMode = "grid" | "blank";

/**
 * A placement on the local CanvasDocument.
 * Position/size are optional so early shells can host placeholders without
 * inventing a final layout schema.
 */
export type CanvasPlacement = {
  placementId: PlacementId;
  /** Domain entity this placement projects, if any. */
  entityRef?: EntityRef;
  kind: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zIndex?: number;
  meta?: Readonly<Record<string, unknown>>;
};

/**
 * Local-only Canvas document state. Not a Service fact; never treated as
 * domain truth. Rebuilt / persisted as machine-local UI state.
 */
export type CanvasDocument = {
  version: 1;
  placements: readonly CanvasPlacement[];
  /** Local presentation only; never a Service/domain fact. */
  backgroundMode?: CanvasBackgroundMode;
  /** Which placement currently has focus chrome, if any. */
  focusedPlacementId?: PlacementId | null;
  /** Viewport camera — opaque to keep schema open. */
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  };
};

export function createEmptyCanvasDocument(): CanvasDocument {
  return {
    version: 1,
    placements: [],
    backgroundMode: "blank",
    focusedPlacementId: null,
  };
}
