/**
 * Pure Canvas V5 adapter: CanvasDocument placements + frozen local snapshots
 * → Excalidraw embeddables, and the reverse
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
  removePlacement,
  setFocusedPlacement,
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
import type { CanvasDocument, CanvasPlacement } from "../../types/identity.js";
import {
  deriveCanvasPlacementSourceState,
  readCanvasNodeSnapshot,
  type CanvasSnapshotSource,
} from "../../model/canvas-node-snapshot.js";
import { withoutCanvasSubtreePlacementMeta } from "../../model/canvas-subtree-projection.js";
import { isCanvasPresentationHistoryElement } from "./canvas-presentation-history.js";

/** V5-local recovery labels; the pure adapter has no UI-engine dependency. */
export type TentNodeRecovery = "none" | "pending" | "ghost" | "error";

export type CanvasNodeResolvers = {
  resolveGhost?: (entityRef: string) => boolean;
  resolveError?: (entityRef: string) => boolean;
  resolvePendingRecovery?: (entityRef: string) => boolean;
  /** Used only to compare projection-visible fields with the frozen snapshot. */
  resolveCurrent?: (entityRef: string) => CanvasSnapshotSource | undefined;
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
  summary?: string;
  detail: string;
  state:
    | "snapshot"
    | "unknown"
    | "stale"
    | "unresolved"
    | "error";
  stateLabel: string;
  sourceState: "current" | "changed" | "deleted" | "unknown";
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

export function limitedCanvasNodePreview(body: string, limit = 180): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_>`~\[\]()!-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= limit) return plain;
  return `${plain.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
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

/** Capture only an exact internal Tent target; generic links remain native. */
export function captureTentNodeOpenTarget(
  element: { link?: string | null; customData?: unknown } | null | undefined,
  event: { preventDefault: () => void }
): TentNodeCustomData | null {
  const target = tentNodeOpenTarget(element);
  if (!target) return null;
  event.preventDefault();
  return target;
}

function placementSize(p: CanvasPlacement): { width: number; height: number } {
  return {
    width: p.kind === "node" ? NODE_CARD.width : isFiniteNumber(p.width) ? p.width : NODE_CARD.width,
    height: p.kind === "node" ? NODE_CARD.height : isFiniteNumber(p.height) ? p.height : NODE_CARD.height,
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

function detailForRecovery(recovery: TentNodeRecovery, path?: string): string {
  switch (recovery) {
    case "ghost":
      return "权威投影中已不存在该节点；本地位置仍保留。";
    case "pending":
      return "投影加载中或暂时不可用；本地位置未删除。";
    case "error":
      return "投影查询失败；本地位置仍保留。";
    default:
      return path || "拖放时冻结的本地快照；当前内容在右侧焦点栏。";
  }
}

function snapshotTypeLabel(type: string | undefined): string {
  if (type === "goal") return "目标";
  if (type === "prompt") return "提示";
  if (type === "output") return "输出";
  return type?.trim() || "节点";
}

function stateForSnapshot(
  recovery: TentNodeRecovery,
  sourceState: ReturnType<typeof deriveCanvasPlacementSourceState>,
  hasSnapshot: boolean
): Pick<TentEmbeddableCardModel, "state" | "stateLabel" | "sourceState"> {
  if (recovery === "ghost") {
    return { state: "unresolved", stateLabel: "节点未解析", sourceState: "deleted" };
  }
  if (recovery === "pending") {
    return { state: "stale", stateLabel: "投影已过期", sourceState: "unknown" };
  }
  if (recovery === "error") {
    return { state: "error", stateLabel: "加载失败", sourceState: "unknown" };
  }
  if (!hasSnapshot) return { state: "unknown", stateLabel: "快照尚未固化", sourceState: "unknown" };
  if (sourceState.state === "changed") {
    return { state: "snapshot", stateLabel: "来源有更新", sourceState: "changed" };
  }
  if (sourceState.reason === "revision-unavailable") {
    return { state: "snapshot", stateLabel: "来源版本未知", sourceState: "unknown" };
  }
  return { state: "snapshot", stateLabel: "本地快照", sourceState: "current" };
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
    const recovery = recoveryForEntity(entityRef, resolvers);
    const snapshot = readCanvasNodeSnapshot(p);
    const current = snapshot && entityRef
      ? resolvers.resolveCurrent?.(entityRef)
      : undefined;
    const sourceState = deriveCanvasPlacementSourceState({
      placement: p,
      authority: recovery === "none" ? "fresh" : "unknown",
      source: current ?? null,
    });
    const title = snapshot?.title?.trim() || snapshot?.name || "未固化的节点快照";
    const typeLabel = snapshotTypeLabel(snapshot?.type);
    const projectedState = stateForSnapshot(recovery, sourceState, Boolean(snapshot));
    map.set(p.placementId, {
      placementId: p.placementId,
      nodeId: entityRef ?? p.placementId,
      title,
      typeLabel,
      recovery,
      summary: snapshot?.tags?.length
        ? snapshot.tags.slice(0, 2).join(" · ")
        : undefined,
      detail: detailForRecovery(recovery, snapshot?.path),
      ...projectedState,
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
      strokeWidth: edge.emphasis === "quiet" ? 1.25 : 2,
      strokeStyle: edge.emphasis === "quiet" ? "dashed" : "solid",
      roughness: 0,
      opacity: edge.emphasis === "quiet" ? 34 : 76,
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
      endArrowhead: null,
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
 * Full pure mapping of a local document into Excalidraw elements. An optional
 * graph input is a read-only, non-persisted structure overlay. Production only
 * passes authoritative direct-parent pairs; card snapshots remain frozen.
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
      width: NODE_CARD.width,
      height: NODE_CARD.height,
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
 * Release Excalidraw's transient Tent-node selection after a pointer gesture.
 * This removes resize/rotation affordances without locking the element, and
 * canonicalizes any attempted transform while retaining the element position.
 * Non-Tent drawing selections remain owned by Excalidraw.
 */
export function releaseTentTransformSelection(
  elements: readonly unknown[],
  selectedElementIds: Record<string, boolean> | null | undefined
): {
  elements: readonly unknown[];
  selectedElementIds: Record<string, boolean>;
  elementsChanged: boolean;
  selectionChanged: boolean;
  changed: boolean;
} {
  const nextSelection = { ...(selectedElementIds ?? {}) };
  let elementsChanged = false;
  let selectionChanged = false;
  const nextElements = elements.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const element = raw as ExcalidrawElementLike;
    if (!readTentNodeCustomData(element)) return raw;
    if (nextSelection[element.id]) {
      delete nextSelection[element.id];
      selectionChanged = true;
    }
    if (
      element.width === NODE_CARD.width &&
      element.height === NODE_CARD.height &&
      (element.angle ?? 0) === 0
    ) {
      return raw;
    }
    elementsChanged = true;
    return {
      ...element,
      width: NODE_CARD.width,
      height: NODE_CARD.height,
      angle: 0,
    };
  });
  return {
    elements: elementsChanged ? nextElements : elements,
    selectedElementIds: nextSelection,
    elementsChanged,
    selectionChanged,
    changed: elementsChanged || selectionChanged,
  };
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
 * Reconcile local placement instances from one authoritative Excalidraw scene
 * frame. The cache is supplied by the host and contains only exact placements
 * that a local duplicate/delete command may restore through native undo/redo.
 * No Node/domain state participates in this operation.
 */
export function reconcileTentPlacementHistory(args: {
  document: CanvasDocument;
  elements: readonly unknown[];
  cachedPlacements: ReadonlyMap<string, CanvasPlacement>;
  knownHistoryPlacementIds?: ReadonlySet<string>;
  focusRestoredPlacementId?: string | null;
}): {
  document: CanvasDocument;
  restoredPlacements: CanvasPlacement[];
  deletedPlacements: CanvasPlacement[];
  conflictedPlacementIds: string[];
} {
  let document = args.document;
  const restoredPlacements: CanvasPlacement[] = [];
  const restoredIds = new Set<string>();
  const activeIds = new Set<string>();
  const deletedIds = new Set<string>();

  for (const raw of args.elements) {
    if (!raw || typeof raw !== "object") continue;
    const element = raw as ExcalidrawElementLike;
    const placementId = readTentNodeCustomData(element)?.placementId;
    if (!placementId) continue;
    (element.isDeleted === true ? deletedIds : activeIds).add(placementId);
  }
  const conflictedPlacementIds = [...activeIds].filter((placementId) =>
    deletedIds.has(placementId)
  );
  const conflictedIds = new Set(conflictedPlacementIds);

  for (const raw of args.elements) {
    if (!raw || typeof raw !== "object") continue;
    const element = raw as ExcalidrawElementLike;
    if (element.isDeleted === true) continue;
    const placementId = readTentNodeCustomData(element)?.placementId;
    if (
      !placementId ||
      conflictedIds.has(placementId) ||
      restoredIds.has(placementId) ||
      document.placements.some((placement) => placement.placementId === placementId)
    ) continue;
    const cached = args.cachedPlacements.get(placementId);
    if (!cached) continue;
    restoredIds.add(placementId);
    restoredPlacements.push(cached);
    document = {
      ...document,
      placements: [...document.placements, cached],
    };
  }

  if (
    args.focusRestoredPlacementId &&
    restoredIds.has(args.focusRestoredPlacementId)
  ) {
    document = setFocusedPlacement(document, args.focusRestoredPlacementId);
  }

  const removedIds = new Set(deletedIds);
  for (const placementId of args.knownHistoryPlacementIds ?? []) {
    if (!activeIds.has(placementId) && !deletedIds.has(placementId)) {
      removedIds.add(placementId);
    }
  }

  const deletedPlacements: CanvasPlacement[] = [];
  for (const placementId of removedIds) {
    if (conflictedIds.has(placementId)) continue;
    const placement = document.placements.find(
      (candidate) => candidate.placementId === placementId
    );
    if (!placement) continue;
    deletedPlacements.push(placement);
    document = removePlacement(document, placementId);
  }

  return {
    document,
    restoredPlacements,
    deletedPlacements,
    conflictedPlacementIds,
  };
}

/**
 * Re-key duplicated Tent embeddables as new local placement instances.
 * Domain identity and frozen snapshot metadata are copied, never mutated.
 */
export function duplicateTentPlacements(args: {
  document: CanvasDocument;
  nextElements: readonly ExcalidrawElementLike[];
  previousElements: readonly ExcalidrawElementLike[];
  createPlacementId: () => string;
}): { document: CanvasDocument; elements: ExcalidrawElementLike[]; addedPlacementIds: string[] } {
  const previousIds = new Set(args.previousElements.map((element) => element.id));
  const placementsById = new Map(
    args.document.placements.map((placement) => [placement.placementId, placement] as const)
  );
  const addedPlacements: CanvasPlacement[] = [];
  const addedPlacementIds: string[] = [];
  const elements = args.nextElements.map((element) => {
    if (previousIds.has(element.id)) return element;
    const custom = readTentNodeCustomData(element);
    if (!custom) return element;
    const source = placementsById.get(custom.placementId);
    if (!source) return element;
    const placementId = args.createPlacementId();
    addedPlacementIds.push(placementId);
    addedPlacements.push(withoutCanvasSubtreePlacementMeta({
      ...source,
      placementId,
      x: isFiniteNumber(element.x) ? element.x : source.x,
      y: isFiniteNumber(element.y) ? element.y : source.y,
      width: NODE_CARD.width,
      height: NODE_CARD.height,
    }));
    return {
      ...element,
      id: tentPlacementElementId(placementId),
      width: NODE_CARD.width,
      height: NODE_CARD.height,
      angle: 0,
      link: tentNodeLink(custom.nodeId),
      customData: { ...custom, placementId },
    };
  });
  if (addedPlacements.length === 0) {
    return { document: args.document, elements, addedPlacementIds };
  }
  return {
    document: {
      ...args.document,
      placements: [...args.document.placements, ...addedPlacements],
      focusedPlacementId: addedPlacementIds.at(-1) ?? args.document.focusedPlacementId,
    },
    elements,
    addedPlacementIds,
  };
}

/**
 * Strip tent-node / tent-edge elements so remaining content can feed Drawing V4.
 */
export function drawingElementsFromScene(
  elements: readonly unknown[]
): unknown[] {
  return elements.filter((raw) => {
    if (!raw || typeof raw !== "object") return false;
    if (isCanvasPresentationHistoryElement(raw)) return false;
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
