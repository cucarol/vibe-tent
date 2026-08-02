/**
 * Desktop P0-1: collaboration closed-loop UI model + service client smoke.
 * Pure model tests + vertical registry/dispatch/accept via Local Service.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS } from "../src/service/types.js";
import {
  ACTIONABLE_TASK_STATES,
  buildAcceptPayload,
  buildRejectPayload,
  buildStartSessionPayload,
  buildTaskReviewItems,
  canCancelTask,
  canInterruptTask,
  canStartAgentOnTask,
  isActionableTaskState,
  listCoordinationTypeNames,
  listCoordinationTypeOptions,
  listRouteOptions,
  pickDefaultCoordinationType,
  pickDefaultRouteId,
  sessionStateLabel,
  suggestNodeName,
  taskStateLabel,
  validateDispatchForm,
} from "../src/desktop/workbench/collaboration-ui.js";
import { DesktopShellModel } from "../src/desktop/workbench/shell-model.js";
import { ServiceRpcClient } from "../src/desktop/client/rpc-client.js";
import {
  defaultSettingsRoutes,
  projectSettingsRoute,
  projectSettingsRoutes,
} from "../src/service/routes.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { GROK_ACP_ADAPTER_ID } from "../src/adapters/grok-acp/index.js";
import { buildTaskContextCard } from "../src/core/task-context-card.js";

const testTaskContextCard = (nodeId: string) =>
  buildTaskContextCard({
    refs: { nodes: [{ id: nodeId }] },
  });

// ---- pure UI model ----

test("listCoordinationTypeNames uses base tier types", () => {
  const names = listCoordinationTypeNames([
    { name: "note", tier: "base" as const },
    { name: "goal", tier: "base" as const },
    { name: "prompt", tier: "base" as const },
    { name: "open", tier: "modifier" as const },
    { name: "quest", tier: "base" as const },
  ]);
  assert.deepEqual(names, ["goal", "note", "prompt", "quest"]);
  assert.equal(pickDefaultCoordinationType(names.map((name) => ({ name, tier: "base" as const }))), "goal");
  assert.ok(listCoordinationTypeNames([{ name: "mission", tier: "base" }]).includes("mission"));
  assert.equal(
    listCoordinationTypeNames([{ name: "sealed", tier: "modifier" }]).length,
    0
  );
});

test("validateDispatchForm builds task.dispatch payload and blocks invalid cases", () => {
  const roles = [{ name: "executor" }, { name: "reviewer" }];
  const ok = validateDispatchForm({
    nodeId: "cx-1",
    coordination: true,
    role: "executor",
    prompt: "  implement feature  ",
    roles,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.payload, {
    nodeId: "cx-1",
    assigneeKind: "role",
    assigneeId: "executor",
    prompt: "implement feature",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });

  assert.equal(
    validateDispatchForm({
      nodeId: "cx-1",
      coordination: false,
      role: "executor",
      prompt: "x",
      roles,
    }).ok,
    false
  );
  assert.equal(
    validateDispatchForm({
      nodeId: null,
      coordination: true,
      role: "executor",
      prompt: "x",
      roles,
    }).ok,
    false
  );
  assert.equal(
    validateDispatchForm({
      nodeId: "cx-1",
      coordination: true,
      role: "",
      prompt: "x",
      roles,
    }).ok,
    false
  );
  assert.equal(
    validateDispatchForm({
      nodeId: "cx-1",
      coordination: true,
      role: "executor",
      prompt: "   ",
      roles,
    }).ok,
    false
  );
  assert.equal(
    validateDispatchForm({
      nodeId: "cx-1",
      coordination: true,
      role: "ghost",
      prompt: "x",
      roles,
    }).ok,
    false
  );
  assert.equal(
    validateDispatchForm({
      nodeId: "cx-1",
      coordination: true,
      role: "executor",
      prompt: "x",
      roles: [],
    }).ok,
    false
  );
});

test("accept/reject payload builders and task review model", () => {
  assert.deepEqual(buildAcceptPayload("temp/executor/tasks/t1.md"), {
    taskPath: "temp/executor/tasks/t1.md",
    actor: "user",
  });

  const badReject = buildRejectPayload("temp/executor/tasks/t1.md", "  ");
  assert.equal(badReject.ok, false);

  const goodReject = buildRejectPayload("temp/executor/tasks/t1.md", "  need more tests  ");
  assert.equal(goodReject.ok, true);
  if (goodReject.ok) {
    assert.equal(goodReject.payload.note, "need more tests");
    assert.equal(goodReject.payload.actor, "user");
    assert.equal(goodReject.payload.resume, true);
  }

  const items = buildTaskReviewItems(
    [
      {
        path: "temp/executor/tasks/a.md",
        id: "tk-a",
        assigneeKind: "role",
        assigneeId: "executor",
        referencedNodeIds: ["cx-box"],
        state: "delivered",
        manifest: "m",
        activeDeliveryId: "dl-1",
        prompt: "ship it",
        contextCard: testTaskContextCard("cx-box"),
      },
      {
        path: "temp/executor/tasks/b.md",
        id: "tk-b",
        assigneeKind: "role",
        assigneeId: "executor",
        referencedNodeIds: ["cx-box"],
        state: "queued",
        manifest: "m",
        prompt: "queued work",
        contextCard: testTaskContextCard("cx-box"),
      },
    ],
    [
      {
        path: "temp/executor/deliveries/dl-1.md",
        id: "dl-1",
        taskId: "tk-a",
        sourceNodeId: "cx-box",
        status: "ready",
        summary: "Done with tests",
        commits: ["abcdef123456"],
        integrationMode: null,
      },
    ]
  );

  assert.equal(items[0].canAcceptOrReject, true);
  assert.equal(items[0].deliverySummary, "Done with tests");
  assert.deepEqual(items[0].commits, ["abcdef123456"]);
  assert.deepEqual(items[0].referencedNodeIds, ["cx-box"]);
  assert.deepEqual(items[1].referencedNodeIds, ["cx-box"]);
  assert.equal(items[1].canAcceptOrReject, false);
  assert.equal(items[1].canStartAgent, true);
  assert.equal(items[0].canStartAgent, false);
  assert.equal(items[0].canCancel, false);
  assert.equal(items[1].canCancel, true);
  assert.match(items[0].summaryLine, /待确认交付/);
});

test("suggestNodeName embeds type without hardcoding goal", () => {
  assert.match(suggestNodeName("prompt", 1_700_000_000_000), /^prompt-/);
  assert.match(suggestNodeName("mission", 1_700_000_000_000), /^mission-/);
});

test("CLIENT_METHODS includes registry.types/roles, role CRUD, and route CRUD", () => {
  assert.ok(CLIENT_METHODS.includes("registry.types"));
  assert.ok(CLIENT_METHODS.includes("registry.roles"));
  assert.ok(CLIENT_METHODS.includes("registry.role.create"));
  assert.ok(CLIENT_METHODS.includes("registry.role.update"));
  assert.ok(CLIENT_METHODS.includes("registry.role.delete"));
  assert.ok(CLIENT_METHODS.includes("route.list"));
  assert.ok(CLIENT_METHODS.includes("route.get"));
  assert.ok(CLIENT_METHODS.includes("route.create"));
  assert.ok(CLIENT_METHODS.includes("route.update"));
  assert.ok(CLIENT_METHODS.includes("route.delete"));
});

test("projectSettingsRoutes strips secrets and projects Settings route metadata", () => {
  const raw = defaultSettingsRoutes();
  // Inject a secret-looking env bag — must never appear in projection.
  (raw[0] as unknown as { env: Record<string, string> }).env = { CPA_GROK_API_KEY: "sk-secret-value", PATH: "/tmp" };
  (raw[1] as unknown as { env: Record<string, string> }).env = { TOKEN: "should-not-leak" };
  (raw[1] as unknown as { acp: Record<string, string> }).acp = {
    executable: "C:\\\\tools\\\\grok.exe",
    envKey: "CPA_GROK_API_KEY",
  };

  const projected = projectSettingsRoutes(raw);
  const json = JSON.stringify(projected);
  assert.ok(!json.includes("sk-secret-value"));
  assert.ok(!json.includes("should-not-leak"));
  // Env key *names* may appear; secret *values* must not.
  assert.ok(!json.includes("TOKEN"));
  // No raw env map object in projection payload.
  assert.ok(!/"env"\s*:/.test(json));

  const grok = projected.find((p) => p.routeId === "grok-acp-default")!;
  assert.equal(grok.adapterId, GROK_ACP_ADAPTER_ID);
  assert.equal(grok.model, "grok-4.5");
  assert.equal(grok.envKey, "CPA_GROK_API_KEY");
  assert.equal(grok.executable, undefined, "unsupported nested ACP fields never leak into route projection");
  assert.ok(projected.every((route) => route.routeId.length > 0));

  const single = projectSettingsRoute(raw[1]);
  assert.equal(single.routeId, raw[1]!.routeId);
  assert.ok(!("env" in single));
  assert.ok(!("fake" in single));
  assert.ok(!("grokAcp" in single) && !("acp" in single));
});

test("listRouteOptions + pickDefaultRouteId use Settings route ids", () => {
  const opts = listRouteOptions(projectSettingsRoutes(defaultSettingsRoutes()));
  assert.ok(opts.some((p) => p.routeId === "grok-acp-default"));
  assert.equal(pickDefaultRouteId(opts), opts[0]!.routeId);

  // Sole product route wins.
  assert.equal(
    pickDefaultRouteId([{ routeId: "only", adapterId: "x", displayName: "only", label: "only" }]),
    "only"
  );
});

test("buildStartSessionPayload is user callerKind and uses the Task's persisted route", () => {
  const ok = buildStartSessionPayload("temp/executor/tasks/t1.md");
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.payload, {
      taskPath: "temp/executor/tasks/t1.md",
      callerKind: "user",
    });
  }
  assert.equal(buildStartSessionPayload("").ok, false);
});

test("actionable task states include failed for retry/cancel lists", () => {
  assert.ok(ACTIONABLE_TASK_STATES.includes("failed"));
  assert.equal(isActionableTaskState("failed"), true);
  assert.equal(isActionableTaskState("accepted"), false);
  assert.equal(isActionableTaskState("interrupted"), false);
  assert.equal(canStartAgentOnTask("failed"), true);
  assert.equal(canCancelTask("failed"), true);
  assert.equal(canCancelTask("delivered"), false);
});

test("task/session state labels and start/interrupt gates", () => {
  assert.equal(taskStateLabel("queued"), "排队中");
  assert.equal(taskStateLabel("failed"), "失败");
  assert.equal(sessionStateLabel("starting"), "启动中");
  assert.equal(sessionStateLabel("live"), "运行中");
  assert.equal(sessionStateLabel("waiting-user"), "等待用户");
  assert.equal(sessionStateLabel("stopped"), "已停止");
  assert.equal(sessionStateLabel("failed"), "会话失败");

  assert.equal(canStartAgentOnTask("queued"), true);
  assert.equal(canStartAgentOnTask("running"), true);
  assert.equal(canStartAgentOnTask("delivered"), false);
  assert.equal(
    canStartAgentOnTask("running", { state: "live", alive: true }),
    false
  );
  assert.equal(
    canInterruptTask("running", { state: "live", alive: true }),
    true
  );
  assert.equal(canInterruptTask("queued"), false);
  assert.equal(canInterruptTask("running", null, { hasSessionId: true }), true);

  const items = buildTaskReviewItems(
    [
      {
        path: "temp/executor/tasks/live.md",
        id: "tk-live",
        assigneeKind: "role",
        assigneeId: "executor",
        referencedNodeIds: ["cx-1"],
        state: "running",
        manifest: "m",
        sessionId: "ss-live1",
        prompt: "go",
        contextCard: testTaskContextCard("cx-1"),
      },
    ],
    [],
    [
      {
        sessionId: "ss-live1",
        routeId: "fake-default",
        adapterId: FAKE_ADAPTER_ID,
        state: "live",
        alive: true,
        resumeCapable: false,
        lastTaskId: "tk-live",
      },
    ]
  );
  assert.equal(items[0].canStartAgent, false);
  assert.equal(items[0].canInterrupt, true);
  assert.equal(items[0].sessionState, "live");
  assert.match(items[0].summaryLine, /会话运行中/);
});

// ---- service + client vertical smoke ----

async function makeCollabWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-collab-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "collab",
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "executor", prompt: "do work" },
          { name: "orchestrator", prompt: "orchestrate" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

test("service+client: registry → create coordination box → dispatch → deliver → accept/reject", async () => {
  const ws = await makeCollabWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-collab-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;

    const types = (await client.registryTypes(workspaceId)) as {
      types: Array<{ name: string; tier: string; coordination: boolean }>;
    };
    const coordNames = listCoordinationTypeNames(types.types);
    assert.ok(coordNames.includes("goal"));
    assert.ok(coordNames.includes("prompt"));
    assert.ok(!coordNames.includes("note"));
    assert.ok(!coordNames.includes("open")); // modifier

    const roles = (await client.registryRoles(workspaceId)) as {
      roles: Array<{ name: string }>;
    };
    assert.ok(roles.roles.some((r) => r.name === "executor"));

    const defaultType = pickDefaultCoordinationType(types.types)!;
    const created = (await client.docsCreateNote(workspaceId, {
      name: suggestNodeName(defaultType, Date.now()),
      type: defaultType,
    }));
    assert.match(created.nodeId, /^cx-/);
    assert.equal(created.type, defaultType);

    const form = validateDispatchForm({
      nodeId: created.nodeId,
      coordination: true,
      role: "executor",
      prompt: "Ship collab closed loop",
      roles: roles.roles.map((r) => ({ name: r.name })),
    });
    assert.equal(form.ok, true);
    assert.ok(form.payload);

    const dispatched = (await client.taskDispatch(workspaceId, {
      nodeIds: [form.payload!.nodeId],
      assigneeKind: form.payload!.assigneeKind,
      assigneeId: form.payload!.assigneeId,
      prompt: form.payload!.prompt,
      parentActor: form.payload!.parentActor ?? { kind: "user", id: "user" },
      reviewer:
        form.payload!.reviewer ??
        form.payload!.parentActor ?? { kind: "user", id: "user" },
      deliveryPolicy: "review",
    })) as { taskPath: string; state: string };
    assert.equal(dispatched.state, "queued");

    await client.taskClaim(workspaceId, dispatched.taskPath);
    // No commits: pure Tent accept path (Git integrate covered by service P0 tests).
    const delivered = (await client.taskDeliver(workspaceId, dispatched.taskPath, {
      summary: "Implemented closed loop",
    })) as { state: string; delivery: { status: string } };
    assert.equal(delivered.state, "delivered");

    // Self-accept still forbidden (UI must not bypass)
    const self = await client.tryCall("task.accept", {
      workspaceId,
      taskPath: dispatched.taskPath,
      actor: "executor",
    });
    assert.equal(self.ok, false);

    const acceptPayload = buildAcceptPayload(dispatched.taskPath, "user");
    const accepted = (await client.taskAccept(
      workspaceId,
      acceptPayload.taskPath,
      acceptPayload.actor
    )) as { state: string };
    assert.equal(accepted.state, "accepted");

    // Second box: reject path
    const box2 = (await client.docsCreateNote(workspaceId, {
      name: suggestNodeName("prompt", Date.now() + 1),
      type: "prompt",
    }));
    const d2 = (await client.taskDispatch(workspaceId, {
      nodeIds: [box2.nodeId],
      assigneeKind: "role",
      assigneeId: "executor",
      prompt: "will be rejected",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      deliveryPolicy: "review",
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, d2.taskPath);
    await client.taskDeliver(workspaceId, d2.taskPath, {
      summary: "not good enough",
    });
    const rejectPayload = buildRejectPayload(d2.taskPath, "缺测试", "user");
    assert.equal(rejectPayload.ok, true);
    if (rejectPayload.ok) {
      const rejected = (await client.taskReject(
        workspaceId,
        rejectPayload.payload.taskPath,
        rejectPayload.payload.actor,
        { note: rejectPayload.payload.note, resume: rejectPayload.payload.resume }
      )) as { state: string; delivery: { status: string } };
      // resume default → rework path leaves task active (running/waiting), delivery rejected
      assert.equal(rejected.delivery.status, "rejected");
      assert.notEqual(rejected.state, "accepted");
    }

    // Shell model loads registry + tasks over desktop RPC client
    const rpc = new ServiceRpcClient({ baseUrl: svc.url, token: svc.token });
    const model = new DesktopShellModel(rpc);
    await model.refreshHealth();
    await model.refreshWorkspaces();
    await model.bindForeground(workspaceId);
    const snap = model.getSnapshot();
    assert.ok(snap.coordinationTypes.some((t) => t.name === "goal"));
    assert.ok(snap.roles.some((r) => r.name === "executor"));
    assert.ok(Array.isArray(snap.taskReview));
  } finally {
    await svc.stop();
  }
});

test("service+client: route.list safe metadata + startSession/interrupt via shell model", async () => {
  const ws = await makeCollabWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-collab-acp-"));
  // Inject only fake for offline start (no CPA / no real grok binary).
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    routes: [
      {
        routeId: "fake-default",
        provider: "fake",
        adapterId: FAKE_ADAPTER_ID,
        fake: { waitForSignal: true, emitStdout: true, canResume: true },
      },
      {
        routeId: "grok-acp-default",
        provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
        model: "grok-4.5",
        envKey: "CPA_GROK_API_KEY",
        permissionPolicy: "deny",
      },
    ],
  });
  try {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    // Product list: no testOnly, no secret values / env maps.
    const productList = (await client.routeList()) as {
      routes: Array<Record<string, unknown>>;
    };
    const productJson = JSON.stringify(productList);
    assert.ok(!/"env"\s*:/.test(productJson));
    assert.ok(!productJson.includes("sk-"));
    assert.ok(productList.routes.some((p) => p.routeId === "grok-acp-default"));
    assert.ok(productList.routes.some((p) => p.routeId === "fake-default"));

    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const box = (await client.docsCreateNote(workspaceId, {
      name: suggestNodeName("prompt", Date.now()),
      type: "prompt",
    }));

    const dispatched = (await client.taskDispatch(workspaceId, {
      nodeIds: [box.nodeId],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "start via UI model",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      deliveryPolicy: "review",
      // Explicit: dispatch must not auto-start session.
      startSession: false,
    })) as { taskPath: string; state: string };
    assert.equal(dispatched.state, "queued");

    const rpc = new ServiceRpcClient({ baseUrl: svc.url, token: svc.token });
    const model = new DesktopShellModel(rpc);
    await model.refreshHealth();
    await model.refreshWorkspaces();
    await model.bindForeground(workspaceId);

    let snap = model.getSnapshot();
    // Product routes only in shell default refresh.
    assert.equal(snap.selectedRouteId, "fake-default");

    const review = snap.taskReview.find((t) => t.path === dispatched.taskPath);
    assert.ok(review);
    assert.equal(review!.canStartAgent, true);
    assert.equal(review!.canInterrupt, false);

    // startSession payload path: user click; the Task's route assignee is authoritative.
    const started = (await model.startAgentSession(dispatched.taskPath)) as {
      session: { sessionId: string; state: string; routeId: string };
      task: { state: string; sessionId?: string };
    };
    assert.match(started.session.sessionId, /^ss-/);
    assert.equal(started.session.routeId, "fake-default");
    assert.ok(started.task.state === "running" || started.task.sessionId);

    snap = model.getSnapshot();
    const afterStart = snap.taskReview.find((t) => t.path === dispatched.taskPath);
    assert.ok(afterStart);
    // Live session → interrupt available; start gated off while alive.
    assert.equal(afterStart!.canInterrupt, true);
    assert.equal(afterStart!.canStartAgent, false);
    assert.ok(afterStart!.sessionId);

    const interrupted = (await model.interruptTask(dispatched.taskPath)) as {
      state: string;
    };
    assert.equal(interrupted.state, "interrupted");

    snap = model.getSnapshot();
    const afterIntr = snap.taskReview.find((t) => t.path === dispatched.taskPath);
    assert.ok(afterIntr);
    assert.equal(afterIntr!.state, "interrupted");
    assert.equal(afterIntr!.canStartAgent, false);
    assert.equal(afterIntr!.canInterrupt, false);

    // Missing Task path still surfaces as a local validation error.
    await assert.rejects(
      () => model.startAgentSession(""),
      /任务路径/i
    );
  } finally {
    await svc.stop();
  }
});

test("listCoordinationTypeOptions returns base-tier names only", () => {
  const opts = listCoordinationTypeOptions([
    { name: "goal", tier: "base" },
    { name: "note", tier: "base" },
    { name: "asset", tier: "modifier" },
  ]);
  assert.deepEqual(
    opts.map((o) => o.name).sort(),
    ["goal", "note"]
  );
});
