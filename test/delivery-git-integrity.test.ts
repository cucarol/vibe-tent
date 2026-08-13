/**
 * Git/TaskResult integrity: concurrent accept on same target + foreign commits[] SHA.
 *
 * 1. Two ready Results with the same targetHead accepted concurrently:
 *    exactly one integrates; the other fails stable retryable TARGET_MOVED and
 *    remains ready/delivered. Serialization is by git-common-dir + fully resolved
 *    target ref (not workspaceId / taskPath / lexical workspace path).
 * 2. Public task.submit commits[] foreign/missing/base SHAs refuse ready TaskResult
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
import {
  setBeforeTaskAcceptFinalizeForTests,
  setBeforeTaskSubmitFinalizeForTests,
} from "../src/service/handlers.js";
import { rpcCall } from "../src/service/http-server.js";
import { RPC_LIFECYCLE } from "../src/service/types.js";
import { taskReject } from "../src/core/task-lifecycle.js";
import { loadTaskRecord } from "../src/core/task.js";
import {
  loadTaskResults,
} from "../src/core/task-result.js";
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
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>,
  options: { integrateCommits?: () => Promise<void> } = {}
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
    ...options,
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

function resultIdOf(response: { result?: unknown }): string {
  const id = (response.result as { result?: { id?: string } } | undefined)?.result?.id;
  assert.ok(id, "fixture requires an exact ready TaskResult id");
  return id;
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
    acceptMode?: "review-required" | "auto-accept" | "agent-decide";
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
    requester: { kind: "user", id: "user" },
    workspaceId,
    workNodeIds: [nodeId],
    contextNodeIds: [],
    connectionId: "fake-default",
    prompt: opts.prompt,
    acceptMode: opts.acceptMode ?? "review-required",
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
  assert.ok(data, "expected RESULT_COMMIT_LANE data");
  assert.equal(data!.code, "RESULT_COMMIT_LANE");
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

async function assertReadyAfterFailedAccept(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  taskPath: string,
  resultId: string
): Promise<void> {
  const got = await rpc(svc, "task.get", { workspaceId, taskPath });
  assert.ok(!got.error, JSON.stringify(got.error));
  assert.equal((got.result as { task: { state: string } }).task.state, "submitted");
  const result = await rpc(svc, "taskResult.get", { workspaceId, id: resultId });
  assert.ok(!result.error, JSON.stringify(result.error));
  assert.equal(
    (result.result as { result: { status: string } }).result.status,
    "ready"
  );
}

test("task.accept retry finalizes an exact fast-forward already integrated before crash", async () => {
  const ws = await makeWorkspace("accept-crash-fast-forward");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const task = await claimRunningWithBase(svc, ws, {
      label: "crash-ff",
      prompt: "recover exact fast-forward",
    });
    const commit = await taskCommitOnLane(
      task.worktree,
      "crash-ff.txt",
      "fast-forward\n",
      "crash ff"
    );
    const delivered = await rpc(svc, "task.submit", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      report: "ready for fast-forward crash recovery",
      commits: [commit],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const resultId = resultIdOf(delivered);

    setBeforeTaskAcceptFinalizeForTests(async () => {
      throw new Error("injected post-integrate crash");
    });
    try {
      const first = await rpc(svc, "task.accept", {
        workspaceId: task.workspaceId,
        resultId,
        actor: "user",
      });
      assert.ok(first.error, "injected crash must stop before finalize");
    } finally {
      setBeforeTaskAcceptFinalizeForTests(null);
    }

    assert.equal((await git(ws, "rev-parse", "main")).trim(), commit);
    await assertReadyAfterFailedAccept(svc, task.workspaceId, task.taskPath, resultId);

    const retry = await rpc(svc, "task.accept", {
      workspaceId: task.workspaceId,
      resultId,
      actor: "user",
    });
    assert.ok(!retry.error, JSON.stringify(retry.error));
    assert.equal((retry.result as { state: string }).state, "accepted");
    assert.equal((await git(ws, "rev-parse", "main")).trim(), commit);
  });
});

test("task.submit exact retry reuses the persisted target after integration response loss", async () => {
  const ws = await makeWorkspace("submit-crash-fast-forward");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const task = await claimRunningWithBase(svc, ws, {
      label: "submit-crash",
      prompt: "recover exact auto-submit",
      acceptMode: "auto-accept",
    });
    const commit = await taskCommitOnLane(
      task.worktree,
      "submit-crash.txt",
      "submit crash\n",
      "submit crash"
    );
    setBeforeTaskSubmitFinalizeForTests(async () => {
      throw new Error("injected post-submit-integrate crash");
    });
    try {
      const first = await rpc(svc, "task.submit", {
        workspaceId: task.workspaceId,
        taskPath: task.taskPath,
        report: "auto result survives response loss",
        commits: [commit],
      });
      assert.ok(first.error, "injected crash must stop before submit finalize");
    } finally {
      setBeforeTaskSubmitFinalizeForTests(null);
    }

    assert.equal((await git(ws, "rev-parse", "main")).trim(), commit);
    const mount = svc.ctx.host.require(task.workspaceId);
    const partial = await loadTaskRecord(mount.env.fs, task.taskPath);
    assert.equal(partial.state, "submitted");
    assert.ok(partial.currentResultId);
    const resultPath = (await loadTaskResults(mount.env.fs, { taskId: partial.id })).find(
      (row) => row.id === partial.currentResultId
    )!.path;
    const taskBeforeConflict = await mount.env.fs.readFile(task.taskPath);
    const resultBeforeConflict = await mount.env.fs.readFile(resultPath);
    const conflicting = await rpc(svc, "task.submit", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      report: "different candidate",
      commits: [commit],
    });
    assert.equal(
      (conflicting.error?.data as { code?: string } | undefined)?.code,
      "RESULT_CHANGED"
    );
    assert.equal(await mount.env.fs.readFile(task.taskPath), taskBeforeConflict);
    assert.equal(await mount.env.fs.readFile(resultPath), resultBeforeConflict);
    assert.equal((await git(ws, "rev-parse", "main")).trim(), commit);

    const retry = await rpc(svc, "task.submit", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      report: "auto result survives response loss",
      commits: [commit],
    });
    assert.ok(!retry.error, JSON.stringify(retry.error));
    assert.equal((retry.result as { state: string }).state, "accepted");
    assert.equal((await git(ws, "rev-parse", "main")).trim(), commit);
    const rows = await loadTaskResults(mount.env.fs, { taskId: partial.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, partial.currentResultId);
    assert.equal(rows[0]!.status, "accepted");
  });
});

test("task.accept finalize rejects exact TaskResult semantic drift introduced during Git integration", async () => {
  const ws = await makeWorkspace("accept-finalize-result-drift");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const task = await claimRunningWithBase(svc, ws, {
      label: "finalize-drift",
      prompt: "revalidate exact TaskResult after integration",
    });
    const commit = await taskCommitOnLane(
      task.worktree,
      "finalize-drift.txt",
      "drift\n",
      "finalize drift"
    );
    const delivered = await rpc(svc, "task.submit", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      report: "ready before exact TaskResult drift",
      commits: [commit],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const resultId = resultIdOf(delivered);
    const mount = svc.ctx.host.require(task.workspaceId);
    const taskRecord = await loadTaskRecord(mount.env.fs, task.taskPath);
    const exact = (await loadTaskResults(mount.env.fs, { taskId: taskRecord.id })).find(
      (row) => row.id === resultId
    );
    assert.ok(exact);
    const exactRaw = await mount.env.fs.readFile(exact.path);
    setBeforeTaskAcceptFinalizeForTests(async () => {
      await mount.env.fs.writeFile(
        exact.path,
        exactRaw.replace("ready before exact TaskResult drift", "drifted after Git")
      );
    });
    try {
      const drifted = await rpc(svc, "task.accept", {
        workspaceId: task.workspaceId,
        resultId,
        actor: "user",
      });
      assert.equal(
        (drifted.error?.data as { code?: string } | undefined)?.code,
        "RESULT_CHANGED"
      );
    } finally {
      setBeforeTaskAcceptFinalizeForTests(null);
    }
    assert.equal((await git(ws, "rev-parse", "main")).trim(), commit);
    await assertReadyAfterFailedAccept(svc, task.workspaceId, task.taskPath, resultId);
    await mount.env.fs.writeFile(exact.path, exactRaw);

    const retry = await rpc(svc, "task.accept", {
      workspaceId: task.workspaceId,
      resultId,
      actor: "user",
    });
    assert.ok(!retry.error, JSON.stringify(retry.error));
    assert.equal((retry.result as { state: string }).state, "accepted");
  });
});

test("task.accept retry finalizes only an exact ordered cherry-pick integration at target tip", async () => {
  const ws = await makeWorkspace("accept-crash-cherry-pick");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const task = await claimRunningWithBase(svc, ws, {
      label: "crash-cp",
      prompt: "recover exact ordered cherry-picks",
    });
    const first = await taskCommitOnLane(task.worktree, "cp-first.txt", "first\n", "cp first");
    await taskCommitOnLane(task.worktree, "cp-gap.txt", "gap\n", "cp gap");
    const last = await taskCommitOnLane(task.worktree, "cp-last.txt", "last\n", "cp last");
    const delivered = await rpc(svc, "task.submit", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      report: "ready for cherry-pick crash recovery",
      commits: [first, last],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const resultId = resultIdOf(delivered);

    setBeforeTaskAcceptFinalizeForTests(async () => {
      throw new Error("injected post-integrate crash");
    });
    try {
      const firstAccept = await rpc(svc, "task.accept", {
        workspaceId: task.workspaceId,
        resultId,
        actor: "user",
      });
      assert.ok(firstAccept.error, "injected crash must stop before finalize");
    } finally {
      setBeforeTaskAcceptFinalizeForTests(null);
    }

    const integratedTip = (await git(ws, "rev-parse", "main")).trim();
    assert.notEqual(integratedTip, last, "production must cherry-pick the non-contiguous refs");
    assert.equal(await pathExists(path.join(ws, "cp-first.txt")), true);
    assert.equal(await pathExists(path.join(ws, "cp-gap.txt")), false);
    assert.equal(await pathExists(path.join(ws, "cp-last.txt")), true);
    await assertReadyAfterFailedAccept(svc, task.workspaceId, task.taskPath, resultId);

    const retry = await rpc(svc, "task.accept", {
      workspaceId: task.workspaceId,
      resultId,
      actor: "user",
    });
    assert.ok(!retry.error, JSON.stringify(retry.error));
    assert.equal((retry.result as { state: string }).state, "accepted");
    assert.equal((await git(ws, "rev-parse", "main")).trim(), integratedTip);
  });
});

test("task.accept retry rejects a partial ordered integration", async () => {
  const ws = await makeWorkspace("accept-crash-partial");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const task = await claimRunningWithBase(svc, ws, {
      label: "partial",
      prompt: "reject partial integration",
    });
    const first = await taskCommitOnLane(task.worktree, "partial-first.txt", "first\n", "partial first");
    const last = await taskCommitOnLane(task.worktree, "partial-last.txt", "last\n", "partial last");
    const delivered = await rpc(svc, "task.submit", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      report: "ready for partial check",
      commits: [first, last],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const resultId = resultIdOf(delivered);

    await git(ws, "cherry-pick", "-x", first);
    const partialTip = (await git(ws, "rev-parse", "main")).trim();
    const retry = await rpc(svc, "task.accept", {
      workspaceId: task.workspaceId,
      resultId,
      actor: "user",
    });
    targetMovedData(retry.error as { code?: number; data?: unknown });
    assert.equal((await git(ws, "rev-parse", "main")).trim(), partialTip);
    assert.equal(await pathExists(path.join(ws, "partial-last.txt")), false);
    await assertReadyAfterFailedAccept(svc, task.workspaceId, task.taskPath, resultId);
  });
});

test("task.accept retry rejects a foreign advance after exact integration", async () => {
  const ws = await makeWorkspace("accept-crash-foreign-advance");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const task = await claimRunningWithBase(svc, ws, {
      label: "foreign",
      prompt: "reject later foreign advance",
    });
    const commit = await taskCommitOnLane(task.worktree, "foreign-task.txt", "task\n", "task ref");
    const delivered = await rpc(svc, "task.submit", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      report: "ready before foreign advance",
      commits: [commit],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const resultId = resultIdOf(delivered);

    setBeforeTaskAcceptFinalizeForTests(async () => {
      throw new Error("injected post-integrate crash");
    });
    try {
      const first = await rpc(svc, "task.accept", {
        workspaceId: task.workspaceId,
        resultId,
        actor: "user",
      });
      assert.ok(first.error, "injected crash must stop before finalize");
    } finally {
      setBeforeTaskAcceptFinalizeForTests(null);
    }

    await fs.writeFile(path.join(ws, "foreign-after.txt"), "foreign\n");
    await git(ws, "add", "foreign-after.txt");
    await git(ws, "commit", "-q", "-m", "foreign after integration");
    const foreignTip = (await git(ws, "rev-parse", "main")).trim();

    const retry = await rpc(svc, "task.accept", {
      workspaceId: task.workspaceId,
      resultId,
      actor: "user",
    });
    targetMovedData(retry.error as { code?: number; data?: unknown });
    assert.equal((await git(ws, "rev-parse", "main")).trim(), foreignTip);
    await assertReadyAfterFailedAccept(svc, task.workspaceId, task.taskPath, resultId);
  });
});

test("task.accept retry rejects a foreign patch with a forged exact cherry-pick trailer", async () => {
  const ws = await makeWorkspace("accept-crash-forged-trailer");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const task = await claimRunningWithBase(svc, ws, {
      label: "forged-trailer",
      prompt: "reject forged cherry-pick trailer",
    });
    const sourceCommit = await taskCommitOnLane(
      task.worktree,
      "real-source.txt",
      "real source patch\n",
      "real source"
    );
    const delivered = await rpc(svc, "task.submit", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      report: "ready before forged trailer",
      commits: [sourceCommit],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const resultId = resultIdOf(delivered);

    await fs.writeFile(path.join(ws, "foreign-forgery.txt"), "different patch\n");
    await git(ws, "add", "foreign-forgery.txt");
    await git(
      ws,
      "commit",
      "-q",
      "-m",
      "foreign forged trailer",
      "-m",
      `(cherry picked from commit ${sourceCommit})`
    );
    const forgedTip = (await git(ws, "rev-parse", "main")).trim();

    const retry = await rpc(svc, "task.accept", {
      workspaceId: task.workspaceId,
      resultId,
      actor: "user",
    });
    targetMovedData(retry.error as { code?: number; data?: unknown });
    assert.equal((await git(ws, "rev-parse", "main")).trim(), forgedTip);
    assert.equal(await pathExists(path.join(ws, "real-source.txt")), false);
    await assertReadyAfterFailedAccept(svc, task.workspaceId, task.taskPath, resultId);
  });
});

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

    const deliveredA = await rpc(svc, "task.submit", {
      workspaceId,
      taskPath: taskA.taskPath,
      report: "ready A",
      commits: [refA],
    });
    assert.ok(!deliveredA.error, JSON.stringify(deliveredA.error));
    const headA = (deliveredA.result as { result: { targetHead?: string } }).result
      .targetHead;
    assert.equal(headA, mainAtDeliver);

    const deliveredB = await rpc(svc, "task.submit", {
      workspaceId,
      taskPath: taskB.taskPath,
      report: "ready B",
      commits: [refB],
    });
    assert.ok(!deliveredB.error, JSON.stringify(deliveredB.error));
    const headB = (deliveredB.result as { result: { targetHead?: string } }).result
      .targetHead;
    assert.equal(headB, mainAtDeliver);
    assert.equal(headA, headB, "both Deliveries snapshot the same targetHead");

    // Fire concurrent accepts on different taskPaths sharing the same
    // git-common-dir + refs/heads/main lock (not workspaceId/taskPath).
    const [resA, resB] = await Promise.all([
      rpc(svc, "task.accept", {
        workspaceId,
        resultId: resultIdOf(deliveredA),
        actor: "user",
      }),
      rpc(svc, "task.accept", {
        workspaceId,
        resultId: resultIdOf(deliveredB),
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

    // Winner integrated; loser remains submitted with ready TaskResult.
    const gotLoser = await rpc(svc, "task.get", {
      workspaceId,
      taskPath: loser.taskPath,
    });
    assert.equal(
      (gotLoser.result as { task: { state: string } }).task.state,
      "submitted",
      "loser must remain ready/submitted for retry"
    );
    const list = await rpc(svc, "taskResult.list", { workspaceId });
    const ready = (
      list.result as { results: Array<{ status: string; summary?: string }> }
    ).results.filter((d) => d.status === "ready");
    assert.equal(ready.length, 1, "loser TaskResult stays ready");

    assert.equal(await pathExists(path.join(ws, winner.file)), true);
    assert.equal(await pathExists(path.join(ws, loser.file)), false);
    assert.equal((await git(ws, "status", "--porcelain")).trim(), "");
    const mainAfter = (await git(ws, "rev-parse", "main")).trim();
    assert.notEqual(mainAfter, mainAtDeliver);
  });
});

test("task.accept rejects caller commit overrides without mutating ready TaskResult", async () => {
  const ws = await makeWorkspace("accept-immutable-commits");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const task = await claimRunningWithBase(svc, ws, {
      label: "immutable",
      prompt: "accept immutable TaskResult commits",
    });
    const commitA = await taskCommitOnLane(
      task.worktree,
      "immutable-a.txt",
      "a\n",
      "immutable a"
    );
    const delivered = await rpc(svc, "task.submit", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      report: "ready A",
      commits: [commitA],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const resultPath = (
      delivered.result as { result: { path: string; commits: string[] } }
    ).result.path;
    assert.deepEqual(
      (delivered.result as { result: { commits: string[] } }).result.commits,
      [commitA]
    );

    const taskFile = path.join(ws, ".tent", ...task.taskPath.split("/"));
    const resultFile = path.join(ws, ".tent", ...resultPath.split("/"));
    const beforeTask = await fs.readFile(taskFile);
    const beforeTaskResult = await fs.readFile(resultFile);
    const beforeMain = (await git(ws, "rev-parse", "main")).trim();

    const missingTaskResultId = await rpc(svc, "task.accept", {
      workspaceId: task.workspaceId,
      actor: "user",
    });
    assert.equal(missingTaskResultId.error?.code, -32602);
    assert.deepEqual(await fs.readFile(taskFile), beforeTask);
    assert.deepEqual(await fs.readFile(resultFile), beforeTaskResult);
    assert.equal((await git(ws, "rev-parse", "main")).trim(), beforeMain);

    for (const commits of [[], ["bbbbbbb"]]) {
      const rejected = await rpc(svc, "task.accept", {
        workspaceId: task.workspaceId,
        resultId: resultIdOf(delivered),
        actor: "user",
        commits,
      });
      assert.equal(rejected.error?.code, -32602);
      assert.match(rejected.error?.message ?? "", /commits|unknown parameter/i);
      assert.deepEqual(await fs.readFile(taskFile), beforeTask);
      assert.deepEqual(await fs.readFile(resultFile), beforeTaskResult);
      assert.equal((await git(ws, "rev-parse", "main")).trim(), beforeMain);
    }

    const accepted = await rpc(svc, "task.accept", {
      workspaceId: task.workspaceId,
      resultId: resultIdOf(delivered),
      actor: "user",
    });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    assert.equal((accepted.result as { state: string }).state, "accepted");
    assert.equal(await pathExists(path.join(ws, "immutable-a.txt")), true);
  });
});

test("task.reject rejects unknown fields before mutating Task or TaskResult", async () => {
  const ws = await makeWorkspace("reject-exact-params");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const task = await claimRunningWithBase(svc, ws, {
      label: "reject-params",
      prompt: "reject unknown parameters before mutation",
    });
    const delivered = await rpc(svc, "task.submit", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      report: "ready for exact reject",
      commits: [],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const resultPath = (
      delivered.result as { result: { path: string; status: string } }
    ).result.path;

    const taskFile = path.join(ws, ".tent", ...task.taskPath.split("/"));
    const resultFile = path.join(ws, ".tent", ...resultPath.split("/"));
    const beforeTask = await fs.readFile(taskFile);
    const beforeTaskResult = await fs.readFile(resultFile);

    const missingTaskResultId = await rpc(svc, "task.reject", {
      workspaceId: task.workspaceId,
      actor: "user",
      note: "must not be applied",
      resume: false,
    });
    assert.equal(missingTaskResultId.error?.code, -32602);
    assert.deepEqual(await fs.readFile(taskFile), beforeTask);
    assert.deepEqual(await fs.readFile(resultFile), beforeTaskResult);

    for (const extra of [
      { actorOverride: "rl-forged" },
      { commits: [] },
      { session: "ss-forged" },
    ]) {
      const rejected = await rpc(svc, "task.reject", {
        workspaceId: task.workspaceId,
        resultId: resultIdOf(delivered),
        actor: "user",
        note: "must not be applied",
        resume: false,
        ...extra,
      });
      assert.equal(rejected.error?.code, -32602, JSON.stringify(rejected));
      assert.match(rejected.error?.message ?? "", /unknown parameter/i);
      assert.deepEqual(await fs.readFile(taskFile), beforeTask);
      assert.deepEqual(await fs.readFile(resultFile), beforeTaskResult);
    }

    const rejected = await rpc(svc, "task.reject", {
      workspaceId: task.workspaceId,
      resultId: resultIdOf(delivered),
      actor: "user",
      note: "valid terminal reject",
      resume: false,
    });
    assert.ok(!rejected.error, JSON.stringify(rejected.error));
    assert.equal((rejected.result as { state: string }).state, "rejected");
    assert.equal(
      (rejected.result as { result: { status: string } }).result.status,
      "rejected"
    );
  });
});

test("review mutations reject a replaced TaskResult before Git or durable writes", async () => {
  const ws = await makeWorkspace("result-bound-review");
  await initGitOnWorkspace(ws);
  let integrateCalls = 0;

  await withService(async (svc) => {
    const task = await claimRunningWithBase(svc, ws, {
      label: "result-bound",
      prompt: "review the exact ready TaskResult",
    });
    const commitA = await taskCommitOnLane(
      task.worktree,
      "candidate-a.txt",
      "a\n",
      "candidate a"
    );
    const deliveredA = await rpc(svc, "task.submit", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      report: "candidate A",
      commits: [commitA],
    });
    assert.ok(!deliveredA.error, JSON.stringify(deliveredA.error));
    const resultA = (deliveredA.result as {
      result: { id: string; path: string };
    }).result;

    await taskReject(svc.ctx.host.require(task.workspaceId).env, task.taskPath, {
      actor: "user",
      resultId: resultA.id,
      note: "replace A",
      resume: true,
    });

    const commitB = await taskCommitOnLane(
      task.worktree,
      "candidate-b.txt",
      "b\n",
      "candidate b"
    );
    const deliveredB = await rpc(svc, "task.submit", {
      workspaceId: task.workspaceId,
      taskPath: task.taskPath,
      report: "candidate B",
      commits: [commitB],
    });
    assert.ok(!deliveredB.error, JSON.stringify(deliveredB.error));
    const resultB = (deliveredB.result as {
      result: { id: string; path: string };
    }).result;
    assert.notEqual(resultA.id, resultB.id);

    const taskFile = path.join(ws, ".tent", ...task.taskPath.split("/"));
    const resultAFile = path.join(ws, ".tent", ...resultA.path.split("/"));
    const resultBFile = path.join(ws, ".tent", ...resultB.path.split("/"));
    const beforeTask = await fs.readFile(taskFile);
    const beforeA = await fs.readFile(resultAFile);
    const beforeB = await fs.readFile(resultBFile);
    const beforeMain = (await git(ws, "rev-parse", "main")).trim();

    for (const method of ["task.accept", "task.reject"] as const) {
      const stale = await rpc(svc, method, {
        workspaceId: task.workspaceId,
        resultId: resultA.id,
        actor: "user",
        ...(method === "task.reject" ? { note: "stale card", resume: false } : {}),
      });
      assert.equal(stale.error?.code, -32004, JSON.stringify(stale.error));
      assert.equal(
        (stale.error?.data as { code?: string } | undefined)?.code,
        "REVIEW_RESULT_TASK_NOT_UNIQUE"
      );
      assert.equal(integrateCalls, 0, "stale accept must fail before the Git integrator");
      assert.deepEqual(await fs.readFile(taskFile), beforeTask);
      assert.deepEqual(await fs.readFile(resultAFile), beforeA);
      assert.deepEqual(await fs.readFile(resultBFile), beforeB);
      assert.equal((await git(ws, "rev-parse", "main")).trim(), beforeMain);
    }

    const alias = await rpc(svc, "task.accept", {
      workspaceId: task.workspaceId,
      resultId: resultB.id,
      expectedTaskResultId: resultB.id,
      actor: "user",
    });
    assert.equal(alias.error?.code, -32602, JSON.stringify(alias.error));
    assert.deepEqual(await fs.readFile(taskFile), beforeTask);
    assert.deepEqual(await fs.readFile(resultBFile), beforeB);
    assert.equal((await git(ws, "rev-parse", "main")).trim(), beforeMain);
  }, {
    integrateCommits: async () => {
      integrateCalls += 1;
    },
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

    const deliveredA = await rpc(svc, "task.submit", {
      workspaceId: workspaceIdA,
      taskPath: taskA.taskPath,
      report: "ready dual A",
      commits: [refA],
    });
    assert.ok(!deliveredA.error, JSON.stringify(deliveredA.error));
    assert.equal(
      (deliveredA.result as { result: { targetHead?: string } }).result.targetHead,
      mainAtDeliver
    );

    const deliveredB = await rpc(svc, "task.submit", {
      workspaceId: workspaceIdB,
      taskPath: taskB.taskPath,
      report: "ready dual B",
      commits: [refB],
    });
    assert.ok(!deliveredB.error, JSON.stringify(deliveredB.error));
    assert.equal(
      (deliveredB.result as { result: { targetHead?: string } }).result.targetHead,
      mainAtDeliver
    );

    const [resA, resB] = await Promise.all([
      rpc(svc, "task.accept", {
        workspaceId: workspaceIdA,
        resultId: resultIdOf(deliveredA),
        actor: "user",
      }),
      rpc(svc, "task.accept", {
        workspaceId: workspaceIdB,
        resultId: resultIdOf(deliveredB),
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
      "submitted",
      "loser remains ready/submitted under its own workspaceId"
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

    const resultIds = new Map<string, string>();
    for (const row of [
      { workspaceId: workspaceIdA, taskPath: taskA.taskPath, commits: [refA] },
      { workspaceId: workspaceIdB, taskPath: taskB.taskPath, commits: [refB] },
    ]) {
      const d = await rpc(svc, "task.submit", {
        workspaceId: row.workspaceId,
        taskPath: row.taskPath,
        report: "ready hold",
        commits: row.commits,
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      resultIds.set(row.taskPath, resultIdOf(d));
    }

    const acceptA = rpc(svc, "task.accept", {
      workspaceId: workspaceIdA,
      resultId: resultIds.get(taskA.taskPath),
      actor: "user",
    });
    const acceptB = rpc(svc, "task.accept", {
      workspaceId: workspaceIdB,
      resultId: resultIds.get(taskB.taskPath),
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

test("task.submit foreign SHA: no ready TaskResult; Git unchanged", async () => {
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

    const delivered = await rpc(svc, "task.submit", {
      workspaceId,
      taskPath,
      report: "must refuse foreign",
      commits: [foreignSha],
    });
    assert.ok(delivered.error, "foreign SHA must refuse task.submit");
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
    const list = await rpc(svc, "taskResult.list", { workspaceId });
    assert.equal(
      (list.result as { results: unknown[] }).results.length,
      0,
      "must not publish ready TaskResult"
    );

    assert.equal((await git(ws, "rev-parse", "main")).trim(), mainBefore);
    assert.equal(await pathExists(path.join(ws, "foreign.txt")), false);
    assert.equal((await git(ws, "status", "--porcelain")).trim(), "");
  });
});

test("task.submit missing SHA: no ready TaskResult; Git unchanged", async () => {
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
    const delivered = await rpc(svc, "task.submit", {
      workspaceId,
      taskPath,
      report: "must refuse missing",
      commits: [missing],
    });
    assert.ok(delivered.error, "missing SHA must refuse task.submit");
    const data = deliverCommitLaneData(delivered.error as { code?: number; data?: unknown });
    assert.equal(data.laneCode, "MISSING_COMMIT");

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "running");
    const list = await rpc(svc, "taskResult.list", { workspaceId });
    assert.equal((list.result as { results: unknown[] }).results.length, 0);
    assert.equal((await git(ws, "rev-parse", "main")).trim(), mainBefore);
  });
});

test("task.submit baseCommit itself: no ready TaskResult; Git unchanged", async () => {
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

    const delivered = await rpc(svc, "task.submit", {
      workspaceId,
      taskPath,
      report: "must refuse base",
      commits: [baseCommit],
    });
    assert.ok(delivered.error, "baseCommit itself must refuse task.submit");
    const data = deliverCommitLaneData(delivered.error as { code?: number; data?: unknown });
    assert.equal(data.laneCode, "BASE_COMMIT");

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "running");
    const list = await rpc(svc, "taskResult.list", { workspaceId });
    assert.equal((list.result as { results: unknown[] }).results.length, 0);
    assert.equal((await git(ws, "rev-parse", "main")).trim(), mainBefore);
  });
});
