/**
 * Production Canvas V5 host: Excalidraw is the sole scene / camera / interaction
 * engine. Tent Nodes render via public renderEmbeddable; CanvasDocument + Drawing
 * V4 remain local presentation / ink stores.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { CanvasDocument } from "../../types/identity.js";
import {
  removePlacement,
  setFocusedPlacement,
  withViewport,
  DEFAULT_VIEWPORT,
} from "../../model/canvas-document.js";
import type {
  CanvasEdgeLayerVisibility,
  GraphEdgeSource,
} from "../../model/canvas-edges.js";
import type { DrawingPersistenceStatus } from "../../model/drawing-persistence-status.js";
import {
  applyPlacementPatches,
  buildTentEmbeddableCardModels,
  captureTentNodeOpenTarget,
  deletedTentPlacementIds,
  extractPlacementPatchesFromElements,
  readTentNodeCustomData,
  selectionToFocusedPlacement,
  tentPlacementElementId,
  validateTentEmbeddableLink,
  viewportFromExcalidrawAppState,
  excalidrawAppStateFromViewport,
  type CanvasNodeResolvers,
} from "./documentToExcalidraw.js";
import { togglePlacementPresentation } from "../../model/placement-chrome.js";
import {
  schedulePostMountCanvasViewportSync,
  viewportAfterCanvasResize,
} from "../../model/canvas-viewport-resize.js";
import { CANVAS_V5_COLORS } from "./canvasV5Theme.js";
import { Button } from "../../ui/index.js";
import type { ExcalidrawSceneSnapshot } from "./excalidrawSceneTypes.js";
import { sceneContentSignature } from "./sceneContentSignature.js";
import {
  hydrateCanvasV5Scene,
  sceneSnapshotForV4Persist,
} from "./v5Migration.js";
import {
  createV5OwnershipState,
  embeddableInteractive,
  reduceV5Ownership,
  type V5OwnershipState,
} from "./v5InteractionOwnership.js";
import {
  TentEmbeddableNode,
  type TentEmbeddableNodeData,
  type TentEmbeddableNodeState,
} from "./TentEmbeddableNode.js";
import {
  shouldRefreshCanvasV5Scene,
  type LiveSceneInputs,
} from "./sceneRefreshPolicy.js";
import {
  createCanvasV5PersistGate,
  flushCanvasV5PersistGates,
} from "./canvasV5PersistGate.js";
import "./tent-embeddable-prototype.css";
import "./canvas-v5-host.css";

export type CanvasV5HostProps = {
  document: CanvasDocument;
  onDocumentChange: (document: CanvasDocument) => void;
  onSelectPlacement: (
    placementId: string | null,
    entityRef: string | null
  ) => void;
  resolvers?: CanvasNodeResolvers;
  graph?: GraphEdgeSource | null;
  edgeLayers: CanvasEdgeLayerVisibility;
  onToggleEdgeLayer?: (layer: keyof CanvasEdgeLayerVisibility) => void;
  initialScene?: ExcalidrawSceneSnapshot | null;
  scopeGeneration?: number;
  layerVisible: boolean;
  onLayerVisibleChange: (visible: boolean) => void;
  persistenceStatus: DrawingPersistenceStatus;
  onRetryPersistence?: () => void;
  onScenePersist?: (
    snapshot: ExcalidrawSceneSnapshot,
    layerVisible: boolean
  ) => void;
  className?: string;
  style?: CSSProperties;
  immersive?: boolean;
  onImmersiveChange?: (immersive: boolean) => void;
};

type ExcalidrawApi = {
  updateScene: (scene: {
    appState?: Record<string, unknown>;
    elements?: readonly unknown[];
    captureUpdate?: string;
  }) => void;
  getSceneElements?: () => readonly unknown[];
  getAppState?: () => Record<string, unknown>;
  getFiles?: () => Record<string, unknown>;
  resetScene?: () => void;
};

type ExcalidrawComponentProps = {
  excalidrawAPI?: (api: ExcalidrawApi) => void;
  initialData?: {
    elements?: readonly unknown[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
  };
  onChange?: (
    elements: readonly unknown[],
    appState: Record<string, unknown> & {
      scrollX?: number;
      scrollY?: number;
      zoom?: { value: number };
      selectedElementIds?: Record<string, boolean>;
      activeEmbeddable?: {
        element?: { id?: string };
        state?: "hover" | "active";
      } | null;
    },
    files: Record<string, unknown>
  ) => void;
  viewModeEnabled?: boolean;
  zenModeEnabled?: boolean;
  gridModeEnabled?: boolean;
  theme?: "light" | "dark";
  langCode?: string;
  detectScroll?: boolean;
  handleKeyboardGlobally?: boolean;
  validateEmbeddable?: (link: string) => boolean;
  renderEmbeddable?: (
    element: { id: string; link?: string | null; customData?: unknown },
    appState: Record<string, unknown>
  ) => ReactNode;
  onLinkOpen?: (
    element: { id: string; link?: string | null; customData?: unknown },
    event: { preventDefault: () => void }
  ) => void;
  UIOptions?: {
    canvasActions?: Record<string, boolean>;
    tools?: { image?: boolean };
  };
};

const ExcalidrawLazy = lazy(async () => {
  const mod = await import("@excalidraw/excalidraw");
  await import("@excalidraw/excalidraw/index.css");
  const pack = mod as { Excalidraw: ComponentType<ExcalidrawComponentProps> };
  return { default: pack.Excalidraw };
});

const CANVAS_COPY = {
  "canvas.display.aria": "画布显示设置",
  "canvas.display": "显示",
  "canvas.immersive.exit": "退出沉浸",
  "canvas.immersive.enter": "沉浸画布",
  "canvas.drawing.hide": "隐藏绘图",
  "canvas.drawing.show": "显示绘图",
  "canvas.relations.help": "选择要在画布中显示的关系",
  "canvas.relations": "关系",
  "canvas.layer.parent": "父子",
  "canvas.layer.markdown": "Markdown",
  "canvas.layer.wiki": "Wiki",
  "canvas.layer.relation": "语义关系",
  "canvas.aria": "Tent 画布",
} as const;

function canvasCopy(key: keyof typeof CANVAS_COPY): string {
  return CANVAS_COPY[key];
}

function statusMessage(status: DrawingPersistenceStatus): string | null {
  return status.kind === "ok" ? null : status.message;
}

function toNodeData(model: {
  nodeId: string;
  title: string;
  typeLabel: string;
  detail: string;
  recovery: string;
  summary?: string;
  state: TentEmbeddableNodeState;
  stateLabel: string;
  rawTaskState?: string | null;
}): TentEmbeddableNodeData {
  return {
    nodeId: model.nodeId,
    title: model.title,
    type: model.typeLabel,
    state: model.state,
    stateLabel: model.stateLabel,
    rawTaskState: model.rawTaskState,
    detail: model.summary ? `${model.detail} ${model.summary}` : model.detail,
  };
}

export function CanvasV5Host(props: CanvasV5HostProps) {
  const {
    document: canvasDocument,
    onDocumentChange,
    onSelectPlacement,
    resolvers = {},
    graph = null,
    edgeLayers,
    onToggleEdgeLayer,
    initialScene = null,
    scopeGeneration = 0,
    layerVisible,
    onLayerVisibleChange,
    persistenceStatus,
    onRetryPersistence,
    onScenePersist,
    immersive = false,
    onImmersiveChange,
  } = props;

  const documentRef = useRef(canvasDocument);
  documentRef.current = canvasDocument;
  const onDocumentChangeRef = useRef(onDocumentChange);
  onDocumentChangeRef.current = onDocumentChange;
  const onSelectPlacementRef = useRef(onSelectPlacement);
  onSelectPlacementRef.current = onSelectPlacement;
  const onScenePersistRef = useRef(onScenePersist);
  onScenePersistRef.current = onScenePersist;
  const layerVisibleRef = useRef(layerVisible);
  layerVisibleRef.current = layerVisible;

  const applyingExternal = useRef(false);
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const cancelApiViewportSyncRef = useRef<(() => void) | null>(null);
  const lastInternallyPublishedDocument = useRef<CanvasDocument | null>(null);
  const liveSceneInputs = useRef<LiveSceneInputs>({
    document: canvasDocument,
    graph,
    edgeLayers,
  });
  const lastPersistedDrawingSig = useRef<string>("");
  const persistGate = useRef(createCanvasV5PersistGate(120));
  const placementPersistGate = useRef(createCanvasV5PersistGate(80));

  const publishDocument = useCallback((nextDocument: CanvasDocument) => {
    lastInternallyPublishedDocument.current = nextDocument;
    documentRef.current = nextDocument;
    onDocumentChangeRef.current(nextDocument);
  }, []);

  const hydrated = useMemo(
    () =>
      hydrateCanvasV5Scene({
        document: canvasDocument,
        drawingScene: initialScene,
        resolvers,
        graph,
        edgeLayers,
      }),
    // Scope generation is the authoritative tab/workspace boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeGeneration]
  );

  const [mountKey, setMountKey] = useState(0);
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const [loadBanner, setLoadBanner] = useState<string | null>(() =>
    hydrated.status.kind === "ok" ? null : hydrated.status.message
  );
  const [ownership, setOwnership] = useState<V5OwnershipState>(() =>
    createV5OwnershipState(canvasDocument.focusedPlacementId ?? null)
  );
  const ownershipRef = useRef(ownership);
  ownershipRef.current = ownership;
  const hostRef = useRef<HTMLDivElement>(null);
  const initialDataRef = useRef({
    elements: hydrated.elements as unknown[],
    appState: hydrated.appState,
    files: hydrated.files,
  });

  useEffect(() => {
    const next = hydrateCanvasV5Scene({
      document: documentRef.current,
      drawingScene: initialScene,
      resolvers,
      graph,
      edgeLayers,
    });
    initialDataRef.current = {
      elements: next.elements as unknown[],
      appState: next.appState,
      files: next.files,
    };
    setLoadBanner(next.status.kind === "ok" ? null : next.status.message);
    setOwnership(
      createV5OwnershipState(documentRef.current.focusedPlacementId ?? null)
    );
    setMountKey((k) => k + 1);
    lastPersistedDrawingSig.current = "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeGeneration]);

  useEffect(() => {
    const previous = liveSceneInputs.current;
    const next = { document: canvasDocument, graph, edgeLayers };
    liveSceneInputs.current = next;
    if (
      !shouldRefreshCanvasV5Scene(
        previous,
        next,
        lastInternallyPublishedDocument.current
      )
    ) {
      return;
    }

    const api = apiRef.current;
    if (!api) return;
    const drawingScene = sceneSnapshotForV4Persist(
      api.getSceneElements?.() ?? [],
      api.getAppState?.() ?? {},
      api.getFiles?.() ?? {},
      layerVisibleRef.current
    );
    const refreshed = hydrateCanvasV5Scene({
      document: canvasDocument,
      drawingScene,
      resolvers,
      graph,
      edgeLayers,
    });

    applyingExternal.current = true;
    try {
      api.updateScene({
        elements: refreshed.elements,
        appState: {
          activeEmbeddable: null,
          selectedElementIds: canvasDocument.focusedPlacementId
            ? {
                [tentPlacementElementId(canvasDocument.focusedPlacementId)]: true,
              }
            : {},
        },
        captureUpdate: "NEVER",
      });
      setLoadBanner(
        refreshed.status.kind === "ok" ? null : refreshed.status.message
      );
    } finally {
      void Promise.resolve().then(() => {
        applyingExternal.current = false;
      });
    }
  }, [canvasDocument, edgeLayers, graph, resolvers]);

  useEffect(() => {
    const focusedPlacementId = canvasDocument.focusedPlacementId ?? null;
    if (ownershipRef.current.focusedPlacementId === focusedPlacementId) return;

    const nextOwnership = createV5OwnershipState(focusedPlacementId);
    ownershipRef.current = nextOwnership;
    setOwnership(nextOwnership);

    const api = apiRef.current;
    if (!api) return;
    applyingExternal.current = true;
    try {
      api.updateScene({
        appState: {
          activeEmbeddable: null,
          selectedElementIds: focusedPlacementId
            ? { [tentPlacementElementId(focusedPlacementId)]: true }
            : {},
        },
        captureUpdate: "NEVER",
      });
    } finally {
      void Promise.resolve().then(() => {
        applyingExternal.current = false;
      });
    }
  }, [canvasDocument.focusedPlacementId]);

  useEffect(() => {
    return () => {
      cancelApiViewportSyncRef.current?.();
      cancelApiViewportSyncRef.current = null;
      apiRef.current = null;
      flushCanvasV5PersistGates({
        placement: placementPersistGate.current,
        drawing: persistGate.current,
      });
      persistGate.current.cancel();
      placementPersistGate.current.cancel();
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let previousSize: { width: number; height: number } | null = null;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const nextSize = { width: rect.width, height: rect.height };
      const sizeBeforeResize = previousSize ?? nextSize;
      if (
        previousSize &&
        Math.abs(sizeBeforeResize.width - nextSize.width) < 0.5 &&
        Math.abs(sizeBeforeResize.height - nextSize.height) < 0.5
      ) return;
      // Resolve the latest captured pan/zoom before deriving the resize. A
      // delayed placement write must never restore the pre-resize camera.
      placementPersistGate.current.flush();
      const document = documentRef.current;
      const focusedPlacement = document.focusedPlacementId
        ? document.placements.find(
            (placement) => placement.placementId === document.focusedPlacementId
          ) ?? null
        : null;
      const viewport = viewportAfterCanvasResize({
        viewport: document.viewport ?? DEFAULT_VIEWPORT,
        previousSize: sizeBeforeResize,
        nextSize,
        focusedPlacement,
        focusVisibility: previousSize ? "if-visible-before-resize" : "always",
      });
      previousSize = nextSize;
      const currentViewport = document.viewport ?? DEFAULT_VIEWPORT;
      if (
        Math.abs(currentViewport.x - viewport.x) < 0.01 &&
        Math.abs(currentViewport.y - viewport.y) < 0.01 &&
        Math.abs(currentViewport.zoom - viewport.zoom) < 0.0001
      ) return;
      const nextDocument = withViewport(document, viewport);
      const viewportAppState = excalidrawAppStateFromViewport(viewport);
      applyingExternal.current = true;
      try {
        if (apiRef.current) {
          apiRef.current.updateScene({
            appState: viewportAppState,
            captureUpdate: "NEVER",
          });
        } else {
          initialDataRef.current = {
            ...initialDataRef.current,
            appState: {
              ...initialDataRef.current.appState,
              ...viewportAppState,
            },
          };
        }
        publishDocument(nextDocument);
      } finally {
        void Promise.resolve().then(() => {
          applyingExternal.current = false;
        });
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [publishDocument]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (displayMenuOpen) {
        event.preventDefault();
        setDisplayMenuOpen(false);
        return;
      }
      const prev = ownershipRef.current;
      const next = reduceV5Ownership(prev, { type: "escape" });
      const ownershipChanged =
        next.activeElementId !== prev.activeElementId ||
        next.focusedPlacementId !== prev.focusedPlacementId ||
        next.owner !== prev.owner;

      if (ownershipChanged) {
        event.preventDefault();
        setOwnership(next);
        ownershipRef.current = next;
        if (next.focusedPlacementId == null && prev.focusedPlacementId != null) {
          const doc = setFocusedPlacement(documentRef.current, null);
          publishDocument(doc);
          onSelectPlacementRef.current(null, null);
        }
        const api = apiRef.current;
        if (api && prev.activeElementId && !next.activeElementId) {
          applyingExternal.current = true;
          try {
            api.updateScene({
              appState: { activeEmbeddable: null },
              captureUpdate: "NEVER",
            });
          } finally {
            void Promise.resolve().then(() => {
              applyingExternal.current = false;
            });
          }
        }
        return;
      }

      if (immersive && onImmersiveChange) {
        event.preventDefault();
        onImmersiveChange(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [displayMenuOpen, immersive, onImmersiveChange, publishDocument]);

  const persistDrawing = useCallback(
    (
      elements: readonly unknown[],
      appState: Record<string, unknown>,
      files: Record<string, unknown>
    ) => {
      if (!onScenePersistRef.current) return;
      const snapshot = sceneSnapshotForV4Persist(
        elements,
        appState,
        files,
        layerVisibleRef.current
      );
      const sig = `${sceneContentSignature(snapshot.elements, snapshot.files)}:${
        layerVisibleRef.current ? "shown" : "hidden"
      }`;
      if (sig === lastPersistedDrawingSig.current) return;
      lastPersistedDrawingSig.current = sig;
      onScenePersistRef.current(snapshot, layerVisibleRef.current);
    },
    []
  );

  const handleApi = useCallback((api: ExcalidrawApi) => {
    apiRef.current = api;
    cancelApiViewportSyncRef.current?.();
    cancelApiViewportSyncRef.current = schedulePostMountCanvasViewportSync({
      scheduler: {
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (frameId) => cancelAnimationFrame(frameId),
      },
      isCurrent: () => apiRef.current === api,
      readViewport: () => documentRef.current.viewport ?? DEFAULT_VIEWPORT,
      applyViewport: (viewport) => {
        applyingExternal.current = true;
        try {
          api.updateScene({
            appState: excalidrawAppStateFromViewport(viewport),
            captureUpdate: "NEVER",
          });
        } finally {
          void Promise.resolve().then(() => {
            applyingExternal.current = false;
          });
        }
      },
    });
  }, []);

  const handleChange = useCallback<
    NonNullable<ExcalidrawComponentProps["onChange"]>
  >((elements, appState, files) => {
    if (applyingExternal.current) return;

    const filesObj = (files ?? {}) as Record<string, unknown>;
    const appObj = appState as Record<string, unknown>;

    // Selection → Focus (right pane). Mid-gesture continuous.
    const focus = selectionToFocusedPlacement(
      elements,
      appState.selectedElementIds
    );
    const prevOwn = ownershipRef.current;
    if (focus.placementId !== prevOwn.focusedPlacementId) {
      const nextOwn = reduceV5Ownership(prevOwn, {
        type: "select-placement",
        placementId: focus.placementId,
      });
      setOwnership(nextOwn);
      ownershipRef.current = nextOwn;
      const doc = setFocusedPlacement(
        documentRef.current,
        focus.placementId
      );
      if (doc.focusedPlacementId !== documentRef.current.focusedPlacementId) {
        publishDocument(doc);
      }
      onSelectPlacementRef.current(focus.placementId, focus.entityRef);
    }

    // Embeddable activation ownership
    const activeId =
      appState.activeEmbeddable?.state === "active" &&
      typeof appState.activeEmbeddable.element?.id === "string"
        ? appState.activeEmbeddable.element.id
        : null;
    if (activeId && activeId !== ownershipRef.current.activeElementId) {
      const nextOwn = reduceV5Ownership(ownershipRef.current, {
        type: "activate-embeddable",
        elementId: activeId,
      });
      setOwnership(nextOwn);
      ownershipRef.current = nextOwn;
    } else if (
      !activeId &&
      ownershipRef.current.owner === "embeddable-active"
    ) {
      const nextOwn = reduceV5Ownership(ownershipRef.current, {
        type: "pointer-blank",
      });
      // Only clear active, keep focus if selection remains
      if (!focus.placementId) {
        setOwnership(nextOwn);
        ownershipRef.current = nextOwn;
      } else if (ownershipRef.current.activeElementId) {
        const cleared = {
          ...ownershipRef.current,
          owner: "canvas" as const,
          activeElementId: null,
        };
        setOwnership(cleared);
        ownershipRef.current = cleared;
      }
    }

    // Geometry write-back (continuous visual via Excalidraw; doc merge debounced)
    const patches = extractPlacementPatchesFromElements(elements);
    placementPersistGate.current.schedule(() => {
      const nextDoc = applyPlacementPatches(documentRef.current, patches);
      if (nextDoc !== documentRef.current) {
        // Also fold viewport from Excalidraw (sole camera).
        const vp = viewportFromExcalidrawAppState(
          {
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
            zoom: appState.zoom,
          },
          documentRef.current.viewport ?? DEFAULT_VIEWPORT
        );
        const withVp = withViewport(nextDoc, vp);
        publishDocument(withVp);
      } else {
        const vp = viewportFromExcalidrawAppState(
          {
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
            zoom: appState.zoom,
          },
          documentRef.current.viewport ?? DEFAULT_VIEWPORT
        );
        const prev = documentRef.current.viewport ?? DEFAULT_VIEWPORT;
        if (
          Math.abs(prev.x - vp.x) > 0.01 ||
          Math.abs(prev.y - vp.y) > 0.01 ||
          Math.abs(prev.zoom - vp.zoom) > 0.0001
        ) {
          const withVp = withViewport(documentRef.current, vp);
          publishDocument(withVp);
        }
      }
    });

    // Remove-from-canvas when tent embeddable deleted
    const deleted = deletedTentPlacementIds(elements);
    if (deleted.length > 0) {
      let doc = documentRef.current;
      for (const placementId of deleted) {
        doc = removePlacement(doc, placementId);
      }
      if (doc !== documentRef.current) {
        publishDocument(doc);
        if (
          ownershipRef.current.focusedPlacementId &&
          deleted.includes(ownershipRef.current.focusedPlacementId)
        ) {
          onSelectPlacementRef.current(null, null);
        }
      }
    }

    // Drawing persistence (strip tent nodes) — debounced
    persistGate.current.schedule(() => {
      persistDrawing(elements, appObj, filesObj);
    });
  }, [persistDrawing, publishDocument]);

  const handleLinkOpen = useCallback<
    NonNullable<ExcalidrawComponentProps["onLinkOpen"]>
  >((element, event) => {
    const target = captureTentNodeOpenTarget(element, event);
    if (!target) return;

    const nextOwnership = reduceV5Ownership(ownershipRef.current, {
      type: "select-placement",
      placementId: target.placementId,
    });
    ownershipRef.current = nextOwnership;
    setOwnership(nextOwnership);

    const nextDocument = setFocusedPlacement(
      documentRef.current,
      target.placementId
    );
    if (
      nextDocument.focusedPlacementId !==
      documentRef.current.focusedPlacementId
    ) {
      publishDocument(nextDocument);
    }
    onSelectPlacementRef.current(target.placementId, target.nodeId);

    apiRef.current?.updateScene({
      appState: {
        activeEmbeddable: null,
        selectedElementIds: { [element.id]: true },
      },
      captureUpdate: "NEVER",
    });
  }, [publishDocument]);

  const handleLayerVisibleChange = useCallback(
    (visible: boolean) => {
      layerVisibleRef.current = visible;
      onLayerVisibleChange(visible);
      const api = apiRef.current;
      if (!api) return;
      persistDrawing(
        api.getSceneElements?.() ?? [],
        api.getAppState?.() ?? {},
        api.getFiles?.() ?? {}
      );
    },
    [onLayerVisibleChange, persistDrawing]
  );

  const banner =
    loadBanner ?? statusMessage(persistenceStatus);
  const canRetry =
    !loadBanner &&
    persistenceStatus.kind !== "ok" &&
    persistenceStatus.retryable === true;

  const cardModels = useMemo(
    () => buildTentEmbeddableCardModels(canvasDocument, resolvers),
    [canvasDocument, resolvers]
  );

  return (
    <div
      ref={hostRef}
      className={`tn-canvas-v5-host${props.className ? ` ${props.className}` : ""}`}
      data-testid="canvas-v5-host"
      data-canvas-v5="excalidraw-single-scene"
      data-viewport-control-owner="excalidraw"
      data-single-transform-owner="excalidraw"
      data-drawing-visible={layerVisible ? "true" : "false"}
      data-tent-node-focused={
        canvasDocument.focusedPlacementId ? "true" : "false"
      }
      data-gesture-owner={ownership.owner}
      data-scope-generation={String(scopeGeneration)}
      data-immersive={immersive ? "true" : "false"}
      style={props.style}
    >
      {banner ? (
        <div
          className="tn-canvas-v5-host__banner"
          data-kind={loadBanner ? "error" : "warn"}
          role="status"
        >
          <span>{banner}</span>
          {canRetry && onRetryPersistence ? (
            <Button
              variant="quiet"
              size="compact"
              onClick={onRetryPersistence}
            >
              重试
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="tn-canvas-v5-host__chrome" data-testid="canvas-v5-chrome">
        <div className="tn-canvas-v5-host__settings">
          <Button
            variant="quiet"
            size="compact"
            data-testid="canvas-display-menu"
            aria-label={canvasCopy("canvas.display.aria")}
            aria-haspopup="dialog"
            aria-expanded={displayMenuOpen}
            aria-controls="canvas-v5-display-panel"
            onClick={() => setDisplayMenuOpen((open) => !open)}
          >
            {canvasCopy("canvas.display")}
          </Button>
          {displayMenuOpen ? (
          <div
            id="canvas-v5-display-panel"
            className="tn-canvas-v5-host__settings-popover"
            role="dialog"
            aria-label="画布显示"
          >
            {onImmersiveChange ? (
              <Button
                variant="quiet"
                size="compact"
                data-testid="canvas-immersive-toggle"
                onClick={() => onImmersiveChange(!immersive)}
              >
                {immersive
                  ? canvasCopy("canvas.immersive.exit")
                  : canvasCopy("canvas.immersive.enter")}
              </Button>
            ) : null}
            <Button
              variant="quiet"
              size="compact"
              data-testid="canvas-drawing-toggle"
              aria-pressed={layerVisible}
              onClick={() => handleLayerVisibleChange(!layerVisible)}
            >
              {layerVisible
                ? canvasCopy("canvas.drawing.hide")
                : canvasCopy("canvas.drawing.show")}
            </Button>
            {onToggleEdgeLayer ? (
              <fieldset data-testid="canvas-edge-layers">
                <legend title={canvasCopy("canvas.relations.help")}>
                  {canvasCopy("canvas.relations")}
                </legend>
                {(
                  [
                    ["parent", "canvas.layer.parent"],
                    ["markdown", "canvas.layer.markdown"],
                    ["wiki", "canvas.layer.wiki"],
                    ["relation", "canvas.layer.relation"],
                  ] as const
                ).map(([layer, label]) => (
                  <label key={layer}>
                    <input
                      type="checkbox"
                      checked={edgeLayers[layer]}
                      data-testid={`edge-layer-${layer}`}
                      onChange={() => onToggleEdgeLayer(layer)}
                    />
                    {canvasCopy(label)}
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
          ) : null}
        </div>
      </div>

      <div
        className="tn-canvas-v5-host__scene"
        data-testid="canvas-v5-scene"
        aria-label={canvasCopy("canvas.aria")}
      >
        <Suspense
          fallback={
            <div className="tn-fusion-loading" role="status" aria-busy="true">
              …
            </div>
          }
        >
          <ExcalidrawLazy
            key={`${scopeGeneration}-${mountKey}`}
            excalidrawAPI={handleApi}
            initialData={initialDataRef.current}
            onChange={handleChange}
            viewModeEnabled={false}
            zenModeEnabled={false}
            gridModeEnabled={false}
            theme="light"
            langCode="zh-CN"
            detectScroll={false}
            handleKeyboardGlobally={false}
             validateEmbeddable={(link) => validateTentEmbeddableLink(link)}
             onLinkOpen={handleLinkOpen}
             renderEmbeddable={(element, appState) => {
              const custom = readTentNodeCustomData(element);
              if (!custom) return null;
              const model = cardModels.get(custom.placementId);
              if (!model) {
                // Missing view data is unknown, not evidence of stale/error/unresolved.
                return (
                  <TentEmbeddableNode
                    data={{
                      nodeId: custom.nodeId,
                      title: "本地画布位置",
                      type: "节点",
                      state: "unknown",
                      stateLabel: "状态未知",
                      detail: "权威投影尚不可用；本地位置已保留。",
                    }}
                    selected={Boolean(
                      (appState.selectedElementIds as Record<string, boolean> | undefined)?.[
                        element.id
                      ]
                    )}
                  />
                );
              }
              const selected = Boolean(
                (appState.selectedElementIds as Record<string, boolean> | undefined)?.[
                  element.id
                ]
              );
              const interactive = embeddableInteractive(
                ownershipRef.current,
                element.id
              );
              return (
                <TentEmbeddableNode
                  data={toNodeData(model)}
                  selected={selected}
                  interactive={interactive}
                  expanded={model.presentation === "expanded"}
                  onToggleExpanded={() => {
                    const nextDocument = togglePlacementPresentation(
                      documentRef.current,
                      custom.placementId
                    );
                    if (nextDocument !== documentRef.current) {
                      publishDocument(nextDocument);
                    }
                  }}
                />
              );
            }}
            UIOptions={{
              canvasActions: {
                changeViewBackgroundColor: false,
                clearCanvas: false,
                export: false,
                loadScene: false,
                saveToActiveFile: false,
                toggleTheme: false,
                saveAsImage: false,
              },
              tools: { image: true },
            }}
          />
        </Suspense>
      </div>

    </div>
  );
}
