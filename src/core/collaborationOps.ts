import { withTentMutation, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import type { OpsEnv } from "./ops-context.js";
import { validateProposalTarget } from "./proposal.js";
import { isUsableBox, join, loadTent } from "./tree.js";

export interface ProposeResult {
  proposalPath: string;
}

export interface ApplyGrant {
  targetId: string;
  targetPath: string;
  instructions: string;
}

export async function propose(
  env: OpsEnv,
  targetId: string,
  role: string,
  body: string
): Promise<ProposeResult> {
  return withTentMutation(env.fs, async () => {
    const roleName = assertRoleName(role);
    const tent = await loadTent(env.fs);
    const check = validateProposalTarget(tent, targetId);
    if (!check.ok) throw new Error(check.reason || "proposal target 不可用");
    const content = body.trim();
    if (!content) throw new Error("proposal 正文不能为空");

    const dir = join("temp", roleName, "proposals");
    await ensureDir(env.fs, dir);
    const proposalPath = await uniqueProposalPath(
      env.fs,
      dir,
      targetId,
      env.clock.now()
    );
    const data: Record<string, unknown> = {
      type: "proposal",
      target: targetId,
      status: "open",
      from: roleName,
    };
    await env.fs.writeFile(
      proposalPath,
      serializeFrontmatter(
        data,
        content + "\n",
        ["type", "target", "status", "from", "note"]
      )
    );
    return { proposalPath };
  });
}

export async function applyProposal(
  env: OpsEnv,
  proposalPath: string,
  accept: boolean,
  note?: string
): Promise<void> {
  await withTentMutation(env.fs, async () => {
    const raw = await env.fs.readFile(proposalPath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    if (accept) {
      const targetId = typeof data.target === "string"
        ? data.target
        : String(data.target || "");
      const check = validateProposalTarget(await loadTent(env.fs), targetId);
      if (!check.ok) throw new Error(check.reason || "proposal target 不可用");
    }
    data.status = accept ? "accepted" : "rejected";
    if (note) data.note = note;
    await env.fs.writeFile(
      proposalPath,
      serializeFrontmatter(data, body, keyOrder)
    );
  });
}

export async function startApply(
  env: OpsEnv,
  proposalPath: string
): Promise<ApplyGrant> {
  const { data, body } = parseFrontmatter(await env.fs.readFile(proposalPath));
  if (data.status !== "accepted") {
    throw new Error(
      `proposal 不是 accepted 状态(当前 ${data.status});只有 user 批准过的才能落地`
    );
  }
  const targetId = String(data.target);
  const tent = await loadTent(env.fs);
  const check = validateProposalTarget(tent, targetId);
  if (!check.ok || !check.target) {
    throw new Error(check.reason || `找不到目标框 ${targetId}`);
  }
  const target = check.target;
  if (!isUsableBox(target)) {
    throw new Error(`目标框不可落地:${target.invalidReason || "已归档"}`);
  }
  return {
    targetId,
    targetPath: target.path,
    instructions: body.trim(),
  };
}

export async function finishApply(
  env: OpsEnv,
  proposalPath: string
): Promise<void> {
  await withTentMutation(env.fs, async () => {
    const { data, body, keyOrder } = parseFrontmatter(
      await env.fs.readFile(proposalPath)
    );
    if (data.status !== "accepted") {
      throw new Error("proposal 不是 accepted 状态,无法收尾");
    }
    data.status = "applied";
    await env.fs.writeFile(
      proposalPath,
      serializeFrontmatter(data, body, keyOrder)
    );
  });
}

async function ensureDir(fs: FsAdapter, path: string): Promise<void> {
  if (path && !(await fs.exists(path))) await fs.mkdir(path);
}

function assertRoleName(role: string): string {
  const name = role.trim();
  if (!name) throw new Error("role 名不能为空");
  if (/[\/\\\r\n]/.test(name)) {
    throw new Error("role 名不能包含路径分隔符或换行");
  }
  return name;
}

async function uniqueProposalPath(
  fs: FsAdapter,
  dir: string,
  targetId: string,
  now: string
): Promise<string> {
  const stamp = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 18) || "proposal";
  const safeTarget = targetId.replace(/[^0-9A-Za-z_-]+/g, "-") || "target";
  let index = 1;
  while (true) {
    const suffix = index === 1 ? "" : `-${index}`;
    const path = join(dir, `pr-${stamp}-${safeTarget}${suffix}.md`);
    if (!(await fs.exists(path))) return path;
    index += 1;
  }
}
