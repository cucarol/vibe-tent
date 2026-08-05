/**
 * Canvas V5 migration helpers: read the existing Excalidraw-shaped drawing
 * snapshot beside CanvasDocument without renaming storage keys or wiping data.
 *
 * Guarantees:
 * - Idempotent hydrate: repeating adapt does not duplicate tent placements.
 * - Failure retains prior drawing snapshot and reports diagnostics.
 * - Image fileIds and binary map entries are preserved through the V4 adapter.
 * - V5 writes the same `{elements, appState, files}` snapshot envelope.
 */
import type { CanvasDocument } from "../../types/identity.js";
import {
  documentToExcalidrawElements,
  drawingElementsFromScene,
  excalidrawAppStateFromViewport,
  tentPlacementElementId,
  type CanvasNodeResolvers,
  type ExcalidrawElementLike,
} from "./documentToExcalidraw.js";
import type { ExcalidrawSceneSnapshot } from "./excalidrawSceneTypes.js";
import type {
  CanvasEdgeLayerVisibility,
  GraphEdgeSource,
} from "../../model/canvas-edges.js";
import { DEFAULT_VIEWPORT } from "../../model/canvas-document.js";
import { CANVAS_V5_COLORS } from "./canvasV5Theme.js";

export type DrawingDiagnostic = {
  code: string;
  message: string;
};

export type V5HydrateStatus =
  | { kind: "ok" }
  | { kind: "degraded"; message: string; diagnostics: readonly DrawingDiagnostic[] }
  | { kind: "error"; message: string; retainedScene: ExcalidrawSceneSnapshot | null };

export type V5HydrateResult = {
  /** Merged Excalidraw elements (placements + edges + drawing). */
  elements: readonly unknown[];
  files: Record<string, unknown>;
  appState: Record<string, unknown>;
  /** Drawing-only elements for later V4 write-back. */
  drawingElements: readonly unknown[];
  status: V5HydrateStatus;
  /** True when a second hydrate with the same inputs yields the same element ids. */
  placementElementIds: readonly string[];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Read a legacy Excalidraw-shaped drawing snapshot without dropping unknown
 * element/file fields. Malformed top-level fields fail closed to empty values;
 * the caller still receives the original snapshot in the error status.
 */
export function hydrateDrawingSceneForV5(
  scene: ExcalidrawSceneSnapshot | null | undefined
): {
  elements: readonly unknown[];
  files: Record<string, unknown>;
  appState: Record<string, unknown>;
  diagnostics: readonly DrawingDiagnostic[];
  error: string | null;
} {
  if (!scene) {
    return {
      elements: [],
      files: {},
      appState: {},
      diagnostics: [],
      error: null,
    };
  }
  try {
    if (!Array.isArray(scene.elements)) {
      throw new Error("绘图元素损坏；已保留原始快照。 ");
    }
    if (scene.files != null && !isPlainObject(scene.files)) {
      throw new Error("绘图附件索引损坏；已保留原始快照。 ");
    }
    if (scene.appState != null && !isPlainObject(scene.appState)) {
      throw new Error("画布视图状态损坏；已保留原始快照。 ");
    }
    return {
      elements: scene.elements.slice(),
      files: { ...(scene.files ?? {}) },
      appState: { ...(scene.appState ?? {}) },
      diagnostics: [],
      error: null,
    };
  } catch (err) {
    return {
      elements: Array.isArray(scene.elements) ? scene.elements.slice() : [],
      files:
        scene.files && isPlainObject(scene.files)
          ? { ...scene.files }
          : {},
      appState: { ...(scene.appState ?? {}) },
      diagnostics: [],
      error: err instanceof Error ? err.message : "V4 画布读取失败，已保留原数据。",
    };
  }
}

/**
 * Build the production V5 initial scene from CanvasDocument + optional V4 drawing.
 * Idempotent: placement element ids are a pure function of placementId.
 */
export function hydrateCanvasV5Scene(input: {
  document: CanvasDocument;
  drawingScene?: ExcalidrawSceneSnapshot | null;
  resolvers?: CanvasNodeResolvers;
  graph?: GraphEdgeSource | null;
  edgeLayers?: CanvasEdgeLayerVisibility;
}): V5HydrateResult {
  const drawing = hydrateDrawingSceneForV5(input.drawingScene);
  const mapped = documentToExcalidrawElements(input.document, {
    resolvers: input.resolvers,
    graph: input.graph,
    edgeLayers: input.edgeLayers,
    drawingElements: drawing.elements,
  });

  const viewport = input.document.viewport ?? DEFAULT_VIEWPORT;
  const camera = excalidrawAppStateFromViewport(viewport);
  const appState: Record<string, unknown> = {
    ...drawing.appState,
    ...camera,
    viewBackgroundColor: CANVAS_V5_COLORS.blankBackground,
    gridModeEnabled: false,
    collaborators: new Map(),
    selectedElementIds: input.document.focusedPlacementId
      ? { [tentPlacementElementId(input.document.focusedPlacementId)]: true }
      : {},
  };

  let status: V5HydrateStatus = { kind: "ok" };
  if (drawing.error) {
    status = {
      kind: "error",
      message: drawing.error,
      retainedScene: input.drawingScene ?? null,
    };
  } else if (drawing.diagnostics.length > 0) {
    status = {
      kind: "degraded",
      message: drawing.diagnostics[0]?.message ?? "部分绘图对象以降级方式载入。",
      diagnostics: drawing.diagnostics,
    };
  }

  const placementElementIds = mapped.elements
    .filter((el) => el.type === "embeddable")
    .map((el) => el.id);

  return {
    elements: mapped.elements,
    files: drawing.files,
    appState,
    drawingElements: drawingElementsFromScene(mapped.elements),
    status,
    placementElementIds,
  };
}

/**
 * Second hydrate must not invent extra placement element ids.
 */
export function assertIdempotentPlacementHydrate(
  first: V5HydrateResult,
  second: V5HydrateResult
): boolean {
  if (first.placementElementIds.length !== second.placementElementIds.length) {
    return false;
  }
  const a = [...first.placementElementIds].sort();
  const b = [...second.placementElementIds].sort();
  return a.every((id, i) => id === b[i]);
}

/**
 * Build a persistable drawing snapshot from the live V5 scene (Tent Nodes
 * stripped). The raw Excalidraw element/file fields remain untouched.
 */
export function sceneSnapshotForV4Persist(
  elements: readonly unknown[],
  appState: Record<string, unknown> | null | undefined,
  files: Record<string, unknown> | null | undefined,
  layerVisible = true
): ExcalidrawSceneSnapshot {
  const drawingOnly = drawingElementsFromScene(elements);
  return {
    elements: drawingOnly,
    appState: isPlainObject(appState) ? { ...appState } : {},
    files: isPlainObject(files) ? { ...files } : {},
    layerVisible,
  };
}

/**
 * Collect image fileIds still referenced after hydrate (regression guard).
 */
export function collectImageFileIds(elements: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as ExcalidrawElementLike & { fileId?: unknown };
    if (el.type === "image" && typeof el.fileId === "string" && el.fileId) {
      ids.push(el.fileId);
    }
    const data = (el as { data?: { fileId?: unknown } }).data;
    if (data && typeof data.fileId === "string" && data.fileId) {
      ids.push(data.fileId);
    }
  }
  return ids;
}
