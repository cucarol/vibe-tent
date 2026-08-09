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
  routePoints: readonly { x: number; y: number }[];
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

export type CanvasStructureRouteDiagnostics = {
  segmentRectChecks: number;
  indexBuildRectChecks?: number;
  indexedIntervalChecks?: number;
  visibilityNodesExpanded?: number;
};

type CanvasStructureObstacle = { placementId: string; rect: Rect };
type CanvasStructureInterval = {
  min: number;
  max: number;
  placementId: string;
};
type CanvasStructureIntervalIndex = {
  intervals: readonly CanvasStructureInterval[];
  prefixMax: readonly number[];
};
type CanvasStructureObstacleGeometry = {
  obstacles: readonly CanvasStructureObstacle[];
  xLanes: readonly number[];
  yLanes: readonly number[];
  horizontalByY: Map<number, CanvasStructureIntervalIndex>;
  verticalByX: Map<number, CanvasStructureIntervalIndex>;
};

const STRUCTURE_CLEARANCE = 12;
const STRUCTURE_TRUNK = 18;

function placementRect(placement: CanvasPlacement, override: PositionOverride): Rect {
  const x = override?.placementId === placement.placementId ? override.x : placement.x ?? 0;
  const y = override?.placementId === placement.placementId ? override.y : placement.y ?? 0;
  return { x, y, width: NODE_CARD.width, height: NODE_CARD.height };
}

function centersDirection(parent: ReturnType<typeof placementRect>, child: ReturnType<typeof placementRect>): SubtreeDirection {
  const dx = child.x + child.width / 2 - (parent.x + parent.width / 2);
  const dy = child.y + child.height / 2 - (parent.y + parent.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "down" : "up";
}

function anchor(rect: ReturnType<typeof placementRect>, direction: SubtreeDirection): Point {
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

function trunkEnd(point: Point, direction: SubtreeDirection): Point {
  if (direction === "right") return { x: point.x + STRUCTURE_TRUNK, y: point.y };
  if (direction === "left") return { x: point.x - STRUCTURE_TRUNK, y: point.y };
  if (direction === "down") return { x: point.x, y: point.y + STRUCTURE_TRUNK };
  return { x: point.x, y: point.y - STRUCTURE_TRUNK };
}

function inflateRect(rect: Rect, clearance: number): Rect {
  return {
    x: rect.x - clearance,
    y: rect.y - clearance,
    width: rect.width + clearance * 2,
    height: rect.height + clearance * 2,
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
  obstacles: readonly Rect[],
  diagnostics?: CanvasStructureRouteDiagnostics
): boolean {
  for (let index = 1; index < points.length; index += 1) {
    for (const rect of obstacles) {
      if (diagnostics) diagnostics.segmentRectChecks += 1;
      if (segmentIntersectsRect(points[index - 1], points[index], rect)) return false;
    }
  }
  return true;
}

function collapseCollinear(points: readonly Point[]): Point[] {
  if (points.length <= 2) return [...points];
  const result = [points[0]];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = result.at(-1)!;
    const point = points[index];
    const next = points[index + 1];
    if ((previous.x === point.x && point.x === next.x) ||
      (previous.y === point.y && point.y === next.y)) continue;
    result.push(point);
  }
  result.push(points.at(-1)!);
  return result;
}

type OpenNode = { key: string; ix: number; iy: number; g: number; f: number };

function pushOpen(heap: OpenNode[], node: OpenNode): void {
  heap.push(node);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareOpen(heap[parent], heap[index]) <= 0) break;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function popOpen(heap: OpenNode[]): OpenNode | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  heap[0] = last;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let next = index;
    if (left < heap.length && compareOpen(heap[left], heap[next]) < 0) next = left;
    if (right < heap.length && compareOpen(heap[right], heap[next]) < 0) next = right;
    if (next === index) break;
    [heap[index], heap[next]] = [heap[next], heap[index]];
    index = next;
  }
  return first;
}

function compareOpen(a: OpenNode, b: OpenNode): number {
  return a.f - b.f || a.g - b.g || a.key.localeCompare(b.key);
}

function buildObstacleGeometry(obstacles: readonly CanvasStructureObstacle[]): CanvasStructureObstacleGeometry {
  const xLanes = new Set<number>();
  const yLanes = new Set<number>();
  for (const { rect } of obstacles) {
    xLanes.add(rect.x);
    xLanes.add(rect.x + rect.width);
    yLanes.add(rect.y);
    yLanes.add(rect.y + rect.height);
  }
  return {
    obstacles,
    xLanes: [...xLanes].sort((a, b) => a - b),
    yLanes: [...yLanes].sort((a, b) => a - b),
    horizontalByY: new Map(),
    verticalByX: new Map(),
  };
}

function buildIntervalIndex(intervals: CanvasStructureInterval[]): CanvasStructureIntervalIndex {
  intervals.sort((a, b) => a.min - b.min || a.max - b.max || a.placementId.localeCompare(b.placementId));
  const prefixMax: number[] = [];
  for (let index = 0; index < intervals.length; index += 1) {
    prefixMax[index] = Math.max(prefixMax[index - 1] ?? Number.NEGATIVE_INFINITY, intervals[index].max);
  }
  return { intervals, prefixMax };
}

function horizontalIndex(
  geometry: CanvasStructureObstacleGeometry,
  y: number,
  diagnostics?: CanvasStructureRouteDiagnostics
): CanvasStructureIntervalIndex {
  const cached = geometry.horizontalByY.get(y);
  if (cached) return cached;
  const intervals: CanvasStructureInterval[] = [];
  for (const obstacle of geometry.obstacles) {
    if (diagnostics) diagnostics.indexBuildRectChecks = (diagnostics.indexBuildRectChecks ?? 0) + 1;
    const { rect } = obstacle;
    if (y > rect.y && y < rect.y + rect.height) {
      intervals.push({ min: rect.x, max: rect.x + rect.width, placementId: obstacle.placementId });
    }
  }
  const index = buildIntervalIndex(intervals);
  geometry.horizontalByY.set(y, index);
  return index;
}

function verticalIndex(
  geometry: CanvasStructureObstacleGeometry,
  x: number,
  diagnostics?: CanvasStructureRouteDiagnostics
): CanvasStructureIntervalIndex {
  const cached = geometry.verticalByX.get(x);
  if (cached) return cached;
  const intervals: CanvasStructureInterval[] = [];
  for (const obstacle of geometry.obstacles) {
    if (diagnostics) diagnostics.indexBuildRectChecks = (diagnostics.indexBuildRectChecks ?? 0) + 1;
    const { rect } = obstacle;
    if (x > rect.x && x < rect.x + rect.width) {
      intervals.push({ min: rect.y, max: rect.y + rect.height, placementId: obstacle.placementId });
    }
  }
  const index = buildIntervalIndex(intervals);
  geometry.verticalByX.set(x, index);
  return index;
}

function firstGreater(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] > value) high = middle;
    else low = middle + 1;
  }
  return low;
}

function firstAtLeastByMin(intervals: readonly CanvasStructureInterval[], value: number): number {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (intervals[middle].min >= value) high = middle;
    else low = middle + 1;
  }
  return low;
}

function indexedRangeIsClear(
  index: CanvasStructureIntervalIndex,
  from: number,
  to: number,
  ignoredPlacementIds: ReadonlySet<string>,
  diagnostics?: CanvasStructureRouteDiagnostics
): boolean {
  const min = Math.min(from, to);
  const max = Math.max(from, to);
  const end = firstAtLeastByMin(index.intervals, max);
  const start = firstGreater(index.prefixMax, min);
  for (let cursor = start; cursor < end; cursor += 1) {
    if (diagnostics) diagnostics.indexedIntervalChecks = (diagnostics.indexedIntervalChecks ?? 0) + 1;
    const interval = index.intervals[cursor];
    if (!ignoredPlacementIds.has(interval.placementId) && interval.max > min) return false;
  }
  return true;
}

function indexedPointIsBlocked(
  point: Point,
  geometry: CanvasStructureObstacleGeometry,
  ignoredPlacementIds: ReadonlySet<string>,
  diagnostics?: CanvasStructureRouteDiagnostics
): boolean {
  return !indexedRangeIsClear(
    horizontalIndex(geometry, point.y, diagnostics),
    point.x,
    point.x,
    ignoredPlacementIds,
    diagnostics
  );
}

function indexedSegmentIsClear(
  a: Point,
  b: Point,
  geometry: CanvasStructureObstacleGeometry,
  ignoredPlacementIds: ReadonlySet<string>,
  diagnostics?: CanvasStructureRouteDiagnostics
): boolean {
  if (a.y === b.y) {
    return indexedRangeIsClear(
      horizontalIndex(geometry, a.y, diagnostics),
      a.x,
      b.x,
      ignoredPlacementIds,
      diagnostics
    );
  }
  if (a.x === b.x) {
    return indexedRangeIsClear(
      verticalIndex(geometry, a.x, diagnostics),
      a.y,
      b.y,
      ignoredPlacementIds,
      diagnostics
    );
  }
  return false;
}

function routeVisibilityGrid(
  start: Point,
  end: Point,
  geometry: CanvasStructureObstacleGeometry,
  ignoredPlacementIds: ReadonlySet<string>,
  diagnostics?: CanvasStructureRouteDiagnostics
): Point[] | null {
  const xs = [...new Set([...geometry.xLanes, start.x, end.x])].sort((a, b) => a - b);
  const ys = [...new Set([...geometry.yLanes, start.y, end.y])].sort((a, b) => a - b);
  const startIx = xs.indexOf(start.x);
  const startIy = ys.indexOf(start.y);
  const endIx = xs.indexOf(end.x);
  const endIy = ys.indexOf(end.y);
  if (startIx < 0 || startIy < 0 || endIx < 0 || endIy < 0 ||
    indexedPointIsBlocked(start, geometry, ignoredPlacementIds, diagnostics) ||
    indexedPointIsBlocked(end, geometry, ignoredPlacementIds, diagnostics)) return null;

  const keyFor = (ix: number, iy: number) => `${ix}:${iy}`;
  const startKey = keyFor(startIx, startIy);
  const endKey = keyFor(endIx, endIy);
  const open: OpenNode[] = [];
  const best = new Map<string, number>([[startKey, 0]]);
  const previous = new Map<string, string>();
  pushOpen(open, {
    key: startKey,
    ix: startIx,
    iy: startIy,
    g: 0,
    f: Math.abs(end.x - start.x) + Math.abs(end.y - start.y),
  });
  const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
  while (open.length > 0) {
    const current = popOpen(open)!;
    if (current.g !== best.get(current.key)) continue;
    if (diagnostics) diagnostics.visibilityNodesExpanded =
      (diagnostics.visibilityNodesExpanded ?? 0) + 1;
    if (current.key === endKey) {
      const reversed: Point[] = [];
      let key: string | undefined = endKey;
      while (key) {
        const [ix, iy] = key.split(":").map(Number);
        reversed.push({ x: xs[ix], y: ys[iy] });
        key = previous.get(key);
      }
      return collapseCollinear(reversed.reverse());
    }
    const currentPoint = { x: xs[current.ix], y: ys[current.iy] };
    for (const [dx, dy] of directions) {
      const ix = current.ix + dx;
      const iy = current.iy + dy;
      if (ix < 0 || iy < 0 || ix >= xs.length || iy >= ys.length) continue;
      const point = { x: xs[ix], y: ys[iy] };
      if (indexedPointIsBlocked(point, geometry, ignoredPlacementIds, diagnostics) ||
        !indexedSegmentIsClear(currentPoint, point, geometry, ignoredPlacementIds, diagnostics)) continue;
      const key = keyFor(ix, iy);
      const g = current.g + Math.abs(point.x - currentPoint.x) + Math.abs(point.y - currentPoint.y);
      if (g >= (best.get(key) ?? Number.POSITIVE_INFINITY)) continue;
      best.set(key, g);
      previous.set(key, current.key);
      pushOpen(open, {
        key,
        ix,
        iy,
        g,
        f: g + Math.abs(end.x - point.x) + Math.abs(end.y - point.y),
      });
    }
  }
  return null;
}

function routeOrthogonal(
  start: Point,
  end: Point,
  obstacles: readonly Rect[],
  geometry: CanvasStructureObstacleGeometry,
  ignoredPlacementIds: ReadonlySet<string>,
  diagnostics?: CanvasStructureRouteDiagnostics
): Point[] | null {
  const direct = [
    normalizePoints([start, { x: end.x, y: start.y }, end]),
    normalizePoints([start, { x: start.x, y: end.y }, end]),
  ];
  for (const candidate of direct) {
    if (pathIsClear(candidate, obstacles, diagnostics)) return candidate;
  }
  return routeVisibilityGrid(start, end, geometry, ignoredPlacementIds, diagnostics);
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
    const radius = Math.min(7, incoming / 2, outgoing / 2);
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
  override: PositionOverride = null,
  diagnostics?: CanvasStructureRouteDiagnostics
): CanvasSubtreeStructureBranch[] {
  const byId = new Map(document.placements.map((placement) => [placement.placementId, placement] as const));
  const emphasized = emphasizedRelationshipIds(
    projection.relationships,
    document.focusedPlacementId
  );
  const visibleNodeRects = projection.visiblePlacementIds.flatMap((placementId) => {
    const placement = byId.get(placementId);
    return placement?.kind === "node"
      ? [{ placementId, rect: inflateRect(placementRect(placement, override), STRUCTURE_CLEARANCE) }]
      : [];
  });
  const obstacleGeometry = buildObstacleGeometry(visibleNodeRects);
  return projection.relationships.flatMap((relationship) => {
    const parent = byId.get(relationship.parentPlacementId);
    const child = byId.get(relationship.childPlacementId);
    if (!parent || !child) return [];
    const direction = centersDirection(
      placementRect(parent, override),
      placementRect(child, override)
    );
    const parentPoint = anchor(placementRect(parent, override), direction);
    const branchPoint = trunkEnd(parentPoint, direction);
    const childPoint = anchor(placementRect(child, override), opposite(direction));
    const ignoredPlacementIds = new Set([
      relationship.parentPlacementId,
      relationship.childPlacementId,
    ]);
    const obstacles = visibleNodeRects.flatMap((candidate) =>
      ignoredPlacementIds.has(candidate.placementId) ? [] : [candidate.rect]
    );
    const points = routeOrthogonal(
      branchPoint,
      childPoint,
      obstacles,
      obstacleGeometry,
      ignoredPlacementIds,
      diagnostics
    );
    if (!points) return [];
    const routePoints = [parentPoint, ...points];
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
