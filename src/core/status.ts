import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../fs/node-fs.js";
import { loadProposals } from "./proposal.js";
import { loadTaskEnvelopes } from "./task.js";
import { loadTent, type LoadedTent } from "./tree.js";
import type { Box } from "./types.js";
import { resolveTentWorkspace } from "./workspace.js";

export const NOT_INSIDE_TENT_MESSAGE = "Not inside a Tent (no .tent/RULES.md found).";

export async function renderTentStatus(cwd = process.cwd(), role = process.env.TENT_ROLE): Promise<string> {
  const root = path.resolve(cwd);
  if (!(await isTentRoot(root))) throw new Error(NOT_INSIDE_TENT_MESSAGE);

  const fsAdapter = new NodeFs(root);
  const tent = await loadTent(fsAdapter);
  const workspace = resolveTentWorkspace(tent);
  const lines = [
    `Tent: ${root}`,
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

  const tasks = (await loadTaskEnvelopes(fsAdapter))
    .filter((task) => task.status === "pending")
    .filter((task) => hasUndoneClaim(tent, task.claims))
    .filter((task) => !role || task.role === role);
  lines.push("");
  if (tasks.length === 0) {
    lines.push("Pending tasks (task-ack): none");
  } else {
    lines.push("Pending tasks (task-ack):");
    for (const task of tasks) {
      lines.push(`- ${task.role}/${path.posix.basename(task.path)} -> ${task.claims.join(", ")}`);
    }
  }

  const claims = activeClaimBoxes(tent);
  lines.push("");
  if (claims.length === 0) {
    lines.push("Active claims: none");
  } else {
    lines.push("Active claims:");
    for (const box of claims) {
      lines.push(`- ${box.id}: ${box.name} (owner: ${box.fm.owner}, status: ${box.fm.status || "none"})`);
    }
  }

  return lines.join("\n") + "\n";
}

async function isTentRoot(root: string): Promise<boolean> {
  return (await exists(path.join(root, ".tent"))) && (await exists(path.join(root, "RULES.md")));
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function activeClaimBoxes(tent: LoadedTent): Box[] {
  return [...tent.byId.values()]
    .filter((box) => !!box.fm.owner)
    .sort((a, b) => a.path.localeCompare(b.path));
}

function hasUndoneClaim(tent: LoadedTent, claims: string[]): boolean {
  if (claims.length === 0 || claims.includes("root")) return true;
  return claims.some((claim) => tent.byId.get(claim)?.fm.status !== "done");
}
