/**
 * Pure graph projection helpers for Desktop graph view.
 * No Electron / DOM. Edges come only from real docs.backlinks (+ optional body out-links).
 * There is no bulk graph RPC — see DESKTOP_CONTRACT_GAPS graph.bulk.
 */

export type GraphNode = {
  nodeId: string;
  path: string;
  name: string;
  type: string;
  /** @deprecated Local UI only; prefer invalid/archived. */
  coordination?: boolean;
  invalid?: boolean;
  archived?: boolean;
  children?: GraphNode[];
};

export type GraphBacklink = {
  fromNodeId: string;
  fromPath: string;
  fromName: string;
  raw: string;
  kind: string;
};

export type GraphOutLink = {
  raw: string;
  kind: string;
  targetNodeId?: string;
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
  nodeId: string;
  path: string;
  name: string;
  type: string;
  /** Local usable flag for legacy UI (true when not invalid/archived). */
  usable: boolean;
  /** @deprecated Prefer usable. */
  coordination: boolean;
  depth: number;
};

function graphNodeUsable(n: GraphNode): boolean {
  if (n.invalid) return false;
  if (n.archived) return false;
  if (typeof n.coordination === "boolean") return n.coordination;
  return true;
}

/** Depth-first flatten for the graph node list (no fabricated edges). */
export function flattenGraphNodes(roots: GraphNode[], depth = 0): FlatGraphNode[] {
  const out: FlatGraphNode[] = [];
  for (const n of roots) {
    const usable = graphNodeUsable(n);
    out.push({
      nodeId: n.nodeId,
      path: n.path,
      name: n.name,
      type: n.type,
      usable,
      coordination: usable,
      depth,
    });
    if (n.children?.length) {
      out.push(...flattenGraphNodes(n.children, depth + 1));
    }
  }
  return out;
}

export function findGraphNode(nodes: GraphNode[], nodeId: string): GraphNode | undefined {
  for (const n of nodes) {
    if (n.nodeId === nodeId) return n;
    const child = findGraphNode(n.children || [], nodeId);
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
    case "live-verified":
      return "live verified (this machine)";
    case "opt-in-live-probe":
      return "opt-in live probe";
    case "live-e2e":
      // Legacy wire value from older catalogs — map honestly, do not upgrade.
      return "opt-in live probe (legacy live-e2e)";
    case "mock-tested":
      return "mock-tested";
    case "adapter-implemented":
      return "adapter only";
    default:
      return level || "unknown";
  }
}
