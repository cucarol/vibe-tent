// 工单(manifest)生成 —— 派活的硬执行层之一。
// V0.2: readable/writable lists are **context pointers** (dispatch selection scope +
// system paths), not domain R/W axes on Nodes. Deterministic for any agent/process.
// DispatchInput.claimNodes / claimRoot are ephemeral caller-side selection only —
// Manifest YAML is auxiliary; Task Context Card v2 is the sole frozen Node context wire.

import { Node, Manifest, ManifestEntry } from "./types.js";
import { isUsableNode, LoadedTent, join } from "./tree.js";

export interface DispatchInput {
  tentName: string;
  roleId?: string;
  sessionId?: string;
  /** Ephemeral dispatch selection (nodes in writable scope). Not persisted as claims. */
  claimNodes?: Node[];
  /** Ephemeral root/workspace selection. Not persisted as claims. */
  claimRoot?: boolean;
  workspace?: string;
  worktree?: string;
  branch?: string;
  targetBranch?: string;
}

export function buildManifest(tent: LoadedTent, input: DispatchInput): Manifest {
  const roleId = input.roleId?.trim();
  const sessionId = input.sessionId?.trim();
  if (!roleId && !sessionId) throw new Error("Manifest requires roleId or sessionId.");
  const claimNodes = input.claimRoot ? tent.roots : requireClaimNodes(input);
  const claimScope = input.claimRoot
    ? allNodes(tent).filter(isUsableNode)
    : claimNodes.flatMap(subtree);

  const readable: ManifestEntry[] = [];
  const writable: ManifestEntry[] = [];

  // Context readable set: all usable Nodes (semantic context for the agent).
  for (const node of allNodes(tent)) {
    if (isUsableNode(node)) {
      readable.push({ id: node.id, path: node.path, note: oneLineNote(node) });
    }
  }
  readable.push({ path: "roles.json", note: "System registry: available roles and persistent prompts." });
  readable.push({ path: "temp/", note: "System pipeline: read all role temp state." });

  // Context writable set: dispatch selection scope (mutation authority is Task/Service, not this list).
  for (const node of claimScope) {
    if (isUsableNode(node)) {
      writable.push({ id: node.id, path: node.path });
    }
  }
  if (input.claimRoot) {
    writable.push({ path: "./", note: "Structural permission: may create/move top-level nodes at the Tent root." });
  }
  for (const node of claimScope) {
    writable.push({ id: node.id, path: `${node.path}/`, note: "Structural permission: may create/move/delete child nodes under this node." });
  }
  const executorRoot = roleId
    ? join("temp", "roles", roleId)
    : join("temp", "sessions", sessionId!);
  writable.push({ path: executorRoot + "/" });

  return {
    tent: input.tentName,
    ...(roleId ? { roleId } : {}),
    ...(sessionId ? { sessionId } : {}),
    // No claims[] — writable ids/paths encode selection; Task Node refs are contextCard only.
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.worktree ? { worktree: input.worktree } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.targetBranch ? { targetBranch: input.targetBranch } : {}),
    readable: dedupe(readable),
    writable: dedupe(writable),
  };
}

/** 把 manifest 序列化成 YAML(落盘 + 进 prompt)。 Never emits claims[]. */
export function manifestToYaml(m: Manifest): string {
  const lines: string[] = [];
  lines.push(`tent: ${m.tent}`);
  if (m.roleId) lines.push(`roleId: ${m.roleId}`);
  if (m.sessionId) lines.push(`sessionId: ${m.sessionId}`);
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

function oneLineNote(node: Node): string {
  // 身份文件正文第一行非空文字当摘要
  const firstLine = node.body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return firstLine ? firstLine.slice(0, 40) : node.type;
}

function allNodes(tent: LoadedTent): Node[] {
  return [...tent.byPath.values()];
}

function subtree(node: Node): Node[] {
  const out: Node[] = [node];
  for (const c of node.children) out.push(...subtree(c));
  return out;
}

function requireClaimNodes(input: DispatchInput): Node[] {
  if (!input.claimNodes || input.claimNodes.length === 0) throw new Error("Missing claim nodes.");
  return input.claimNodes;
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
