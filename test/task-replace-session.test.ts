/**
 * Focused tests for task.replaceSession: eligibility, flight, success, failure,
 * atomic rebind, late events, and held pre-replace managed-input race.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { ensureRoleWorkspace } from "../src/core/workspace.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS, RPC_A2A_DENIED, RPC_LIFECYCLE } from "../src/service/types.js";
import {
  holdManagedTaskInputQueueForTests,
  isManagedSessionInFlightForTests,
  mapRuntimeEventToService,
  REPLACE_SESSION_RESTORE_REASON,
  resetManagedAutoDeliverDedupForTests,
  resetManagedTaskInputQueueForTests,
  SESSION_UNAVAILABLE_WAIT_CODE,
  SESSION_UNAVAILABLE_WAIT_SUMMARY,
} from "../src/service/handlers.js";
import { DEFAULT_GROK_MODEL, GROK_ACP_ADAPTER_ID } from "../src/adapters/grok-acp/index.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { configureTestGitIdentity, git } from "./helpers.js";

const MOCK_ACP = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-acp-server.mjs");
type Svc = Awaited<ReturnType<typeof startLocalTentService>>;
type TaskSnap = {
  id?: string; state: string; sessionId?: string; referencedNodeIds?: string[];
  worktree?: string; branch?: string; deliveryPolicy?: string;
  wait?: { reason?: string; summary?: string; code?: string } | null;
};
const FAKE_KEEPALIVE = { id: "fake-default", adapterId: FAKE_ADAPTER_ID, fake: { waitForSignal: true, sleepMs: 60_000 } } as const;
const FAKE_FAIL_LAUNCH = {
  id: "fake-fail-launch", adapterId: FAKE_ADAPTER_ID,
  fake: { failLaunch: "replace-session test: intentional launch failure" },
} as const;

function mockAcpProfile(id: string, opts: { logPath: string; promptDelayMs?: number }) {
  return {
    id, adapterId: GROK_ACP_ADAPTER_ID, command: process.execPath,
    args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      MOCK_ACP_LOG: opts.logPath, MOCK_ACP_KEEP_ALIVE: "1", MOCK_ACP_PROMPT_TEXT: "REPLACE_SESSION_REPORT",
      ...(opts.promptDelayMs != null ? { MOCK_ACP_PROMPT_DELAY_MS: String(opts.promptDelayMs) } : {}),
      CPA_GROK_API_KEY: "test-key-not-real",
    },
    acp: {
      model: DEFAULT_GROK_MODEL, envKey: "CPA_GROK_API_KEY", permissionPolicy: "deny" as const,
      promptTimeoutMs: Math.max(8_000, (opts.promptDelayMs ?? 0) + 4_000), permissionTimeoutMs: 500,
    },
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

async function makeWorkspace(
  name = "replace-session",
  rolePolicies?: Record<string, "allow" | "ask" | "deny">,
  roleProfiles?: Record<string, string[]>
): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-replace-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, { name, boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }] });
  await fsa.writeFile(".tent/roles.json", JSON.stringify({
    roles: [
      {
        name: "executor", prompt: "do work",
        ...(rolePolicies?.executor ? { a2aPolicy: rolePolicies.executor } : {}),
        ...(rolePolicies?.executor === "allow" || roleProfiles?.executor
          ? { allowedProfiles: roleProfiles?.executor ?? ["fake-default", "fake-fail-launch"] }
          : {}),
      },
      {
        name: "orchestrator", prompt: "dispatch work",
        a2aPolicy: rolePolicies?.orchestrator ?? "allow",
        allowedProfiles: roleProfiles?.orchestrator ?? ["fake-default"],
      },
    ],
  }, null, 2) + "\n");
  return workspace;
}

async function withService<T>(
  fn: (svc: Svc) => Promise<T>,
  opts?: { profiles?: import("../src/runtime/types.js").AgentProfileConfig[] }
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-replace-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true, profiles: opts?.profiles });
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
  return { workspaceId, boxId: (created.result as { id: string }).id };
}

async function dispatchClaimStart(svc: Svc, workspaceId: string, boxId: string, opts?: { profileId?: string }) {
  const profileId = opts?.profileId ?? "fake-default";
  const d = await rpc(svc, "task.dispatch", {
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    workspaceId, boxId, role: "executor", prompt: "replace-session fixture", deliveryPolicy: "review",
  });
  assert.ok(!d.error, JSON.stringify(d.error));
  const taskPath = (d.result as { taskPath: string }).taskPath;
  if ((d.result as { state?: string }).state === "queued") await rpc(svc, "task.claim", { workspaceId, taskPath });
  const before = await rpc(svc, "task.get", { workspaceId, taskPath });
  const taskBefore = (before.result as { task: { sessionId?: string } }).task;
  if (!taskBefore.sessionId) {
    const started = await rpc(svc, "task.startSession", { workspaceId, taskPath, callerKind: "user", profileId });
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
function assertParkedOnPrior(task: TaskSnap, priorSessionId: string) {
  assert.equal(task.state, "waiting");
  assert.equal(task.wait?.reason, "external");
  assert.equal(task.wait?.code, SESSION_UNAVAILABLE_WAIT_CODE);
  assert.equal(task.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);
  assert.equal(task.sessionId, priorSessionId);
}
async function seedPending(svc: Svc, workspaceId: string, taskPath: string, sessionId: string, id: string, text: string) {
  const now = new Date().toISOString();
  return svc.ctx.taskInputs.add({ id, workspaceId, taskPath, sessionId, status: "pending", text, createdAt: now, updatedAt: now });
}

test("CLIENT_METHODS includes task.replaceSession", () => {
  assert.ok((CLIENT_METHODS as readonly string[]).includes("task.replaceSession"));
  assert.equal(REPLACE_SESSION_RESTORE_REASON, "task.replaceSession.fresh");
});

test("replaceSession: success preserves Task + contextRestored=false + audit", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, boxId);
    const before = await getTask(svc, workspaceId, taskPath);
    const replaced = (await client.taskReplaceSession(workspaceId, {
      taskPath, profileId: "fake-default", callerKind: "user",
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
    assert.deepEqual(replaced.task.referencedNodeIds ?? [], before.referencedNodeIds ?? []);
    assert.equal(replaced.task.worktree, before.worktree);
    assert.equal(replaced.task.branch, before.branch);
    assert.equal(replaced.task.deliveryPolicy, before.deliveryPolicy);
    const newRow = await svc.runtime.registry.read(replaced.session.sessionId);
    assert.equal(newRow?.contextRestored, false);
    assert.equal(newRow?.restoreReason, REPLACE_SESSION_RESTORE_REASON);
    assert.equal(newRow?.replacedSessionId, priorSessionId);
    const oldRow = await svc.runtime.registry.read(priorSessionId);
    assert.ok(oldRow);
    assert.equal(oldRow!.replacedBySessionId, replaced.session.sessionId);
    assert.equal(oldRow!.stopReason, "user");
    assert.ok(oldRow!.state === "stopped" || oldRow!.state === "failed");
    assert.equal(oldRow!.lastTaskId, undefined);
    assert.equal((await svc.runtime.probe(priorSessionId)).alive, false);
    assert.equal((await svc.runtime.probe(replaced.session.sessionId)).alive, true);
  });
});

test("replaceSession: eligibility - turnBusy, waitCode, A2A deny, force refused", async () => {
  resetManagedAutoDeliverDedupForTests();
  {
    const ws = await makeWorkspace();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-replace-busy-"));
    const logPath = path.join(dataDir, "mock-acp-log.json");
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId, boxId, role: "executor", prompt: "busy replace must fail-loud", deliveryPolicy: "review",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId, taskPath, callerKind: "user", profileId: "mock-acp-replace-busy",
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
        workspaceId, taskPath, profileId: "mock-acp-replace-busy", callerKind: "user",
      });
      assert.ok(refused.error);
      assert.equal(refused.error!.code, RPC_LIFECYCLE);
      assert.equal(errCode(refused), "TURN_BUSY");
      const force = await rpc(svc, "task.replaceSession", {
        workspaceId, taskPath, profileId: "mock-acp-replace-busy", callerKind: "user", force: true,
      });
      assert.ok(force.error);
      assert.match(String(force.error!.message ?? ""), /force/i);
    }, { profiles: [mockAcpProfile("mock-acp-replace-busy", { logPath, promptDelayMs: 4_000 })] });
  }
  {
    const ws = await makeWorkspace();
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, boxId);
      await rpc(svc, "task.wait", {
        workspaceId, taskPath, reason: "user-input",
        summary: "awaiting human reply (not session_unavailable)",
      });
      const refused = await rpc(svc, "task.replaceSession", {
        workspaceId, taskPath, profileId: "fake-default", callerKind: "user",
      });
      assert.ok(refused.error);
      assert.equal(errCode(refused), "REPLACE_SESSION_WAIT_NOT_ELIGIBLE");
      const task = await getTask(svc, workspaceId, taskPath);
      assert.equal(task.state, "waiting");
      assert.equal(task.sessionId, priorSessionId);
    });
  }
  {
    const ws = await makeWorkspace("replace-deny", { executor: "deny" });
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const { taskPath } = await dispatchClaimStart(svc, workspaceId, boxId);
      const denied = await rpc(svc, "task.replaceSession", {
        workspaceId, taskPath, profileId: "fake-default", callerKind: "role",
      });
      assert.ok(denied.error);
      assert.equal(denied.error!.code, RPC_A2A_DENIED);
    });
  }
});

test("replaceSession: session_unavailable + late events + atomic rebind; launch/persist failures park", async () => {
  resetManagedAutoDeliverDedupForTests();
  {
    const ws = await makeWorkspace();
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, boxId);
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
      const replaced = await rpc(svc, "task.replaceSession", {
        workspaceId, taskPath, profileId: "fake-default", callerKind: "user",
      });
      assert.ok(!replaced.error, JSON.stringify(replaced.error));
      const newSessionId = (replaced.result as { session: { sessionId: string } }).session.sessionId;
      assert.notEqual(newSessionId, priorSessionId);
      assert.equal((replaced.result as { session: { contextRestored?: boolean } }).session.contextRestored, false);
      assert.equal((replaced.result as { task: TaskSnap }).task.state, "running");
      const input = await getInput(svc, workspaceId, taskPath, seeded.id);
      assert.equal(input.status, "pending");
      assert.equal(input.sessionId, newSessionId);
      mapRuntimeEventToService(svc.ctx, { type: "session.failed", sessionId: priorSessionId, error: "late failure after replace" });
      mapRuntimeEventToService(svc.ctx, { type: "session.exited", sessionId: priorSessionId, exitCode: 1 });
      await new Promise((r) => setTimeout(r, 120));
      const task = await getTask(svc, workspaceId, taskPath);
      assert.equal(task.state, "running");
      assert.equal(task.sessionId, newSessionId);
    });
  }
  {
    const ws = await makeWorkspace("replace-launch-fail", { executor: "allow" }, { executor: ["fake-default", "fake-fail-launch"] });
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, boxId, { profileId: "fake-default" });
      const seeded = await seedPending(
        svc, workspaceId, taskPath, priorSessionId, "ti-launch-fail-seed", "must not rebind to orphan on launch fail"
      );
      const failed = await rpc(svc, "task.replaceSession", {
        workspaceId, taskPath, profileId: "fake-fail-launch", callerKind: "user",
      });
      assert.ok(failed.error);
      assert.equal(failed.error!.code, RPC_LIFECYCLE);
      assert.equal(errCode(failed), "REPLACE_SESSION_LAUNCH_FAILED");
      assertParkedOnPrior(await getTask(svc, workspaceId, taskPath), priorSessionId);
      const input = await getInput(svc, workspaceId, taskPath, seeded.id);
      assert.ok(input.status === "pending" || input.status === "failed");
      assert.equal(input.sessionId, priorSessionId);
      for (const rec of await svc.runtime.registry.list()) {
        if (rec.profileId !== "fake-fail-launch") continue;
        assert.equal((await svc.runtime.probe(rec.id)).alive, false);
      }
    }, { profiles: [FAKE_KEEPALIVE, FAKE_FAIL_LAUNCH] });
  }
  {
    const ws = await makeWorkspace();
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, boxId);
      await seedPending(svc, workspaceId, taskPath, priorSessionId, "ti-rebind-fail-a", "input A must stay on prior if rebind fails");
      await seedPending(svc, workspaceId, taskPath, priorSessionId, "ti-rebind-fail-b", "input B must stay on prior if rebind fails");
      svc.ctx.taskInputs.setNextPersistErrorForTests(new Error("injected TaskInput rebind persist failure"));
      const failed = await rpc(svc, "task.replaceSession", {
        workspaceId, taskPath, profileId: "fake-default", callerKind: "user",
      });
      assert.ok(failed.error);
      assert.equal(errCode(failed), "REPLACE_SESSION_TASK_INPUT_REBIND_FAILED");
      assertParkedOnPrior(await getTask(svc, workspaceId, taskPath), priorSessionId);
      for (const inputId of ["ti-rebind-fail-a", "ti-rebind-fail-b"]) {
        const input = await getInput(svc, workspaceId, taskPath, inputId);
        assert.ok(input.status === "pending" || input.status === "failed");
        assert.equal(input.sessionId, priorSessionId);
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
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId } = await dispatchClaimStart(svc, workspaceId, boxId);
      const again = await rpc(svc, "task.startSession", {
        workspaceId, taskPath, profileId: "fake-default", callerKind: "user",
      });
      assert.ok(!again.error, JSON.stringify(again.error));
      assert.equal((again.result as { session: { sessionId: string } }).session.sessionId, sessionId);
      assert.notEqual((again.result as { session: { contextRestored?: boolean } }).session.contextRestored, false);
    });
  }
  {
    const ws = await makeWorkspace();
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, boxId);
      const payload = { workspaceId, taskPath, profileId: "fake-default", callerKind: "user" as const };
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
    const ws = await makeWorkspace("replace-flight", { executor: "allow" }, { executor: ["fake-default", "fake-alt"] });
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const { taskPath } = await dispatchClaimStart(svc, workspaceId, boxId, { profileId: "fake-default" });
      const [a, b] = await Promise.all([
        rpc(svc, "task.replaceSession", { workspaceId, taskPath, profileId: "fake-default", callerKind: "user" }),
        rpc(svc, "task.replaceSession", { workspaceId, taskPath, profileId: "fake-alt", callerKind: "user" }),
      ]);
      const errors = [a, b].filter((r) => r.error);
      assert.ok(errors.length >= 1);
      const conflict = errors.find((r) => /already in progress/i.test(String(r.error!.message ?? "")));
      if (conflict) {
        assert.equal(conflict.error!.code, RPC_LIFECYCLE);
        assert.equal((conflict.error!.data as { retryable?: boolean }).retryable, true);
      }
      assert.equal(isManagedSessionInFlightForTests(workspaceId, taskPath), false);
    }, {
      profiles: [
        FAKE_KEEPALIVE,
        { id: "fake-alt", adapterId: FAKE_ADAPTER_ID, fake: { waitForSignal: true, sleepMs: 60_000 } },
      ],
    });
  }
  {
    const ws = await makeWorkspace();
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(svc, workspaceId, boxId);
      svc.runtime.clearFollowUpAttemptsForTests();
      const hold = holdManagedTaskInputQueueForTests(workspaceId, taskPath);
      const send = await rpc(svc, "task.sendInput", {
        workspaceId, taskPath, text: "stale worker must not inject prior after replace", actor: "user",
      });
      assert.ok(!send.error, JSON.stringify(send.error));
      const inputId = (send.result as { input: { id: string; sessionId?: string } }).input.id;
      assert.equal((send.result as { input: { sessionId?: string } }).input.sessionId, priorSessionId);
      await hold.entered;
      const replaced = await rpc(svc, "task.replaceSession", {
        workspaceId, taskPath, profileId: "fake-default", callerKind: "user",
      });
      assert.ok(!replaced.error, JSON.stringify(replaced.error));
      const newSessionId = (replaced.result as { session: { sessionId: string } }).session.sessionId;
      assert.notEqual(newSessionId, priorSessionId);
      const mid = await getInput(svc, workspaceId, taskPath, inputId);
      assert.equal(mid.sessionId, newSessionId);
      assert.ok(mid.status === "pending" || mid.status === "failed");
      // No inject attempt while held (replace only rebinds durable row).
      assert.deepEqual(svc.runtime.getFollowUpAttemptsForTests(), []);
      hold.release();
      await pollUntil(async () => {
        const input = await getInput(svc, workspaceId, taskPath, inputId);
        // Worker finished attempt (success or honest fail) and never left prior binding.
        return input.sessionId === newSessionId && input.status !== "processing" ? input : null;
      }, 8_000, "input settled on new session after worker release");
      const finalInput = await getInput(svc, workspaceId, taskPath, inputId);
      assert.equal(finalInput.sessionId, newSessionId);
      const attempts = svc.runtime.getFollowUpAttemptsForTests();
      assert.equal(attempts.filter((a) => a.sessionId === priorSessionId).length, 0,
        "retired prior Session must receive zero follow-up inject attempts");
      // Any inject attempt must target the replacement Session only.
      assert.ok(attempts.every((a) => a.sessionId === newSessionId));
      const task = await getTask(svc, workspaceId, taskPath);
      assert.equal(task.sessionId, newSessionId);
      assert.equal((await svc.runtime.probe(priorSessionId)).alive, false);
    });
  }
});

/**
 * replaceSession joins the same per-Task lifecycle flight as accept prepare→Git→finalize.
 * While accept holds the flight mid-Git, same-Task replaceSession waits; after accept it
 * refuses authoritative accepted state. Unrelated Task (other role) replace stays concurrent.
 */
test("replaceSession: waits on same-Task accept Git then refuses accepted; unrelated concurrent", async () => {
  resetManagedAutoDeliverDedupForTests();
  // Two roles so each Task can hold its own managed session (role occupancy).
  const ws = await makeWorkspace(
    "replace-life-flight",
    { executor: "allow", orchestrator: "allow" },
    { executor: ["fake-default"], orchestrator: ["fake-default"] }
  );
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
    integrateCommits: async () => {
      integrateEntered = true;
      order.push("integrate-enter");
      await integrateHold;
      order.push("integrate-exit");
    },
  });
  try {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const { taskPath, sessionId: priorSessionId } = await dispatchClaimStart(
      svc,
      workspaceId,
      boxId
    );
    assert.ok(priorSessionId);
    const contract = await ensureRoleWorkspace(ws, "executor");
    await fs.writeFile(path.join(contract.worktree, "life-replace.txt"), "r\n");
    await git(contract.worktree, "add", "life-replace.txt");
    await git(contract.worktree, "commit", "-q", "-m", "life replace");
    const sourceRef = (await git(contract.worktree, "rev-parse", "HEAD")).trim();

    // Unrelated Task B on orchestrator role (own session lane).
    const otherNote = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "unrelated-replace-task",
      type: "prompt",
    });
    assert.ok(!otherNote.error, JSON.stringify(otherNote.error));
    const otherBoxId = (otherNote.result as { id: string }).id;
    const otherDispatch = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId: otherBoxId,
      role: "orchestrator",
      prompt: "unrelated concurrent replace",
      deliveryPolicy: "review",
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
      profileId: "fake-default",
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

    const acceptPromise = rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
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
      profileId: "fake-default",
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
      profileId: "fake-default",
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
    assert.ok(order.indexOf("accept-done") < order.indexOf("replace-done"));
  } finally {
    releaseIntegrate();
    await svc.stop();
  }
});
