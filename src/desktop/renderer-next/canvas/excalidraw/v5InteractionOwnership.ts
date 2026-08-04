/**
 * Canvas V5 single-scene interaction ownership.
 * Excalidraw owns camera + free drawing; Tent embeddable activation is a nested
 * owner that Escape / blank click must release back to canvas gestures.
 */

export type V5GestureOwner = "canvas" | "embeddable-active" | "chrome";

export type V5OwnershipState = {
  owner: V5GestureOwner;
  /** Active embeddable element id when owner is embeddable-active. */
  activeElementId: string | null;
  /** Focused tent placement (drives right Focus), independent of embeddable active. */
  focusedPlacementId: string | null;
};

export type V5OwnershipEvent =
  | { type: "select-placement"; placementId: string | null }
  | { type: "activate-embeddable"; elementId: string }
  | { type: "escape" }
  | { type: "pointer-blank" }
  | { type: "chrome-focus" }
  | { type: "chrome-blur" };

export function createV5OwnershipState(
  focusedPlacementId: string | null = null
): V5OwnershipState {
  return {
    owner: "canvas",
    activeElementId: null,
    focusedPlacementId,
  };
}

/**
 * Pure ownership transition. Escape always exits embeddable-active first;
 * a second Escape (or blank click) clears placement focus back to canvas.
 */
export function reduceV5Ownership(
  state: V5OwnershipState,
  event: V5OwnershipEvent
): V5OwnershipState {
  switch (event.type) {
    case "chrome-focus":
      return { ...state, owner: "chrome" };
    case "chrome-blur":
      return {
        ...state,
        owner: state.activeElementId ? "embeddable-active" : "canvas",
      };
    case "select-placement":
      return {
        ...state,
        focusedPlacementId: event.placementId,
        owner: state.activeElementId ? "embeddable-active" : "canvas",
      };
    case "activate-embeddable":
      return {
        ...state,
        owner: "embeddable-active",
        activeElementId: event.elementId,
      };
    case "escape":
      if (state.owner === "chrome") {
        return { ...state, owner: "canvas" };
      }
      if (state.owner === "embeddable-active" || state.activeElementId) {
        return {
          ...state,
          owner: "canvas",
          activeElementId: null,
        };
      }
      if (state.focusedPlacementId) {
        return {
          ...state,
          owner: "canvas",
          focusedPlacementId: null,
          activeElementId: null,
        };
      }
      return { ...state, owner: "canvas", activeElementId: null };
    case "pointer-blank":
      if (state.owner === "embeddable-active" || state.activeElementId) {
        return {
          ...state,
          owner: "canvas",
          activeElementId: null,
        };
      }
      return {
        ...state,
        owner: "canvas",
        focusedPlacementId: null,
        activeElementId: null,
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * Whether canvas pan/draw gestures should receive the pointer.
 * Embeddable-active keeps gestures inside the React card until Escape.
 */
export function canvasGesturesEnabled(state: V5OwnershipState): boolean {
  return state.owner === "canvas";
}

export function embeddableInteractive(
  state: V5OwnershipState,
  elementId: string
): boolean {
  return (
    state.owner === "embeddable-active" && state.activeElementId === elementId
  );
}
