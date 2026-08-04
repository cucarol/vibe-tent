/**
 * Pure Canvas V5 adapter: CanvasDocument placements + Service summaries +
 * projected edges → Excalidraw embeddable / arrow elements, and the reverse
 * write-back from element changes into local placement geometry/selection.
 *
 * Frozen rules:
 * - customData.kind = "tent-node"; store nodeId + placementId only (no body/Task).
 * - Same nodeId may appear as multiple placements (placementId is instance key).
 * - Projection stale/error never deletes placements; recovery is presentation-only.
 * - No React Flow camera; Excalidraw owns scene coordinates.
 */

import {
  NODE_CARD,
  type Viewport,
  DEFAULT_VIEWPORT,
} from "../../model/canvas-document.js";
import { CANVAS_V5_COLORS } from "./canvasV5Theme.js";
import {
  projectCanvasEdges,
  type CanvasEdgeLayerVisibility,
  type GraphEdgeSource,
  DEFAULT_EDGE_LAYERS,
} from "../../model/canvas-edges.js";
import {
  compactExpandedSummary,
  getPlacementPresentation,
  type PlacementPresentation,
} from "../../model/placement-chrome.js";
import type { CanvasDocument, CanvasPlacement } from "../../types/identity.js";

/** V5-local recovery labels; the pure adapter has no UI-engine dependency. */
export type TentNodeRecovery = "none" | "pending" | "ghost" | "error";

export type CanvasNodeResolvers = {
  resolveLabel?: (entityRef: string) => string | undefined;
  resolveType?: (entityRef: string) => string | undefined;
  resolveGhost?: (entityRef: string) => boolean;
  resolveError?: (entityRef: string) => boolean;
  resolvePendingRecovery?: (entityRef: string) => boolean;
  /** `null` is authoritative idle; `undefined` is not loaded / failed. */
  resolveActiveTaskState?: (entityRef: string) => string | null | undefined;
  resolveSummary?: (entityRef: string) =>
    | {
        type?: string;
        tags?: readonly string[];
        path?: string;
        childCount?: number;
      }
    | undefined;
};

export const TENT_NODE_CUSTOM_KIND = "tent-node" as const;
export const TENT_NODE_LINK_PREFIX = "tent://node/" as const;
export const TENT_PLACEMENT_ELEMENT_PREFIX = "tent-pl:" as const;

export type TentNodeCustomData = {
  kind: typeof TENT_NODE_CUSTOM_KIND;
  nodeId: string;
  placementId: string;
};

export type TentEmbeddableCardModel = {
  placementId: string;
  nodeId: string;
  title: string;
  typeLabel: string;
  recovery: TentNodeRecovery;
  presentation: PlacementPresentation;
  summary?: string;
  detail: string;
  state:
    | "active"
    | "waiting"
    | "delivered"
    | "idle"
    | "unknown"
    | "stale"
    | "unresolved"
    | "error";
  stateLabel: string;
  /** Exact protocol state retained for diagnostics; presentation may translate it. */
  rawTaskState?: string | null;
  width: number;
  height: number;
};

export type ExcalidrawElementLike = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  isDeleted?: boolean;
  link?: string | null;
  locked?: boolean;
  customData?: Record<string, unknown>;
  [key: string]: unknown;
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function tentPlacementElementId(placementId: string): string {
  return `${TENT_PLACEMENT_ELEMENT_PREFIX}${placementId}`;
}

export function placementIdFromElementId(elementId: string): string | null {
  if (!elementId.startsWith(TENT_PLACEMENT_ELEMENT_PREFIX)) return null;
  const id = elementId.slice(TENT_PLACEMENT_ELEMENT_PREFIX.length);
  return id.length > 0 ? id : null;
}

export function isTentNodeCustomData(
  raw: unknown
): raw is TentNodeCustomData {
  if (!raw || typeof raw !== "object") return false;
  const data = raw as Record<string, unknown>;
  return (
    data.kind === TENT_NODE_CUSTOM_KIND &&
    typeof data.nodeId === "string" &&
    data.nodeId.length > 0 &&
    typeof data.placementId === "string" &&
    data.placementId.length > 0
  );
}

export function readTentNodeCustomData(
  element: { customData?: unknown } | null | undefined
): TentNodeCustomData | null {
  return isTentNodeCustomData(element?.customData) ? element.customData : null;
}

export function tentNodeLink(nodeId: string): string {
  return `${TENT_NODE_LINK_PREFIX}${nodeId}`;
}

export function validateTentEmbeddableLink(link: string | null | undefined): boolean {
  return link == null || link === "" || link.startsWith(TENT_NODE_LINK_PREFIX);
}

/**
 * Resolve Excalidraw's required embeddable link to a Tent-owned Node action.
 * Both customData and the internal URL must agree; malformed or generic links
 * fail closed and are never opened by the host.
 */
export function tentNodeOpenTarget(
  element: { link?: string | null; customData?: unknown } | null | undefined
): TentNodeCustomData | null {
  const custom = readTentNodeCustomData(element);
  if (!custom || element?.link !== tentNodeLink(custom.nodeId)) return null;
  return custom;
}

function placementSize(p: CanvasPlacement): { width: number; height: number } {
  return {
    width: isFiniteNumber(p.width) ? p.width : NODE_CARD.width,
    height: isFiniteNumber(p.height) ? p.height : NODE_CARD.height,
  };
}

function recoveryForEntity(
  entityRef: string | undefined,
  resolvers: CanvasNodeResolvers
): TentNodeRecovery {
  if (!entityRef) return "none";
  if (resolvers.resolveError?.(entityRef)) return "error";
  if (resolvers.resolveGhost?.(entityRef)) return "ghost";
  if (resolvers.resolvePendingRecovery?.(entityRef)) return "pending";
  return "none";
}

function detailForRecovery(recovery: TentNodeRecovery): string {
  switch (recovery) {
    case "ghost":
      return "权威投影中已不存在该节点；本地位置仍保留。";
    case "pending":
      return "投影加载中或暂时不可用；本地位置未删除。";
    case "error":
      return "投影查询失败；本地位置仍保留。";
    default:
      return "空间表达与状态动效；正文与派活在右侧详情栏。";
  }
}

function stateForProjection(
  recovery: TentNodeRecovery,
  activeTaskState: string | null | undefined
): Pick<TentEmbeddableCardModel, "state" | "stateLabel"> {
  if (recovery === "ghost") {
    return { state: "unresolved", stateLabel: "节点未解析" };
  }
  if (recovery === "pending") {
    return { state: "stale", stateLabel: "投影已过期" };
  }
  if (recovery === "error") {
    return { state: "error", stateLabel: "加载失败" };
  }
  if (activeTaskState === undefined) {
    return { state: "unknown", stateLabel: "协作状态未加载" };
  }
  if (activeTaskState === null) {
    return { state: "idle", stateLabel: "无进行中任务" };
  }
  if (activeTaskState === "waiting") {
    return { state: "waiting", stateLabel: "任务等待中" };
  }
  if (activeTaskState === "delivered") {
    return { state: "delivered", stateLabel: "交付待审" };
  }
  const exactStateLabels: Record<string, string> = {
    claimed: "任务已认领",
    running: "任务进行中",
    interrupted: "任务已中断",
    rejected: "返工中",
  };
  return {
    state: "active",
    stateLabel: exactStateLabels[activeTaskState] ?? `任务 · ${activeTaskState}`,
  };
}

/**
 * Build presentational card models for embeddable React content.
 * Does not copy Task / body / collaboration facts into customData.
 */
export function buildTentEmbeddableCardModels(
  doc: CanvasDocument,
  resolvers: CanvasNodeResolvers = {}
): Map<string, TentEmbeddableCardModel> {
  const map = new Map<string, TentEmbeddableCardModel>();
  for (const p of doc.placements) {
    const entityRef = p.entityRef;
    const size = placementSize(p);
    const presentation = getPlacementPresentation(p.meta);
    const recovery = recoveryForEntity(entityRef, resolvers);
    const title =
      (entityRef && resolvers.resolveLabel?.(entityRef)) ||
      (typeof p.meta?.name === "string" ? p.meta.name : null) ||
      (entityRef ? "未解析节点" : p.kind);
    const typeLabel =
      (entityRef && resolvers.resolveType?.(entityRef)) ||
      (typeof p.meta?.type === "string" ? p.meta.type : "") ||
      "节点";
    const summaryFields =
      entityRef && resolvers.resolveSummary
        ? resolvers.resolveSummary(entityRef)
        : undefined;
    const rawTaskState = entityRef
      ? resolvers.resolveActiveTaskState?.(entityRef)
      : undefined;
    const projectedState = stateForProjection(recovery, rawTaskState);
    map.set(p.placementId, {
      placementId: p.placementId,
      nodeId: entityRef ?? p.placementId,
      title,
      typeLabel,
      recovery,
      presentation,
      summary:
        presentation === "expanded"
          ? compactExpandedSummary({
              type: summaryFields?.type ?? typeLabel,
              tags: summaryFields?.tags,
              path: summaryFields?.path,
              childCount: summaryFields?.childCount,
            })
          : undefined,
      detail: detailForRecovery(recovery),
      ...projectedState,
      rawTaskState,
      width: size.width,
      height: size.height,
    });
  }
  return map;
}

function baseEmbeddableSeed(placementId: string): number {
  let h = 0;
  for (let i = 0; i < placementId.length; i++) {
    h = (h * 31 + placementId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) + 1;
}

/**
 * Map one placement to an Excalidraw embeddable element (pure, serializable).
 */
export function placementToEmbeddableElement(
  placement: CanvasPlacement,
  options: {
    focused?: boolean;
    version?: number;
  } = {}
): ExcalidrawElementLike {
  const size = placementSize(placement);
  const nodeId = placement.entityRef ?? placement.placementId;
  const seed = baseEmbeddableSeed(placement.placementId);
  return {
    id: tentPlacementElementId(placement.placementId),
    type: "embeddable",
    x: isFiniteNumber(placement.x) ? placement.x : 0,
    y: isFiniteNumber(placement.y) ? placement.y : 0,
    width: size.width,
    height: size.height,
    angle: 0,
    // The React embeddable owns the node boundary. Excalidraw still renders its
    // native selection box, so a second element stroke would create a nested
    // card outline and an exaggerated rounded corner.
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed,
    version: options.version ?? 1,
    versionNonce: seed + 17,
    isDeleted: false,
    boundElements: [],
    updated: 1,
    // Excalidraw requires a link to activate its public renderEmbeddable seam.
    // CanvasV5Host owns this internal URL and maps it to the tested Focus action;
    // it is never allowed to navigate the browser.
    link: tentNodeLink(nodeId),
    locked: false,
    customData: {
      kind: TENT_NODE_CUSTOM_KIND,
      nodeId,
      placementId: placement.placementId,
    } satisfies TentNodeCustomData,
  };
}

/**
 * Project graph edges that connect two on-canvas placements into arrow elements.
 * Unresolved / missing endpoints are skipped (fail-closed; no invented geometry).
 */
export function projectedEdgesToArrowElements(
  doc: CanvasDocument,
  graph: GraphEdgeSource | null | undefined,
  layers: CanvasEdgeLayerVisibility = DEFAULT_EDGE_LAYERS
): ExcalidrawElementLike[] {
  const edges = projectCanvasEdges(doc, graph ?? null, layers);
  return edges.map((edge, index) => {
    const dx = edge.x2 - edge.x1;
    const dy = edge.y2 - edge.y1;
    return {
      id: `tent-edge:${edge.id}`,
      type: "arrow",
      x: edge.x1,
      y: edge.y1,
      width: Math.abs(dx),
      height: Math.abs(dy),
      angle: 0,
      strokeColor:
        edge.kind === "parent"
          ? CANVAS_V5_COLORS.relationParent
          : CANVAS_V5_COLORS.relationSecondary,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: edge.kind === "parent" ? 2 : 1.5,
      strokeStyle: edge.unresolved ? "dashed" : "solid",
      roughness: 0,
      opacity: 74,
      groupIds: [],
      frameId: null,
      roundness: { type: 2 },
      seed: 5000 + index,
      version: 1,
      versionNonce: 6000 + index,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: true,
      points: [
        [0, 0],
        [dx, dy],
      ],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
      customData: {
        kind: "tent-edge",
        edgeId: edge.id,
        edgeKind: edge.kind,
      },
    };
  });
}

export type DocumentToExcalidrawResult = {
  elements: readonly ExcalidrawElementLike[];
  cards: Map<string, TentEmbeddableCardModel>;
  /** Element id → placementId for tent nodes only. */
  placementByElementId: Map<string, string>;
};

/**
 * Full pure mapping of local document + projection into Excalidraw elements.
 * Drawing-layer freehand/text/image elements are supplied separately by the host
 * (V4 scene) so this function never invents ink or binaries.
 */
export function documentToExcalidrawElements(
  doc: CanvasDocument,
  options: {
    resolvers?: CanvasNodeResolvers;
    graph?: GraphEdgeSource | null;
    edgeLayers?: CanvasEdgeLayerVisibility;
    /** Extra non-node scene elements (drawing V4 legacy elements). */
    drawingElements?: readonly unknown[];
  } = {}
): DocumentToExcalidrawResult {
  const resolvers = options.resolvers ?? {};
  const cards = buildTentEmbeddableCardModels(doc, resolvers);
  const placementByElementId = new Map<string, string>();
  const nodeElements = doc.placements.map((p) => {
    const el = placementToEmbeddableElement(p, {
      focused: doc.focusedPlacementId === p.placementId,
    });
    placementByElementId.set(el.id, p.placementId);
    return el;
  });
  const edgeElements = projectedEdgesToArrowElements(
    doc,
    options.graph,
    options.edgeLayers ?? DEFAULT_EDGE_LAYERS
  );

  const drawing = (options.drawingElements ?? []).filter((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const el = raw as ExcalidrawElementLike;
    // Never re-import tent nodes from drawing storage (placements are SoT).
    if (readTentNodeCustomData(el)) return false;
    if (typeof el.id === "string" && el.id.startsWith(TENT_PLACEMENT_ELEMENT_PREFIX)) {
      return false;
    }
    if (typeof el.id === "string" && el.id.startsWith("tent-edge:")) return false;
    return el.isDeleted !== true;
  }) as ExcalidrawElementLike[];

  return {
    elements: [...nodeElements, ...edgeElements, ...drawing],
    cards,
    placementByElementId,
  };
}

export type PlacementGeometryPatch = {
  placementId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Extract placement geometry from live Excalidraw elements (mid-drag continuous).
 * Deleted tent embeddables are omitted (host decides remove-from-canvas).
 */
export function extractPlacementPatchesFromElements(
  elements: readonly unknown[]
): PlacementGeometryPatch[] {
  const patches: PlacementGeometryPatch[] = [];
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as ExcalidrawElementLike;
    if (el.isDeleted === true) continue;
    const custom = readTentNodeCustomData(el);
    if (!custom) continue;
    if (!isFiniteNumber(el.x) || !isFiniteNumber(el.y)) continue;
    patches.push({
      placementId: custom.placementId,
      x: el.x,
      y: el.y,
      width: isFiniteNumber(el.width) ? el.width : NODE_CARD.width,
      height: isFiniteNumber(el.height) ? el.height : NODE_CARD.height,
    });
  }
  return patches;
}

/**
 * Apply geometry patches to CanvasDocument without touching entityRef / kind.
 * Pure; safe to call on every pointermove — persistence should still debounce.
 */
export function applyPlacementPatches(
  doc: CanvasDocument,
  patches: readonly PlacementGeometryPatch[]
): CanvasDocument {
  if (patches.length === 0) return doc;
  const byId = new Map(patches.map((p) => [p.placementId, p]));
  let changed = false;
  const placements = doc.placements.map((p) => {
    const patch = byId.get(p.placementId);
    if (!patch) return p;
    if (
      p.x === patch.x &&
      p.y === patch.y &&
      p.width === patch.width &&
      p.height === patch.height
    ) {
      return p;
    }
    changed = true;
    return {
      ...p,
      x: patch.x,
      y: patch.y,
      width: patch.width,
      height: patch.height,
    };
  });
  return changed ? { ...doc, placements } : doc;
}

/**
 * Read focused placement from Excalidraw selectedElementIds.
 * Prefer the first selected tent-node; blank selection → null.
 */
export function selectionToFocusedPlacement(
  elements: readonly unknown[],
  selectedElementIds: Record<string, boolean> | null | undefined
): { placementId: string | null; entityRef: string | null } {
  if (!selectedElementIds) {
    return { placementId: null, entityRef: null };
  }
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as ExcalidrawElementLike;
    if (!selectedElementIds[el.id] || el.isDeleted === true) continue;
    const custom = readTentNodeCustomData(el);
    if (!custom) continue;
    return {
      placementId: custom.placementId,
      entityRef: custom.nodeId,
    };
  }
  return { placementId: null, entityRef: null };
}

/**
 * Placement ids whose tent embeddable is marked isDeleted in the scene.
 */
export function deletedTentPlacementIds(
  elements: readonly unknown[]
): string[] {
  const out: string[] = [];
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as ExcalidrawElementLike;
    if (el.isDeleted !== true) continue;
    const custom = readTentNodeCustomData(el);
    if (custom) out.push(custom.placementId);
  }
  return out;
}

/**
 * Strip tent-node / tent-edge elements so remaining content can feed Drawing V4.
 */
export function drawingElementsFromScene(
  elements: readonly unknown[]
): unknown[] {
  return elements.filter((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const el = raw as ExcalidrawElementLike;
    if (readTentNodeCustomData(el)) return false;
    if (typeof el.id === "string" && el.id.startsWith("tent-edge:")) return false;
    if (typeof el.id === "string" && el.id.startsWith(TENT_PLACEMENT_ELEMENT_PREFIX)) {
      return false;
    }
    return true;
  });
}

export function viewportFromExcalidrawAppState(
  appState: {
    scrollX?: number;
    scrollY?: number;
    zoom?: { value?: number } | number;
  } | null | undefined,
  base: Viewport = DEFAULT_VIEWPORT
): Viewport {
  const zoomRaw =
    typeof appState?.zoom === "number"
      ? appState.zoom
      : appState?.zoom && typeof appState.zoom === "object"
        ? appState.zoom.value
        : undefined;
  const zoom = isFiniteNumber(zoomRaw) && zoomRaw > 0 ? zoomRaw : base.zoom;
  const scrollX = isFiniteNumber(appState?.scrollX) ? appState!.scrollX! : base.x / zoom;
  const scrollY = isFiniteNumber(appState?.scrollY) ? appState!.scrollY! : base.y / zoom;
  // Match sharedViewport: translationPx = scroll * zoom
  return {
    x: scrollX * zoom,
    y: scrollY * zoom,
    zoom,
  };
}

export function excalidrawAppStateFromViewport(viewport: Viewport | null | undefined): {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
} {
  const v = viewport ?? DEFAULT_VIEWPORT;
  const zoom = isFiniteNumber(v.zoom) && v.zoom > 0 ? v.zoom : 1;
  return {
    scrollX: v.x / zoom,
    scrollY: v.y / zoom,
    zoom: { value: zoom },
  };
}

/**
 * True when two placement patch lists are geometrically equal (for persist skip).
 */
export function placementPatchesEqual(
  a: readonly PlacementGeometryPatch[],
  b: readonly PlacementGeometryPatch[]
): boolean {
  if (a.length !== b.length) return false;
  const map = new Map(b.map((p) => [p.placementId, p]));
  for (const left of a) {
    const right = map.get(left.placementId);
    if (!right) return false;
    if (
      left.x !== right.x ||
      left.y !== right.y ||
      left.width !== right.width ||
      left.height !== right.height
    ) {
      return false;
    }
  }
  return true;
}
