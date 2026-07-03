import type { TaskEnvelope } from "../core/task.js";

export interface PendingDispatch {
  boxId: string;
  task: TaskEnvelope;
}

export function dispatchAckKey(tentName: string, taskPath: string): string {
  return `${tentName}\0${taskPath}`;
}

export function rememberDispatchAck(
  acknowledged: string[],
  key: string,
  limit = 500
): string[] {
  const withoutCurrent = [...new Set(acknowledged)].filter((item) => item !== key);
  return [...withoutCurrent, key].slice(-Math.max(0, limit));
}

export function pendingDispatches(
  tasks: TaskEnvelope[],
  acknowledged: ReadonlySet<string>,
  ownerFor: (boxId: string) => string | undefined,
  tentName: string
): PendingDispatch[] {
  const latestByBox = new Map<string, TaskEnvelope>();
  for (const task of [...tasks].sort(compareTaskOrder)) {
    for (const boxId of task.claims) {
      if (boxId !== "root") latestByBox.set(boxId, task);
    }
  }

  const pending: PendingDispatch[] = [];
  for (const [boxId, task] of latestByBox) {
    if (ownerFor(boxId) !== task.role) continue;
    if (acknowledged.has(dispatchAckKey(tentName, task.path))) continue;
    pending.push({ boxId, task });
  }
  return pending;
}

function compareTaskOrder(a: TaskEnvelope, b: TaskEnvelope): number {
  const aName = a.path.slice(a.path.lastIndexOf("/") + 1);
  const bName = b.path.slice(b.path.lastIndexOf("/") + 1);
  return aName.localeCompare(bName) || a.path.localeCompare(b.path);
}
