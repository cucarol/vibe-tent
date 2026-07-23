import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PlaceholderCanvasEngine,
  type CanvasEngine,
} from "../canvas/engine.js";
import { ServiceGateway } from "../gateway/service-gateway.js";
import {
  createEmptyCanvasDocument,
  type CanvasDocument,
} from "../types/identity.js";
import {
  OUTLINE_PANEL_ID,
  OUTLINE_TOGGLE_ID,
  closeOutline,
  createDefaultOutlineChrome,
  toggleOutline,
  type OutlineChromeState,
} from "../types/outline.js";
import {
  APP_SURFACES,
  defaultAppSurface,
  type AppSurfaceId,
} from "../types/surfaces.js";
import { Outline } from "./Outline.js";
import { SurfaceStage } from "./SurfaceStage.js";

export type AppShellProps = {
  /** Optional injected gateway (tests / future preload bridge). */
  gateway?: ServiceGateway;
  /** Optional canvas engine (defaults to PlaceholderCanvasEngine). */
  canvasEngine?: CanvasEngine;
  /** Initial local canvas document. */
  initialDocument?: CanvasDocument;
  /** Initial stage surface. */
  initialSurface?: AppSurfaceId;
  /** Initial Outline chrome (default collapsed). */
  initialOutline?: OutlineChromeState;
  /**
   * Optional controlled Outline chrome. When set with `onOutlineChange`, the
   * shell reports open/toggle/close so hosts can apply expand/locate helpers
   * from `types/outline.ts` without inventing a real tree.
   */
  outline?: OutlineChromeState;
  onOutlineChange?: (next: OutlineChromeState) => void;
};

/**
 * Canvas-first single-window app shell.
 * Rail + stage surfaces; Outline is a default-collapsed drawer/overlay
 * invoked from rail or chrome — not a permanent grid column.
 *
 * Open / expand / locate-entity interfaces live in `types/outline.ts`
 * (`OutlineChromeState` + pure helpers). Shell owns the open flag and a11y.
 */
export function AppShell(props: AppShellProps = {}) {
  const gateway = useMemo(
    () => props.gateway ?? new ServiceGateway(),
    [props.gateway]
  );
  const engine = useMemo(
    () => props.canvasEngine ?? new PlaceholderCanvasEngine(),
    [props.canvasEngine]
  );
  const [surface, setSurface] = useState<AppSurfaceId>(
    () => props.initialSurface ?? defaultAppSurface()
  );
  const [document] = useState<CanvasDocument>(
    () => props.initialDocument ?? createEmptyCanvasDocument()
  );
  const [internalOutline, setInternalOutline] = useState<OutlineChromeState>(
    () => props.initialOutline ?? createDefaultOutlineChrome()
  );
  const controlled = props.outline !== undefined;
  const outline = controlled ? props.outline! : internalOutline;

  const commitOutline = useCallback(
    (next: OutlineChromeState) => {
      if (props.onOutlineChange) props.onOutlineChange(next);
      if (!controlled) setInternalOutline(next);
    },
    [controlled, props.onOutlineChange]
  );

  const handleToggleOutline = useCallback(() => {
    commitOutline(toggleOutline(outline));
  }, [commitOutline, outline]);

  const handleCloseOutline = useCallback(() => {
    commitOutline(closeOutline(outline));
  }, [commitOutline, outline]);

  useEffect(() => {
    if (!outline.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        commitOutline(closeOutline(outline));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [outline, commitOutline]);

  return (
    <div
      className="tn-app"
      data-shell="renderer-next"
      data-surface={surface}
      data-outline-open={outline.open ? "true" : "false"}
    >
      <nav className="tn-rail" aria-label="Surfaces">
        <button
          id={OUTLINE_TOGGLE_ID}
          type="button"
          data-outline-toggle="rail"
          aria-expanded={outline.open}
          aria-controls={OUTLINE_PANEL_ID}
          title="Outline"
          onClick={handleToggleOutline}
        >
          Outline
        </button>
        {APP_SURFACES.map((s) => (
          <button
            key={s.id}
            type="button"
            data-surface-nav={s.id}
            aria-current={surface === s.id ? "page" : undefined}
            title={s.label}
            onClick={() => setSurface(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <header className="tn-chrome" data-region="chrome">
        <button
          type="button"
          data-outline-toggle="chrome"
          aria-expanded={outline.open}
          aria-controls={OUTLINE_PANEL_ID}
          title="Outline"
          onClick={handleToggleOutline}
        >
          Outline
        </button>
        <strong>帷幄 · Tent</strong>
        <span className="tn-chrome-surface" data-testid="active-surface">
          {surface}
        </span>
        <span className="sr-only">
          Service gateway dirty: {gateway.isDirty() ? "yes" : "no"}
        </span>
      </header>

      <main className="tn-stage" data-region="stage" id="tn-stage">
        <SurfaceStage
          surface={surface}
          canvasEngine={engine}
          canvasDocument={document}
        />
      </main>

      <footer className="tn-status" data-region="status">
        <span>renderer-next foundation</span>
        <span aria-hidden="true">·</span>
        <span>Service sole authority · events invalidate only</span>
      </footer>

      <Outline chrome={outline} onClose={handleCloseOutline} />
    </div>
  );
}
