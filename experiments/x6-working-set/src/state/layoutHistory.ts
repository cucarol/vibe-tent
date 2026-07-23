/**
 * Layout-only undo/redo. Domain/lifecycle intents are recorded for display
 * but never enter this stack.
 */

import {
  applyGroupAssign,
  cloneDocument,
  setViewport,
  updatePlacement,
} from "../model/canvasDocument.js";
import type { CanvasDocument, LayoutCommand } from "../model/types.js";

export type LayoutHistoryState = {
  document: CanvasDocument;
  undoStack: LayoutCommand[];
  redoStack: LayoutCommand[];
};

export function createLayoutHistory(document: CanvasDocument): LayoutHistoryState {
  return {
    document: cloneDocument(document),
    undoStack: [],
    redoStack: [],
  };
}

function applyForward(doc: CanvasDocument, cmd: LayoutCommand): CanvasDocument {
  switch (cmd.type) {
    case "move":
      return updatePlacement(doc, cmd.placementId, {
        x: cmd.after.x,
        y: cmd.after.y,
      });
    case "resize":
      return updatePlacement(doc, cmd.placementId, {
        x: cmd.after.x,
        y: cmd.after.y,
        width: cmd.after.width,
        height: cmd.after.height,
      });
    case "viewport":
      return setViewport(doc, cmd.after);
    case "group-assign":
      return applyGroupAssign(doc, cmd.placementIds, cmd.afterGroupId);
    case "batch": {
      let next = doc;
      for (const step of cmd.steps) next = applyForward(next, step);
      return next;
    }
    default: {
      const _exhaustive: never = cmd;
      return _exhaustive;
    }
  }
}

function applyBackward(doc: CanvasDocument, cmd: LayoutCommand): CanvasDocument {
  switch (cmd.type) {
    case "move":
      return updatePlacement(doc, cmd.placementId, {
        x: cmd.before.x,
        y: cmd.before.y,
      });
    case "resize":
      return updatePlacement(doc, cmd.placementId, {
        x: cmd.before.x,
        y: cmd.before.y,
        width: cmd.before.width,
        height: cmd.before.height,
      });
    case "viewport":
      return setViewport(doc, cmd.before);
    case "group-assign":
      return applyGroupAssign(doc, cmd.placementIds, cmd.beforeGroupId);
    case "batch": {
      let next = doc;
      for (let i = cmd.steps.length - 1; i >= 0; i--) {
        next = applyBackward(next, cmd.steps[i]!);
      }
      return next;
    }
    default: {
      const _exhaustive: never = cmd;
      return _exhaustive;
    }
  }
}

export function pushLayoutCommand(
  state: LayoutHistoryState,
  cmd: LayoutCommand
): LayoutHistoryState {
  return {
    document: applyForward(state.document, cmd),
    undoStack: [...state.undoStack, cmd],
    redoStack: [],
  };
}

export function undoLayout(state: LayoutHistoryState): LayoutHistoryState {
  if (state.undoStack.length === 0) return state;
  const cmd = state.undoStack[state.undoStack.length - 1]!;
  return {
    document: applyBackward(state.document, cmd),
    undoStack: state.undoStack.slice(0, -1),
    redoStack: [...state.redoStack, cmd],
  };
}

export function redoLayout(state: LayoutHistoryState): LayoutHistoryState {
  if (state.redoStack.length === 0) return state;
  const cmd = state.redoStack[state.redoStack.length - 1]!;
  return {
    document: applyForward(state.document, cmd),
    undoStack: [...state.undoStack, cmd],
    redoStack: state.redoStack.slice(0, -1),
  };
}

export function canUndo(state: LayoutHistoryState): boolean {
  return state.undoStack.length > 0;
}

export function canRedo(state: LayoutHistoryState): boolean {
  return state.redoStack.length > 0;
}

/** Replace document without history (e.g. restore snapshot). */
export function replaceDocument(
  state: LayoutHistoryState,
  document: CanvasDocument,
  clearHistory = false
): LayoutHistoryState {
  return {
    document: cloneDocument(document),
    undoStack: clearHistory ? [] : state.undoStack,
    redoStack: clearHistory ? [] : state.redoStack,
  };
}
