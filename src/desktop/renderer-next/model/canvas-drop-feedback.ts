export type CanvasDropFeedbackState = {
  phase: "idle" | "target" | "success";
  depth: number;
};

export const IDLE_CANVAS_DROP_FEEDBACK: CanvasDropFeedbackState = {
  phase: "idle",
  depth: 0,
};

/**
 * HTML dragenter/dragleave fires once per nested child. Keep one local depth
 * owner so the Canvas target does not flicker while crossing Excalidraw DOM.
 */
export function enterCanvasDropTarget(
  current: CanvasDropFeedbackState
): CanvasDropFeedbackState {
  return { phase: "target", depth: current.depth + 1 };
}

export function leaveCanvasDropTarget(
  current: CanvasDropFeedbackState
): CanvasDropFeedbackState {
  const depth = Math.max(0, current.depth - 1);
  return depth === 0 ? IDLE_CANVAS_DROP_FEEDBACK : { phase: "target", depth };
}

export function completeCanvasDrop(
  accepted: boolean
): CanvasDropFeedbackState {
  return accepted ? { phase: "success", depth: 0 } : IDLE_CANVAS_DROP_FEEDBACK;
}
