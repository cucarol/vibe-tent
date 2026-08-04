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
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
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
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
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
  const svc = await startLocalTentService({
    dataDir,
    connections: [
      {
        connectionId: "fake-default",
        provider: "fake",
        adapterId: FAKE_ADAPTER_ID,
        fake: { waitForSignal: true },
      },
    ],
  });
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
  const nodeId = (created.result as { nodeId: string }).nodeId;
  return { workspaceId, nodeId };
}

async function claimRunningWithBase(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string,
  opts: {
    label: string;
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
  let nodeId: string;
  if (workspaceId) {
    const created = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: opts.noteName ?? `item-${opts.label}`,
      type: "prompt",
    });
    assert.ok(!created.error, JSON.stringify(created.error));
    nodeId = (created.result as { nodeId: string }).nodeId;
  } else {
    const mounted = await mountWorkItem(svc, ws, opts.noteName ?? `item-${opts.label}`);
    workspaceId = mounted.workspaceId;
    nodeId = mounted.nodeId;
  }

  const d = await rpc(svc, "task.dispatch", {
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    workspaceId,
    workNodeIds: [nodeId],
    contextNodeIds: [],
    connectionId: "fake-default",
    prompt: opts.prompt,
    acceptMode: "review-required",
  });
  assert.ok(!d.error, JSON.stringify(d.error));
  const taskPath = (d.result as { taskPath: string }).taskPath;
  await rpc(svc, "task.claim", { workspaceId, taskPath });
  const started = await rpc(svc, "task.startSession", {
    workspaceId,
    taskPath,
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
  // Two independent exact Task lanes → main (same targetBranch).
  const mainAtDeliver = (await git(ws, "rev-parse", "main")).trim();

  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const taskA = await claimRunningWithBase(svc, ws, {
      label: "executor-a",
      prompt: "concurrent A",
      workspaceId,
      noteName: "item-a",
    });
    const taskB = await claimRunningWithBase(svc, ws, {
      label: "executor-b",
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

test("task.accept rejects caller commit overrides without mutating ready Delivery", async () => {
  const ws = await makeWorkspace("accept-immutable-commits");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const task = await claimRunningWithBase(svc, ws, {
      label: "immutable",
      prompt: "accept immutable Delivery commits",
    });
    const commitA = await taskCommitOnLane(
      task.worktree,
      "immutable-a.txt",
      "a\n",
      "immutable a"
    );
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      summary: "ready A",
      commits: [commitA],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const deliveryPath = (
      delivered.result as { delivery: { path: string; commits: string[] } }
    ).delivery.path;
    assert.deepEqual(
      (delivered.result as { delivery: { commits: string[] } }).delivery.commits,
      [commitA]
    );

    const taskFile = path.join(ws, ".tent", ...task.taskPath.split("/"));
    const deliveryFile = path.join(ws, ".tent", ...deliveryPath.split("/"));
    const beforeTask = await fs.readFile(taskFile);
    const beforeDelivery = await fs.readFile(deliveryFile);
    const beforeMain = (await git(ws, "rev-parse", "main")).trim();

    for (const commits of [[], ["bbbbbbb"]]) {
      const rejected = await rpc(svc, "task.accept", {
        workspaceId: task.workspaceId,
        taskPath: task.taskPath,
        actor: "user",
        commits,
      });
      assert.equal(rejected.error?.code, -32602);
      assert.match(rejected.error?.message ?? "", /commits|unknown parameter/i);
      assert.deepEqual(await fs.readFile(taskFile), beforeTask);
      assert.deepEqual(await fs.readFile(deliveryFile), beforeDelivery);
      assert.equal((await git(ws, "rev-parse", "main")).trim(), beforeMain);
    }

    const accepted = await rpc(svc, "task.accept", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      actor: "user",
    });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    assert.equal((accepted.result as { state: string }).state, "accepted");
    assert.equal(await pathExists(path.join(ws, "immutable-a.txt")), true);
  });
});

test("task.reject rejects unknown fields before mutating Task or Delivery", async () => {
  const ws = await makeWorkspace("reject-exact-params");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const task = await claimRunningWithBase(svc, ws, {
      label: "reject-params",
      prompt: "reject unknown parameters before mutation",
    });
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      summary: "ready for exact reject",
      commits: [],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const deliveryPath = (
      delivered.result as { delivery: { path: string; status: string } }
    ).delivery.path;

    const taskFile = path.join(ws, ".tent", ...task.taskPath.split("/"));
    const deliveryFile = path.join(ws, ".tent", ...deliveryPath.split("/"));
    const beforeTask = await fs.readFile(taskFile);
    const beforeDelivery = await fs.readFile(deliveryFile);

    for (const extra of [
      { actorOverride: "rl-forged" },
      { commits: [] },
      { session: "ss-forged" },
    ]) {
      const rejected = await rpc(svc, "task.reject", {
        workspaceId: task.workspaceId,
        taskPath: task.taskPath,
        actor: "user",
        note: "must not be applied",
        resume: false,
        ...extra,
      });
      assert.equal(rejected.error?.code, -32602, JSON.stringify(rejected));
      assert.match(rejected.error?.message ?? "", /unknown parameter/i);
      assert.deepEqual(await fs.readFile(taskFile), beforeTask);
      assert.deepEqual(await fs.readFile(deliveryFile), beforeDelivery);
    }

    const rejected = await rpc(svc, "task.reject", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      actor: "user",
      note: "valid terminal reject",
      resume: false,
    });
    assert.ok(!rejected.error, JSON.stringify(rejected.error));
    assert.equal((rejected.result as { state: string }).state, "rejected");
    assert.equal(
      (rejected.result as { delivery: { status: string } }).delivery.status,
      "rejected"
    );
  });
});

/**
 * Production path: two distinct Service workspaceId mounts whose roots are
 * different git worktrees of the same repository (shared git-common-dir) and
 * the same target ref. Concurrent accept must serialize on that lock identity
 * (not workspaceId) — exactly one integrates; the other TARGET_MOVED.
 */
test("Service dual workspaceId projections same common-dir+target: concurrent accept serializes", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-gi-dual-"));
  const projA = path.join(parent, "proj-a");
  const projB = path.join(parent, "proj-b");
  await fs.mkdir(projA, { recursive: true });

  // Shared repo: proj-a on main; proj-b is a linked worktree (same git-common-dir).
  await git(projA, "init", "-q", "-b", "main");
  await configureTestGitIdentity(projA);
  await fs.writeFile(path.join(projA, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(projA, "README.md"), "# dual\n");
  await git(projA, "add", ".gitignore", "README.md");
  await git(projA, "commit", "-q", "-m", "init");
  await git(projA, "worktree", "add", "-q", projB, "-b", "tent-test/proj-b-lane");

  for (const root of [projA, projB]) {
    const fsa = new NodeFs(root);
    await scaffoldInWorkspace(fsa, {
      name: path.basename(root),
      nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
    });
  }

  const { resolveIntegrationTargetLockIdentity } = await import(
    "../src/core/workspace.js"
  );
  const idA = await resolveIntegrationTargetLockIdentity(projA, "main");
  const idB = await resolveIntegrationTargetLockIdentity(projB, "main");
  assert.equal(idA.gitCommonDir, idB.gitCommonDir, "projections share git-common-dir");
  assert.equal(idA.targetRef, "refs/heads/main");
  assert.equal(idB.targetRef, "refs/heads/main");

  // Role lanes live in the shared object store (created from either projection).
  const mainAtDeliver = (await git(projA, "rev-parse", "main")).trim();

  await withService(async (svc) => {
    const mountA = await rpc(svc, "workspace.mount", { workspaceRoot: projA });
    const mountB = await rpc(svc, "workspace.mount", { workspaceRoot: projB });
    assert.ok(!mountA.error, JSON.stringify(mountA.error));
    assert.ok(!mountB.error, JSON.stringify(mountB.error));
    const workspaceIdA = (mountA.result as { workspaceId: string }).workspaceId;
    const workspaceIdB = (mountB.result as { workspaceId: string }).workspaceId;
    assert.notEqual(
      workspaceIdA,
      workspaceIdB,
      "distinct path projections must yield distinct workspaceIds"
    );

    const taskA = await claimRunningWithBase(svc, projA, {
      label: "executor-a",
      prompt: "dual A",
      workspaceId: workspaceIdA,
      noteName: "item-a",
    });
    const taskB = await claimRunningWithBase(svc, projB, {
      label: "executor-b",
      prompt: "dual B",
      workspaceId: workspaceIdB,
      noteName: "item-b",
    });
    assert.equal(taskA.workspaceId, workspaceIdA);
    assert.equal(taskB.workspaceId, workspaceIdB);

    const refA = await taskCommitOnLane(taskA.worktree, "dual-a.txt", "a\n", "dual a");
    const refB = await taskCommitOnLane(taskB.worktree, "dual-b.txt", "b\n", "dual b");

    const deliveredA = await rpc(svc, "task.deliver", {
      workspaceId: workspaceIdA,
      taskPath: taskA.taskPath,
      summary: "ready dual A",
      commits: [refA],
    });
    assert.ok(!deliveredA.error, JSON.stringify(deliveredA.error));
    assert.equal(
      (deliveredA.result as { delivery: { targetHead?: string } }).delivery.targetHead,
      mainAtDeliver
    );

    const deliveredB = await rpc(svc, "task.deliver", {
      workspaceId: workspaceIdB,
      taskPath: taskB.taskPath,
      summary: "ready dual B",
      commits: [refB],
    });
    assert.ok(!deliveredB.error, JSON.stringify(deliveredB.error));
    assert.equal(
      (deliveredB.result as { delivery: { targetHead?: string } }).delivery.targetHead,
      mainAtDeliver
    );

    const [resA, resB] = await Promise.all([
      rpc(svc, "task.accept", {
        workspaceId: workspaceIdA,
        taskPath: taskA.taskPath,
        actor: "user",
      }),
      rpc(svc, "task.accept", {
        workspaceId: workspaceIdB,
        taskPath: taskB.taskPath,
        actor: "user",
      }),
    ]);

    const outcomes = [
      { res: resA, workspaceId: workspaceIdA, taskPath: taskA.taskPath, file: "dual-a.txt" },
      { res: resB, workspaceId: workspaceIdB, taskPath: taskB.taskPath, file: "dual-b.txt" },
    ];
    const winners = outcomes.filter((o) => !o.res.error);
    const losers = outcomes.filter((o) => o.res.error);
    assert.equal(winners.length, 1, "exactly one dual-projection accept integrates");
    assert.equal(losers.length, 1, "exactly one dual-projection accept TARGET_MOVED");

    const winner = winners[0]!;
    const loser = losers[0]!;
    assert.equal((winner.res.result as { state: string }).state, "accepted");
    const moved = targetMovedData(loser.res.error as { code?: number; data?: unknown });
    assert.equal(moved.reason, "head_moved");
    assert.equal(moved.expectedTargetHead, mainAtDeliver);

    const gotLoser = await rpc(svc, "task.get", {
      workspaceId: loser.workspaceId,
      taskPath: loser.taskPath,
    });
    assert.equal(
      (gotLoser.result as { task: { state: string } }).task.state,
      "delivered",
      "loser remains ready/delivered under its own workspaceId"
    );

    // Winner artifact on shared main; loser file absent from main worktree.
    assert.equal(await pathExists(path.join(projA, winner.file)), true);
    assert.equal(await pathExists(path.join(projA, loser.file)), false);
    assert.notEqual((await git(projA, "rev-parse", "main")).trim(), mainAtDeliver);
  });
});

/**
 * Same dual-projection setup: blocked integrate hook proves at most one critical
 * writer enters at a time across distinct workspaceIds (common-dir lock).
 */
test("Service dual workspaceId: blocked integrate critical section is exclusive", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-gi-dual-hold-"));
  const projA = path.join(parent, "proj-a");
  const projB = path.join(parent, "proj-b");
  await fs.mkdir(projA, { recursive: true });
  await git(projA, "init", "-q", "-b", "main");
  await configureTestGitIdentity(projA);
  await fs.writeFile(path.join(projA, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(projA, "README.md"), "# dual hold\n");
  await git(projA, "add", ".gitignore", "README.md");
  await git(projA, "commit", "-q", "-m", "init");
  await git(projA, "worktree", "add", "-q", projB, "-b", "tent-test/proj-b-hold");

  for (const root of [projA, projB]) {
    const fsa = new NodeFs(root);
    await scaffoldInWorkspace(fsa, {
      name: path.basename(root),
      nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
    });
  }

  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  let entered = 0;

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-gi-dual-hold-svc-"));
  const svc = await startLocalTentService({
    dataDir,
    connections: [
      {
        connectionId: "fake-default",
        provider: "fake",
        adapterId: FAKE_ADAPTER_ID,
        fake: { waitForSignal: true },
      },
    ],
    integrateCommits: async () => {
      entered += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await hold;
      active -= 1;
    },
  });
  try {
    const mountA = await rpc(svc, "workspace.mount", { workspaceRoot: projA });
    const mountB = await rpc(svc, "workspace.mount", { workspaceRoot: projB });
    const workspaceIdA = (mountA.result as { workspaceId: string }).workspaceId;
    const workspaceIdB = (mountB.result as { workspaceId: string }).workspaceId;
    assert.notEqual(workspaceIdA, workspaceIdB);

    const taskA = await claimRunningWithBase(svc, projA, {
      label: "executor-a",
      prompt: "hold A",
      workspaceId: workspaceIdA,
      noteName: "hold-a",
    });
    const taskB = await claimRunningWithBase(svc, projB, {
      label: "executor-b",
      prompt: "hold B",
      workspaceId: workspaceIdB,
      noteName: "hold-b",
    });
    const refA = await taskCommitOnLane(taskA.worktree, "hold-a.txt", "a\n", "hold a");
    const refB = await taskCommitOnLane(taskB.worktree, "hold-b.txt", "b\n", "hold b");

    for (const row of [
      { workspaceId: workspaceIdA, taskPath: taskA.taskPath, commits: [refA] },
      { workspaceId: workspaceIdB, taskPath: taskB.taskPath, commits: [refB] },
    ]) {
      const d = await rpc(svc, "task.deliver", {
        workspaceId: row.workspaceId,
        taskPath: row.taskPath,
        summary: "ready hold",
        commits: row.commits,
      });
      assert.ok(!d.error, JSON.stringify(d.error));
    }

    const acceptA = rpc(svc, "task.accept", {
      workspaceId: workspaceIdA,
      taskPath: taskA.taskPath,
      actor: "user",
    });
    const acceptB = rpc(svc, "task.accept", {
      workspaceId: workspaceIdB,
      taskPath: taskB.taskPath,
      actor: "user",
    });

    const deadline = Date.now() + 15000;
    while (entered < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(entered >= 1, "at least one accept must enter integrate");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(maxActive, 1, "common-dir lock allows only one integrate critical section");
    assert.equal(entered, 1, "second accept must wait on flight before entering integrate");

    release();
    await Promise.all([acceptA, acceptB]);
    assert.equal(maxActive, 1);
    assert.ok(entered >= 1);
  } finally {
    release();
    await svc.stop();
  }
});

test("task.deliver foreign SHA: no ready Delivery; Git unchanged", async () => {
  const ws = await makeWorkspace("foreign-sha");
  await initGitOnWorkspace(ws);
  const mainBefore = (await git(ws, "rev-parse", "main")).trim();

  await withService(async (svc) => {
    const { workspaceId, taskPath, baseCommit, worktree } = await claimRunningWithBase(
      svc,
      ws,
      {
        label: "executor",
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
  const mainBefore = (await git(ws, "rev-parse", "main")).trim();

  await withService(async (svc) => {
    const { workspaceId, taskPath, worktree } = await claimRunningWithBase(svc, ws, {
      label: "executor",
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
  const mainBefore = (await git(ws, "rev-parse", "main")).trim();

  await withService(async (svc) => {
    const { workspaceId, taskPath, baseCommit, worktree } = await claimRunningWithBase(
      svc,
      ws,
      {
        label: "executor",
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
