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
  newPlacementId,
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
  duplicateTentPlacements,
  extractPlacementPatchesFromElements,
  limitedCanvasNodePreview,
  readTentNodeCustomData,
  reconcileTentPlacementHistory,
  releaseTentTransformSelection,
  selectionToFocusedPlacement,
  validateTentEmbeddableLink,
  viewportFromExcalidrawAppState,
  excalidrawAppStateFromViewport,
  type CanvasNodeResolvers,
  type ExcalidrawElementLike,
} from "./documentToExcalidraw.js";
import {
  createTentPlacementDrag,
  focusExcalidrawKeyboardOwner,
  moveTentPlacementForPointer,
  restoreTentPlacementAfterCancel,
  type TentPlacementDrag,
} from "./tent-placement-drag.js";
import { NODE_CARD } from "../../model/canvas-document.js";
import {
  schedulePostMountCanvasViewportSync,
  viewportAfterCanvasResize,
} from "../../model/canvas-viewport-resize.js";
import { CANVAS_V5_COLORS } from "./canvasV5Theme.js";
import { Button, IconButton } from "../../ui/index.js";
import { ShellIcon } from "../../shell/icons.js";
import type { ExcalidrawSceneSnapshot } from "./excalidrawSceneTypes.js";
import { sceneContentSignature } from "./sceneContentSignature.js";
import {
  hydrateCanvasV5Scene,
  sceneSnapshotForV4Persist,
} from "./v5Migration.js";
import {
  createV5OwnershipState,
  reduceV5Ownership,
  type V5OwnershipState,
} from "./v5InteractionOwnership.js";
import {
  TentEmbeddableNode,
  type TentEmbeddableNodeData,
  type TentEmbeddableNodeState,
} from "./TentEmbeddableNode.js";
import {
  resolveCanvasV5SceneRefresh,
  type LiveSceneInputs,
} from "./sceneRefreshPolicy.js";
import {
  captureCanvasV5SyncBaseline,
  createCanvasV5PersistGate,
  flushCanvasV5PersistGates,
} from "./canvasV5PersistGate.js";
import "./tent-embeddable-prototype.css";
import "./canvas-v5-host.css";
import type {
  CanvasSubtreeProjection,
  SubtreeDirection,
} from "../../model/canvas-subtree-projection.js";
import {
  carryCollapsedSubtreeDescendants,
  readCanvasProjectionPlacementMeta,
  setCanvasProjectionPlacementHidden,
} from "../../model/canvas-subtree-projection.js";
import {
  CanvasSubtreeOverlay,
  type CanvasSubtreeOverlayHandle,
} from "./CanvasSubtreeOverlay.js";
import {
  activeCanvasPresentationRevision,
  advanceCanvasPresentationHistory,
  preserveCanvasPresentationHistoryMarker,
} from "./canvas-presentation-history.js";

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
  previewDocument?: {
    nodeId: string;
    status?: "loading" | "ready" | "error";
    body?: string;
  } | null;
  onPreviewNode?: (nodeId: string | null) => void;
  attentionPlacementIds?: ReadonlySet<string>;
  subtreeProjection?: CanvasSubtreeProjection;
  onSubtreeDirection?: (placementId: string, direction: SubtreeDirection) => void;
  onProjectionSync?: (
    authorityDigest: string
  ) => CanvasDocument | null | Promise<CanvasDocument | null>;
};

type ExcalidrawApi = {
  updateScene: (scene: {
    appState?: Record<string, unknown>;
    elements?: readonly unknown[];
    captureUpdate?: string;
  }) => void;
  getSceneElements?: () => readonly unknown[];
  getSceneElementsIncludingDeleted?: () => readonly unknown[];
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
  onDuplicate?: (
    nextElements: readonly unknown[],
    previousElements: readonly unknown[]
  ) => unknown[] | void;
  onPointerDown?: (
    activeTool: unknown,
    pointerDownState: {
      hit?: { element?: { id?: string; customData?: unknown } | null };
      withCmdOrCtrl?: boolean;
    }
  ) => void;
  onPointerUp?: () => void;
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
  "canvas.sync": "同步画布",
  "canvas.sync.current": "画布已同步",
  "canvas.sync.unavailable": "权威来源不可用，暂不能同步",
  "canvas.aria": "Tent 画布",
} as const;

const EMPTY_SUBTREE_PROJECTION: CanvasSubtreeProjection = {
  authority: "unknown",
  visiblePlacementIds: [],
  relationships: [],
  controls: [],
  placementStates: [],
  documentSync: null,
};

function sceneDocumentForSubtreeProjection(
  document: CanvasDocument,
  projection: CanvasSubtreeProjection
): CanvasDocument {
  const visible = new Set(projection.visiblePlacementIds);
  return {
    ...document,
    placements: document.placements.filter((placement) => visible.has(placement.placementId)),
    focusedPlacementId: document.focusedPlacementId && visible.has(document.focusedPlacementId)
      ? document.focusedPlacementId
      : null,
  };
}
function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(
    target.closest("input, textarea, select, [contenteditable='true'], .cm-editor")
  );
}

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
  sourceState?: "current" | "changed" | "deleted" | "unknown";
  rawTaskState?: string | null;
}): TentEmbeddableNodeData {
  return {
    nodeId: model.nodeId,
    title: model.title,
    type: model.typeLabel,
    state: model.state,
    stateLabel: model.stateLabel,
    sourceState: model.sourceState,
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
    previewDocument = null,
    onPreviewNode,
    attentionPlacementIds = new Set<string>(),
    subtreeProjection = EMPTY_SUBTREE_PROJECTION,
    onSubtreeDirection = () => {},
    onProjectionSync = () => null,
  } = props;

  const sceneDocument = useMemo(
    () => sceneDocumentForSubtreeProjection(canvasDocument, subtreeProjection),
    [canvasDocument, subtreeProjection]
  );

  const documentRef = useRef(canvasDocument);
  documentRef.current = canvasDocument;
  const onDocumentChangeRef = useRef(onDocumentChange);
  onDocumentChangeRef.current = onDocumentChange;
  const onSelectPlacementRef = useRef(onSelectPlacement);
  onSelectPlacementRef.current = onSelectPlacement;
  const onPreviewNodeRef = useRef(onPreviewNode);
  onPreviewNodeRef.current = onPreviewNode;
  const onScenePersistRef = useRef(onScenePersist);
  onScenePersistRef.current = onScenePersist;
  const layerVisibleRef = useRef(layerVisible);
  layerVisibleRef.current = layerVisible;
  const deletedPlacementCacheRef = useRef(new Map<string, CanvasDocument["placements"][number]>());
  const adapterHistoryPlacementIdsRef = useRef(new Set<string>());
  const subtreeProjectionRef = useRef(subtreeProjection);
  subtreeProjectionRef.current = subtreeProjection;
  const subtreeOverlayRef = useRef<CanvasSubtreeOverlayHandle>(null);
  const presentationHistoryDocumentsRef = useRef(new Map<string, CanvasDocument>());
  const presentationHistoryBaselineRef = useRef<CanvasDocument | null>(null);
  const presentationHistoryRevisionRef = useRef<string | null>(null);
  const presentationHistoryStartedRef = useRef(false);

  const applyingExternal = useRef(false);
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const releaseTransformFrameRef = useRef<number | null>(null);
  const pointerGestureActiveRef = useRef(false);
  const tentPlacementDragRef = useRef<TentPlacementDrag | null>(null);
  const tentPlacementDragPreviewRef = useRef<HTMLElement | null>(null);
  const tentPlacementPreviewFrameRef = useRef<number | null>(null);
  const pendingHistoryFocusPlacementIdRef = useRef<string | null>(null);
  const cancelApiViewportSyncRef = useRef<(() => void) | null>(null);
  const lastInternallyPublishedDocument = useRef<CanvasDocument | null>(null);
  const liveSceneInputs = useRef<LiveSceneInputs>({
    document: sceneDocument,
    graph,
    edgeLayers,
  });
  const latestSceneInputs = useRef<LiveSceneInputs>({
    document: sceneDocument,
    graph,
    edgeLayers,
  });
  latestSceneInputs.current = { document: sceneDocument, graph, edgeLayers };
  const resolversRef = useRef(resolvers);
  resolversRef.current = resolvers;
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
        document: sceneDocument,
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
  const [apiReady, setApiReady] = useState(false);
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const [previewPlacementId, setPreviewPlacementId] = useState<string | null>(null);
  const [hoveredPlacementId, setHoveredPlacementId] = useState<string | null>(null);
  const previewPlacementIdRef = useRef<string | null>(null);
  const previewCandidateRef = useRef<string | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const latestSceneRef = useRef<{
    elements: readonly unknown[];
    appState: Record<string, unknown>;
  }>({ elements: [], appState: {} });
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

  const positionPreview = useCallback((placementId: string) => {
    const preview = previewRef.current;
    const host = hostRef.current;
    if (!preview || !host) return;
    const element = latestSceneRef.current.elements.find((raw) => {
      if (!raw || typeof raw !== "object") return false;
      return readTentNodeCustomData(raw as { customData?: unknown })?.placementId === placementId;
    }) as { x?: number; y?: number; width?: number } | undefined;
    if (!element || typeof element.x !== "number" || typeof element.y !== "number") return;
    const appState = latestSceneRef.current.appState as {
      scrollX?: number;
      scrollY?: number;
      zoom?: { value?: number };
    };
    const zoom = appState.zoom?.value ?? 1;
    const rect = host.getBoundingClientRect();
    const hasSubtreeControl = subtreeProjectionRef.current.controls.some(
      (control) => control.placementId === placementId
    );
    const preferredLeft = (element.x + (element.width ?? NODE_CARD.width) + (appState.scrollX ?? 0)) * zoom +
      (hasSubtreeControl ? 38 : 14);
    const preferredTop = (element.y + (appState.scrollY ?? 0)) * zoom;
    preview.style.left = `${Math.max(12, Math.min(rect.width - 250, preferredLeft))}px`;
    preview.style.top = `${Math.max(52, Math.min(rect.height - 142, preferredTop))}px`;
  }, []);

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }, []);

  const selectTentPlacement = useCallback(
    (placementId: string | null, nodeId: string | null) => {
      const nextOwnership = reduceV5Ownership(ownershipRef.current, {
        type: "select-placement",
        placementId,
      });
      ownershipRef.current = nextOwnership;
      setOwnership(nextOwnership);
      const nextDocument = setFocusedPlacement(documentRef.current, placementId);
      if (nextDocument.focusedPlacementId !== documentRef.current.focusedPlacementId) {
        publishDocument(nextDocument);
      }
      onSelectPlacementRef.current(placementId, nodeId);
    },
    [publishDocument]
  );

  useEffect(() => () => {
    clearPreviewTimer();
    onPreviewNodeRef.current?.(null);
  }, [clearPreviewTimer]);

  useEffect(() => {
    presentationHistoryDocumentsRef.current.clear();
    presentationHistoryBaselineRef.current = null;
    presentationHistoryRevisionRef.current = null;
    presentationHistoryStartedRef.current = false;
    const next = hydrateCanvasV5Scene({
      document: sceneDocumentForSubtreeProjection(
        documentRef.current,
        subtreeProjectionRef.current
      ),
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
    apiRef.current = null;
    setApiReady(false);
    setMountKey((k) => k + 1);
    lastPersistedDrawingSig.current = "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeGeneration]);

  const applyLatestControlledScene = useCallback((api: ExcalidrawApi) => {
    const previous = liveSceneInputs.current;
    const next = latestSceneInputs.current;
    const decision = resolveCanvasV5SceneRefresh(
      previous,
      next,
      lastInternallyPublishedDocument.current,
      apiRef.current === api
    );
    if (!decision.refresh) {
      liveSceneInputs.current = decision.consumed;
      return;
    }
    const sceneElements = api.getSceneElementsIncludingDeleted?.() ?? api.getSceneElements?.() ?? [];
    const drawingScene = sceneSnapshotForV4Persist(
      sceneElements,
      api.getAppState?.() ?? {},
      api.getFiles?.() ?? {},
      layerVisibleRef.current
    );
    const refreshed = hydrateCanvasV5Scene({
      document: next.document,
      drawingScene,
      resolvers: resolversRef.current,
      graph: next.graph,
      edgeLayers: next.edgeLayers,
    });

    applyingExternal.current = true;
    try {
      api.updateScene({
        elements: preserveCanvasPresentationHistoryMarker(
          refreshed.elements,
          sceneElements
        ),
        appState: {
          activeEmbeddable: null,
          selectedElementIds: {},
        },
        captureUpdate: "NEVER",
      });
      setLoadBanner(
        refreshed.status.kind === "ok" ? null : refreshed.status.message
      );
      liveSceneInputs.current = decision.consumed;
    } finally {
      void Promise.resolve().then(() => {
        applyingExternal.current = false;
      });
    }
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    applyLatestControlledScene(api);
  }, [applyLatestControlledScene, edgeLayers, graph, resolvers, sceneDocument]);

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
          selectedElementIds: {},
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
      if (releaseTransformFrameRef.current !== null) {
        cancelAnimationFrame(releaseTransformFrameRef.current);
        releaseTransformFrameRef.current = null;
      }
      if (tentPlacementPreviewFrameRef.current !== null) {
        cancelAnimationFrame(tentPlacementPreviewFrameRef.current);
        tentPlacementPreviewFrameRef.current = null;
      }
      if (tentPlacementDragPreviewRef.current) {
        tentPlacementDragPreviewRef.current.style.translate = "";
        tentPlacementDragPreviewRef.current = null;
      }
      pointerGestureActiveRef.current = false;
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

  const commitPresentationDocumentWithHistory = useCallback(
    (nextDocument: CanvasDocument): boolean => {
      const api = apiRef.current;
      if (!api || nextDocument === documentRef.current) return false;
      const elements = api.getSceneElementsIncludingDeleted?.() ?? api.getSceneElements?.() ?? [];
      const currentRevision = activeCanvasPresentationRevision(elements);
      if (!currentRevision) {
        presentationHistoryBaselineRef.current = documentRef.current;
      }
      const revision = newPlacementId("canvas-presentation");
      presentationHistoryDocumentsRef.current.set(revision, nextDocument);
      if (presentationHistoryDocumentsRef.current.size > 64) {
        const oldest = presentationHistoryDocumentsRef.current.keys().next().value;
        if (oldest) presentationHistoryDocumentsRef.current.delete(oldest);
      }
      presentationHistoryStartedRef.current = true;
      presentationHistoryRevisionRef.current = revision;
      placementPersistGate.current.cancel();
      publishDocument(nextDocument);
      const nextElements = advanceCanvasPresentationHistory(elements, revision);
      latestSceneRef.current = {
        elements: nextElements,
        appState: api.getAppState?.() ?? latestSceneRef.current.appState,
      };
      api.updateScene({
        elements: nextElements,
        appState: { activeEmbeddable: null, selectedElementIds: {} },
        captureUpdate: "IMMEDIATELY",
      });
      return true;
    },
    [publishDocument]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const host = hostRef.current;
      const ownsKeyboard = Boolean(
        host &&
        ((event.target instanceof Node && host.contains(event.target)) ||
          (document.activeElement && host.contains(document.activeElement)))
      );
      const focusedPlacementId = documentRef.current.focusedPlacementId;
      const isDelete = event.key === "Delete" || event.key === "Backspace";
      const isDuplicate =
        (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d";
      if (
        ownsKeyboard &&
        focusedPlacementId &&
        !isEditableTarget(event.target) &&
        (isDelete || isDuplicate)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const placement = documentRef.current.placements.find(
          (candidate) => candidate.placementId === focusedPlacementId
        );
        const api = apiRef.current;
        if (!placement || !api || !host) return;
        const scene = api?.getSceneElements?.() ?? [];
        const source = scene.find((raw) => {
          if (!raw || typeof raw !== "object") return false;
          return readTentNodeCustomData(raw as { customData?: unknown })?.placementId === focusedPlacementId;
        }) as ExcalidrawElementLike | undefined;
        if (!source) return;
        if (isDelete) {
          commitPresentationDocumentWithHistory(
            setCanvasProjectionPlacementHidden(
              documentRef.current,
              focusedPlacementId,
              true
            )
          );
          return;
        }

        const provisional = {
          ...source,
          id: `tent-copy:${newPlacementId("scene")}`,
          x: source.x + 24,
          y: source.y + 24,
          isDeleted: false,
          version: 1,
          versionNonce: Math.floor(Math.random() * 2_147_483_647),
          seed: Math.floor(Math.random() * 2_147_483_647),
          updated: Date.now(),
        } satisfies ExcalidrawElementLike;
        const duplicated = duplicateTentPlacements({
          document: documentRef.current,
          previousElements: scene as ExcalidrawElementLike[],
          nextElements: [...scene, provisional] as ExcalidrawElementLike[],
          createPlacementId: () => newPlacementId("pl-node"),
        });
        const placementId = duplicated.addedPlacementIds.at(-1);
        const duplicatedPlacement = placementId
          ? duplicated.document.placements.find(
              (candidate) => candidate.placementId === placementId
            )
          : undefined;
        if (!placementId || !duplicatedPlacement) return;
        adapterHistoryPlacementIdsRef.current.add(placementId);
        deletedPlacementCacheRef.current.set(placementId, duplicatedPlacement);
        pendingHistoryFocusPlacementIdRef.current = placementId;
        api.updateScene({
          elements: duplicated.elements,
          appState: { activeEmbeddable: null, selectedElementIds: {} },
          captureUpdate: "IMMEDIATELY",
        });
        return;
      }
      if (event.key !== "Escape") return;
      if (displayMenuOpen) {
        event.preventDefault();
        setDisplayMenuOpen(false);
        return;
      }
      if (previewPlacementIdRef.current) {
        event.preventDefault();
        clearPreviewTimer();
        previewCandidateRef.current = null;
        previewPlacementIdRef.current = null;
        setPreviewPlacementId(null);
        onPreviewNodeRef.current?.(null);
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
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [clearPreviewTimer, commitPresentationDocumentWithHistory, displayMenuOpen, immersive, onImmersiveChange, publishDocument]);

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
    setApiReady(true);
    applyLatestControlledScene(api);
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
    requestAnimationFrame(() => {
      if (apiRef.current !== api) return;
      subtreeOverlayRef.current?.update(api.getAppState?.() ?? {});
    });
  }, [applyLatestControlledScene]);

  const commitPlacementFromScene = useCallback((
    elements: readonly unknown[],
    appState: {
      scrollX?: number;
      scrollY?: number;
      zoom?: { value: number };
    }
  ) => {
    const moved = carryCollapsedSubtreeDescendants(
      documentRef.current,
      applyPlacementPatches(
      documentRef.current,
      extractPlacementPatchesFromElements(elements)
      )
    );
    const viewport = viewportFromExcalidrawAppState(
      appState,
      moved.viewport ?? DEFAULT_VIEWPORT
    );
    const previousViewport = moved.viewport ?? DEFAULT_VIEWPORT;
    const viewportChanged =
      Math.abs(previousViewport.x - viewport.x) > 0.01 ||
      Math.abs(previousViewport.y - viewport.y) > 0.01 ||
      Math.abs(previousViewport.zoom - viewport.zoom) > 0.0001;
    const committed = viewportChanged ? withViewport(moved, viewport) : moved;
    if (committed !== documentRef.current) {
      publishDocument(committed);
    }
  }, [publishDocument]);

  const releaseNativeTentSelection = useCallback((
    api: ExcalidrawApi,
    elements: readonly unknown[],
    selectedElementIds: Record<string, boolean>,
    deactivateEmbeddable = false
  ) => {
    const released = releaseTentTransformSelection(elements, selectedElementIds);
    if (!released.changed && !deactivateEmbeddable) return;
    applyingExternal.current = true;
    try {
      api.updateScene({
        ...(released.elementsChanged ? { elements: released.elements } : {}),
        appState: {
          selectedElementIds: released.selectedElementIds,
          ...(deactivateEmbeddable ? { activeEmbeddable: null } : {}),
        },
        captureUpdate: "NEVER",
      });
    } finally {
      queueMicrotask(() => {
        applyingExternal.current = false;
      });
    }
  }, []);

  const handleChange = useCallback<
    NonNullable<ExcalidrawComponentProps["onChange"]>
  >((elements, appState, files) => {
    if (applyingExternal.current) return;

    const filesObj = (files ?? {}) as Record<string, unknown>;
    const appObj = appState as Record<string, unknown>;
    latestSceneRef.current = { elements, appState: appObj };
    subtreeOverlayRef.current?.update(appObj);
    if (tentPlacementDragRef.current) return;

    if (presentationHistoryStartedRef.current) {
      const revision = activeCanvasPresentationRevision(elements);
      if (revision !== presentationHistoryRevisionRef.current) {
        const stored = revision
          ? presentationHistoryDocumentsRef.current.get(revision) ?? null
          : presentationHistoryBaselineRef.current;
        if (stored) {
          presentationHistoryRevisionRef.current = revision;
          placementPersistGate.current.cancel();
          publishDocument({
            ...stored,
            viewport: documentRef.current.viewport,
          });
          return;
        }
      }
    }

    // Native Store history is the causal source for duplicate/delete. The
    // CanvasDocument follows the exact scene frame using only locally cached
    // placements, so undo/redo never creates or mutates a domain Node.
    const history = reconcileTentPlacementHistory({
      document: documentRef.current,
      elements,
      cachedPlacements: deletedPlacementCacheRef.current,
      knownHistoryPlacementIds: adapterHistoryPlacementIdsRef.current,
      focusRestoredPlacementId: pendingHistoryFocusPlacementIdRef.current,
    });
    const topologyChanged = history.document !== documentRef.current;
    for (const placement of history.deletedPlacements) {
      deletedPlacementCacheRef.current.set(placement.placementId, placement);
    }
    for (const placement of history.restoredPlacements) {
      deletedPlacementCacheRef.current.delete(placement.placementId);
    }
    if (topologyChanged) {
      placementPersistGate.current.cancel();
      publishDocument(history.document);
    }
    const restoredFocus = pendingHistoryFocusPlacementIdRef.current;
    if (
      restoredFocus &&
      history.restoredPlacements.some(
        (placement) => placement.placementId === restoredFocus
      )
    ) {
      pendingHistoryFocusPlacementIdRef.current = null;
      const placement = history.restoredPlacements.find(
        (candidate) => candidate.placementId === restoredFocus
      );
      if (placement) selectTentPlacement(restoredFocus, placement.entityRef ?? null);
    }

    const activeEmbeddableElementId =
      typeof appState.activeEmbeddable?.element?.id === "string"
        ? appState.activeEmbeddable.element.id
        : null;
    const activeEmbeddableIsActive =
      appState.activeEmbeddable?.state === "active";
    const activeEmbeddableIsTent = Boolean(
      readTentNodeCustomData(
        appState.activeEmbeddable?.element as { customData?: unknown } | undefined
      ) ?? (activeEmbeddableElementId
        ? readTentNodeCustomData(
            elements.find((raw) => Boolean(
              raw &&
              typeof raw === "object" &&
              (raw as { id?: string }).id === activeEmbeddableElementId
            )) as { customData?: unknown } | undefined
          )
        : null)
    );

    // Excalidraw can promote an embeddable to active shortly after pointer-up.
    // A Tent card is a read-only projection, so leaving it active would let its
    // wrapper consume the next pointer stream. During a real gesture, clear
    // only that activation and leave native selection intact for the move.
    // This update deliberately is not wrapped in applyingExternal: the next
    // onChange may contain the authoritative final geometry for this gesture.
    if (
      activeEmbeddableIsTent &&
      activeEmbeddableIsActive &&
      pointerGestureActiveRef.current
    ) {
      apiRef.current?.updateScene({
        appState: { activeEmbeddable: null },
        captureUpdate: "NEVER",
      });
    }

    const transientTentSelection = selectionToFocusedPlacement(
      elements,
      appState.selectedElementIds
    );
    if (!pointerGestureActiveRef.current && transientTentSelection.placementId) {
      placementPersistGate.current.cancel();
      commitPlacementFromScene(elements, appState);
      const api = apiRef.current;
      if (api) {
        releaseNativeTentSelection(
          api,
          elements,
          appState.selectedElementIds ?? {},
          activeEmbeddableIsTent && activeEmbeddableIsActive
        );
      }
      return;
    }

    if (
      activeEmbeddableIsTent &&
      activeEmbeddableIsActive &&
      !pointerGestureActiveRef.current
    ) {
      apiRef.current?.updateScene({
        appState: { activeEmbeddable: null },
        captureUpdate: "NEVER",
      });
    }

    const hoveredCustom = appState.activeEmbeddable?.element?.id
      ? readTentNodeCustomData(
          elements.find((raw) =>
            Boolean(raw && typeof raw === "object" && (raw as { id?: string }).id === appState.activeEmbeddable?.element?.id)
          ) as { customData?: unknown } | undefined
        )
      : null;
    const previewCandidate = hoveredCustom?.placementId ?? null;
    if (previewCandidate !== previewCandidateRef.current) {
      if (previewPlacementIdRef.current) onPreviewNodeRef.current?.(null);
      previewCandidateRef.current = previewCandidate;
      setHoveredPlacementId(previewCandidate);
      clearPreviewTimer();
      previewPlacementIdRef.current = null;
      setPreviewPlacementId(null);
      if (previewCandidate) {
        previewTimerRef.current = window.setTimeout(() => {
          previewTimerRef.current = null;
          if (previewCandidateRef.current !== previewCandidate) return;
          previewPlacementIdRef.current = previewCandidate;
          setPreviewPlacementId(previewCandidate);
          const nodeId = documentRef.current.placements.find(
            (placement) => placement.placementId === previewCandidate
          )?.entityRef ?? null;
          onPreviewNodeRef.current?.(nodeId);
          requestAnimationFrame(() => positionPreview(previewCandidate));
        }, 460);
      }
    } else if (previewCandidate && previewPlacementIdRef.current === previewCandidate) {
      positionPreview(previewCandidate);
    }

    // Native selection is only used while a pointer gesture is active. It can
    // select a Tent element long enough for Excalidraw to perform a move, while
    // persistent product focus stays in CanvasDocument/V5OwnershipState.
    const focus = selectionToFocusedPlacement(
      elements,
      appState.selectedElementIds
    );
    const prevOwn = ownershipRef.current;
    if (focus.placementId && focus.placementId !== prevOwn.focusedPlacementId) {
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
    if (!topologyChanged) {
      placementPersistGate.current.schedule(() => {
        commitPlacementFromScene(elements, appState);
      });
    }

    if (
      history.deletedPlacements.some(
        (placement) => placement.placementId === ownershipRef.current.focusedPlacementId
      )
    ) {
      onSelectPlacementRef.current(null, null);
    }

    // Drawing persistence (strip tent nodes) — debounced
    persistGate.current.schedule(() => {
      persistDrawing(elements, appObj, filesObj);
    });
  }, [clearPreviewTimer, commitPlacementFromScene, persistDrawing, positionPreview, publishDocument, releaseNativeTentSelection, selectTentPlacement]);

  const handlePointerDown = useCallback<
    NonNullable<ExcalidrawComponentProps["onPointerDown"]>
  >((_activeTool, pointerDownState) => {
    const hit = pointerDownState.hit?.element;
    const custom = readTentNodeCustomData(hit ?? undefined);
    if (custom) {
      pointerGestureActiveRef.current = true;
      selectTentPlacement(custom.placementId, custom.nodeId);
      return;
    }
    if (!pointerDownState.withCmdOrCtrl) {
      selectTentPlacement(null, null);
    }
  }, [selectTentPlacement]);

  const handlePointerUp = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    placementPersistGate.current.cancel();
    if (releaseTransformFrameRef.current !== null) {
      cancelAnimationFrame(releaseTransformFrameRef.current);
    }
    releaseTransformFrameRef.current = requestAnimationFrame(() => {
      releaseTransformFrameRef.current = null;
      if (apiRef.current !== api) return;
      const elements = api.getSceneElements?.() ?? [];
      const appState = api.getAppState?.() ?? {};
      placementPersistGate.current.cancel();
      commitPlacementFromScene(
        elements,
        appState as {
          scrollX?: number;
          scrollY?: number;
          zoom?: { value: number };
        }
      );
      pointerGestureActiveRef.current = false;
      const nextOwnership = createV5OwnershipState(
        documentRef.current.focusedPlacementId ?? null
      );
      ownershipRef.current = nextOwnership;
      setOwnership(nextOwnership);
      releaseNativeTentSelection(
        api,
        elements,
        (appState.selectedElementIds ?? {}) as Record<string, boolean>,
        true
      );
    });
  }, [commitPlacementFromScene, releaseNativeTentSelection]);

  useEffect(() => {
    const stopAdapterEvent = (event: PointerEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const finishAdapterDrag = (event: PointerEvent, cancelled: boolean) => {
      const drag = tentPlacementDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      stopAdapterEvent(event);

      const api = apiRef.current;
      const target = event.target;
      if (target instanceof Element && target.hasPointerCapture?.(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
      if (!api) {
        if (tentPlacementDragPreviewRef.current) {
          tentPlacementDragPreviewRef.current.style.translate = "";
          tentPlacementDragPreviewRef.current = null;
        }
        tentPlacementDragRef.current = null;
        return;
      }

      placementPersistGate.current.cancel();
      const scene = api.getSceneElements?.() ?? [];
      const appState = api.getAppState?.() ?? {};
      const final = moveTentPlacementForPointer(
        scene,
        drag,
        event.clientX,
        event.clientY
      );
      const nextElements = cancelled
        ? restoreTentPlacementAfterCancel(scene, drag)
        : final.elements;

      applyingExternal.current = true;
      try {
        api.updateScene({
          elements: nextElements,
          appState: {
            activeEmbeddable: null,
            selectedElementIds: {},
          },
          // Pointer-move preview frames do not participate in Store capture.
          // This is the only history boundary for the final placement.
          captureUpdate: !cancelled && final.moved ? "IMMEDIATELY" : "NEVER",
        });
        latestSceneRef.current = {
          elements: nextElements,
          appState: {
            ...appState,
            activeEmbeddable: null,
            selectedElementIds: {},
          },
        };
        if (!cancelled && final.moved) {
          commitPlacementFromScene(
            nextElements,
            appState as {
              scrollX?: number;
              scrollY?: number;
              zoom?: { value: number };
            }
          );
        }
        subtreeOverlayRef.current?.update(appState);
      } finally {
        const preview = tentPlacementDragPreviewRef.current;
        if (tentPlacementPreviewFrameRef.current !== null) {
          cancelAnimationFrame(tentPlacementPreviewFrameRef.current);
        }
        if (cancelled) {
          if (preview) preview.style.translate = "";
          tentPlacementDragPreviewRef.current = null;
        } else {
          tentPlacementPreviewFrameRef.current = requestAnimationFrame(() => {
            tentPlacementPreviewFrameRef.current = null;
            if (preview) preview.style.translate = "";
            if (tentPlacementDragPreviewRef.current === preview) {
              tentPlacementDragPreviewRef.current = null;
            }
          });
        }
        tentPlacementDragRef.current = null;
        pointerGestureActiveRef.current = false;
        queueMicrotask(() => {
          applyingExternal.current = false;
        });
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      const host = hostRef.current;
      const api = apiRef.current;
      const target = event.target;
      if (
        !host ||
        !api ||
        event.button !== 0 ||
        !(target instanceof HTMLCanvasElement) ||
        !host.contains(target)
      ) {
        return;
      }

      const card = Array.from(
        host.querySelectorAll<HTMLElement>("[data-tent-placement-id]")
      ).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
        );
      });
      const placementId = card?.dataset.tentPlacementId;
      if (!placementId) return;

      const scene = api.getSceneElements?.() ?? [];
      const element = scene.find((raw) => {
        if (!raw || typeof raw !== "object") return false;
        return readTentNodeCustomData(raw as { customData?: unknown })?.placementId === placementId;
      }) as ExcalidrawElementLike | undefined;
      const custom = readTentNodeCustomData(element);
      if (!element || !custom || element.isDeleted === true) return;

      stopAdapterEvent(event);
      placementPersistGate.current.cancel();
      clearPreviewTimer();
      previewCandidateRef.current = null;
      previewPlacementIdRef.current = null;
      setPreviewPlacementId(null);
      onPreviewNodeRef.current?.(null);
      const appState = api.getAppState?.() ?? {};
      const zoom = (
        appState.zoom as { value?: number } | undefined
      )?.value ?? 1;
      tentPlacementDragRef.current = createTentPlacementDrag({
        pointerId: event.pointerId,
        placementId,
        nodeId: custom.nodeId,
        elementId: element.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originX: element.x,
        originY: element.y,
        zoom,
      });
      tentPlacementDragPreviewRef.current =
        card.parentElement?.parentElement instanceof HTMLElement
          ? card.parentElement.parentElement
          : card;
      selectTentPlacement(placementId, custom.nodeId);
      focusExcalidrawKeyboardOwner(host);
      api.updateScene({
        appState: {
          activeEmbeddable: null,
          selectedElementIds: {},
        },
        captureUpdate: "NEVER",
      });
      target.setPointerCapture?.(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = tentPlacementDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      stopAdapterEvent(event);
      const api = apiRef.current;
      if (!api) return;
      const moved = moveTentPlacementForPointer(
        api.getSceneElements?.() ?? [],
        drag,
        event.clientX,
        event.clientY
      );
      if (!moved.moved) return;
      const movedElement = moved.elements.find((raw) =>
        Boolean(
          raw &&
          typeof raw === "object" &&
          readTentNodeCustomData(raw as { customData?: unknown })?.placementId === drag.placementId
        )
      ) as { x?: number; y?: number } | undefined;
      if (typeof movedElement?.x === "number" && typeof movedElement.y === "number") {
        subtreeOverlayRef.current?.update(
          api.getAppState?.() ?? latestSceneRef.current.appState,
          { placementId: drag.placementId, x: movedElement.x, y: movedElement.y }
        );
      }
      const preview = tentPlacementDragPreviewRef.current;
      if (preview) {
        preview.style.translate = `${event.clientX - drag.startClientX}px ${
          event.clientY - drag.startClientY
        }px`;
      }
    };

    const onPointerUp = (event: PointerEvent) => finishAdapterDrag(event, false);
    const onPointerCancel = (event: PointerEvent) => finishAdapterDrag(event, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      const drag = tentPlacementDragRef.current;
      const api = apiRef.current;
      if (drag && api) {
        api.updateScene({
          elements: restoreTentPlacementAfterCancel(
            api.getSceneElements?.() ?? [],
            drag
          ),
          appState: { activeEmbeddable: null, selectedElementIds: {} },
          captureUpdate: "NEVER",
        });
      }
      if (tentPlacementDragPreviewRef.current) {
        tentPlacementDragPreviewRef.current.style.translate = "";
        tentPlacementDragPreviewRef.current = null;
      }
      tentPlacementDragRef.current = null;
    };
  }, [clearPreviewTimer, commitPlacementFromScene, selectTentPlacement]);

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
        selectedElementIds: {},
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
  const projectionStateByPlacement = useMemo(
    () => new Map(
      subtreeProjection.placementStates.map((item) => [item.placementId, item.state] as const)
    ),
    [subtreeProjection.placementStates]
  );
  const hiddenNodePlacements = useMemo(
    () => canvasDocument.placements.filter(
      (placement) =>
        placement.kind === "node" &&
        readCanvasProjectionPlacementMeta(placement).hidden
    ),
    [canvasDocument.placements]
  );

  const syncPendingRef = useRef(false);
  const handleProjectionSyncWithHistory = useCallback(async () => {
    const sync = subtreeProjectionRef.current.documentSync;
    const api = apiRef.current;
    if (!api || !sync?.canSync || syncPendingRef.current) return;
    const documentAtRequest = captureCanvasV5SyncBaseline({
      placement: placementPersistGate.current,
      drawing: persistGate.current,
      readScene: () => ({
        elements: api.getSceneElementsIncludingDeleted?.() ?? api.getSceneElements?.() ?? [],
        appState: api.getAppState?.() ?? {},
        files: api.getFiles?.() ?? {},
      }),
      commitPlacement: (elements, appState) => {
        commitPlacementFromScene(
          elements,
          appState as {
            scrollX?: number;
            scrollY?: number;
            zoom?: { value: number };
          }
        );
      },
      persistDrawing: (elements, appState, files) => {
        persistDrawing(
          elements,
          appState as Record<string, unknown>,
          files as Record<string, unknown>
        );
      },
      readDocument: () => documentRef.current,
    });
    syncPendingRef.current = true;
    try {
      const nextDocument = await onProjectionSync(sync.authorityDigest);
      if (
        documentRef.current !== documentAtRequest ||
        !nextDocument ||
        nextDocument === documentAtRequest
      ) return;
      commitPresentationDocumentWithHistory(nextDocument);
    } finally {
      syncPendingRef.current = false;
    }
  }, [commitPlacementFromScene, commitPresentationDocumentWithHistory, onProjectionSync, persistDrawing]);
  const handlePlacementHiddenChange = useCallback(
    (placementId: string, hidden: boolean) => {
      if (!apiRef.current) return;
      commitPresentationDocumentWithHistory(
        setCanvasProjectionPlacementHidden(
          documentRef.current,
          placementId,
          hidden
        )
      );
    },
    [commitPresentationDocumentWithHistory]
  );
  const handleSubtreeDirectionWhenReady = useCallback(
    (placementId: string, direction: SubtreeDirection) => {
      if (!apiRef.current) return;
      onSubtreeDirection(placementId, direction);
    },
    [onSubtreeDirection]
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      subtreeOverlayRef.current?.update(
        apiRef.current?.getAppState?.() ?? latestSceneRef.current.appState
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [canvasDocument, subtreeProjection]);

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
        <div
          className="tn-canvas-v5-host__projection-sync"
          data-state={subtreeProjection.documentSync ? "pending" : subtreeProjection.authority}
        >
          <IconButton
            variant="ghost"
            size="compact"
            data-testid="canvas-projection-sync"
            aria-label={subtreeProjection.documentSync
              ? `${canvasCopy("canvas.sync")}，${subtreeProjection.documentSync.affectedCount} 项待更新`
              : subtreeProjection.authority === "fresh"
                ? canvasCopy("canvas.sync.current")
                : canvasCopy("canvas.sync.unavailable")}
            tooltip={subtreeProjection.documentSync
              ? `${canvasCopy("canvas.sync")} · ${subtreeProjection.documentSync.affectedCount}`
              : subtreeProjection.authority === "fresh"
                ? canvasCopy("canvas.sync.current")
                : canvasCopy("canvas.sync.unavailable")}
            disabled={!apiReady || !subtreeProjection.documentSync?.canSync}
            onClick={handleProjectionSyncWithHistory}
          >
            <ShellIcon name="refresh" />
          </IconButton>
          {subtreeProjection.documentSync ? (
            <span aria-hidden="true">{subtreeProjection.documentSync.affectedCount}</span>
          ) : null}
        </div>
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
            {hiddenNodePlacements.length > 0 ? (
              <div className="tn-canvas-v5-host__hidden-list" data-testid="canvas-hidden-placements">
                <span>已隐藏投影</span>
                {hiddenNodePlacements.map((placement) => (
                  <Button
                    key={placement.placementId}
                    variant="quiet"
                    size="compact"
                    data-placement-id={placement.placementId}
                    disabled={!apiReady}
                    onClick={() => handlePlacementHiddenChange(placement.placementId, false)}
                  >
                    显示 {cardModels.get(placement.placementId)?.title ?? placement.entityRef ?? "本地节点"}
                  </Button>
                ))}
              </div>
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
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
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
                    placementId={custom.placementId}
                    data={{
                      nodeId: custom.nodeId,
                      title: "本地画布位置",
                      type: "节点",
                      state: "unknown",
                      stateLabel: "状态未知",
                      detail: "权威投影尚不可用；本地位置已保留。",
                    }}
                    selected={canvasDocument.focusedPlacementId === custom.placementId}
                    projectionSyncState="unknown"
                  />
                );
              }
              const selected = canvasDocument.focusedPlacementId === custom.placementId;
              return (
                <TentEmbeddableNode
                  placementId={custom.placementId}
                  data={toNodeData(model)}
                  selected={selected}
                  projectionSyncState={projectionStateByPlacement.get(custom.placementId) ?? "unknown"}
                  needsAttention={attentionPlacementIds.has(custom.placementId)}
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
        <CanvasSubtreeOverlay
          ref={subtreeOverlayRef}
          document={canvasDocument}
          projection={subtreeProjection}
          hoveredPlacementId={hoveredPlacementId}
          selectedPlacementId={canvasDocument.focusedPlacementId ?? null}
          onDirection={handleSubtreeDirectionWhenReady}
          onHide={(placementId) => handlePlacementHiddenChange(placementId, true)}
          commandsEnabled={apiReady}
        />
        {previewPlacementId && cardModels.get(previewPlacementId) ? (
          <aside
            ref={previewRef}
            className="tn-canvas-node-preview"
            data-testid="canvas-node-quick-preview"
            aria-hidden="true"
          >
            <span>{cardModels.get(previewPlacementId)!.typeLabel}</span>
            <strong>{cardModels.get(previewPlacementId)!.title}</strong>
            <p>{
              previewDocument?.nodeId === cardModels.get(previewPlacementId)!.nodeId
                ? previewDocument.status === "loading"
                  ? "正在载入正文…"
                  : previewDocument.status === "error"
                    ? "正文暂不可用"
                    : limitedCanvasNodePreview(previewDocument.body ?? "") || "正文为空"
                : onPreviewNode
                  ? "正在载入正文…"
                : cardModels.get(previewPlacementId)!.detail
            }</p>
          </aside>
        ) : null}
      </div>

    </div>
  );
}
