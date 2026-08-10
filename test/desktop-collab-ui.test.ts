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
  listConnectionOptions,
  pickDefaultCoordinationType,
  pickDefaultConnectionId,
  sessionStateLabel,
  suggestNodeName,
  taskStateLabel,
  validateDispatchForm,
} from "../src/desktop/workbench/collaboration-ui.js";
import { DesktopShellModel } from "../src/desktop/workbench/shell-model.js";
import { ServiceRpcClient } from "../src/desktop/client/rpc-client.js";
import {
  defaultAgentConnections,
  projectAgentConnection,
  projectAgentConnections,
} from "../src/service/connections.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { GROK_ACP_ADAPTER_ID } from "../src/adapters/grok-acp/index.js";
import { buildTaskContextCard } from "../src/core/task-context-card.js";

const testTaskContextCard = (nodeId: string) =>
  buildTaskContextCard({
    workNodeIds: [nodeId],
    contextNodeIds: [],
    nodeSnapshots: [
      {
        id: nodeId,
        path: `nodes/${nodeId}.md`,
        type: "prompt",
        tags: [],
        body: "",
        etag: "000000000000000000000000",
      },
    ],
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
  const roles = [
    { roleId: "rl-executor", name: "executor" },
    { roleId: "rl-reviewer", name: "reviewer" },
  ];
  const ok = validateDispatchForm({
    nodeId: "cx-1",
    coordination: true,
    role: "executor",
    prompt: "  implement feature  ",
    roles,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.payload, {
    workNodeIds: ["cx-1"], contextNodeIds: [],
    roleId: "rl-executor",
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
  assert.deepEqual(buildAcceptPayload("temp/executor/tasks/t1.md", "dl-ready"), {
    taskPath: "temp/executor/tasks/t1.md",
    deliveryId: "dl-ready",
    actor: "user",
  });

  const badReject = buildRejectPayload("temp/executor/tasks/t1.md", "dl-ready", "  ");
  assert.equal(badReject.ok, false);

  const goodReject = buildRejectPayload(
    "temp/executor/tasks/t1.md",
    "dl-ready",
    "  need more tests  "
  );
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
        roleId: "rl-executor",
        workNodeIds: ["cx-box"], contextNodeIds: [],
        state: "delivered",
        manifest: "m",
        acceptMode: "review-required",
        activeDeliveryId: "dl-1",
        prompt: "ship it",
        contextCard: testTaskContextCard("cx-box"),
      },
      {
        path: "temp/executor/tasks/b.md",
        id: "tk-b",
        roleId: "rl-executor",
        sessionId: "ss-b",
        workNodeIds: ["cx-box"], contextNodeIds: [],
        state: "queued",
        manifest: "m",
        acceptMode: "review-required",
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
  assert.deepEqual(items[0].workNodeIds, ["cx-box"]);
  assert.deepEqual(items[0].contextNodeIds, []);
  assert.deepEqual(items[1].workNodeIds, ["cx-box"]);
  assert.deepEqual(items[1].contextNodeIds, []);
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

test("CLIENT_METHODS includes registry.types/roles, role CRUD, and Connection CRUD", () => {
  assert.ok(CLIENT_METHODS.includes("registry.types"));
  assert.ok(CLIENT_METHODS.includes("registry.roles"));
  assert.ok(CLIENT_METHODS.includes("registry.role.create"));
  assert.ok(CLIENT_METHODS.includes("registry.role.update"));
  assert.ok(CLIENT_METHODS.includes("registry.role.delete"));
  assert.ok(CLIENT_METHODS.includes("connection.list"));
  assert.ok(CLIENT_METHODS.includes("connection.get"));
  assert.ok(CLIENT_METHODS.includes("connection.create"));
  assert.ok(CLIENT_METHODS.includes("connection.update"));
  assert.ok(CLIENT_METHODS.includes("connection.delete"));
});

test("projectAgentConnections strips secrets and projects Agent Connection metadata", () => {
  const raw = defaultAgentConnections();
  // Inject a secret-looking env bag — must never appear in projection.
  (raw[0] as unknown as { env: Record<string, string> }).env = { CPA_GROK_API_KEY: "sk-secret-value", PATH: "/tmp" };
  (raw[1] as unknown as { env: Record<string, string> }).env = { TOKEN: "should-not-leak" };
  (raw[1] as unknown as { acp: Record<string, string> }).acp = {
    executable: "C:\\\\tools\\\\grok.exe",
    envKey: "CPA_GROK_API_KEY",
  };

  const projected = projectAgentConnections(raw);
  const json = JSON.stringify(projected);
  assert.ok(!json.includes("sk-secret-value"));
  assert.ok(!json.includes("should-not-leak"));
  // Env key *names* may appear; secret *values* must not.
  assert.ok(!json.includes("TOKEN"));
  // No raw env map object in projection payload.
  assert.ok(!/"env"\s*:/.test(json));

  const grok = projected.find((p) => p.connectionId === "grok-acp-default")!;
  assert.equal(grok.adapterId, GROK_ACP_ADAPTER_ID);
  assert.equal(grok.model, "grok-4.5");
  assert.equal(grok.envKey, "CPA_GROK_API_KEY");
  assert.equal(grok.executable, undefined, "unsupported nested ACP fields never leak into Connection projection");
  assert.ok(projected.every((connection) => connection.connectionId.length > 0));

  const single = projectAgentConnection(raw[1]);
  assert.equal(single.connectionId, raw[1]!.connectionId);
  assert.ok(!("env" in single));
  assert.ok(!("fake" in single));
  assert.ok(!("grokAcp" in single) && !("acp" in single));
});

test("listConnectionOptions + pickDefaultConnectionId use Agent Connection ids", () => {
  const opts = listConnectionOptions(projectAgentConnections(defaultAgentConnections()));
  assert.ok(opts.some((p) => p.connectionId === "grok-acp-default"));
  assert.equal(pickDefaultConnectionId(opts), opts[0]!.connectionId);

  // Sole product route wins.
  assert.equal(
    pickDefaultConnectionId([{ connectionId: "only", adapterId: "x", displayName: "only", label: "only" }]),
    "only"
  );
});

test("buildStartSessionPayload is user callerKind and uses the Task's persisted Session", () => {
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
  assert.equal(canStartAgentOnTask("failed", undefined, { hasSessionId: true }), true);
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

  assert.equal(canStartAgentOnTask("queued", undefined, { hasSessionId: true }), true);
  assert.equal(canStartAgentOnTask("running", undefined, { hasSessionId: true }), true);
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
        roleId: "rl-executor",
        workNodeIds: ["cx-1"], contextNodeIds: [],
        state: "running",
        manifest: "m",
        acceptMode: "review-required",
        sessionId: "ss-live1",
        prompt: "go",
        contextCard: testTaskContextCard("cx-1"),
      },
    ],
    [],
    [
      {
        sessionId: "ss-live1",
        connectionId: "fake-default",
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
  assert.deepEqual(items[0].workNodeIds, ["cx-1"]);
  assert.deepEqual(items[0].contextNodeIds, []);
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
          { id: "rl-executor", name: "executor", prompt: "do work" },
          { id: "rl-orchestrator", name: "orchestrator", prompt: "orchestrate" },
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
      roles: Array<{ roleId: string; name: string }>;
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
      roles: roles.roles.map((r) => ({ roleId: r.roleId, name: r.name })),
    });
    assert.equal(form.ok, true);
    assert.ok(form.payload);

    const dispatched = (await client.taskDispatch(workspaceId, {
      workNodeIds: form.payload!.workNodeIds,
      contextNodeIds: [],
      roleId: form.payload!.roleId,
      prompt: form.payload!.prompt,
      parentActor: form.payload!.parentActor ?? { kind: "user", id: "user" },
      reviewer:
        form.payload!.reviewer ??
        form.payload!.parentActor ?? { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as { taskPath: string; state: string };
    assert.equal(dispatched.state, "queued");

    const entered = (await client.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      cwd: ws,
    })) as { session: { sessionId: string }; sessionToken: string };
    const roleClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: entered.session.sessionId,
      currentSessionToken: entered.sessionToken,
    });
    await roleClient.taskClaim(workspaceId, dispatched.taskPath);
    // No commits: pure Tent accept path (Git integrate covered by service P0 tests).
    const delivered = (await client.taskDeliver(workspaceId, dispatched.taskPath, {
      summary: "Implemented closed loop",
    })) as { state: string; delivery: { id: string; status: string } };
    assert.equal(delivered.state, "delivered");

    // Self-accept still forbidden (UI must not bypass)
    const self = await client.tryCall("task.accept", {
      workspaceId,
      taskPath: dispatched.taskPath,
      deliveryId: delivered.delivery.id,
      actor: "executor",
    });
    assert.equal(self.ok, false);

    const acceptPayload = buildAcceptPayload(dispatched.taskPath, delivered.delivery.id, "user");
    const accepted = (await client.taskAccept(
      workspaceId,
      acceptPayload.taskPath,
      acceptPayload.deliveryId,
      acceptPayload.actor
    )) as { state: string };
    assert.equal(accepted.state, "accepted");

    // Second box: reject path
    const box2 = (await client.docsCreateNote(workspaceId, {
      name: suggestNodeName("prompt", Date.now() + 1),
      type: "prompt",
    }));
    const d2 = (await client.taskDispatch(workspaceId, {
      workNodeIds: [box2.nodeId], contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "will be rejected",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as { taskPath: string };
    await roleClient.taskClaim(workspaceId, d2.taskPath);
    const delivered2 = (await client.taskDeliver(workspaceId, d2.taskPath, {
      summary: "not good enough",
    })) as { delivery: { id: string } };
    const rejectPayload = buildRejectPayload(
      d2.taskPath,
      delivered2.delivery.id,
      "缺测试",
      "user"
    );
    assert.equal(rejectPayload.ok, true);
    if (rejectPayload.ok) {
      const rejected = (await client.taskReject(
        workspaceId,
        rejectPayload.payload.taskPath,
        rejectPayload.payload.deliveryId,
        rejectPayload.payload.actor,
        { note: rejectPayload.payload.note, resume: false }
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

test("service+client: connection.list safe metadata + managed Session/interrupt via shell model", async () => {
  const ws = await makeCollabWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-collab-acp-"));
  // Inject only fake for offline start (no CPA / no real grok binary).
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    connections: [
      {
        connectionId: "fake-default",
        provider: "fake",
        adapterId: FAKE_ADAPTER_ID,
        fake: { waitForSignal: true, emitStdout: true, canResume: true },
      },
      {
        connectionId: "grok-acp-default",
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
    const productList = (await client.connectionList()) as {
      connections: Array<Record<string, unknown>>;
    };
    const productJson = JSON.stringify(productList);
    assert.ok(!/"env"\s*:/.test(productJson));
    assert.ok(!productJson.includes("sk-"));
    assert.ok(productList.connections.some((p) => p.connectionId === "grok-acp-default"));
    assert.ok(productList.connections.some((p) => p.connectionId === "fake-default"));

    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const box = (await client.docsCreateNote(workspaceId, {
      name: suggestNodeName("prompt", Date.now()),
      type: "prompt",
    }));

    const dispatched = (await client.taskDispatch(workspaceId, {
      workNodeIds: [box.nodeId], contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "start via UI model",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as {
      taskPath: string;
      state: string;
      session?: { sessionId: string; connectionId: string };
    };
    assert.ok(dispatched.state === "running" || dispatched.state === "waiting");
    assert.equal(
      (dispatched.session as unknown as { session: { connectionId: string } }).session.connectionId,
      "fake-default"
    );

    const rpc = new ServiceRpcClient({ baseUrl: svc.url, token: svc.token });
    const model = new DesktopShellModel(rpc);
    await model.refreshHealth();
    await model.refreshWorkspaces();
    await model.bindForeground(workspaceId);

    let snap = model.getSnapshot();
    // Product Connections only in shell default refresh.
    assert.equal(snap.selectedConnectionId, "fake-default");

    const review = snap.taskReview.find((t) => t.path === dispatched.taskPath);
    assert.ok(review);
    const afterStart = review!;
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
