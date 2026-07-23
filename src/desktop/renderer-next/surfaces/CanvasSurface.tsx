import { useEffect, useRef } from "react";
import type { CanvasEngine } from "../canvas/engine.js";
import type { CanvasDocument } from "../types/identity.js";
import { SurfacePlaceholder } from "./SurfacePlaceholder.js";

export type CanvasSurfaceProps = {
  engine: CanvasEngine;
  document: CanvasDocument;
};

/**
 * Canvas-first stage host. Mounts a CanvasEngine adapter into a host node.
 * Outline is shell drawer chrome, not part of this stage surface.
 */
export function CanvasSurface(props: CanvasSurfaceProps) {
  const { engine, document } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    engine.mount({ container: el, document });
    return () => engine.unmount();
    // Mount once per engine; document updates use setDocument below.
  }, [engine]);

  useEffect(() => {
    engine.setDocument(document);
  }, [engine, document]);

  return (
    <SurfacePlaceholder
      surfaceId="canvas"
      title="Canvas"
      description="Working-set Canvas stage. entityRef is domain identity; placementId is local layout only. CanvasDocument is machine-local UI state — Service remains the sole fact authority."
    >
      <div
        ref={hostRef}
        className="tn-canvas-host"
        data-testid="canvas-engine-host"
      />
    </SurfacePlaceholder>
  );
}
