import type { LoadedTent } from "./tree.js";
import type { FsAdapter } from "./adapter.js";
import { loadTaskEnvelopes } from "./task.js";
import { envelopeIsActiveOccupation, occupiedBoxesFromTasks } from "./claim.js";
import { taskDirectlyReferencesNode } from "./task-node-refs.js";

/**
 * Inbox item: active task occupation on a box.
 * Legacy owner-based grouping is retired; inbox is task-derived when tasks are provided.
 */
export type InboxItem =
  | { state: "stale"; role: string; boxPath: string; boxId: string; taskId?: string };

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
  const tasks = await loadTaskEnvelopes(fs);
  const occupied = occupiedBoxesFromTasks(tent as LoadedTent, tasks);
  const items: InboxItem[] = [];
  for (const box of occupied) {
    if (box.invalid || box.archived) continue;
    const task = tasks.find(
      (t) => envelopeIsActiveOccupation(t) && taskDirectlyReferencesNode(t, box.id)
    );
    if (!task) continue;
    items.push({
      state: "stale",
      role: task.role,
      boxPath: box.path,
      boxId: box.id,
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
