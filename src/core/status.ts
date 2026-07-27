import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FsAdapter } from "./adapter.js";
import { loadProposals } from "./proposal.js";
import { loadTaskEnvelopes } from "./task.js";
import { loadTent, type LoadedTent } from "./tree.js";
import { envelopeIsActiveOccupation } from "./claim.js";
import { resolveTentWorkspace } from "./workspace.js";

export const NOT_INSIDE_TENT_MESSAGE = "Not inside a Tent (no .tent/ system root with RULES.md found).";

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
      const box = tent.byId.get(proposal.boxId);
      const first = proposal.body.split("\n").map((line) => line.trim()).find(Boolean) || "(empty proposal)";
      lines.push(`- ${proposal.boxId}: ${box?.name ?? "(missing box)"} (${proposal.role}) - ${first}`);
    }
  }

  const allTasks = await loadTaskEnvelopes(fsAdapter);
  const pendingTasks = allTasks
    .filter((task) => task.state === "queued" || task.status === "pending")
    .filter((task) => !role || task.role === role);
  lines.push("");
  if (pendingTasks.length === 0) {
    lines.push("Pending tasks (task-ack): none");
  } else {
    lines.push("Pending tasks (task-ack):");
    for (const task of pendingTasks) {
      lines.push(`- ${task.role}/${path.posix.basename(task.path)} -> ${task.claims.join(", ")}`);
    }
  }

  // Claimed occupation only (running/waiting/delivered). Queued stays under Pending tasks.
  const activeTasks = allTasks
    .filter((task) => envelopeIsActiveOccupation(task))
    .filter((task) => task.state !== "queued" && task.status !== "pending")
    .filter((task) => !role || task.role === role);
  lines.push("");
  if (activeTasks.length === 0) {
    lines.push("Active tasks: none");
  } else {
    lines.push("Active tasks:");
    for (const task of activeTasks) {
      const state = task.state || task.status || "unknown";
      lines.push(
        `- ${task.id || path.posix.basename(task.path)}: ${task.role} [${state}] claims=${task.claims.join(",")}`
      );
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * 定位 tent system root：
 * 1. cwd 本身是 system root（含 RULES.md + types.json 或 temp/）
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
  if (!(await exists(path.join(root, "RULES.md")))) return false;
  // 新布局：注册表扁平在 system root；兼容极旧 fixture 仍有嵌套 .tent 的判定略宽松
  return (
    (await exists(path.join(root, "types.json"))) ||
    (await exists(path.join(root, "temp"))) ||
    (await exists(path.join(root, ".tent")))
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
