import type { TaskEnvelope } from "../core/task.js";

export interface PendingDispatch {
  boxId: string;
  task: TaskEnvelope;
}

export function pendingDispatches(tasks: TaskEnvelope[]): PendingDispatch[] {
  const latestByBox = new Map<string, TaskEnvelope>();
  for (const task of [...tasks].sort(compareTaskOrder)) {
    for (const boxId of task.claims) {
      if (boxId !== "root") latestByBox.set(boxId, task);
    }
  }

  const pending: PendingDispatch[] = [];
  for (const [boxId, task] of latestByBox) {
    if (task.status === "taken") continue;
    pending.push({ boxId, task });
  }
  return pending;
}

function compareTaskOrder(a: TaskEnvelope, b: TaskEnvelope): number {
  const aName = a.path.slice(a.path.lastIndexOf("/") + 1);
  const bName = b.path.slice(b.path.lastIndexOf("/") + 1);
  return aName.localeCompare(bName) || a.path.localeCompare(b.path);
}
