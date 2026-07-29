import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { createPrimaryType } from "../src/core/typeManagement.js";
import { configureTestGitIdentity, git, makeTent } from "./helpers.js";

test("resolveTentWorkspace:仅 in-workspace 布局,不再扫描 concept workspace 字段", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const { resolveTentWorkspace, findIntegratedCommit } = await import("../src/core/workspace.js");

  await fs.writeFile(
    path.join(dir, "output", "alpha仓库指针", "alpha仓库指针.md"),
    "---\nid: bx-o1\ntype: artifact\nworkspace: C:/legacy/repo\n---\n",
  );
  let tent = await loadTent(fsa);
  assert.equal(
    resolveTentWorkspace(tent),
    undefined,
    "无 systemRoot 时不得用 concept workspace 字段兜底",
  );
  assert.equal(
    resolveTentWorkspace(tent, dir),
    undefined,
    "system root 不叫 .tent 时不得扫描 workspace 字段",
  );

  // system root 名为 .tent 时父目录即 workspace
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ws-layout-"));
  const workspace = path.join(parent, "repo");
  const systemRoot = path.join(workspace, ".tent");
  await fs.mkdir(systemRoot, { recursive: true });
  await fs.writeFile(path.join(systemRoot, "index.md"), "---\ntype: index\n---\n# Index\n");
  const layoutFs = new NodeFs(systemRoot);
  tent = await loadTent(layoutFs);
  assert.equal(path.resolve(resolveTentWorkspace(tent, systemRoot)!), path.resolve(workspace));

  void findIntegratedCommit;
  void createPrimaryType;
});

test("workspaceCheckShell:POSIX require-check uses portable sh -c", async () => {
  const { workspaceCheckShell } = await import("../src/core/workspace.js");

  assert.deepEqual(workspaceCheckShell("echo ok", "linux"), {
    shell: "/bin/sh",
    args: ["-c", "echo ok"],
  });
  assert.deepEqual(workspaceCheckShell("echo ok", "win32", "C:\\Windows\\System32\\cmd.exe"), {
    shell: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "echo ok"],
  });
});

test("isSameWorkspaceRoot:non-Windows preserves case-sensitive path comparison", async () => {
  const { isSameWorkspaceRoot } = await import("../src/core/workspace.js");

  assert.equal(isSameWorkspaceRoot("/tmp/Repo", "/tmp/repo", "linux"), false);
  assert.equal(isSameWorkspaceRoot("C:\\Repo", "c:\\repo", "win32"), true);
});

test("ensureRoleWorkspaceIfGit: non-Git workspace returns undefined without throwing", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-nongit-"));
  const workspace = path.join(parent, "docs-only");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "README.md"), "# docs\n");

  const { ensureRoleWorkspaceIfGit, isGitWorkspace } = await import("../src/core/workspace.js");
  assert.equal(await isGitWorkspace(workspace), false);
  assert.equal(await ensureRoleWorkspaceIfGit(workspace, "executor"), undefined);
});

test("workspace Git:中文 role 复用单一 worktree/branch,验收 commit 合入 main", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-workspace-"));
  const workspace = path.join(parent, "repo");
  await fs.mkdir(workspace);
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "-q", "-m", "init");

  const {
    ensureRoleWorkspace,
    integrateWorkspaceCommits,
    listRoleCommits,
    readWorkspaceHead,
  } = await import("../src/core/workspace.js");
  const initialHead = await readWorkspaceHead(workspace);
  assert.equal(initialHead.branch, "main");
  assert.equal(initialHead.ref, (await git(workspace, "rev-parse", "main")).trim());
  const contract = await ensureRoleWorkspace(workspace, "执行者");
  assert.equal(contract.branch, "tent-role/执行者");
  assert.equal(path.basename(contract.worktree), "执行者");
  assert.deepEqual(
    await ensureRoleWorkspace(workspace, "执行者"),
    contract,
    "同 role 复用 lane"
  );

  await fs.writeFile(path.join(contract.worktree, "result.txt"), "done\n");
  await git(contract.worktree, "add", "result.txt");
  await git(contract.worktree, "commit", "-q", "-m", "deliver result");
  const sourceRef = (await git(contract.worktree, "rev-parse", "HEAD")).trim();
  await fs.writeFile(path.join(contract.worktree, "second.txt"), "second\n");
  await git(contract.worktree, "add", "second.txt");
  await git(contract.worktree, "commit", "-q", "-m", "second result");
  const secondRef = (await git(contract.worktree, "rev-parse", "HEAD")).trim();

  const candidates = await listRoleCommits(contract);
  assert.deepEqual(
    candidates.map((item) => item.ref),
    [secondRef, sourceRef],
    "候选 commit 按时间倒序列出 role lane 领先 main 的提交"
  );
  assert.equal(candidates[0].shortRef, secondRef.slice(0, candidates[0].shortRef.length));
  assert.equal(candidates[0].subject, "second result");
  assert.equal(candidates[1].subject, "deliver result");
  assert.equal(
    (await readWorkspaceHead(workspace)).ref,
    initialHead.ref,
    "role lane 提交不改变正式 HEAD"
  );
  assert.deepEqual(
    await listRoleCommits({ ...contract, branch: "tent-role/missing" }),
    [],
    "role lane 不存在时按无候选处理"
  );

  const [integrated] = await integrateWorkspaceCommits(contract, [sourceRef]);
  assert.equal(integrated.sourceRef, sourceRef);
  assert.equal(integrated.alreadyIntegrated, false);
  assert.equal(
    (await readWorkspaceHead(workspace)).ref,
    integrated.integratedRef,
    "验收后正式 HEAD 随合入更新"
  );
  assert.equal(
    (await fs.readFile(path.join(workspace, "result.txt"), "utf8")).replace(/\r\n/g, "\n"),
    "done\n"
  );
  const [again] = await integrateWorkspaceCommits(contract, [sourceRef]);
  assert.equal(again.alreadyIntegrated, true, "重复确认不重复 cherry-pick");
  assert.equal(again.integratedRef, integrated.integratedRef);
});

test("workspace integration:second cherry-pick conflict rolls the whole batch back", async () => {
  const workspace = await makeGitWorkspace("tent-workspace-rollback-");
  await fs.writeFile(path.join(workspace, "conflict.txt"), "base\n");
  await git(workspace, "add", "conflict.txt");
  await git(workspace, "commit", "-q", "-m", "add conflict base");

  const { ensureRoleWorkspace, integrateWorkspaceCommits } = await import("../src/core/workspace.js");
  const contract = await ensureRoleWorkspace(workspace, "reviewer");
  const firstRef = await commitFile(contract.worktree, "first.txt", "first\n", "first delivery");
  await fs.writeFile(path.join(contract.worktree, "conflict.txt"), "role\n");
  await git(contract.worktree, "add", "conflict.txt");
  await git(contract.worktree, "commit", "-q", "-m", "conflicting delivery");
  const secondRef = (await git(contract.worktree, "rev-parse", "HEAD")).trim();

  await fs.writeFile(path.join(workspace, "conflict.txt"), "main\n");
  await git(workspace, "add", "conflict.txt");
  await git(workspace, "commit", "-q", "-m", "main conflict");
  const beforeHead = (await git(workspace, "rev-parse", "HEAD")).trim();

  await assert.rejects(
    () => integrateWorkspaceCommits(contract, [firstRef, secondRef]),
    /Workspace integration conflicted and was rolled back/,
  );

  assert.equal((await git(workspace, "rev-parse", "HEAD")).trim(), beforeHead);
  assert.equal((await git(workspace, "reflog", "show", "-1", "--format=%H", "main")).trim(), beforeHead);
  assert.equal((await git(workspace, "status", "--porcelain")).trim(), "");
  assert.equal(await pathExists(path.join(workspace, "first.txt")), false);
  assert.equal(normalizeLf(await fs.readFile(path.join(workspace, "conflict.txt"), "utf8")), "main\n");
});

test("workspace integration:complete descendant interval fast-forwards without changing shas", async () => {
  const workspace = await makeGitWorkspace("tent-workspace-ff-");
  const { ensureRoleWorkspace, integrateWorkspaceCommits } = await import("../src/core/workspace.js");
  const contract = await ensureRoleWorkspace(workspace, "reviewer");
  const firstRef = await commitFile(contract.worktree, "first.txt", "first\n", "first delivery");
  const lastRef = await commitFile(contract.worktree, "last.txt", "last\n", "last delivery");

  const integrated = await integrateWorkspaceCommits(contract, [firstRef, lastRef]);

  assert.equal((await git(workspace, "rev-parse", "main")).trim(), lastRef);
  assert.deepEqual(
    integrated.map((item) => item.integratedRef),
    [firstRef, lastRef],
  );
  assert.ok(integrated.every((item) => item.alreadyIntegrated === false));
});

test("workspace integration:commit gaps keep the cherry-pick path", async () => {
  const workspace = await makeGitWorkspace("tent-workspace-gap-");
  const { ensureRoleWorkspace, integrateWorkspaceCommits } = await import("../src/core/workspace.js");
  const contract = await ensureRoleWorkspace(workspace, "reviewer");
  const firstRef = await commitFile(contract.worktree, "first.txt", "first\n", "first delivery");
  await commitFile(contract.worktree, "middle.txt", "middle\n", "middle delivery");
  const lastRef = await commitFile(contract.worktree, "last.txt", "last\n", "last delivery");

  const integrated = await integrateWorkspaceCommits(contract, [firstRef, lastRef]);
  const mainRef = (await git(workspace, "rev-parse", "main")).trim();

  assert.notEqual(mainRef, lastRef, "gap prevents a fast-forward to the role commit");
  assert.notEqual(integrated[0].integratedRef, firstRef);
  assert.notEqual(integrated[1].integratedRef, lastRef);
  assert.equal(await pathExists(path.join(workspace, "middle.txt")), false);
  assert.equal(normalizeLf(await fs.readFile(path.join(workspace, "first.txt"), "utf8")), "first\n");
  assert.equal(normalizeLf(await fs.readFile(path.join(workspace, "last.txt"), "utf8")), "last\n");
});

test("workspace integration:off-source tip does not whole-interval fast-forward", async () => {
  // Negative boundary: tip is a target descendant but NOT on contract.branch.
  // Whole-interval FF would drag foreign intermediate commits; must cherry-pick
  // the tip only (or otherwise leave intermediates out).
  const workspace = await makeGitWorkspace("tent-workspace-ff-off-source-");
  const { ensureRoleWorkspace, integrateWorkspaceCommits } = await import("../src/core/workspace.js");
  const contract = await ensureRoleWorkspace(workspace, "reviewer");
  const mainBefore = (await git(workspace, "rev-parse", "main")).trim();

  // Foreign lineage: main → middle → tip (tip is target descendant, not on role).
  await git(workspace, "checkout", "-q", "-b", "foreign-lane");
  await commitFile(workspace, "foreign-middle.txt", "middle\n", "foreign middle");
  const foreignTip = await commitFile(workspace, "foreign-tip.txt", "tip\n", "foreign tip");
  await git(workspace, "checkout", "-q", "main");

  assert.equal(
    (await git(workspace, "rev-parse", `refs/heads/${contract.branch}`)).trim(),
    mainBefore,
    "role source branch stays at pre-foreign tip"
  );
  // merge-base --is-ancestor exits 0 when true; throws (non-zero) when false.
  await git(workspace, "merge-base", "--is-ancestor", mainBefore, foreignTip);
  await assert.rejects(
    () =>
      git(
        workspace,
        "merge-base",
        "--is-ancestor",
        foreignTip,
        `refs/heads/${contract.branch}`,
      ),
    /./,
    "foreign tip is not reachable from the task source branch",
  );

  const integrated = await integrateWorkspaceCommits(contract, [foreignTip]);
  const mainAfter = (await git(workspace, "rev-parse", "main")).trim();

  assert.notEqual(
    mainAfter,
    foreignTip,
    "must not whole-interval fast-forward an off-source tip"
  );
  assert.equal(
    await pathExists(path.join(workspace, "foreign-middle.txt")),
    false,
    "must not drag foreign intermediate commits into target"
  );
  assert.equal(
    normalizeLf(await fs.readFile(path.join(workspace, "foreign-tip.txt"), "utf8")),
    "tip\n",
    "exact tip content still lands via precise cherry-pick"
  );
  assert.equal(integrated.length, 1);
  assert.equal(integrated[0].sourceRef, foreignTip);
  assert.notEqual(integrated[0].integratedRef, foreignTip);
  assert.equal(integrated[0].alreadyIntegrated, false);
});

test("listRoleCommitsStrict / listPendingRoleCommits: fail-loud + skip already-integrated", async () => {
  const workspace = await makeGitWorkspace("tent-pending-commits-");
  const {
    ensureRoleWorkspace,
    integrateWorkspaceCommits,
    listPendingRoleCommits,
    listRoleCommits,
    listRoleCommitsStrict,
    listRoleCommitsSince,
    readRoleBranchTip,
  } = await import("../src/core/workspace.js");
  const contract = await ensureRoleWorkspace(workspace, "reviewer");
  // Task-scoped base is the role tip *before* this task's commits.
  const base = await readRoleBranchTip(workspace, contract.branch);
  const firstRef = await commitFile(contract.worktree, "p1.txt", "one\n", "pending one");
  const secondRef = await commitFile(contract.worktree, "p2.txt", "two\n", "pending two");

  const strict = await listRoleCommitsStrict(contract);
  assert.deepEqual(
    strict.map((c) => c.ref),
    [secondRef, firstRef],
    "strict log is newest-first like listRoleCommits"
  );
  assert.deepEqual(
    (await listRoleCommits(contract)).map((c) => c.ref),
    [secondRef, firstRef]
  );
  assert.deepEqual(
    (await listRoleCommitsSince(contract, base)).map((c) => c.ref),
    [secondRef, firstRef],
    "since-base log matches target..branch when base is pre-task tip"
  );

  const pending = await listPendingRoleCommits(contract, base);
  assert.deepEqual(
    pending.map((c) => c.ref),
    [firstRef, secondRef],
    "pending is oldest-first for integrate order"
  );

  // Integrate first only (cherry-pick leaves role branch tip ahead).
  await integrateWorkspaceCommits(contract, [firstRef]);
  const after = await listPendingRoleCommits(contract, base);
  assert.deepEqual(
    after.map((c) => c.ref),
    [secondRef],
    "already-integrated (ancestor/cherry-pick) commits are not re-presented"
  );

  // Exclusive base..branch: commits at/below base are not candidates.
  assert.deepEqual(
    (await listPendingRoleCommits(contract, firstRef)).map((c) => c.ref),
    [secondRef],
    "listPendingRoleCommits is exclusive base..branch"
  );
  const mainRef = (await git(workspace, "rev-parse", "main")).trim();
  assert.deepEqual(
    (await listPendingRoleCommits(contract, mainRef)).map((c) => c.ref),
    [secondRef],
    "an advanced target that remains an ancestor is still a valid baseline"
  );
  const divergentMainRef = await commitFile(
    workspace,
    "main-only.txt",
    "main only\n",
    "diverge main from role lane"
  );
  await assert.rejects(
    () => listPendingRoleCommits(contract, divergentMainRef),
    /no longer descends/i,
    "a rewritten or divergent role lane must fail loud instead of widening the range"
  );

  await assert.rejects(
    () =>
      listRoleCommitsStrict({
        ...contract,
        branch: "tent-role/definitely-missing",
      }),
    /./,
    "strict variant must not swallow missing-branch Git errors as []"
  );
  assert.deepEqual(
    await listRoleCommits({
      ...contract,
      branch: "tent-role/definitely-missing",
    }),
    [],
    "read-only listRoleCommits still soft-fails to []"
  );
  await assert.rejects(
    () => listPendingRoleCommits(contract, ""),
    /base/i,
    "managed pending list requires a non-empty base"
  );
});

test("listRoleCommitsFor:只读列举 role 分支 commits,不创建 worktree", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-commit-list-"));
  const workspace = path.join(parent, "repo");
  await fs.mkdir(workspace);
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "-q", "-m", "init");

  await git(workspace, "checkout", "-q", "-b", "tent-role/reviewer");
  await fs.writeFile(path.join(workspace, "a.txt"), "a\n");
  await git(workspace, "add", "a.txt");
  await git(workspace, "commit", "-q", "-m", "first review");
  const firstRef = (await git(workspace, "rev-parse", "HEAD")).trim();
  await fs.writeFile(path.join(workspace, "b.txt"), "b\n");
  await git(workspace, "add", "b.txt");
  await git(workspace, "commit", "-q", "-m", "second review");
  const secondRef = (await git(workspace, "rev-parse", "HEAD")).trim();
  await git(workspace, "checkout", "-q", "main");

  const beforeWorktrees = await git(workspace, "worktree", "list", "--porcelain");
  const { listRoleCommitsFor } = await import("../src/core/workspace.js");
  const commits = await listRoleCommitsFor(workspace, "reviewer");
  const afterWorktrees = await git(workspace, "worktree", "list", "--porcelain");

  assert.deepEqual(
    commits.map((item) => item.ref),
    [secondRef, firstRef],
    "只读 API 能列出 role branch 领先 main 的 commits"
  );
  assert.equal(commits[0].subject, "second review");
  assert.equal(afterWorktrees, beforeWorktrees, "列举 commit 不应创建 worktree");
  assert.deepEqual(await listRoleCommitsFor(workspace, "missing"), []);
  assert.equal(
    await git(workspace, "worktree", "list", "--porcelain"),
    beforeWorktrees
  );
});

test("completeClaim: retired — rejects without dual-writing Node owner/status", async () => {
  const dir = await makeTent();
  const adapter = new NodeFs(dir);
  const { completeClaim } = await import("../src/core/ops.js");
  await assert.rejects(
    () => completeClaim(
      { fs: adapter, clock: { now: () => "t" }, tentName: "x" },
      "bx-g2",
      async () => {
        throw new Error("conflict");
      }
    ),
    /retired|owner\/status|no longer write/i
  );
  const box = (await loadTent(adapter)).byId.get("bx-g2")!;
  assert.equal(box.fm.owner, undefined);
  assert.equal(box.fm.status, undefined);
});

async function makeGitWorkspace(prefix: string): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(parent, "repo");
  await fs.mkdir(workspace);
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "-q", "-m", "init");
  return workspace;
}

async function commitFile(
  workspace: string,
  filename: string,
  contents: string,
  message: string,
): Promise<string> {
  await fs.writeFile(path.join(workspace, filename), contents);
  await git(workspace, "add", filename);
  await git(workspace, "commit", "-q", "-m", message);
  return (await git(workspace, "rev-parse", "HEAD")).trim();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function normalizeLf(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
