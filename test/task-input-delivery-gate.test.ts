/**
 * P0: pending/processing/retryable-failed TaskInput blocks ready Delivery.
 * Same authority for public task.deliver and managed auto-deliver.
 * Managed seal must not silently cancel open blocker rows.
 * Deterministic; fake + mock ACP only — no paid/live providers.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import {
  invokeManagedAutoDeliverForTests,
  resetManagedAutoDeliverDedupForTests,
  resetManagedTaskInputBackgroundForTests,
  stopManagedTaskInputBackgroundAccept,
} from "../src/service/handlers.js";
import { makeTaskInputId } from "../src/service/task-input-store.js";
import { RPC_LIFECYCLE } from "../src/service/types.js";
import {
  DEFAULT_GROK_MODEL,
  GROK_ACP_ADAPTER_ID,
} from "../src/adapters/grok-acp/index.js";

const MOCK_ACP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mock-acp-server.mjs"
);

function mockAcpProfile(
  id: string,
  opts: {
    logPath: string;
    promptText?: string;
    keepAlive?: boolean;
    hangBootstrap?: boolean;
  }
): import("../src/runtime/types.js").AgentProfileConfig {
  return {
    id,
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      MOCK_ACP_LOG: opts.logPath,
      MOCK_ACP_KEEP_ALIVE: opts.keepAlive === false ? "0" : "1",
      MOCK_ACP_PROMPT_TEXT: opts.promptText ?? "MANAGED_FINAL_REPORT",
      MOCK_ACP_PROMPT_MODE: opts.hangBootstrap ? "interrupt" : "ok",
      CPA_GROK_API_KEY: "test-key-not-real",
    },
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: "deny",
      promptTimeoutMs: 15_000,
      permissionTimeoutMs: 500,
    },
  };
}

async function makeWorkspace(prefix = "tent-ti-gate-"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "task-input-delivery-gate",
    rules: "# RULES\n\nTaskInput Delivery gate\n",
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
            a2aPolicy: "allow",
            allowedProfiles: ["fake-default", "mock-gate"],
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
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>,
  opts?: { profiles?: import("../src/runtime/types.js").AgentProfileConfig[] }
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-gate-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    profiles: opts?.profiles,
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

async function runningTask(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string,
  opts?: { startSession?: boolean; profileId?: string }
): Promise<{ workspaceId: string; taskPath: string; sessionId?: string }> {
  const { workspaceId, boxId } = await mountWorkItem(svc, ws);
  const d = await rpc(svc, "task.dispatch", {
    workspaceId,
    boxId,
    role: "executor",
    prompt: "delivery gate fixture",
    deliveryPolicy: "review",
  });
  assert.ok(!d.error, JSON.stringify(d.error));
  const taskPath = (d.result as { taskPath: string }).taskPath;
  await rpc(svc, "task.claim", { workspaceId, taskPath });
  if (opts?.startSession) {
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
      profileId: opts.profileId ?? "fake-default",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const sessionId = (started.result as { session: { sessionId: string } })
      .session.sessionId;
    return { workspaceId, taskPath, sessionId };
  }
  return { workspaceId, taskPath };
}

async function seedTaskInput(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  input: {
    workspaceId: string;
    taskPath: string;
    status: "pending" | "processing" | "failed" | "delivered" | "uncertain" | "consumed" | "cancelled";
    text?: string;
    sessionId?: string;
  }
): Promise<{ id: string }> {
  const id = makeTaskInputId();
  const now = new Date().toISOString();
  const base = {
    id,
    workspaceId: input.workspaceId,
    taskPath: input.taskPath,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    role: "executor",
    kind: "user-input" as const,
    text: input.text ?? `seed ${input.status}`,
    status: "pending" as const,
    createdAt: now,
    updatedAt: now,
  };
  await svc.ctx.taskInputs.add(base);
  if (input.status === "pending") return { id };
  if (input.status === "processing") {
    await svc.ctx.taskInputs.markProcessing(id);
    return { id };
  }
  if (input.status === "failed") {
    await svc.ctx.taskInputs.markFailed(id, "seeded inject failure");
    return { id };
  }
  if (input.status === "delivered") {
    await svc.ctx.taskInputs.markDelivered(id, "test");
    return { id };
  }
  if (input.status === "uncertain") {
    await svc.ctx.taskInputs.markUncertain(id, "seeded uncertain");
    return { id };
  }
  if (input.status === "consumed") {
    await svc.ctx.taskInputs.markDelivered(id, "test");
    await svc.ctx.taskInputs.ack(id, input.workspaceId, input.taskPath, "executor");
    return { id };
  }
  // cancelled: leave as pending then cancelTask
  await svc.ctx.taskInputs.cancelTask(
    input.workspaceId,
    input.taskPath,
    "test-seed"
  );
  return { id };
}

function assertPendingTaskInputError(err: {
  code?: number;
  message?: string;
  data?: unknown;
}): void {
  assert.equal(err.code, RPC_LIFECYCLE);
  assert.match(String(err.message ?? ""), /open TaskInput|PENDING_TASK_INPUT/i);
  const data = err.data as
    | {
        code?: string;
        inputIds?: string[];
        statuses?: string[];
        firstInputId?: string;
        firstStatus?: string;
        count?: number;
      }
    | undefined;
  assert.equal(data?.code, "PENDING_TASK_INPUT");
  assert.ok((data?.count ?? 0) >= 1);
  assert.ok(Array.isArray(data?.inputIds) && data!.inputIds!.length >= 1);
  assert.ok(Array.isArray(data?.statuses) && data!.statuses!.length >= 1);
  assert.ok(data?.firstInputId);
  assert.ok(data?.firstStatus);
}

test("P0: pending TaskInput blocks public task.deliver; no dl- created", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("tent-ti-gate-pending-");
  await withService(async (svc) => {
    const { workspaceId, taskPath } = await runningTask(svc, ws);
    const { id } = await seedTaskInput(svc, {
      workspaceId,
      taskPath,
      status: "pending",
      text: "must consume first",
    });

    const manual = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "BLOCKED_BY_PENDING_INPUT",
    });
    assert.ok(manual.error, "pending TaskInput must refuse public deliver");
    assertPendingTaskInputError(manual.error!);

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal(
      (got.result as { task: { state: string } }).task.state,
      "running"
    );
    const list = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      list.result as { deliveries: Array<{ id: string; summary: string }> }
    ).deliveries;
    assert.equal(deliveries.length, 0, "no dl- while pending input blocks");
    assert.equal(
      deliveries.some((d) => /BLOCKED_BY_PENDING_INPUT/.test(d.summary)),
      false
    );

    const still = await svc.ctx.taskInputs.get(id, workspaceId, taskPath);
    assert.equal(still?.status, "pending", "gate must not cancel the blocker");
  });
});

test("P0: processing TaskInput blocks public deliver", async () => {
  const ws = await makeWorkspace("tent-ti-gate-processing-");
  await withService(async (svc) => {
    const { workspaceId, taskPath } = await runningTask(svc, ws);
    const { id } = await seedTaskInput(svc, {
      workspaceId,
      taskPath,
      status: "processing",
    });

    const manual = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "BLOCKED_BY_PROCESSING",
    });
    assert.ok(manual.error);
    assertPendingTaskInputError(manual.error!);
    const data = manual.error!.data as { firstStatus?: string; firstInputId?: string };
    assert.equal(data.firstStatus, "processing");
    assert.equal(data.firstInputId, id);

    const list = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal(
      (list.result as { deliveries: unknown[] }).deliveries.length,
      0
    );
    const still = await svc.ctx.taskInputs.get(id, workspaceId, taskPath);
    assert.equal(still?.status, "processing");
  });
});

test("P0: retryable failed TaskInput blocks public deliver", async () => {
  const ws = await makeWorkspace("tent-ti-gate-failed-");
  await withService(async (svc) => {
    const { workspaceId, taskPath } = await runningTask(svc, ws);
    const { id } = await seedTaskInput(svc, {
      workspaceId,
      taskPath,
      status: "failed",
    });

    const manual = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "BLOCKED_BY_FAILED",
    });
    assert.ok(manual.error);
    assertPendingTaskInputError(manual.error!);
    const data = manual.error!.data as { firstStatus?: string };
    assert.equal(data.firstStatus, "failed");

    const list = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal(
      (list.result as { deliveries: unknown[] }).deliveries.length,
      0
    );
    const still = await svc.ctx.taskInputs.get(id, workspaceId, taskPath);
    assert.equal(still?.status, "failed");
  });
});

test("P0: terminal TaskInput (delivered/acked/cancelled) and uncertain do not block", async () => {
  const ws = await makeWorkspace("tent-ti-gate-terminal-");
  await withService(async (svc) => {
    const { workspaceId, taskPath } = await runningTask(svc, ws);

    // Seed terminal / at-most-once rows that must NOT block.
    await seedTaskInput(svc, {
      workspaceId,
      taskPath,
      status: "delivered",
      text: "already injected",
    });
    await seedTaskInput(svc, {
      workspaceId,
      taskPath,
      status: "uncertain",
      text: "at-most-once",
    });
    // cancelled via dedicated add+cancel
    {
      const id = makeTaskInputId();
      const now = new Date().toISOString();
      await svc.ctx.taskInputs.add({
        id,
        workspaceId,
        taskPath,
        role: "executor",
        kind: "user-input",
        text: "cancel me",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
      await svc.ctx.taskInputs.cancelTask(workspaceId, taskPath, "test");
      const c = await svc.ctx.taskInputs.get(id, workspaceId, taskPath);
      assert.equal(c?.status, "cancelled");
    }
    await seedTaskInput(svc, {
      workspaceId,
      taskPath,
      status: "consumed",
      text: "acked",
    });

    const ok = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "TERMINAL_INPUTS_OK",
    });
    assert.ok(!ok.error, JSON.stringify(ok.error));
    assert.equal(
      (ok.result as { state: string }).state,
      "delivered"
    );
    const list = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      list.result as { deliveries: Array<{ status: string; summary: string }> }
    ).deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].status, "ready");
    assert.equal(deliveries[0].summary, "TERMINAL_INPUTS_OK");
  });
});

test("P0: after input is delivered/acked a later public Delivery succeeds", async () => {
  const ws = await makeWorkspace("tent-ti-gate-later-");
  await withService(async (svc) => {
    const { workspaceId, taskPath } = await runningTask(svc, ws);
    const { id } = await seedTaskInput(svc, {
      workspaceId,
      taskPath,
      status: "pending",
      text: "resolve me then deliver",
    });

    const blocked = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "TOO_EARLY",
    });
    assert.ok(blocked.error);
    assertPendingTaskInputError(blocked.error!);

    await svc.ctx.taskInputs.markDelivered(id, "test");
    const afterDelivered = await svc.ctx.taskInputs.get(id, workspaceId, taskPath);
    assert.equal(afterDelivered?.status, "delivered");

    const ok = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "AFTER_INPUT_DELIVERED",
    });
    assert.ok(!ok.error, JSON.stringify(ok.error));
    assert.equal((ok.result as { state: string }).state, "delivered");
    const list = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      list.result as { deliveries: Array<{ summary: string; status: string }> }
    ).deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].summary, "AFTER_INPUT_DELIVERED");
    assert.equal(deliveries[0].status, "ready");
  });
});

test("P0: managed auto-deliver refuses open TaskInput; seal does not cancel blocker; same PENDING_TASK_INPUT code", async () => {
  resetManagedAutoDeliverDedupForTests();
  resetManagedTaskInputBackgroundForTests();
  // Prevent background inject from racing the open pending row to delivered.
  stopManagedTaskInputBackgroundAccept();

  const ws = await makeWorkspace("tent-ti-gate-managed-");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-gate-log-"));
  const logPath = path.join(dataDir, "mock-acp.json");

  await withService(
    async (svc) => {
      const { workspaceId, taskPath, sessionId } = await runningTask(svc, ws, {
        startSession: true,
        profileId: "mock-gate",
      });
      assert.ok(sessionId);

      // Keep task running (hang bootstrap avoids auto-deliver race).
      const { id } = await seedTaskInput(svc, {
        workspaceId,
        taskPath,
        status: "pending",
        text: "blocker for managed seal",
        sessionId,
      });

      const diag: Array<Record<string, unknown>> = [];
      const unsub = svc.events.subscribe((ev) => {
        if (ev.type === "session.state") {
          diag.push(ev.payload as Record<string, unknown>);
        }
      });

      await invokeManagedAutoDeliverForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId: sessionId!,
        assistantText: "MANAGED_SHOULD_NOT_PUBLISH",
      });
      unsub();

      const got = await rpc(svc, "task.get", { workspaceId, taskPath });
      assert.equal(
        (got.result as { task: { state: string } }).task.state,
        "running",
        "blocked managed auto-deliver keeps task running"
      );
      const list = await rpc(svc, "delivery.list", { workspaceId });
      assert.equal(
        (list.result as { deliveries: unknown[] }).deliveries.length,
        0,
        "no ready Delivery from managed path while pending input"
      );

      const still = await svc.ctx.taskInputs.get(id, workspaceId, taskPath);
      assert.equal(
        still?.status,
        "pending",
        "managed seal must not cancel open blocker rows"
      );
      assert.notEqual(still?.resolvedBy, "session.stop_after_deliver");

      const failEv = diag.find(
        (p) => p.runtimeEvent === "session.prompt_complete.failed"
      );
      assert.ok(failEv, "must emit managed auto-deliver failure diagnostics");
      assert.equal(failEv!.taskFailed, false);
      assert.equal(failEv!.errorCode, "PENDING_TASK_INPUT");
      assert.match(String(failEv!.error ?? ""), /open TaskInput|PENDING_TASK_INPUT/i);

      // Same authority: public path also refuses with identical code.
      const manual = await rpc(svc, "task.deliver", {
        workspaceId,
        taskPath,
        summary: "PUBLIC_ALSO_BLOCKED",
      });
      assert.ok(manual.error);
      assertPendingTaskInputError(manual.error!);

      // Legitimate consume then managed deliver succeeds.
      await svc.ctx.taskInputs.markDelivered(id, "test");
      resetManagedAutoDeliverDedupForTests();
      await invokeManagedAutoDeliverForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId: sessionId!,
        assistantText: "MANAGED_AFTER_INPUT_OK",
      });

      const after = await rpc(svc, "task.get", { workspaceId, taskPath });
      assert.equal(
        (after.result as { task: { state: string } }).task.state,
        "delivered"
      );
      const afterList = await rpc(svc, "delivery.list", { workspaceId });
      const deliveries = (
        afterList.result as {
          deliveries: Array<{ summary: string; status: string }>;
        }
      ).deliveries;
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].status, "ready");
      assert.equal(deliveries[0].summary, "MANAGED_AFTER_INPUT_OK");
    },
    {
      profiles: [
        mockAcpProfile("mock-gate", {
          logPath,
          promptText: "HANG_BOOTSTRAP",
          keepAlive: true,
          hangBootstrap: true,
        }),
      ],
    }
  );
});

test("P0: public and managed paths share PENDING_TASK_INPUT authority payload shape", async () => {
  resetManagedAutoDeliverDedupForTests();
  stopManagedTaskInputBackgroundAccept();
  const ws = await makeWorkspace("tent-ti-gate-shared-");
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-gate-shared-log-")),
    "mock.json"
  );

  await withService(
    async (svc) => {
      // One role-session at a time (executor slot is exclusive).
      // Public path first without session (no TURN_BUSY), then managed mock path.
      const { workspaceId, taskPath: publicPath } = await runningTask(svc, ws);
      const { id: publicId } = await seedTaskInput(svc, {
        workspaceId,
        taskPath: publicPath,
        status: "failed",
      });

      const publicRes = await rpc(svc, "task.deliver", {
        workspaceId,
        taskPath: publicPath,
        summary: "PUBLIC_SHAPE",
      });
      assert.ok(publicRes.error);
      const publicData = publicRes.error!.data as {
        code?: string;
        inputIds?: string[];
        firstStatus?: string;
        firstInputId?: string;
      };
      assert.equal(publicData.code, "PENDING_TASK_INPUT");
      assert.deepEqual(publicData.inputIds, [publicId]);
      assert.equal(publicData.firstStatus, "failed");
      assert.equal(publicData.firstInputId, publicId);

      // Finish the public task occupation so the same role can start managed session.
      await rpc(svc, "task.interrupt", {
        workspaceId,
        taskPath: publicPath,
        actor: "user",
      });

      const created2 = await rpc(svc, "docs.createNote", {
        workspaceId,
        name: "work-item-managed",
        type: "prompt",
      });
      assert.ok(!created2.error, JSON.stringify(created2.error));
      const boxId2 = (created2.result as { id: string }).id;
      const dManaged = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId: boxId2,
        role: "executor",
        prompt: "managed gate shape",
        deliveryPolicy: "review",
      });
      assert.ok(!dManaged.error, JSON.stringify(dManaged.error));
      const managedPath = (dManaged.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath: managedPath });
      const startedManaged = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath: managedPath,
        callerKind: "user",
        profileId: "mock-gate",
      });
      assert.ok(!startedManaged.error, JSON.stringify(startedManaged.error));
      const managedSession = (
        startedManaged.result as { session: { sessionId: string } }
      ).session.sessionId;
      const { id: managedId } = await seedTaskInput(svc, {
        workspaceId,
        taskPath: managedPath,
        status: "failed",
        sessionId: managedSession,
      });

      const diag: Array<Record<string, unknown>> = [];
      const unsub = svc.events.subscribe((ev) => {
        if (ev.type === "session.state") {
          diag.push(ev.payload as Record<string, unknown>);
        }
      });
      await invokeManagedAutoDeliverForTests(svc.ctx, {
        workspaceId,
        taskPath: managedPath,
        sessionId: managedSession,
        assistantText: "MANAGED_SHAPE",
      });
      unsub();
      const failEv = diag.find(
        (p) =>
          p.runtimeEvent === "session.prompt_complete.failed" &&
          p.taskPath === managedPath
      );
      assert.ok(failEv);
      assert.equal(failEv!.errorCode, "PENDING_TASK_INPUT");

      const list = await rpc(svc, "delivery.list", { workspaceId });
      assert.equal(
        (list.result as { deliveries: unknown[] }).deliveries.length,
        0
      );
      const stillManaged = await svc.ctx.taskInputs.get(
        managedId,
        workspaceId,
        managedPath
      );
      assert.equal(stillManaged?.status, "failed");
    },
    {
      profiles: [
        mockAcpProfile("mock-gate", {
          logPath,
          hangBootstrap: true,
          keepAlive: true,
        }),
      ],
    }
  );
});
