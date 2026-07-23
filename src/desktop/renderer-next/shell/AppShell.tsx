import { useMemo, useState } from "react";
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
};

/**
 * Canvas-first single-window app shell.
 * Rail + Outline (always on) + stage surfaces; no multi-window product model.
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

  return (
    <div className="tn-app" data-shell="renderer-next" data-surface={surface}>
      <nav className="tn-rail" aria-label="Surfaces">
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

      <Outline />

      <header className="tn-chrome" data-region="chrome">
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
    </div>
  );
}
