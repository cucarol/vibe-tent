/**
 * Managed Delivery report-draft preservation:
 * - durable machine-local store (not ready Delivery / not chat / not pending-interaction)
 * - preserve before publish; survive failure + service restart
 * - idempotent retry from draft; clear after successful Delivery
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import {
  invokeManagedAutoDeliverForTests,
  resetManagedAutoDeliverDedupForTests,
} from "../src/service/handlers.js";
import {
  ManagedDeliveryReportDraftStore,
  makeManagedDeliveryReportDraftId,
} from "../src/service/managed-delivery-report-draft-store.js";
import { configureTestGitIdentity, git } from "./helpers.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";

const FAKE_ROUTE = {
  connectionId: "fake-default",
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, sleepMs: 60_000 },
} as const;

async function makeWorkspace(name = "mrd"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-mrd-ws-"));
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
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>, dataDir: string) => Promise<T>,
  opts?: { dataDir?: string; connections?: import("../src/runtime/types.js").AgentConnectionConfig[] }
): Promise<T> {
  const dataDir =
    opts?.dataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "tent-mrd-data-")));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    connections: opts?.connections ?? [FAKE_ROUTE],
  });
  try {
    return await fn(svc, dataDir);
  } finally {
    await svc.stop();
  }
}

async function taskWorktree(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  taskPath: string
): Promise<string> {
  const got = await rpc(svc, "task.get", { workspaceId, taskPath });
  assert.ok(!got.error, JSON.stringify(got.error));
  const worktree = (
    got.result as { task: { workspaceLane?: { worktree?: string } } }
  ).task.workspaceLane?.worktree;
  assert.ok(worktree, "route Task must have an exact worktree");
  return worktree;
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

async function initGitOnWorkspace(ws: string): Promise<void> {
  await git(ws, "init");
  await configureTestGitIdentity(ws);
  await git(ws, "add", ".");
  await git(ws, "commit", "-q", "-m", "init");
}

// ---- unit: store ----

test("ManagedDeliveryReportDraftStore: preserve / get / markFailed / clear / restart", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-mrd-store-"));
  const store = new ManagedDeliveryReportDraftStore(dataDir);
  await store.ensureLoaded();

  const first = await store.preserve({
    workspaceId: "ws-1",
    taskPath: "temp/executor/tasks/task-a.md",
    taskId: "tk-aaaa",
    sessionId: "ss-1",
    assistantText: "  FINAL_REPORT_BODY  ",
  });
  assert.equal(first.assistantText, "FINAL_REPORT_BODY");
  assert.equal(first.attemptCount, 1);
  assert.equal(first.lastError, undefined);
  assert.ok(first.id.startsWith("mrd-"));

  const got = await store.get("ws-1", "temp/executor/tasks/task-a.md");
  assert.ok(got);
  assert.equal(got!.assistantText, "FINAL_REPORT_BODY");
  assert.equal(got!.sessionId, "ss-1");

  // Idempotent re-preserve for same task bumps attempt, keeps body.
  const second = await store.preserve({
    workspaceId: "ws-1",
    taskPath: "temp/executor/tasks/task-a.md",
    sessionId: "ss-1",
    assistantText: "FINAL_REPORT_BODY",
  });
  assert.equal(second.id, first.id);
  assert.equal(second.attemptCount, 2);
  assert.equal(second.createdAt, first.createdAt);

  const failed = await store.markFailed(
    "ws-1",
    "temp/executor/tasks/task-a.md",
    "WORKTREE_DIRTY: uncommitted"
  );
  assert.ok(failed);
  assert.equal(failed!.assistantText, "FINAL_REPORT_BODY");
  assert.match(failed!.lastError!, /WORKTREE_DIRTY/);

  // Survive "restart": new store instance on same dataDir.
  const reloaded = new ManagedDeliveryReportDraftStore(dataDir);
  await reloaded.ensureLoaded();
  const afterRestart = await reloaded.get("ws-1", "temp/executor/tasks/task-a.md");
  assert.ok(afterRestart);
  assert.equal(afterRestart!.assistantText, "FINAL_REPORT_BODY");
  assert.match(afterRestart!.lastError!, /WORKTREE_DIRTY/);
  assert.equal(afterRestart!.attemptCount, 2);

  const cleared = await reloaded.clear("ws-1", "temp/executor/tasks/task-a.md");
  assert.equal(cleared, true);
  assert.equal(await reloaded.get("ws-1", "temp/executor/tasks/task-a.md"), undefined);
  // Idempotent clear.
  assert.equal(await reloaded.clear("ws-1", "temp/executor/tasks/task-a.md"), false);

  // Disk file still exists but items empty.
  const raw = JSON.parse(await fs.readFile(reloaded.filePath, "utf8")) as {
    items: unknown[];
  };
  assert.equal(raw.items.length, 0);
});

test("ManagedDeliveryReportDraftStore: empty assistantText refused; id helper", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-mrd-empty-"));
  const store = new ManagedDeliveryReportDraftStore(dataDir);
  await assert.rejects(
    () =>
      store.preserve({
        workspaceId: "ws",
        taskPath: "t",
        sessionId: "ss",
        assistantText: "   ",
      }),
    /non-empty assistantText/
  );
  assert.match(makeManagedDeliveryReportDraftId(() => 0), /^mrd-/);
});

// ---- integration: failure preserves draft; retry + restart ----

test("P0: natural report without outcome survives dirty refusal and draft-only retry", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-dirty-retry");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      connectionId: "fake-default",
      prompt: "preserve draft on dirty refuse",
      deliveryPolicy: "review",
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
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    const worktree = await taskWorktree(svc, workspaceId, taskPath);
    await fs.writeFile(
      path.join(worktree, "UNTRACKED_DIRTY.txt"),
      "untracked dirty\n"
    );

    const reportBody = "DIRTY_PRESERVED_NATURAL_REPORT_BODY";
    const reportText = reportBody;
    const diag: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "session.state") diag.push(ev.payload as Record<string, unknown>);
    });

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: reportText,
    });
    unsub();

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal(
      (got.result as { task: { state: string } }).task.state,
      "running",
      "task must stay running (not delivered)"
    );
    const list = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal(
      (list.result as { deliveries: unknown[] }).deliveries.length,
      0,
      "must not publish ready Delivery"
    );

    const draft = await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath);
    assert.ok(draft, "report draft must be preserved operationally");
    assert.equal(draft!.assistantText, reportText);
    assert.equal(draft!.sessionId, sessionId);
    assert.match(String(draft!.lastError ?? ""), /dirty|uncommitted|WORKTREE/i);
    assert.ok(draft!.attemptCount >= 1);

    const failEv = diag.find((p) => p.runtimeEvent === "session.prompt_complete.failed");
    assert.ok(failEv);
    assert.equal(failEv!.taskFailed, false);
    assert.equal(failEv!.reportDraftPreserved, true);

    // Clean worktree, then idempotent retry from durable draft (empty assistantText).
    await git(worktree, "add", "UNTRACKED_DIRTY.txt");
    await git(worktree, "commit", "-q", "-m", "commit dirty");
    assert.equal((await git(worktree, "status", "--porcelain")).trim(), "");

    resetManagedAutoDeliverDedupForTests();
    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "", // recover from draft — no Agent re-answer
    });

    const after = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((after.result as { task: { state: string } }).task.state, "delivered");
    const afterList = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      afterList.result as { deliveries: Array<{ summary: string; status: string }> }
    ).deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].summary, reportBody);
    assert.equal(deliveries[0].status, "ready");

    const cleared = await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath);
    assert.equal(cleared, undefined, "draft cleared after successful Delivery");
  });
});

test("malformed outcome text is delivered intact instead of discarding the report", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-malformed-outcome");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const dispatched = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      connectionId: "fake-default",
      prompt: "deliver malformed control text intact",
      deliveryPolicy: "review",
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;
    const reportText = "outcome: definitely-not-a-state\n\nMALFORMED_REPORT_BODY";

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: reportText,
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "delivered");
    const listed = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      listed.result as { deliveries: Array<{ summary: string; status: string }> }
    ).deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, "ready");
    assert.equal(deliveries[0]?.summary, reportText);
  });
});

test("P0: report draft survives service restart; retry publishes without re-prompt", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-restart");
  await initGitOnWorkspace(ws);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-mrd-restart-data-"));
  const reportBody = "RESTART_SURVIVES_REPORT_BODY";
  const reportText = `outcome: delivered\n\n${reportBody}`;

  let workspaceId = "";
  let taskPath = "";
  let sessionId = "";

  // Phase 1: fail deliver with dirty worktree → draft on disk; stop service.
  await withService(
    async (svc) => {
      const mounted = await mountWorkItem(svc, ws);
      workspaceId = mounted.workspaceId;
      const d = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        nodeIds: [mounted.nodeId],
        connectionId: "fake-default",
        prompt: "restart must keep draft",
        deliveryPolicy: "review",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;

      const worktree = await taskWorktree(svc, workspaceId, taskPath);
      await fs.writeFile(path.join(worktree, "DIRTY.txt"), "x\n");

      await invokeManagedAutoDeliverForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId,
        assistantText: reportText,
      });

      const draft = await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath);
      assert.ok(draft);
      assert.equal(draft!.assistantText, reportText);

      const mid = await rpc(svc, "task.get", { workspaceId, taskPath });
      assert.equal((mid.result as { task: { state: string } }).task.state, "running");
    },
    { dataDir }
  );

  // Disk still holds the draft after stop.
  const diskStore = new ManagedDeliveryReportDraftStore(dataDir);
  await diskStore.ensureLoaded();
  const onDisk = await diskStore.get(workspaceId, taskPath);
  assert.ok(onDisk, "draft must survive service stop");
  assert.equal(onDisk!.assistantText, reportText);

  // Clean worktree outside service.
  const taskFs = new NodeFs(path.join(ws, ".tent"));
  const persisted = await import("../src/core/task.js").then(({ loadTaskEnvelope }) =>
    loadTaskEnvelope(taskFs, taskPath)
  );
  assert.ok(persisted.worktree, "route Task worktree must persist across Service restart");
  await git(persisted.worktree, "add", "DIRTY.txt");
  await git(persisted.worktree, "commit", "-q", "-m", "clean for retry");

  // Phase 2: new service process on same dataDir + remount workspace.
  // workspaceId is path-stable (hash of root); draft key survives restart.
  // Mount reconciliation parks the task waiting(external) when the managed
  // process is gone — resume occupation, then retry deliver from draft only.
  resetManagedAutoDeliverDedupForTests();
  await withService(
    async (svc) => {
      const remounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
      assert.ok(!remounted.error, JSON.stringify(remounted.error));
      const liveWorkspaceId = (remounted.result as { workspaceId: string }).workspaceId;
      assert.equal(
        liveWorkspaceId,
        workspaceId,
        "remount of same root must reuse stable workspaceId (draft key)"
      );

      const draft = await svc.ctx.managedDeliveryReportDrafts.get(liveWorkspaceId, taskPath);
      assert.ok(draft, "draft must reload from dataDir after restart");
      assert.equal(draft!.assistantText, reportText);

      const got = await rpc(svc, "task.get", { workspaceId: liveWorkspaceId, taskPath });
      assert.ok(!got.error, JSON.stringify(got.error));
      const task = (got.result as { task: { state: string; sessionId?: string } }).task;
      // Dead managed process after restart → waiting(external); occupation held.
      assert.ok(
        task.state === "waiting" || task.state === "running",
        `expected waiting/running after restart remount, got ${task.state}`
      );
      if (task.state === "waiting") {
        const resumed = await rpc(svc, "task.resume", {
          workspaceId: liveWorkspaceId,
          taskPath,
        });
        assert.ok(!resumed.error, JSON.stringify(resumed.error));
        assert.equal(
          (resumed.result as { task: { state: string } }).task.state,
          "running"
        );
      }

      const liveSessionId = task.sessionId || sessionId;
      await invokeManagedAutoDeliverForTests(svc.ctx, {
        workspaceId: liveWorkspaceId,
        taskPath,
        sessionId: liveSessionId,
        assistantText: "", // recover from draft only — no Agent re-answer
      });

      const after = await rpc(svc, "task.get", { workspaceId: liveWorkspaceId, taskPath });
      assert.equal((after.result as { task: { state: string } }).task.state, "delivered");
      const list = await rpc(svc, "delivery.list", { workspaceId: liveWorkspaceId });
      const deliveries = (
        list.result as { deliveries: Array<{ summary: string; status: string }> }
      ).deliveries;
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].summary, reportBody);
      assert.equal(deliveries[0].status, "ready");

      assert.equal(
        await svc.ctx.managedDeliveryReportDrafts.get(liveWorkspaceId, taskPath),
        undefined,
        "draft cleared after successful Delivery post-restart"
      );
    },
    { dataDir }
  );
});

test("P0: publish preparation failure preserves draft; retry publishes without re-prompt", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-integrate-fail");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      connectionId: "fake-default",
      prompt: "integrate fail keeps draft",
      deliveryPolicy: "review",
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
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    const reportBody = "INTEGRATE_FAIL_PRESERVED_REPORT";
    const reportText = `outcome: delivered\n\n${reportBody}`;
    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: reportText,
      commits: ["not-a-commit"],
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "running");
    const list1 = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal(
      (list1.result as { deliveries: unknown[] }).deliveries.length,
      0,
      "failed publish preparation must not leave a Delivery"
    );

    const draft = await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath);
    assert.ok(draft);
    assert.equal(draft!.assistantText, reportText);
    assert.match(String(draft!.lastError ?? ""), /commit|revision|unknown|invalid/i);

    // Retry without the invalid SHA: a zero-commit review Delivery is published
    // from the preserved report without asking the provider to answer again.
    resetManagedAutoDeliverDedupForTests();
    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "", // from draft
      commits: [],
    });

    const after = await rpc(svc, "task.get", { workspaceId, taskPath });
    const state = (after.result as { task: { state: string } }).task.state;
    assert.equal(state, "delivered");
    const list2 = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      list2.result as { deliveries: Array<{ summary: string }> }
    ).deliveries;
    assert.ok(deliveries.some((d) => d.summary === reportBody));
    assert.equal(
      await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath),
      undefined,
      "draft cleared after successful publish"
    );
  });
});
