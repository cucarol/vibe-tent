import * as nodePath from "node:path";
import * as nodeFs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { LoadedTent } from "./tree.js";
import { parseOutputPointer } from "./output.js";
import type { RoleWorkspaceContract } from "./task.js";
import { workspaceRootFromSystemRoot } from "./paths.js";

export interface IntegrationResult {
  sourceRef: string;
  integratedRef: string;
  alreadyIntegrated: boolean;
}

export interface RoleCommit {
  ref: string;
  shortRef: string;
  subject: string;
}

export interface WorkspaceHead {
  ref: string;
  shortRef: string;
  branch: string;
}

export interface WorkspaceCheckResult {
  command: string;
  stdout: string;
  stderr: string;
}

/**
 * 解析一顶 Tent 对应的真实 workspace 根。
 *
 * B1 起：优先从 in-workspace 布局推导（system root 目录名为 `.tent` 时父目录即 workspace）。
 * 兼容迁移前：仍可读 concept 上的 `workspace:` 指针字段（不再依赖 type.workspacePointer 能力轴）。
 * 多指针冲突仍报错。不再使用「workspace pointer type」产品语义。
 */
export function resolveTentWorkspace(tent: LoadedTent, systemRoot?: string): string | undefined {
  if (systemRoot) {
    const fromLayout = workspaceRootFromSystemRoot(systemRoot);
    if (fromLayout) return nodePath.resolve(fromLayout);
  }

  const workspaces = new Set<string>();
  for (const box of tent.byPath.values()) {
    const workspace = parseOutputPointer(box.fm, box.body).workspace;
    if (workspace) workspaces.add(nodePath.resolve(workspace));
  }
  if (workspaces.size > 1) {
    throw new Error(`A Tent can reference only one workspace; found: ${[...workspaces].join(", ")}.`);
  }
  return [...workspaces][0];
}

/**
 * 判断 source commit 是否已合入 target 分支（ancestor 或 -x cherry-pick 痕迹）。
 * 供 Task API / complete 幂等复用；不修改仓库。
 */
export async function findIntegratedCommit(
  workspace: string,
  sourceRef: string,
  targetBranch: string
): Promise<{ integratedRef: string; reason: "ancestor" | "cherry-pick" } | undefined> {
  const root = nodePath.resolve(workspace);
  await assertGitWorkspace(root);
  const full = await fullRef(root, sourceRef);
  const ancestor = await findAncestorIntegration(root, full, targetBranch);
  if (ancestor) return { integratedRef: full, reason: "ancestor" };
  const prior = await findCherryPick(root, full);
  if (prior) return { integratedRef: prior, reason: "cherry-pick" };
  return undefined;
}

/** 读取正式分支当前 HEAD；只读，不要求 workspace 正 checkout 在正式分支。 */
export async function readWorkspaceHead(workspace: string): Promise<WorkspaceHead> {
  const root = nodePath.resolve(workspace);
  await assertGitWorkspace(root);
  const branch = await resolveTargetBranch(root);
  const ref = (await git(root, ["rev-parse", `refs/heads/${branch}`])).trim();
  const shortRef = (await git(root, ["rev-parse", "--short", ref])).trim();
  if (!ref || !shortRef) throw new Error("Cannot read workspace HEAD.");
  return { ref, shortRef, branch };
}

/** Run an explicit user-supplied gate in the integration workspace before mutation. */
export async function runWorkspaceCheck(workspace: string, command: string): Promise<WorkspaceCheckResult> {
  const root = nodePath.resolve(workspace);
  await assertGitWorkspace(root);
  const script = command.trim();
  if (!script) throw new Error("--require-check requires a non-empty command.");
  return runShell(root, script);
}

export async function ensureRoleWorkspace(
  workspace: string,
  role: string
): Promise<RoleWorkspaceContract> {
  const root = nodePath.resolve(workspace);
  await assertGitWorkspace(root);
  const targetBranch = await resolveTargetBranch(root);
  const roleSlug = safeComponent(role);
  const branch = `tent-role/${roleSlug}`;
  const worktree = nodePath.join(
    nodePath.dirname(root),
    `${nodePath.basename(root)}-worktrees`,
    roleSlug
  );

  const existing = await worktreeForBranch(root, branch);
  if (existing) {
    return { workspace: root, worktree: await nodeFs.realpath(nodePath.resolve(existing)), branch, targetBranch };
  }
  if (await pathExists(worktree)) {
    throw new Error(`Role worktree path exists but is not registered to ${branch}: ${worktree}.`);
  }

  const branchExists = await gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (branchExists) {
    await git(root, ["worktree", "add", worktree, branch]);
  } else {
    await git(root, ["worktree", "add", "-b", branch, worktree, targetBranch]);
  }
  return { workspace: root, worktree: await nodeFs.realpath(worktree), branch, targetBranch };
}

/** 把 user 在验收交互中明确选中的 commits 逐个纳入正式分支；不 push。 */
export async function integrateWorkspaceCommits(
  contract: RoleWorkspaceContract,
  refs: string[]
): Promise<IntegrationResult[]> {
  const commits = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
  if (commits.length === 0) return [];
  const root = contract.workspace;
  const current = (await git(root, ["branch", "--show-current"])).trim();
  if (current !== contract.targetBranch) {
    throw new Error(`Workspace must have ${contract.targetBranch} checked out; current branch is ${current || "(detached)"}.`);
  }
  const dirty = (await git(root, ["status", "--porcelain"])).trim();
  if (dirty) throw new Error("Workspace has uncommitted changes; cannot integrate commits.");

  const originalRef = (await git(root, ["rev-parse", `refs/heads/${contract.targetBranch}`])).trim();
  const resolved = [];
  for (const sourceRef of commits) {
    await git(root, ["cat-file", "-e", `${sourceRef}^{commit}`]);
    resolved.push({ sourceRef, fullRef: await fullRef(root, sourceRef) });
  }
  const fastForwardRef = await completeFastForwardRef(root, originalRef, resolved.map((item) => item.fullRef));
  if (fastForwardRef) {
    try {
      await git(root, ["merge", "--ff-only", fastForwardRef]);
      return resolved.map(({ sourceRef, fullRef: integratedRef }) => ({
        sourceRef,
        integratedRef,
        alreadyIntegrated: false,
      }));
    } catch (error) {
      await rollbackIntegration(root, originalRef, error);
    }
  }

  const results: IntegrationResult[] = [];
  try {
    for (const { sourceRef } of resolved) {
      const ancestor = await findAncestorIntegration(root, sourceRef, contract.targetBranch);
      if (ancestor) {
        results.push({ sourceRef, integratedRef: ancestor, alreadyIntegrated: true });
        continue;
      }
      const prior = await findCherryPick(root, sourceRef);
      if (prior) {
        results.push({ sourceRef, integratedRef: prior, alreadyIntegrated: true });
        continue;
      }
      await git(root, ["cherry-pick", "-x", sourceRef]);
      const integratedRef = (await git(root, ["rev-parse", "HEAD"])).trim();
      results.push({ sourceRef, integratedRef, alreadyIntegrated: false });
    }
  } catch (error) {
    await rollbackIntegration(root, originalRef, error);
  }
  return results;
}

/** 列出 role lane 尚未进入正式分支的 commits；只读，异常按空候选处理。 */
export async function listRoleCommits(contract: RoleWorkspaceContract): Promise<RoleCommit[]> {
  try {
    const output = await git(contract.workspace, [
      "log",
      `${contract.targetBranch}..${contract.branch}`,
      "--format=%H%x09%h%x09%s",
    ]);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [ref = "", shortRef = "", ...subjectParts] = line.split("\t");
        return { ref, shortRef, subject: subjectParts.join("\t") };
      })
      .filter((item) => item.ref && item.shortRef);
  } catch {
    return [];
  }
}

/** 只读列举 role lane 未合入正式分支的 commits；不建 worktree、不建分支。 */
export async function listRoleCommitsFor(workspace: string, role: string): Promise<RoleCommit[]> {
  try {
    const root = nodePath.resolve(workspace);
    await assertGitWorkspace(root);
    const targetBranch = await resolveTargetBranch(root);
    const branch = `tent-role/${safeComponent(role)}`;
    const exists = await gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (!exists) return [];
    return listRoleCommits({ workspace: root, worktree: "", branch, targetBranch });
  } catch {
    return [];
  }
}

async function assertGitWorkspace(root: string): Promise<void> {
  const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
  const [realTop, realRoot] = await Promise.all([
    nodeFs.realpath(nodePath.resolve(top)),
    nodeFs.realpath(root),
  ]);
  if (!isSameWorkspaceRoot(realTop, realRoot)) {
    throw new Error(`Workspace must be a Git root: ${root}.`);
  }
}

export function isSameWorkspaceRoot(
  realTop: string,
  realRoot: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const top = platform === "win32" ? realTop.toLowerCase() : realTop;
  const root = platform === "win32" ? realRoot.toLowerCase() : realRoot;
  return top === root;
}

async function resolveTargetBranch(root: string): Promise<string> {
  for (const name of ["main", "master"]) {
    if (await gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])) return name;
  }
  const current = (await git(root, ["branch", "--show-current"])).trim();
  if (!current) throw new Error("Cannot identify the workspace main branch.");
  return current;
}

async function worktreeForBranch(root: string, branch: string): Promise<string | undefined> {
  const output = await git(root, ["worktree", "list", "--porcelain"]);
  let currentPath = "";
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}`) return currentPath;
  }
  return undefined;
}

async function findCherryPick(root: string, sourceRef: string): Promise<string | undefined> {
  const full = await fullRef(root, sourceRef);
  const needle = `(cherry picked from commit ${full})`;
  // 扫描目标历史上足够深的提交；短窗口会导致「已合入」误判为需再次 cherry-pick。
  const output = await git(root, ["log", "--format=%H%x00%B%x00", "--all", "-n", "5000"]);
  const parts = output.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const body = parts[i + 1] ?? "";
    if (body.includes(needle)) return parts[i].trim();
    // 兼容部分 git 前端截断 message 时仍保留完整 sha 的变体
    if (body.includes("cherry picked from commit") && body.includes(full)) {
      return parts[i].trim();
    }
  }
  return undefined;
}

async function findAncestorIntegration(
  root: string,
  sourceRef: string,
  targetBranch: string
): Promise<string | undefined> {
  const targetRef = `refs/heads/${targetBranch}`;
  const full = await fullRef(root, sourceRef);
  if (await gitOk(root, ["merge-base", "--is-ancestor", full, targetRef])) {
    // 已是祖先时，幂等结果应指向 source 自身（已在历史上），而非当前 target HEAD。
    return full;
  }
  return undefined;
}

async function completeFastForwardRef(
  root: string,
  targetRef: string,
  commits: string[]
): Promise<string | undefined> {
  const lastRef = commits.at(-1);
  if (!lastRef || lastRef === targetRef) return undefined;
  if (!(await gitOk(root, ["merge-base", "--is-ancestor", targetRef, lastRef]))) return undefined;
  const range = (await git(root, ["rev-list", "--reverse", `${targetRef}..${lastRef}`]))
    .split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter(Boolean);
  if (range.length !== commits.length) return undefined;
  const supplied = new Set(commits);
  return range.every((ref) => supplied.has(ref)) ? lastRef : undefined;
}

async function rollbackIntegration(root: string, originalRef: string, cause: unknown): Promise<never> {
  await git(root, ["cherry-pick", "--abort"]).catch(() => "");
  try {
    await git(root, ["reset", "--hard", originalRef]);
  } catch (rollbackError) {
    throw new Error(
      `Workspace integration failed and rollback also failed: ${errorMessage(cause)}; rollback: ${errorMessage(rollbackError)}`
    );
  }
  throw new Error(`Workspace integration conflicted and was rolled back: ${errorMessage(cause)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fullRef(root: string, ref: string): Promise<string> {
  return (await git(root, ["rev-parse", ref])).trim();
}

function safeComponent(value: string): string {
  const source = value.trim();
  const normalized = source.normalize("NFKC");
  let clean = normalized
    .replace(/[<>:"/\\|?*\x00-\x1f~^:[\]@{}]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 40);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean);
  if (reserved) clean = `role-${clean}`;
  if (!clean) return `role-${shortHash(source)}`;
  return clean !== normalized || normalized !== source || reserved
    ? `${clean}-${shortHash(source)}`
    : clean;
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await nodeFs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (err += data));
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `git ${args.join(" ")} exit ${code}`));
    });
    child.on("error", reject);
  });
}

function runShell(cwd: string, command: string): Promise<WorkspaceCheckResult> {
  return new Promise((resolve, reject) => {
    const { shell, args } = workspaceCheckShell(command);
    const child = spawn(shell, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ command, stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit ${code}`;
      reject(new Error(`--require-check failed (${code}): ${command}\n${detail}`));
    });
    child.on("error", (error) => {
      reject(new Error(`--require-check failed to start: ${command}\n${error.message}`));
    });
  });
}

export function workspaceCheckShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec,
): { shell: string; args: string[] } {
  const windows = platform === "win32";
  return {
    shell: windows ? comSpec || "cmd.exe" : "/bin/sh",
    args: windows ? ["/d", "/s", "/c", command] : ["-c", command],
  };
}
