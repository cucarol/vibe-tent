/**
 * Per-Task lifecycle flight (workspaceId+taskPath).
 * Spans prepare -> Git -> finalize for conflicting ops. MutationBus stays short;
 * Git is outside the workspace-wide bus. Not held across provider turns.
 */
import { MutationBus } from "./mutation-bus.js";

const queue = new MutationBus();
const key = (ws: string, path: string) => `${ws}\0${path}`;

export function runTaskLifecycle<T>(
  workspaceId: string,
  taskPath: string,
  action: () => Promise<T>
): Promise<T> {
  return queue.run(key(workspaceId, taskPath), action);
}
