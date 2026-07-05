// 工单(manifest)生成 —— 派活的硬执行层之一。
// 算可读集/可写集:
//   可读集 = 帐内所有 readable=true 的框 + 系统 temp 管道
//   可写集 = 认领子树里所有 writable=true 的框 + 该角色的 temp 格
// 这是确定性算法,任何 agent/进程跑出来必须一字不差。

import { Box, Manifest, ManifestEntry } from "./types.js";
import { isUsableBox, LoadedTent, join } from "./tree.js";
import { splitType } from "./typeRegistry.js";

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

  // 可读集:帐内全部 readable=true 的框(含认领子树内的)
  for (const box of allBoxes(tent)) {
    if (isUsableBox(box) && box.readable.value) {
      readable.push({ id: box.id, path: box.path, note: oneLineNote(box) });
    }
  }
  readable.push({ path: ".tent/roles.json", note: "System registry: available roles and persistent prompts." });
  readable.push({ path: "temp/", note: "System pipe: read all role tasks, proposals, and deliveries." });

  // 可写集:认领子树里 writable=true 的框
  for (const box of claimScope) {
    if (isUsableBox(box) && box.writable.value) {
      writable.push({ id: box.id, path: box.path });
    }
  }
  if (input.claimRoot) {
    writable.push({ path: "./", note: "Structure permission: may create/move top-level boxes at the Tent root." });
  }
  for (const box of claimScope) {
    writable.push({ id: box.id, path: `${box.path}/`, note: "Structure permission: may create/move/delete child boxes under this box." });
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
    preloaded: buildPreloaded(tent),
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
  lines.push(`preloaded:`);
  for (const p of m.preloaded) lines.push(`  - ${p}`);
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

function buildPreloaded(tent: LoadedTent): string[] {
  const order = treeOrder(tent);
  const entries = allBoxes(tent)
    .filter((box) => isUsableBox(box) && box.readable.value)
    .sort((a, b) => {
      const stable = preloadStabilityRank(a) - preloadStabilityRank(b);
      if (stable !== 0) return stable;
      const type = preloadTypeRank(a) - preloadTypeRank(b);
      if (type !== 0) return type;
      return (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id);
    })
    .map((box) => `${box.path} body`);
  return ["RULES.md", ...entries];
}

function preloadStabilityRank(box: Box): number {
  const status = box.fm.status || "todo";
  if (box.writable.value || box.fm.owner || status === "doing") return 1;
  return 0;
}

function preloadTypeRank(box: Box): number {
  const base = splitType(box.type).base;
  if (base === "goal") return 0;
  if (base === "prompt") return 1;
  if (base === "output") return 2;
  return 3;
}

function treeOrder(tent: LoadedTent): Map<string, number> {
  const order = new Map<string, number>();
  let n = 0;
  const visit = (box: Box) => {
    order.set(box.id, n++);
    for (const child of box.children) visit(child);
  };
  for (const root of tent.roots) visit(root);
  return order;
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
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    out.push(e);
  }
  return out;
}
