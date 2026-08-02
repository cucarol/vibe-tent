import type { TaskEnvelope } from "../core/task.js";
import { taskReferencedNodeIds } from "../core/task-node-refs.js";

export interface PendingDispatch {
  nodeId: string;
  task: TaskEnvelope;
}

export function pendingDispatches(tasks: TaskEnvelope[]): PendingDispatch[] {
  const latestByBox = new Map<string, TaskEnvelope>();
  for (const task of [...tasks].sort(compareTaskOrder)) {
    if (task.contextCard == null) continue;
    for (const nodeId of taskReferencedNodeIds(task)) {
      if (nodeId !== "root") latestByBox.set(nodeId, task);
    }
  }

  const pending: PendingDispatch[] = [];
  for (const [nodeId, task] of latestByBox) {
    if (task.state !== "queued") continue;
    pending.push({ nodeId, task });
  }
  return pending;
}

function compareTaskOrder(a: TaskEnvelope, b: TaskEnvelope): number {
  const aName = a.path.slice(a.path.lastIndexOf("/") + 1);
  const bName = b.path.slice(b.path.lastIndexOf("/") + 1);
  return aName.localeCompare(bName) || a.path.localeCompare(b.path);
}
