/**
 * Git/Delivery integrity: concurrent accept on same target + foreign commits[] SHA.
 *
 * 1. Two ready Deliveries with the same targetHead accepted concurrently:
 *    exactly one integrates; the other fails stable retryable TARGET_MOVED and
 *    remains ready/delivered. Serialization is by git-common-dir + fully resolved
 *    target ref (not workspaceId / taskPath / lexical workspace path).
 * 2. Public task.deliver commits[] foreign/missing/base SHAs refuse ready Delivery
 *    and leave Git unchanged.
 * 3. Lock identity and CAS rollback ownership are covered in workspace.test
 *    (common-dir key across worktree projections; external advance after own write).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { ensureRoleWorkspace } from "../src/core/workspace.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { RPC_LIFECYCLE } from "../src/service/types.js";
import { configureTestGitIdentity, git } from "./helpers.js";

async function makeWorkspace(name = "git-integrity"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-gi-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    rules: "# RULES\n\nGit/Delivery integrity\n",
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          {
            name: "executor-a",
            prompt: "do work a",
            allowedProfiles: ["fake-default"],
          },
          {
            name: "executor-b",
            prompt: "do work b",
            allowedProfiles: ["fake-default"],
          },
          {
            name: "executor",
            prompt: "do work",
            allowedProfiles: ["fake-default"],
          },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function initGitOnWorkspace(workspace: string): Promise<void> {
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", ".gitignore", "README.md");
  await git(workspace, "commit", "-q", "-m", "init");
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-gi-svc-"));
  const svc = await startLocalTentService({ dataDir });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

function rpc(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  method: string,
  params?: Record<string, unknown>
) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

async function mountWorkItem(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string,
  name = "work-item"
) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name,
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  const boxId = (created.result as { id: string }).id;
  return { workspaceId, boxId };
}

async function claimRunningWithBase(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string,
  opts: {
    role: string;
    prompt: string;
    noteName?: string;
    workspaceId?: string;
  }
): Promise<{
  workspaceId: string;
  taskPath: string;
  baseCommit: string;
  worktree: string;
  branch: string;
}> {
  let workspaceId = opts.workspaceId;
  let boxId: string;
  if (workspaceId) {
    const created = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: opts.noteName ?? `item-${opts.role}`,
      type: "prompt",
    });
    assert.ok(!created.error, JSON.stringify(created.error));
    boxId = (created.result as { id: string }).id;
  } else {
    const mounted = await mountWorkItem(svc, ws, opts.noteName ?? `item-${opts.role}`);
    workspaceId = mounted.workspaceId;
    boxId = mounted.boxId;
  }

  const d = await rpc(svc, "task.dispatch", {
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    workspaceId,
    boxId,
    role: opts.role,
    prompt: opts.prompt,
    deliveryPolicy: "review",
  });
  assert.ok(!d.error, JSON.stringify(d.error));
  const taskPath = (d.result as { taskPath: string }).taskPath;
  await rpc(svc, "task.claim", { workspaceId, taskPath });
  const started = await rpc(svc, "task.startSession", {
    workspaceId,
    taskPath,
    profileId: "fake-default",
    callerKind: "user",
  });
  assert.ok(!started.error, JSON.stringify(started.error));
  const got = await rpc(svc, "task.get", { workspaceId, taskPath });
  const lane = (
    got.result as {
      task: {
        workspaceLane?: {
          baseCommit?: string;
          worktree?: string;
          branch?: string;
        };
      };
    }
  ).task.workspaceLane;
  const baseCommit = lane?.baseCommit?.trim() || "";
  const worktree = lane?.worktree?.trim() || "";
  const branch = lane?.branch?.trim() || "";
  assert.ok(baseCommit, "startSession must persist exact workspaceLane.baseCommit");
  assert.ok(worktree, "startSession must bind executor worktree");
  assert.ok(branch, "startSession must bind executor branch");
  return { workspaceId, taskPath, baseCommit, worktree, branch };
}

async function taskCommitOnLane(
  worktree: string,
  filename: string,
  contents: string,
  message: string
): Promise<string> {
  await fs.writeFile(path.join(worktree, filename), contents);
  await git(worktree, "add", filename);
  await git(worktree, "commit", "-q", "-m", message);
  return (await git(worktree, "rev-parse", "HEAD")).trim();
}

function targetMovedData(error: { code?: number; data?: unknown } | undefined): Record<string, unknown> {
  assert.ok(error, "expected RPC error");
  assert.equal(error!.code, RPC_LIFECYCLE);
  const data = error!.data as Record<string, unknown> | undefined;
  assert.ok(data, "expected TARGET_MOVED data");
  assert.equal(data!.code, "TARGET_MOVED");
  return data!;
}

function deliverCommitLaneData(
  error: { code?: number; data?: unknown } | undefined
): Record<string, unknown> {
  assert.ok(error, "expected RPC error");
  assert.equal(error!.code, RPC_LIFECYCLE);
  const data = error!.data as Record<string, unknown> | undefined;
  assert.ok(data, "expected DELIVER_COMMIT_LANE data");
  assert.equal(data!.code, "DELIVER_COMMIT_LANE");
  return data!;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test("concurrent accept same targetHead: one integrates; other TARGET_MOVED remains ready", async () => {
  const ws = await makeWorkspace("concurrent-accept");
  await initGitOnWorkspace(ws);
  // Two independent role lanes → main (same targetBranch).
  await ensureRoleWorkspace(ws, "executor-a");
  await ensureRoleWorkspace(ws, "executor-b");
  const mainAtDeliver = (await git(ws, "rev-parse", "main")).trim();

  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const taskA = await claimRunningWithBase(svc, ws, {
      role: "executor-a",
      prompt: "concurrent A",
      workspaceId,
      noteName: "item-a",
    });
    const taskB = await claimRunningWithBase(svc, ws, {
      role: "executor-b",
      prompt: "concurrent B",
      workspaceId,
      noteName: "item-b",
    });
    assert.equal(taskA.workspaceId, workspaceId);
    assert.equal(taskB.workspaceId, workspaceId);
    assert.notEqual(taskA.taskPath, taskB.taskPath);

    const refA = await taskCommitOnLane(
      taskA.worktree,
      "feat-a.txt",
      "a\n",
      "feat a"
    );
    const refB = await taskCommitOnLane(
      taskB.worktree,
      "feat-b.txt",
      "b\n",
      "feat b"
    );
    assert.notEqual(refA, refB);

    const deliveredA = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath: taskA.taskPath,
      summary: "ready A",
      commits: [refA],
    });
    assert.ok(!deliveredA.error, JSON.stringify(deliveredA.error));
    const headA = (deliveredA.result as { delivery: { targetHead?: string } }).delivery
      .targetHead;
    assert.equal(headA, mainAtDeliver);

    const deliveredB = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath: taskB.taskPath,
      summary: "ready B",
      commits: [refB],
    });
    assert.ok(!deliveredB.error, JSON.stringify(deliveredB.error));
    const headB = (deliveredB.result as { delivery: { targetHead?: string } }).delivery
      .targetHead;
    assert.equal(headB, mainAtDeliver);
    assert.equal(headA, headB, "both Deliveries snapshot the same targetHead");

    // Fire concurrent accepts on different taskPaths sharing the same
    // git-common-dir + refs/heads/main lock (not workspaceId/taskPath).
    const [resA, resB] = await Promise.all([
      rpc(svc, "task.accept", {
        workspaceId,
        taskPath: taskA.taskPath,
        actor: "user",
      }),
      rpc(svc, "task.accept", {
        workspaceId,
        taskPath: taskB.taskPath,
        actor: "user",
      }),
    ]);

    const outcomes = [
      { label: "A", res: resA, taskPath: taskA.taskPath, file: "feat-a.txt" },
      { label: "B", res: resB, taskPath: taskB.taskPath, file: "feat-b.txt" },
    ];
    const winners = outcomes.filter((o) => !o.res.error);
    const losers = outcomes.filter((o) => o.res.error);
    assert.equal(winners.length, 1, "exactly one accept must integrate");
    assert.equal(losers.length, 1, "exactly one accept must fail TARGET_MOVED");

    const winner = winners[0]!;
    const loser = losers[0]!;
    assert.equal((winner.res.result as { state: string }).state, "accepted");
    const moved = targetMovedData(loser.res.error as { code?: number; data?: unknown });
    assert.equal(moved.reason, "head_moved");
    assert.equal(moved.expectedTargetHead, mainAtDeliver);
    assert.notEqual(moved.currentTargetHead, mainAtDeliver);

    // Winner integrated; loser remains delivered with ready Delivery.
    const gotLoser = await rpc(svc, "task.get", {
      workspaceId,
      taskPath: loser.taskPath,
    });
    assert.equal(
      (gotLoser.result as { task: { state: string } }).task.state,
      "delivered",
      "loser must remain ready/delivered for retry"
    );
    const list = await rpc(svc, "delivery.list", { workspaceId });
    const ready = (
      list.result as { deliveries: Array<{ status: string; summary?: string }> }
    ).deliveries.filter((d) => d.status === "ready");
    assert.equal(ready.length, 1, "loser Delivery stays ready");

    assert.equal(await pathExists(path.join(ws, winner.file)), true);
    assert.equal(await pathExists(path.join(ws, loser.file)), false);
    assert.equal((await git(ws, "status", "--porcelain")).trim(), "");
    const mainAfter = (await git(ws, "rev-parse", "main")).trim();
    assert.notEqual(mainAfter, mainAtDeliver);
  });
});

test("task.deliver foreign SHA: no ready Delivery; Git unchanged", async () => {
  const ws = await makeWorkspace("foreign-sha");
  await initGitOnWorkspace(ws);
  await ensureRoleWorkspace(ws, "executor");
  const mainBefore = (await git(ws, "rev-parse", "main")).trim();

  await withService(async (svc) => {
    const { workspaceId, taskPath, baseCommit, worktree } = await claimRunningWithBase(
      svc,
      ws,
      {
        role: "executor",
        prompt: "foreign sha",
      }
    );

    // Legitimate Task commit exists on the lane but is NOT listed — foreign SHA is.
    await taskCommitOnLane(worktree, "legit.txt", "legit\n", "legit work");

    // Foreign lineage: commit on a sibling branch, not in base..task-branch.
    const side = "tent-test/foreign-deliver";
    await git(ws, "checkout", "-q", "-b", side, mainBefore);
    await fs.writeFile(path.join(ws, "foreign.txt"), "foreign\n");
    await git(ws, "add", "foreign.txt");
    await git(ws, "commit", "-q", "-m", "foreign sibling commit");
    const foreignSha = (await git(ws, "rev-parse", "HEAD")).trim();
    await git(ws, "checkout", "-q", "main");
    assert.notEqual(foreignSha, baseCommit);

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "must refuse foreign",
      commits: [foreignSha],
    });
    assert.ok(delivered.error, "foreign SHA must refuse task.deliver");
    const data = deliverCommitLaneData(delivered.error as { code?: number; data?: unknown });
    assert.ok(
      data.laneCode === "NOT_IN_LANE_RANGE" ||
        data.laneCode === "NOT_REACHABLE_FROM_BRANCH",
      `unexpected laneCode ${String(data.laneCode)}`
    );

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal(
      (got.result as { task: { state: string } }).task.state,
      "running",
      "Task must remain running after foreign SHA refuse"
    );
    const list = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal(
      (list.result as { deliveries: unknown[] }).deliveries.length,
      0,
      "must not publish ready Delivery"
    );

    assert.equal((await git(ws, "rev-parse", "main")).trim(), mainBefore);
    assert.equal(await pathExists(path.join(ws, "foreign.txt")), false);
    assert.equal((await git(ws, "status", "--porcelain")).trim(), "");
  });
});

test("task.deliver missing SHA: no ready Delivery; Git unchanged", async () => {
  const ws = await makeWorkspace("missing-sha");
  await initGitOnWorkspace(ws);
  await ensureRoleWorkspace(ws, "executor");
  const mainBefore = (await git(ws, "rev-parse", "main")).trim();

  await withService(async (svc) => {
    const { workspaceId, taskPath, worktree } = await claimRunningWithBase(svc, ws, {
      role: "executor",
      prompt: "missing sha",
    });
    await taskCommitOnLane(worktree, "ok.txt", "ok\n", "ok work");

    const missing = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "must refuse missing",
      commits: [missing],
    });
    assert.ok(delivered.error, "missing SHA must refuse task.deliver");
    const data = deliverCommitLaneData(delivered.error as { code?: number; data?: unknown });
    assert.equal(data.laneCode, "MISSING_COMMIT");

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "running");
    const list = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal((list.result as { deliveries: unknown[] }).deliveries.length, 0);
    assert.equal((await git(ws, "rev-parse", "main")).trim(), mainBefore);
  });
});

test("task.deliver baseCommit itself: no ready Delivery; Git unchanged", async () => {
  const ws = await makeWorkspace("base-as-commit");
  await initGitOnWorkspace(ws);
  await ensureRoleWorkspace(ws, "executor");
  const mainBefore = (await git(ws, "rev-parse", "main")).trim();

  await withService(async (svc) => {
    const { workspaceId, taskPath, baseCommit, worktree } = await claimRunningWithBase(
      svc,
      ws,
      {
        role: "executor",
        prompt: "base as commit",
      }
    );
    // Non-empty lane so history gate is not the only failure mode.
    await taskCommitOnLane(worktree, "extra.txt", "x\n", "extra");

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "must refuse base",
      commits: [baseCommit],
    });
    assert.ok(delivered.error, "baseCommit itself must refuse task.deliver");
    const data = deliverCommitLaneData(delivered.error as { code?: number; data?: unknown });
    assert.equal(data.laneCode, "BASE_COMMIT");

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "running");
    const list = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal((list.result as { deliveries: unknown[] }).deliveries.length, 0);
    assert.equal((await git(ws, "rev-parse", "main")).trim(), mainBefore);
  });
});
