/**
 * UI intents for the next renderer.
 *
 * Three undo policies stay separate (frozen boundary):
 * - layout: pure local Canvas geometry / chrome (undoable in UI)
 * - reversible-domain: Service mutations that may be reversed via command
 * - lifecycle: irreversible or policy-gated domain steps (no silent undo)
 *
 * Intents describe *what the UI wants*; ServiceGateway owns actual mutation.
 */

/** How an intent may participate in undo/redo chrome. */
export type UndoPolicy = "layout" | "reversible-domain" | "lifecycle";

/** Base fields shared by every UI intent. */
export type UiIntentBase = {
  /** Stable intent type id (e.g. "canvas.pan", "task.deliver"). */
  type: string;
  undoPolicy: UndoPolicy;
  /** Optional correlation for projection invalidation / tracing. */
  intentId?: string;
  /** Opaque payload — never a second source of domain truth. */
  payload?: Readonly<Record<string, unknown>>;
};

/**
 * Layout intents only touch local CanvasDocument / chrome.
 * They must not call Service mutation paths.
 */
export type LayoutIntent = UiIntentBase & {
  undoPolicy: "layout";
};

/**
 * Reversible domain intents become Service commands that the product may
 * later reverse (where Core supports it). UI never invents reverse RPCs.
 */
export type ReversibleDomainIntent = UiIntentBase & {
  undoPolicy: "reversible-domain";
};

/**
 * Lifecycle intents (claim, accept, reject, start session, …) are not
 * silently undoable in the UI chrome.
 */
export type LifecycleIntent = UiIntentBase & {
  undoPolicy: "lifecycle";
};

export type UiIntent = LayoutIntent | ReversibleDomainIntent | LifecycleIntent;

export function isLayoutIntent(intent: UiIntent): intent is LayoutIntent {
  return intent.undoPolicy === "layout";
}

export function isReversibleDomainIntent(
  intent: UiIntent
): intent is ReversibleDomainIntent {
  return intent.undoPolicy === "reversible-domain";
}

export function isLifecycleIntent(intent: UiIntent): intent is LifecycleIntent {
  return intent.undoPolicy === "lifecycle";
}

/** Discriminate undo chrome without re-opening domain rules. */
export function undoPolicyOf(intent: UiIntent): UndoPolicy {
  return intent.undoPolicy;
}
