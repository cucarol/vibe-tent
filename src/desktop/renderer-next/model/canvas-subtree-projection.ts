import type { CanvasDocument, CanvasPlacement } from "../types/identity.js";
import { NODE_CARD, newPlacementId } from "./canvas-document.js";
import {
  type CanvasNodeSnapshot,
  deriveCanvasPlacementSourceState,
  readCanvasNodeSnapshot,
  withCanvasNodeSnapshot,
} from "./canvas-node-snapshot.js";

export const CANVAS_SUBTREE_META_KEY = "tentSubtreeProjection";
export const CANVAS_PROJECTION_PLACEMENT_META_KEY = "tentProjectionPlacement";

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

/**
 * Local presentation state shared by standalone and subtree placements.
 * Missing metadata is the canonical legacy/default state; it is never
 * materialized just because the Canvas was read.
 */
export type CanvasProjectionPlacementMeta = {
  version: 1;
  hidden: boolean;
  sourceStatus: "active" | "deleted";
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

type CanvasProjectionSyncDiff = {
  affectedCount: number;
  reasons: readonly CanvasProjectionSyncReason[];
};

export type CanvasProjectionSyncReason =
  | "content-changed"
  | "reparented"
  | "member-added"
  | "member-removed"
  | "source-deleted"
  | "source-archived"
  | "revision-unknown";

export type CanvasProjectionPlacementState = {
  placementId: string;
  state: "current" | "pending-sync" | "tombstone" | "unknown";
  reasons: readonly CanvasProjectionSyncReason[];
};

export type CanvasDocumentSyncControl = {
  affectedCount: number;
  reasons: readonly CanvasProjectionSyncReason[];
  authorityDigest: string;
  canSync: boolean;
};

export type CanvasSubtreeProjection = {
  authority: "fresh" | "unknown";
  visiblePlacementIds: readonly string[];
  relationships: readonly CanvasSubtreeRelationship[];
  controls: readonly CanvasSubtreeControl[];
  placementStates: readonly CanvasProjectionPlacementState[];
  documentSync: CanvasDocumentSyncControl | null;
};

export type CanvasProjectionAuthorityReader =
  () => readonly CanvasSubtreeNodeSource[] | null;

const DIRECTIONS = new Set<SubtreeDirection>(["up", "right", "down", "left"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readCanvasProjectionPlacementMeta(
  placement: Pick<CanvasPlacement, "meta">
): CanvasProjectionPlacementMeta {
  const raw = placement.meta?.[CANVAS_PROJECTION_PLACEMENT_META_KEY];
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    typeof raw.hidden !== "boolean" ||
    (raw.sourceStatus !== "active" && raw.sourceStatus !== "deleted")
  ) {
    return { version: 1, hidden: false, sourceStatus: "active" };
  }
  return {
    version: 1,
    hidden: raw.hidden,
    sourceStatus: raw.sourceStatus,
  };
}

export function withCanvasProjectionPlacementMeta(
  placement: CanvasPlacement,
  state: CanvasProjectionPlacementMeta
): CanvasPlacement {
  return {
    ...placement,
    meta: {
      ...(placement.meta ?? {}),
      [CANVAS_PROJECTION_PLACEMENT_META_KEY]: state,
    },
  };
}

export function setCanvasProjectionPlacementHidden(
  document: CanvasDocument,
  placementId: string,
  hidden: boolean
): CanvasDocument {
  let changed = false;
  const placements = document.placements.map((placement) => {
    if (placement.placementId !== placementId || placement.kind !== "node") return placement;
    const state = readCanvasProjectionPlacementMeta(placement);
    if (state.hidden === hidden) return placement;
    changed = true;
    return withCanvasProjectionPlacementMeta(placement, { ...state, hidden });
  });
  if (!changed) return document;
  return {
    ...document,
    placements,
    focusedPlacementId: hidden && document.focusedPlacementId === placementId
      ? null
      : document.focusedPlacementId,
  };
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
      // A captured bundle starts folded. The root is the only visible member;
      // each branch is revealed explicitly, one level at a time.
      expandedDirection: null,
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
    if (readCanvasProjectionPlacementMeta(placement).hidden) continue;
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
      if (
        !parent ||
        parent.meta.expandedDirection === null ||
        readCanvasProjectionPlacementMeta(parent.placement).hidden
      ) {
        isVisible = false;
        break;
      }
      current = parent;
    }
    if (isVisible) visible.add(placement.placementId);
  }
  return visible;
}

function encodeAuthorityPart(value: string): string {
  return `${value.length}:${value}`;
}

function reachableAuthoritySources(
  rootNodeId: string,
  sources: readonly CanvasSubtreeNodeSource[]
): CanvasSubtreeNodeSource[] {
  const byId = new Map(sources.map((source) => [source.nodeId, source] as const));
  const children = childrenByParent(sources);
  const reachable: CanvasSubtreeNodeSource[] = [];
  const queue = [rootNodeId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const source = byId.get(nodeId);
    if (!source) continue;
    reachable.push(source);
    queue.push(...(children.get(nodeId) ?? []).map((child) => child.nodeId));
  }
  return reachable;
}

/**
 * Optimistic guard for the one current-Canvas sync command. Geometry and
 * camera are intentionally excluded because sync preserves the latest local
 * layout, while exact placement/instance membership and source revisions are
 * included so a stale rendered command cannot commit over either change.
 */
export function canvasDocumentAuthorityDigest(
  document: CanvasDocument,
  sources: readonly CanvasSubtreeNodeSource[] | null
): string | null {
  if (!sources) return null;
  const sourceById = new Map(sources.map((source) => [source.nodeId, source] as const));
  const valid = validSubtreeMembers(document);
  const relevantNodeIds = new Set<string>();
  for (const placement of document.placements) {
    if (placement.kind !== "node" || !placement.entityRef) continue;
    relevantNodeIds.add(placement.entityRef);
    const member = valid.get(placement.placementId);
    if (member?.meta.parentPlacementId === null) {
      for (const source of reachableAuthoritySources(placement.entityRef, sources)) {
        relevantNodeIds.add(source.nodeId);
      }
    }
  }
  const local = document.placements
    .filter((placement) => placement.kind === "node")
    .map((placement) => {
      const subtree = valid.get(placement.placementId)?.meta;
      const state = readCanvasProjectionPlacementMeta(placement);
      return [
        placement.placementId,
        placement.entityRef ?? "",
        subtree?.instanceId ?? "standalone",
        subtree?.rootPlacementId ?? "",
        subtree?.parentPlacementId ?? "",
        String(subtree?.depth ?? -1),
        String(subtree?.siblingOrder ?? -1),
        state.sourceStatus,
      ] as const;
    })
    .sort((left, right) => left[0].localeCompare(right[0]));
  const authority = [...relevantNodeIds]
    .sort((left, right) => left.localeCompare(right))
    .map((nodeId) => {
      const source = sourceById.get(nodeId);
      return source
        ? [nodeId, source.parentNodeId ?? "", source.snapshot.etag] as const
        : [nodeId, "!missing", "!missing"] as const;
    });
  const encodeRows = (rows: readonly (readonly string[])[]) =>
    rows.map((row) => row.map(encodeAuthorityPart).join("|")).join(";");
  return `v2:local:${encodeRows(local)}:authority:${encodeRows(authority)}`;
}

export function deriveCanvasSubtreeProjection(
  document: CanvasDocument,
  sources: readonly CanvasSubtreeNodeSource[] | null
): CanvasSubtreeProjection {
  const authority = sources ? "fresh" : "unknown";
  const valid = validSubtreeMembers(document);
  const visible = visiblePlacementIds(document, valid);
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
      !visible.has(member.placement.placementId)
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
    if (!visible.has(member.placement.placementId)) continue;
    const projectedChildren = childrenByPlacement.get(member.placement.placementId) ?? [];
    if (projectedChildren.length === 0) continue;
    controls.push({
      placementId: member.placement.placementId,
      projectedDirectChildCount: projectedChildren.length,
      unprojectedDirectChildCount: 0,
      expandedDirection: member.meta.expandedDirection,
      lastDirection: member.meta.lastDirection,
      canMutate: true,
    });
  }
  if (!sources) {
    return {
      authority,
      visiblePlacementIds: [...visible],
      relationships,
      controls,
      placementStates: document.placements
        .filter((placement) => placement.kind === "node")
        .map((placement) => ({
          placementId: placement.placementId,
          state: readCanvasProjectionPlacementMeta(placement).sourceStatus === "deleted"
            ? "tombstone" as const
            : "unknown" as const,
          reasons: [],
        })),
      documentSync: null,
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
  const placementStates = new Map<string, CanvasProjectionPlacementState>();
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
    const snapshot = readCanvasNodeSnapshot(placement);
    const localState = readCanvasProjectionPlacementMeta(placement);
    const reasons: CanvasProjectionSyncReason[] = [];
    if (source && localState.sourceStatus === "deleted") {
      reasons.push("content-changed");
    } else if (state.state === "deleted" && localState.sourceStatus !== "deleted") {
      reasons.push("source-deleted");
    }
    else if (state.state === "changed") {
      if (source?.snapshot.archived && snapshot?.archived !== source.snapshot.archived) {
        reasons.push("source-archived");
      } else {
        reasons.push("content-changed");
      }
    } else if (state.state === "unknown" && state.reason === "revision-unavailable") {
      reasons.push("revision-unknown");
    }
    placementStates.set(placement.placementId, {
      placementId: placement.placementId,
      state: !source && localState.sourceStatus === "deleted"
        ? "tombstone"
        : state.state === "current" && localState.sourceStatus === "active"
          ? "current"
          : "pending-sync",
      reasons,
    });
  }
  const syncDiffs: CanvasProjectionSyncDiff[] = [];
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
    const reasons = new Set<CanvasProjectionSyncReason>();
    for (const member of members) {
      const nodeId = member.placement.entityRef;
      if (!nodeId || !expected.has(nodeId)) {
        affected.add(member.placement.placementId);
        reasons.add(
          !nodeId
            ? "member-removed"
            : sourceById.has(nodeId)
              ? "reparented"
              : "source-deleted"
        );
        continue;
      }
      if (member.meta.parentPlacementId !== null) {
        const expectedParentNodeId = authoritativeParentByChild.get(nodeId) ?? null;
        const actualParentNodeId = valid.get(member.meta.parentPlacementId)?.placement.entityRef ?? null;
        if (expectedParentNodeId !== actualParentNodeId) {
          affected.add(member.placement.placementId);
          reasons.add("reparented");
        }
      }
      const placementState = placementStates.get(member.placement.placementId);
      if (placementState?.state !== "current") {
        affected.add(member.placement.placementId);
        placementState?.reasons.forEach((reason) => reasons.add(reason));
      }
    }
    for (const nodeId of expected) {
      if (!memberByNodeId.has(nodeId)) {
        affected.add(`missing:${nodeId}`);
        reasons.add("member-added");
      }
    }
    if (affected.size > 0) {
      const rootState = placementStates.get(root.placement.placementId);
      placementStates.set(root.placement.placementId, {
        placementId: root.placement.placementId,
        state: "pending-sync",
        reasons: [...new Set([...(rootState?.reasons ?? []), ...reasons])],
      });
      syncDiffs.push({
        affectedCount: affected.size,
        reasons: [...reasons],
      });
    }
  }
  for (const placement of document.placements) {
    if (placement.kind !== "node" || valid.has(placement.placementId)) continue;
    const placementState = placementStates.get(placement.placementId);
    if (placementState?.state !== "pending-sync") continue;
    syncDiffs.push({
      affectedCount: 1,
      reasons: placementState.reasons,
    });
  }
  const documentSync = syncDiffs.length > 0
    ? {
      affectedCount: syncDiffs.reduce((total, control) => total + control.affectedCount, 0),
      reasons: [...new Set(syncDiffs.flatMap((control) => control.reasons))],
      authorityDigest: canvasDocumentAuthorityDigest(document, sources)!,
      canSync: true,
    } satisfies CanvasDocumentSyncControl
    : null;
  return {
    authority,
    visiblePlacementIds: [...visible],
    relationships,
    controls,
    placementStates: [...placementStates.values()],
    documentSync,
  };
}

function sourceSnapshot(source: CanvasSubtreeNodeSource): CanvasNodeSnapshot {
  return source.snapshot;
}

function withProjectionSource(
  placement: CanvasPlacement,
  source: CanvasSubtreeNodeSource | null
): CanvasPlacement {
  const current = readCanvasProjectionPlacementMeta(placement);
  const next = source
    ? withCanvasNodeSnapshot(placement, sourceSnapshot(source))
    : placement;
  return withCanvasProjectionPlacementMeta(next, {
    ...current,
    sourceStatus: source ? "active" : "deleted",
  });
}

function placementRect(placement: CanvasPlacement): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const width = placement.kind === "node"
    ? NODE_CARD.width
    : typeof placement.width === "number" ? placement.width : 0;
  const height = placement.kind === "node"
    ? NODE_CARD.height
    : typeof placement.height === "number" ? placement.height : 0;
  const left = placement.x ?? 0;
  const top = placement.y ?? 0;
  return { left, top, right: left + width, bottom: top + height };
}

function positionIsAvailable(
  position: { x: number; y: number },
  occupied: readonly ReturnType<typeof placementRect>[]
): boolean {
  const margin = 20;
  const candidate = {
    left: position.x - margin,
    top: position.y - margin,
    right: position.x + NODE_CARD.width + margin,
    bottom: position.y + NODE_CARD.height + margin,
  };
  return occupied.every((rect) =>
    candidate.right <= rect.left ||
    candidate.left >= rect.right ||
    candidate.bottom <= rect.top ||
    candidate.top >= rect.bottom
  );
}

function nearestAvailableChildPosition(
  parent: { x: number; y: number },
  direction: SubtreeDirection,
  siblingOrder: number,
  siblingCount: number,
  occupied: readonly ReturnType<typeof placementRect>[]
): { x: number; y: number } {
  const initial = childPosition(parent, direction, siblingOrder, siblingCount);
  const perpendicularGap = direction === "left" || direction === "right"
    ? NODE_CARD.height + 28
    : NODE_CARD.width + 28;
  const forwardGap = direction === "left" || direction === "right"
    ? NODE_CARD.width + 76
    : NODE_CARD.height + 76;
  const forwardLimit = occupied.reduce((limit, rect) => {
    if (direction === "right") return Math.max(limit, rect.right - (initial.x - 20));
    if (direction === "left") return Math.max(limit, initial.x + NODE_CARD.width + 20 - rect.left);
    if (direction === "down") return Math.max(limit, rect.bottom - (initial.y - 20));
    return Math.max(limit, initial.y + NODE_CARD.height + 20 - rect.top);
  }, 0);
  // One step beyond the furthest occupied bound is guaranteed free on the
  // centre lane because the Canvas plane is unbounded in the chosen direction.
  // This keeps the search deterministic without ever falling back to a known
  // collision after a fixed number of candidates.
  const maxDepth = Math.ceil(Math.max(0, forwardLimit) / forwardGap) + 1;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    for (let lane = 0; lane < 9; lane += 1) {
      const laneOffset = lane === 0
        ? 0
        : Math.ceil(lane / 2) * (lane % 2 === 1 ? 1 : -1);
      const position = { ...initial };
      if (direction === "right" || direction === "left") {
        position.x += (direction === "right" ? 1 : -1) * depth * forwardGap;
        position.y += laneOffset * perpendicularGap;
      } else {
        position.x += laneOffset * perpendicularGap;
        position.y += (direction === "down" ? 1 : -1) * depth * forwardGap;
      }
      if (positionIsAvailable(position, occupied)) return position;
    }
  }
  throw new Error("Canvas child placement search exhausted outside occupied bounds");
}

function reconcileSubtreeInstance(
  document: CanvasDocument,
  rootPlacementId: string,
  sources: readonly CanvasSubtreeNodeSource[],
  createPlacementId: () => string
): CanvasDocument {
  const valid = validSubtreeMembers(document);
  const root = valid.get(rootPlacementId);
  if (!root || root.meta.parentPlacementId !== null || !root.placement.entityRef) return document;
  const instanceId = root.meta.instanceId;
  const members = document.placements.flatMap((placement) => {
    const member = valid.get(placement.placementId);
    return member?.meta.instanceId === instanceId ? [member] : [];
  });
  const sourceById = new Map(sources.map((source) => [source.nodeId, source] as const));
  const rootSource = sourceById.get(root.placement.entityRef) ?? null;

  if (!rootSource) {
    const memberIds = new Set(members.map((member) => member.placement.placementId));
    return {
      ...document,
      placements: document.placements.map((placement) =>
        memberIds.has(placement.placementId)
          ? withProjectionSource(
            withoutCanvasSubtreePlacementMeta(placement),
            placement.entityRef ? sourceById.get(placement.entityRef) ?? null : null
          )
          : placement
      ),
    };
  }

  const authorityChildren = childrenByParent(sources);
  const expected: Array<{
    source: CanvasSubtreeNodeSource;
    parentNodeId: string | null;
    depth: number;
    siblingOrder: number;
  }> = [];
  const queue: Array<{
    source: CanvasSubtreeNodeSource;
    parentNodeId: string | null;
    depth: number;
    siblingOrder: number;
  }> = [{ source: rootSource, parentNodeId: null, depth: 0, siblingOrder: 0 }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (seen.has(entry.source.nodeId)) continue;
    seen.add(entry.source.nodeId);
    expected.push(entry);
    (authorityChildren.get(entry.source.nodeId) ?? []).forEach((child, siblingOrder) => {
      queue.push({
        source: child,
        parentNodeId: entry.source.nodeId,
        depth: entry.depth + 1,
        siblingOrder,
      });
    });
  }

  const expectedNodeIds = new Set(expected.map((entry) => entry.source.nodeId));
  const membersByNodeId = new Map<string, ValidMember[]>();
  for (const member of members) {
    if (!member.placement.entityRef) continue;
    const list = membersByNodeId.get(member.placement.entityRef) ?? [];
    list.push(member);
    membersByNodeId.set(member.placement.entityRef, list);
  }
  const canonicalMemberByNodeId = new Map(
    [...membersByNodeId].map(([nodeId, nodeMembers]) => [nodeId, nodeMembers[0]!] as const)
  );
  const updated = new Map<string, CanvasPlacement>();
  for (const member of members) {
    const nodeId = member.placement.entityRef;
    const canonical = nodeId ? canonicalMemberByNodeId.get(nodeId) : null;
    if (
      !nodeId ||
      !expectedNodeIds.has(nodeId) ||
      canonical?.placement.placementId !== member.placement.placementId
    ) {
      updated.set(
        member.placement.placementId,
        withProjectionSource(
          withoutCanvasSubtreePlacementMeta(member.placement),
          nodeId ? sourceById.get(nodeId) ?? null : null
        )
      );
    }
  }

  // New members must avoid every placement that survives this transaction,
  // including existing members that appear later in authoritative sibling
  // order. Existing members keep their exact geometry and never need to be
  // searched, so retaining their rectangles here cannot move them.
  const occupied = document.placements.map(placementRect);
  const nextByNodeId = new Map<string, CanvasPlacement>();
  const additions: CanvasPlacement[] = [];
  for (const entry of expected) {
    const existing = canonicalMemberByNodeId.get(entry.source.nodeId)?.placement ?? null;
    const parentPlacement = entry.parentNodeId ? nextByNodeId.get(entry.parentNodeId) ?? null : null;
    const parentMeta = parentPlacement ? readCanvasSubtreePlacementMeta(parentPlacement) : null;
    const direction = parentMeta?.expandedDirection ?? parentMeta?.lastDirection ?? root.meta.lastDirection;
    const siblings = entry.parentNodeId ? authorityChildren.get(entry.parentNodeId) ?? [] : [entry.source];
    const position = existing
      ? { x: existing.x ?? 0, y: existing.y ?? 0 }
      : parentPlacement
        ? nearestAvailableChildPosition(
          { x: parentPlacement.x ?? 0, y: parentPlacement.y ?? 0 },
          direction,
          entry.siblingOrder,
          siblings.length,
          occupied
        )
        : { x: root.placement.x ?? 0, y: root.placement.y ?? 0 };
    const placementId = existing?.placementId ?? createPlacementId();
    const existingMeta = existing ? readCanvasSubtreePlacementMeta(existing) : null;
    const meta: CanvasSubtreePlacementMeta = {
      version: 1,
      instanceId,
      rootPlacementId,
      parentPlacementId: parentPlacement?.placementId ?? null,
      depth: entry.depth,
      siblingOrder: entry.siblingOrder,
      expandedDirection: existingMeta?.expandedDirection ?? null,
      lastDirection: existingMeta?.lastDirection ?? direction,
    };
    const placement = withCanvasProjectionPlacementMeta(
      withCanvasSubtreePlacementMeta(
        withCanvasNodeSnapshot({
          ...(existing ?? {}),
          placementId,
          entityRef: entry.source.nodeId,
          kind: "node",
          x: position.x,
          y: position.y,
          width: NODE_CARD.width,
          height: NODE_CARD.height,
        }, sourceSnapshot(entry.source)),
        meta
      ),
      {
        ...readCanvasProjectionPlacementMeta(existing ?? { meta: undefined }),
        sourceStatus: "active",
      }
    );
    nextByNodeId.set(entry.source.nodeId, placement);
    occupied.push(placementRect(placement));
    if (existing) updated.set(existing.placementId, placement);
    else additions.push(placement);
  }

  return {
    ...document,
    placements: [
      ...document.placements.map((placement) => updated.get(placement.placementId) ?? placement),
      ...additions,
    ],
  };
}

/**
 * Reconcile every projection in the current Canvas as one pure document
 * transaction. Callers persist the returned document before publishing it.
 */
export function reconcileCanvasDocumentSync(
  document: CanvasDocument,
  sources: readonly CanvasSubtreeNodeSource[] | null,
  request: {
    authorityDigest: string;
    createPlacementId?: () => string;
  }
): CanvasDocument {
  if (!sources || canvasDocumentAuthorityDigest(document, sources) !== request.authorityDigest) {
    return document;
  }
  const createPlacementId = request.createPlacementId ?? (() => newPlacementId("pl-node"));
  const originalValid = validSubtreeMembers(document);
  const rootIds = document.placements.flatMap((placement) => {
    const member = originalValid.get(placement.placementId);
    return member?.meta.parentPlacementId === null ? [placement.placementId] : [];
  });
  let next = document;
  for (const rootId of rootIds) {
    next = reconcileSubtreeInstance(next, rootId, sources, createPlacementId);
  }
  const validAfterInstances = validSubtreeMembers(next);
  const sourceById = new Map(sources.map((source) => [source.nodeId, source] as const));
  return {
    ...next,
    placements: next.placements.map((placement) => {
      if (
        placement.kind !== "node" ||
        validAfterInstances.has(placement.placementId)
      ) return placement;
      return withProjectionSource(
        placement,
        placement.entityRef ? sourceById.get(placement.entityRef) ?? null : null
      );
    }),
  };
}

export function reconcileCanvasDocumentSyncFromLatestAuthority(
  document: CanvasDocument,
  authorityDigest: string,
  readAuthority: CanvasProjectionAuthorityReader,
  createPlacementId?: () => string
): CanvasDocument {
  return reconcileCanvasDocumentSync(document, readAuthority(), {
    authorityDigest,
    ...(createPlacementId ? { createPlacementId } : {}),
  });
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
