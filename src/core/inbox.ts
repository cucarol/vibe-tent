import type { LoadedTent } from "./tree.js";
import type { FsAdapter } from "./adapter.js";
import { loadTaskRecords, taskExecutionLabel } from "./task.js";
import { taskIsActiveOccupation, occupiedNodesFromTasks } from "./claim.js";
import { taskDirectlyReferencesNode } from "./task-node-refs.js";

/**
 * Inbox item: active task occupation on a node.
 * Legacy owner-based grouping is retired; inbox is task-derived when tasks are provided.
 */
export type InboxItem =
  | { state: "stale"; role: string; nodePath: string; nodeId: string; taskId?: string };

/**
 * Aggregate inbox from active Task envelopes.
 * When `fs` is omitted (legacy call with only tent), returns empty — owner FM is not product truth.
 */
export async function buildInbox(
  tent: LoadedTentLike,
  fs?: FsAdapter
): Promise<InboxItem[]> {
  if (!fs) {
    // Structural-only callers (no task oracle): empty inbox — do not scan fm.owner.
    return [];
  }
  const tasks = await loadTaskRecords(fs);
  const occupied = occupiedNodesFromTasks(tent as LoadedTent, tasks);
  const items: InboxItem[] = [];
  for (const node of occupied) {
    if (node.invalid || node.archived) continue;
    const task = tasks.find(
      (t) => taskIsActiveOccupation(t) && taskDirectlyReferencesNode(t, node.id)
    );
    if (!task) continue;
    items.push({
      state: "stale",
      role: taskExecutionLabel(task),
      nodePath: node.path,
      nodeId: node.id,
      taskId: task.id || task.path,
    });
  }
  return items;
}

/** 需要 user 裁定的条目数。认领中不计。 */
export function pendingCount(_items: InboxItem[]): number {
  return 0;
}

// 避免循环依赖:只需要 byId 这一面。
interface LoadedTentLike {
  byId: LoadedTent["byId"];
  roots?: LoadedTent["roots"];
}
