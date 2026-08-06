export type ProjectionState =
  | "loading"
  | "ready"
  | "stale"
  | "unresolved"
  | "error";
export type CollaborationProjectionState =
  | "ready"
  | "refreshing"
  | "stale"
  | "error"
  | "unknown";

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
  activeTaskState?: string | null;
  collaborationState?: CollaborationProjectionState;
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

export function collaborationProjectionState(
  state: "idle" | "loading" | "ready" | "stale" | "error"
): CollaborationProjectionState {
  if (state === "ready") return "ready";
  if (state === "loading") return "refreshing";
  if (state === "stale") return "stale";
  if (state === "error") return "error";
  return "unknown";
}

export function collaborationBadgeLabel(node: WorkbenchNodeView): string {
  if (node.collaborationState === "refreshing") return "正在刷新";
  if (node.collaborationState !== "ready") return "状态未知";
  if (typeof node.activeTaskState === "string") {
    return taskStateLabel(node.activeTaskState);
  }
  return node.activeTaskState === null ? "空闲" : "状态未知";
}

export function collaborationSummary(node: WorkbenchNodeView): string {
  if (node.collaborationState === "refreshing") {
    return "正在刷新协作状态；不会把旧结果当作当前事实。";
  }
  if (node.collaborationState !== "ready" || node.activeTaskState === undefined) {
    return "协作状态未知；等待权威投影恢复。";
  }
  return node.activeTaskState
    ? `任务状态：${taskStateLabel(node.activeTaskState)}`
    : "这个节点当前没有进行中的任务。";
}

export function projectionLabel(state: ProjectionState | undefined): string | null {
  if (!state || state === "ready") return null;
  if (state === "loading") return "正在加载";
  if (state === "stale") return "数据已过期";
  if (state === "unresolved") return "节点未解析";
  return "加载失败";
}
