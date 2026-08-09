import type { CanvasDocument, CanvasPlacement } from "../types/identity.js";
import { NODE_CARD, newPlacementId } from "./canvas-document.js";
import {
  type CanvasNodeSnapshot,
  deriveCanvasPlacementSourceState,
  withCanvasNodeSnapshot,
} from "./canvas-node-snapshot.js";

export const CANVAS_SUBTREE_META_KEY = "tentSubtreeProjection";

export type SubtreeDirection = "up" | "right" | "down" | "left";

export type CanvasSubtreePlacementMeta = {
  version: 1;
  instanceId: string;
  rootPlacementId: string;
  parentPlacementId: string | null;
  depth: number;
  siblingOrder: number;
  expandedDirection: SubtreeDirection | null;
  lastDirection: SubtreeDirection;
};

export type CanvasSubtreeNodeSource = {
  nodeId: string;
  parentNodeId: string | null;
  snapshot: CanvasNodeSnapshot & { etag: string };
};

export type CanvasSubtreeHierarchy = {
  parentNodeId: string;
  childNodeId: string;
};

export type CanvasSubtreeRelationship = {
  id: string;
  instanceId: string;
  parentPlacementId: string;
  childPlacementId: string;
};

export type CanvasSubtreeControl = {
  placementId: string;
  projectedDirectChildCount: number;
  unprojectedDirectChildCount: number;
  expandedDirection: SubtreeDirection | null;
  lastDirection: SubtreeDirection;
  canMutate: boolean;
};

export type CanvasProjectionSyncControl = {
  placementId: string;
  scope: "standalone" | "subtree";
  affectedCount: number;
  canSync: boolean;
};

export type CanvasProjectionPlacementState = {
  placementId: string;
  state: "current" | "pending-sync" | "unknown";
};

export type CanvasSubtreeProjection = {
  authority: "fresh" | "unknown";
  visiblePlacementIds: readonly string[];
  relationships: readonly CanvasSubtreeRelationship[];
  controls: readonly CanvasSubtreeControl[];
  placementStates: readonly CanvasProjectionPlacementState[];
  syncControls: readonly CanvasProjectionSyncControl[];
};

const DIRECTIONS = new Set<SubtreeDirection>(["up", "right", "down", "left"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readCanvasSubtreePlacementMeta(
  placement: Pick<CanvasPlacement, "meta">
): CanvasSubtreePlacementMeta | null {
  const raw = placement.meta?.[CANVAS_SUBTREE_META_KEY];
  if (!isRecord(raw)) return null;
  const expandedDirection = raw.expandedDirection;
  if (
    raw.version !== 1 ||
    typeof raw.instanceId !== "string" ||
    !raw.instanceId ||
    typeof raw.rootPlacementId !== "string" ||
    !raw.rootPlacementId ||
    !(raw.parentPlacementId === null || typeof raw.parentPlacementId === "string") ||
    !Number.isInteger(raw.depth) ||
    (raw.depth as number) < 0 ||
    !Number.isInteger(raw.siblingOrder) ||
    (raw.siblingOrder as number) < 0 ||
    !(expandedDirection === null || DIRECTIONS.has(expandedDirection as SubtreeDirection)) ||
    !DIRECTIONS.has(raw.lastDirection as SubtreeDirection)
  ) return null;
  return {
    version: 1,
    instanceId: raw.instanceId,
    rootPlacementId: raw.rootPlacementId,
    parentPlacementId: raw.parentPlacementId as string | null,
    depth: raw.depth as number,
    siblingOrder: raw.siblingOrder as number,
    expandedDirection: expandedDirection as SubtreeDirection | null,
    lastDirection: raw.lastDirection as SubtreeDirection,
  };
}

export function withCanvasSubtreePlacementMeta(
  placement: CanvasPlacement,
  subtree: CanvasSubtreePlacementMeta
): CanvasPlacement {
  return {
    ...placement,
    meta: {
      ...(placement.meta ?? {}),
      [CANVAS_SUBTREE_META_KEY]: subtree,
    },
  };
}

export function withoutCanvasSubtreePlacementMeta(
  placement: CanvasPlacement
): CanvasPlacement {
  if (!placement.meta || !(CANVAS_SUBTREE_META_KEY in placement.meta)) return placement;
  const nextMeta = { ...placement.meta };
  delete nextMeta[CANVAS_SUBTREE_META_KEY];
  return { ...placement, meta: nextMeta };
}

function childrenByParent<T extends { nodeId: string; parentNodeId: string | null }>(
  sources: readonly T[]
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const source of sources) {
    if (!source.parentNodeId) continue;
    const children = map.get(source.parentNodeId) ?? [];
    children.push(source);
    map.set(source.parentNodeId, children);
  }
  return map;
}

function childPosition(
  parent: { x: number; y: number },
  direction: SubtreeDirection,
  index: number,
  count: number
): { x: number; y: number } {
  const branchGap = 76;
  const siblingGap = 28;
  const offset = (index - (count - 1) / 2) * (direction === "left" || direction === "right"
    ? NODE_CARD.height + siblingGap
    : NODE_CARD.width + siblingGap);
  if (direction === "right") {
    return { x: parent.x + NODE_CARD.width + branchGap, y: parent.y + offset };
  }
  if (direction === "left") {
    return { x: parent.x - NODE_CARD.width - branchGap, y: parent.y + offset };
  }
  if (direction === "down") {
    return { x: parent.x + offset, y: parent.y + NODE_CARD.height + branchGap };
  }
  return { x: parent.x + offset, y: parent.y - NODE_CARD.height - branchGap };
}

export function createCanvasSubtreeProjectionInstance(
  document: CanvasDocument,
  rootNodeId: string,
  sources: readonly CanvasSubtreeNodeSource[],
  point: { x: number; y: number },
  direction: SubtreeDirection = "right",
  createInstanceId: () => string = () => newPlacementId("subtree"),
  createPlacementId: () => string = () => newPlacementId("pl-node")
): { document: CanvasDocument; rootPlacementId: string; instanceId: string } {
  const byId = new Map(sources.map((source) => [source.nodeId, source] as const));
  const root = byId.get(rootNodeId);
  if (!root) throw new Error(`Missing subtree root source: ${rootNodeId}`);
  const children = childrenByParent(sources);
  const instanceId = createInstanceId();
  const rootPlacementId = createPlacementId();
  const placements: CanvasPlacement[] = [];
  const seen = new Set<string>();

  const append = (
    source: CanvasSubtreeNodeSource,
    placementId: string,
    parentPlacementId: string | null,
    depth: number,
    siblingOrder: number,
    position: { x: number; y: number }
  ) => {
    if (seen.has(source.nodeId)) return;
    seen.add(source.nodeId);
    const directChildren = children.get(source.nodeId) ?? [];
    const subtree = {
      version: 1,
      instanceId,
      rootPlacementId,
      parentPlacementId,
      depth,
      siblingOrder,
      expandedDirection: depth === 0 && directChildren.length > 0 ? direction : null,
      lastDirection: direction,
    } satisfies CanvasSubtreePlacementMeta;
    placements.push(withCanvasSubtreePlacementMeta(withCanvasNodeSnapshot({
      placementId,
      entityRef: source.nodeId,
      kind: "node",
      x: position.x,
      y: position.y,
      width: NODE_CARD.width,
      height: NODE_CARD.height,
    }, source.snapshot), subtree));
    directChildren.forEach((child, index) => {
      const childPlacementId = createPlacementId();
      append(
        child,
        childPlacementId,
        placementId,
        depth + 1,
        index,
        childPosition(position, direction, index, directChildren.length)
      );
    });
  };
  append(root, rootPlacementId, null, 0, 0, point);
  return {
    instanceId,
    rootPlacementId,
    document: {
      ...document,
      placements: [...document.placements, ...placements],
      focusedPlacementId: rootPlacementId,
    },
  };
}

type ValidMember = {
  placement: CanvasPlacement;
  meta: CanvasSubtreePlacementMeta;
};

function validSubtreeMembers(document: CanvasDocument): Map<string, ValidMember> {
  const candidates = new Map<string, ValidMember>();
  for (const placement of document.placements) {
    const meta = readCanvasSubtreePlacementMeta(placement);
    if (meta) candidates.set(placement.placementId, { placement, meta });
  }
  const valid = new Map<string, ValidMember>();
  const resolving = new Set<string>();
  const resolve = (placementId: string): boolean => {
    if (valid.has(placementId)) return true;
    const member = candidates.get(placementId);
    if (!member || resolving.has(placementId)) return false;
    resolving.add(placementId);
    const { meta } = member;
    let ok = false;
    if (meta.parentPlacementId === null) {
      ok = meta.depth === 0 && meta.rootPlacementId === placementId;
    } else {
      const parent = candidates.get(meta.parentPlacementId);
      ok = Boolean(
        parent &&
        parent.meta.instanceId === meta.instanceId &&
        parent.meta.rootPlacementId === meta.rootPlacementId &&
        meta.depth === parent.meta.depth + 1 &&
        resolve(parent.placement.placementId)
      );
    }
    resolving.delete(placementId);
    if (ok) valid.set(placementId, member);
    return ok;
  };
  for (const placementId of candidates.keys()) resolve(placementId);
  return valid;
}

function visiblePlacementIds(
  document: CanvasDocument,
  valid: ReadonlyMap<string, ValidMember>
): Set<string> {
  const visible = new Set<string>();
  for (const placement of document.placements) {
    const member = valid.get(placement.placementId);
    if (!member) {
      visible.add(placement.placementId);
      continue;
    }
    let current = member;
    const seen = new Set<string>();
    let isVisible = true;
    while (current.meta.parentPlacementId) {
      if (seen.has(current.placement.placementId)) {
        isVisible = false;
        break;
      }
      seen.add(current.placement.placementId);
      const parent = valid.get(current.meta.parentPlacementId);
      if (!parent || parent.meta.expandedDirection === null) {
        isVisible = false;
        break;
      }
      current = parent;
    }
    if (isVisible) visible.add(placement.placementId);
  }
  return visible;
}

export function deriveCanvasSubtreeProjection(
  document: CanvasDocument,
  sources: readonly CanvasSubtreeNodeSource[] | null
): CanvasSubtreeProjection {
  const authority = sources ? "fresh" : "unknown";
  const valid = validSubtreeMembers(document);
  const visible = visiblePlacementIds(document, valid);
  if (!sources) {
    return {
      authority,
      visiblePlacementIds: [...visible],
      relationships: [],
      controls: [],
      placementStates: document.placements
        .filter((placement) => placement.kind === "node")
        .map((placement) => ({ placementId: placement.placementId, state: "unknown" })),
      syncControls: [],
    };
  }
  const hierarchy: CanvasSubtreeHierarchy[] = sources.flatMap((source) =>
    source.parentNodeId
      ? [{ parentNodeId: source.parentNodeId, childNodeId: source.nodeId }]
      : []
  );
  const sourceById = new Map(sources.map((source) => [source.nodeId, source] as const));
  const authoritativeParentByChild = new Map(
    hierarchy.map((edge) => [edge.childNodeId, edge.parentNodeId] as const)
  );
  const authoritativeChildrenByParent = new Map<string, string[]>();
  for (const edge of hierarchy) {
    const children = authoritativeChildrenByParent.get(edge.parentNodeId) ?? [];
    children.push(edge.childNodeId);
    authoritativeChildrenByParent.set(edge.parentNodeId, children);
  }
  const relationships: CanvasSubtreeRelationship[] = [];
  const childrenByPlacement = new Map<string, ValidMember[]>();
  for (const member of valid.values()) {
    if (!member.meta.parentPlacementId) continue;
    const children = childrenByPlacement.get(member.meta.parentPlacementId) ?? [];
    children.push(member);
    childrenByPlacement.set(member.meta.parentPlacementId, children);
    const parent = valid.get(member.meta.parentPlacementId);
    if (
      !parent ||
      !visible.has(parent.placement.placementId) ||
      !visible.has(member.placement.placementId) ||
      !parent.placement.entityRef ||
      !member.placement.entityRef ||
      authoritativeParentByChild.get(member.placement.entityRef) !== parent.placement.entityRef
    ) continue;
    relationships.push({
      id: `subtree:${member.meta.instanceId}:${parent.placement.placementId}->${member.placement.placementId}`,
      instanceId: member.meta.instanceId,
      parentPlacementId: parent.placement.placementId,
      childPlacementId: member.placement.placementId,
    });
  }
  const controls: CanvasSubtreeControl[] = [];
  for (const member of valid.values()) {
    if (!visible.has(member.placement.placementId) || !member.placement.entityRef) continue;
    const projectedChildren = (childrenByPlacement.get(member.placement.placementId) ?? [])
      .filter((child) =>
        child.placement.entityRef &&
        authoritativeParentByChild.get(child.placement.entityRef) === member.placement.entityRef
      );
    const authoritativeChildren = authoritativeChildrenByParent.get(member.placement.entityRef) ?? [];
    if (projectedChildren.length === 0 && authoritativeChildren.length === 0) continue;
    const projectedEntityIds = new Set(projectedChildren.map((child) => child.placement.entityRef));
    controls.push({
      placementId: member.placement.placementId,
      projectedDirectChildCount: projectedChildren.length,
      unprojectedDirectChildCount: authoritativeChildren.filter((id) => !projectedEntityIds.has(id)).length,
      expandedDirection: member.meta.expandedDirection,
      lastDirection: member.meta.lastDirection,
      canMutate: projectedChildren.length > 0,
    });
  }
  const placementStates = new Map<string, CanvasProjectionPlacementState["state"]>();
  for (const placement of document.placements) {
    if (placement.kind !== "node" || !placement.entityRef) continue;
    const source = sourceById.get(placement.entityRef);
    const state = deriveCanvasPlacementSourceState({
      placement,
      authority: "fresh",
      source: source
        ? {
          nodeId: source.nodeId,
          etag: source.snapshot.etag,
          name: source.snapshot.name,
          ...(source.snapshot.title ? { title: source.snapshot.title } : {}),
          path: source.snapshot.path,
          type: source.snapshot.type,
          tags: source.snapshot.tags,
          mode: source.snapshot.mode,
          archived: source.snapshot.archived,
          invalid: source.snapshot.invalid,
        }
        : null,
    });
    placementStates.set(
      placement.placementId,
      state.state === "current" ? "current" : "pending-sync"
    );
  }
  const syncControls: CanvasProjectionSyncControl[] = [];
  const membersByInstance = new Map<string, ValidMember[]>();
  for (const member of valid.values()) {
    const members = membersByInstance.get(member.meta.instanceId) ?? [];
    members.push(member);
    membersByInstance.set(member.meta.instanceId, members);
  }
  for (const members of membersByInstance.values()) {
    const root = members.find((member) => member.meta.parentPlacementId === null);
    if (!root || !root.placement.entityRef) continue;
    const memberByNodeId = new Map(
      members.flatMap((member) => member.placement.entityRef
        ? [[member.placement.entityRef, member] as const]
        : [])
    );
    const expected = new Set<string>();
    const queue = [root.placement.entityRef];
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (expected.has(nodeId) || !sourceById.has(nodeId)) continue;
      expected.add(nodeId);
      queue.push(...(authoritativeChildrenByParent.get(nodeId) ?? []));
    }
    const affected = new Set<string>();
    for (const member of members) {
      const nodeId = member.placement.entityRef;
      if (!nodeId || !expected.has(nodeId)) {
        affected.add(member.placement.placementId);
        continue;
      }
      if (member.meta.parentPlacementId !== null) {
        const expectedParentNodeId = authoritativeParentByChild.get(nodeId) ?? null;
        const actualParentNodeId = valid.get(member.meta.parentPlacementId)?.placement.entityRef ?? null;
        if (expectedParentNodeId !== actualParentNodeId) {
          affected.add(member.placement.placementId);
        }
      }
      if (placementStates.get(member.placement.placementId) !== "current") {
        affected.add(member.placement.placementId);
      }
    }
    for (const nodeId of expected) {
      if (!memberByNodeId.has(nodeId)) affected.add(`missing:${nodeId}`);
    }
    if (affected.size > 0) {
      placementStates.set(root.placement.placementId, "pending-sync");
      syncControls.push({
        placementId: root.placement.placementId,
        scope: "subtree",
        affectedCount: affected.size,
        canSync: true,
      });
    }
  }
  for (const placement of document.placements) {
    if (placement.kind !== "node" || valid.has(placement.placementId)) continue;
    if (placementStates.get(placement.placementId) !== "pending-sync") continue;
    syncControls.push({
      placementId: placement.placementId,
      scope: "standalone",
      affectedCount: 1,
      canSync: true,
    });
  }
  return {
    authority,
    visiblePlacementIds: [...visible],
    relationships,
    controls,
    placementStates: [...placementStates].map(([placementId, state]) => ({ placementId, state })),
    syncControls,
  };
}

function sourceSnapshot(source: CanvasSubtreeNodeSource): CanvasNodeSnapshot {
  return source.snapshot;
}

export function reconcileCanvasProjectionSync(
  document: CanvasDocument,
  controlPlacementId: string,
  sources: readonly CanvasSubtreeNodeSource[] | null,
  createPlacementId: () => string = () => newPlacementId("pl-node")
): CanvasDocument {
  if (!sources) return document;
  const sourceById = new Map(sources.map((source) => [source.nodeId, source] as const));
  const children = childrenByParent(sources);
  const valid = validSubtreeMembers(document);
  const controlMember = valid.get(controlPlacementId);
  if (!controlMember) {
    const placement = document.placements.find((candidate) => candidate.placementId === controlPlacementId);
    if (!placement?.entityRef) return document;
    const source = sourceById.get(placement.entityRef);
    return source
      ? {
        ...document,
        placements: document.placements.map((candidate) =>
          candidate.placementId === controlPlacementId
            ? withCanvasNodeSnapshot(candidate, sourceSnapshot(source))
            : candidate
        ),
      }
      : {
        ...document,
        placements: document.placements.filter((candidate) => candidate.placementId !== controlPlacementId),
        focusedPlacementId: document.focusedPlacementId === controlPlacementId
          ? null
          : document.focusedPlacementId,
      };
  }
  const root = valid.get(controlMember.meta.rootPlacementId);
  if (!root?.placement.entityRef) return document;
  const instanceId = root.meta.instanceId;
  const members = [...valid.values()].filter((member) => member.meta.instanceId === instanceId);
  const memberByNodeId = new Map(
    members.flatMap((member) => member.placement.entityRef
      ? [[member.placement.entityRef, member] as const]
      : [])
  );
  const rootSource = sourceById.get(root.placement.entityRef);
  if (!rootSource) {
    const removedIds = new Set(members.map((member) => member.placement.placementId));
    return {
      ...document,
      placements: document.placements.filter((placement) => !removedIds.has(placement.placementId)),
      focusedPlacementId: document.focusedPlacementId && removedIds.has(document.focusedPlacementId)
        ? null
        : document.focusedPlacementId,
    };
  }
  const expected: CanvasSubtreeNodeSource[] = [];
  const queue: { source: CanvasSubtreeNodeSource; parentNodeId: string | null; depth: number; siblingOrder: number }[] = [
    { source: rootSource, parentNodeId: null, depth: 0, siblingOrder: 0 },
  ];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (seen.has(entry.source.nodeId)) continue;
    seen.add(entry.source.nodeId);
    expected.push(entry.source);
    (children.get(entry.source.nodeId) ?? []).forEach((child, siblingOrder) => {
      queue.push({ source: child, parentNodeId: entry.source.nodeId, depth: entry.depth + 1, siblingOrder });
    });
  }
  const expectedIds = new Set(expected.map((source) => source.nodeId));
  const nextByNodeId = new Map<string, CanvasPlacement>();
  const nextPlacements = document.placements.filter((placement) => {
    const member = valid.get(placement.placementId);
    if (!member || member.meta.instanceId !== instanceId) return true;
    if (!placement.entityRef || !expectedIds.has(placement.entityRef)) return false;
    nextByNodeId.set(placement.entityRef, placement);
    return false;
  });
  const depthByNodeId = new Map<string, number>([[rootSource.nodeId, 0]]);
  const visit = (source: CanvasSubtreeNodeSource, parentNodeId: string | null, siblingOrder: number) => {
    const parentPlacement = parentNodeId ? nextByNodeId.get(parentNodeId) : null;
    const parentMeta = parentPlacement ? readCanvasSubtreePlacementMeta(parentPlacement) : null;
    const existing = memberByNodeId.get(source.nodeId)?.placement;
    const placementId = existing?.placementId ?? createPlacementId();
    const direction = parentMeta?.expandedDirection ?? parentMeta?.lastDirection ?? root.meta.lastDirection;
    const siblingCount = parentNodeId ? (children.get(parentNodeId) ?? []).length : 1;
    const position = existing
      ? { x: existing.x ?? 0, y: existing.y ?? 0 }
      : parentPlacement
        ? childPosition(
          { x: parentPlacement.x ?? 0, y: parentPlacement.y ?? 0 },
          direction,
          siblingOrder,
          siblingCount
        )
        : { x: root.placement.x ?? 0, y: root.placement.y ?? 0 };
    const depth = parentNodeId ? (depthByNodeId.get(parentNodeId) ?? 0) + 1 : 0;
    depthByNodeId.set(source.nodeId, depth);
    const meta: CanvasSubtreePlacementMeta = existing
      ? {
        ...(readCanvasSubtreePlacementMeta(existing) ?? root.meta),
        instanceId,
        rootPlacementId: root.placement.placementId,
        parentPlacementId: parentPlacement?.placementId ?? null,
        depth,
        siblingOrder,
      }
      : {
        version: 1,
        instanceId,
        rootPlacementId: root.placement.placementId,
        parentPlacementId: parentPlacement?.placementId ?? null,
        depth,
        siblingOrder,
        expandedDirection: null,
        lastDirection: direction,
      };
    const placement = withCanvasSubtreePlacementMeta(withCanvasNodeSnapshot({
      ...(existing ?? {}),
      placementId,
      entityRef: source.nodeId,
      kind: "node",
      x: position.x,
      y: position.y,
      width: NODE_CARD.width,
      height: NODE_CARD.height,
    }, sourceSnapshot(source)), meta);
    nextByNodeId.set(source.nodeId, placement);
    (children.get(source.nodeId) ?? []).forEach((child, index) => visit(child, source.nodeId, index));
  };
  visit(rootSource, null, 0);
  const orderedMembers = expected.flatMap((source) => {
    const placement = nextByNodeId.get(source.nodeId);
    return placement ? [placement] : [];
  });
  const retainedIds = new Set(orderedMembers.map((placement) => placement.placementId));
  return {
    ...document,
    placements: [...nextPlacements, ...orderedMembers],
    focusedPlacementId: document.focusedPlacementId && !retainedIds.has(document.focusedPlacementId) &&
      members.some((member) => member.placement.placementId === document.focusedPlacementId)
      ? root.placement.placementId
      : document.focusedPlacementId,
  };
}

function subtreeDescendantPlacementIds(
  valid: ReadonlyMap<string, ValidMember>,
  parentPlacementId: string
): Set<string> {
  const descendants = new Set<string>();
  const queue = [parentPlacementId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const member of valid.values()) {
      if (member.meta.parentPlacementId !== parentId || descendants.has(member.placement.placementId)) continue;
      descendants.add(member.placement.placementId);
      queue.push(member.placement.placementId);
    }
  }
  return descendants;
}

export function toggleCanvasSubtreeBranch(
  document: CanvasDocument,
  placementId: string,
  direction: SubtreeDirection
): CanvasDocument {
  const valid = validSubtreeMembers(document);
  const root = valid.get(placementId);
  if (!root) return document;
  const descendants = subtreeDescendantPlacementIds(valid, placementId);
  if (descendants.size === 0) return document;
  const collapse = root.meta.expandedDirection !== null;
  const relayout = !collapse && direction !== root.meta.lastDirection;
  const nextPositions = new Map<string, { x: number; y: number }>();
  if (relayout) {
    const layout = (parentId: string) => {
      const parent = valid.get(parentId);
      if (!parent) return;
      const children = [...valid.values()]
        .filter((member) => member.meta.parentPlacementId === parentId)
        .sort((a, b) => a.meta.siblingOrder - b.meta.siblingOrder);
      children.forEach((child, index) => {
        const parentPosition = nextPositions.get(parentId) ?? {
          x: parent.placement.x ?? 0,
          y: parent.placement.y ?? 0,
        };
        nextPositions.set(
          child.placement.placementId,
          childPosition(parentPosition, direction, index, children.length)
        );
        layout(child.placement.placementId);
      });
    };
    layout(placementId);
  }
  const nextPlacements = document.placements.map((placement) => {
    const member = valid.get(placement.placementId);
    if (!member) return placement;
    let next = placement;
    if (placement.placementId === placementId) {
      next = withCanvasSubtreePlacementMeta(next, {
        ...member.meta,
        expandedDirection: collapse ? null : direction,
        lastDirection: collapse ? member.meta.lastDirection : direction,
      });
    } else if (relayout && descendants.has(placement.placementId)) {
      const position = nextPositions.get(placement.placementId);
      next = withCanvasSubtreePlacementMeta(
        position ? { ...next, ...position } : next,
        {
          ...member.meta,
          expandedDirection: member.meta.expandedDirection === null ? null : direction,
          lastDirection: direction,
        }
      );
    }
    return next;
  });
  const focusedPlacementId = collapse && document.focusedPlacementId && descendants.has(document.focusedPlacementId)
    ? placementId
    : document.focusedPlacementId;
  return { ...document, placements: nextPlacements, focusedPlacementId };
}

/**
 * A collapsed branch is a local spatial group: moving its visible root shifts
 * only the hidden descendants by the same delta. Expanded members remain
 * independently movable and never snap back.
 */
export function carryCollapsedSubtreeDescendants(
  previous: CanvasDocument,
  next: CanvasDocument
): CanvasDocument {
  const previousById = new Map(previous.placements.map((placement) => [placement.placementId, placement] as const));
  const valid = validSubtreeMembers(previous);
  const deltas = new Map<string, { x: number; y: number }>();
  for (const placement of next.placements) {
    const before = previousById.get(placement.placementId);
    const member = valid.get(placement.placementId);
    if (!before || !member || member.meta.expandedDirection !== null) continue;
    const dx = (placement.x ?? 0) - (before.x ?? 0);
    const dy = (placement.y ?? 0) - (before.y ?? 0);
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) continue;
    for (const descendantId of subtreeDescendantPlacementIds(valid, placement.placementId)) {
      deltas.set(descendantId, { x: dx, y: dy });
    }
  }
  if (deltas.size === 0) return next;
  return {
    ...next,
    placements: next.placements.map((placement) => {
      const delta = deltas.get(placement.placementId);
      return delta
        ? { ...placement, x: (placement.x ?? 0) + delta.x, y: (placement.y ?? 0) + delta.y }
        : placement;
    }),
  };
}

function instanceVisibleBounds(
  document: CanvasDocument,
  instanceId: string,
  visible: ReadonlySet<string>
): { left: number; top: number; right: number; bottom: number } | null {
  const placements = document.placements.filter((placement) =>
    visible.has(placement.placementId) &&
    readCanvasSubtreePlacementMeta(placement)?.instanceId === instanceId
  );
  if (placements.length === 0) return null;
  return placements.reduce((bounds, placement) => ({
    left: Math.min(bounds.left, placement.x ?? 0),
    top: Math.min(bounds.top, placement.y ?? 0),
    right: Math.max(bounds.right, (placement.x ?? 0) + NODE_CARD.width),
    bottom: Math.max(bounds.bottom, (placement.y ?? 0) + NODE_CARD.height),
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
}

/**
 * Join a newly authoritative Node only when the drop point is inside exactly
 * one eligible projection-instance envelope. This is explicit scope hit
 * testing, never nearest-copy pairing.
 */
export function joinCanvasSubtreeInstanceAt(
  document: CanvasDocument,
  source: CanvasSubtreeNodeSource,
  point: { x: number; y: number },
  createPlacementId: () => string = () => newPlacementId("pl-node")
): { document: CanvasDocument; placementId: string } | null {
  if (!source.parentNodeId) return null;
  const valid = validSubtreeMembers(document);
  const visible = visiblePlacementIds(document, valid);
  const instancesContainingNode = new Set(
    [...valid.values()]
      .filter((member) => member.placement.entityRef === source.nodeId)
      .map((member) => member.meta.instanceId)
  );
  const candidates = [...valid.values()].filter((member) =>
    member.placement.entityRef === source.parentNodeId &&
    visible.has(member.placement.placementId) &&
    !instancesContainingNode.has(member.meta.instanceId)
  ).filter((member) => {
    const bounds = instanceVisibleBounds(document, member.meta.instanceId, visible);
    if (!bounds) return false;
    const padding = 56;
    return point.x >= bounds.left - padding && point.x <= bounds.right + padding &&
      point.y >= bounds.top - padding && point.y <= bounds.bottom + padding;
  });
  if (candidates.length !== 1) return null;
  const parent = candidates[0];
  const siblings = [...valid.values()].filter((member) =>
    member.meta.parentPlacementId === parent.placement.placementId
  );
  const placementId = createPlacementId();
  const placement = withCanvasSubtreePlacementMeta(withCanvasNodeSnapshot({
    placementId,
    entityRef: source.nodeId,
    kind: "node",
    x: point.x,
    y: point.y,
    width: NODE_CARD.width,
    height: NODE_CARD.height,
  }, source.snapshot), {
    version: 1,
    instanceId: parent.meta.instanceId,
    rootPlacementId: parent.meta.rootPlacementId,
    parentPlacementId: parent.placement.placementId,
    depth: parent.meta.depth + 1,
    siblingOrder: siblings.length,
    expandedDirection: null,
    lastDirection: parent.meta.expandedDirection ?? parent.meta.lastDirection,
  });
  return {
    placementId,
    document: {
      ...document,
      placements: [...document.placements, placement],
      focusedPlacementId: placementId,
    },
  };
}
