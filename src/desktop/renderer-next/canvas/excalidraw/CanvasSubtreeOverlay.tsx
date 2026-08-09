import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
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
  onHide: (placementId: string) => void;
  commandsEnabled: boolean;
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

function HideGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
      <path d="M3 3l14 14M8.4 5.1A8.7 8.7 0 0 1 10 5c4 0 6.8 3.8 6.8 3.8a10.8 10.8 0 0 1-2 2.4M11.8 12.7A4.6 4.6 0 0 1 10 13c-4 0-6.8-3.8-6.8-3.8a11 11 0 0 1 2.1-2.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const CanvasSubtreeOverlay = forwardRef<CanvasSubtreeOverlayHandle, Props>(
  function CanvasSubtreeOverlay(
    { document, projection, hoveredPlacementId, selectedPlacementId, onDirection, onHide, commandsEnabled },
    ref
  ) {
    const [directionMenuPlacementId, setDirectionMenuPlacementId] = useState<string | null>(null);
    const groupRef = useRef<SVGGElement>(null);
    const pathRefs = useRef(new Map<string, { base: SVGPathElement | null; highlight: SVGPathElement | null }>());
    const controlRefs = useRef(new Map<string, HTMLDivElement>());
    const placementActionRefs = useRef(new Map<string, HTMLDivElement>());
    const branches = useMemo(
      () => deriveCanvasSubtreeStructureBranches(document, projection),
      [document, projection]
    );
    const byPlacementId = useMemo(
      () => new Map(document.placements.map((placement) => [placement.placementId, placement] as const)),
      [document]
    );

    useEffect(() => {
      setDirectionMenuPlacementId(null);
    }, [selectedPlacementId]);

    useEffect(() => {
      if (
        directionMenuPlacementId &&
        !projection.controls.some((control) => control.placementId === directionMenuPlacementId)
      ) {
        setDirectionMenuPlacementId(null);
      }
    }, [directionMenuPlacementId, projection.controls]);

    useEffect(() => {
      if (!directionMenuPlacementId) return;
      const closeOnOutsidePointer = (event: PointerEvent) => {
        const control = controlRefs.current.get(directionMenuPlacementId);
        if (event.target instanceof Node && control?.contains(event.target)) return;
        setDirectionMenuPlacementId(null);
      };
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        const control = controlRefs.current.get(directionMenuPlacementId);
        setDirectionMenuPlacementId(null);
        requestAnimationFrame(() => {
          control?.querySelector<HTMLButtonElement>("[data-role=toggle]")?.focus({ preventScroll: true });
        });
      };
      window.addEventListener("pointerdown", closeOnOutsidePointer, true);
      window.addEventListener("keydown", closeOnEscape, true);
      return () => {
        window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        window.removeEventListener("keydown", closeOnEscape, true);
      };
    }, [directionMenuPlacementId]);

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
        for (const [placementId, element] of placementActionRefs.current) placeControl(placementId, element);
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
          const activeDirection = control.expandedDirection ?? control.lastDirection;
          const directionMenuOpen = !control.expandedDirection && directionMenuPlacementId === control.placementId;
          const count = control.projectedDirectChildCount;
          const label = control.expandedDirection
            ? `收起${directionLabel[control.expandedDirection]}侧 ${count} 个后代`
            : `展开子树，${count} 个直接后代`;
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
              data-menu-open={directionMenuOpen ? "true" : "false"}
              role="group"
              aria-label="子树投影"
            >
              <IconButton
                className="tn-canvas-subtree-controls__button"
                data-role="toggle"
                data-direction={activeDirection}
                variant="quiet"
                size="compact"
                aria-label={label}
                tooltip={label}
                aria-expanded={control.expandedDirection ? true : directionMenuOpen}
                aria-haspopup={control.expandedDirection ? undefined : "menu"}
                disabled={!control.canMutate}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  if (control.expandedDirection) {
                    onDirection(control.placementId, control.expandedDirection);
                    return;
                  }
                  setDirectionMenuPlacementId((current) => current === control.placementId ? null : control.placementId);
                }}
              >
                <DirectionGlyph direction={activeDirection} />
              </IconButton>
              {directionMenuOpen ? (
                <div className="tn-canvas-subtree-controls__menu" role="menu" aria-label="选择展开方向">
                  {(["up", "right", "down", "left"] as const).map((direction) => (
                  <IconButton
                    key={direction}
                    className="tn-canvas-subtree-controls__menu-button"
                    data-role="direction"
                    data-direction={direction}
                    variant="quiet"
                    size="compact"
                    role="menuitem"
                    aria-label={`向${directionLabel[direction]}展开 ${count} 个后代`}
                    tooltip={`向${directionLabel[direction]}展开`}
                    disabled={!control.canMutate}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => {
                      setDirectionMenuPlacementId(null);
                      onDirection(control.placementId, direction);
                    }}
                  >
                    <DirectionGlyph direction={direction} />
                  </IconButton>
                  ))}
                </div>
              ) : null}
              {control.unprojectedDirectChildCount > 0 ? (
                <span
                  className="tn-canvas-subtree-controls__pending"
                  title={`${control.unprojectedDirectChildCount} 个直接后代尚未进入此投影实例`}
                  aria-label={`${control.unprojectedDirectChildCount} 个直接后代尚未投影`}
                >
                  +{control.unprojectedDirectChildCount}
                </span>
              ) : null}
            </div>
          );
        })}
        {projection.visiblePlacementIds.map((placementId) => {
          const placement = byPlacementId.get(placementId);
          if (!placement || placement.kind !== "node") return null;
          const visible = placementId === selectedPlacementId || placementId === hoveredPlacementId;
          return (
            <div
              key={`placement-actions:${placementId}`}
              ref={(element) => {
                if (element) placementActionRefs.current.set(placementId, element);
                else placementActionRefs.current.delete(placementId);
              }}
              className="tn-canvas-placement-actions"
              data-visible={visible ? "true" : "false"}
            >
              <IconButton
                variant="quiet"
                size="compact"
                aria-label="在画布中隐藏"
                tooltip="在画布中隐藏"
                disabled={!commandsEnabled}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onHide(placementId)}
              >
                <HideGlyph />
              </IconButton>
            </div>
          );
        })}
      </>
    );
  }
);
