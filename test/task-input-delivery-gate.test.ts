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
  const nodeId = (created.result as { nodeId: string }).nodeId;
  return { workspaceId, nodeId };
}

async function runningTask(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string,
  opts?: {
    startSession?: boolean;
    profileId?: string;
    deliveryPolicy?: "review" | "bypass";
  }
): Promise<{ workspaceId: string; taskPath: string; sessionId?: string }> {
  const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
  const d = await rpc(svc, "task.dispatch", {
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    workspaceId,
    nodeIds: [nodeId],
    role: "executor",
    prompt: "delivery gate fixture",
    deliveryPolicy: opts?.deliveryPolicy ?? "review",
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

test("P0: terminal TaskInput (delivered/acked/cancelled) do not block", async () => {
  const ws = await makeWorkspace("tent-ti-gate-terminal-");
  await withService(async (svc) => {
    const { workspaceId, taskPath } = await runningTask(svc, ws);

    // Seed terminal rows that must NOT block.
    await seedTaskInput(svc, {
      workspaceId,
      taskPath,
      status: "delivered",
      text: "already injected",
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

test("P0: uncertain blocks manual and bypass Delivery and is attention-visible", async () => {
  for (const deliveryPolicy of ["review", "bypass"] as const) {
    const ws = await makeWorkspace(`tent-ti-gate-uncertain-${deliveryPolicy}-`);
    await withService(async (svc) => {
      const { workspaceId, taskPath } = await runningTask(svc, ws, {
        deliveryPolicy,
      });
      const { id } = await seedTaskInput(svc, {
        workspaceId,
        taskPath,
        status: "uncertain",
        text: "provider may have seen this",
      });

      const manual = await rpc(svc, "task.deliver", {
        workspaceId,
        taskPath,
        summary: `MUST_NOT_${deliveryPolicy.toUpperCase()}`,
      });
      assert.ok(manual.error);
      assertPendingTaskInputError(manual.error!);
      const data = manual.error!.data as {
        firstStatus?: string;
        firstInputId?: string;
      };
      assert.equal(data.firstStatus, "uncertain");
      assert.equal(data.firstInputId, id);

      const attention = await rpc(svc, "taskInput.listPending", {
        workspaceId,
        taskPath,
      });
      assert.ok(!attention.error, JSON.stringify(attention.error));
      const row = (
        attention.result as {
          inputs: Array<{
            id: string;
            status: string;
            lastError?: string;
            uncertainAt?: string;
          }>;
        }
      ).inputs.find((input) => input.id === id);
      assert.equal(row?.status, "uncertain");
      assert.match(row?.lastError ?? "", /seeded uncertain/);
      assert.ok(row?.uncertainAt);

      const deliveries = await rpc(svc, "delivery.list", { workspaceId });
      assert.equal(
        (deliveries.result as { deliveries: unknown[] }).deliveries.length,
        0,
        `${deliveryPolicy} must not publish/auto-accept around uncertain`
      );
    });
  }
});

test("P0: explicit retry is new-row first; ack old uncertain leaves new blocker", async () => {
  const ws = await makeWorkspace("tent-ti-gate-uncertain-retry-");
  await withService(async (svc) => {
    const { workspaceId, taskPath } = await runningTask(svc, ws);
    const { id: uncertainId } = await seedTaskInput(svc, {
      workspaceId,
      taskPath,
      status: "uncertain",
    });

    const resent = await rpc(svc, "task.sendInput", {
      workspaceId,
      taskPath,
      text: "new row retries the ambiguous requirement",
    });
    assert.ok(!resent.error, JSON.stringify(resent.error));
    const newId = (resent.result as { input: { id: string } }).input.id;
    assert.notEqual(newId, uncertainId);

    const acked = await rpc(svc, "taskInput.ack", {
      workspaceId,
      taskPath,
      inputId: uncertainId,
    });
    assert.ok(!acked.error, JSON.stringify(acked.error));
    assert.equal(
      (acked.result as { input: { status: string } }).input.status,
      "consumed"
    );

    const blocked = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "NEW_ROW_STILL_BLOCKS",
    });
    assert.ok(blocked.error);
    assertPendingTaskInputError(blocked.error!);
    const data = blocked.error!.data as { inputIds?: string[]; statuses?: string[] };
    assert.deepEqual(data.inputIds, [newId]);
    assert.deepEqual(data.statuses, ["pending"]);
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

test("P0: managed auto-deliver refuses open TaskInput pre-seal; Session stays live; draft retry after input delivered", async () => {
  resetManagedAutoDeliverDedupForTests();
  resetManagedTaskInputBackgroundForTests();
  // Prevent background inject from racing the open pending row to delivered.
  stopManagedTaskInputBackgroundAccept();

  const ws = await makeWorkspace("tent-ti-gate-managed-");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-gate-log-"));
  const logPath = path.join(dataDir, "mock-acp.json");
  // Explicit outcome wire required for managed ready Delivery; body is the summary.
  const reportBody = "MANAGED_AFTER_INPUT_OK";
  const reportText = `outcome: delivered\n\n${reportBody}`;

  await withService(
    async (svc) => {
      const { workspaceId, taskPath, sessionId } = await runningTask(svc, ws, {
        startSession: true,
        profileId: "mock-gate",
      });
      assert.ok(sessionId);

      // Input before seal: open blocker must refuse without stopping Session.
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
        assistantText: reportText,
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
        "pre-seal gate must not cancel open blocker rows"
      );
      assert.notEqual(still?.resolvedBy, "session.stop_after_deliver");

      // Pre-seal refusal: managed Session must remain live (not sealed/stopped).
      const probe = await rpc(svc, "session.get", { workspaceId, sessionId });
      assert.ok(!probe.error, JSON.stringify(probe.error));
      const session = (
        probe.result as { session: { alive?: boolean; state?: string } }
      ).session;
      assert.equal(
        session.alive,
        true,
        "blocked managed auto-deliver must leave Session alive"
      );

      const failEv = diag.find(
        (p) => p.runtimeEvent === "session.prompt_complete.failed"
      );
      assert.ok(failEv, "must emit managed auto-deliver failure diagnostics");
      assert.equal(failEv!.taskFailed, false);
      assert.equal(failEv!.errorCode, "PENDING_TASK_INPUT");
      assert.match(String(failEv!.error ?? ""), /open TaskInput|PENDING_TASK_INPUT/i);
      assert.equal(failEv!.reportDraftPreserved, true);

      // Report draft retained for production-style retry without re-prompt.
      // Full outcome wire is stored so idempotent retry re-parses correctly.
      const draft = await svc.ctx.managedDeliveryReportDrafts.get(
        workspaceId,
        taskPath
      );
      assert.ok(draft, "draft must survive pre-seal PENDING_TASK_INPUT refusal");
      assert.equal(draft!.assistantText, reportText);

      // Legitimate consume, then production-like retry: empty assistantText
      // recovers the durable draft (not a re-prompt; not the sole test-only path).
      await svc.ctx.taskInputs.markDelivered(id, "test");
      const afterInput = await svc.ctx.taskInputs.get(id, workspaceId, taskPath);
      assert.equal(afterInput?.status, "delivered");

      await invokeManagedAutoDeliverForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId: sessionId!,
        assistantText: "",
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
      assert.equal(deliveries[0].summary, reportBody);
      assert.equal(
        await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath),
        undefined,
        "draft cleared after successful publish"
      );
    },
    {
      profiles: [
        mockAcpProfile("mock-gate", {
          logPath,
          promptText: reportText,
          keepAlive: true,
          hangBootstrap: true,
        }),
      ],
    }
  );
});

test("P0 race: input before deliver blocks; deliver first makes sendInput refuse", async () => {
  const ws = await makeWorkspace("tent-ti-gate-order-");
  await withService(async (svc) => {
    // --- Input first → public deliver blocked ---
    const a = await runningTask(svc, ws);
    const sent = await rpc(svc, "task.sendInput", {
      workspaceId: a.workspaceId,
      taskPath: a.taskPath,
      text: "consume before deliver",
      actor: "user",
    });
    assert.ok(!sent.error, JSON.stringify(sent.error));
    assert.equal(
      (sent.result as { accepted?: boolean; input: { status: string } }).accepted,
      true
    );
    assert.equal(
      (sent.result as { input: { status: string } }).input.status,
      "pending"
    );

    const blocked = await rpc(svc, "task.deliver", {
      workspaceId: a.workspaceId,
      taskPath: a.taskPath,
      summary: "TOO_EARLY_AFTER_SEND",
    });
    assert.ok(blocked.error);
    assertPendingTaskInputError(blocked.error!);
    assert.equal(
      (
        (
          await rpc(svc, "task.get", {
            workspaceId: a.workspaceId,
            taskPath: a.taskPath,
          })
        ).result as { task: { state: string } }
      ).task.state,
      "running"
    );
    assert.equal(
      (
        (await rpc(svc, "delivery.list", { workspaceId: a.workspaceId }))
          .result as { deliveries: unknown[] }
      ).deliveries.length,
      0
    );

    await rpc(svc, "task.interrupt", {
      workspaceId: a.workspaceId,
      taskPath: a.taskPath,
      actor: "user",
    });

    // --- Deliver first → sendInput rechecks state and refuses ---
    const created = await rpc(svc, "docs.createNote", {
      workspaceId: a.workspaceId,
      name: "order-b",
      type: "prompt",
    });
    assert.ok(!created.error, JSON.stringify(created.error));
    const nodeId = (created.result as { nodeId: string }).nodeId;
    const d = await rpc(svc, "task.dispatch", {
      workspaceId: a.workspaceId,
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      nodeIds: [nodeId],
      role: "executor",
      prompt: "deliver first ordering",
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", {
      workspaceId: a.workspaceId,
      taskPath,
    });

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId: a.workspaceId,
      taskPath,
      summary: "DELIVER_BEFORE_INPUT",
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    assert.equal(
      (delivered.result as { state: string }).state,
      "delivered"
    );

    const lateInput = await rpc(svc, "task.sendInput", {
      workspaceId: a.workspaceId,
      taskPath,
      text: "too late after deliver",
      actor: "user",
    });
    assert.ok(lateInput.error, "sendInput must refuse after Delivery published");
    assert.equal(lateInput.error!.code, RPC_LIFECYCLE);
    assert.match(
      String(lateInput.error!.message ?? ""),
      /running or waiting|state=delivered/i
    );
    const lateData = lateInput.error!.data as { state?: string } | undefined;
    assert.equal(lateData?.state, "delivered");

    // No second Delivery; no late pending input on delivered task.
    const list = await rpc(svc, "delivery.list", {
      workspaceId: a.workspaceId,
    });
    const deliveries = (
      list.result as { deliveries: Array<{ summary: string }> }
    ).deliveries.filter((x) => x.summary === "DELIVER_BEFORE_INPUT");
    assert.equal(deliveries.length, 1);
    const pending = await svc.ctx.taskInputs.listRetryableForTask(
      a.workspaceId,
      taskPath
    );
    assert.equal(
      pending.length,
      0,
      "sendInput must not persist a blocker after Delivery"
    );
  });
});

test("P0 race: concurrent sendInput and public deliver — honest either-way under MutationBus", async () => {
  const ws = await makeWorkspace("tent-ti-gate-race-");
  await withService(async (svc) => {
    const { workspaceId, taskPath } = await runningTask(svc, ws);

    // Both enter the same workspace MutationBus: exactly one of
    // (deliver publishes) or (sendInput accepts pending) can win; the other
    // fails honestly. Never both succeed (would mean a slipped blocker).
    const [deliverRes, sendRes] = await Promise.all([
      rpc(svc, "task.deliver", {
        workspaceId,
        taskPath,
        summary: "RACE_DELIVER",
      }),
      rpc(svc, "task.sendInput", {
        workspaceId,
        taskPath,
        text: "RACE_INPUT",
        actor: "user",
      }),
    ]);

    const deliverOk = !deliverRes.error;
    const sendOk = !sendRes.error;
    assert.equal(
      deliverOk && sendOk,
      false,
      "deliver and sendInput must not both succeed (ordering hole)"
    );
    assert.ok(
      deliverOk || sendOk,
      `at least one path should succeed: deliver=${JSON.stringify(deliverRes.error)} send=${JSON.stringify(sendRes.error)}`
    );

    if (deliverOk) {
      assert.equal((deliverRes.result as { state: string }).state, "delivered");
      assert.ok(sendRes.error);
      assert.equal(sendRes.error!.code, RPC_LIFECYCLE);
      assert.match(
        String(sendRes.error!.message ?? ""),
        /running or waiting|state=delivered/i
      );
      const list = await rpc(svc, "delivery.list", { workspaceId });
      assert.equal(
        (list.result as { deliveries: unknown[] }).deliveries.length,
        1
      );
      assert.equal(
        (await svc.ctx.taskInputs.listRetryableForTask(workspaceId, taskPath)).length,
        0
      );
    } else {
      assert.ok(sendOk);
      assert.equal(
        (sendRes.result as { input: { status: string } }).input.status,
        "pending"
      );
      assertPendingTaskInputError(deliverRes.error!);
      const mid = await rpc(svc, "task.get", { workspaceId, taskPath });
      assert.equal(
        (mid.result as { task: { state: string } }).task.state,
        "running"
      );
      assert.equal(
        (
          (await rpc(svc, "delivery.list", { workspaceId })).result as {
            deliveries: unknown[];
          }
        ).deliveries.length,
        0
      );
    }
  });
});

test("P0 race: sendInput cannot slip between final publish gate and taskDeliver (MutationBus hold)", async () => {
  const ws = await makeWorkspace("tent-ti-gate-toctou-");
  await withService(async (svc) => {
    const { workspaceId, taskPath } = await runningTask(svc, ws);

    // Hold MutationBus, queue deliver then sendInput, then release.
    // deliver publishes first; sendInput rechecks state=delivered and refuses.
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const busHold = svc.ctx.mutations.run(workspaceId, async () => {
      await hold;
    });
    await new Promise((r) => setTimeout(r, 20));

    const deliverPromise = rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "TOCTOU_DELIVER_WINS",
    });
    await new Promise((r) => setTimeout(r, 20));
    const sendPromise = rpc(svc, "task.sendInput", {
      workspaceId,
      taskPath,
      text: "must not slip mid-publish",
      actor: "user",
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      (await svc.ctx.taskInputs.listRetryableForTask(workspaceId, taskPath)).length,
      0,
      "no TaskInput row while publish path still holds/queues the bus"
    );

    releaseHold();
    await busHold;
    const [deliverRes, sendRes] = await Promise.all([
      deliverPromise,
      sendPromise,
    ]);

    assert.ok(!deliverRes.error, JSON.stringify(deliverRes.error));
    assert.equal((deliverRes.result as { state: string }).state, "delivered");
    assert.ok(sendRes.error, "sendInput after deliver on bus must refuse");
    assert.equal(sendRes.error!.code, RPC_LIFECYCLE);
    assert.match(
      String(sendRes.error!.message ?? ""),
      /running or waiting|state=delivered/i
    );
    assert.equal(
      (await svc.ctx.taskInputs.listRetryableForTask(workspaceId, taskPath)).length,
      0
    );
    const list = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal(
      (
        list.result as { deliveries: Array<{ summary: string }> }
      ).deliveries.filter((x) => x.summary === "TOCTOU_DELIVER_WINS").length,
      1
    );
  });
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
      const nodeId2 = (created2.result as { nodeId: string }).nodeId;
      const dManaged = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        nodeIds: [nodeId2],
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
        // Explicit outcome wire so managed path reaches TaskInput authority
        // (not the missing-outcome short-circuit).
        assistantText: "outcome: delivered\n\nMANAGED_SHAPE",
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
