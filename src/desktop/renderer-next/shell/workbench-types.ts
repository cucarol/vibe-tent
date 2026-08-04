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
  outputProvenance?: { state: "ready" | "error"; label: string };
};

export function nodeTitle(node: WorkbenchNodeView): string {
  return node.title?.trim() || node.name;
}

export function nodeTypeLabel(type: string): string {
  if (type === "goal") return "目标";
  if (type === "prompt") return "提示";
  if (type === "output") return "输出";
  return type.trim() || "未知类型";
}

export function taskStateLabel(state: string): string {
  const labels: Record<string, string> = {
    queued: "排队中",
    running: "运行中",
    waiting: "等待中",
    delivered: "待审阅",
    accepted: "已接受",
    rejected: "已驳回",
    interrupted: "已中断",
    failed: "失败",
  };
  return labels[state] ?? `任务 · ${state}`;
}

export function projectionLabel(state: ProjectionState | undefined): string | null {
  if (!state || state === "ready") return null;
  if (state === "stale") return "数据已过期";
  if (state === "unresolved") return "节点未解析";
  return "加载失败";
}
