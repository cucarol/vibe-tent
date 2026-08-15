import type { WorkbenchNodeView } from "../shell/workbench-types.js";
import { outlineAncestorNodeIds } from "./outline-tree.js";

export type OutlineRevealRequest = {
  nodeId: string;
  revision: number;
};

export type OutlineRevealResolution = {
  expandedNodeIds: ReadonlySet<string>;
  pendingFocus: OutlineRevealRequest | null;
  handledRevision: number;
  shouldShowNodes: boolean;
};

/** Resolve one Canvas-origin reveal, retaining it while the tray is hidden. */
export function resolveOutlineReveal(args: {
  nodes: readonly WorkbenchNodeView[];
  expandedNodeIds: ReadonlySet<string>;
  reveal: OutlineRevealRequest | undefined;
  visible: boolean;
  handledRevision: number;
  pendingFocus: OutlineRevealRequest | null;
}): OutlineRevealResolution {
  const revision = args.reveal?.revision ?? 0;
  const retainedPending = args.pendingFocus && args.reveal &&
    args.pendingFocus.revision >= args.reveal.revision
    ? args.pendingFocus
    : null;
  const nextRequest = args.reveal && revision > args.handledRevision
    ? args.reveal
    : retainedPending
      ? retainedPending
      : null;
  if (!args.visible) {
    return {
      expandedNodeIds: args.expandedNodeIds,
      pendingFocus: nextRequest,
      handledRevision: Math.max(args.handledRevision, revision),
      shouldShowNodes: false,
    };
  }

  if (!args.reveal || revision === 0 || !nextRequest) {
    return {
      expandedNodeIds: args.expandedNodeIds,
      pendingFocus: retainedPending,
      handledRevision: args.handledRevision,
      shouldShowNodes: false,
    };
  }

  if (!args.nodes.some((node) => node.nodeId === nextRequest.nodeId)) {
    return {
      expandedNodeIds: args.expandedNodeIds,
      pendingFocus: null,
      handledRevision: args.handledRevision,
      shouldShowNodes: false,
    };
  }

  const nextExpandedNodeIds = new Set(args.expandedNodeIds);
  for (const ancestor of outlineAncestorNodeIds(args.nodes, nextRequest.nodeId)) {
    nextExpandedNodeIds.add(ancestor);
  }
  return {
    expandedNodeIds: nextExpandedNodeIds,
    pendingFocus: nextRequest,
    handledRevision: Math.max(args.handledRevision, revision),
    shouldShowNodes: true,
  };
}
