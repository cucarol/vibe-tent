/**
 * Local Outline chrome state for the next renderer foundation.
 *
 * Outline is a default-collapsed drawer/overlay invoked from rail/chrome —
 * not a permanent grid column and not a stage surface. No real tree or RPC
 * here: only the open/expand/locate interfaces future projections bind to.
 */

import type { EntityRef } from "./identity.js";

/** Stable DOM id for the Outline panel (aria-controls target). */
export const OUTLINE_PANEL_ID = "tn-outline-panel";

/** Stable DOM id for the primary Outline toggle control. */
export const OUTLINE_TOGGLE_ID = "tn-outline-toggle";

/**
 * Machine-local Outline chrome. Not Service truth.
 * - `open`: drawer/overlay visibility (default false = collapsed).
 * - `expandedIds`: which tree node keys are expanded (placeholder keys).
 * - `currentEntityRef`: entity the chrome should reveal/highlight when open.
 */
export type OutlineChromeState = {
  open: boolean;
  expandedIds: readonly string[];
  currentEntityRef: EntityRef | null;
};

export function createDefaultOutlineChrome(): OutlineChromeState {
  return {
    open: false,
    expandedIds: [],
    currentEntityRef: null,
  };
}

export function isOutlineOpen(state: OutlineChromeState): boolean {
  return state.open === true;
}

export function openOutline(state: OutlineChromeState): OutlineChromeState {
  if (state.open) return state;
  return { ...state, open: true };
}

export function closeOutline(state: OutlineChromeState): OutlineChromeState {
  if (!state.open) return state;
  return { ...state, open: false };
}

export function toggleOutline(state: OutlineChromeState): OutlineChromeState {
  return { ...state, open: !state.open };
}

export function setOutlineExpanded(
  state: OutlineChromeState,
  nodeId: string,
  expanded: boolean
): OutlineChromeState {
  const has = state.expandedIds.includes(nodeId);
  if (expanded && has) return state;
  if (!expanded && !has) return state;
  const expandedIds = expanded
    ? [...state.expandedIds, nodeId]
    : state.expandedIds.filter((id) => id !== nodeId);
  return { ...state, expandedIds };
}

export function toggleOutlineExpanded(
  state: OutlineChromeState,
  nodeId: string
): OutlineChromeState {
  return setOutlineExpanded(
    state,
    nodeId,
    !state.expandedIds.includes(nodeId)
  );
}

/**
 * Point Outline at a domain entity and open the drawer so chrome can scroll/
 * highlight it later. Does not fetch projections or invent tree nodes.
 */
export function locateOutlineEntity(
  state: OutlineChromeState,
  entityRef: EntityRef | null
): OutlineChromeState {
  return {
    ...state,
    open: true,
    currentEntityRef: entityRef,
  };
}
