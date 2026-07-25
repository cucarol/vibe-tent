// 工单(manifest)生成 —— 派活的硬执行层之一。
// V0.2: readable/writable lists are **context pointers** (claim scope + system paths),
// not domain R/W axes on Nodes. Deterministic for any agent/process.

import { Box, Manifest, ManifestEntry } from "./types.js";
import { isUsableBox, LoadedTent, join } from "./tree.js";

export interface DispatchInput {
  tentName: string;
  role: string;
  claimBoxes?: Box[];
  claimRoot?: boolean;
  workspace?: string;
  worktree?: string;
  branch?: string;
  targetBranch?: string;
}

export function buildManifest(tent: LoadedTent, input: DispatchInput): Manifest {
  const { role } = input;
  const claimBoxes = input.claimRoot ? tent.roots : requireClaimBoxes(input);
  const claimScope = input.claimRoot
    ? allBoxes(tent).filter(isUsableBox)
    : claimBoxes.flatMap(subtree);

  const readable: ManifestEntry[] = [];
  const writable: ManifestEntry[] = [];

  // Context readable set: all usable concepts (semantic context for the agent).
  for (const box of allBoxes(tent)) {
    if (isUsableBox(box)) {
      readable.push({ id: box.id, path: box.path, note: oneLineNote(box) });
    }
  }
  readable.push({ path: "roles.json", note: "System registry: available roles and persistent prompts." });
  readable.push({ path: "temp/", note: "System pipeline: read all role temp state." });

  // Context writable set: claim scope (mutation authority is Task/Service, not this list).
  for (const box of claimScope) {
    if (isUsableBox(box)) {
      writable.push({ id: box.id, path: box.path });
    }
  }
  if (input.claimRoot) {
    writable.push({ path: "./", note: "Structural permission: may create/move top-level boxes at the Tent root." });
  }
  for (const box of claimScope) {
    writable.push({ id: box.id, path: `${box.path}/`, note: "Structural permission: may create/move/delete child boxes under this box." });
  }
  // 角色 temp 格(总是可写)
  writable.push({ path: join("temp", role) + "/" });

  return {
    tent: input.tentName,
    role,
    claims: input.claimRoot ? ["root"] : claimBoxes.map((box) => box.id),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.worktree ? { worktree: input.worktree } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.targetBranch ? { targetBranch: input.targetBranch } : {}),
    readable: dedupe(readable),
    writable: dedupe(writable),
  };
}

/** 把 manifest 序列化成 YAML(落盘 + 进 prompt)。 */
export function manifestToYaml(m: Manifest): string {
  const lines: string[] = [];
  lines.push(`tent: ${m.tent}`);
  lines.push(`role: ${m.role}`);
  lines.push(`claims: [${m.claims.join(", ")}]`);
  if (m.workspace) lines.push(`workspace: ${yamlStr(m.workspace)}`);
  if (m.worktree) lines.push(`worktree: ${yamlStr(m.worktree)}`);
  if (m.branch) lines.push(`branch: ${yamlStr(m.branch)}`);
  if (m.targetBranch) lines.push(`targetBranch: ${yamlStr(m.targetBranch)}`);
  lines.push(`readable:`);
  for (const e of m.readable) lines.push(`  - ${entryLine(e)}`);
  lines.push(`writable:`);
  for (const e of m.writable) lines.push(`  - ${entryLine(e)}`);
  return lines.join("\n") + "\n";
}

function entryLine(e: ManifestEntry): string {
  const parts: string[] = [];
  if (e.id) parts.push(`id: ${e.id}`);
  parts.push(`path: ${yamlStr(e.path)}`);
  if (e.note) parts.push(`note: ${yamlStr(e.note)}`);
  return `{${parts.join(", ")}}`;
}

function yamlStr(s: string): string {
  return /[:#{}\[\],]/.test(s) ? JSON.stringify(s) : s;
}

function oneLineNote(box: Box): string {
  // 身份文件正文第一行非空文字当摘要
  const firstLine = box.body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return firstLine ? firstLine.slice(0, 40) : box.type;
}

function allBoxes(tent: LoadedTent): Box[] {
  return [...tent.byPath.values()];
}

function subtree(box: Box): Box[] {
  const out: Box[] = [box];
  for (const c of box.children) out.push(...subtree(c));
  return out;
}

function requireClaimBoxes(input: DispatchInput): Box[] {
  if (!input.claimBoxes || input.claimBoxes.length === 0) throw new Error("Missing claim boxes.");
  return input.claimBoxes;
}

function dedupe(entries: ManifestEntry[]): ManifestEntry[] {
  const seen = new Set<string>();
  const out: ManifestEntry[] = [];
  for (const e of entries) {
    const key = `${e.id ?? ""}|${e.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
