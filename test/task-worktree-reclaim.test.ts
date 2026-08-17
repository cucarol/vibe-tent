/**
 * Core: terminal Task worktree reclaim eligibility + remove.
 * Role lanes stay durable; only Session tent-task/* lanes reclaim.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { configureTestGitIdentity, git } from "./helpers.js";
import {
  ensureRoleWorkspace,
  ensureTaskWorkspace,
  expectedTaskWorktreePath,
  taskWorktreeBranchName,
} from "../src/core/workspace.js";
import {
  evaluateTaskWorktreeReclaim,
  reclaimTaskWorktree,
  removeTaskLaneDirectorySafe,
} from "../src/core/task-worktree-reclaim.js";
import type { TaskRecord } from "../src/core/task.js";
import type { TaskResultRecord } from "../src/core/task-result.js";
import {
  buildTaskContextCard,
  type TaskContextCard,
} from "../src/core/task-context-card.js";
import { contentEtag } from "../src/core/etag.js";

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

/** Canonical ContextCard wire — no runtime/Manifest claims[]. */
function fixtureContextCard(overrides?: {
  nodeId?: string;
  nodePath?: string;
}): TaskContextCard {
  const nodeId = overrides?.nodeId ?? "cx-abc123";
  const nodePath = overrides?.nodePath ?? "inbox";
  const body = "Terminal Task worktree reclaim fixture\n";
  return buildTaskContextCard({
    nodeIds: [nodeId],
    nodeSnapshots: [{
      id: nodeId,
      path: nodePath,
      type: "prompt",
      tags: [],
      body,
      etag: contentEtag(body),
      archived: false,
    }],
  });
}

function sessionTask(
  partial: Partial<TaskRecord> & Pick<TaskRecord, "id" | "state" | "path">
): TaskRecord {
  const contextCard = partial.contextCard ?? fixtureContextCard();
  return {
    executionSessionId: "ss-fakedefault",
    acceptMode: "review-required",
    manifest: "temp/sessions/ss-fakedefault/manifests/m.yml",
    requester: { kind: "user", id: "user" },
    nodeIds: partial.nodeIds ?? contextCard.nodeIds,
    nodeSnapshots: partial.nodeSnapshots ?? contextCard.nodeSnapshots,
    contextCard,
    ...partial,
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function worktreeList(workspace: string): Promise<string> {
  return git(workspace, "worktree", "list", "--porcelain");
}

test("naming helpers: tent-task branch + task-* directory are stable", () => {
  assert.equal(taskWorktreeBranchName("tk-abc"), "tent-task/tk-abc");
  assert.match(expectedTaskWorktreePath("/tmp/repo", "tk-abc"), /task-tk-abc$/);
});
test("role task lane is NOT_APPLICABLE (durable)", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-role-");
  const role = await ensureRoleWorkspace(workspace, "executor");
  const task = sessionTask({
    id: "tk-roleish",
    path: "temp/roles/rl-executor/tasks/t.md",
    state: "accepted",
    assigneeRoleId: "rl-executor",
    executionSessionId: undefined,
    workspace: role.workspace,
    worktree: role.worktree,
    branch: role.branch,
    targetBranch: role.targetBranch,
  });
  const d = await evaluateTaskWorktreeReclaim({ workspaceRoot: workspace, task });
  assert.equal(d.code, "NOT_APPLICABLE");
  assert.equal(d.eligible, false);
  assert.equal(await pathExists(role.worktree), true);
});

test("accepted clean integrated Session lane reclaims; branch+commits preserved; idempotent", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-ok-");
  const taskId = "tk-reclaim-ok";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  const base = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
  await fs.writeFile(path.join(lane.worktree, "feat.txt"), "ok\n");
  await git(lane.worktree, "add", "feat.txt");
  await git(lane.worktree, "commit", "-q", "-m", "feat");
  const tip = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
  // Integrate into main (peer target).
  await git(workspace, "merge", "--ff-only", tip);

  const task = sessionTask({
    id: taskId,
    path: `temp/sessions/ss-fakedefault/tasks/${taskId}.md`,
    state: "accepted",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
    baseCommit: base,
  });
  const results: TaskResultRecord[] = [
    {
      path: "temp/sessions/ss-fakedefault/results/rs-1.md",
      id: "rs-1",
      taskId,
      status: "accepted",
      report: "done",
      commits: [tip],
      checks: [],
      artifactRefs: [],
      integrationMode: null,
      createdAt: "2026-08-13T00:00:00.000Z",
    },
  ];

  const preview = await evaluateTaskWorktreeReclaim({
    workspaceRoot: workspace,
    task,
    results,
  });
  assert.equal(preview.code, "RECLAIMABLE");
  assert.equal(preview.eligible, true);

  const first = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results,
  });
  assert.equal(first.reclaimed, true);
  assert.equal(first.code, "RECLAIMED");
  assert.equal(await pathExists(lane.worktree), false);
  // Branch tip still reachable; commits not deleted.
  const branchTip = (await git(workspace, "rev-parse", `refs/heads/${lane.branch}`)).trim();
  assert.equal(branchTip, tip);
  assert.equal(
    (await git(workspace, "cat-file", "-t", tip)).trim(),
    "commit"
  );
  // Registration gone.
  assert.doesNotMatch(await worktreeList(workspace), new RegExp(taskId));

  const second = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results,
  });
  assert.equal(second.reclaimed, true);
  assert.equal(second.alreadyGone, true);
  assert.equal(second.code, "ALREADY_GONE");
});

test("dirty worktree refuses reclaim (DIRTY)", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-dirty-");
  const taskId = "tk-reclaim-dirty";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  await fs.writeFile(path.join(lane.worktree, "DIRTY.txt"), "x\n");

  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "rejected",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });
  const d = await evaluateTaskWorktreeReclaim({ workspaceRoot: workspace, task, results: [] });
  assert.equal(d.code, "DIRTY");
  assert.equal(d.eligible, false);
  assert.equal(await pathExists(lane.worktree), true);
});

test("running task refuses reclaim (NOT_TERMINAL)", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-run-");
  const taskId = "tk-reclaim-run";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "running",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });
  const d = await evaluateTaskWorktreeReclaim({ workspaceRoot: workspace, task });
  assert.equal(d.code, "NOT_TERMINAL");
  assert.equal(d.eligible, false);
});

test("accepted with unintegrated commits refuses (UNINTEGRATED)", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-unint-");
  const taskId = "tk-reclaim-unint";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  const base = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
  await fs.writeFile(path.join(lane.worktree, "hanging.txt"), "no integrate\n");
  await git(lane.worktree, "add", "hanging.txt");
  await git(lane.worktree, "commit", "-q", "-m", "hanging");
  const tip = (await git(lane.worktree, "rev-parse", "HEAD")).trim();

  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "accepted",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
    baseCommit: base,
  });
  const results: TaskResultRecord[] = [
    {
      path: "rs.md",
      id: "rs-u",
      taskId,
      status: "accepted",
      report: "claimed integrated but was not",
      commits: [tip],
      checks: [],
      artifactRefs: [],
      integrationMode: null,
      createdAt: "2026-08-13T00:00:00.000Z",
    },
  ];
  const d = await evaluateTaskWorktreeReclaim({
    workspaceRoot: workspace,
    task,
    results,
  });
  assert.equal(d.code, "UNINTEGRATED");
  assert.equal(d.eligible, false);
  assert.equal(await pathExists(lane.worktree), true);
});

test("rejected clean lane reclaims without result commits", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-rej-");
  const taskId = "tk-reclaim-rej";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "rejected",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });
  const r = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results: [],
  });
  assert.equal(r.reclaimed, true);
  assert.equal(r.code, "RECLAIMED");
  assert.equal(await pathExists(lane.worktree), false);
  // Branch still exists for audit.
  assert.equal(
    (await git(workspace, "show-ref", "--verify", "--quiet", `refs/heads/${lane.branch}`),
      true) || true,
    true
  );
  const exists = await git(workspace, "show-ref", "--verify", `refs/heads/${lane.branch}`)
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, true);
});

test("external / unexpected worktree path refuses", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-ext-");
  const foreign = path.join(path.dirname(workspace), "foreign-wt");
  await fs.mkdir(foreign, { recursive: true });
  const task = sessionTask({
    id: "tk-reclaim-ext",
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "failed",
    workspace,
    worktree: foreign,
    branch: taskWorktreeBranchName("tk-reclaim-ext"),
    targetBranch: "main",
  });
  const d = await evaluateTaskWorktreeReclaim({ workspaceRoot: workspace, task });
  assert.equal(d.code, "EXTERNAL_OR_UNEXPECTED_PATH");
  assert.equal(d.eligible, false);
});

test("no lane recorded → NOT_APPLICABLE", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-nolan-");
  const task = sessionTask({
    id: "tk-docs",
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "accepted",
  });
  const d = await evaluateTaskWorktreeReclaim({ workspaceRoot: workspace, task });
  assert.equal(d.code, "NOT_APPLICABLE");
});

test("P0: accepted TaskResult omits branch tip → UNINTEGRATED (task-branch settle)", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-omit-");
  const taskId = "tk-reclaim-omit";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  const base = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
  await fs.writeFile(path.join(lane.worktree, "declared.txt"), "in result\n");
  await git(lane.worktree, "add", "declared.txt");
  await git(lane.worktree, "commit", "-q", "-m", "declared");
  const declared = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
  await fs.writeFile(path.join(lane.worktree, "omitted.txt"), "not in result\n");
  await git(lane.worktree, "add", "omitted.txt");
  await git(lane.worktree, "commit", "-q", "-m", "omitted tip");
  const omitted = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
  // Integrate only the declared commit into main; leave omitted tip on task branch.
  await git(workspace, "cherry-pick", "-x", declared);

  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "accepted",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
    baseCommit: base,
  });
  const results: TaskResultRecord[] = [
    {
      path: "rs.md",
      id: "rs-omit",
      taskId,
      status: "accepted",
      report: "only declared",
      commits: [declared],
      checks: [],
      artifactRefs: [],
      integrationMode: null,
      createdAt: "2026-08-13T00:00:00.000Z",
    },
  ];
  const d = await evaluateTaskWorktreeReclaim({
    workspaceRoot: workspace,
    task,
    results,
  });
  assert.equal(d.code, "UNINTEGRATED");
  assert.equal(d.eligible, false);
  assert.equal((d.details as { source?: string } | undefined)?.source, "task-branch");
  assert.ok(
    ((d.details as { missingCommits?: string[] } | undefined)?.missingCommits ?? []).includes(
      omitted
    )
  );
  assert.equal(await pathExists(lane.worktree), true);
});

test("accepted branch reclaim requires exact baseCommit when task branch still exists", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-missing-base-");
  const taskId = "tk-reclaim-missing-base";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  await fs.writeFile(path.join(lane.worktree, "done.txt"), "integrated\n");
  await git(lane.worktree, "add", "done.txt");
  await git(lane.worktree, "commit", "-q", "-m", "done");
  const done = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
  await git(workspace, "cherry-pick", "-x", done);

  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "accepted",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });
  const d = await evaluateTaskWorktreeReclaim({
    workspaceRoot: workspace,
    task,
    results: [],
  });
  assert.equal(d.code, "AMBIGUOUS_OWNERSHIP");
  assert.equal(d.eligible, false);
  assert.match(d.reason, /missing baseCommit/i);
  assert.equal(await pathExists(lane.worktree), true);
});

test("accepted branch reclaim rejects invalid or non-ancestor baseCommit", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-bad-base-");
  const taskId = "tk-reclaim-bad-base";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  await fs.writeFile(path.join(lane.worktree, "done.txt"), "integrated\n");
  await git(lane.worktree, "add", "done.txt");
  await git(lane.worktree, "commit", "-q", "-m", "done");
  const done = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
  await git(workspace, "cherry-pick", "-x", done);

  const invalidBase = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/invalid.md",
    state: "accepted",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
    baseCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  });
  const invalid = await evaluateTaskWorktreeReclaim({
    workspaceRoot: workspace,
    task: invalidBase,
    results: [],
  });
  assert.equal(invalid.code, "AMBIGUOUS_OWNERSHIP");
  assert.match(invalid.reason, /baseCommit .* unreadable/i);

  await fs.writeFile(path.join(workspace, "main-only.txt"), "later main commit\n");
  await git(workspace, "add", "main-only.txt");
  await git(workspace, "commit", "-q", "-m", "main-only");
  const nonAncestorBase = (await git(workspace, "rev-parse", "HEAD")).trim();
  const nonAncestorTask = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/non-ancestor.md",
    state: "accepted",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
    baseCommit: nonAncestorBase,
  });
  const nonAncestor = await evaluateTaskWorktreeReclaim({
    workspaceRoot: workspace,
    task: nonAncestorTask,
    results: [],
  });
  assert.equal(nonAncestor.code, "AMBIGUOUS_OWNERSHIP");
  assert.match(nonAncestor.reason, /not an ancestor/i);
  assert.equal(await pathExists(lane.worktree), true);
});

test("P0: absent dir drops only exact stale registration (no broad prune inventory)", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-stale-");
  const taskId = "tk-reclaim-stale";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  const otherId = "tk-reclaim-other";
  const other = await ensureTaskWorkspace(workspace, otherId);
  // Remove directory out-of-band while leaving registration (simulate crash mid-remove).
  // Git still lists the worktree until cleaned; use OS rmdir after making it empty of locks:
  // force-remove via renaming path away is not used — instead commit-clean then
  // `git worktree remove` partially: delete files then rely on evaluate seeing path.
  await fs.rm(lane.worktree, { recursive: true, force: true });
  // Other lane must survive any cleanup of the first.
  assert.equal(await pathExists(other.worktree), true);

  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "interrupted",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });
  const r = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results: [],
  });
  assert.equal(r.reclaimed, true);
  assert.ok(r.code === "RECLAIMED" || r.code === "ALREADY_GONE");
  assert.equal(await pathExists(lane.worktree), false);
  assert.equal(await pathExists(other.worktree), true, "sibling Task lane must remain");
  assert.match(await worktreeList(workspace), /tk-reclaim-other|task-tk-reclaim-other/);
});

test("P0: existing dir remove refuses when registration branch mismatches (ownership > dirtiness)", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-own-");
  const taskId = "tk-reclaim-own";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "failed",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });
  // Detach HEAD inside the worktree so on-disk branch no longer matches registration tip ownership.
  await git(lane.worktree, "checkout", "--detach", "HEAD");
  const r = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results: [],
  });
  assert.equal(r.reclaimed, false);
  assert.ok(
    r.code === "CONFLICTED_REGISTRATION" || r.code === "AMBIGUOUS_OWNERSHIP",
    `expected ownership refuse, got ${r.code}`
  );
  assert.equal(await pathExists(lane.worktree), true, "must keep scene on ownership mismatch");
});

test("P0: TOCTOU rebind after evaluate refuses remove (registration vs expected branch)", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-toctou-");
  const taskId = "tk-reclaim-toctou";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "failed",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });

  // Prove evaluate would succeed on the clean, correctly registered lane.
  const preview = await evaluateTaskWorktreeReclaim({
    workspaceRoot: workspace,
    task,
    results: [],
  });
  assert.equal(preview.code, "RECLAIMABLE");
  assert.equal(preview.eligible, true);
  assert.equal(preview.branch, lane.branch);

  // After evaluate, before remove: rebind this exact path to a foreign tent-task branch.
  // Fresh registration must then mismatch diagnostic.expected branch → no delete.
  const r = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results: [],
    beforeRemoveForTests: async () => {
      await git(lane.worktree, "checkout", "-B", "tent-task/foreign-rebind");
    },
  });
  assert.equal(r.reclaimed, false);
  assert.equal(
    r.code,
    "CONFLICTED_REGISTRATION",
    `expected CONFLICTED_REGISTRATION after TOCTOU rebind, got ${r.code}: ${r.reason}`
  );
  assert.equal(await pathExists(lane.worktree), true, "TOCTOU mismatch must not delete worktree");
  assert.match(await worktreeList(workspace), /foreign-rebind|task-tk-reclaim-toctou/);
});

test("P0: remove never force-deletes when dirtiness re-check fails", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-noforce-");
  const taskId = "tk-reclaim-noforce";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "failed",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });
  // Eligible while clean…
  const clean = await evaluateTaskWorktreeReclaim({
    workspaceRoot: workspace,
    task,
    results: [],
  });
  assert.equal(clean.code, "RECLAIMABLE");
  // …then dirtiness appears before remove (simulate TOCTOU).
  await fs.writeFile(path.join(lane.worktree, "race.txt"), "race\n");
  const r = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results: [],
  });
  assert.equal(r.reclaimed, false);
  assert.equal(r.code, "DIRTY");
  assert.equal(await pathExists(lane.worktree), true, "must not force-remove dirty tree");
  // Registration still present.
  assert.match(await worktreeList(workspace), /task-tk-reclaim-noforce|tk-reclaim-noforce/);
});

/**
 * Production regression (cx-80g9p5): Task lane node_modules was a Windows junction
 * into shared deps. git worktree remove followed the reparse point and deleted the
 * target. Reclaim must Node-fs.rm the lane (link-only for junctions) then drop only
 * exact Git registration; external sentinel must survive. Never use the real
 * workspace root node_modules as the destructive target — isolated external only.
 */
test("P0: reclaim Node-rm lane with outbound junction; external sentinel survives", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-junc-");
  // Production Task lanes share a committed .gitignore so node_modules junctions
  // are not untracked dirtiness before the final clean gate.
  await fs.writeFile(path.join(workspace, ".gitignore"), "node_modules/\n");
  await git(workspace, "add", ".gitignore");
  await git(workspace, "commit", "-q", "-m", "ignore node_modules");
  const taskId = "tk-reclaim-junc";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  const tipBefore = (await git(lane.worktree, "rev-parse", "HEAD")).trim();

  // Isolated external target (not the real Tent root node_modules).
  // Package-like nested layout: sentinel + package.json + .bin/tool.cmd.
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tent-reclaim-ext-"));
  const sentinelPath = path.join(externalRoot, "sentinel.txt");
  const sentinelBody = `survive-${taskId}-${Date.now()}\n`;
  await fs.writeFile(sentinelPath, sentinelBody);
  const packageJsonPath = path.join(externalRoot, "package.json");
  const packageJsonBody = '{\n  "name": "shared-deps-standin",\n  "version": "0.0.0"\n}\n';
  await fs.writeFile(packageJsonPath, packageJsonBody);
  const binDir = path.join(externalRoot, ".bin");
  await fs.mkdir(binDir);
  const toolCmdPath = path.join(binDir, "tool.cmd");
  const toolCmdBody = "@echo off\r\necho shared-tool\r\n";
  await fs.writeFile(toolCmdPath, toolCmdBody);

  const linkPath = path.join(lane.worktree, "node_modules");
  let linkKind: "junction" | "dir" | "unsupported" = "unsupported";
  if (process.platform === "win32") {
    try {
      await fs.symlink(externalRoot, linkPath, "junction");
      linkKind = "junction";
    } catch {
      try {
        await fs.symlink(externalRoot, linkPath, "dir");
        linkKind = "dir";
      } catch {
        linkKind = "unsupported";
      }
    }
  } else {
    try {
      await fs.symlink(externalRoot, linkPath, "dir");
      linkKind = "dir";
    } catch {
      linkKind = "unsupported";
    }
  }
  if (linkKind === "unsupported") {
    // Host cannot create the production link shape; still prove the small helper.
    const missing = await removeTaskLaneDirectorySafe(
      path.join(lane.worktree, "no-such-lane-dir-xyz")
    );
    assert.equal(missing.ok, false);
    return;
  }

  const linkStat = await fs.lstat(linkPath);
  assert.equal(linkStat.isSymbolicLink(), true, `expected ${linkKind} to report isSymbolicLink`);

  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "failed",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });

  const r = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results: [],
  });
  assert.equal(
    r.reclaimed,
    true,
    `expected RECLAIMED after ${linkKind} Node-rm, got ${r.code}: ${r.reason}`
  );
  assert.equal(r.code, "RECLAIMED");
  assert.equal(await pathExists(lane.worktree), false, "Task worktree directory must be gone");
  assert.doesNotMatch(
    await worktreeList(workspace),
    new RegExp(taskId),
    "Git worktree registration must be gone"
  );
  // Branch + commits preserved (metadata-only force after dir absent).
  const branchTip = (await git(workspace, "rev-parse", `refs/heads/${lane.branch}`)).trim();
  assert.equal(branchTip, tipBefore);
  assert.equal((await git(workspace, "cat-file", "-t", tipBefore)).trim(), "commit");

  assert.equal(await pathExists(externalRoot), true, "external target dir must survive");
  assert.equal(await pathExists(sentinelPath), true, "external sentinel must survive");
  assert.equal(await fs.readFile(sentinelPath, "utf8"), sentinelBody);
  assert.equal(await fs.readFile(packageJsonPath, "utf8"), packageJsonBody);
  assert.equal(await fs.readFile(toolCmdPath, "utf8"), toolCmdBody);
});

test("P0: portable file symlink outbound survives Node-rm reclaim", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-slink-");
  await fs.writeFile(path.join(workspace, ".gitignore"), "shared-bin\n");
  await git(workspace, "add", ".gitignore");
  await git(workspace, "commit", "-q", "-m", "ignore shared-bin link");
  const taskId = "tk-reclaim-slink";
  const lane = await ensureTaskWorkspace(workspace, taskId);

  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tent-reclaim-slink-ext-"));
  const targetFile = path.join(externalRoot, "shared-bin.txt");
  const body = "portable-symlink-sentinel\n";
  await fs.writeFile(targetFile, body);

  const linkPath = path.join(lane.worktree, "shared-bin");
  try {
    await fs.symlink(
      targetFile,
      linkPath,
      process.platform === "win32" ? "file" : undefined
    );
  } catch {
    // Windows without symlink privilege: skip without failing the suite.
    return;
  }
  assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true);

  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "interrupted",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });
  const r = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results: [],
  });
  assert.equal(r.reclaimed, true, `got ${r.code}: ${r.reason}`);
  assert.equal(await pathExists(lane.worktree), false);
  assert.equal(await fs.readFile(targetFile, "utf8"), body);
});

/**
 * Tracked symlink must not break reclaim the way pre-unlink-then-git-remove did
 * (that left a dirty tracked deletion). Node-rm of the whole lane + metadata force
 * clears registration without requiring a clean porcelain after partial unlink.
 */
test("P0: tracked symlink in lane reclaims; external target survives", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-tracked-sl-");
  const taskId = "tk-reclaim-tracked-sl";
  const lane = await ensureTaskWorkspace(workspace, taskId);

  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tent-reclaim-tsl-ext-"));
  const targetFile = path.join(externalRoot, "tracked-target.txt");
  const body = "tracked-symlink-sentinel\n";
  await fs.writeFile(targetFile, body);

  const linkPath = path.join(lane.worktree, "tracked-link");
  try {
    await fs.symlink(
      targetFile,
      linkPath,
      process.platform === "win32" ? "file" : undefined
    );
  } catch {
    return;
  }
  await git(lane.worktree, "add", "tracked-link");
  await git(lane.worktree, "commit", "-q", "-m", "add tracked symlink");
  const tip = (await git(lane.worktree, "rev-parse", "HEAD")).trim();

  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "failed",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });
  const r = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results: [],
  });
  assert.equal(r.reclaimed, true, `got ${r.code}: ${r.reason}`);
  assert.equal(await pathExists(lane.worktree), false);
  assert.doesNotMatch(await worktreeList(workspace), new RegExp(taskId));
  assert.equal((await git(workspace, "rev-parse", `refs/heads/${lane.branch}`)).trim(), tip);
  assert.equal(await fs.readFile(targetFile, "utf8"), body);
});

test("P0: lane root reparse/junction fails closed before Node rm", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-reclaim-rootlink-"));
  const realDir = path.join(parent, "real-lane");
  const linkLane = path.join(parent, "link-lane");
  await fs.mkdir(realDir);
  try {
    if (process.platform === "win32") {
      await fs.symlink(realDir, linkLane, "junction");
    } else {
      await fs.symlink(realDir, linkLane, "dir");
    }
  } catch {
    return;
  }
  const result = await removeTaskLaneDirectorySafe(linkLane);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /lane root is a symlink|junction|reparse/i);
  }
  assert.equal(await pathExists(linkLane), true, "link-as-root must remain");
  assert.equal(await pathExists(realDir), true, "real target dir must remain");
});

test("P0: Node lane rm failure fails closed (registration untouched)", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-rm-fail-");
  await fs.writeFile(path.join(workspace, ".gitignore"), "node_modules/\n");
  await git(workspace, "add", ".gitignore");
  await git(workspace, "commit", "-q", "-m", "ignore node_modules");
  const taskId = "tk-reclaim-rm-fail";
  const lane = await ensureTaskWorkspace(workspace, taskId);

  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tent-reclaim-rmf-ext-"));
  const sentinelPath = path.join(externalRoot, "keep.txt");
  await fs.writeFile(sentinelPath, "must-keep\n");

  const linkPath = path.join(lane.worktree, "node_modules");
  try {
    if (process.platform === "win32") {
      await fs.symlink(externalRoot, linkPath, "junction");
    } else {
      await fs.symlink(externalRoot, linkPath, "dir");
    }
  } catch {
    return;
  }

  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "failed",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });

  const r = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results: [],
    rmLaneDirectoryForTests: async () => {
      throw new Error("simulated fs.rm EPERM");
    },
  });
  assert.equal(r.reclaimed, false);
  assert.equal(r.code, "REMOVE_FAILED");
  assert.match(r.reason, /Node-safe|fs\.rm|simulated fs\.rm/i);
  assert.equal(await pathExists(lane.worktree), true, "lane preserved on rm failure");
  assert.equal(await pathExists(linkPath), true, "junction left in place when rm fails");
  assert.equal(await fs.readFile(sentinelPath, "utf8"), "must-keep\n");
  assert.match(await worktreeList(workspace), /tk-reclaim-rm-fail|task-tk-reclaim-rm-fail/);
});

/**
 * After Node-safe lane rm succeeds, exact metadata force can still fail.
 * Registration/branch/external target/sibling must remain; a later dir-absent
 * retry clears only this registration (no global prune).
 */
test("P0: metadata force failure then dir-absent retry clears only exact registration", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-meta-retry-");
  await fs.writeFile(path.join(workspace, ".gitignore"), "node_modules/\n");
  await git(workspace, "add", ".gitignore");
  await git(workspace, "commit", "-q", "-m", "ignore node_modules");
  const taskId = "tk-reclaim-meta-retry";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  const siblingId = "tk-reclaim-meta-sib";
  const sibling = await ensureTaskWorkspace(workspace, siblingId);
  const tipBefore = (await git(lane.worktree, "rev-parse", "HEAD")).trim();

  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tent-reclaim-meta-ext-"));
  const sentinelPath = path.join(externalRoot, "sentinel.txt");
  const sentinelBody = "meta-retry-sentinel\n";
  await fs.writeFile(sentinelPath, sentinelBody);
  const pkgPath = path.join(externalRoot, "package.json");
  await fs.writeFile(pkgPath, '{"name":"meta-retry"}\n');

  const linkPath = path.join(lane.worktree, "node_modules");
  try {
    if (process.platform === "win32") {
      await fs.symlink(externalRoot, linkPath, "junction");
    } else {
      await fs.symlink(externalRoot, linkPath, "dir");
    }
  } catch {
    return;
  }

  const task = sessionTask({
    id: taskId,
    path: "temp/sessions/ss-fakedefault/tasks/t.md",
    state: "failed",
    workspace: lane.workspace,
    worktree: lane.worktree,
    branch: lane.branch,
    targetBranch: lane.targetBranch,
  });

  const first = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results: [],
    removeWorktreeMetadataForTests: async () => {
      throw new Error("simulated git worktree remove --force EPERM");
    },
  });
  assert.equal(first.reclaimed, false);
  assert.equal(first.code, "REMOVE_FAILED");
  assert.match(first.reason, /stale registration|simulated git worktree remove/i);
  // Lane dir gone (Node rm ran); registration still present for retry.
  assert.equal(await pathExists(lane.worktree), false, "lane dir removed by Node rm");
  assert.match(
    await worktreeList(workspace),
    new RegExp(taskId),
    "exact registration must remain after metadata failure"
  );
  assert.equal(
    (await git(workspace, "rev-parse", `refs/heads/${lane.branch}`)).trim(),
    tipBefore,
    "branch tip preserved"
  );
  assert.equal(await pathExists(sibling.worktree), true, "sibling worktree must remain");
  assert.match(await worktreeList(workspace), new RegExp(siblingId));
  assert.equal(await fs.readFile(sentinelPath, "utf8"), sentinelBody);
  assert.equal(await fs.readFile(pkgPath, "utf8"), '{"name":"meta-retry"}\n');

  // Second call: dir already absent → metadata-only path succeeds (real git).
  const second = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    results: [],
  });
  assert.equal(second.reclaimed, true, `retry got ${second.code}: ${second.reason}`);
  assert.ok(second.code === "RECLAIMED" || second.code === "ALREADY_GONE");
  assert.equal(await pathExists(lane.worktree), false);
  assert.doesNotMatch(await worktreeList(workspace), new RegExp(taskId));
  assert.equal(await pathExists(sibling.worktree), true, "sibling still present after retry");
  assert.match(await worktreeList(workspace), new RegExp(siblingId));
  assert.equal(
    (await git(workspace, "rev-parse", `refs/heads/${lane.branch}`)).trim(),
    tipBefore
  );
  assert.equal(await fs.readFile(sentinelPath, "utf8"), sentinelBody);
});
