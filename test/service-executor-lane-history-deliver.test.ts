/**
 * P0 Service E2E: ordinary executor lane history gate at public task.deliver
 * and managed auto-deliver (cx-5q6za6 / review-feedback ti-jkpe3m5mxk).
 *
 * Proves ready Delivery is blocked at lifecycle entry points — not only pure /
 * real-git helpers in task-context-card.test.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { ensureRoleWorkspace } from "../src/core/workspace.js";
import { NodeFs } from "../src/fs/node-fs.js";
import {
  invokeManagedAutoDeliverForTests,
  resetManagedAutoDeliverDedupForTests,
} from "../src/service/handlers.js";
import { rpcCall } from "../src/service/http-server.js";
import { startLocalTentService } from "../src/service/service.js";
import { RPC_LIFECYCLE } from "../src/service/types.js";
import { configureTestGitIdentity, git } from "./helpers.js";

async function makeWorkspace(name = "lane-hist"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `tent-${name}-`));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
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

async function initGitOnWorkspace(workspace: string): Promise<string> {
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", ".gitignore", "README.md");
  await git(workspace, "commit", "-q", "-m", "init");
  return (await git(workspace, "rev-parse", "HEAD")).trim();
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-lane-hist-svc-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
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
  const boxId = (created.result as { id: string }).id;
  return { workspaceId, boxId };
}

/**
 * Dispatch + claim + startSession so ensureTaskWorkspaceLane persists exact
 * baseCommit (capture-once at bind). Public deliver without this fails MISSING_BASE.
 */
async function runningTaskWithBase(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string
): Promise<{
  workspaceId: string;
  taskPath: string;
  sessionId: string;
  baseCommit: string;
  branch: string;
  worktree: string;
}> {
  const { workspaceId, boxId } = await mountWorkItem(svc, ws);
  const d = await rpc(svc, "task.dispatch", {
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    workspaceId,
    nodeIds: [boxId],
    role: "executor",
    prompt: "executor lane history fixture",
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
  const sessionId = (started.result as { session: { sessionId: string } }).session
    .sessionId;
  const got = await rpc(svc, "task.get", { workspaceId, taskPath });
  const task = got.result as {
    task: {
      state: string;
      workspaceLane?: {
        baseCommit?: string;
        branch?: string;
        worktree?: string;
      };
    };
  };
  assert.equal(task.task.state, "running");
  const baseCommit = task.task.workspaceLane?.baseCommit?.trim() || "";
  const branch = task.task.workspaceLane?.branch?.trim() || "";
  const worktree = task.task.workspaceLane?.worktree?.trim() || "";
  assert.ok(baseCommit, "startSession must persist exact baseCommit");
  assert.ok(branch, "executor lane branch required");
  assert.ok(worktree, "executor lane worktree required");
  return { workspaceId, taskPath, sessionId, baseCommit, branch, worktree };
}

/**
 * Synthetic merge tip whose base..tip range hits multi-parent before foreign
 * ancestry: side commit off exact base, then --no-ff merge while task tip is
 * still base → historyCode MERGE_COMMIT.
 */
async function createExecutorMergeCommitAtBase(worktree: string): Promise<string> {
  const head = (await git(worktree, "rev-parse", "HEAD")).trim();
  const side = "tent-test/side-merge-hist";
  await git(worktree, "checkout", "-b", side, head);
  await fs.writeFile(path.join(worktree, "side-merge.txt"), "side\n");
  await git(worktree, "add", "side-merge.txt");
  await git(worktree, "commit", "-q", "-m", "side commit for merge tip");
  // Return to the task/role branch tip (still at base).
  await git(worktree, "checkout", "-");
  const merge = await git(
    worktree,
    "merge",
    "--no-ff",
    "-m",
    "executor unauthorized merge",
    side
  ).catch((err: unknown) => {
    throw new Error(`merge failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  void merge;
  const tip = (await git(worktree, "rev-parse", "HEAD")).trim();
  const parentLine = (await git(worktree, "rev-list", "--parents", "-n", "1", tip)).trim();
  const parts = parentLine.split(/\s+/);
  assert.ok(parts.length >= 3, `tip must be multi-parent merge; got ${parentLine}`);
  return tip;
}

function assertExecutorLaneHistoryRpcError(
  error: { code?: number; message?: string; data?: unknown } | undefined,
  expectedHistoryCode: string
): Record<string, unknown> {
  assert.ok(error, "expected RPC error");
  assert.equal(error!.code, RPC_LIFECYCLE);
  const data = error!.data as Record<string, unknown> | undefined;
  assert.ok(data, "expected EXECUTOR_LANE_HISTORY data");
  assert.equal(data!.code, "EXECUTOR_LANE_HISTORY");
  assert.equal(data!.historyCode, expectedHistoryCode);
  return data!;
}

test("Service: exact base + linear Task commit → public task.deliver succeeds", async () => {
  const ws = await makeWorkspace("linear-ok");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, taskPath, baseCommit, worktree } =
      await runningTaskWithBase(svc, ws);

    // One ordinary single-parent Task commit on the bound executor lane.
    await fs.writeFile(path.join(worktree, "linear-work.txt"), "linear\n");
    await git(worktree, "add", "linear-work.txt");
    await git(worktree, "commit", "-q", "-m", "linear task work");
    const tip = (await git(worktree, "rev-parse", "HEAD")).trim();
    const parents = (await git(worktree, "rev-list", "--parents", "-n", "1", tip))
      .trim()
      .split(/\s+/);
    assert.equal(parents[1], baseCommit, "first parent of tip must be exact baseCommit");

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "linear history ok",
      commits: [tip],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const result = delivered.result as {
      task: { state: string; workspaceLane?: { baseCommit?: string } };
      delivery: { status: string; summary: string; commits?: string[] };
    };
    assert.equal(result.task.state, "delivered");
    assert.equal(result.delivery.status, "ready");
    assert.equal(result.delivery.summary, "linear history ok");
    assert.equal(result.task.workspaceLane?.baseCommit, baseCommit);

    const list = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      list.result as { deliveries: Array<{ status: string; summary: string }> }
    ).deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.status, "ready");
  });
});

test("Service: executor merge commit → task.deliver EXECUTOR_LANE_HISTORY/MERGE_COMMIT; no ready Delivery", async () => {
  const ws = await makeWorkspace("merge-refuse");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, taskPath, baseCommit, worktree } =
      await runningTaskWithBase(svc, ws);

    const tip = await createExecutorMergeCommitAtBase(worktree);
    assert.notEqual(tip, baseCommit);

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "must refuse merge tip",
      commits: [tip],
    });
    assert.ok(delivered.error, "merge tip must refuse public task.deliver");
    assertExecutorLaneHistoryRpcError(delivered.error, "MERGE_COMMIT");

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal(
      (got.result as { task: { state: string } }).task.state,
      "running",
      "Task must remain running after history gate refuse"
    );
    const list = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal(
      (list.result as { deliveries: unknown[] }).deliveries.length,
      0,
      "must not publish ready Delivery"
    );
  });
});

test("Service: managed auto-deliver second gate refuses merge; preserves Task + report draft", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("managed-merge");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId, worktree } =
      await runningTaskWithBase(svc, ws);

    await createExecutorMergeCommitAtBase(worktree);

    const reportBody = "MERGE_REFUSED_REPORT_BODY";
    const reportText = `outcome: delivered\n\n${reportBody}`;

    // Production auto-collects lane tip; omit explicit commits so the second gate
    // sees real rev-list parents under managed auto-deliver (same as public path).
    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: reportText,
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal(
      (got.result as { task: { state: string } }).task.state,
      "running",
      "managed auto-deliver must keep Task running on merge refuse"
    );
    const list = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal(
      (list.result as { deliveries: unknown[] }).deliveries.length,
      0,
      "managed path must not publish ready Delivery on merge"
    );

    const draft = await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath);
    assert.ok(draft, "report draft must be preserved before second-gate refuse");
    assert.equal(draft!.assistantText, reportText);
    assert.equal(draft!.sessionId, sessionId);
    assert.match(
      String(draft!.lastError ?? ""),
      /EXECUTOR_LANE_HISTORY|MERGE_COMMIT|merge|history/i
    );
    assert.ok(draft!.attemptCount >= 1);
  });
});
