/**
 * Box collaboration projection helpers (workbench / client layer).
 * status / assignee / activeTaskId come only from box.projection RPC —
 * never from frontmatter, owner, or task list fan-in in the renderer.
 */

export type BoxStatus = "todo" | "doing" | "done";

/** Normalized view of service BoxProjection (safe UI fields only). */
export type BoxProjectionView = {
  workspaceId: string;
  boxId: string;
  status: BoxStatus;
  assignee?: string;
  activeTaskId?: string;
};

export type TreeNodeLike = {
  id: string;
  coordination: boolean;
  status?: string;
  assignee?: string;
  children?: TreeNodeLike[];
};

/** Chinese labels for box.projection status (tree marks + inspector). */
export function boxStatusLabel(status: BoxStatus | string | undefined): string {
  switch (status) {
    case "doing":
      return "进行中";
    case "done":
      return "完成";
    case "todo":
      return "待办";
    default:
      return status ? String(status) : "—";
  }
}

/**
 * Normalize raw box.projection result. Rejects unknown shapes rather than inventing state.
 */
export function normalizeBoxProjection(raw: unknown): BoxProjectionView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const workspaceId = typeof r.workspaceId === "string" ? r.workspaceId : "";
  const boxId =
    (typeof r.boxId === "string" && r.boxId) ||
    (typeof r.id === "string" && r.id) ||
    "";
  const statusRaw = r.status;
  if (!workspaceId || !boxId) return null;
  if (statusRaw !== "todo" && statusRaw !== "doing" && statusRaw !== "done") {
    return null;
  }
  const out: BoxProjectionView = {
    workspaceId,
    boxId,
    status: statusRaw,
  };
  if (typeof r.assignee === "string" && r.assignee.trim()) {
    out.assignee = r.assignee.trim();
  }
  if (typeof r.activeTaskId === "string" && r.activeTaskId.trim()) {
    out.activeTaskId = r.activeTaskId.trim();
  }
  return out;
}

/** Collect coordination box ids (depth-first) for box.projection fan-out. */
export function collectCoordinationBoxIds(nodes: readonly TreeNodeLike[]): string[] {
  const ids: string[] = [];
  const walk = (list: readonly TreeNodeLike[]) => {
    for (const n of list) {
      if (n.coordination && n.id) ids.push(n.id);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

/**
 * Strip any list/frontmatter collab fields, then overlay box.projection.
 * Non-coordination nodes never carry status/assignee.
 */
export function applyBoxProjectionsToTree<T extends TreeNodeLike>(
  nodes: T[],
  byBoxId: ReadonlyMap<string, BoxProjectionView>
): T[] {
  return nodes.map((n) => applyOne(n, byBoxId));
}

function applyOne<T extends TreeNodeLike>(
  node: T,
  byBoxId: ReadonlyMap<string, BoxProjectionView>
): T {
  const children = node.children?.length
    ? node.children.map((c) => applyOne(c as T, byBoxId))
    : node.children;

  if (!node.coordination) {
    const cleared = { ...node, children } as T;
    delete (cleared as TreeNodeLike).status;
    delete (cleared as TreeNodeLike).assignee;
    return cleared;
  }

  const proj = byBoxId.get(node.id);
  if (!proj) {
    const cleared = { ...node, children } as T;
    delete (cleared as TreeNodeLike).status;
    delete (cleared as TreeNodeLike).assignee;
    return cleared;
  }

  const next = { ...node, children, status: proj.status } as T;
  if (proj.assignee) (next as TreeNodeLike).assignee = proj.assignee;
  else delete (next as TreeNodeLike).assignee;
  return next;
}

/**
 * Compact one-line collab summary for inspector (no invented fields).
 * e.g. "进行中 · reviewer" or "待办"
 */
export function boxProjectionSummaryLine(proj: BoxProjectionView | null | undefined): string | null {
  if (!proj) return null;
  const parts = [boxStatusLabel(proj.status)];
  if (proj.assignee) parts.push(proj.assignee);
  return parts.join(" · ");
}
