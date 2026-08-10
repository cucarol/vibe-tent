/**
 * Focused tests for task.replaceSession: eligibility, flight, success, failure,
 * atomic rebind, late events, and held pre-replace managed-input race.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MUTATION_LOCK_PATH } from "../src/core/paths.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS, RPC_LIFECYCLE } from "../src/service/types.js";
import {
  holdManagedTaskInputQueueForTests,
  isManagedSessionInFlightForTests,
  mapRuntimeEventToService,
  REPLACE_SESSION_RESTORE_REASON,
  resetManagedAutoDeliverDedupForTests,
  resetManagedTaskInputQueueForTests,
  setBeforeReplaceTaskInputRollbackForTests,
  SESSION_UNAVAILABLE_WAIT_CODE,
  SESSION_UNAVAILABLE_WAIT_SUMMARY,
} from "../src/service/handlers.js";
import { DEFAULT_GROK_MODEL, GROK_ACP_ADAPTER_ID } from "../src/adapters/grok-acp/index.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { configureTestGitIdentity, git } from "./helpers.js";

const MOCK_ACP = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-acp-server.mjs");
type Svc = Awaited<ReturnType<typeof startLocalTentService>>;
type TaskSnap = {
  id?: string; state: string; sessionId?: string;
  workNodeIds?: string[]; contextNodeIds?: string[];
  contextCard?: {
    workNodeIds: string[];
    contextNodeIds: string[];
    nodeSnapshots: Array<{ id: string }>;
  };
  worktree?: string; branch?: string; acceptMode?: string;
  wait?: { reason?: string; summary?: string; code?: string } | null;
};
const FAKE_KEEPALIVE = { connectionId: "fake-default", provider: "fake", adapterId: FAKE_ADAPTER_ID, fake: { waitForSignal: true, sleepMs: 60_000 } } as const;
const FAKE_FAIL_LAUNCH = {
  connectionId: "fake-fail-launch", provider: "fake", adapterId: FAKE_ADAPTER_ID,
  fake: { failLaunch: "replace-session test: intentional launch failure" },
} as const;

function mockAcpRoute(id: string, opts: { logPath: string; promptDelayMs?: number }) {
  const childEnv = {
    CPA_GROK_API_KEY: "test-key-not-real",
    MOCK_ACP_LOG: opts.logPath,
    MOCK_ACP_KEEP_ALIVE: "1",
    MOCK_ACP_PROMPT_TEXT: "REPLACE_SESSION_REPORT",
    ...(opts.promptDelayMs != null ? { MOCK_ACP_PROMPT_DELAY_MS: String(opts.promptDelayMs) } : {}),
  };
  const childBootstrap = `Object.assign(process.env, ${JSON.stringify(childEnv)}); await import(${JSON.stringify(pathToFileURL(MOCK_ACP).href)});`;
  return {
    connectionId: id, provider: "test", adapterId: GROK_ACP_ADAPTER_ID, command: process.execPath,
    args: ["--input-type=module", "--eval", childBootstrap],
    model: DEFAULT_GROK_MODEL, envKey: "CPA_GROK_API_KEY", permissionPolicy: "deny" as const,
    promptTimeoutMs: Math.max(8_000, (opts.promptDelayMs ?? 0) + 4_000), permissionTimeoutMs: 500,
  };
}

async function pollUntil<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 20_000, label = "condition"): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function makeWorkspace(name = "replace-session"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-replace-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, { name, nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }] });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [{ id: "rl-executor", name: "executor", prompt: "execute" }] }, null, 2) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Svc) => Promise<T>,
  opts?: { connections?: import("../src/runtime/types.js").AgentConnectionConfig[] }
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-replace-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    connections: opts?.connections ?? [FAKE_KEEPALIVE],
  });
  try { return await fn(svc); } finally { await svc.stop(); }
}

function rpc(svc: Svc, method: string, params?: Record<string, unknown>) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}
function errCode(res: { error?: { data?: unknown } }) {
  return (res.error?.data as { code?: string } | undefined)?.code;
}

async function mountWorkItem(svc: Svc, ws: string) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
  const created = await rpc(svc, "docs.createNote", { workspaceId, name: "work-item", type: "prompt" });
  assert.ok(!created.error, JSON.stringify(created.error));
  return { workspaceId, nodeId: (created.result as { nodeId: string }).nodeId };
}

async function dispatchClaimStart(svc: Svc, workspaceId: string, nodeId: string, opts?: { connectionId?: string }) {
  const connectionId = opts?.connectionId ?? "fake-default";
  const d = await rpc(svc, "task.dispatch", {
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    workspaceId, workNodeIds: [nodeId], contextNodeIds: [], connectionId, prompt: "replace-session fixture", acceptMode: "review-required",
  });
  assert.ok(!d.error, JSON.stringify(d.error));
  const taskPath = (d.result as { taskPath: string }).taskPath;
  if ((d.result as { state?: string }).state === "queued") await rpc(svc, "task.claim", { workspaceId, taskPath });
  const before = await rpc(svc, "task.get", { workspaceId, taskPath });
  const taskBefore = (before.result as { task: { sessionId?: string } }).task;
  if (!taskBefore.sessionId) {
    const started = await rpc(svc, "task.startSession", { workspaceId, taskPath, callerKind: "user" });
    assert.ok(!started.error, JSON.stringify(started.error));
    return { taskPath, sessionId: (started.result as { session: { sessionId: string } }).session.sessionId };
  }
  return { taskPath, sessionId: taskBefore.sessionId! };
}

async function getTask(svc: Svc, workspaceId: string, taskPath: string): Promise<TaskSnap> {
  const got = await rpc(svc, "task.get", { workspaceId, taskPath });
  assert.ok(!got.error, JSON.stringify(got.error));
  return (got.result as { task: TaskSnap }).task;
}
async function getInput(svc: Svc, workspaceId: string, taskPath: string, inputId: string) {
  const got = await rpc(svc, "taskInput.get", { workspaceId, taskPath, inputId });
  assert.ok(!got.error, JSON.stringify(got.error));
  return (got.result as { input: { status: string; sessionId?: string } }).input;
}
function assertParkedOnSession(task: TaskSnap, sessionId: string) {
  assert.equal(task.state, "waiting");
  assert.equal(task.wait?.reason, "external");
  assert.equal(task.wait?.code, SESSION_UNAVAILABLE_WAIT_CODE);
  assert.equal(task.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);
  assert.equal(task.sessionId, sessionId);
}
async function seedPending(svc: Svc, workspaceId: string, taskPath: string, sessionId: string, id: string, text: string) {
  const now = new Date().toISOString();
  return svc.ctx.taskInputs.add({ id, workspaceId, taskPath, sessionId, status: "pending", text, createdAt: now, updatedAt: now });
}

test("CLIENT_METHODS includes task.replaceSession", () => {
  assert.ok((CLIENT_METHODS as readonly string[]).includes("task.replaceSession"));
  assert.equal(REPLACE_SESSION_RESTORE_REASON, "task.replaceSession.fresh");
});

test("start/replace reject caller-supplied connectionId and unknown fields without mutation", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const dispatched = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "strict start and replace params",
      acceptMode: "review-required",
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    const reservedSessionId = (await getTask(svc, workspaceId, taskPath)).sessionId;
    assert.match(reservedSessionId ?? "", /^ss-/);
    const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));

    for (const extra of [
      { connectionId: "fake-default" },
      { unexpectedField: "must-fail-loud" },
    ]) {
      const refused = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        ...extra,
      });
      assert.equal(refused.error?.code, -32602, JSON.stringify(refused));
      assert.equal((await getTask(svc, workspaceId, taskPath)).sessionId, reservedSessionId);
    }

    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;

    for (const extra of [
      { connectionId: "fake-default" },
      { unexpectedField: "must-fail-loud" },
    ]) {
      const refused = await rpc(svc, "task.replaceSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        ...extra,
      });
      assert.equal(refused.error?.code, -32602, JSON.stringify(refused));
      assert.equal((await getTask(svc, workspaceId, taskPath)).sessionId, sessionId);
      assert.equal((await svc.runtime.probe(sessionId)).alive, true);
    }
  });
});

test("managed start refuses a Role Task; only an exact Connection Task owns a Session", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const dispatched = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId, workNodeIds: [nodeId], contextNodeIds: [], roleId: "rl-executor",
      prompt: "Role Task must never receive a Connection-managed Session", acceptMode: "review-required",
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    const started = await rpc(svc, "task.startSession", {
      workspaceId, taskPath, callerKind: "user",
    });
    assert.ok(started.error);
    assert.equal(started.error!.code, -32602);
    assert.match(String(started.error!.message), /exact bound Session/i);
  });
});

test("Connection dispatch: interrupt wins while provider start is held; late Session is stopped", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const entered = deferred();
    const release = deferred();
    const originalStart = svc.runtime.startSession.bind(svc.runtime);
    (svc.runtime as { startSession: typeof svc.runtime.startSession }).startSession = async (input) => {
      entered.resolve();
      await release.promise;
      return originalStart(input);
    };

    const dispatching = rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "held start race",
      acceptMode: "review-required",
    });
    await Promise.race([
      entered.promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("provider start was not reached")), 10_000)
      ),
    ]);
    const listed = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!listed.error, JSON.stringify(listed.error));
    const rows = (listed.result as { tasks: Array<{ path: string; state: string; sessionId?: string }> }).tasks;
    const held = rows.find((row) => row.state === "running" && row.sessionId);
    assert.ok(held, JSON.stringify(rows));
    const taskPath = held!.path;
    const reservedSessionId = held!.sessionId!;
    const interrupted = await rpc(svc, "task.interrupt", { workspaceId, taskPath });
    assert.ok(!interrupted.error, JSON.stringify(interrupted.error));
    release.resolve();
    const started = await dispatching;
    assert.equal(started.error?.code, RPC_LIFECYCLE, JSON.stringify(started));
    assert.equal(errCode(started), "SESSION_LAUNCH_FAILED");

    const task = await getTask(svc, workspaceId, taskPath);
    assert.equal(task.state, "interrupted");
    assert.equal(task.sessionId, reservedSessionId, "terminal Task keeps its exact stopped Session audit binding");
    const stoppedSessionId = (started.error?.data as { sessionId?: string }).sessionId;
    assert.equal(stoppedSessionId, reservedSessionId);
    assert.equal((await svc.runtime.probe(stoppedSessionId!)).alive, false);
  }, { connections: [FAKE_KEEPALIVE] });
});

test("replaceSession: terminal transition wins while replacement start is held", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(
      svc,
      workspaceId,
      nodeId
    );

    const entered = deferred();
    const release = deferred();
    const originalStart = svc.runtime.startSession.bind(svc.runtime);
    (svc.runtime as { startSession: typeof svc.runtime.startSession }).startSession = async (input) => {
      const handle = await originalStart(input);
      entered.resolve();
      await release.promise;
      return handle;
    };

    const replacing = rpc(svc, "task.replaceSession", {
      workspaceId, taskPath, callerKind: "user",
    });
    await entered.promise;
    const interrupted = await rpc(svc, "task.interrupt", { workspaceId, taskPath });
    assert.ok(!interrupted.error, JSON.stringify(interrupted.error));
    release.resolve();
    const replaced = await replacing;
    assert.equal(replaced.error?.code, RPC_LIFECYCLE, JSON.stringify(replaced));
    assert.equal(errCode(replaced), "TASK_SESSION_BIND_CAS_FAILED", JSON.stringify(replaced));

    const task = await getTask(svc, workspaceId, taskPath);
    assert.equal(task.state, "interrupted");
    assert.notEqual(task.sessionId, priorSessionId);
    const orphanSessionId = (replaced.error?.data as { orphanSessionId?: string }).orphanSessionId;
    assert.ok(orphanSessionId);
    assert.notEqual(orphanSessionId, priorSessionId);
    assert.equal(task.sessionId, orphanSessionId, "terminal Task keeps its exact stopped replacement binding");
    assert.equal((await svc.runtime.probe(orphanSessionId!)).alive, false);
  }, { connections: [FAKE_KEEPALIVE] });
});

test("replaceSession accepts an immediate prompt_complete progression on the prebound Session", async () => {
  const ws = await makeWorkspace("replace-immediate-complete");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(
      svc,
      workspaceId,
      nodeId
    );

    const originalStart = svc.runtime.startSession.bind(svc.runtime);
    (svc.runtime as { startSession: typeof svc.runtime.startSession }).startSession = async (input) => {
      const handle = await originalStart(input);
      await mapRuntimeEventToService(svc.ctx, {
        type: "session.prompt_complete",
        sessionId: handle.sessionId,
        assistantText: "outcome: needs-input\n\nreplacement needs a user answer",
        stopReason: "end_turn",
      });
      return handle;
    };

    const replaced = await rpc(svc, "task.replaceSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(!replaced.error, JSON.stringify(replaced.error));
    const replacementSessionId = (replaced.result as {
      session: { sessionId: string };
    }).session.sessionId;
    assert.notEqual(replacementSessionId, priorSessionId);
    const task = await getTask(svc, workspaceId, taskPath);
    assert.equal(task.sessionId, replacementSessionId);
    assert.equal(task.state, "waiting");
    assert.match(task.wait?.summary ?? "", /needs a user answer/i);
    assert.equal((await svc.runtime.probe(replacementSessionId)).alive, true);
  });
});

test("replaceSession: success preserves Task + contextRestored=false + audit", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, nodeId);
    const before = await getTask(svc, workspaceId, taskPath);
    const rolesPath = path.join(ws, ".tent", "roles.json");
    const rolesBefore = await fs.readFile(rolesPath, "utf8");
    const roleEvents: unknown[] = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type === "registry.roles.updated") roleEvents.push(event.payload);
    });

    const replaced = (await client.taskReplaceSession(workspaceId, {
      taskPath, callerKind: "user",
    })) as {
      task: TaskSnap;
      session: { sessionId: string; contextRestored?: boolean; restoreReason?: string; replacedSessionId?: string };
      priorSessionId: string; replaced: boolean;
    };
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.priorSessionId, priorSessionId);
    assert.notEqual(replaced.session.sessionId, priorSessionId);
    assert.match(replaced.session.sessionId, /^ss-/);
    assert.equal(replaced.session.contextRestored, false);
    assert.equal(replaced.session.restoreReason, REPLACE_SESSION_RESTORE_REASON);
    assert.equal(replaced.session.replacedSessionId, priorSessionId);
    assert.equal(replaced.task.id, before.id);
    assert.equal(replaced.task.state, "running");
    assert.equal(replaced.task.sessionId, replaced.session.sessionId);
    assert.deepEqual(replaced.task.workNodeIds ?? [], before.workNodeIds ?? []);
    assert.deepEqual(replaced.task.contextNodeIds ?? [], before.contextNodeIds ?? []);
    assert.deepEqual(
      replaced.task.contextCard?.nodeSnapshots.map((snapshot) => snapshot.id) ?? [],
      before.contextCard?.nodeSnapshots.map((snapshot) => snapshot.id) ?? []
    );
    assert.equal(replaced.task.worktree, before.worktree);
    assert.equal(replaced.task.branch, before.branch);
    assert.equal(replaced.task.acceptMode, before.acceptMode);
    const newRow = await svc.runtime.registry.read(replaced.session.sessionId);
    assert.equal(newRow?.contextRestored, false);
    assert.equal(newRow?.restoreReason, REPLACE_SESSION_RESTORE_REASON);
    assert.equal(newRow?.replacedSessionId, priorSessionId);
    const oldRow = await svc.runtime.registry.read(priorSessionId);
    assert.ok(oldRow);
    assert.equal(oldRow!.replacedBySessionId, replaced.session.sessionId);
    assert.equal(oldRow!.stopReason, "user");
    assert.ok(oldRow!.state === "stopped" || oldRow!.state === "failed");
    assert.equal(oldRow!.lastTaskId, before.id);
    assert.equal((await svc.runtime.probe(priorSessionId)).alive, false);
    assert.equal((await svc.runtime.probe(replaced.session.sessionId)).alive, true);
    assert.equal(await fs.readFile(rolesPath, "utf8"), rolesBefore);
    assert.equal(roleEvents.length, 0);
    unsubscribe();
  });
});

test("replaceSession: eligibility - turnBusy, waitCode, force refused", async () => {
  resetManagedAutoDeliverDedupForTests();
  {
    const ws = await makeWorkspace();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-replace-busy-"));
    const logPath = path.join(dataDir, "mock-acp-log.json");
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId, workNodeIds: [nodeId], contextNodeIds: [], connectionId: "mock-acp-replace-busy", prompt: "busy replace must fail-loud", acceptMode: "review-required",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId, taskPath, callerKind: "user",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const priorSessionId = (started.result as { session: { sessionId: string } }).session.sessionId;
      await pollUntil(async () => {
        const probe = await rpc(svc, "session.get", { workspaceId, sessionId: priorSessionId });
        if (probe.error) return null;
        const session = (probe.result as { session: { alive?: boolean; turnBusy?: boolean } }).session;
        return session.alive && session.turnBusy === true ? session : null;
      }, 8_000, "managed turnBusy before replace");
      const refused = await rpc(svc, "task.replaceSession", {
        workspaceId, taskPath, callerKind: "user",
      });
      assert.ok(refused.error);
      assert.equal(refused.error!.code, RPC_LIFECYCLE);
      assert.equal(errCode(refused), "TURN_BUSY");
      const force = await rpc(svc, "task.replaceSession", {
        workspaceId, taskPath, callerKind: "user", force: true,
      });
      assert.ok(force.error);
      assert.match(String(force.error!.message ?? ""), /force/i);
    }, { connections: [mockAcpRoute("mock-acp-replace-busy", { logPath, promptDelayMs: 4_000 })] });
  }
  {
    const ws = await makeWorkspace();
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, nodeId);
      await rpc(svc, "task.wait", {
        workspaceId, taskPath, reason: "user-input",
        summary: "awaiting human reply (not session_unavailable)",
      });
      const refused = await rpc(svc, "task.replaceSession", {
        workspaceId, taskPath, callerKind: "user",
      });
      assert.ok(refused.error);
      assert.equal(errCode(refused), "REPLACE_SESSION_WAIT_NOT_ELIGIBLE");
      const task = await getTask(svc, workspaceId, taskPath);
      assert.equal(task.state, "waiting");
      assert.equal(task.sessionId, priorSessionId);
    });
  }
});

test("replaceSession: session_unavailable + late events + atomic rebind; launch/persist failures park", async () => {
  resetManagedAutoDeliverDedupForTests();
  {
    const ws = await makeWorkspace();
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, nodeId);
      mapRuntimeEventToService(svc.ctx, {
        type: "session.failed", sessionId: priorSessionId,
        error: "simulated unusable provider context for replace eligibility",
      });
      await pollUntil(async () => {
        const task = await getTask(svc, workspaceId, taskPath);
        return task.state === "waiting" && task.wait?.code === SESSION_UNAVAILABLE_WAIT_CODE ? task : null;
      }, 5_000, "session_unavailable park");
      const seeded = await seedPending(
        svc, workspaceId, taskPath, priorSessionId, "ti-replace-rebind-seed",
        "please preserve this U2A note across replace"
      );
      svc.runtime.clearFollowUpAttemptsForTests();
      const recoveryHold = holdManagedTaskInputQueueForTests(workspaceId, taskPath);
      try {
        const sessionIdsBeforeReplace = new Set(
          (await svc.runtime.registry.list()).map((session) => session.id)
        );
        let replaced = await rpc(svc, "task.replaceSession", {
          workspaceId, taskPath, callerKind: "user",
        });
        if (errCode(replaced) === "TASK_SESSION_BIND_CAS_FAILED") {
          const data = replaced.error?.data as {
            orphanSessionId?: string;
            expected?: { taskId?: string; sessionId?: string };
            actual?: { taskId?: string; sessionId?: string };
          };
          const orphan = data.orphanSessionId;
          if (orphan) {
            assert.match(orphan, /^ss-/);
            assert.equal((await svc.runtime.probe(orphan)).alive, false);
          } else {
            assert.equal(typeof data.expected?.taskId, "string");
            assert.equal(typeof data.actual?.taskId, "string");
            assert.equal(typeof data.expected?.sessionId, "string");
            assert.equal(typeof data.actual?.sessionId, "string");
            assert.deepEqual(
              (await svc.runtime.registry.list())
                .map((session) => session.id)
                .filter((sessionId) => !sessionIdsBeforeReplace.has(sessionId)),
              []
            );
            const retryableTask = await getTask(svc, workspaceId, taskPath);
            assert.equal(retryableTask.sessionId, priorSessionId);
            assert.ok(
              retryableTask.state === "running" ||
                (retryableTask.state === "waiting" &&
                  retryableTask.wait?.code === SESSION_UNAVAILABLE_WAIT_CODE),
              JSON.stringify(retryableTask)
            );
          }
          replaced = await rpc(svc, "task.replaceSession", {
            workspaceId, taskPath, callerKind: "user",
          });
        }
        assert.ok(!replaced.error, JSON.stringify(replaced.error));
        const newSessionId = (replaced.result as { session: { sessionId: string } }).session.sessionId;
        assert.notEqual(newSessionId, priorSessionId);
        assert.equal((replaced.result as { session: { contextRestored?: boolean } }).session.contextRestored, false);
        assert.equal((replaced.result as { task: TaskSnap }).task.state, "running");
        await recoveryHold.entered;
        const input = await getInput(svc, workspaceId, taskPath, seeded.id);
        assert.equal(input.status, "pending");
        assert.equal(input.sessionId, newSessionId);
        assert.deepEqual(svc.runtime.getFollowUpAttemptsForTests(), []);
        recoveryHold.release();
        await pollUntil(async () => {
          const attempts = svc.runtime.getFollowUpAttemptsForTests();
          return attempts.length === 1 ? attempts[0] : null;
        }, 5_000, "replacement Session recovery inject attempt");
        assert.deepEqual(svc.runtime.getFollowUpAttemptsForTests(), [
          { sessionId: newSessionId },
        ]);
        const settledInput = await pollUntil(async () => {
          const row = await getInput(svc, workspaceId, taskPath, seeded.id);
          return row.status === "failed" || row.status === "delivered" ? row : null;
        }, 5_000, "replacement recovery row settled");
        assert.equal(settledInput.sessionId, newSessionId);
        mapRuntimeEventToService(svc.ctx, { type: "session.failed", sessionId: priorSessionId, error: "late failure after replace" });
        mapRuntimeEventToService(svc.ctx, { type: "session.exited", sessionId: priorSessionId, exitCode: 1 });
        await new Promise((r) => setTimeout(r, 120));
        const task = await getTask(svc, workspaceId, taskPath);
        assert.equal(task.state, "running");
        assert.equal(task.sessionId, newSessionId);
      } finally {
        recoveryHold.release();
      }
    });
  }
  {
    const ws = await makeWorkspace("replace-launch-fail");
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, nodeId, { connectionId: "fake-default" });
      const seeded = await seedPending(
        svc, workspaceId, taskPath, priorSessionId, "ti-launch-fail-seed", "must not rebind to orphan on launch fail"
      );
      const replaced = await rpc(svc, "task.replaceSession", {
        workspaceId, taskPath, callerKind: "user",
      });
      assert.ok(!replaced.error, JSON.stringify(replaced.error));
      const newSessionId = (replaced.result as { session: { sessionId: string } }).session.sessionId;
      assert.notEqual(newSessionId, priorSessionId);
      assert.equal((await svc.runtime.registry.read(newSessionId))?.connectionId, "fake-default");
      const input = await getInput(svc, workspaceId, taskPath, seeded.id);
      assert.equal(input.sessionId, newSessionId);
      for (const rec of await svc.runtime.registry.list()) {
        if (rec.connectionId !== "fake-fail-launch") continue;
        assert.equal((await svc.runtime.probe(rec.id)).alive, false);
      }
    }, { connections: [FAKE_KEEPALIVE, FAKE_FAIL_LAUNCH] });
  }
  {
    const ws = await makeWorkspace();
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, nodeId);
      await seedPending(svc, workspaceId, taskPath, priorSessionId, "ti-rebind-fail-a", "input A must stay on prior if rebind fails");
      await seedPending(svc, workspaceId, taskPath, priorSessionId, "ti-rebind-fail-b", "input B must stay on prior if rebind fails");
      svc.ctx.taskInputs.setNextPersistErrorForTests(new Error("injected TaskInput rebind persist failure"));
      const failed = await rpc(svc, "task.replaceSession", {
        workspaceId, taskPath, callerKind: "user",
      });
      assert.ok(failed.error);
      assert.equal(errCode(failed), "REPLACE_SESSION_TASK_INPUT_REBIND_FAILED");
      const failedSessionId = (failed.error!.data as { newSessionId?: string }).newSessionId;
      assert.match(failedSessionId ?? "", /^ss-/);
      assertParkedOnSession(await getTask(svc, workspaceId, taskPath), priorSessionId);
      assert.equal((await svc.runtime.probe(failedSessionId!)).alive, false);
      for (const inputId of ["ti-rebind-fail-a", "ti-rebind-fail-b"]) {
        const input = await getInput(svc, workspaceId, taskPath, inputId);
        assert.ok(input.status === "pending" || input.status === "failed");
        assert.equal(input.sessionId, priorSessionId);
      }
    });
  }
  {
    const ws = await makeWorkspace("replace-rebind-rollback-fail");
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(
        svc,
        workspaceId,
        nodeId
      );
      const inputId = "ti-rebind-rollback-fail";
      await seedPending(
        svc,
        workspaceId,
        taskPath,
        priorSessionId,
        inputId,
        "rollback failure must converge on the stopped replacement"
      );
      svc.ctx.taskInputs.setNextPersistErrorForTests(
        new Error("injected first TaskInput rebind failure")
      );
      setBeforeReplaceTaskInputRollbackForTests(async () => {
        throw new Error("injected Task rollback failure");
      });
      try {
        const failed = await rpc(svc, "task.replaceSession", {
          workspaceId,
          taskPath,
          callerKind: "user",
        });
        assert.ok(failed.error);
        assert.equal(
          errCode(failed),
          "REPLACE_SESSION_TASK_INPUT_REBIND_ROLLBACK_FAILED"
        );
        const data = failed.error!.data as {
          newSessionId?: string;
          rebindError?: string;
          rollbackError?: string;
        };
        assert.match(data.newSessionId ?? "", /^ss-/);
        assert.match(data.rebindError ?? "", /first TaskInput rebind failure/);
        assert.match(data.rollbackError ?? "", /Task rollback failure/);
        assertParkedOnSession(
          await getTask(svc, workspaceId, taskPath),
          data.newSessionId!
        );
        assert.equal((await svc.runtime.probe(data.newSessionId!)).alive, false);
        const input = await getInput(svc, workspaceId, taskPath, inputId);
        assert.equal(input.sessionId, data.newSessionId);
        assert.ok(input.status === "pending" || input.status === "failed");
      } finally {
        setBeforeReplaceTaskInputRollbackForTests(null);
      }
    });
  }
});

test("replaceSession: startSession never silent-replaces; shared flight; managed-input race", async () => {
  resetManagedAutoDeliverDedupForTests();
  resetManagedTaskInputQueueForTests();
  {
    const ws = await makeWorkspace();
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId } = await dispatchClaimStart(svc, workspaceId, nodeId);
      const again = await rpc(svc, "task.startSession", {
        workspaceId, taskPath, callerKind: "user",
      });
      assert.ok(!again.error, JSON.stringify(again.error));
      assert.equal((again.result as { session: { sessionId: string } }).session.sessionId, sessionId);
      assert.notEqual((again.result as { session: { contextRestored?: boolean } }).session.contextRestored, false);
    });
  }
  {
    const ws = await makeWorkspace();
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, nodeId);
      const payload = { workspaceId, taskPath, callerKind: "user" as const };
      const [a, b] = await Promise.all([
        rpc(svc, "task.replaceSession", payload),
        rpc(svc, "task.replaceSession", payload),
      ]);
      assert.ok(!a.error, JSON.stringify(a.error));
      assert.ok(!b.error, JSON.stringify(b.error));
      const idA = (a.result as { session: { sessionId: string } }).session.sessionId;
      const idB = (b.result as { session: { sessionId: string } }).session.sessionId;
      assert.equal(idA, idB);
      assert.notEqual(idA, priorSessionId);
      assert.equal(isManagedSessionInFlightForTests(workspaceId, taskPath), false);
    });
  }
  {
    const ws = await makeWorkspace("replace-flight");
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const { taskPath } = await dispatchClaimStart(svc, workspaceId, nodeId, { connectionId: "fake-default" });
      const [a, b] = await Promise.all([
        rpc(svc, "task.replaceSession", { workspaceId, taskPath, callerKind: "user" }),
        rpc(svc, "task.replaceSession", { workspaceId, taskPath, callerKind: "user" }),
      ]);
      assert.ok(!a.error, JSON.stringify(a.error));
      assert.ok(!b.error, JSON.stringify(b.error));
      assert.equal(
        (a.result as { session: { sessionId: string } }).session.sessionId,
        (b.result as { session: { sessionId: string } }).session.sessionId
      );
      assert.equal(isManagedSessionInFlightForTests(workspaceId, taskPath), false);
    }, {
      connections: [
        FAKE_KEEPALIVE,
        { connectionId: "fake-alt", provider: "fake", adapterId: FAKE_ADAPTER_ID, fake: { waitForSignal: true, sleepMs: 60_000 } },
      ],
    });
  }
  {
    const ws = await makeWorkspace();
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, nodeId);
      svc.runtime.clearFollowUpAttemptsForTests();
      const hold = holdManagedTaskInputQueueForTests(workspaceId, taskPath);
      const send = await rpc(svc, "task.sendInput", {
        workspaceId, taskPath, text: "stale worker must not inject prior after replace", actor: "user",
      });
      assert.ok(!send.error, JSON.stringify(send.error));
      const inputId = (send.result as { input: { id: string; sessionId?: string } }).input.id;
      assert.equal((send.result as { input: { sessionId?: string } }).input.sessionId, priorSessionId);
      await hold.entered;
      try {
        const replacing = rpc(svc, "task.replaceSession", {
          workspaceId, taskPath, callerKind: "user",
        });
        const beforeReleaseTask = await getTask(svc, workspaceId, taskPath);
        const beforeReleaseInput = await getInput(svc, workspaceId, taskPath, inputId);
        assert.equal(beforeReleaseTask.sessionId, priorSessionId);
        assert.equal(beforeReleaseInput.sessionId, priorSessionId);
        assert.deepEqual(svc.runtime.getFollowUpAttemptsForTests(), []);
        hold.release();
        const replaced = await replacing;
        assert.ok(!replaced.error, JSON.stringify(replaced.error));
        const newSessionId = (replaced.result as { session: { sessionId: string } }).session.sessionId;
        assert.notEqual(newSessionId, priorSessionId);
        const mid = await getInput(svc, workspaceId, taskPath, inputId);
        assert.equal(mid.sessionId, newSessionId);
        assert.ok(mid.status === "pending" || mid.status === "failed");
        await pollUntil(async () => {
          const input = await getInput(svc, workspaceId, taskPath, inputId);
          // Worker finished attempt (success or honest fail) and never left prior binding.
          return input.sessionId === newSessionId && input.status !== "processing" ? input : null;
        }, 8_000, "input settled on new session after worker release");
        const finalInput = await getInput(svc, workspaceId, taskPath, inputId);
        assert.equal(finalInput.sessionId, newSessionId);
        const attempts = svc.runtime.getFollowUpAttemptsForTests();
        assert.equal(attempts.filter((a) => a.sessionId === priorSessionId).length, 1,
          "the FIFO owner may finish one prior-Session attempt before replacement");
        assert.ok(attempts.filter((a) => a.sessionId === newSessionId).length <= 1,
          "replacement recovery must not inject the same open row twice");
        assert.ok(attempts.every((a) =>
          a.sessionId === priorSessionId || a.sessionId === newSessionId
        ));
        const task = await getTask(svc, workspaceId, taskPath);
        assert.equal(task.sessionId, newSessionId);
        assert.equal((await svc.runtime.probe(priorSessionId)).alive, false);
      } finally {
        hold.release();
      }
    });
  }
});

test("startSession queues lifecycle reconcile behind an active Service mutation", async () => {
  const ws = await makeWorkspace("start-reconcile-mutation-order");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const { taskPath, sessionId } = await dispatchClaimStart(svc, workspaceId, nodeId);
    const mount = svc.ctx.host.require(workspaceId);
    const entered = deferred();
    const release = deferred();
    const holding = svc.ctx.mutations.run(workspaceId, () =>
      mount.env.fs.withLock!(MUTATION_LOCK_PATH, async () => {
        entered.resolve();
        await release.promise;
      })
    );
    await entered.promise;

    let settled = false;
    const starting = rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false, "startSession must queue, not fail on the held mutation lock");

    release.resolve();
    await holding;
    const started = await starting;
    assert.ok(!started.error, JSON.stringify(started.error));
    assert.equal(
      (started.result as { session: { sessionId: string } }).session.sessionId,
      sessionId
    );
  });
});

test("startSession rejects a changed exact Task/Session identity before flight join", async () => {
  const ws = await makeWorkspace("start-route-identity");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const dispatched = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "identity must fail before provider flight",
      acceptMode: "review-required",
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const direct = dispatched.result as { taskPath: string; sessionId: string };
    const task = await getTask(svc, workspaceId, direct.taskPath);
    assert.ok(task.id);
    await svc.runtime.registry.update(direct.sessionId, { lastTaskId: "tk-foreign1" });

    try {
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath: direct.taskPath,
        callerKind: "user",
      });
      assert.equal(started.error?.code, RPC_LIFECYCLE, JSON.stringify(started));
      assert.equal(errCode(started), "BOUND_SESSION_IDENTITY_MISMATCH");
      assert.equal(
        isManagedSessionInFlightForTests(workspaceId, direct.taskPath),
        false,
        "invalid identity must fail before a managed provider flight is installed"
      );
    } finally {
      await svc.runtime.registry.update(direct.sessionId, { lastTaskId: task.id });
    }
  });
});

test("replaceSession does not join an older same-connection flight after exact route rebind", async () => {
  const ws = await makeWorkspace("replace-route-rebind");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(
      svc,
      workspaceId,
      nodeId
    );
    const entered = deferred();
    const release = deferred();
    const originalStart = svc.runtime.startSession.bind(svc.runtime);
    let providerStartCount = 0;
    (svc.runtime as { startSession: typeof svc.runtime.startSession }).startSession = async (
      input
    ) => {
      providerStartCount += 1;
      entered.resolve();
      await release.promise;
      return originalStart(input);
    };

    const owner = rpc(svc, "task.replaceSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    await entered.promise;

    try {
      const rebound = await getTask(svc, workspaceId, taskPath);
      assert.ok(rebound.sessionId);
      assert.notEqual(rebound.sessionId, priorSessionId);
      assert.equal((await svc.runtime.registry.read(rebound.sessionId!))?.connectionId, "fake-default");

      const staleJoin = await rpc(svc, "task.replaceSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
      });
      assert.equal(staleJoin.error?.code, RPC_LIFECYCLE, JSON.stringify(staleJoin));
      assert.match(staleJoin.error?.message ?? "", /operation already in progress/);
      assert.equal(
        (staleJoin.error?.data as { retryable?: boolean } | undefined)?.retryable,
        true
      );
      assert.equal(providerStartCount, 1, "route mismatch must not start a second provider");
    } finally {
      release.resolve();
      (svc.runtime as { startSession: typeof svc.runtime.startSession }).startSession = originalStart;
    }

    const replaced = await owner;
    assert.ok(!replaced.error, JSON.stringify(replaced.error));
    assert.equal(providerStartCount, 1);
  });
});

/**
 * replaceSession joins the same per-Task lifecycle flight as accept prepare→Git→finalize.
 * While accept holds the flight mid-Git, same-Task replaceSession waits; after accept it
 * refuses authoritative accepted state. Unrelated Task (other role) replace stays concurrent.
 */
test("replaceSession: waits on same-Task accept Git then refuses accepted; unrelated concurrent", async () => {
  resetManagedAutoDeliverDedupForTests();
  // Two roles so each Task can hold its own managed session (role occupancy).
  const ws = await makeWorkspace("replace-life-flight");
  await git(ws, "init", "-q", "-b", "main");
  await configureTestGitIdentity(ws);
  await fs.writeFile(path.join(ws, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(ws, "README.md"), "# repo\n");
  await git(ws, "add", ".gitignore", "README.md");
  await git(ws, "commit", "-q", "-m", "init");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-replace-life-"));
  let releaseIntegrate!: () => void;
  const integrateHold = new Promise<void>((resolve) => {
    releaseIntegrate = resolve;
  });
  let integrateEntered = false;
  const order: string[] = [];

  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    connections: [FAKE_KEEPALIVE],
    integrateCommits: async () => {
      integrateEntered = true;
      order.push("integrate-enter");
      await integrateHold;
      order.push("integrate-exit");
    },
  });
  try {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(
      svc,
      workspaceId,
      nodeId
    );
    assert.ok(priorSessionId);
    const taskSession = await svc.runtime.registry.read(priorSessionId);
    const taskWorktree = taskSession?.runtimeWorkspace?.cwd;
    assert.ok(taskWorktree);
    await fs.writeFile(path.join(taskWorktree!, "life-replace.txt"), "r\n");
    await git(taskWorktree!, "add", "life-replace.txt");
    await git(taskWorktree!, "commit", "-q", "-m", "life replace");
    const sourceRef = (await git(taskWorktree!, "rev-parse", "HEAD")).trim();

    // Unrelated Task B on orchestrator role (own session lane).
    const otherNote = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "unrelated-replace-task",
      type: "prompt",
    });
    assert.ok(!otherNote.error, JSON.stringify(otherNote.error));
    const otherNodeId = (otherNote.result as { nodeId: string }).nodeId;
    const otherDispatch = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [otherNodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "unrelated concurrent replace",
      acceptMode: "review-required",
    });
    assert.ok(!otherDispatch.error, JSON.stringify(otherDispatch.error));
    const otherTaskPath = (otherDispatch.result as { taskPath: string }).taskPath;
    if ((otherDispatch.result as { state?: string }).state === "queued") {
      await rpc(svc, "task.claim", { workspaceId, taskPath: otherTaskPath });
    }
    const otherStarted = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: otherTaskPath,
      callerKind: "user",
    });
    assert.ok(!otherStarted.error, JSON.stringify(otherStarted.error));
    const otherPrior = (otherStarted.result as { session: { sessionId: string } }).session
      .sessionId;

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "ready for accept/replace race",
      commits: [sourceRef],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    assert.equal((delivered.result as { state: string }).state, "delivered");
    const deliveryId = (delivered.result as { delivery: { id: string } }).delivery.id;

    const acceptPromise = rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      deliveryId,
      actor: "user",
    }).then((res) => {
      order.push("accept-done");
      return res;
    });

    const deadline = Date.now() + 15000;
    while (!integrateEntered && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(integrateEntered, true, "accept must enter Git before concurrent replaceSession");

    // Unrelated Task B replace completes while Task A accept still holds Git.
    const otherReplace = await rpc(svc, "task.replaceSession", {
      workspaceId,
      taskPath: otherTaskPath,
      callerKind: "user",
    });
    assert.ok(!otherReplace.error, JSON.stringify(otherReplace.error));
    const otherNew = (otherReplace.result as { session: { sessionId: string } }).session
      .sessionId;
    assert.notEqual(otherNew, otherPrior);
    order.push("unrelated-replace-done");

    const replacePromise = rpc(svc, "task.replaceSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    }).then((res) => {
      order.push("replace-done");
      return res;
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!order.includes("replace-done"), "replaceSession must wait on same-Task accept Git");
    assert.ok(!order.includes("accept-done"), "accept must not finish while Git is held");
    assert.ok(
      order.includes("unrelated-replace-done"),
      "unrelated Task replace must not wait on Task A lifecycle flight"
    );

    releaseIntegrate();
    const [accepted, replaced] = await Promise.all([acceptPromise, replacePromise]);
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    assert.equal((accepted.result as { state: string }).state, "accepted");
    assert.ok(replaced.error, "replaceSession must refuse after accept completed");
    assert.equal(replaced.error?.code, RPC_LIFECYCLE, JSON.stringify(replaced.error));
    assert.match(
      String(replaced.error?.message ?? ""),
      /requires running or waiting|accepted/i,
      JSON.stringify(replaced.error)
    );
    assert.equal(errCode(replaced), "INVALID_TASK_STATE");

    const get = await getTask(svc, workspaceId, taskPath);
    assert.equal(get.state, "accepted");

    assert.ok(order.indexOf("unrelated-replace-done") < order.indexOf("integrate-exit"));
    assert.ok(order.indexOf("integrate-exit") < order.indexOf("accept-done"));
    assert.ok(order.includes("replace-done"));
  } finally {
    releaseIntegrate();
    await svc.stop();
  }
});
