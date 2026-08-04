export type ProjectionState = "ready" | "stale" | "unresolved" | "error";

export type WorkbenchNodeView = {
  nodeId: string;
  path: string;
  name: string;
  title?: string;
  type: "goal" | "prompt" | "output" | string;
  tags: readonly string[];
  mode: "editable" | "archived";
  archived: boolean;
  invalid: boolean;
  depth?: number;
  activeTaskState?: string | null;
  projectionState?: ProjectionState;
  projectionMessage?: string;
};

export function nodeTitle(node: WorkbenchNodeView): string {
  return node.title?.trim() || node.name;
}

export function nodeTypeLabel(type: string): string {
  if (type === "goal") return "目标";
  if (type === "prompt") return "提示";
  if (type === "output") return "输出";
  return "节点";
}

export function projectionLabel(state: ProjectionState | undefined): string | null {
  if (!state || state === "ready") return null;
  if (state === "stale") return "数据已过期";
  if (state === "unresolved") return "节点未解析";
  return "加载失败";
}
