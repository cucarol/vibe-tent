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

/** Resolve one Canvas-origin reveal without retaining work while the tray is hidden. */
export function resolveOutlineReveal(args: {
  nodes: readonly WorkbenchNodeView[];
  expandedNodeIds: ReadonlySet<string>;
  reveal: OutlineRevealRequest | undefined;
  visible: boolean;
  handledRevision: number;
  pendingFocus: OutlineRevealRequest | null;
}): OutlineRevealResolution {
  const revision = args.reveal?.revision ?? 0;
  if (!args.visible) {
    return {
      expandedNodeIds: args.expandedNodeIds,
      pendingFocus: null,
      handledRevision: Math.max(args.handledRevision, revision),
      shouldShowNodes: false,
    };
  }

  if (!args.reveal || revision === 0) {
    return {
      expandedNodeIds: args.expandedNodeIds,
      pendingFocus: null,
      handledRevision: args.handledRevision,
      shouldShowNodes: false,
    };
  }

  if (revision <= args.handledRevision) {
    return {
      expandedNodeIds: args.expandedNodeIds,
      pendingFocus: args.pendingFocus,
      handledRevision: args.handledRevision,
      shouldShowNodes: false,
    };
  }

  if (!args.nodes.some((node) => node.nodeId === args.reveal?.nodeId)) {
    return {
      expandedNodeIds: args.expandedNodeIds,
      pendingFocus: null,
      handledRevision: args.handledRevision,
      shouldShowNodes: false,
    };
  }

  const nextExpandedNodeIds = new Set(args.expandedNodeIds);
  for (const ancestor of outlineAncestorNodeIds(args.nodes, args.reveal.nodeId)) {
    nextExpandedNodeIds.add(ancestor);
  }
  return {
    expandedNodeIds: nextExpandedNodeIds,
    pendingFocus: args.reveal,
    handledRevision: revision,
    shouldShowNodes: true,
  };
}
