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
  invokeManagedAutoDeliverRetryFromDraftForTests,
  holdManagedTaskInputQueueForTests,
  resetManagedAutoDeliverDedupForTests,
  setAfterManagedSessionProviderStartForTests,
} from "../src/service/handlers.js";
import {
  ManagedDeliveryReportDraftStore,
  makeManagedDeliveryReportDraftId,
} from "../src/service/managed-delivery-report-draft-store.js";
import { configureTestGitIdentity, git } from "./helpers.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { createDelivery, loadDeliveries, writeDelivery } from "../src/core/delivery.js";
import { loadTaskEnvelope, patchTaskEnvelope } from "../src/core/task.js";

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

async function setupManagedTask(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string,
  acceptMode: "review-required" | "auto-accept"
): Promise<{ workspaceId: string; nodeId: string; taskPath: string; sessionId: string }> {
  const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
  const dispatched = await rpc(svc, "task.dispatch", {
    parentActor: { kind: "user", id: "user" },
    workspaceId,
    workNodeIds: [nodeId],
    contextNodeIds: [],
    connectionId: "fake-default",
    prompt: "managed Delivery WAL recovery",
    acceptMode,
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
  return { workspaceId, nodeId, taskPath, sessionId };
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
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "preserve draft on dirty refuse",
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
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "deliver malformed control text intact",
      acceptMode: "review-required",
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

  // Phase 1: fail deliver with dirty worktree → draft on disk; stop service.
  await withService(
    async (svc) => {
      const mounted = await mountWorkItem(svc, ws);
      workspaceId = mounted.workspaceId;
      const d = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        workspaceId,
        workNodeIds: [mounted.nodeId],
        contextNodeIds: [],
        connectionId: "fake-default",
        prompt: "restart must keep draft",
        acceptMode: "review-required",
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
      const sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;

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
      assert.equal(task.state, "waiting", "restart must park the dead managed Session");
      const resumed = await rpc(svc, "task.resume", {
        workspaceId: liveWorkspaceId,
        taskPath,
      });
      assert.ok(!resumed.error, JSON.stringify(resumed.error));
      assert.equal(
        (resumed.result as { task: { state: string } }).task.state,
        "delivered",
        "formal task.resume must retry the durable final report without provider re-prompt"
      );

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

test("task.resume reconciles a Delivery WAL committed before the Task write", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-resume-post-wal");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    await svc.ctx.managedDeliveryReportDrafts.preserve({
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "outcome: delivered\n\nRESUME_POST_WAL_REPORT",
    });
    const parked = await rpc(svc, "task.wait", {
      workspaceId,
      taskPath,
      reason: "external",
      summary: "retry durable report after resume",
    });
    assert.ok(!parked.error, JSON.stringify(parked.error));

    const originalWrite = mount.env.fs.writeFile.bind(mount.env.fs);
    let deliveryWritten = false;
    let injected = false;
    mount.env.fs.writeFile = async (relativePath, content) => {
      const normalized = relativePath.replaceAll("\\", "/");
      if (normalized.includes("/deliveries/") && normalized.endsWith(".md")) {
        await originalWrite(relativePath, content);
        deliveryWritten = true;
        return;
      }
      if (!injected && deliveryWritten && normalized === taskPath.replaceAll("\\", "/")) {
        injected = true;
        deliveryWritten = false;
        throw new Error("injected Task write failure after ready Delivery WAL");
      }
      await originalWrite(relativePath, content);
    };
    let resumed;
    try {
      resumed = await rpc(svc, "task.resume", { workspaceId, taskPath });
    } finally {
      mount.env.fs.writeFile = originalWrite;
    }
    assert.equal(injected, true, "fault must hit the Task write after Delivery WAL");
    assert.ok(!resumed.error, JSON.stringify(resumed.error));
    assert.equal(
      (resumed.result as { task: { state: string } }).task.state,
      "delivered",
      "resume response must project the reconciled committed Delivery"
    );
    const task = await loadTaskEnvelope(mount.env.fs, taskPath);
    const deliveries = await loadDeliveries(mount.env.fs, { taskId: task.id! });
    assert.equal(task.state, "delivered");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.summary, "RESUME_POST_WAL_REPORT");
  });
});

test("P0: publish preparation failure preserves draft; retry publishes without re-prompt", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-integrate-fail");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "integrate fail keeps draft",
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

test("managed report retry repairs ready Delivery plus running Task through Core WAL", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-ready-running-recovery");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskEnvelope(mount.env.fs, taskPath);
    const delivery = await createDelivery(mount.env.fs, mount.env.clock, {
      taskId: task.id!,
      sourceNodeId: nodeId,
      deliveriesDir: task.roleId
        ? `temp/roles/${task.roleId}/deliveries`
        : `temp/sessions/${task.sessionId}/deliveries`,
      summary: "READY_RUNNING_RECOVERY",
      taskLastOutcome: "delivered",
      status: "ready",
    });
    const sessionsBefore = (await svc.runtime.registry.list()).map((row) => row.id).sort();

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "READY_RUNNING_RECOVERY",
    });

    const repaired = await loadTaskEnvelope(mount.env.fs, taskPath);
    assert.equal(repaired.state, "delivered");
    assert.equal(repaired.activeDeliveryId, delivery.id);
    const deliveries = await loadDeliveries(mount.env.fs, { taskId: task.id! });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.id, delivery.id);
    assert.equal(deliveries[0]!.status, "ready");
    assert.equal(await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath), undefined);
    assert.deepEqual(
      (await svc.runtime.registry.list()).map((row) => row.id).sort(),
      sessionsBefore,
      "WAL retry must not launch a replacement provider Session"
    );
  });
});

test("managed report retry repairs accepted Delivery plus delivered Task without deriving current commits", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-accepted-delivered-recovery");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "auto-accept"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskEnvelope(mount.env.fs, taskPath);
    const historicalCommit = "a".repeat(40);
    const delivery = await createDelivery(mount.env.fs, mount.env.clock, {
      taskId: task.id!,
      sourceNodeId: nodeId,
      deliveriesDir: task.roleId
        ? `temp/roles/${task.roleId}/deliveries`
        : `temp/sessions/${task.sessionId}/deliveries`,
      summary: "ACCEPTED_DELIVERED_RECOVERY",
      commits: [historicalCommit],
      targetHead: "b".repeat(40),
      taskLastOutcome: "delivered",
      status: "accepted",
      integrationMode: "auto-accept",
    });
    await patchTaskEnvelope(mount.env.fs, taskPath, {
      state: "delivered",
      activeDeliveryId: delivery.id,
      lastOutcome: "delivered",
      updatedAt: mount.env.clock.now(),
    });
    const sessionsBefore = (await svc.runtime.registry.list()).map((row) => row.id).sort();

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "ACCEPTED_DELIVERED_RECOVERY",
    });

    const repaired = await loadTaskEnvelope(mount.env.fs, taskPath);
    assert.equal(repaired.state, "accepted");
    assert.equal(repaired.activeDeliveryId, delivery.id);
    const deliveries = await loadDeliveries(mount.env.fs, { taskId: task.id! });
    assert.equal(deliveries.length, 1);
    assert.deepEqual(deliveries[0]!.commits, [historicalCommit]);
    assert.equal(deliveries[0]!.status, "accepted");
    assert.equal(await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath), undefined);
    assert.deepEqual(
      (await svc.runtime.registry.list()).map((row) => row.id).sort(),
      sessionsBefore,
      "accepted WAL retry must not launch or replay the provider"
    );
  });
});

test("managed WAL recovery keeps the durable draft when the retry report mismatches", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-candidate-mismatch");
  await initGitOnWorkspace(ws);
  await withService(async (svc, dataDir) => {
    const { workspaceId, nodeId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskEnvelope(mount.env.fs, taskPath);
    await svc.ctx.managedDeliveryReportDrafts.preserve({
      workspaceId,
      taskPath,
      taskId: task.id!,
      sessionId,
      assistantText: "PERSISTED_REPORT",
    });
    await createDelivery(mount.env.fs, mount.env.clock, {
      taskId: task.id!,
      sourceNodeId: nodeId,
      deliveriesDir: task.roleId
        ? `temp/roles/${task.roleId}/deliveries`
        : `temp/sessions/${task.sessionId}/deliveries`,
      summary: "PERSISTED_REPORT",
      taskLastOutcome: "delivered",
      status: "ready",
    });
    const draftFile = path.join(dataDir, "managed-delivery-report-drafts.json");
    const draftRaw = await fs.readFile(draftFile, "utf8");
    const taskRaw = await mount.env.fs.readFile(taskPath);

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "DIFFERENT_RETRY_REPORT",
    });

    const retained = await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath);
    assert.equal(retained?.assistantText, "PERSISTED_REPORT");
    assert.equal(await fs.readFile(draftFile, "utf8"), draftRaw);
    assert.equal(await mount.env.fs.readFile(taskPath), taskRaw);
    const deliveries = await loadDeliveries(mount.env.fs, { taskId: task.id! });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.status, "ready");
    assert.equal((await loadTaskEnvelope(mount.env.fs, taskPath)).state, "running");
  });
});

for (const operation of ["task.sendInput", "task.startSession", "task.replaceSession"] as const) {
  test(`${operation} reconciles ready Delivery WAL before composite side effects`, async () => {
    resetManagedAutoDeliverDedupForTests();
    const ws = await makeWorkspace(`mrd-composite-${operation}`);
    await initGitOnWorkspace(ws);
    await withService(async (svc) => {
      const { workspaceId, nodeId, taskPath, sessionId } = await setupManagedTask(
        svc,
        ws,
        "review-required"
      );
      const mount = svc.ctx.host.require(workspaceId);
      const task = await loadTaskEnvelope(mount.env.fs, taskPath);
      const committed = await createDelivery(mount.env.fs, mount.env.clock, {
        taskId: task.id!,
        sourceNodeId: nodeId,
        deliveriesDir: task.roleId
          ? `temp/roles/${task.roleId}/deliveries`
          : `temp/sessions/${task.sessionId}/deliveries`,
        summary: `COMPOSITE_${operation}`,
        taskLastOutcome: "delivered",
        status: "ready",
      });
      const sessionsBefore = (await svc.runtime.registry.list()).map((row) => row.id).sort();
      const inputCountBefore = (
        await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)
      ).length;
      const priorProbe = await svc.runtime.probe(sessionId);
      assert.equal(priorProbe.alive, true);

      const result = operation === "task.sendInput"
        ? await rpc(svc, operation, { workspaceId, taskPath, text: "MUST_NOT_PERSIST" })
        : await rpc(svc, operation, { workspaceId, taskPath, callerKind: "user" });
      assert.ok(result.error, `${operation} must fail after WAL convergence`);

      const repaired = await loadTaskEnvelope(mount.env.fs, taskPath);
      assert.equal(repaired.state, "delivered");
      assert.equal(repaired.activeDeliveryId, committed.id);
      assert.equal(
        (await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)).length,
        inputCountBefore,
        "composite failure must not add TaskInput"
      );
      assert.deepEqual(
        (await svc.runtime.registry.list()).map((row) => row.id).sort(),
        sessionsBefore,
        "composite failure must not reserve or launch a Session"
      );
      assert.equal(
        (await svc.runtime.probe(sessionId)).alive,
        true,
        "replaceSession must not stop the prior child"
      );
      assert.equal((await loadDeliveries(mount.env.fs, { taskId: task.id! })).length, 1);
    });
  });
}

for (const operation of ["task.startSession", "task.replaceSession"] as const) {
  test(`${operation} cleans a newly started child when Delivery WAL wins before final bind`, async () => {
    resetManagedAutoDeliverDedupForTests();
    const ws = await makeWorkspace(`mrd-provider-race-${operation}`);
    await initGitOnWorkspace(ws);
    await withService(async (svc) => {
      const { workspaceId, nodeId, taskPath, sessionId } = await setupManagedTask(
        svc,
        ws,
        "review-required"
      );
      const mount = svc.ctx.host.require(workspaceId);
      const ownerTask = await loadTaskEnvelope(mount.env.fs, taskPath);
      const ownerDeliveriesDir = ownerTask.roleId
        ? `temp/roles/${ownerTask.roleId}/deliveries`
        : `temp/sessions/${ownerTask.sessionId}/deliveries`;
      if (operation === "task.startSession") {
        await svc.runtime.stopSession(sessionId, "user");
        await svc.runtime.registry.update(sessionId, {
          state: "reserved",
          pid: undefined,
          resumeToken: undefined,
          lastError: undefined,
        });
        await patchTaskEnvelope(mount.env.fs, taskPath, {
          state: "running",
          wait: null,
          updatedAt: mount.env.clock.now(),
        });
        assert.equal((await svc.runtime.probe(sessionId)).alive, false);
      }

      let startedSessionId = "";
      let committedId = "";
      setAfterManagedSessionProviderStartForTests(async (hook) => {
        if (hook.operation !== operation) return;
        startedSessionId = hook.sessionId;
        const current = await loadTaskEnvelope(mount.env.fs, taskPath);
        const committed = await createDelivery(mount.env.fs, mount.env.clock, {
          taskId: current.id!,
          sourceNodeId: nodeId,
          deliveriesDir: ownerDeliveriesDir,
          summary: `PROVIDER_RACE_${operation}`,
          taskLastOutcome: "delivered",
          status: "ready",
        });
        committedId = committed.id;
      });
      try {
        const result = await rpc(svc, operation, {
          workspaceId,
          taskPath,
          callerKind: "user",
        });
        assert.ok(result.error, `${operation} must lose to the committed Delivery`);
      } finally {
        setAfterManagedSessionProviderStartForTests(null);
      }

      assert.ok(startedSessionId, "test hook must observe the newly started child");
      const repaired = await loadTaskEnvelope(mount.env.fs, taskPath);
      assert.equal(repaired.state, "delivered");
      assert.equal(repaired.activeDeliveryId, committedId);
      assert.equal(
        (await svc.runtime.probe(startedSessionId)).alive,
        false,
        "losing provider child must be stopped"
      );
      const deliveries = await loadDeliveries(mount.env.fs, { taskId: repaired.id! });
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]!.id, committedId);
    });
  });
}

test("managed blocked report preserves full body and stale draft retry cannot re-park a resumed turn", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-control-report");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const fullBody = `BLOCKED_FULL_BODY_${"中".repeat(2_500)}`;
    const control = `outcome: blocked\n\n${fullBody}`;

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: control,
      commits: [],
    });
    const parked = await loadTaskEnvelope(mount.env.fs, taskPath);
    assert.equal(parked.state, "waiting");
    assert.ok((parked.wait?.summary.length ?? 0) <= 2_000);
    const draft = await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath);
    assert.equal(draft?.assistantText, control);
    assert.ok(draft!.assistantText.includes(fullBody));

    const resumed = await rpc(svc, "task.resume", { workspaceId, taskPath });
    assert.ok(!resumed.error, JSON.stringify(resumed.error));
    await invokeManagedAutoDeliverRetryFromDraftForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
    });
    assert.equal(
      (await loadTaskEnvelope(mount.env.fs, taskPath)).state,
      "running",
      "generic retry must not replay the stale blocked report"
    );
    assert.equal(
      (await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath))?.assistantText,
      control
    );

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "outcome: delivered\n\nNEW_RESUMED_REPORT",
      commits: [],
    });
    const delivered = await loadTaskEnvelope(mount.env.fs, taskPath);
    assert.equal(delivered.state, "delivered");
    const deliveries = await loadDeliveries(mount.env.fs, { taskId: delivered.id! });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.summary, "NEW_RESUMED_REPORT");
    assert.equal(await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath), undefined);
  });
});

test("managed control draft from retired Session is superseded by current replacement report", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-control-replace");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId: priorSessionId } =
      await setupManagedTask(svc, ws, "review-required");
    const mount = svc.ctx.host.require(workspaceId);
    const control = "outcome: needs-input\n\nOLD_SESSION_CONTROL";
    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId: priorSessionId,
      assistantText: control,
      commits: [],
    });
    assert.equal((await loadTaskEnvelope(mount.env.fs, taskPath)).state, "waiting");

    const resumed = await rpc(svc, "task.resume", { workspaceId, taskPath });
    assert.ok(!resumed.error, JSON.stringify(resumed.error));
    const replaced = await rpc(svc, "task.replaceSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(!replaced.error, JSON.stringify(replaced.error));
    const replacementSessionId = (
      replaced.result as { session: { sessionId: string } }
    ).session.sessionId;
    assert.notEqual(replacementSessionId, priorSessionId);

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId: replacementSessionId,
      assistantText: "outcome: delivered\n\nREPLACEMENT_SESSION_REPORT",
      commits: [],
    });
    const delivered = await loadTaskEnvelope(mount.env.fs, taskPath);
    assert.equal(delivered.state, "delivered");
    const deliveries = await loadDeliveries(mount.env.fs, { taskId: delivered.id! });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.summary, "REPLACEMENT_SESSION_REPORT");
    assert.equal(await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath), undefined);
  });
});

test("terminal reject feedback permits replacement; uncertain requires ack first", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-reject-terminal-session");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId, taskPath, sessionId: priorSessionId } =
      await setupManagedTask(svc, ws, "review-required");
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskEnvelope(mount.env.fs, taskPath);
    const delivery = await createDelivery(mount.env.fs, mount.env.clock, {
      taskId: task.id!,
      sourceNodeId: nodeId,
      deliveriesDir: task.roleId
        ? `temp/roles/${task.roleId}/deliveries`
        : `temp/sessions/${task.sessionId}/deliveries`,
      summary: "REJECT_TERMINAL_SESSION",
      status: "ready",
    });
    delivery.status = "rejected";
    delivery.review = { by: "user", decision: "reject", note: "REVIEW_TERMINAL" };
    await writeDelivery(mount.env.fs, delivery);
    await patchTaskEnvelope(mount.env.fs, taskPath, {
      state: "running",
      activeDeliveryId: delivery.id,
      updatedAt: mount.env.clock.now(),
    });
    const reviewId = `ti-rf-${delivery.id.slice(3)}`;
    await svc.ctx.taskInputs.add({
      id: reviewId,
      workspaceId,
      taskPath,
      taskId: task.id,
      sessionId: priorSessionId,
      kind: "review-feedback",
      text: "REVIEW_TERMINAL",
      status: "pending",
      createdAt: "2026-08-10T02:00:00.000Z",
      updatedAt: "2026-08-10T02:00:00.000Z",
    });
    await svc.ctx.taskInputs.markProcessing(reviewId);
    await svc.ctx.taskInputs.markUncertain(
      reviewId,
      "provider accepted but durable confirmation failed",
      "service",
      { sessionId: priorSessionId }
    );

    const refused = await rpc(svc, "task.replaceSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(refused.error);
    assert.match(refused.error!.message, /uncertain.*ack/i);
    assert.equal(
      (await loadTaskEnvelope(mount.env.fs, taskPath)).sessionId,
      priorSessionId,
      "uncertain continuation must block before replacement side effects"
    );
    assert.equal((await svc.runtime.probe(priorSessionId)).alive, true);

    const acked = await rpc(svc, "taskInput.ack", {
      workspaceId,
      taskPath,
      inputId: reviewId,
    });
    assert.ok(!acked.error, JSON.stringify(acked.error));
    assert.equal((acked.result as { input: { status: string } }).input.status, "consumed");

    const replaced = await rpc(svc, "task.replaceSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(!replaced.error, JSON.stringify(replaced.error));
    const replacementSessionId = (
      replaced.result as { session: { sessionId: string } }
    ).session.sessionId;
    assert.notEqual(replacementSessionId, priorSessionId);
    const terminalRow = await svc.ctx.taskInputs.get(reviewId, workspaceId, taskPath);
    assert.equal(terminalRow?.status, "consumed");
    assert.equal(
      terminalRow?.sessionId,
      priorSessionId,
      "terminal feedback retains its historical Session identity"
    );
  });
});

test("delivered reject feedback keeps historical Session while replacement succeeds", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("mrd-reject-delivered-session");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId, taskPath, sessionId: priorSessionId } =
      await setupManagedTask(svc, ws, "review-required");
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskEnvelope(mount.env.fs, taskPath);
    const delivery = await createDelivery(mount.env.fs, mount.env.clock, {
      taskId: task.id!,
      sourceNodeId: nodeId,
      deliveriesDir: task.roleId
        ? `temp/roles/${task.roleId}/deliveries`
        : `temp/sessions/${task.sessionId}/deliveries`,
      summary: "REJECT_DELIVERED_SESSION",
      status: "ready",
    });
    delivery.status = "rejected";
    delivery.review = { by: "user", decision: "reject", note: "REVIEW_DELIVERED" };
    await writeDelivery(mount.env.fs, delivery);
    await patchTaskEnvelope(mount.env.fs, taskPath, {
      state: "running",
      activeDeliveryId: delivery.id,
      updatedAt: mount.env.clock.now(),
    });
    const reviewId = `ti-rf-${delivery.id.slice(3)}`;
    await svc.ctx.taskInputs.add({
      id: reviewId,
      workspaceId,
      taskPath,
      taskId: task.id,
      sessionId: priorSessionId,
      kind: "review-feedback",
      text: "REVIEW_DELIVERED",
      status: "delivered",
      createdAt: "2026-08-10T02:30:00.000Z",
      updatedAt: "2026-08-10T02:30:00.000Z",
    });

    const replaced = await rpc(svc, "task.replaceSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(!replaced.error, JSON.stringify(replaced.error));
    const replacementSessionId = (
      replaced.result as { session: { sessionId: string } }
    ).session.sessionId;
    assert.notEqual(replacementSessionId, priorSessionId);
    const terminalRow = await svc.ctx.taskInputs.get(reviewId, workspaceId, taskPath);
    assert.equal(terminalRow?.status, "delivered");
    assert.equal(terminalRow?.sessionId, priorSessionId);
  });
});

for (const operation of ["task.startSession", "task.replaceSession"] as const) {
  test(`${operation} recovers reject-resume feedback before later retryable input`, async () => {
    resetManagedAutoDeliverDedupForTests();
    const ws = await makeWorkspace(`mrd-reject-feedback-${operation}`);
    await initGitOnWorkspace(ws);
    await withService(async (svc) => {
      const { workspaceId, nodeId, taskPath } = await setupManagedTask(
        svc,
        ws,
        "review-required"
      );
      const mount = svc.ctx.host.require(workspaceId);
      const task = await loadTaskEnvelope(mount.env.fs, taskPath);
      const delivery = await createDelivery(mount.env.fs, mount.env.clock, {
        taskId: task.id!,
        sourceNodeId: nodeId,
        deliveriesDir: task.roleId
          ? `temp/roles/${task.roleId}/deliveries`
          : `temp/sessions/${task.sessionId}/deliveries`,
        summary: "REJECT_RESUME_FEEDBACK_ORDER",
        status: "ready",
      });
      delivery.status = "rejected";
      delivery.review = {
        by: "user",
        decision: "reject",
        note: "REVIEW_FIRST",
      };
      await writeDelivery(mount.env.fs, delivery);
      await patchTaskEnvelope(mount.env.fs, taskPath, {
        state: "running",
        activeDeliveryId: delivery.id,
        updatedAt: mount.env.clock.now(),
      });
      const common = {
        workspaceId,
        taskPath,
        taskId: task.id,
        sessionId: task.sessionId,
        status: "pending" as const,
      };
      const review = await svc.ctx.taskInputs.add({
        ...common,
        id: `ti-rf-${delivery.id.slice(3)}`,
        kind: "review-feedback",
        text: "REVIEW_FIRST",
        createdAt: "2026-08-10T01:00:00.000Z",
        updatedAt: "2026-08-10T01:00:00.000Z",
      });
      const later = await svc.ctx.taskInputs.add({
        ...common,
        id: "ti-later-input",
        kind: "user-input",
        text: "LATER_INPUT",
        createdAt: "2026-08-10T01:00:01.000Z",
        updatedAt: "2026-08-10T01:00:01.000Z",
      });

      const hold = holdManagedTaskInputQueueForTests(workspaceId, taskPath);
      try {
        const recovered = await rpc(svc, operation, {
          workspaceId,
          taskPath,
          callerKind: "user",
        });
        assert.ok(!recovered.error, JSON.stringify(recovered.error));
        await hold.entered;
        const reviewAfter = await svc.ctx.taskInputs.get(review.id, workspaceId, taskPath);
        const laterAfter = await svc.ctx.taskInputs.get(later.id, workspaceId, taskPath);
        assert.equal(reviewAfter?.status, "pending");
        assert.equal(
          laterAfter?.status,
          "pending",
          "later input must remain behind the review-feedback turn"
        );
      } finally {
        hold.release();
      }
    });
  });
}
