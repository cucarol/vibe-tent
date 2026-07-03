import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { configureTestGitIdentity, git, makeTent } from "./helpers.js";

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

test("completeClaim:workspace 合入失败时不释放 owner 或写 done", async () => {
  const dir = await makeTent();
  const adapter = new NodeFs(dir);
  const outputDir = path.join(dir, "goal", "挖新alpha", "写表达式", "交付记录");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "交付记录.md"),
    "---\nid: bx-failed-output\ntype: output\n---\n# 交付记录\n",
  );
  const { completeClaim } = await import("../src/core/ops.js");
  await assert.rejects(
    () => completeClaim(
      { fs: adapter, clock: { now: () => "t" }, tentName: "x" },
      "bx-g2",
      {
        integrate: async () => {
          throw new Error("conflict");
        },
      }
    ),
    /conflict/
  );
  const after = await loadTent(adapter);
  const box = after.byId.get("bx-g2")!;
  assert.equal(box.fm.owner, "executor");
  assert.equal(box.fm.status, "doing");
  assert.equal(after.byId.get("bx-failed-output")!.fm.status, undefined);
});
