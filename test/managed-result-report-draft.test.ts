/**
 * Managed TaskResult report-draft preservation:
 * - durable machine-local store (not ready TaskResult / not chat / not pending-interaction)
 * - preserve before publish; survive failure + service restart
 * - idempotent retry from draft; clear after successful TaskResult
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
  boundedTaskReturnErrorForTests,
  invokeManagedAutoSubmitForTests,
  invokeManagedAutoSubmitRetryFromDraftForTests,
  holdManagedTaskInputQueueForTests,
  resetManagedAutoSubmitFlightsForTests,
  setAfterManagedSessionProviderStartForTests,
} from "../src/service/handlers.js";
import {
  ManagedTaskResultReportDraftStore,
} from "../src/service/managed-result-report-draft-store.js";
import { configureTestGitIdentity, git } from "./helpers.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { createTaskResult, loadTaskResults, writeTaskResult } from "../src/core/task-result.js";
import { loadTaskRecord, patchTaskRecord } from "../src/core/task.js";
import { runTaskLifecycle } from "../src/service/task-lifecycle-flight.js";

const FAKE_ROUTE = {
  connectionId: "fake-default",
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, sleepMs: 60_000 },
} as const;

test("Service failed-return writer truncates multibyte error at a valid UTF-8 boundary", () => {
  const bounded = boundedTaskReturnErrorForTests("中".repeat(10_000));
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 8 * 1024);
  assert.equal(bounded.includes("\uFFFD"), false);
  assert.match(bounded, /…$/);
});

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

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
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
    requester: { kind: "user", id: "user" },
    workspaceId,
    nodeIds: [nodeId],
    connectionId: "fake-default",
    prompt: "managed TaskResult WAL recovery",
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

test("ManagedTaskResultReportDraftStore: preserve / get / markFailed / clear / restart", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-mrd-store-"));
  const store = new ManagedTaskResultReportDraftStore(dataDir);
  await store.ensureLoaded();

  const first = await store.preserve({
    workspaceId: "ws-1",
    taskPath: "temp/executor/tasks/task-a.md",
    taskId: "tk-aaaa",
    sessionId: "ss-1",
    assistantText: "  FINAL_REPORT_BODY  ",
  });
  assert.equal(first.assistantText, "FINAL_REPORT_BODY");
  assert.equal(first.lastError, undefined);
  assert.ok(first.createdAt);
  assert.ok(first.updatedAt);

  const got = await store.get("ws-1", "temp/executor/tasks/task-a.md");
  assert.ok(got);
  assert.equal(got!.assistantText, "FINAL_REPORT_BODY");
  assert.equal(got!.sessionId, "ss-1");

  // Same exact Task is one slot: overwrite Session/body and clear diagnostics.
  const second = await store.preserve({
    workspaceId: "ws-1",
    taskPath: "temp/executor/tasks/task-a.md",
    sessionId: "ss-1",
    assistantText: "FINAL_REPORT_BODY",
  });
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
  const reloaded = new ManagedTaskResultReportDraftStore(dataDir);
  await reloaded.ensureLoaded();
  const afterRestart = await reloaded.get("ws-1", "temp/executor/tasks/task-a.md");
  assert.ok(afterRestart);
  assert.equal(afterRestart!.assistantText, "FINAL_REPORT_BODY");
  assert.match(afterRestart!.lastError!, /WORKTREE_DIRTY/);
  const persisted = JSON.parse(await fs.readFile(reloaded.filePath, "utf8")) as {
    items: Array<Record<string, unknown>>;
  };
  assert.equal("id" in persisted.items[0]!, false);
  assert.equal("attemptCount" in persisted.items[0]!, false);

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

test("ManagedTaskResultReportDraftStore: empty assistantText refused", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-mrd-empty-"));
  const store = new ManagedTaskResultReportDraftStore(dataDir);
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
});

test("ManagedTaskResultReportDraftStore: malformed state fails loud without mutation or backup", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-mrd-corrupt-"));
  const file = path.join(dataDir, "managed-result-report-drafts.json");
  for (const raw of [
    "{not-json\n",
    JSON.stringify({ items: [{ workspaceId: "ws", taskPath: "task", id: "retired" }] }),
  ]) {
    await fs.writeFile(file, raw, "utf8");
    const before = await fs.readFile(file);
    const store = new ManagedTaskResultReportDraftStore(dataDir);
    await assert.rejects(() => store.ensureLoaded(), /draft state is malformed/i);
    assert.deepEqual(await fs.readFile(file), before);
    assert.deepEqual(await fs.readdir(dataDir), ["managed-result-report-drafts.json"]);
  }
});

test("same-key concurrent completions share one flight and late retry creates no second Result", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-single-flight");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const store = svc.ctx.managedTaskResultReportDrafts;
    const originalPreserve = store.preserve.bind(store);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let preserveCalls = 0;
    store.preserve = async (...args) => {
      preserveCalls += 1;
      const row = await originalPreserve(...args);
      entered();
      await held;
      return row;
    };
    const input = {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "SINGLE_FLIGHT_REPORT",
      commits: [] as string[],
    };
    try {
      const first = invokeManagedAutoSubmitForTests(svc.ctx, input);
      await reached;
      const duplicate = invokeManagedAutoSubmitForTests(svc.ctx, input);
      release();
      await Promise.all([first, duplicate]);
    } finally {
      store.preserve = originalPreserve;
    }
    assert.equal(preserveCalls, 1, "only the owner writes the durable draft");
    let results = await loadTaskResults(svc.ctx.host.require(workspaceId).env.fs);
    assert.equal(results.filter((row) => row.report === "SINGLE_FLIGHT_REPORT").length, 1);
    assert.equal(await store.get(workspaceId, taskPath), undefined);

    await invokeManagedAutoSubmitRetryFromDraftForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
    });
    results = await loadTaskResults(svc.ctx.host.require(workspaceId).env.fs);
    assert.equal(results.filter((row) => row.report === "SINGLE_FLIGHT_REPORT").length, 1);
  });
});

test("draft lookup failure reaches the managed publication diagnostic boundary", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-read-fail-loud");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const store = svc.ctx.managedTaskResultReportDrafts;
    const originalGet = store.get.bind(store);
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type === "session.state") events.push(event.payload as Record<string, unknown>);
    });
    store.get = async () => {
      throw new Error("Managed TaskResult report draft state is malformed");
    };
    try {
      await invokeManagedAutoSubmitForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId,
        assistantText: "",
      });
    } finally {
      store.get = originalGet;
      unsubscribe();
    }
    assert.ok(
      events.some(
        (event) =>
          event.runtimeEvent === "session.prompt_complete.failed" &&
          String(event.error).includes("draft state is malformed")
      )
    );
    assert.equal((await loadTaskResults(svc.ctx.host.require(workspaceId).env.fs)).length, 0);
  });
});

test("draft retry waits for an active failed owner then publishes once without provider replay", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-active-failure-retry");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const store = svc.ctx.managedTaskResultReportDrafts;
    const originalMarkFailed = store.markFailed.bind(store);
    let failedEntered!: () => void;
    let releaseFailure!: () => void;
    const entered = new Promise<void>((resolve) => { failedEntered = resolve; });
    const held = new Promise<void>((resolve) => { releaseFailure = resolve; });
    store.markFailed = async (...args) => {
      const row = await originalMarkFailed(...args);
      failedEntered();
      await held;
      return row;
    };
    const originalStop = svc.ctx.runtime.stopSession.bind(svc.ctx.runtime);
    let providerStops = 0;
    svc.ctx.runtime.stopSession = async (...args) => {
      providerStops += 1;
      return originalStop(...args);
    };
    try {
      const owner = invokeManagedAutoSubmitForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId,
        assistantText: "ACTIVE_OWNER_RETRY_REPORT",
        commits: ["not-a-commit"],
      });
      await entered;
      const retry = invokeManagedAutoSubmitRetryFromDraftForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId,
      });
      releaseFailure();
      await Promise.all([owner, retry]);
    } finally {
      releaseFailure();
      store.markFailed = originalMarkFailed;
      svc.ctx.runtime.stopSession = originalStop;
    }
    const results = await loadTaskResults(svc.ctx.host.require(workspaceId).env.fs);
    assert.equal(results.filter((row) => row.report === "ACTIVE_OWNER_RETRY_REPORT").length, 1);
    assert.equal(providerStops, 1, "retry observes the already sealed provider without replay");
    assert.equal(await store.get(workspaceId, taskPath), undefined);
  });
});

// ---- integration: failure preserves draft; retry + restart ----

test("P0: natural report without outcome survives dirty refusal and draft-only retry", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-dirty-retry");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      requester: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
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

    await invokeManagedAutoSubmitForTests(svc.ctx, {
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
    const list = await rpc(svc, "taskResult.list", { workspaceId });
    assert.equal(
      (list.result as { results: unknown[] }).results.length,
      0,
      "must not publish ready TaskResult"
    );

    const draft = await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath);
    assert.ok(draft, "report draft must be preserved operationally");
    assert.equal(draft!.assistantText, reportText);
    assert.equal(draft!.sessionId, sessionId);
    assert.match(String(draft!.lastError ?? ""), /dirty|uncommitted|WORKTREE/i);

    const failEv = diag.find((p) => p.runtimeEvent === "session.prompt_complete.failed");
    assert.ok(failEv);
    assert.equal(failEv!.taskFailed, false);
    assert.equal(failEv!.reportDraftPreserved, true);

    // Clean worktree, then idempotent retry from durable draft (empty assistantText).
    await git(worktree, "add", "UNTRACKED_DIRTY.txt");
    await git(worktree, "commit", "-q", "-m", "commit dirty");
    assert.equal((await git(worktree, "status", "--porcelain")).trim(), "");

    resetManagedAutoSubmitFlightsForTests();
    await invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "", // recover from draft — no Agent re-answer
    });

    const after = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((after.result as { task: { state: string } }).task.state, "submitted");
    const afterList = await rpc(svc, "taskResult.list", { workspaceId });
    const results = (
      afterList.result as { results: Array<{ report: string; status: string }> }
    ).results;
    assert.equal(results.length, 1);
    assert.equal(results[0].report, reportBody);
    assert.equal(results[0].status, "ready");

    const cleared = await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath);
    assert.equal(cleared, undefined, "draft cleared after successful TaskResult");
  });
});

test("malformed outcome text is submitted intact instead of discarding the report", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-malformed-outcome");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const dispatched = await rpc(svc, "task.dispatch", {
      requester: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
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

    await invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: reportText,
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "submitted");
    const listed = await rpc(svc, "taskResult.list", { workspaceId });
    const results = (
      listed.result as { results: Array<{ report: string; status: string }> }
    ).results;
    assert.equal(results.length, 1);
    assert.equal(results[0]?.status, "ready");
    assert.equal(results[0]?.report, reportText);
  });
});

test("P0: report draft survives service restart; retry publishes without re-prompt", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-restart");
  await initGitOnWorkspace(ws);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-mrd-restart-data-"));
  const reportBody = "RESTART_SURVIVES_REPORT_BODY";
  const reportText = reportBody;

  let workspaceId = "";
  let taskPath = "";

  // Phase 1: fail deliver with dirty worktree → draft on disk; stop service.
  await withService(
    async (svc) => {
      const mounted = await mountWorkItem(svc, ws);
      workspaceId = mounted.workspaceId;
      const d = await rpc(svc, "task.dispatch", {
        requester: { kind: "user", id: "user" },
        workspaceId,
        nodeIds: [mounted.nodeId],
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

      await invokeManagedAutoSubmitForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId,
        assistantText: reportText,
      });

      const draft = await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath);
      assert.ok(draft);
      assert.equal(draft!.assistantText, reportText);

      const mid = await rpc(svc, "task.get", { workspaceId, taskPath });
      assert.equal((mid.result as { task: { state: string } }).task.state, "running");
    },
    { dataDir }
  );

  // Disk still holds the draft after stop.
  const diskStore = new ManagedTaskResultReportDraftStore(dataDir);
  await diskStore.ensureLoaded();
  const onDisk = await diskStore.get(workspaceId, taskPath);
  assert.ok(onDisk, "draft must survive service stop");
  assert.equal(onDisk!.assistantText, reportText);

  // Clean worktree outside service.
  const taskFs = new NodeFs(path.join(ws, ".tent"));
  const persisted = await import("../src/core/task.js").then(({ loadTaskRecord }) =>
    loadTaskRecord(taskFs, taskPath)
  );
  assert.ok(persisted.worktree, "route Task worktree must persist across Service restart");
  await git(persisted.worktree, "add", "DIRTY.txt");
  await git(persisted.worktree, "commit", "-q", "-m", "clean for retry");

  // Phase 2: new service process on same dataDir + remount workspace.
  // workspaceId is path-stable (hash of root); draft key survives restart.
  // Mount reconciliation parks the task waiting(external) when the managed
  // process is gone — resume the same Task path, then retry submit from draft only.
  resetManagedAutoSubmitFlightsForTests();
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

      const draft = await svc.ctx.managedTaskResultReportDrafts.get(liveWorkspaceId, taskPath);
      assert.ok(draft, "draft must reload from dataDir after restart");
      assert.equal(draft!.assistantText, reportText);

      const got = await rpc(svc, "task.get", { workspaceId: liveWorkspaceId, taskPath });
      assert.ok(!got.error, JSON.stringify(got.error));
      const task = (got.result as { task: { state: string; executionSessionId?: string } }).task;
      // Dead managed process after restart → waiting(external); exact Task recovery facts remain.
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
        "submitted",
        "formal task.resume must retry the durable final report without provider re-prompt"
      );

      const after = await rpc(svc, "task.get", { workspaceId: liveWorkspaceId, taskPath });
      assert.equal((after.result as { task: { state: string } }).task.state, "submitted");
      const list = await rpc(svc, "taskResult.list", { workspaceId: liveWorkspaceId });
      const results = (
        list.result as { results: Array<{ report: string; status: string }> }
      ).results;
      assert.equal(results.length, 1);
      assert.equal(results[0].report, reportBody);
      assert.equal(results[0].status, "ready");

      assert.equal(
        await svc.ctx.managedTaskResultReportDrafts.get(liveWorkspaceId, taskPath),
        undefined,
        "draft cleared after successful TaskResult post-restart"
      );
    },
    { dataDir }
  );
});

test("task.resume cannot advance a Result-only partial; exact managed submit retry converges", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-resume-post-wal");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    await svc.ctx.managedTaskResultReportDrafts.preserve({
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "RESUME_POST_WAL_REPORT",
    });
    const parked = await rpc(svc, "task.wait", {
      workspaceId,
      taskPath,
      reason: "external",
      summary: "retry durable report after resume",
    });
    assert.ok(!parked.error, JSON.stringify(parked.error));

    const originalWrite = mount.env.fs.writeFile.bind(mount.env.fs);
    let resultWritten = false;
    let injected = false;
    mount.env.fs.writeFile = async (relativePath, content) => {
      const normalized = relativePath.replaceAll("\\", "/");
      if (normalized.includes("/results/") && normalized.endsWith(".md")) {
        await originalWrite(relativePath, content);
        resultWritten = true;
        return;
      }
      if (!injected && resultWritten && normalized === taskPath.replaceAll("\\", "/")) {
        injected = true;
        resultWritten = false;
        throw new Error("injected Task write failure after ready TaskResult WAL");
      }
      await originalWrite(relativePath, content);
    };
    let resumed;
    try {
      resumed = await rpc(svc, "task.resume", { workspaceId, taskPath });
    } finally {
      mount.env.fs.writeFile = originalWrite;
    }
    assert.equal(injected, true, "fault must hit the Task write after TaskResult WAL");
    assert.equal(
      (resumed.error?.data as { code?: string } | undefined)?.code,
      "RESULT_CHANGED",
      "unrelated resume must not advance an incomplete Result publication"
    );
    const partial = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(partial.state, "running");
    assert.equal(partial.currentResultId, undefined);
    const exactRetry = await rpc(svc, "task.submit", {
      workspaceId,
      taskPath,
      report: "RESUME_POST_WAL_REPORT",
      commits: [],
    });
    assert.ok(!exactRetry.error, JSON.stringify(exactRetry.error));
    const task = await loadTaskRecord(mount.env.fs, taskPath);
    const results = await loadTaskResults(mount.env.fs, { taskId: task.id! });
    assert.equal(task.state, "submitted");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.report, "RESUME_POST_WAL_REPORT");
  });
});

test("P0: publish preparation failure preserves draft; retry publishes without re-prompt", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-integrate-fail");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      requester: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
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
    const reportText = reportBody;
    await invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: reportText,
      commits: ["not-a-commit"],
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "running");
    const list1 = await rpc(svc, "taskResult.list", { workspaceId });
    assert.equal(
      (list1.result as { results: unknown[] }).results.length,
      0,
      "failed publish preparation must not leave a TaskResult"
    );

    const draft = await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath);
    assert.ok(draft);
    assert.equal(draft!.assistantText, reportText);
    assert.match(String(draft!.lastError ?? ""), /commit|revision|unknown|invalid/i);

    // Retry without the invalid SHA: a zero-commit review TaskResult is published
    // from the preserved report without asking the provider to answer again.
    resetManagedAutoSubmitFlightsForTests();
    await invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "", // from draft
      commits: [],
    });

    const after = await rpc(svc, "task.get", { workspaceId, taskPath });
    const state = (after.result as { task: { state: string } }).task.state;
    assert.equal(state, "submitted");
    const list2 = await rpc(svc, "taskResult.list", { workspaceId });
    const results = (
      list2.result as { results: Array<{ report: string }> }
    ).results;
    assert.ok(results.some((d) => d.report === reportBody));
    assert.equal(
      await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath),
      undefined,
      "draft cleared after successful publish"
    );
  });
});

test("oversized final report remains Task-visible when publication preparation fails", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-oversized-result-failure");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const report = "中".repeat(22_000);
    const taskEvents: Array<Record<string, unknown>> = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type === "task.state") taskEvents.push(event.payload as Record<string, unknown>);
    });
    try {
      await invokeManagedAutoSubmitForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId,
        assistantText: report,
        commits: ["not-a-commit"],
      });
    } finally {
      unsubscribe();
    }

    const task = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(task.state, "running");
    assert.equal(task.statusDetail?.kind, "failed");
    assert.equal(task.statusDetail?.report, undefined);
    assert.equal(task.statusDetail?.code, "RESULT_COMMIT_LANE");
    assert.ok(task.statusDetail?.error);
    const failedEvent = taskEvents.find(
      (event) => event.reason === "session.prompt_complete.failed"
    );
    assert.ok(failedEvent, "durable failed return must invalidate Task projections");
    assert.equal(failedEvent!.id, task.id);
    assert.equal(failedEvent!.state, task.state);
    assert.equal(
      (await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath))?.assistantText,
      report
    );
  });
});

test("managed report submission ignores unrelated ready Result history and creates a fresh Result", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-ready-running-recovery");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskRecord(mount.env.fs, taskPath);
    const result = await createTaskResult(mount.env.fs, mount.env.clock, {
      taskId: task.id!,
      resultsDir: task.assigneeRoleId
        ? `temp/roles/${task.assigneeRoleId}/results`
        : `temp/sessions/${task.executionSessionId}/results`,
      report: "READY_RUNNING_RECOVERY",
      status: "ready",
    });
    const sessionsBefore = (await svc.runtime.registry.list()).map((row) => row.id).sort();

    await invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "READY_RUNNING_RECOVERY",
    });

    const repaired = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(repaired.state, "submitted");
    assert.notEqual(repaired.currentResultId, result.id);
    const results = await loadTaskResults(mount.env.fs, { taskId: task.id! });
    assert.equal(results.length, 2);
    assert.equal(results.find((row) => row.id === result.id)?.status, "ready");
    assert.equal(await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath), undefined);
    assert.deepEqual(
      (await svc.runtime.registry.list()).map((row) => row.id).sort(),
      sessionsBefore,
      "WAL retry must not launch a replacement provider Session"
    );
  });
});

test("managed report retry repairs accepted TaskResult plus accepted Task without deriving current commits", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-accepted-delivered-recovery");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "auto-accept"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskRecord(mount.env.fs, taskPath);
    const historicalCommit = "a".repeat(40);
    const result = await createTaskResult(mount.env.fs, mount.env.clock, {
      taskId: task.id!,
      resultsDir: task.assigneeRoleId
        ? `temp/roles/${task.assigneeRoleId}/results`
        : `temp/sessions/${task.executionSessionId}/results`,
      report: "ACCEPTED_DELIVERED_RECOVERY",
      commits: [historicalCommit],
      targetHead: "b".repeat(40),
      status: "ready",
      integrationMode: "auto-accept",
    });
    result.status = "accepted";
    result.review = { reviewer: "user", at: mount.env.clock.now() };
    await writeTaskResult(mount.env.fs, result);
    await patchTaskRecord(mount.env.fs, taskPath, {
      state: "submitted",
      currentResultId: result.id,
      statusDetail: { kind: "failed", error: "stale pre-publish return" },
      updatedAt: mount.env.clock.now(),
    });
    const sessionsBefore = (await svc.runtime.registry.list()).map((row) => row.id).sort();

    await invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "ACCEPTED_DELIVERED_RECOVERY",
    });

    const repaired = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(repaired.state, "accepted");
    assert.equal(repaired.currentResultId, result.id);
    const results = await loadTaskResults(mount.env.fs, { taskId: task.id! });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0]!.commits, [historicalCommit]);
    assert.equal(results[0]!.status, "accepted");
    assert.equal(await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath), undefined);
    assert.deepEqual(
      (await svc.runtime.registry.list()).map((row) => row.id).sort(),
      sessionsBefore,
      "accepted WAL retry must not launch or replay the provider"
    );
  });
});

test("managed auto-phase WAL retry converges without another provider seal or stop", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-auto-wal-no-reseal");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "auto-accept"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskRecord(mount.env.fs, taskPath);
    const result = await createTaskResult(mount.env.fs, mount.env.clock, {
      taskId: task.id!,
      resultsDir: task.assigneeRoleId
        ? `temp/roles/${task.assigneeRoleId}/results`
        : `temp/sessions/${task.executionSessionId}/results`,
      report: "AUTO_WAL_NO_RESEAL",
      status: "ready",
      integrationMode: "auto-accept",
    });
    await patchTaskRecord(mount.env.fs, taskPath, {
      state: "submitted",
      currentResultId: result.id,
      updatedAt: mount.env.clock.now(),
    });
    await svc.ctx.managedTaskResultReportDrafts.preserve({
      workspaceId,
      taskPath,
      taskId: task.id,
      sessionId,
      assistantText: result.report,
    });

    const originalStop = svc.ctx.runtime.stopSession.bind(svc.ctx.runtime);
    let additionalStops = 0;
    svc.ctx.runtime.stopSession = async (...args) => {
      additionalStops += 1;
      return originalStop(...args);
    };
    try {
      await invokeManagedAutoSubmitForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId,
        assistantText: "",
      });
    } finally {
      svc.ctx.runtime.stopSession = originalStop;
    }
    assert.equal(additionalStops, 0);
    const recovered = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(recovered.state, "accepted");
    assert.equal(recovered.currentResultId, result.id);
    assert.equal(await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath), undefined);
  });
});

test("recovered Result from a retired Session cannot clear or converge after rebind", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-recovered-rebind-race");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskRecord(mount.env.fs, taskPath);
    const result = await createTaskResult(mount.env.fs, mount.env.clock, {
      taskId: task.id!,
      resultsDir: task.assigneeRoleId
        ? `temp/roles/${task.assigneeRoleId}/results`
        : `temp/sessions/${task.executionSessionId}/results`,
      report: "RETIRED_SESSION_RECOVERY",
      status: "ready",
    });
    await patchTaskRecord(mount.env.fs, taskPath, {
      state: "submitted",
      currentResultId: result.id,
      updatedAt: mount.env.clock.now(),
    });
    let entered!: () => void;
    let release!: () => void;
    const ownerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const ownerHold = new Promise<void>((resolve) => { release = resolve; });
    const blocker = runTaskLifecycle(workspaceId, taskPath, async () => {
      entered();
      await ownerHold;
    });
    await ownerEntered;
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type !== "task.state") return;
      const payload = event.payload as Record<string, unknown>;
      if (payload.reason !== "watch") events.push(payload);
    });
    const completing = invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: result.report,
    });
    await pollUntil(async () =>
      (await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath)) ? true : null,
    5_000, "old Session completion preserves draft before Task flight");
    await patchTaskRecord(mount.env.fs, taskPath, {
      executionSessionId: "ss-rebound",
      updatedAt: mount.env.clock.now(),
    });
    release();
    try {
      await Promise.all([blocker, completing]);
    } finally {
      unsubscribe();
    }
    const rebound = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(rebound.executionSessionId, "ss-rebound");
    assert.equal(rebound.state, "submitted");
    assert.equal(rebound.currentResultId, result.id);
    assert.equal(
      (await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath))?.assistantText,
      result.report
    );
    assert.equal(events.length, 0, "retired Session completion must not project Task state");
  });
});

test("managed WAL recovery keeps the durable draft when the retry report mismatches", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-candidate-mismatch");
  await initGitOnWorkspace(ws);
  await withService(async (svc, dataDir) => {
    const { workspaceId, nodeId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskRecord(mount.env.fs, taskPath);
    await svc.ctx.managedTaskResultReportDrafts.preserve({
      workspaceId,
      taskPath,
      taskId: task.id!,
      sessionId,
      assistantText: "PERSISTED_REPORT",
    });
    await createTaskResult(mount.env.fs, mount.env.clock, {
      taskId: task.id!,
      resultsDir: task.assigneeRoleId
        ? `temp/roles/${task.assigneeRoleId}/results`
        : `temp/sessions/${task.executionSessionId}/results`,
      report: "PERSISTED_REPORT",
      status: "ready",
    });
    const draftFile = path.join(dataDir, "managed-result-report-drafts.json");
    const draftRaw = await fs.readFile(draftFile, "utf8");
    const taskRaw = await mount.env.fs.readFile(taskPath);

    await invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "DIFFERENT_RETRY_REPORT",
    });

    const retained = await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath);
    assert.equal(retained?.assistantText, "PERSISTED_REPORT");
    assert.equal(await fs.readFile(draftFile, "utf8"), draftRaw);
    assert.equal(await mount.env.fs.readFile(taskPath), taskRaw);
    const results = await loadTaskResults(mount.env.fs, { taskId: task.id! });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.status, "ready");
    assert.equal((await loadTaskRecord(mount.env.fs, taskPath)).state, "running");
  });
});

for (const operation of ["task.sendInput", "task.startSession", "task.replaceSession"] as const) {
  test(`${operation} ignores unrelated ready Result inventory`, async () => {
    resetManagedAutoSubmitFlightsForTests();
    const ws = await makeWorkspace(`mrd-composite-${operation}`);
    await initGitOnWorkspace(ws);
    await withService(async (svc) => {
      const { workspaceId, nodeId, taskPath, sessionId } = await setupManagedTask(
        svc,
        ws,
        "review-required"
      );
      const mount = svc.ctx.host.require(workspaceId);
      const task = await loadTaskRecord(mount.env.fs, taskPath);
      const committed = await createTaskResult(mount.env.fs, mount.env.clock, {
        taskId: task.id!,
        resultsDir: task.assigneeRoleId
          ? `temp/roles/${task.assigneeRoleId}/results`
          : `temp/sessions/${task.executionSessionId}/results`,
        report: `COMPOSITE_${operation}`,
        status: "ready",
      });
      const sessionsBefore = (await svc.runtime.registry.list()).map((row) => row.id).sort();
      const inputCountBefore = (
        await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)
      ).length;
      const priorProbe = await svc.runtime.probe(sessionId);
      assert.equal(priorProbe.isAlive, true);

      const result = operation === "task.sendInput"
        ? await rpc(svc, operation, { workspaceId, taskPath, text: "MUST_NOT_PERSIST" })
        : await rpc(svc, operation, { workspaceId, taskPath, callerKind: "user" });
      assert.ok(!result.error, JSON.stringify(result.error));

      const current = await loadTaskRecord(mount.env.fs, taskPath);
      assert.equal(current.state, "running");
      assert.equal(current.currentResultId, undefined);
      if (operation === "task.sendInput") {
        assert.equal(
          (await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)).length,
          inputCountBefore + 1
        );
      }
      assert.equal((await loadTaskResults(mount.env.fs, { taskId: task.id! })).length, 1);
      assert.equal(
        (await loadTaskResults(mount.env.fs, { taskId: task.id! }))[0]!.id,
        committed.id
      );
    });
  });
}

for (const operation of ["task.startSession", "task.replaceSession"] as const) {
  test(`${operation} does not treat an unrelated Result created during provider start as publication`, async () => {
    resetManagedAutoSubmitFlightsForTests();
    const ws = await makeWorkspace(`mrd-provider-race-${operation}`);
    await initGitOnWorkspace(ws);
    await withService(async (svc) => {
      const { workspaceId, nodeId, taskPath, sessionId } = await setupManagedTask(
        svc,
        ws,
        "review-required"
      );
      const mount = svc.ctx.host.require(workspaceId);
      const ownerTask = await loadTaskRecord(mount.env.fs, taskPath);
      const ownerTaskResultsDir = ownerTask.assigneeRoleId
        ? `temp/roles/${ownerTask.assigneeRoleId}/results`
        : `temp/sessions/${ownerTask.executionSessionId}/results`;
      if (operation === "task.startSession") {
        await svc.runtime.stopSession(sessionId, "user");
        await svc.runtime.registry.update(sessionId, {
          state: "reserved",
          pid: undefined,
          resumeToken: undefined,
          lastError: undefined,
        });
        await patchTaskRecord(mount.env.fs, taskPath, {
          state: "running",
          wait: null,
          updatedAt: mount.env.clock.now(),
        });
        assert.equal((await svc.runtime.probe(sessionId)).isAlive, false);
      }

      let startedSessionId = "";
      let committedId = "";
      setAfterManagedSessionProviderStartForTests(async (hook) => {
        if (hook.operation !== operation) return;
        startedSessionId = hook.sessionId;
        const current = await loadTaskRecord(mount.env.fs, taskPath);
        const committed = await createTaskResult(mount.env.fs, mount.env.clock, {
          taskId: current.id!,
          resultsDir: ownerTaskResultsDir,
          report: `PROVIDER_RACE_${operation}`,
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
        assert.ok(!result.error, JSON.stringify(result.error));
      } finally {
        setAfterManagedSessionProviderStartForTests(null);
      }

      assert.ok(startedSessionId, "test hook must observe the newly started child");
      const repaired = await loadTaskRecord(mount.env.fs, taskPath);
      assert.equal(repaired.state, "running");
      assert.equal(repaired.currentResultId, undefined);
      assert.equal(
        (await svc.runtime.probe(startedSessionId)).isAlive,
        true,
        "unrelated Result inventory must not stop the current provider child"
      );
      const results = await loadTaskResults(mount.env.fs, { taskId: repaired.id! });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.id, committedId);
    });
  });
}

test("managed blocked report preserves full body and stale draft retry cannot re-park a resumed turn", async () => {
  resetManagedAutoSubmitFlightsForTests();
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

    await invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: control,
      commits: [],
    });
    const parked = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(parked.state, "waiting");
    assert.ok((parked.wait?.summary.length ?? 0) <= 2_000);
    assert.equal(parked.statusDetail?.kind, "blocked");
    assert.equal(parked.statusDetail?.report, fullBody);
    assert.equal(
      await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath),
      undefined,
      "Task statusDetail replaces the duplicate draft only after the park commits"
    );

    const resumed = await rpc(svc, "task.resume", { workspaceId, taskPath });
    assert.ok(!resumed.error, JSON.stringify(resumed.error));
    assert.equal(
      (await loadTaskRecord(mount.env.fs, taskPath)).state,
      "running",
      "resume does not replay a control return"
    );

    await invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "NEW_RESUMED_REPORT",
      commits: [],
    });
    const delivered = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(delivered.state, "submitted");
    const results = await loadTaskResults(mount.env.fs, { taskId: delivered.id! });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.report, "NEW_RESUMED_REPORT");
    assert.equal(delivered.statusDetail, undefined);
    assert.equal(await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath), undefined);
  });
});

test("oversized blocked report keeps its draft and records a bounded failed return", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-control-oversized");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const control = `outcome: blocked\n\n${"中".repeat(22_000)}`;
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type === "session.state") events.push(event.payload as Record<string, unknown>);
    });
    try {
      await invokeManagedAutoSubmitForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId,
        assistantText: control,
        commits: [],
      });
    } finally {
      unsubscribe();
    }

    const task = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(task.state, "running");
    assert.equal(task.statusDetail?.kind, "failed");
    assert.equal(task.statusDetail?.code, "MANAGED_RETURN_INVALID");
    assert.match(task.statusDetail?.error ?? "", /exceeds 65536 UTF-8 bytes/);
    assert.equal(
      (await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath))?.assistantText,
      control
    );
    assert.ok(events.some((event) => event.runtimeEvent === "session.prompt_complete.outcome"));
    assert.match((await svc.runtime.registry.read(sessionId))?.lastError ?? "", /managed outcome=blocked/);
  });
});

test("blocked return remains visible when duplicate draft cleanup fails", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-control-clear-failure");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type === "session.state") events.push(event.payload as Record<string, unknown>);
    });
    const store = svc.ctx.managedTaskResultReportDrafts;
    const originalClear = store.clear.bind(store);
    store.clear = async () => {
      throw new Error("injected draft cleanup failure");
    };
    try {
      await invokeManagedAutoSubmitForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId,
        assistantText: "outcome: blocked\n\nNeed a decision",
        commits: [],
      });
    } finally {
      store.clear = originalClear;
      unsubscribe();
    }

    const task = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(task.state, "waiting");
    assert.equal(task.statusDetail?.kind, "blocked");
    assert.equal(task.statusDetail?.report, "Need a decision");
    assert.ok(await store.get(workspaceId, taskPath), "failed cleanup retains the duplicate draft");
    assert.ok(events.some((event) => event.runtimeEvent === "session.prompt_complete.outcome"));
    assert.match((await svc.runtime.registry.read(sessionId))?.lastError ?? "", /managed outcome=blocked/);
  });
});

test("stale managed control completion cannot park a rebound Task", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-control-rebind-race");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    let releaseFlight!: () => void;
    let flightEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      flightEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFlight = resolve;
    });
    const holding = runTaskLifecycle(workspaceId, taskPath, async () => {
      flightEntered();
      await release;
    });
    await entered;

    const taskEvents: Array<Record<string, unknown>> = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type === "task.state") taskEvents.push(event.payload as Record<string, unknown>);
    });
    const completing = invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "outcome: blocked\n\nretired completion",
      commits: [],
    });
    try {
      let preserved = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath)) {
          preserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(preserved, true, "completion must reach its durable draft before rebind");
      await patchTaskRecord(mount.env.fs, taskPath, {
        executionSessionId: "ss-rebound",
        updatedAt: mount.env.clock.now(),
      });
    } finally {
      releaseFlight();
      await holding;
    }
    await completing;
    unsubscribe();

    const after = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(after.state, "running");
    assert.equal(after.executionSessionId, "ss-rebound");
    assert.equal(after.statusDetail, undefined);
    assert.equal(taskEvents.length, 0, "stale completion emits no Task invalidation");
    assert.ok(await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath));
  });
});

test("stale provider completion skips publish without cancelling current TaskInput", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-delivered-rebind-skip");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskRecord(mount.env.fs, taskPath);
    let releaseFlight!: () => void;
    let flightEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      flightEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFlight = resolve;
    });
    const holding = runTaskLifecycle(workspaceId, taskPath, async () => {
      flightEntered();
      await release;
    });
    await entered;

    const completing = invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "completed report",
      commits: [],
    });
    try {
      let preserved = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath)) {
          preserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(preserved, true);
      await patchTaskRecord(mount.env.fs, taskPath, {
        executionSessionId: "ss-current",
        updatedAt: mount.env.clock.now(),
      });
      await svc.ctx.taskInputs.add({
        id: "ti-current",
        workspaceId,
        taskPath,
        taskId: task.id,
        sessionId: "ss-current",
        kind: "user-input",
        text: "current input must survive stale completion",
        status: "pending",
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
      });
    } finally {
      releaseFlight();
      await holding;
    }
    await completing;

    const after = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(after.state, "running");
    assert.equal(after.executionSessionId, "ss-current");
    assert.equal((await loadTaskResults(mount.env.fs)).length, 0);
    const inputs = await svc.ctx.taskInputs.listForTask(workspaceId, taskPath);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.id, "ti-current");
    assert.equal(inputs[0]?.status, "pending");
  });
});

for (const timing of ["skewed-visible", "equal-new-draft"] as const) {
  test(`terminal draft precedence ignores diagnostic statusDetail.at (${timing})`, async () => {
    resetManagedAutoSubmitFlightsForTests();
    const ws = await makeWorkspace(`mrd-terminal-at-${timing}`);
    await initGitOnWorkspace(ws);
    await withService(async (svc) => {
      const { workspaceId, taskPath, sessionId } = await setupManagedTask(
        svc,
        ws,
        "review-required"
      );
      const mount = svc.ctx.host.require(workspaceId);
      const store = svc.ctx.managedTaskResultReportDrafts;

      if (timing === "skewed-visible") {
        const originalClear = store.clear.bind(store);
        store.clear = async () => {
          throw new Error("retain exact control draft");
        };
        try {
          await invokeManagedAutoSubmitForTests(svc.ctx, {
            workspaceId,
            taskPath,
            sessionId,
            assistantText: "outcome: blocked\n\nVisible blocked fact",
            commits: [],
          });
        } finally {
          store.clear = originalClear;
        }
        const visible = await loadTaskRecord(mount.env.fs, taskPath);
        assert.equal(visible.statusDetail?.report, "Visible blocked fact");
        await patchTaskRecord(mount.env.fs, taskPath, {
          statusDetail: {
            ...visible.statusDetail!,
            at: "2000-01-01T00:00:00.000Z",
          },
        });
      } else {
        const task = await loadTaskRecord(mount.env.fs, taskPath);
        const draft = await store.preserve({
          workspaceId,
          taskPath,
          taskId: task.id!,
          sessionId,
          assistantText: "new draft wins by lifecycle order",
        });
        await patchTaskRecord(mount.env.fs, taskPath, {
          statusDetail: {
            kind: "failed",
            error: "older visible return",
            at: draft.updatedAt,
            executionSessionId: sessionId,
          },
        });
      }

      const interrupted = await rpc(svc, "task.interrupt", { workspaceId, taskPath });
      assert.ok(!interrupted.error, JSON.stringify(interrupted.error));
      const terminal = await loadTaskRecord(mount.env.fs, taskPath);
      assert.equal(terminal.state, "interrupted");
      if (timing === "skewed-visible") {
        assert.equal(terminal.statusDetail?.kind, "blocked");
        assert.equal(terminal.statusDetail?.report, "Visible blocked fact");
      } else {
        assert.equal(terminal.statusDetail?.kind, "failed");
        assert.equal(terminal.statusDetail?.report, "new draft wins by lifecycle order");
        assert.equal(terminal.statusDetail?.code, "TASK_TERMINATED_WITH_DRAFT");
      }
      assert.equal(await store.get(workspaceId, taskPath), undefined);
    });
  });
}

for (const oversized of [false, true] as const) {
  test(`task.interrupt promotes ${oversized ? "oversized" : "bounded"} draft before terminal cleanup`, async () => {
    resetManagedAutoSubmitFlightsForTests();
    const ws = await makeWorkspace(`mrd-interrupt-draft-${oversized}`);
    await initGitOnWorkspace(ws);
    await withService(async (svc) => {
      const { workspaceId, taskPath, sessionId } = await setupManagedTask(
        svc,
        ws,
        "review-required"
      );
      const mount = svc.ctx.host.require(workspaceId);
      const task = await loadTaskRecord(mount.env.fs, taskPath);
      const report = oversized ? "中".repeat(22_000) : "formal return before interrupt";
      await svc.ctx.managedTaskResultReportDrafts.preserve({
        workspaceId,
        taskPath,
        taskId: task.id!,
        sessionId,
        assistantText: report,
      });

      const interrupted = await rpc(svc, "task.interrupt", { workspaceId, taskPath });
      assert.ok(!interrupted.error, JSON.stringify(interrupted.error));
      const terminal = await loadTaskRecord(mount.env.fs, taskPath);
      assert.equal(terminal.state, "interrupted");
      assert.equal(
        terminal.statusDetail?.code,
        oversized ? "TASK_TERMINATED_DRAFT_OVERSIZE" : "TASK_TERMINATED_WITH_DRAFT"
      );
      assert.equal(terminal.statusDetail?.report, oversized ? undefined : report);
      assert.equal(terminal.statusDetail?.executionSessionId, sessionId);
      assert.equal(await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath), undefined);
    });
  });
}

test("task.interrupt remains successful when terminal draft cleanup fails", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-interrupt-clear-failure");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskRecord(mount.env.fs, taskPath);
    await svc.ctx.managedTaskResultReportDrafts.preserve({
      workspaceId,
      taskPath,
      taskId: task.id!,
      sessionId,
      assistantText: "draft survives cleanup failure",
    });
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type === "task.state") events.push(event.payload as Record<string, unknown>);
    });
    const store = svc.ctx.managedTaskResultReportDrafts;
    const originalClear = store.clear.bind(store);
    store.clear = async () => {
      throw new Error("injected terminal cleanup failure");
    };
    let interrupted;
    try {
      interrupted = await rpc(svc, "task.interrupt", { workspaceId, taskPath });
    } finally {
      store.clear = originalClear;
      unsubscribe();
    }
    assert.ok(!interrupted!.error, JSON.stringify(interrupted!.error));
    const terminal = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(terminal.state, "interrupted");
    assert.equal(terminal.statusDetail?.report, "draft survives cleanup failure");
    assert.ok(await store.get(workspaceId, taskPath));
    assert.ok(events.some((event) => event.reason === "task.interrupt"));
  });
});

test("task.interrupt emits and clears its draft before auxiliary cleanup failures", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-interrupt-aux-cleanup-failure");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskRecord(mount.env.fs, taskPath);
    await svc.ctx.managedTaskResultReportDrafts.preserve({
      workspaceId,
      taskPath,
      taskId: task.id!,
      sessionId,
      assistantText: "visible before auxiliary cleanup",
    });
    const taskEvents: Array<Record<string, unknown>> = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type === "task.state") taskEvents.push(event.payload as Record<string, unknown>);
    });
    const inputs = svc.ctx.taskInputs;
    const decisions = svc.ctx.decisionRequests;
    const originalCancelTask = inputs.cancelTask.bind(inputs);
    const originalRemoveDecision = decisions.removePendingForTask.bind(decisions);
    inputs.cancelTask = async () => {
      throw new Error("injected TaskInput cleanup failure");
    };
    decisions.removePendingForTask = async () => {
      throw new Error("injected Decision cleanup failure");
    };
    let interrupted;
    try {
      interrupted = await rpc(svc, "task.interrupt", { workspaceId, taskPath });
    } finally {
      inputs.cancelTask = originalCancelTask;
      decisions.removePendingForTask = originalRemoveDecision;
      unsubscribe();
    }

    assert.ok(!interrupted!.error, JSON.stringify(interrupted!.error));
    const terminal = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(terminal.state, "interrupted");
    assert.equal(terminal.statusDetail?.report, "visible before auxiliary cleanup");
    assert.equal(await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath), undefined);
    assert.ok(taskEvents.some((event) => event.reason === "task.interrupt"));
  });
});

test("task.interrupt ignores a retired-Session draft and clears it after terminalizing", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-interrupt-retired-session");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId } = await setupManagedTask(
      svc,
      ws,
      "review-required"
    );
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskRecord(mount.env.fs, taskPath);
    await svc.ctx.managedTaskResultReportDrafts.preserve({
      workspaceId,
      taskPath,
      taskId: task.id!,
      sessionId,
      assistantText: "retired Session draft",
    });
    await patchTaskRecord(mount.env.fs, taskPath, {
      executionSessionId: "ss-rebound",
      updatedAt: mount.env.clock.now(),
    });

    const interrupted = await rpc(svc, "task.interrupt", { workspaceId, taskPath });
    assert.ok(!interrupted.error, JSON.stringify(interrupted.error));
    const terminal = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(terminal.state, "interrupted");
    assert.equal(terminal.statusDetail, undefined);
    assert.equal(await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath), undefined);
  });
});

for (const cleanupFails of [false, true] as const) {
  test(`task.cancel removes queued stale draft${cleanupFails ? " even when cleanup fails" : ""}`, async () => {
    const ws = await makeWorkspace(`mrd-cancel-draft-${cleanupFails}`);
    await initGitOnWorkspace(ws);
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const listed = await rpc(svc, "registry.roles", { workspaceId });
      assert.ok(!listed.error, JSON.stringify(listed.error));
      const roleId = (listed.result as {
        roles: Array<{ roleId: string; name: string }>;
      }).roles.find((role) => role.name === "executor")?.roleId;
      assert.ok(roleId);
      const dispatched = await rpc(svc, "task.dispatch", {
        requester: { kind: "user", id: "user" },
        workspaceId,
        nodeIds: [nodeId],
        assigneeRoleId: roleId,
        prompt: "queued stale draft cleanup",
      });
      assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
      const taskPath = (dispatched.result as { taskPath: string }).taskPath;
      const mount = svc.ctx.host.require(workspaceId);
      const task = await loadTaskRecord(mount.env.fs, taskPath);
      await svc.ctx.managedTaskResultReportDrafts.preserve({
        workspaceId,
        taskPath,
        taskId: task.id!,
        sessionId: "ss-stale",
        assistantText: "impossible queued draft",
      });
      const store = svc.ctx.managedTaskResultReportDrafts;
      const originalClear = store.clear.bind(store);
      if (cleanupFails) {
        store.clear = async () => {
          throw new Error("injected cancel cleanup failure");
        };
      }
      let cancelled;
      try {
        cancelled = await rpc(svc, "task.cancel", { workspaceId, taskPath });
      } finally {
        store.clear = originalClear;
      }
      assert.ok(!cancelled!.error, JSON.stringify(cancelled!.error));
      assert.equal(await mount.env.fs.exists(taskPath), false);
      assert.equal(Boolean(await store.get(workspaceId, taskPath)), cleanupFails);
    });
  });
}

test("managed control draft from retired Session is superseded by current replacement report", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-control-replace");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, taskPath, sessionId: priorSessionId } =
      await setupManagedTask(svc, ws, "review-required");
    const mount = svc.ctx.host.require(workspaceId);
    const control = "outcome: blocked\n\nOLD_SESSION_CONTROL";
    await invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId: priorSessionId,
      assistantText: control,
      commits: [],
    });
    assert.equal((await loadTaskRecord(mount.env.fs, taskPath)).state, "waiting");

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

    await invokeManagedAutoSubmitForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId: replacementSessionId,
      assistantText: "REPLACEMENT_SESSION_REPORT",
      commits: [],
    });
    const delivered = await loadTaskRecord(mount.env.fs, taskPath);
    assert.equal(delivered.state, "submitted");
    const results = await loadTaskResults(mount.env.fs, { taskId: delivered.id! });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.report, "REPLACEMENT_SESSION_REPORT");
    assert.equal(await svc.ctx.managedTaskResultReportDrafts.get(workspaceId, taskPath), undefined);
  });
});

test("terminal reject feedback permits replacement; uncertain requires ack first", async () => {
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-reject-terminal-session");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId, taskPath, sessionId: priorSessionId } =
      await setupManagedTask(svc, ws, "review-required");
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskRecord(mount.env.fs, taskPath);
    const result = await createTaskResult(mount.env.fs, mount.env.clock, {
      taskId: task.id!,
      resultsDir: task.assigneeRoleId
        ? `temp/roles/${task.assigneeRoleId}/results`
        : `temp/sessions/${task.executionSessionId}/results`,
      report: "REJECT_TERMINAL_SESSION",
      status: "ready",
    });
    result.status = "rejected";
    result.review = { reviewer: "user", at: mount.env.clock.now(), note: "REVIEW_TERMINAL" };
    await writeTaskResult(mount.env.fs, result);
    await patchTaskRecord(mount.env.fs, taskPath, {
      state: "running",
      currentResultId: result.id,
      updatedAt: mount.env.clock.now(),
    });
    const reviewId = `ti-rf-${result.id.slice(3)}`;
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
      (await loadTaskRecord(mount.env.fs, taskPath)).executionSessionId,
      priorSessionId,
      "uncertain continuation must block before replacement side effects"
    );
    assert.equal((await svc.runtime.probe(priorSessionId)).isAlive, true);

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
  resetManagedAutoSubmitFlightsForTests();
  const ws = await makeWorkspace("mrd-reject-delivered-session");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId, taskPath, sessionId: priorSessionId } =
      await setupManagedTask(svc, ws, "review-required");
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskRecord(mount.env.fs, taskPath);
    const result = await createTaskResult(mount.env.fs, mount.env.clock, {
      taskId: task.id!,
      resultsDir: task.assigneeRoleId
        ? `temp/roles/${task.assigneeRoleId}/results`
        : `temp/sessions/${task.executionSessionId}/results`,
      report: "REJECT_DELIVERED_SESSION",
      status: "ready",
    });
    result.status = "rejected";
    result.review = { reviewer: "user", at: mount.env.clock.now(), note: "REVIEW_DELIVERED" };
    await writeTaskResult(mount.env.fs, result);
    await patchTaskRecord(mount.env.fs, taskPath, {
      state: "running",
      currentResultId: result.id,
      updatedAt: mount.env.clock.now(),
    });
    const reviewId = `ti-rf-${result.id.slice(3)}`;
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
    resetManagedAutoSubmitFlightsForTests();
    const ws = await makeWorkspace(`mrd-reject-feedback-${operation}`);
    await initGitOnWorkspace(ws);
    await withService(async (svc) => {
      const { workspaceId, nodeId, taskPath } = await setupManagedTask(
        svc,
        ws,
        "review-required"
      );
      const mount = svc.ctx.host.require(workspaceId);
      const task = await loadTaskRecord(mount.env.fs, taskPath);
      const result = await createTaskResult(mount.env.fs, mount.env.clock, {
        taskId: task.id!,
        resultsDir: task.assigneeRoleId
          ? `temp/roles/${task.assigneeRoleId}/results`
          : `temp/sessions/${task.executionSessionId}/results`,
        report: "REJECT_RESUME_FEEDBACK_ORDER",
        status: "ready",
      });
      result.status = "rejected";
      result.review = {
        reviewer: "user",
        at: mount.env.clock.now(),
        note: "REVIEW_FIRST",
      };
      await writeTaskResult(mount.env.fs, result);
      await patchTaskRecord(mount.env.fs, taskPath, {
        state: "running",
        currentResultId: result.id,
        updatedAt: mount.env.clock.now(),
      });
      const common = {
        workspaceId,
        taskPath,
        taskId: task.id,
        sessionId: task.executionSessionId,
        status: "pending" as const,
      };
      const review = await svc.ctx.taskInputs.add({
        ...common,
        id: `ti-rf-${result.id.slice(3)}`,
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
