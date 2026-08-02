import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FsAdapter } from "./adapter.js";
import { loadProposals } from "./proposal.js";
import { loadTaskEnvelopes } from "./task.js";
import { loadTent, type LoadedTent } from "./tree.js";
import { envelopeIsActiveOccupation } from "./claim.js";
import { taskReferencedNodeIds } from "./task-node-refs.js";
import { resolveTentWorkspace } from "./workspace.js";
import { INDEX_PATH } from "./paths.js";

export const NOT_INSIDE_TENT_MESSAGE = "Not inside a Tent (no .tent/index.md marker found).";

/** Host factory for Node/Obsidian FsAdapter — Core never imports `src/fs`. */
export type StatusFsFactory = (systemRoot: string) => FsAdapter;

export async function renderTentStatus(
  cwd = process.cwd(),
  role = process.env.TENT_ROLE,
  createFs?: StatusFsFactory
): Promise<string> {
  const systemRoot = await findTentSystemRoot(cwd);
  if (!systemRoot) throw new Error(NOT_INSIDE_TENT_MESSAGE);
  if (!createFs) {
    throw new Error(
      "renderTentStatus requires createFs (host FsAdapter factory); Core does not import src/fs"
    );
  }

  const fsAdapter = createFs(systemRoot);
  const tent = await loadTent(fsAdapter);
  const workspace = resolveTentWorkspace(tent, systemRoot);
  const lines = [
    `Tent: ${systemRoot}`,
    `Workspace: ${workspace || "(none)"}`,
    "",
  ];

  const proposals = (await loadProposals(fsAdapter)).filter((proposal) => proposal.status === "pending");
  if (proposals.length === 0) {
    lines.push("Pending proposals: none");
  } else {
    lines.push("Pending proposals:");
    for (const proposal of proposals) {
      const node = tent.byId.get(proposal.nodeId);
      const first = proposal.body.split("\n").map((line) => line.trim()).find(Boolean) || "(empty proposal)";
      lines.push(`- ${proposal.nodeId}: ${node?.name ?? "(missing node)"} (${proposal.role}) - ${first}`);
    }
  }

  const allTasks = await loadTaskEnvelopes(fsAdapter);
  const pendingTasks = allTasks
    .filter((task) => task.state === "queued")
    .filter((task) => !role || (task.assigneeKind === "role" && task.assigneeId === role));
  lines.push("");
  if (pendingTasks.length === 0) {
    lines.push("Pending tasks: none");
  } else {
    lines.push("Pending tasks:");
    for (const task of pendingTasks) {
      const nodeIds = taskReferencedNodeIds(task);
      lines.push(
        `- ${task.assigneeKind}:${task.assigneeId}/${path.posix.basename(task.path)} -> ${nodeIds.join(", ") || "-"}`
      );
    }
  }

  // Claimed occupation only (running/waiting/delivered). Queued stays under Pending tasks.
  const activeTasks = allTasks
    .filter((task) => envelopeIsActiveOccupation(task))
    .filter((task) => task.state !== "queued")
    .filter((task) => !role || (task.assigneeKind === "role" && task.assigneeId === role));
  lines.push("");
  if (activeTasks.length === 0) {
    lines.push("Active tasks: none");
  } else {
    lines.push("Active tasks:");
    for (const task of activeTasks) {
      const state = task.state;
      const nodeIds = taskReferencedNodeIds(task);
      lines.push(
        `- ${task.id || path.posix.basename(task.path)}: ${task.assigneeKind}:${task.assigneeId} [${state}] nodes=${nodeIds.join(",") || "-"}`
      );
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * 定位 tent system root：
 * 1. cwd 本身是 system root（含 index.md marker）
 * 2. cwd 下有 `.tent/` system dir（workspace 根）
 * 3. 向上查找（兼容从子目录调用）
 */
export async function findTentSystemRoot(cwd = process.cwd()): Promise<string | undefined> {
  let dir = path.resolve(cwd);
  for (;;) {
    if (await isSystemRoot(dir)) return dir;
    const nested = path.join(dir, ".tent");
    if (await isSystemRoot(nested)) return nested;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function isSystemRoot(root: string): Promise<boolean> {
  return exists(path.join(root, INDEX_PATH));
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
