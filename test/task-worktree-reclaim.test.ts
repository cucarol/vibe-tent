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
import type { TaskEnvelope } from "../src/core/task.js";
import type { DeliveryRecord } from "../src/core/delivery.js";
import {
  buildTaskContextCard,
  type TaskContextCardV1,
} from "../src/core/task-context-card.js";

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
}): TaskContextCardV1 {
  const nodeId = overrides?.nodeId ?? "cx-1";
  const nodePath = overrides?.nodePath ?? "inbox";
  return buildTaskContextCard({
    objective: "Terminal Task worktree reclaim fixture",
    acceptance: ["Lane reclaims only when terminal, clean, and settled"],
    refs: {
      nodes: [{ id: nodeId, path: nodePath }],
      tasks: [],
      deliveries: [],
      git: [],
    },
  });
}

function sessionTask(
  partial: Partial<TaskEnvelope> & Pick<TaskEnvelope, "id" | "state" | "path">
): TaskEnvelope {
  const contextCard = partial.contextCard ?? fixtureContextCard();
  return {
    sessionId: "ss-fakedefault",
    manifest: "temp/sessions/ss-fakedefault/manifests/m.yml",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    contextCard,
    taskDeltaDigest: contextCard.taskDeltaDigest,
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
    roleId: "rl-executor",
    sessionId: undefined,
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
  });
  const deliveries: DeliveryRecord[] = [
    {
      path: "temp/sessions/ss-fakedefault/deliveries/dl-1.md",
      id: "dl-1",
      taskId,
      sourceNodeId: "cx-1",
      status: "accepted",
      summary: "done",
      commits: [tip],
      checks: [],
      artifactRefs: [],
      integrationMode: "manual-accept",
    },
  ];

  const preview = await evaluateTaskWorktreeReclaim({
    workspaceRoot: workspace,
    task,
    deliveries,
  });
  assert.equal(preview.code, "RECLAIMABLE");
  assert.equal(preview.eligible, true);

  const first = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    deliveries,
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
    deliveries,
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
  const d = await evaluateTaskWorktreeReclaim({ workspaceRoot: workspace, task, deliveries: [] });
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
  });
  const deliveries: DeliveryRecord[] = [
    {
      path: "d.md",
      id: "dl-u",
      taskId,
      sourceNodeId: "cx-1",
      status: "accepted",
      summary: "claimed integrated but was not",
      commits: [tip],
      checks: [],
      artifactRefs: [],
      integrationMode: "manual-accept",
    },
  ];
  const d = await evaluateTaskWorktreeReclaim({
    workspaceRoot: workspace,
    task,
    deliveries,
  });
  assert.equal(d.code, "UNINTEGRATED");
  assert.equal(d.eligible, false);
  assert.equal(await pathExists(lane.worktree), true);
});

test("rejected clean lane reclaims without delivery commits", async () => {
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
    deliveries: [],
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

test("P0: accepted Delivery omits branch tip → UNINTEGRATED (task-branch settle)", async () => {
  const workspace = await makeGitWorkspace("tent-reclaim-omit-");
  const taskId = "tk-reclaim-omit";
  const lane = await ensureTaskWorkspace(workspace, taskId);
  const base = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
  await fs.writeFile(path.join(lane.worktree, "declared.txt"), "in delivery\n");
  await git(lane.worktree, "add", "declared.txt");
  await git(lane.worktree, "commit", "-q", "-m", "declared");
  const declared = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
  await fs.writeFile(path.join(lane.worktree, "omitted.txt"), "not in delivery\n");
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
    roleBranchBase: base,
  });
  const deliveries: DeliveryRecord[] = [
    {
      path: "d.md",
      id: "dl-omit",
      taskId,
      sourceNodeId: "cx-1",
      status: "accepted",
      summary: "only declared",
      commits: [declared],
      checks: [],
      artifactRefs: [],
      integrationMode: "manual-accept",
    },
  ];
  const d = await evaluateTaskWorktreeReclaim({
    workspaceRoot: workspace,
    task,
    deliveries,
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
    deliveries: [],
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
    deliveries: [],
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
    deliveries: [],
  });
  assert.equal(preview.code, "RECLAIMABLE");
  assert.equal(preview.eligible, true);
  assert.equal(preview.branch, lane.branch);

  // After evaluate, before remove: rebind this exact path to a foreign tent-task branch.
  // Fresh registration must then mismatch diagnostic.expected branch → no delete.
  const r = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    deliveries: [],
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
    deliveries: [],
  });
  assert.equal(clean.code, "RECLAIMABLE");
  // …then dirtiness appears before remove (simulate TOCTOU).
  await fs.writeFile(path.join(lane.worktree, "race.txt"), "race\n");
  const r = await reclaimTaskWorktree({
    workspaceRoot: workspace,
    task,
    deliveries: [],
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
    deliveries: [],
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
    deliveries: [],
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
    deliveries: [],
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
    deliveries: [],
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
    deliveries: [],
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
    deliveries: [],
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

test("P0: pending reclaim queue is explicit opt-in only", async () => {
  const { NodeFs } = await import("../src/fs/node-fs.js");
  const {
    enqueueTaskWorktreeReclaimPending,
    listTaskWorktreeReclaimPending,
    dequeueTaskWorktreeReclaimPending,
    listTaskWorktreeReclaimPendingForWorkspace,
  } = await import("../src/core/task-worktree-reclaim-queue.js");
  const { isSameWorkspaceRoot } = await import("../src/core/workspace.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-reclaim-q-"));
  const fsa = new NodeFs(dir);
  assert.deepEqual(await listTaskWorktreeReclaimPending(fsa), []);
  await enqueueTaskWorktreeReclaimPending(fsa, {
    taskId: "tk-a",
    taskPath: "temp/sessions/ss-x/tasks/a.md",
    workspaceRoot: "/ws/a",
    trigger: "task.reject",
  });
  await enqueueTaskWorktreeReclaimPending(fsa, {
    taskId: "tk-b",
    taskPath: "temp/sessions/ss-x/tasks/b.md",
    workspaceRoot: "/ws/b",
    trigger: "task.accept",
  });
  const all = await listTaskWorktreeReclaimPending(fsa);
  assert.equal(all.length, 2);
  const onlyA = await listTaskWorktreeReclaimPendingForWorkspace(
    fsa,
    "/ws/a",
    (a, b) => isSameWorkspaceRoot(path.resolve(a), path.resolve(b))
  );
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0]!.taskId, "tk-a");
  assert.equal(await dequeueTaskWorktreeReclaimPending(fsa, "tk-a"), true);
  assert.equal((await listTaskWorktreeReclaimPending(fsa)).length, 1);
});

/** Slow FsAdapter: delay queue-file IO so concurrent RMW would race without a lock. */
function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slowQueueFs(
  inner: import("../src/core/adapter.js").FsAdapter,
  delayReadMs: number,
  delayWriteMs: number
): import("../src/core/adapter.js").FsAdapter {
  return {
    listDir: (dir) => inner.listDir(dir),
    readFile: async (p) => {
      if (p.includes("task-worktree-reclaim-pending")) {
        await delayMs(delayReadMs);
      }
      return inner.readFile(p);
    },
    writeFile: async (p, content) => {
      if (p.includes("task-worktree-reclaim-pending")) {
        await delayMs(delayWriteMs);
      }
      return inner.writeFile(p, content);
    },
    readBinary: (p) => inner.readBinary(p),
    writeBinary: (p, data) => inner.writeBinary(p, data),
    exists: async (p) => {
      if (p.includes("task-worktree-reclaim-pending")) {
        await delayMs(delayReadMs);
      }
      return inner.exists(p);
    },
    mkdir: (p) => inner.mkdir(p),
    move: (from, to) => inner.move(from, to),
    remove: (p) => inner.remove(p),
    withLock: inner.withLock?.bind(inner),
  };
}

test("P0: concurrent distinct enqueues retain all siblings", async () => {
  const { NodeFs } = await import("../src/fs/node-fs.js");
  const {
    enqueueTaskWorktreeReclaimPending,
    listTaskWorktreeReclaimPending,
  } = await import("../src/core/task-worktree-reclaim-queue.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-reclaim-q-par-"));
  const fsa = slowQueueFs(new NodeFs(dir), 15, 10);
  const ids = Array.from({ length: 12 }, (_, i) => `tk-par-${String(i).padStart(2, "0")}`);
  await Promise.all(
    ids.map((taskId) =>
      enqueueTaskWorktreeReclaimPending(fsa, {
        taskId,
        taskPath: `temp/sessions/ss-x/tasks/${taskId}.md`,
        workspaceRoot: "/ws/shared",
        trigger: "task.accept",
      })
    )
  );
  const all = await listTaskWorktreeReclaimPending(fsa);
  assert.equal(all.length, ids.length, "every distinct enqueue must survive concurrent RMW");
  assert.deepEqual(
    all.map((e) => e.taskId).sort(),
    [...ids].sort()
  );
});

test("P0: enqueue/dequeue interleaving cannot resurrect or delete siblings", async () => {
  const { NodeFs } = await import("../src/fs/node-fs.js");
  const {
    enqueueTaskWorktreeReclaimPending,
    dequeueTaskWorktreeReclaimPending,
    listTaskWorktreeReclaimPending,
  } = await import("../src/core/task-worktree-reclaim-queue.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-reclaim-q-mix-"));
  const fsa = slowQueueFs(new NodeFs(dir), 12, 8);

  // Seed siblings that must remain through concurrent remove/add of other ids.
  await enqueueTaskWorktreeReclaimPending(fsa, {
    taskId: "tk-keep-a",
    taskPath: "temp/sessions/ss-x/tasks/keep-a.md",
    workspaceRoot: "/ws/a",
    trigger: "seed",
  });
  await enqueueTaskWorktreeReclaimPending(fsa, {
    taskId: "tk-keep-b",
    taskPath: "temp/sessions/ss-x/tasks/keep-b.md",
    workspaceRoot: "/ws/a",
    trigger: "seed",
  });
  await enqueueTaskWorktreeReclaimPending(fsa, {
    taskId: "tk-remove-me",
    taskPath: "temp/sessions/ss-x/tasks/remove-me.md",
    workspaceRoot: "/ws/a",
    trigger: "seed",
  });

  const ops: Promise<unknown>[] = [];
  // Parallel: dequeue one id, enqueue several new ones, re-enqueue removed id once.
  ops.push(dequeueTaskWorktreeReclaimPending(fsa, "tk-remove-me"));
  for (let i = 0; i < 8; i++) {
    const taskId = `tk-new-${i}`;
    ops.push(
      enqueueTaskWorktreeReclaimPending(fsa, {
        taskId,
        taskPath: `temp/sessions/ss-x/tasks/${taskId}.md`,
        workspaceRoot: "/ws/a",
        trigger: "parallel",
      })
    );
  }
  // Attempt to re-add the dequeued id after interleaving starts (may win either order).
  ops.push(
    enqueueTaskWorktreeReclaimPending(fsa, {
      taskId: "tk-remove-me",
      taskPath: "temp/sessions/ss-x/tasks/remove-me-again.md",
      workspaceRoot: "/ws/a",
      trigger: "re-add",
    })
  );
  // Concurrent dequeues of a never-present id must not wipe siblings.
  ops.push(dequeueTaskWorktreeReclaimPending(fsa, "tk-never-existed"));
  await Promise.all(ops);

  const all = await listTaskWorktreeReclaimPending(fsa);
  const ids = new Set(all.map((e) => e.taskId));
  assert.ok(ids.has("tk-keep-a"), "sibling keep-a must not be deleted by interleaving");
  assert.ok(ids.has("tk-keep-b"), "sibling keep-b must not be deleted by interleaving");
  for (let i = 0; i < 8; i++) {
    assert.ok(ids.has(`tk-new-${i}`), `new enqueue tk-new-${i} must be retained`);
  }
  // remove-me was dequeued then re-enqueued; final state is exactly one entry (idempotent).
  assert.equal(
    all.filter((e) => e.taskId === "tk-remove-me").length,
    1,
    "re-enqueued taskId must appear exactly once (no resurrection duplicates)"
  );
  assert.equal(
    all.find((e) => e.taskId === "tk-remove-me")?.taskPath,
    "temp/sessions/ss-x/tasks/remove-me-again.md"
  );
});

test("P0: list after mutation observes committed queue state", async () => {
  const { NodeFs } = await import("../src/fs/node-fs.js");
  const {
    enqueueTaskWorktreeReclaimPending,
    dequeueTaskWorktreeReclaimPending,
    listTaskWorktreeReclaimPending,
  } = await import("../src/core/task-worktree-reclaim-queue.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-reclaim-q-list-"));
  const fsa = slowQueueFs(new NodeFs(dir), 20, 15);

  // Start a slow enqueue, then list must not return until that mutation commits
  // (or after it, with the entry visible) — never a torn mid-RMW snapshot.
  const enqueueP = enqueueTaskWorktreeReclaimPending(fsa, {
    taskId: "tk-visible",
    taskPath: "temp/sessions/ss-x/tasks/visible.md",
    workspaceRoot: "/ws/v",
    trigger: "list-observe",
  });
  // Schedule list slightly after enqueue starts so it queues behind the critical section.
  await delayMs(5);
  const listDuring = listTaskWorktreeReclaimPending(fsa);
  const [enqueued, listed] = await Promise.all([enqueueP, listDuring]);
  assert.equal(enqueued.taskId, "tk-visible");
  assert.ok(
    listed.some((e) => e.taskId === "tk-visible"),
    "list serialized after enqueue must observe the committed entry"
  );

  const dequeueP = dequeueTaskWorktreeReclaimPending(fsa, "tk-visible");
  await delayMs(5);
  const listAfterDeqStart = listTaskWorktreeReclaimPending(fsa);
  const [removed, listed2] = await Promise.all([dequeueP, listAfterDeqStart]);
  assert.equal(removed, true);
  assert.ok(
    !listed2.some((e) => e.taskId === "tk-visible"),
    "list serialized after dequeue must not resurrect the removed entry"
  );
  assert.deepEqual(await listTaskWorktreeReclaimPending(fsa), []);
});
