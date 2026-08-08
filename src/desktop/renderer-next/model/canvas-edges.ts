/**
 * Canvas relationship edges — pure projection of graph onto placements.
 * Edges are view-only: never invent domain relations or write parent/link state.
 * Formal semantic relations project as a separate layer; Canvas never mutates them.
 */

import type { CanvasDocument, CanvasPlacement, EntityRef, PlacementId } from "../types/identity.js";
import { NODE_CARD } from "./canvas-document.js";

export type CanvasEdgeKind = "parent" | "markdown" | "wiki" | "relation";

/** Which edge layers are visible on the local canvas. Parent starts enabled. */
export type CanvasEdgeLayerVisibility = {
  parent: boolean;
  markdown: boolean;
  wiki: boolean;
  /** First-class semantic relations from graph.projection.edges.relation. */
  relation: boolean;
};

export const DEFAULT_EDGE_LAYERS: CanvasEdgeLayerVisibility = {
  parent: true,
  markdown: false,
  wiki: false,
  relation: true,
};

export type GraphEdgeSource = {
  edges?: {
    parent?: { parentNodeId: string | null; childNodeId: string }[];
    markdown?: {
      fromNodeId: string;
      toNodeId?: string;
      raw: string;
      label?: string;
      unresolved?: unknown;
    }[];
    wiki?: {
      fromNodeId: string;
      toNodeId?: string;
      raw: string;
      label?: string;
      unresolved?: unknown;
    }[];
    relation?: {
      id: string;
      fromNodeId: string;
      kind: string;
      direction: "directed" | "bidirectional";
      label?: string;
      toNodeId?: string;
      unresolved?: string;
    }[];
  };
} | null;

export type CanvasEdge = {
  id: string;
  kind: CanvasEdgeKind;
  /** Domain endpoints (entity refs). */
  fromEntityRef: EntityRef;
  toEntityRef: EntityRef;
  fromPlacementId: PlacementId;
  toPlacementId: PlacementId;
  /** Geometry in canvas world coordinates (follows placement move/resize). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
  unresolved?: boolean;
  /** Semantic relation kind when kind === "relation". */
  relationKind?: string;
  direction?: "directed" | "bidirectional";
  /** Local selection emphasis; never a graph/domain field. */
  emphasis?: "quiet" | "selected-path" | "direct-child";
};

export type EdgeEndpoint = "right-center" | "left-center" | "center";

export function defaultEdgeLayers(): CanvasEdgeLayerVisibility {
  return { ...DEFAULT_EDGE_LAYERS };
}

export function toggleEdgeLayer(
  layers: CanvasEdgeLayerVisibility,
  layer: keyof CanvasEdgeLayerVisibility
): CanvasEdgeLayerVisibility {
  // Parent may be toggled off for declutter, but product default keeps it on.
  return { ...layers, [layer]: !layers[layer] };
}

export function normalizeEdgeLayers(
  input: Partial<CanvasEdgeLayerVisibility> | null | undefined
): CanvasEdgeLayerVisibility {
  const base = defaultEdgeLayers();
  if (!input || typeof input !== "object") return base;
  return {
    parent: input.parent !== false,
    markdown: input.markdown === true,
    wiki: input.wiki === true,
    // Relation defaults on; only explicit false turns off.
    relation: input.relation !== false,
  };
}

/**
 * Card edge anchor in world coords. Parent edges leave from the parent's
 * right-center and enter the child's left-center so horizontal trees read cleanly.
 */
export function placementEdgePoint(
  placement: CanvasPlacement,
  endpoint: EdgeEndpoint = "center"
): { x: number; y: number } {
  const x = placement.x ?? 0;
  const y = placement.y ?? 0;
  const w = placement.width ?? NODE_CARD.width;
  const h = placement.height ?? NODE_CARD.height;
  const cy = y + h / 2;
  if (endpoint === "right-center") return { x: x + w, y: cy };
  if (endpoint === "left-center") return { x, y: cy };
  return { x: x + w / 2, y: cy };
}

function preferredPlacementForEntity(
  doc: CanvasDocument,
  entityRef: EntityRef
): CanvasPlacement | undefined {
  const focused = doc.focusedPlacementId
    ? doc.placements.find((placement) =>
        placement.placementId === doc.focusedPlacementId &&
        placement.entityRef === entityRef
      )
    : undefined;
  if (focused) return focused;
  return doc.placements.find((p) => p.entityRef === entityRef);
}

function parentEdgeEmphasis(
  parentByChild: ReadonlyMap<string, string>,
  focusedEntityRef: string | undefined,
  parentNodeId: string,
  childNodeId: string
): CanvasEdge["emphasis"] {
  if (!focusedEntityRef) return "quiet";
  if (parentNodeId === focusedEntityRef) return "direct-child";
  const seen = new Set<string>();
  let current: string | undefined = focusedEntityRef;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent: string | undefined = parentByChild.get(current);
    if (!parent) break;
    if (parent === parentNodeId && current === childNodeId) return "selected-path";
    current = parent;
  }
  return "quiet";
}

/**
 * Project graph edges onto current placements. Only edges whose both endpoints
 * have a placement are emitted. Geometry tracks live placement size/position.
 * Unresolved relation targets (no toNodeId) are not drawn — fail closed.
 * Projection never mutates Canvas placements or Service relations.
 */
export function projectCanvasEdges(
  doc: CanvasDocument,
  graph: GraphEdgeSource,
  layers: CanvasEdgeLayerVisibility = DEFAULT_EDGE_LAYERS
): CanvasEdge[] {
  if (!graph?.edges) return [];
  const out: CanvasEdge[] = [];
  const focusedEntityRef = doc.focusedPlacementId
    ? doc.placements.find((placement) => placement.placementId === doc.focusedPlacementId)?.entityRef
    : undefined;
  const parentByChild = new Map(
    (graph.edges.parent ?? [])
      .filter((edge): edge is { parentNodeId: string; childNodeId: string } =>
        Boolean(edge.parentNodeId && edge.childNodeId)
      )
      .map((edge) => [edge.childNodeId, edge.parentNodeId] as const)
  );

  if (layers.parent) {
    for (const e of graph.edges.parent ?? []) {
      if (!e.parentNodeId || !e.childNodeId) continue;
      const from = preferredPlacementForEntity(doc, e.parentNodeId);
      const to = preferredPlacementForEntity(doc, e.childNodeId);
      if (!from || !to) continue;
      const a = placementEdgePoint(from, "right-center");
      const b = placementEdgePoint(to, "left-center");
      out.push({
        id: `parent:${e.parentNodeId}->${e.childNodeId}`,
        kind: "parent",
        fromEntityRef: e.parentNodeId,
        toEntityRef: e.childNodeId,
        fromPlacementId: from.placementId,
        toPlacementId: to.placementId,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        emphasis: parentEdgeEmphasis(parentByChild, focusedEntityRef, e.parentNodeId, e.childNodeId),
      });
    }
  }

  if (layers.markdown) {
    for (const e of graph.edges.markdown ?? []) {
      if (!e.toNodeId) continue;
      const from = preferredPlacementForEntity(doc, e.fromNodeId);
      const to = preferredPlacementForEntity(doc, e.toNodeId);
      if (!from || !to) continue;
      const a = placementEdgePoint(from, "center");
      const b = placementEdgePoint(to, "center");
      out.push({
        id: `markdown:${e.fromNodeId}->${e.toNodeId}:${e.raw}`,
        kind: "markdown",
        fromEntityRef: e.fromNodeId,
        toEntityRef: e.toNodeId,
        fromPlacementId: from.placementId,
        toPlacementId: to.placementId,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        label: e.label ?? e.raw,
        unresolved: e.unresolved != null,
      });
    }
  }

  if (layers.wiki) {
    for (const e of graph.edges.wiki ?? []) {
      if (!e.toNodeId) continue;
      const from = preferredPlacementForEntity(doc, e.fromNodeId);
      const to = preferredPlacementForEntity(doc, e.toNodeId);
      if (!from || !to) continue;
      const a = placementEdgePoint(from, "center");
      const b = placementEdgePoint(to, "center");
      out.push({
        id: `wiki:${e.fromNodeId}->${e.toNodeId}:${e.raw}`,
        kind: "wiki",
        fromEntityRef: e.fromNodeId,
        toEntityRef: e.toNodeId,
        fromPlacementId: from.placementId,
        toPlacementId: to.placementId,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        label: e.label ?? e.raw,
        unresolved: e.unresolved != null,
      });
    }
  }

  if (layers.relation) {
    for (const e of graph.edges.relation ?? []) {
      // Unresolved targets have no toNodeId — do not invent Canvas endpoints.
      if (!e.toNodeId || !e.fromNodeId || !e.id) continue;
      const from = preferredPlacementForEntity(doc, e.fromNodeId);
      const to = preferredPlacementForEntity(doc, e.toNodeId);
      if (!from || !to) continue;
      const a = placementEdgePoint(from, "center");
      const b = placementEdgePoint(to, "center");
      out.push({
        id: `relation:${e.id}`,
        kind: "relation",
        fromEntityRef: e.fromNodeId,
        toEntityRef: e.toNodeId,
        fromPlacementId: from.placementId,
        toPlacementId: to.placementId,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        label: e.label ?? e.kind,
        relationKind: e.kind,
        direction: e.direction,
        unresolved: e.unresolved != null,
      });
    }
  }

  return out;
}
