import * as nodePath from "node:path";
import * as nodeFs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { LoadedTent } from "./tree.js";
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
 * B1 hardening：只从 in-workspace 布局推导（system root 目录名为 `.tent` 时父目录即 workspace）。
 * 不再扫描 concept 上任意 `workspace:` 字段作为长期 legacy pointer fallback。
 * 不再使用「workspace pointer type」产品语义。
 */
export function resolveTentWorkspace(_tent: LoadedTent, systemRoot?: string): string | undefined {
  void _tent;
  if (!systemRoot) return undefined;
  const fromLayout = workspaceRootFromSystemRoot(systemRoot);
  return fromLayout ? nodePath.resolve(fromLayout) : undefined;
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
  const prior = await findCherryPick(root, full, targetBranch);
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

/**
 * Read the authoritative full SHA tip of a long-lived role branch.
 * Fail-loud when the branch is missing or Git cannot resolve it.
 */
export async function readRoleBranchTip(
  workspace: string,
  branch: string
): Promise<string> {
  const root = nodePath.resolve(workspace);
  await assertGitWorkspace(root);
  const name = branch.trim();
  if (!name) throw new Error("Role branch name is required.");
  const ref = (await git(root, ["rev-parse", `refs/heads/${name}`])).trim();
  if (!ref) throw new Error(`Cannot read role branch tip: ${name}.`);
  return ref;
}

/** Run an explicit user-supplied gate in the integration workspace before mutation. */
export async function runWorkspaceCheck(workspace: string, command: string): Promise<WorkspaceCheckResult> {
  const root = nodePath.resolve(workspace);
  await assertGitWorkspace(root);
  const script = command.trim();
  if (!script) throw new Error("--require-check requires a non-empty command.");
  return runShell(root, script);
}

/** True when `workspace` is a Git repository root (not a nested path inside one). */
export async function isGitWorkspace(workspace: string): Promise<boolean> {
  try {
    await assertGitWorkspace(nodePath.resolve(workspace));
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the long-lived role worktree/branch on a Git workspace.
 * Pure document / non-Git workspaces return `undefined` (no lane) without throwing.
 * Real Git errors after the root check (e.g. worktree path collision) still throw.
 */
export async function ensureRoleWorkspaceIfGit(
  workspace: string,
  role: string
): Promise<RoleWorkspaceContract | undefined> {
  if (!(await isGitWorkspace(workspace))) return undefined;
  return ensureRoleWorkspace(workspace, role);
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

/**
 * One-shot AgentProfile task lane: branch/worktree scoped to task id.
 * Distinct from durable tent-role/<role> lanes; concurrent same-profile tasks
 * each get their own tent-task/<taskId> worktree.
 * Non-Git workspaces return undefined without throwing.
 */
export async function ensureTaskWorkspaceIfGit(
  workspace: string,
  taskId: string
): Promise<RoleWorkspaceContract | undefined> {
  if (!(await isGitWorkspace(workspace))) return undefined;
  return ensureTaskWorkspace(workspace, taskId);
}

export async function ensureTaskWorkspace(
  workspace: string,
  taskId: string
): Promise<RoleWorkspaceContract> {
  const root = nodePath.resolve(workspace);
  await assertGitWorkspace(root);
  const id = taskId.trim();
  if (!id) throw new Error("Task id is required for task-scoped workspace lane.");
  const targetBranch = await resolveTargetBranch(root);
  const taskSlug = safeComponent(id);
  const branch = `tent-task/${taskSlug}`;
  const worktree = nodePath.join(
    nodePath.dirname(root),
    `${nodePath.basename(root)}-worktrees`,
    `task-${taskSlug}`
  );

  const existing = await worktreeForBranch(root, branch);
  if (existing) {
    return {
      workspace: root,
      worktree: await nodeFs.realpath(nodePath.resolve(existing)),
      branch,
      targetBranch,
    };
  }
  if (await pathExists(worktree)) {
    throw new Error(`Task worktree path exists but is not registered to ${branch}: ${worktree}.`);
  }

  const branchExists = await gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (branchExists) {
    await git(root, ["worktree", "add", worktree, branch]);
  } else {
    await git(root, ["worktree", "add", "-b", branch, worktree, targetBranch]);
  }
  return {
    workspace: root,
    worktree: await nodeFs.realpath(worktree),
    branch,
    targetBranch,
  };
}

/** Dirtiness of one exact Git worktree path (tracked + untracked). */
export interface WorktreeDirtiness {
  dirty: boolean;
  worktree: string;
  trackedDirty: boolean;
  untrackedDirty: boolean;
  /** Truncated porcelain sample for diagnostics (never a full dump). */
  sample: string;
  /** Number of porcelain lines observed. */
  changeCount: number;
}

/**
 * Inspect uncommitted changes in one authoritative task/role worktree.
 * Only runs `git status --porcelain` in that worktree path — never checks or
 * mutates main / other lanes. Empty porcelain → clean.
 */
export async function inspectWorktreeDirtiness(worktree: string): Promise<WorktreeDirtiness> {
  const cwd = nodePath.resolve(worktree);
  // Porcelain is relative to this worktree's working tree only.
  const raw = (await git(cwd, ["status", "--porcelain"])).replace(/\r\n/g, "\n").trim();
  const lines = raw ? raw.split("\n").map((line) => line.trimEnd()).filter(Boolean) : [];
  let trackedDirty = false;
  let untrackedDirty = false;
  for (const line of lines) {
    // `?? path` = untracked; everything else is staged/unstaged tracked change.
    if (line.startsWith("??") || line.startsWith("!")) {
      untrackedDirty = true;
    } else {
      trackedDirty = true;
    }
  }
  const sampleLines = lines.slice(0, 8);
  const sample =
    sampleLines.join("\n") + (lines.length > sampleLines.length ? `\n…(+${lines.length - sampleLines.length} more)` : "");
  return {
    dirty: lines.length > 0,
    worktree: cwd,
    trackedDirty,
    untrackedDirty,
    sample,
    changeCount: lines.length,
  };
}

/**
 * Integrate selected commits into contract.targetBranch.
 *
 * Mutations run in the worktree that already has targetBranch checked out
 * (main workspace for peer → mainline; dispatcher role worktree for sub →
 * tent-role/<dispatcher>). Never switches branches automatically.
 * Preserves dirty checks, rollback, and idempotence (ancestor / -x cherry-pick).
 */
export async function integrateWorkspaceCommits(
  contract: RoleWorkspaceContract,
  refs: string[]
): Promise<IntegrationResult[]> {
  const commits = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
  if (commits.length === 0) return [];
  const root = contract.workspace;
  const target = contract.targetBranch;
  // Prefer an existing worktree that already has targetBranch checked out
  // (dispatcher lane for sub tasks; main workspace for peer). Never checkout.
  const integrationCwd = await resolveIntegrationCwd(root, target);

  const current = (await git(integrationCwd, ["branch", "--show-current"])).trim();
  if (current !== target) {
    throw new Error(
      `No worktree has ${target} checked out for integration; found current branch ${current || "(detached)"} at ${integrationCwd}. ` +
        `Never auto-switch branches — ensure the target lane worktree exists and stays on ${target}.`
    );
  }
  const dirty = (await git(integrationCwd, ["status", "--porcelain"])).trim();
  if (dirty) {
    throw new Error(
      `Integration worktree has uncommitted changes; cannot integrate commits (${integrationCwd}).`
    );
  }

  const originalRef = (await git(root, ["rev-parse", `refs/heads/${target}`])).trim();
  const resolved = [];
  for (const sourceRef of commits) {
    // Object database is shared; resolve via repo root.
    await git(root, ["cat-file", "-e", `${sourceRef}^{commit}`]);
    resolved.push({ sourceRef, fullRef: await fullRef(root, sourceRef) });
  }
  const fastForwardRef = await completeFastForwardRef(
    root,
    originalRef,
    resolved.map((item) => item.fullRef),
    contract.branch
  );
  if (fastForwardRef) {
    try {
      await git(integrationCwd, ["merge", "--ff-only", fastForwardRef]);
      return resolved.map(({ sourceRef, fullRef: integratedRef }) => ({
        sourceRef,
        integratedRef,
        alreadyIntegrated: false,
      }));
    } catch (error) {
      await rollbackIntegration(integrationCwd, originalRef, error);
    }
  }

  const results: IntegrationResult[] = [];
  try {
    for (const { sourceRef } of resolved) {
      const ancestor = await findAncestorIntegration(root, sourceRef, target);
      if (ancestor) {
        results.push({ sourceRef, integratedRef: ancestor, alreadyIntegrated: true });
        continue;
      }
      const prior = await findCherryPick(root, sourceRef, target);
      if (prior) {
        results.push({ sourceRef, integratedRef: prior, alreadyIntegrated: true });
        continue;
      }
      await git(integrationCwd, ["cherry-pick", "-x", sourceRef]);
      const integratedRef = (await git(integrationCwd, ["rev-parse", "HEAD"])).trim();
      results.push({ sourceRef, integratedRef, alreadyIntegrated: false });
    }
  } catch (error) {
    await rollbackIntegration(integrationCwd, originalRef, error);
  }
  return results;
}

/**
 * Locate a worktree where `targetBranch` is the current branch.
 * Prefer the main workspace root when it is already on target; otherwise any
 * registered worktree (e.g. tent-role/<dispatcher>). Never creates or switches.
 */
async function resolveIntegrationCwd(root: string, targetBranch: string): Promise<string> {
  const mainCurrent = (await git(root, ["branch", "--show-current"])).trim();
  if (mainCurrent === targetBranch) {
    return root;
  }
  const existing = await worktreeForBranch(root, targetBranch);
  if (existing) {
    const wt = await nodeFs.realpath(nodePath.resolve(existing));
    const wtCurrent = (await git(wt, ["branch", "--show-current"])).trim();
    if (wtCurrent === targetBranch) return wt;
    throw new Error(
      `Worktree for ${targetBranch} exists at ${wt} but current branch is ${wtCurrent || "(detached)"}; never auto-switch.`
    );
  }
  throw new Error(
    `No worktree has ${targetBranch} checked out. Main workspace is on ${mainCurrent || "(detached)"}. ` +
      `For sub tasks ensure the dispatcher role lane (tent-role/<dispatcher>) exists.`
  );
}

/** 列出 role lane 尚未进入正式分支的 commits；只读，异常按空候选处理。 */
export async function listRoleCommits(contract: RoleWorkspaceContract): Promise<RoleCommit[]> {
  try {
    return await listRoleCommitsStrict(contract);
  } catch {
    return [];
  }
}

/**
 * Fail-loud role-lane commit listing for production delivery collection.
 * Same range as listRoleCommits (`targetBranch..branch`); does not swallow Git errors.
 * Newest-first (git log order).
 */
export async function listRoleCommitsStrict(contract: RoleWorkspaceContract): Promise<RoleCommit[]> {
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
}

/**
 * Fail-loud commits exclusive to `base..branch` (newest-first).
 * Used by managed collection once a task-scoped roleBranchBase is known.
 */
export async function listRoleCommitsSince(
  contract: RoleWorkspaceContract,
  base: string
): Promise<RoleCommit[]> {
  const since = base.trim();
  if (!since) throw new Error("listRoleCommitsSince requires a non-empty base SHA.");
  const branchRef = `refs/heads/${contract.branch}`;
  const fullBase = await fullRef(contract.workspace, since);
  if (!(await gitOk(contract.workspace, ["merge-base", "--is-ancestor", fullBase, branchRef]))) {
    throw new Error(
      `Role branch ${contract.branch} no longer descends from task baseline ${fullBase}.`
    );
  }
  const output = await git(contract.workspace, [
    "log",
    `${fullBase}..${branchRef}`,
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
}

/**
 * Pending delivery candidates from an authoritative role lane for managed collection.
 * Requires task-scoped `base` (roleBranchBase full SHA); lists only `base..branch`,
 * minus already-integrated (ancestor or -x cherry-pick) commits.
 * Returns oldest-first so integrate can fast-forward complete intervals.
 *
 * UI listing stays on listRoleCommits / listRoleCommitsFor (targetBranch..branch).
 */
export async function listPendingRoleCommits(
  contract: RoleWorkspaceContract,
  base: string
): Promise<RoleCommit[]> {
  const candidates = await listRoleCommitsSince(contract, base);
  const pending: RoleCommit[] = [];
  for (const item of candidates) {
    const integrated = await findIntegratedCommit(
      contract.workspace,
      item.ref,
      contract.targetBranch
    );
    if (!integrated) pending.push(item);
  }
  // git log is newest-first; reverse for chronological integrate order.
  return pending.reverse();
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

/**
 * 在目标分支可达历史上查找精确的 `cherry picked from commit <fullSha>` 痕迹。
 * 禁止 `git log --all`：其他分支上的同文案不得造成「已合入」误判。
 */
async function findCherryPick(
  root: string,
  sourceRef: string,
  targetBranch: string
): Promise<string | undefined> {
  const full = await fullRef(root, sourceRef);
  const needle = `(cherry picked from commit ${full})`;
  const targetRef = `refs/heads/${targetBranch}`;
  // 仅扫描目标分支可达历史；短窗口会导致「已合入」误判为需再次 cherry-pick。
  const output = await git(root, ["log", targetRef, "--format=%H%x00%B%x00", "-n", "5000"]);
  const parts = output.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const body = parts[i + 1] ?? "";
    // 精确匹配完整 sha 的标准 -x 文案；拒绝子串/截断误判。
    if (body.includes(needle)) return parts[i].trim();
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
  commits: string[],
  sourceBranch: string
): Promise<string | undefined> {
  const lastRef = commits.at(-1);
  if (!lastRef || lastRef === targetRef) return undefined;
  if (!(await gitOk(root, ["merge-base", "--is-ancestor", targetRef, lastRef]))) return undefined;

  // Tip must be reachable from the task source branch (contract.branch).
  // target being an ancestor of the tip is not enough: an arbitrary target-
  // descendant on another branch must not drag foreign intermediate commits
  // into the target via whole-interval fast-forward. Fall back to precise
  // cherry-pick for those cases.
  const sourceRef = `refs/heads/${sourceBranch}`;
  if (!(await gitOk(root, ["merge-base", "--is-ancestor", lastRef, sourceRef]))) {
    return undefined;
  }

  // Single tip that is a complete descendant of target *and* on the source
  // branch: fast-forward to the tip. This preserves intermediate history
  // already on the role lane (e.g. accepted sub commits under the parent tip).
  // Cherry-picking only the tip would drop those intermediate products.
  // Multi-commit lists still require a complete contiguous interval so
  // intentional gaps stay on the cherry-pick path.
  if (commits.length === 1) {
    return lastRef;
  }

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
