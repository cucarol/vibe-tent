import type { WorkbenchNodeView } from "../shell/workbench-types.js";

/** Flatten the authoritative parent-edge tree according to local expansion state. */
export function visibleOutlineNodes(
  nodes: readonly WorkbenchNodeView[],
  expandedNodeIds: ReadonlySet<string>
): WorkbenchNodeView[] {
  const byParent = new Map<string | null, WorkbenchNodeView[]>();
  const byId = new Map(nodes.map((node) => [node.nodeId, node] as const));
  for (const node of nodes) {
    const parentId = node.parentNodeId && byId.has(node.parentNodeId)
      ? node.parentNodeId
      : null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(node);
    byParent.set(parentId, siblings);
  }

  const visible: WorkbenchNodeView[] = [];
  const visited = new Set<string>();
  const structurallyReachable = new Set<string>();
  const markReachable = (node: WorkbenchNodeView) => {
    if (structurallyReachable.has(node.nodeId)) return;
    structurallyReachable.add(node.nodeId);
    for (const child of byParent.get(node.nodeId) ?? []) markReachable(child);
  };
  for (const root of byParent.get(null) ?? []) markReachable(root);
  const append = (node: WorkbenchNodeView) => {
    if (visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    visible.push(node);
    if (!expandedNodeIds.has(node.nodeId)) return;
    for (const child of byParent.get(node.nodeId) ?? []) append(child);
  };
  for (const root of byParent.get(null) ?? []) append(root);
  // A malformed cycle or orphan remains visible without inventing hierarchy.
  for (const node of nodes) {
    if (!structurallyReachable.has(node.nodeId)) append(node);
  }
  return visible;
}

export function isOutlineDescendant(
  nodes: readonly WorkbenchNodeView[],
  candidateNodeId: string,
  ancestorNodeId: string
): boolean {
  const byId = new Map(nodes.map((node) => [node.nodeId, node] as const));
  const seen = new Set<string>();
  let current = byId.get(candidateNodeId)?.parentNodeId ?? null;
  while (current && !seen.has(current)) {
    if (current === ancestorNodeId) return true;
    seen.add(current);
    current = byId.get(current)?.parentNodeId ?? null;
  }
  return false;
}

export function firstOutlineChild(
  nodes: readonly WorkbenchNodeView[],
  parentNodeId: string
): WorkbenchNodeView | null {
  return nodes.find((node) => node.parentNodeId === parentNodeId) ?? null;
}

/** Exact authoritative ancestors ordered root -> direct parent. */
export function outlineAncestorNodeIds(
  nodes: readonly WorkbenchNodeView[],
  nodeId: string
): string[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node] as const));
  const result: string[] = [];
  const seen = new Set<string>([nodeId]);
  let current = byId.get(nodeId)?.parentNodeId ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    result.unshift(current);
    current = byId.get(current)?.parentNodeId ?? null;
  }
  return result;
}

export function updateOutlineExpansion(args: {
  nodes: readonly WorkbenchNodeView[];
  expandedNodeIds: ReadonlySet<string>;
  nodeId: string;
  expanded: boolean;
  selectedNodeId: string | null;
}): { expandedNodeIds: ReadonlySet<string>; selectedNodeId: string | null } {
  const next = new Set(args.expandedNodeIds);
  if (args.expanded) next.add(args.nodeId);
  else next.delete(args.nodeId);
  const selectedNodeId =
    !args.expanded &&
    args.selectedNodeId &&
    isOutlineDescendant(args.nodes, args.selectedNodeId, args.nodeId)
      ? args.nodeId
      : args.selectedNodeId;
  return { expandedNodeIds: next, selectedNodeId };
}
