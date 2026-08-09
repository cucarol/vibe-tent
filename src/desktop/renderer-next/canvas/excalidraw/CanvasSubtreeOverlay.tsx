import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import type { CanvasDocument } from "../../types/identity.js";
import { NODE_CARD } from "../../model/canvas-document.js";
import {
  applyCanvasSubtreeStructureBranchPaths,
  deriveCanvasSubtreeStructureBranches,
} from "../../model/canvas-subtree-geometry.js";
import type {
  CanvasSubtreeProjection,
  SubtreeDirection,
} from "../../model/canvas-subtree-projection.js";
import { IconButton } from "../../ui/index.js";
import { ShellIcon } from "../../shell/icons.js";

export type CanvasSubtreeOverlayHandle = {
  update: (
    appState: Record<string, unknown>,
    override?: { placementId: string; x: number; y: number } | null
  ) => void;
};

type Props = {
  document: CanvasDocument;
  projection: CanvasSubtreeProjection;
  hoveredPlacementId: string | null;
  selectedPlacementId: string | null;
  onDirection: (placementId: string, direction: SubtreeDirection) => void;
  onSync: (placementId: string) => void;
};

const directionLabel: Record<SubtreeDirection, string> = {
  up: "上",
  right: "右",
  down: "下",
  left: "左",
};

function DirectionGlyph({ direction }: { direction: SubtreeDirection }) {
  const path = direction === "up"
    ? "M10 15V5m0 0-4 4m4-4 4 4"
    : direction === "right"
      ? "M5 10h10m0 0-4-4m4 4-4 4"
      : direction === "down"
        ? "M10 5v10m0 0-4-4m4 4 4-4"
        : "M15 10H5m0 0 4-4m-4 4 4 4";
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const CanvasSubtreeOverlay = forwardRef<CanvasSubtreeOverlayHandle, Props>(
  function CanvasSubtreeOverlay(
    { document, projection, hoveredPlacementId, selectedPlacementId, onDirection, onSync },
    ref
  ) {
    const groupRef = useRef<SVGGElement>(null);
    const pathRefs = useRef(new Map<string, { base: SVGPathElement | null; highlight: SVGPathElement | null }>());
    const controlRefs = useRef(new Map<string, HTMLDivElement>());
    const syncRefs = useRef(new Map<string, HTMLDivElement>());
    const branches = useMemo(
      () => deriveCanvasSubtreeStructureBranches(document, projection),
      [document, projection]
    );
    const byPlacementId = useMemo(
      () => new Map(document.placements.map((placement) => [placement.placementId, placement] as const)),
      [document]
    );

    useImperativeHandle(ref, () => ({
      update(appState, override = null) {
        const scrollX = typeof appState.scrollX === "number" ? appState.scrollX : 0;
        const scrollY = typeof appState.scrollY === "number" ? appState.scrollY : 0;
        const zoomRaw = (appState.zoom as { value?: unknown } | undefined)?.value;
        const zoom = typeof zoomRaw === "number" && Number.isFinite(zoomRaw) && zoomRaw > 0
          ? zoomRaw
          : 1;
        groupRef.current?.setAttribute(
          "transform",
          `translate(${scrollX * zoom} ${scrollY * zoom}) scale(${zoom})`
        );
        if (override) {
          applyCanvasSubtreeStructureBranchPaths(
            pathRefs.current,
            deriveCanvasSubtreeStructureBranches(document, projection, override)
          );
        }
        const placeControl = (placementId: string, element: HTMLDivElement) => {
          const placement = byPlacementId.get(placementId);
          if (!placement) return;
          const x = override?.placementId === placementId ? override.x : placement.x ?? 0;
          const y = override?.placementId === placementId ? override.y : placement.y ?? 0;
          element.style.left = `${(x + scrollX) * zoom}px`;
          element.style.top = `${(y + scrollY) * zoom}px`;
          element.style.width = `${NODE_CARD.width * zoom}px`;
          element.style.height = `${NODE_CARD.height * zoom}px`;
        };
        for (const [placementId, element] of controlRefs.current) placeControl(placementId, element);
        for (const [placementId, element] of syncRefs.current) placeControl(placementId, element);
      },
    }), [byPlacementId, document, projection]);

    return (
      <>
        <svg
          className="tn-canvas-subtree-lines"
          aria-hidden="true"
          focusable="false"
          data-testid="canvas-subtree-lines"
        >
          <g ref={groupRef}>
            {branches.map((branch) => (
              <g key={branch.id} data-branch-id={branch.id}>
                <path
                  ref={(element) => {
                    const current = pathRefs.current.get(branch.id) ?? { base: null, highlight: null };
                    current.base = element;
                    pathRefs.current.set(branch.id, current);
                  }}
                  className="tn-canvas-subtree-lines__path"
                  d={branch.path}
                  vectorEffect="non-scaling-stroke"
                />
                {branch.highlightPath ? (
                  <path
                    ref={(element) => {
                      const current = pathRefs.current.get(branch.id) ?? { base: null, highlight: null };
                      current.highlight = element;
                      pathRefs.current.set(branch.id, current);
                    }}
                    className="tn-canvas-subtree-lines__path tn-canvas-subtree-lines__path--highlight"
                    d={branch.highlightPath}
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null}
              </g>
            ))}
          </g>
        </svg>
        {projection.controls.map((control) => {
          const visible = control.placementId === selectedPlacementId || control.placementId === hoveredPlacementId;
          const directions: readonly SubtreeDirection[] = control.expandedDirection
            ? [control.expandedDirection]
            : ["up", "right", "down", "left"];
          return (
            <div
              key={`control:${control.placementId}`}
              ref={(element) => {
                if (element) controlRefs.current.set(control.placementId, element);
                else controlRefs.current.delete(control.placementId);
              }}
              className="tn-canvas-subtree-controls"
              data-visible={visible ? "true" : "false"}
              data-expanded={control.expandedDirection ?? "collapsed"}
              role="group"
              aria-label="子树投影方向"
            >
              {directions.map((direction) => {
                const expanded = control.expandedDirection === direction;
                const count = control.projectedDirectChildCount;
                const label = expanded
                  ? `收起${directionLabel[direction]}侧 ${count} 个后代`
                  : `向${directionLabel[direction]}展开 ${count} 个后代`;
                return (
                  <IconButton
                    key={direction}
                    className="tn-canvas-subtree-controls__button"
                    data-direction={direction}
                    variant="quiet"
                    size="compact"
                    aria-label={label}
                    tooltip={label}
                    aria-expanded={expanded}
                    disabled={!control.canMutate}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onDirection(control.placementId, direction)}
                  >
                    <DirectionGlyph direction={direction} />
                  </IconButton>
                );
              })}
              {control.unprojectedDirectChildCount > 0 ? (
                <span className="tn-canvas-subtree-controls__pending">
                  +{control.unprojectedDirectChildCount} 未投影
                </span>
              ) : null}
            </div>
          );
        })}
        {projection.syncControls.map((control) => {
          const visible = control.placementId === selectedPlacementId || control.placementId === hoveredPlacementId;
          const label = control.scope === "subtree"
            ? `同步投影，${control.affectedCount} 项待更新`
            : "同步快照";
          return (
            <div
              key={`sync:${control.placementId}`}
              ref={(element) => {
                if (element) syncRefs.current.set(control.placementId, element);
                else syncRefs.current.delete(control.placementId);
              }}
              className="tn-canvas-projection-sync"
              data-visible={visible ? "true" : "false"}
            >
              <IconButton
                variant="quiet"
                size="compact"
                aria-label={label}
                tooltip={label}
                disabled={!control.canSync}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onSync(control.placementId)}
              >
                <ShellIcon name="refresh" />
              </IconButton>
              {control.scope === "subtree" ? <span>{control.affectedCount}</span> : null}
            </div>
          );
        })}
      </>
    );
  }
);
