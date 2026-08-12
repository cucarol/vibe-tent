import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { contentEtag } from "../src/core/etag.js";
import { createDelivery, writeDelivery } from "../src/core/delivery.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import {
  loadTaskEnvelope,
  patchTaskEnvelope,
  writeTaskEnvelope,
  type TaskEnvelope,
} from "../src/core/task.js";
import { NodeFs, SystemClock } from "../src/fs/node-fs.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import type { PendingDecisionRequest } from "../src/core/decision-request.js";
import type { AgentConnectionConfig } from "../src/runtime/agent-connection.js";
import { createServiceClient } from "../src/service/client.js";
import { startLocalTentService } from "../src/service/service.js";
import {
  CLIENT_METHODS,
  type WorkspaceCollaborationProjection,
} from "../src/service/types.js";

const FAKE_CONNECTION: AgentConnectionConfig = {
  connectionId: "fake-k",
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  displayName: "Machine K",
  fake: { waitForSignal: true, sleepMs: 60_000 },
};

async function makeWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-workspace-collab-"));
  const workspaceFs = new NodeFs(workspace);
  await scaffoldInWorkspace(workspaceFs, {
    name: "workspace-collaboration",
    nodes: [
      { name: "selected", type: "prompt", body: "# Selected\n" },
      { name: "selected-child", type: "prompt", body: "# Child\n" },
      { name: "user-delivery", type: "prompt", body: "# Delivery\n" },
      { name: "user-decision", type: "prompt", body: "# Decision\n" },
      { name: "history", type: "prompt", body: "# History\n" },
      { name: "connection", type: "prompt", body: "# Connection\n" },
    ],
  });
  await workspaceFs.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { id: "rl-parent", name: "parent", displayName: "Parent Role", prompt: "review" },
          { id: "rl-executor", name: "executor", displayName: "Executor Role", prompt: "work" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  const systemFs = new NodeFs(path.join(workspace, ".tent"));
  const tent = await import("../src/core/tree.js").then(({ loadTent }) => loadTent(systemFs));
  const ids = new Map<string, string>();
  for (const node of tent.byId.values()) ids.set(node.name, node.id);
  return { workspace, systemFs, ids };
}

async function withService<T>(
  fn: (
    svc: Awaited<ReturnType<typeof startLocalTentService>>,
    client: ReturnType<typeof createServiceClient>
  ) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-workspace-collab-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    connections: [FAKE_CONNECTION],
  });
  try {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    return await fn(svc, client);
  } finally {
    await svc.stop();
  }
}

function snapshot(id: string) {
  const body = `# ${id}\n`;
  return { id, path: `${id}.md`, type: "prompt", tags: [], body, etag: contentEtag(body) };
}

async function writeTask(
  systemFs: NodeFs,
  input: {
    workNodeIds: string[];
    roleId?: string;
    sessionId?: string;
    parentActor: { kind: "user" | "role"; id: string };
  }
): Promise<TaskEnvelope> {
  const taskPath = await writeTaskEnvelope(systemFs, new SystemClock(), {
    roleId: input.roleId,
    sessionId: input.sessionId,
    workNodeIds: input.workNodeIds,
    contextNodeIds: [],
    nodeSnapshots: input.workNodeIds.map(snapshot),
    manifestPath: "temp/test/manifest.yml",
    userPrompt: "projection fixture",
    parentActor: input.parentActor,
    acceptMode: "review-required",
  });
  return loadTaskEnvelope(systemFs, taskPath);
}

async function readyDelivery(
  systemFs: NodeFs,
  task: TaskEnvelope,
  sourceNodeId: string,
  summary: string,
  now: string
) {
  const delivery = await createDelivery(systemFs, { now: () => now }, {
    taskId: task.id!,
    sourceNodeId,
    deliveriesDir: task.roleId
      ? `temp/roles/${task.roleId}/deliveries`
      : `temp/sessions/${task.sessionId}/deliveries`,
    summary,
    status: "ready",
  });
  await patchTaskEnvelope(systemFs, task.path, {
    state: "delivered",
    activeDeliveryId: delivery.id,
  });
  return delivery;
}

test("workspace.collaboration joins multi-Node Role work and only user-actionable Inbox", async () => {
  assert.ok(CLIENT_METHODS.includes("workspace.collaboration"));
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const selected = ids.get("selected")!;
    const child = ids.get("selected-child")!;
    const deliveryNode = ids.get("user-delivery")!;
    const decisionNode = ids.get("user-decision")!;

    const roleTask = await writeTask(systemFs, {
      workNodeIds: [selected, child],
      roleId: "rl-executor",
      parentActor: { kind: "role", id: "rl-parent" },
    });
    const roleDelivery = await readyDelivery(
      systemFs,
      roleTask,
      selected,
      "Role review summary",
      "2026-01-01T00:00:00.000Z"
    );

    const userDeliveryTask = await writeTask(systemFs, {
      workNodeIds: [deliveryNode],
      roleId: "rl-executor",
      parentActor: { kind: "user", id: "user" },
    });
    const userDelivery = await readyDelivery(
      systemFs,
      userDeliveryTask,
      deliveryNode,
      "User review summary",
      "2026-01-02T00:00:00.000Z"
    );

    const userDecisionTask = await writeTask(systemFs, {
      workNodeIds: [decisionNode],
      roleId: "rl-executor",
      parentActor: { kind: "user", id: "user" },
    });
    await patchTaskEnvelope(systemFs, userDecisionTask.path, {
      state: "waiting",
      wait: { reason: "user-input", summary: "Need user choice" },
    });
    const decision: PendingDecisionRequest = {
      id: "dr-0123456789",
      status: "pending",
      requester: { kind: "session", id: "ss-0123456789" },
      target: { kind: "user", id: "user" },
      taskId: userDecisionTask.id!,
      question: "Choose one?",
      options: [{ id: "yes", label: "Yes" }],
    };
    await svc.ctx.decisionRequests.add({
      workspaceId,
      taskPath: userDecisionTask.path,
      request: decision,
    });

    const staleReadyTask = await writeTask(systemFs, {
      workNodeIds: [ids.get("history")!],
      roleId: "rl-executor",
      parentActor: { kind: "user", id: "user" },
    });
    await createDelivery(systemFs, { now: () => "2020-01-02T00:00:00.000Z" }, {
      taskId: staleReadyTask.id!,
      sourceNodeId: ids.get("history")!,
      deliveriesDir: "temp/roles/rl-executor/deliveries",
      summary: "Stale ready history",
      status: "ready",
    });
    await svc.ctx.decisionRequests.add({
      workspaceId,
      taskPath: staleReadyTask.path,
      request: {
        id: "dr-abcdefghij",
        status: "pending",
        requester: { kind: "session", id: "ss-abcdefghij" },
        target: { kind: "user", id: "user" },
        taskId: staleReadyTask.id!,
        question: "Historical pending row?",
        options: [],
      },
    });

    // Historical non-actionable Delivery is irrelevant even without a current Task.
    await createDelivery(systemFs, { now: () => "2020-01-01T00:00:00.000Z" }, {
      taskId: "tk-zzzzzzzz",
      sourceNodeId: ids.get("history")!,
      deliveriesDir: "temp/roles/rl-executor/deliveries",
      summary: "Accepted history",
      status: "accepted",
    });

    const result = await client.workspaceCollaboration(
      workspaceId,
      child
    ) as WorkspaceCollaborationProjection;
    assert.deepEqual(result.selectedNode, {
      nodeId: child,
      activeTask: {
        taskId: roleTask.id,
        state: "delivered",
        responsibility: { kind: "role", roleId: "rl-parent", displayName: "Parent Role" },
        execution: { kind: "role", roleId: "rl-executor", displayName: "Executor Role" },
        readyDelivery: {
          deliveryId: roleDelivery.id,
          summary: "Role review summary",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        pendingDecision: null,
      },
    });
    assert.deepEqual(result.inbox.counts, { delivery: 1, decision: 1, total: 2 });
    assert.deepEqual(result.inbox.items.map((item) => item.kind), ["delivery", "decision"]);
    assert.deepEqual(result.inbox.items[0], {
      kind: "delivery",
      deliveryId: userDelivery.id,
      taskId: userDeliveryTask.id,
      sourceNodeId: deliveryNode,
      summary: "User review summary",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    assert.equal(result.inbox.items[1]!.kind, "decision");
    assert.equal((result.inbox.items[1] as { requestId: string }).requestId, decision.id);

    const inboxOnly = await client.workspaceCollaboration(workspaceId);
    assert.equal(inboxOnly.selectedNode, null);
    assert.deepEqual(inboxOnly.inbox, result.inbox);

    const decisionProjection = await client.workspaceCollaboration(workspaceId, decisionNode);
    assert.deepEqual(decisionProjection.selectedNode?.activeTask?.pendingDecision, {
      requestId: decision.id,
      question: "Choose one?",
      options: [{ id: "yes", label: "Yes" }],
    });

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "taskPath", "sessionId", "alive", "turnBusy", "provider", "adapterId",
      "token", "commits", "targetHead", "name", "type", "mode",
    ]) {
      assert.equal(serialized.includes(`\"${forbidden}\"`), false, forbidden);
    }
  });
});

test("workspace.collaboration distinguishes user responsibility from Connection execution", async () => {
  const { workspace, ids } = await makeWorkspace();
  await withService(async (svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const nodeId = ids.get("connection")!;
    const dispatched = await client.taskDispatch(workspaceId, {
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: FAKE_CONNECTION.connectionId,
      prompt: "connection execution",
      parentActor: { kind: "user", id: "user" },
    }) as { taskPath: string; sessionId: string };
    assert.ok(dispatched.taskPath);

    const result = await client.workspaceCollaboration(workspaceId, nodeId);
    assert.equal(result.selectedNode?.activeTask?.state, "running");
    assert.deepEqual(result.selectedNode?.activeTask?.responsibility, { kind: "user" });
    assert.deepEqual(result.selectedNode?.activeTask?.execution, {
      kind: "connection",
      connectionId: "fake-k",
      displayName: "Machine K",
    });

    await svc.runtime.registry.update(dispatched.sessionId, {
      lastTaskId: "tk-other",
    });
    await assert.rejects(
      () => client.workspaceCollaboration(workspaceId, nodeId),
      /WORKSPACE_COLLABORATION_STALE|consistency error/i
    );
  });
});

test("workspace.collaboration keeps ordinary external Session execution private", async () => {
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const entered = await client.sessionEnter({
      workspaceId,
      externalKey: "workspace-collaboration-external",
      cwd: workspace,
    }) as { session: { sessionId: string } };
    const nodeId = ids.get("connection")!;
    const task = await writeTask(systemFs, {
      workNodeIds: [nodeId],
      sessionId: entered.session.sessionId,
      parentActor: { kind: "user", id: "user" },
    });
    await patchTaskEnvelope(systemFs, task.path, { state: "running" });
    await svc.runtime.registry.update(entered.session.sessionId, {
      lastTaskId: task.id,
    });

    const result = await client.workspaceCollaboration(workspaceId, nodeId);
    assert.equal(result.selectedNode?.activeTask?.taskId, task.id);
    assert.deepEqual(result.selectedNode?.activeTask?.responsibility, { kind: "user" });
    assert.equal(result.selectedNode?.activeTask?.execution, null);
  });
});

test("workspace.collaboration fails closed when a current user Delivery is missing", async () => {
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (_svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const deliveryNode = ids.get("user-delivery")!;
    const task = await writeTask(systemFs, {
      workNodeIds: [deliveryNode],
      roleId: "rl-executor",
      parentActor: { kind: "user", id: "user" },
    });
    const delivery = await readyDelivery(
      systemFs,
      task,
      deliveryNode,
      "Current summary",
      "2026-01-01T00:00:00.000Z"
    );
    await patchTaskEnvelope(systemFs, task.path, { activeDeliveryId: "dl-missing" });
    await assert.rejects(
      () => client.workspaceCollaboration(workspaceId, ids.get("selected")!),
      /WORKSPACE_COLLABORATION_STALE|consistency error/i
    );
    await patchTaskEnvelope(systemFs, task.path, {
      state: "running",
      activeDeliveryId: delivery.id,
    });
    await assert.rejects(
      () => client.workspaceCollaboration(workspaceId, deliveryNode),
      /User-reviewable Delivery identity is stale|ready Delivery outside delivered state/i
    );
  });
});

test("workspace.collaboration rejects current ready Delivery without durable createdAt", async () => {
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (_svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const nodeId = ids.get("user-delivery")!;
    const task = await writeTask(systemFs, {
      workNodeIds: [nodeId],
      roleId: "rl-executor",
      parentActor: { kind: "user", id: "user" },
    });
    const delivery = await readyDelivery(
      systemFs,
      task,
      nodeId,
      "Missing timestamp",
      "2026-01-01T00:00:00.000Z"
    );
    const { createdAt: _createdAt, ...withoutCreatedAt } = delivery;
    await writeDelivery(systemFs, withoutCreatedAt);

    await assert.rejects(
      () => client.workspaceCollaboration(workspaceId, ids.get("selected")!),
      /lacks durable createdAt|WORKSPACE_COLLABORATION_STALE/i
    );
  });
});

test("workspace.collaboration rejects duplicate identity for a current Delivery only", async () => {
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (_svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const nodeId = ids.get("user-delivery")!;
    const task = await writeTask(systemFs, {
      workNodeIds: [nodeId],
      roleId: "rl-executor",
      parentActor: { kind: "user", id: "user" },
    });
    const delivery = await readyDelivery(
      systemFs,
      task,
      nodeId,
      "Current unique candidate",
      "2026-01-01T00:00:00.000Z"
    );
    await createDelivery(systemFs, { now: () => "2020-01-01T00:00:00.000Z" }, {
      id: delivery.id,
      taskId: "tk-history",
      sourceNodeId: ids.get("history")!,
      deliveriesDir: "temp/roles/rl-parent/deliveries",
      summary: "Unrelated duplicate history",
      status: "accepted",
    });

    await assert.rejects(
      () => client.workspaceCollaboration(workspaceId, ids.get("selected")!),
      /Delivery identity is not unique|WORKSPACE_COLLABORATION_STALE/i
    );
  });
});

test("workspace.collaboration rejects selected ready Delivery from a foreign Node", async () => {
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (_svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const nodeId = ids.get("user-delivery")!;
    const task = await writeTask(systemFs, {
      workNodeIds: [nodeId],
      roleId: "rl-executor",
      parentActor: { kind: "role", id: "rl-parent" },
    });
    const delivery = await createDelivery(systemFs, new SystemClock(), {
      taskId: task.id!,
      sourceNodeId: ids.get("selected")!,
      deliveriesDir: "temp/roles/rl-executor/deliveries",
      summary: "Foreign source",
      status: "ready",
    });
    await patchTaskEnvelope(systemFs, task.path, {
      state: "delivered",
      activeDeliveryId: delivery.id,
    });

    await assert.rejects(
      () => client.workspaceCollaboration(workspaceId, nodeId),
      /foreign source Node|WORKSPACE_COLLABORATION_STALE/i
    );
  });
});
