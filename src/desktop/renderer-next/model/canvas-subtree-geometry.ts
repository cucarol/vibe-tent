import type { CanvasDocument, CanvasPlacement } from "../types/identity.js";
import { NODE_CARD } from "./canvas-document.js";
import type {
  CanvasSubtreeProjection,
  CanvasSubtreeRelationship,
  SubtreeDirection,
} from "./canvas-subtree-projection.js";

export type CanvasSubtreeStructureBranch = {
  id: string;
  parentPlacementId: string;
  direction: SubtreeDirection;
  path: string;
  highlightPath: string | null;
  routePoints: readonly Point[];
};

export type CanvasSubtreeStructurePathTarget = {
  setAttribute(name: "d", value: string): void;
};

export type CanvasSubtreeStructurePathRefs = ReadonlyMap<string, {
  base: CanvasSubtreeStructurePathTarget | null;
  highlight: CanvasSubtreeStructurePathTarget | null;
}>;

type PositionOverride = { placementId: string; x: number; y: number } | null;
type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

const STRUCTURE_CLEARANCE = 10;

function placementRect(placement: CanvasPlacement, override: PositionOverride): Rect {
  const x = override?.placementId === placement.placementId ? override.x : placement.x ?? 0;
  const y = override?.placementId === placement.placementId ? override.y : placement.y ?? 0;
  return { x, y, width: NODE_CARD.width, height: NODE_CARD.height };
}

function centersDirection(parent: Rect, child: Rect): SubtreeDirection {
  const dx = child.x + child.width / 2 - (parent.x + parent.width / 2);
  const dy = child.y + child.height / 2 - (parent.y + parent.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "down" : "up";
}

function anchor(rect: Rect, direction: SubtreeDirection): Point {
  if (direction === "right") return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  if (direction === "left") return { x: rect.x, y: rect.y + rect.height / 2 };
  if (direction === "down") return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
  return { x: rect.x + rect.width / 2, y: rect.y };
}

function opposite(direction: SubtreeDirection): SubtreeDirection {
  if (direction === "right") return "left";
  if (direction === "left") return "right";
  if (direction === "down") return "up";
  return "down";
}

function inflateRect(rect: Rect): Rect {
  return {
    x: rect.x - STRUCTURE_CLEARANCE,
    y: rect.y - STRUCTURE_CLEARANCE,
    width: rect.width + STRUCTURE_CLEARANCE * 2,
    height: rect.height + STRUCTURE_CLEARANCE * 2,
  };
}

function segmentIntersectsRect(a: Point, b: Point, rect: Rect): boolean {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (a.y === b.y) {
    if (a.y <= rect.y || a.y >= bottom) return false;
    return Math.max(Math.min(a.x, b.x), rect.x) < Math.min(Math.max(a.x, b.x), right);
  }
  if (a.x === b.x) {
    if (a.x <= rect.x || a.x >= right) return false;
    return Math.max(Math.min(a.y, b.y), rect.y) < Math.min(Math.max(a.y, b.y), bottom);
  }
  return true;
}

function normalizePoints(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (!previous || previous.x !== point.x || previous.y !== point.y) result.push(point);
  }
  return result;
}

function pathIsClear(
  points: readonly Point[],
  obstacles: readonly Rect[]
): boolean {
  for (let index = 1; index < points.length; index += 1) {
    for (const rect of obstacles) {
      if (segmentIntersectsRect(points[index - 1], points[index], rect)) return false;
    }
  }
  return true;
}

/**
 * Two direct elbows, one centered dogleg, then four outer detours. This keeps
 * card avoidance without a global lane graph or search.
 * ponytail: O(visible edges × visible cards); revisit only after measured dense-canvas drag lag.
 */
function routeOrthogonal(
  start: Point,
  end: Point,
  direction: SubtreeDirection,
  obstacles: readonly Rect[]
): Point[] | null {
  const horizontal = direction === "left" || direction === "right";
  const middle = horizontal
    ? normalizePoints([start, { x: (start.x + end.x) / 2, y: start.y }, { x: (start.x + end.x) / 2, y: end.y }, end])
    : normalizePoints([start, { x: start.x, y: (start.y + end.y) / 2 }, { x: end.x, y: (start.y + end.y) / 2 }, end]);
  const candidates: Point[][] = [
    middle,
    normalizePoints([start, { x: end.x, y: start.y }, end]),
    normalizePoints([start, { x: start.x, y: end.y }, end]),
  ];
  if (obstacles.length > 0) {
    const left = Math.min(start.x, end.x, ...obstacles.map((rect) => rect.x)) - STRUCTURE_CLEARANCE;
    const right = Math.max(start.x, end.x, ...obstacles.map((rect) => rect.x + rect.width)) + STRUCTURE_CLEARANCE;
    const top = Math.min(start.y, end.y, ...obstacles.map((rect) => rect.y)) - STRUCTURE_CLEARANCE;
    const bottom = Math.max(start.y, end.y, ...obstacles.map((rect) => rect.y + rect.height)) + STRUCTURE_CLEARANCE;
    candidates.push(
      normalizePoints([start, { x: start.x, y: top }, { x: end.x, y: top }, end]),
      normalizePoints([start, { x: right, y: start.y }, { x: right, y: end.y }, end]),
      normalizePoints([start, { x: start.x, y: bottom }, { x: end.x, y: bottom }, end]),
      normalizePoints([start, { x: left, y: start.y }, { x: left, y: end.y }, end])
    );
  }
  for (const candidate of candidates) {
    if (pathIsClear(candidate, obstacles)) return candidate;
  }
  return null;
}

function segmentCommand(from: Point, to: Point): string {
  return from.y === to.y ? `H ${to.x}` : `V ${to.y}`;
}

function roundedPathData(points: readonly Point[]): string {
  if (points.length === 0) return "";
  const commands = [`M ${points[0].x} ${points[0].y}`];
  let cursor = points[0];
  for (let index = 1; index < points.length - 1; index += 1) {
    const corner = points[index];
    const next = points[index + 1];
    const incoming = Math.abs(corner.x - cursor.x) + Math.abs(corner.y - cursor.y);
    const outgoing = Math.abs(next.x - corner.x) + Math.abs(next.y - corner.y);
    const radius = Math.min(6, incoming / 2, outgoing / 2);
    if (radius <= 0) continue;
    const before = {
      x: corner.x === cursor.x ? corner.x : corner.x + (cursor.x < corner.x ? -radius : radius),
      y: corner.y === cursor.y ? corner.y : corner.y + (cursor.y < corner.y ? -radius : radius),
    };
    const after = {
      x: next.x === corner.x ? corner.x : corner.x + (next.x > corner.x ? radius : -radius),
      y: next.y === corner.y ? corner.y : corner.y + (next.y > corner.y ? radius : -radius),
    };
    commands.push(segmentCommand(cursor, before));
    commands.push(`Q ${corner.x} ${corner.y} ${after.x} ${after.y}`);
    cursor = after;
  }
  commands.push(segmentCommand(cursor, points.at(-1)!));
  return commands.join(" ");
}

function emphasizedRelationshipIds(
  relationships: readonly CanvasSubtreeRelationship[],
  focusedPlacementId: string | null | undefined
): Set<string> {
  const emphasized = new Set<string>();
  if (!focusedPlacementId) return emphasized;
  const parentByChild = new Map(relationships.map((edge) => [edge.childPlacementId, edge] as const));
  const seen = new Set<string>();
  let current: string | undefined = focusedPlacementId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parentEdge = parentByChild.get(current);
    if (!parentEdge) break;
    emphasized.add(parentEdge.id);
    current = parentEdge.parentPlacementId;
  }
  for (const edge of relationships) {
    if (edge.parentPlacementId === focusedPlacementId) emphasized.add(edge.id);
  }
  return emphasized;
}

export function applyCanvasSubtreeStructureBranchPaths(
  refs: CanvasSubtreeStructurePathRefs,
  branches: readonly CanvasSubtreeStructureBranch[]
): void {
  const byId = new Map(branches.map((branch) => [branch.id, branch] as const));
  for (const [id, targets] of refs) {
    const branch = byId.get(id);
    targets.base?.setAttribute("d", branch?.path ?? "");
    targets.highlight?.setAttribute("d", branch?.highlightPath ?? "");
  }
}

export function deriveCanvasSubtreeStructureBranches(
  document: CanvasDocument,
  projection: CanvasSubtreeProjection,
  override: PositionOverride = null
): CanvasSubtreeStructureBranch[] {
  const byId = new Map(document.placements.map((placement) => [placement.placementId, placement] as const));
  const emphasized = emphasizedRelationshipIds(projection.relationships, document.focusedPlacementId);
  const visibleRects = projection.visiblePlacementIds.flatMap((placementId) => {
    const placement = byId.get(placementId);
    return placement?.kind === "node"
      ? [{ placementId, rect: inflateRect(placementRect(placement, override)) }]
      : [];
  });
  return projection.relationships.flatMap((relationship) => {
    const parent = byId.get(relationship.parentPlacementId);
    const child = byId.get(relationship.childPlacementId);
    if (!parent || !child) return [];
    const parentRect = placementRect(parent, override);
    const childRect = placementRect(child, override);
    const direction = centersDirection(parentRect, childRect);
    const start = anchor(parentRect, direction);
    const end = anchor(childRect, opposite(direction));
    const obstacles = visibleRects.flatMap(({ placementId, rect }) =>
      placementId === parent.placementId || placementId === child.placementId ? [] : [rect]
    );
    const routePoints = routeOrthogonal(start, end, direction, obstacles);
    if (!routePoints) return [];
    const path = roundedPathData(routePoints);
    return [{
      id: `branch:${relationship.id}`,
      parentPlacementId: parent.placementId,
      direction,
      path,
      highlightPath: emphasized.has(relationship.id) ? path : null,
      routePoints,
    }];
  });
}
