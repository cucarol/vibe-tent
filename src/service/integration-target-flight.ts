/**
 * Production Git integration flight keyed by canonical workspace + targetBranch.
 *
 * Cross-Task accept/deliver integrate paths that share the same integration target
 * must serialize here — not by taskPath (per-Task lifecycle flight alone is not enough).
 * Hold this lock around review-time target HEAD re-read and every Git write/rollback.
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import { MutationBus } from "./mutation-bus.js";

const queue = new MutationBus();

/**
 * Canonical workspace identity for lock keys (realpath when possible).
 * Different path spellings of the same repo must share one target flight.
 */
export async function canonicalWorkspaceLockKey(workspaceRoot: string): Promise<string> {
  const resolved = nodePath.resolve(workspaceRoot);
  try {
    return await nodeFs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function targetFlightKey(canonicalWorkspace: string, targetBranch: string): string {
  // Intentionally NOT taskPath — two Tasks integrating into the same target serialize.
  return `${canonicalWorkspace}\0${targetBranch.trim()}`;
}

/**
 * Run `action` exclusively for (canonical workspace, targetBranch).
 * Nested calls with the same key queue FIFO via MutationBus.
 */
export async function runIntegrationTargetFlight<T>(
  workspaceRoot: string,
  targetBranch: string,
  action: () => Promise<T>
): Promise<T> {
  const branch = targetBranch.trim();
  if (!branch) {
    throw new Error("runIntegrationTargetFlight requires a non-empty targetBranch");
  }
  const canonical = await canonicalWorkspaceLockKey(workspaceRoot);
  return queue.run(targetFlightKey(canonical, branch), action);
}
