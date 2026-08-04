import type { CanvasEngine } from "../canvas/engine.js";
import type { CanvasDocument } from "../types/identity.js";
import { CanvasSurface } from "../surfaces/CanvasSurface.js";

export type SurfaceStageProps = {
  canvasEngine: CanvasEngine;
  canvasDocument: CanvasDocument;
};

/** Compatibility seam for the isolated foundation tests; production AppShell uses CanvasWorkbench. */
export function SurfaceStage({ canvasEngine, canvasDocument }: SurfaceStageProps) {
  return <CanvasSurface engine={canvasEngine} document={canvasDocument} />;
}
