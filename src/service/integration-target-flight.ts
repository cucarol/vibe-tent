/**
 * Production Git integration flight keyed by canonical Git repository identity.
 *
 * Lock identity = absolute realpath(git-common-dir) + fully resolved target ref
 * (e.g. refs/heads/main). NOT workspaceId, taskPath, or a merely lexical workspace
 * path: the same repo/target may be mounted or projection-addressed through
 * different workspaceIds/worktrees. workspaceId is audit only.
 *
 * Hold this lock around review-time target HEAD re-read and every Git write/rollback.
 */
import {
  resolveIntegrationTargetLockIdentity,
  type IntegrationTargetLockIdentity,
} from "../core/workspace.js";
import { MutationBus } from "./mutation-bus.js";

const queue = new MutationBus();

export type { IntegrationTargetLockIdentity };

/**
 * Canonical integration lock key for (repo common-dir, fully resolved target ref).
 * Worktree path aliases of one repo share the same key.
 */
export async function integrationTargetLockKey(
  workspaceRoot: string,
  targetBranch: string
): Promise<string> {
  const id = await resolveIntegrationTargetLockIdentity(workspaceRoot, targetBranch);
  return targetFlightKey(id);
}

function targetFlightKey(id: IntegrationTargetLockIdentity): string {
  // Intentionally NOT workspaceId / taskPath / lexical workspace path.
  return `${id.gitCommonDir}\0${id.targetRef}`;
}

/**
 * Run `action` exclusively for the resolved (git-common-dir, target ref) identity.
 * Nested calls with the same key queue FIFO via MutationBus.
 */
export async function runIntegrationTargetFlight<T>(
  workspaceRoot: string,
  targetBranch: string,
  action: () => Promise<T>
): Promise<T> {
  const id = await resolveIntegrationTargetLockIdentity(workspaceRoot, targetBranch);
  return queue.run(targetFlightKey(id), action);
}
