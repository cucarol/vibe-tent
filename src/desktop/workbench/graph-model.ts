/**
 * Pure graph projection helpers for Desktop graph view.
 * No Electron / DOM. Edges come only from real docs.backlinks (+ optional body out-links).
 * There is no bulk graph RPC — see DESKTOP_CONTRACT_GAPS graph.bulk.
 */

export type GraphNode = {
  id: string;
  path: string;
  name: string;
  type: string;
  coordination: boolean;
  children?: GraphNode[];
};

export type GraphBacklink = {
  fromCx: string;
  fromPath: string;
  fromName: string;
  raw: string;
  kind: string;
};

export type GraphOutLink = {
  raw: string;
  kind: string;
  targetCx?: string;
  targetPath?: string;
  label?: string;
};

export type GraphSelectionView = {
  node: GraphNode | null;
  backlinks: GraphBacklink[];
  outLinks: GraphOutLink[];
  /** True when selection is known but backlinks RPC failed. */
  backlinksError: string | null;
  /** True when out-links could not be loaded (docs.get missing / failed). */
  outLinksError: string | null;
};

export type FlatGraphNode = {
  id: string;
  path: string;
  name: string;
  type: string;
  coordination: boolean;
  depth: number;
};

/** Depth-first flatten for the graph node list (no fabricated edges). */
export function flattenGraphNodes(roots: GraphNode[], depth = 0): FlatGraphNode[] {
  const out: FlatGraphNode[] = [];
  for (const n of roots) {
    out.push({
      id: n.id,
      path: n.path,
      name: n.name,
      type: n.type,
      coordination: !!n.coordination,
      depth,
    });
    if (n.children?.length) {
      out.push(...flattenGraphNodes(n.children, depth + 1));
    }
  }
  return out;
}

export function findGraphNode(nodes: GraphNode[], id: string): GraphNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const child = findGraphNode(n.children || [], id);
    if (child) return child;
  }
  return undefined;
}

/**
 * Build selection view from already-fetched projections.
 * Callers must supply real RPC results; empty arrays are valid (no fake edges).
 */
export function buildGraphSelectionView(args: {
  node: GraphNode | null;
  backlinks?: GraphBacklink[] | null;
  outLinks?: GraphOutLink[] | null;
  backlinksError?: string | null;
  outLinksError?: string | null;
}): GraphSelectionView {
  return {
    node: args.node,
    backlinks: args.backlinks ?? [],
    outLinks: args.outLinks ?? [],
    backlinksError: args.backlinksError ?? null,
    outLinksError: args.outLinksError ?? null,
  };
}

/** Human label for provider verificationLevel — never invents a stronger level. */
export function verificationLevelLabel(level: string): string {
  switch (level) {
    case "live-e2e":
      return "live E2E";
    case "mock-tested":
      return "mock-tested";
    case "adapter-implemented":
      return "adapter only";
    default:
      return level || "unknown";
  }
}
