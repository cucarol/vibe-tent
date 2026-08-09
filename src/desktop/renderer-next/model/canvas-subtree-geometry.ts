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
};

type PositionOverride = { placementId: string; x: number; y: number } | null;
type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

export type CanvasStructureRouteDiagnostics = {
  segmentRectChecks: number;
};

const STRUCTURE_CLEARANCE = 12;

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

function pathScore(points: readonly Point[]): number {
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    distance += Math.abs(points[index].x - points[index - 1].x) +
      Math.abs(points[index].y - points[index - 1].y);
  }
  return distance + Math.max(0, points.length - 2) * 8;
}

function routeOrthogonal(
  start: Point,
  end: Point,
  obstacles: readonly Rect[],
  diagnostics?: CanvasStructureRouteDiagnostics
): Point[] | null {
  const direct = [
    normalizePoints([start, { x: end.x, y: start.y }, end]),
    normalizePoints([start, { x: start.x, y: end.y }, end]),
  ];
  for (const candidate of direct) {
    if (pathIsClear(candidate, obstacles, diagnostics)) return candidate;
  }

  const xLanes = new Set<number>([start.x, end.x]);
  const yLanes = new Set<number>([start.y, end.y]);
  for (const rect of obstacles) {
    xLanes.add(rect.x);
    xLanes.add(rect.x + rect.width);
    yLanes.add(rect.y);
    yLanes.add(rect.y + rect.height);
  }
  const detours = [
    ...[...yLanes].map((y) =>
      normalizePoints([start, { x: start.x, y }, { x: end.x, y }, end])
    ),
    ...[...xLanes].map((x) =>
      normalizePoints([start, { x, y: start.y }, { x, y: end.y }, end])
    ),
  ].filter((points) => points.length > 2);
  detours.sort((a, b) => pathScore(a) - pathScore(b) ||
    JSON.stringify(a).localeCompare(JSON.stringify(b)));
  for (const candidate of detours) {
    if (pathIsClear(candidate, obstacles, diagnostics)) return candidate;
  }
  return null;
}

function pathData(points: readonly Point[]): string {
  if (points.length === 0) return "";
  const commands = [`M ${points[0].x} ${points[0].y}`];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    commands.push(previous.y === point.y ? `H ${point.x}` : `V ${point.y}`);
  }
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

export function deriveCanvasSubtreeStructureBranches(
  document: CanvasDocument,
  projection: CanvasSubtreeProjection,
  override: PositionOverride = null,
  diagnostics?: CanvasStructureRouteDiagnostics
): CanvasSubtreeStructureBranch[] {
  if (projection.authority !== "fresh") return [];
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
  const grouped = new Map<string, {
    parent: CanvasPlacement;
    direction: SubtreeDirection;
    edges: { relationship: CanvasSubtreeRelationship; child: CanvasPlacement }[];
  }>();
  for (const relationship of projection.relationships) {
    const parent = byId.get(relationship.parentPlacementId);
    const child = byId.get(relationship.childPlacementId);
    if (!parent || !child) continue;
    const direction = centersDirection(
      placementRect(parent, override),
      placementRect(child, override)
    );
    const key = `${relationship.parentPlacementId}:${direction}`;
    const group = grouped.get(key) ?? { parent, direction, edges: [] };
    group.edges.push({ relationship, child });
    grouped.set(key, group);
  }
  return [...grouped.entries()].map(([key, group]) => {
    const parentRect = placementRect(group.parent, override);
    const parentPoint = anchor(parentRect, group.direction);
    const routed = group.edges.flatMap(({ relationship, child }) => {
      const childPoint = anchor(placementRect(child, override), opposite(group.direction));
      const obstacles = visibleNodeRects.flatMap((candidate) =>
        candidate.placementId === relationship.parentPlacementId ||
        candidate.placementId === relationship.childPlacementId
          ? []
          : [candidate.rect]
      );
      const points = routeOrthogonal(parentPoint, childPoint, obstacles, diagnostics);
      return points ? [{ relationship, path: pathData(points) }] : [];
    });
    const highlights = routed.flatMap(({ relationship, path }) =>
      emphasized.has(relationship.id) ? [path] : []
    );
    return {
      id: `branch:${key}`,
      parentPlacementId: group.parent.placementId,
      direction: group.direction,
      path: routed.map((edge) => edge.path).join(" "),
      highlightPath: highlights.length > 0 ? highlights.join(" ") : null,
    };
  }).filter((branch) => branch.path.length > 0);
}
