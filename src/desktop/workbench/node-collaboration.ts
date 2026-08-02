/** Canonical node.collaboration projection helpers for Desktop consumers. */

import type { NodeCollaboration, NodeCollaborationActiveTask } from "../../service/types.js";

export type NodeCollaborationView = NodeCollaboration;

export type TreeNodeLike = {
  nodeId: string;
  invalid?: boolean;
  archived?: boolean;
  mode?: string;
  status?: string;
  assignee?: string;
  children?: TreeNodeLike[];
};

function isUsableTreeNode(node: TreeNodeLike): boolean {
  return !node.invalid && !node.archived && node.mode !== "archived";
}

function normalizeActiveTask(raw: unknown): NodeCollaborationActiveTask {
  if (!raw || typeof raw !== "object") throw new Error("Invalid node.collaboration activeTask.");
  const record = raw as Record<string, unknown>;
  const task = record.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("Invalid node.collaboration activeTask.task.");
  }
  const taskRecord = task as Record<string, unknown>;
  if (typeof taskRecord.id !== "string" || typeof taskRecord.state !== "string") {
    throw new Error("Invalid node.collaboration active Task identity/state.");
  }
  return raw as NodeCollaborationActiveTask;
}

/** Normalize only the canonical node.collaboration shape; no id/status aliases. */
export function normalizeNodeCollaboration(raw: unknown): NodeCollaborationView {
  if (!raw || typeof raw !== "object") throw new Error("Invalid node.collaboration projection.");
  const record = raw as Record<string, unknown>;
  if (
    typeof record.workspaceId !== "string" ||
    !record.workspaceId ||
    typeof record.nodeId !== "string" ||
    !record.nodeId ||
    !(record.activeTask === null || (record.activeTask && typeof record.activeTask === "object"))
  ) {
    throw new Error("Invalid node.collaboration projection.");
  }
  const activeTask = record.activeTask === null ? null : normalizeActiveTask(record.activeTask);
  return {
    workspaceId: record.workspaceId,
    nodeId: record.nodeId,
    activeTask,
  };
}

export function collectUsableNodeIds(nodes: readonly TreeNodeLike[]): string[] {
  const ids: string[] = [];
  const walk = (list: readonly TreeNodeLike[]) => {
    for (const node of list) {
      if (isUsableTreeNode(node) && node.nodeId) ids.push(node.nodeId);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}

/**
 * Overlay only active collaboration. Idle Nodes do not gain a todo/done state;
 * accepted history remains on Task/Delivery, not on the Node projection.
 */
export function applyNodeCollaborationsToTree<T extends TreeNodeLike>(
  nodes: T[],
  byNodeId: ReadonlyMap<string, NodeCollaborationView>
): T[] {
  return nodes.map((node) => applyOne(node, byNodeId));
}

function applyOne<T extends TreeNodeLike>(
  node: T,
  byNodeId: ReadonlyMap<string, NodeCollaborationView>
): T {
  const children = node.children?.length
    ? node.children.map((child) => applyOne(child as T, byNodeId))
    : node.children;
  const next = { ...node, children } as T;
  delete (next as TreeNodeLike).status;
  delete (next as TreeNodeLike).assignee;
  if (!isUsableTreeNode(node)) return next;
  const active = byNodeId.get(node.nodeId)?.activeTask?.task;
  if (!active) return next;
  (next as TreeNodeLike).status = "doing";
  const assignee = active.assigneeKind === "agentProfile" ? active.profileId : active.role;
  if (assignee) (next as TreeNodeLike).assignee = assignee;
  return next;
}

export function nodeCollaborationSummaryLine(
  projection: NodeCollaborationView | null | undefined
): string | null {
  if (!projection) return null;
  if (!projection.activeTask) return "无活动任务";
  const first = projection.activeTask.task;
  const assignee = first?.assigneeKind === "agentProfile" ? first.profileId : first?.role;
  return `活动任务${assignee ? ` · ${assignee}` : ""}`;
}
