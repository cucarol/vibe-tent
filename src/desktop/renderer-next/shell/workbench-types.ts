export type ProjectionState =
  | "loading"
  | "ready"
  | "stale"
  | "unresolved"
  | "error";

export type WorkbenchNodeView = {
  nodeId: string;
  /** Required authoritative graph revision; local snapshot fallback uses a separate view. */
  etag: string;
  path: string;
  name: string;
  title?: string;
  type: "goal" | "prompt" | "output" | string;
  tags: readonly string[];
  mode: "editable" | "archived";
  archived: boolean;
  invalid: boolean;
  /** Exact authoritative hierarchy from graph parent edges; never inferred from path. */
  parentNodeId: string | null;
  hasChildren: boolean;
  depth?: number;
  projectionState?: ProjectionState;
  projectionMessage?: string;
  outputProvenance?: { state: "ready" | "error"; label: string };
};

export function nodeTitle(node: Pick<WorkbenchNodeView, "title" | "name">): string {
  return node.title?.trim() || node.name;
}

export function nodeTypeLabel(type: string): string {
  if (type === "goal") return "目标";
  if (type === "prompt") return "提示";
  if (type === "output") return "输出";
  return type.trim() || "未知类型";
}

export function projectionLabel(state: ProjectionState | undefined): string | null {
  if (!state || state === "ready") return null;
  if (state === "loading") return "正在加载";
  if (state === "stale") return "数据已过期";
  if (state === "unresolved") return "节点未解析";
  return "加载失败";
}
