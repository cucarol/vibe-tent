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

function placementRect(placement: CanvasPlacement, override: PositionOverride) {
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

function edgePath(parent: Point, child: Point, direction: SubtreeDirection, bus: number): string {
  if (direction === "right" || direction === "left") {
    return `M ${parent.x} ${parent.y} H ${bus} V ${child.y} H ${child.x}`;
  }
  return `M ${parent.x} ${parent.y} V ${bus} H ${child.x} V ${child.y}`;
}

function branchPath(parent: Point, children: readonly Point[], direction: SubtreeDirection, bus: number): string {
  if (direction === "right" || direction === "left") {
    const ys = children.map((point) => point.y);
    return [
      `M ${parent.x} ${parent.y} H ${bus}`,
      `M ${bus} ${Math.min(parent.y, ...ys)} V ${Math.max(parent.y, ...ys)}`,
      ...children.map((point) => `M ${bus} ${point.y} H ${point.x}`),
    ].join(" ");
  }
  const xs = children.map((point) => point.x);
  return [
    `M ${parent.x} ${parent.y} V ${bus}`,
    `M ${Math.min(parent.x, ...xs)} ${bus} H ${Math.max(parent.x, ...xs)}`,
    ...children.map((point) => `M ${point.x} ${bus} V ${point.y}`),
  ].join(" ");
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
  override: PositionOverride = null
): CanvasSubtreeStructureBranch[] {
  if (projection.authority !== "fresh") return [];
  const byId = new Map(document.placements.map((placement) => [placement.placementId, placement] as const));
  const emphasized = emphasizedRelationshipIds(
    projection.relationships,
    document.focusedPlacementId
  );
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
    const childPoints = group.edges.map(({ child }) =>
      anchor(placementRect(child, override), opposite(group.direction))
    );
    const gap = 28;
    const nearest = group.direction === "right"
      ? Math.min(...childPoints.map((point) => point.x))
      : group.direction === "left"
        ? Math.max(...childPoints.map((point) => point.x))
        : group.direction === "down"
          ? Math.min(...childPoints.map((point) => point.y))
          : Math.max(...childPoints.map((point) => point.y));
    const bus = group.direction === "right"
      ? Math.min(parentPoint.x + gap, (parentPoint.x + nearest) / 2)
      : group.direction === "left"
        ? Math.max(parentPoint.x - gap, (parentPoint.x + nearest) / 2)
        : group.direction === "down"
          ? Math.min(parentPoint.y + gap, (parentPoint.y + nearest) / 2)
          : Math.max(parentPoint.y - gap, (parentPoint.y + nearest) / 2);
    const highlights = group.edges.flatMap(({ relationship }, index) =>
      emphasized.has(relationship.id)
        ? [edgePath(parentPoint, childPoints[index], group.direction, bus)]
        : []
    );
    return {
      id: `branch:${key}`,
      parentPlacementId: group.parent.placementId,
      direction: group.direction,
      path: branchPath(parentPoint, childPoints, group.direction, bus),
      highlightPath: highlights.length > 0 ? highlights.join(" ") : null,
    };
  });
}
