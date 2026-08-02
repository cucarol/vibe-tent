/**
 * Review-time integration target HEAD drift detection.
 * Commit-bearing Deliveries snapshot targetHead at publish; accept / auto-integrate
 * re-resolve and compare before any Git write (TARGET_MOVED, no silent guess).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadDelivery, createDelivery } from "../src/core/delivery.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { RPC_LIFECYCLE } from "../src/service/types.js";
import { setAfterTargetHeadSnapshotForTests } from "../src/service/handlers.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { configureTestGitIdentity, git } from "./helpers.js";

async function makeWorkspace(name = "target-head"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-th-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          {
            name: "executor",
            prompt: "do work",
          },
          { name: "orchestrator", prompt: "dispatch" },
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

/**
 * Ensure durable executor Role lane exists at the current main baseline
 * (no Task commits yet). startSession will capture this tip as baseCommit.
 */
/**
 * Ordinary Task commit on the already-bound route Task lane (after base capture).
 * Must not run before claimRunningWithBase — otherwise baseCommit == tip and
 * base..tip is empty, bypassing first-parent history.
 */
async function taskCommitOnRouteLane(
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

/**
 * Frozen executor-history: sourceRef is a real Task commit whose exact first
 * parent is recorded baseCommit (non-empty base..tip).
 */
async function assertTaskCommitFirstParent(
  sourceRef: string,
  baseCommit: string,
  workspace: string
): Promise<void> {
  assert.notEqual(
    sourceRef,
    baseCommit,
    "commit-bearing Delivery must list a Task commit, not the base tip itself"
  );
  const firstParent = (await git(workspace, "rev-parse", `${sourceRef}^`)).trim();
  assert.equal(
    firstParent,
    baseCommit,
    `sourceRef^ must equal recorded baseCommit (got ${firstParent}, base ${baseCommit})`
  );
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-th-svc-"));
  const svc = await startLocalTentService({
    dataDir,
    routes: [
      {
        routeId: "fake-default",
        provider: "fake",
        adapterId: FAKE_ADAPTER_ID,
        fake: { waitForSignal: true, canResume: true },
      },
    ],
  });
  try {
    return await fn(svc);
  } finally {
    setAfterTargetHeadSnapshotForTests(null);
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
  ws: string
) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: "work-item",
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  const nodeId = (created.result as { nodeId: string }).nodeId;
  return { workspaceId, nodeId };
}

/**
 * Dispatch + claim, then start a managed Session only for a review-policy route
 * Task. Elevated policies remain durable Role Tasks. Both paths persist the
 * exact workspaceLane.baseCommit before Task commits are created.
 * Task commits must be created only after this returns.
 */
async function claimRunningWithBase(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string,
  opts: {
    prompt: string;
    deliveryPolicy?: "review" | "bypass" | "agent-decide";
  }
): Promise<{
  workspaceId: string;
  taskPath: string;
  baseCommit: string;
  worktree: string;
}> {
  const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
  const deliveryPolicy = opts.deliveryPolicy ?? "review";
  const routeTask = deliveryPolicy === "review";
  const d = await rpc(svc, "task.dispatch", {
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    workspaceId,
    nodeIds: [nodeId],
    assigneeKind: routeTask ? "route" : "role",
    assigneeId: routeTask ? "fake-default" : "executor",
    prompt: opts.prompt,
    deliveryPolicy,
  });
  assert.ok(!d.error, JSON.stringify(d.error));
  const taskPath = (d.result as { taskPath: string }).taskPath;
  const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
  assert.ok(!claimed.error, JSON.stringify(claimed.error));
  if (routeTask) {
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
  }
  const got = await rpc(svc, "task.get", { workspaceId, taskPath });
  const lane = (
    got.result as {
      task: {
        workspaceLane?: {
          baseCommit?: string;
          worktree?: string;
        };
      };
    }
  ).task.workspaceLane;
  const baseCommit = lane?.baseCommit?.trim() || "";
  const worktree = lane?.worktree?.trim() || "";
  assert.ok(baseCommit, "claim/start must persist exact workspaceLane.baseCommit");
  assert.ok(worktree, "claim/start must bind executor worktree");
  return { workspaceId, taskPath, baseCommit, worktree };
}

function targetMovedData(error: { code?: number; data?: unknown } | undefined): Record<string, unknown> {
  assert.ok(error, "expected RPC error");
  assert.equal(error!.code, RPC_LIFECYCLE);
  const data = error!.data as Record<string, unknown> | undefined;
  assert.ok(data, "expected TARGET_MOVED data");
  assert.equal(data!.code, "TARGET_MOVED");
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

test("delivery parser: targetHead round-trip and legacy omit", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-th-parse-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/executor/deliveries");
  const clock = { now: () => "2026-01-01T00:00:00.000Z" };

  const withHead = await createDelivery(fsa, clock, {
    taskId: "tk-a",
    sourceNodeId: "cx-a",
    deliveriesDir: "temp/executor/deliveries",
    summary: "with head",
    commits: ["abc123"],
    targetHead: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  });
  const reloaded = await loadDelivery(fsa, withHead.path);
  assert.equal(reloaded.targetHead, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  assert.deepEqual(reloaded.commits, ["abc123"]);

  const legacyPath = "temp/executor/deliveries/dl-legacy01.md";
  await fsa.writeFile(
    legacyPath,
    `---
type: delivery
id: dl-legacy01
taskId: tk-b
sourceNodeId: cx-b
status: ready
commits:
  - abc123
createdAt: "2026-01-01T00:00:00.000Z"
updatedAt: "2026-01-01T00:00:00.000Z"
---
legacy row without targetHead
`
  );
  const legacy = await loadDelivery(fsa, legacyPath);
  assert.equal(legacy.targetHead, undefined);
  assert.deepEqual(legacy.commits, ["abc123"]);
});

test("targetHead: deliver snapshots HEAD; same-head accept integrates", async () => {
  const ws = await makeWorkspace("th-same");
  await initGitOnWorkspace(ws);
  const mainHeadAtDeliver = (await git(ws, "rev-parse", "main")).trim();

  await withService(async (svc) => {
    const { workspaceId, taskPath, baseCommit, worktree } = await claimRunningWithBase(svc, ws, {
      prompt: "same head",
      deliveryPolicy: "review",
    });
    assert.equal(baseCommit, mainHeadAtDeliver, "base must be main baseline tip");
    // Ordinary Task commit only after base capture → non-empty base..tip.
    const sourceRef = await taskCommitOnRouteLane(
      worktree,
      "same.txt",
      "same\n",
      "same work"
    );
    await assertTaskCommitFirstParent(sourceRef, baseCommit, ws);

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "ready",
      commits: [sourceRef],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const delivery = (delivered.result as { delivery: { targetHead?: string; commits: string[] } })
      .delivery;
    assert.equal(delivery.targetHead, mainHeadAtDeliver);
    assert.deepEqual(delivery.commits, [sourceRef]);

    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    assert.equal((accepted.result as { state: string }).state, "accepted");
    assert.equal(
      (await fs.readFile(path.join(ws, "same.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "same\n"
    );
  });
});

test("targetHead: clean non-conflicting target advance fails TARGET_MOVED; Git untouched", async () => {
  const ws = await makeWorkspace("th-moved");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, baseCommit, worktree } = await claimRunningWithBase(svc, ws, {
      prompt: "target will move",
      deliveryPolicy: "review",
    });
    const sourceRef = await taskCommitOnRouteLane(
      worktree,
      "feat.txt",
      "feat\n",
      "feat work"
    );
    await assertTaskCommitFirstParent(sourceRef, baseCommit, ws);

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "ready before target advance",
      commits: [sourceRef],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const expectedHead = (delivered.result as { delivery: { targetHead: string } }).delivery
      .targetHead;
    assert.ok(expectedHead);

    // Clean non-conflicting advance on main (not the delivery commit).
    await fs.writeFile(path.join(ws, "main-advance.txt"), "advance\n");
    await git(ws, "add", "main-advance.txt");
    await git(ws, "commit", "-q", "-m", "main advanced cleanly");
    const afterHead = (await git(ws, "rev-parse", "main")).trim();
    assert.notEqual(afterHead, expectedHead);

    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    const data = targetMovedData(accepted.error as { code?: number; data?: unknown });
    assert.equal(data.reason, "head_moved");
    assert.equal(data.expectedTargetHead, expectedHead);
    assert.equal(data.currentTargetHead, afterHead);

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "delivered");
    const list = await rpc(svc, "delivery.list", { workspaceId });
    const ready = (
      list.result as { deliveries: Array<{ status: string; targetHead?: string }> }
    ).deliveries.filter((row) => row.status === "ready");
    assert.equal(ready.length, 1);
    assert.equal(ready[0].targetHead, expectedHead);

    assert.equal((await git(ws, "rev-parse", "main")).trim(), afterHead);
    assert.equal(await pathExists(path.join(ws, "feat.txt")), false);
    assert.equal((await git(ws, "status", "--porcelain")).trim(), "");
  });
});

test("targetHead: zero-commit Delivery needs no snapshot; accept succeeds", async () => {
  const ws = await makeWorkspace("th-empty");
  await initGitOnWorkspace(ws);
  // Docs-only: tip remains equal to recorded base (empty base..tip is legal).
  await withService(async (svc) => {
    const { workspaceId, taskPath, baseCommit, worktree } = await claimRunningWithBase(
      svc,
      ws,
      {
        prompt: "docs only",
        deliveryPolicy: "review",
      }
    );
    const tip = (await git(worktree, "rev-parse", "HEAD")).trim();
    assert.equal(tip, baseCommit, "zero-commit path keeps tip === baseCommit");

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "no commits",
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const delivery = (delivered.result as { delivery: { targetHead?: string; commits: string[] } })
      .delivery;
    assert.equal(delivery.targetHead, undefined);
    assert.deepEqual(delivery.commits, []);

    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    assert.equal((accepted.result as { state: string }).state, "accepted");
  });
});

test("targetHead: legacy ready row without snapshot fails TARGET_MOVED (no silent migration)", async () => {
  const ws = await makeWorkspace("th-legacy");
  await initGitOnWorkspace(ws);
  const beforeHead = (await git(ws, "rev-parse", "main")).trim();

  await withService(async (svc) => {
    const { workspaceId, taskPath, baseCommit, worktree } = await claimRunningWithBase(svc, ws, {
      prompt: "legacy delivery",
      deliveryPolicy: "review",
    });
    const sourceRef = await taskCommitOnRouteLane(
      worktree,
      "legacy.txt",
      "legacy\n",
      "legacy work"
    );
    await assertTaskCommitFirstParent(sourceRef, baseCommit, ws);

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "will strip snapshot",
      commits: [sourceRef],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const deliveryPath = (delivered.result as { delivery: { path: string } }).delivery.path;
    assert.ok(deliveryPath);

    // Simulate pre-field ready Delivery: drop targetHead from disk only.
    const abs = path.join(ws, ".tent", deliveryPath.replace(/\//g, path.sep));
    const raw = await fs.readFile(abs, "utf8");
    const stripped = raw.replace(/^targetHead:.*\r?\n/m, "");
    assert.notEqual(stripped, raw, "fixture must remove targetHead line");
    await fs.writeFile(abs, stripped);

    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    const data = targetMovedData(accepted.error as { code?: number; data?: unknown });
    assert.equal(data.reason, "missing_snapshot");

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "delivered");
    assert.equal((await git(ws, "rev-parse", "main")).trim(), beforeHead);
    assert.equal(await pathExists(path.join(ws, "legacy.txt")), false);
  });
});

test("targetHead: auto-integrate race — target moves after snapshot fails TARGET_MOVED; no Delivery", async () => {
  const ws = await makeWorkspace("th-bypass-race");
  await initGitOnWorkspace(ws);
  const headAtSnapshot = (await git(ws, "rev-parse", "main")).trim();

  await withService(async (svc) => {
    setAfterTargetHeadSnapshotForTests(async (workspaceRoot) => {
      await fs.writeFile(path.join(workspaceRoot, "race-main.txt"), "moved\n");
      await git(workspaceRoot, "add", "race-main.txt");
      await git(workspaceRoot, "commit", "-q", "-m", "main moved after deliver snapshot");
    });

    const { workspaceId, taskPath, baseCommit, worktree } = await claimRunningWithBase(svc, ws, {
      prompt: "bypass race",
      deliveryPolicy: "bypass",
    });
    const sourceRef = await taskCommitOnRouteLane(
      worktree,
      "race.txt",
      "race\n",
      "race work"
    );
    await assertTaskCommitFirstParent(sourceRef, baseCommit, ws);

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "auto will see target move",
      commits: [sourceRef],
    });
    const data = targetMovedData(delivered.error as { code?: number; data?: unknown });
    assert.equal(data.reason, "head_moved");
    assert.equal(data.expectedTargetHead, headAtSnapshot);
    assert.notEqual(data.currentTargetHead, headAtSnapshot);

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal(
      (got.result as { task: { state: string } }).task.state,
      "running",
      "failed auto-integrate must leave task running"
    );
    const list = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal(
      (list.result as { deliveries: unknown[] }).deliveries.length,
      0,
      "failed auto-integrate must not leave a delivery"
    );

    // Target advanced only by the race hook; delivery commit must not land.
    assert.equal(await pathExists(path.join(ws, "race.txt")), false);
    assert.equal(await pathExists(path.join(ws, "race-main.txt")), true);
    assert.equal((await git(ws, "status", "--porcelain")).trim(), "");
  });
});
