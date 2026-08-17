import type {
  DesktopAcceptMode,
  DesktopDispatchTarget,
} from "./collaboration-ipc.js";

export const TENT_NODE_IDS_DRAG_TYPE = "application/x-tent-node-ids" as const;

export type TaskPackageDraft = {
  nodeIds: string[];
  nodeLabels: Record<string, string>;
  prompt: string;
  acceptMode: DesktopAcceptMode;
  targetKind: DesktopDispatchTarget["kind"];
  target: DesktopDispatchTarget | null;
};

export function emptyTaskPackageDraft(): TaskPackageDraft {
  return {
    nodeIds: [],
    nodeLabels: {},
    prompt: "",
    acceptMode: "review-required",
    targetKind: "role",
    target: null,
  };
}

export function addTaskPackageNodes(
  draft: TaskPackageDraft,
  nodes: readonly { nodeId: string; label?: string }[]
): TaskPackageDraft {
  const nodeIds = [...draft.nodeIds];
  const nodeLabels = { ...draft.nodeLabels };
  for (const node of nodes) {
    if (!nodeIds.includes(node.nodeId)) nodeIds.push(node.nodeId);
    if (node.label?.trim()) nodeLabels[node.nodeId] = node.label.trim();
  }
  return { ...draft, nodeIds, nodeLabels };
}

export function removeTaskPackageNode(
  draft: TaskPackageDraft,
  nodeId: string
): TaskPackageDraft {
  const nodeLabels = { ...draft.nodeLabels };
  delete nodeLabels[nodeId];
  return {
    ...draft,
    nodeIds: draft.nodeIds.filter((id) => id !== nodeId),
    nodeLabels,
  };
}

export function updateTransientNodeSelection(
  current: readonly string[],
  nodeId: string | null,
  toggle: boolean
): string[] {
  if (!nodeId) return [];
  if (!toggle) return [nodeId];
  return current.includes(nodeId)
    ? current.filter((id) => id !== nodeId)
    : [...current, nodeId];
}

export function encodeNodeIdsDrag(nodeIds: readonly string[]): string {
  return JSON.stringify({ nodeIds: [...new Set(nodeIds.filter(Boolean))] });
}

export function decodeNodeIdsDrag(value: string): string[] {
  try {
    const raw = JSON.parse(value) as { nodeIds?: unknown };
    return Array.isArray(raw.nodeIds)
      ? [...new Set(raw.nodeIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())))]
      : [];
  } catch {
    return [];
  }
}
