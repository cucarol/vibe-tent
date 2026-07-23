import type { CanvasEngine } from "../canvas/engine.js";
import type { CanvasDocument } from "../types/identity.js";
import type { AppSurfaceId } from "../types/surfaces.js";
import {
  ActivitySurface,
  CanvasSurface,
  FocusWorkspaceSurface,
  InboxSurface,
  SearchSurface,
  SettingsSurface,
} from "../surfaces/index.js";

export type SurfaceStageProps = {
  surface: AppSurfaceId;
  canvasEngine: CanvasEngine;
  canvasDocument: CanvasDocument;
};

/** Single-window stage host: one active surface at a time. */
export function SurfaceStage(props: SurfaceStageProps) {
  const { surface, canvasEngine, canvasDocument } = props;

  switch (surface) {
    case "canvas":
      return (
        <CanvasSurface engine={canvasEngine} document={canvasDocument} />
      );
    case "focus-workspace":
      return <FocusWorkspaceSurface />;
    case "inbox":
      return <InboxSurface />;
    case "search":
      return <SearchSurface />;
    case "settings":
      return <SettingsSurface />;
    case "activity":
      return <ActivitySurface />;
    default: {
      const _exhaustive: never = surface;
      return _exhaustive;
    }
  }
}
