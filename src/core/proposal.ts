// proposal 聚合 + 收件箱条目。proposal 是状态不是框:一个 prompt 文件,
// frontmatter target/status/from/note,落在 temp/<角色>/proposals/。
// 面板按 target 聚合,在目标框上标"N 待裁"。

import { FsAdapter } from "./adapter.js";
import { parseFrontmatter } from "./frontmatter.js";
import { join } from "./tree.js";
import type { LoadedTent } from "./tree.js";
import type { Box } from "./types.js";

export type ProposalStatus = "open" | "accepted" | "rejected" | "applied";

export interface Proposal {
  /** 文件相对帐根的路径。 */
  path: string;
  target: string;
  status: ProposalStatus;
  from: string;
  note?: string;
  body: string;
}

export interface ProposalTargetCheck {
  ok: boolean;
  reason?: string;
  target?: Box;
}

/** 收件箱四类条目。 */
export type InboxItem =
  | { kind: "proposal"; proposal: Proposal }
  | { kind: "invalid-proposal"; proposal: Proposal; reason: string }
  | { kind: "stale"; role: string; boxPath: string; boxId: string };

/** 扫 temp/<角色>/proposals/ 收集所有 open 状态 proposal。 */
export async function loadProposals(fs: FsAdapter): Promise<Proposal[]> {
  const out: Proposal[] = [];
  if (!(await fs.exists("temp"))) return out;
  const roles = await fs.listDir("temp");
  for (const r of roles) {
    if (!r.isDir) continue;
    const propDir = join("temp", r.name, "proposals");
    if (!(await fs.exists(propDir))) continue;
    const files = await fs.listDir(propDir);
    for (const f of files) {
      if (f.isDir || !f.name.endsWith(".md")) continue;
      const path = join(propDir, f.name);
      const { data, body } = parseFrontmatter(await fs.readFile(path));
      if (typeof data.target !== "string") continue;
      out.push({
        path,
        target: data.target,
        status: (data.status as ProposalStatus) || "open",
        from: typeof data.from === "string" ? data.from : r.name,
        note: typeof data.note === "string" ? data.note : undefined,
        body,
      });
    }
  }
  return out;
}

/** 按 target 数 open proposal,给树上徽章用。 */
export function countByTarget(proposals: Proposal[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of proposals) {
    if (p.status !== "open") continue;
    m.set(p.target, (m.get(p.target) || 0) + 1);
  }
  return m;
}

/** 聚合收件箱:open proposal + 当前认领。report 由 temp/<role>/reports 独立聚合。 */
export async function buildInbox(
  _fs: FsAdapter,
  tent: LoadedTentLike,
  proposals: Proposal[]
): Promise<InboxItem[]> {
  const items: InboxItem[] = [];
  for (const p of proposals) {
    if (p.status !== "open") continue;
    const check = validateProposalTarget(tent, p.target);
    if (check.ok) items.push({ kind: "proposal", proposal: p });
    else items.push({ kind: "invalid-proposal", proposal: p, reason: check.reason || "目标不可用" });
  }
  for (const box of tent.byId.values()) {
    if (box.invalid || box.archived) continue;
    const role = box.fm.owner;
    if (!role) continue;
    items.push({ kind: "stale", role, boxPath: box.path, boxId: box.id });
  }
  return items;
}

export function validateProposalTarget(tent: LoadedTentLike, targetId: string): ProposalTargetCheck {
  const target = tent.byId.get(targetId) as Box | undefined;
  if (!target) return { ok: false, reason: `找不到目标框 ${targetId}` };
  if (target.invalid || target.archived) return { ok: false, reason: `目标框不可提 proposal:${target.invalidReason || "已归档"}` };
  if (!target.readable.value) return { ok: false, reason: `目标框不可读,不能提 proposal: ${targetId}` };
  return { ok: true, target };
}

/** 需要 user 裁定的条目数 = 待裁 proposal；认领中不计。 */
export function pendingCount(items: InboxItem[]): number {
  return items.filter((i) => i.kind === "proposal" || i.kind === "invalid-proposal").length;
}

// 避免循环依赖:只需要 byId 这一面。
interface LoadedTentLike {
  byId: LoadedTent["byId"];
}
