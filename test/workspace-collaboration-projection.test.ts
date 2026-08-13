import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { contentEtag } from "../src/core/etag.js";
import { createTaskResult, writeTaskResult } from "../src/core/task-result.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import {
  loadTaskRecord,
  patchTaskRecord,
  writeTaskRecord,
  type TaskRecord,
} from "../src/core/task.js";
import { taskFail } from "../src/core/task-lifecycle.js";
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
      { name: "user-result", type: "prompt", body: "# TaskResult\n" },
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
    assigneeRoleId?: string;
    executionSessionId?: string;
    requester: { kind: "user" | "role"; id: string };
  }
): Promise<TaskRecord> {
  const taskPath = await writeTaskRecord(systemFs, new SystemClock(), {
    assigneeRoleId: input.assigneeRoleId,
    executionSessionId: input.executionSessionId,
    workNodeIds: input.workNodeIds,
    contextNodeIds: [],
    nodeSnapshots: input.workNodeIds.map(snapshot),
    manifestPath: "temp/test/manifest.yml",
    prompt: "projection fixture",
    requester: input.requester,
    acceptMode: "review-required",
  });
  return loadTaskRecord(systemFs, taskPath);
}

async function readyTaskResult(
  systemFs: NodeFs,
  task: TaskRecord,
  _nodeId: string,
  report: string,
  now: string
) {
  const result = await createTaskResult(systemFs, { now: () => now }, {
    taskId: task.id!,
    resultsDir: task.assigneeRoleId
      ? `temp/roles/${task.assigneeRoleId}/results`
      : `temp/sessions/${task.executionSessionId}/results`,
    report,
    status: "ready",
  });
  await patchTaskRecord(systemFs, task.path, {
    state: "submitted",
    currentResultId: result.id,
  });
  return result;
}

test("workspace.collaboration joins multi-Node Role work and only user-actionable Inbox", async () => {
  assert.ok(CLIENT_METHODS.includes("workspace.collaboration"));
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const selected = ids.get("selected")!;
    const child = ids.get("selected-child")!;
    const resultNode = ids.get("user-result")!;
    const decisionNode = ids.get("user-decision")!;

    const roleTask = await writeTask(systemFs, {
      workNodeIds: [selected, child],
      assigneeRoleId: "rl-executor",
      requester: { kind: "role", id: "rl-parent" },
    });
    const roleTaskResult = await readyTaskResult(
      systemFs,
      roleTask,
      selected,
      "Role review summary",
      "2026-01-01T00:00:00.000Z"
    );

    const userTaskResultTask = await writeTask(systemFs, {
      workNodeIds: [resultNode],
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    const userTaskResult = await readyTaskResult(
      systemFs,
      userTaskResultTask,
      resultNode,
      "User review summary",
      "2026-01-02T00:00:00.000Z"
    );

    const decisionSession = await client.sessionEnter({
      workspaceId,
      externalKey: "workspace-collaboration-decision",
      cwd: workspace,
    }) as { session: { sessionId: string } };
    const userDecisionTask = await writeTask(systemFs, {
      workNodeIds: [decisionNode],
      executionSessionId: decisionSession.session.sessionId,
      requester: { kind: "user", id: "user" },
    });
    await patchTaskRecord(systemFs, userDecisionTask.path, {
      state: "waiting",
      wait: {
        reason: "user-input",
        summary: "Need user choice",
        code: "decision_request:dr-0123456789",
      },
    });
    await svc.runtime.registry.update(decisionSession.session.sessionId, {
      currentTaskId: userDecisionTask.id,
    });
    const decision: PendingDecisionRequest = {
      id: "dr-0123456789",
      status: "pending",
      requester: { kind: "session", id: decisionSession.session.sessionId },
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
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    await createTaskResult(systemFs, { now: () => "2020-01-02T00:00:00.000Z" }, {
      taskId: staleReadyTask.id!,
      resultsDir: "temp/roles/rl-executor/results",
      report: "Stale ready history",
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

    // Historical non-actionable TaskResult is irrelevant even without a current Task.
    const acceptedHistory = await createTaskResult(systemFs, { now: () => "2020-01-01T00:00:00.000Z" }, {
      taskId: "tk-zzzzzzzz",
      resultsDir: "temp/roles/rl-executor/results",
      report: "Accepted history",
    });
    acceptedHistory.status = "accepted";
    acceptedHistory.review = { reviewer: "user", at: "2020-01-01T00:00:00.000Z" };
    await writeTaskResult(systemFs, acceptedHistory);

    const result = await client.workspaceCollaboration(
      workspaceId,
      child
    ) as WorkspaceCollaborationProjection;
    assert.deepEqual(result.selectedNode, {
      nodeId: child,
      activeTask: {
        taskId: roleTask.id,
        state: "submitted",
        responsibility: { kind: "role", roleId: "rl-parent", displayName: "Parent Role" },
        execution: { kind: "role", roleId: "rl-executor", displayName: "Executor Role" },
        readyResult: {
          resultId: roleTaskResult.id,
          summary: "Role review summary",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        pendingDecision: null,
      },
      statusDetail: null,
    });
    assert.deepEqual(result.inbox.counts, { result: 1, decision: 1, total: 2 });
    assert.deepEqual(result.inbox.items.map((item) => item.kind), ["result", "decision"]);
    assert.deepEqual(result.inbox.items[0], {
      kind: "result",
      resultId: userTaskResult.id,
      taskId: userTaskResultTask.id,
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
      "taskPath", "sessionId", "alive", "isTurnActive", "provider", "adapterId",
      "token", "commits", "targetHead", "name", "type", "mode",
    ]) {
      assert.equal(serialized.includes(`\"${forbidden}\"`), false, forbidden);
    }
  });
});
// End of workspace.collaboration projection coverage.

test("workspace.collaboration keeps the latest terminal failed return visible on its Node", async () => {
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const nodeId = ids.get("selected")!;
    const older = await writeTask(systemFs, {
      workNodeIds: [nodeId],
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    await patchTaskRecord(systemFs, older.path, {
      state: "failed",
      statusDetail: {
        kind: "failed",
        error: "older failure",
        at: "2026-01-01T01:00:00+02:00",
      },
      updatedAt: "2026-01-01T01:00:00+02:00",
    });
    const latest = await writeTask(systemFs, {
      workNodeIds: [nodeId],
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    await patchTaskRecord(systemFs, latest.path, {
      state: "running",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await taskFail(svc.ctx.host.require(workspaceId).env, latest.path, {
      error: "latest terminal failure",
      code: "EXPLICIT_FAILURE",
    });
    await patchTaskRecord(systemFs, latest.path, {
      updatedAt: "2025-12-31T23:30:00.000Z",
    });

    const result = await client.workspaceCollaboration(workspaceId, nodeId);
    assert.equal(result.selectedNode?.activeTask, null);
    assert.equal(result.selectedNode?.statusDetail?.taskId, latest.id);
    assert.equal(result.selectedNode?.statusDetail?.kind, "failed");
    assert.equal(result.selectedNode?.statusDetail?.error, "latest terminal failure");
    assert.equal(result.selectedNode?.statusDetail?.code, "EXPLICIT_FAILURE");
    assert.equal(
      result.selectedNode?.statusDetail?.taskId,
      latest.id,
      "numeric instant ordering must beat raw ISO offset lexicographic order"
    );

    const newerRunning = await writeTask(systemFs, {
      workNodeIds: [nodeId],
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    await patchTaskRecord(systemFs, newerRunning.path, {
      state: "running",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const current = await client.workspaceCollaboration(workspaceId, nodeId);
    assert.equal(current.selectedNode?.activeTask?.taskId, newerRunning.id);
    assert.equal(
      current.selectedNode?.statusDetail,
      null,
      "a newer Task without a return supersedes historical failure on the Node surface"
    );
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
      requester: { kind: "user", id: "user" },
    }) as { taskPath: string; executionSessionId: string };
    assert.ok(dispatched.taskPath);

    const result = await client.workspaceCollaboration(workspaceId, nodeId);
    assert.equal(result.selectedNode?.activeTask?.state, "running");
    assert.deepEqual(result.selectedNode?.activeTask?.responsibility, { kind: "user" });
    assert.deepEqual(result.selectedNode?.activeTask?.execution, {
      kind: "connection",
      connectionId: "fake-k",
      displayName: "Machine K",
    });

    await svc.runtime.registry.update(dispatched.executionSessionId, {
      currentTaskId: "tk-other",
    });
    await assert.rejects(
      () => client.workspaceCollaboration(workspaceId, nodeId),
      /WORKSPACE_COLLABORATION_STALE|consistency error/i
    );
  });
});

test("workspace.collaboration exposes only an exact live Decision wait binding", async () => {
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const entered = await client.sessionEnter({
      workspaceId,
      externalKey: "workspace-collaboration-decision-binding",
      cwd: workspace,
    }) as { session: { sessionId: string } };
    const nodeId = ids.get("user-decision")!;
    const task = await writeTask(systemFs, {
      workNodeIds: [nodeId],
      executionSessionId: entered.session.sessionId,
      requester: { kind: "user", id: "user" },
    });
    const requestId = "dr-binding001";
    await patchTaskRecord(systemFs, task.path, {
      state: "waiting",
      wait: { reason: "user-input", summary: "Choose", code: "decision_request:other" },
    });
    await svc.runtime.registry.update(entered.session.sessionId, { currentTaskId: task.id });
    await svc.ctx.decisionRequests.add({
      workspaceId,
      taskPath: task.path,
      request: {
        id: requestId,
        status: "pending",
        requester: { kind: "session", id: entered.session.sessionId },
        target: { kind: "user", id: "user" },
        taskId: task.id!,
        question: "Choose?",
        options: [],
      },
    });

    const stale = await client.workspaceCollaboration(workspaceId);
    assert.equal(stale.inbox.counts.decision, 0, "wrong wait identity is stale inventory");

    await patchTaskRecord(systemFs, task.path, {
      wait: { reason: "user-input", summary: "Choose", code: `decision_request:${requestId}` },
    });
    assert.equal((await client.workspaceCollaboration(workspaceId)).inbox.counts.decision, 1);

    await svc.runtime.registry.update(entered.session.sessionId, { state: "stopped" });
    assert.equal(
      (await client.workspaceCollaboration(workspaceId)).inbox.counts.decision,
      0,
      "a closed requester is historical, not an actionable or workspace-poisoning row"
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
      executionSessionId: entered.session.sessionId,
      requester: { kind: "user", id: "user" },
    });
    await patchTaskRecord(systemFs, task.path, { state: "running" });
    await svc.runtime.registry.update(entered.session.sessionId, {
      currentTaskId: task.id,
    });

    const result = await client.workspaceCollaboration(workspaceId, nodeId);
    assert.equal(result.selectedNode?.activeTask?.taskId, task.id);
    assert.deepEqual(result.selectedNode?.activeTask?.responsibility, { kind: "user" });
    assert.equal(result.selectedNode?.activeTask?.execution, null);
  });
});

test("workspace.collaboration fails closed when a current user TaskResult is missing", async () => {
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (_svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const resultNode = ids.get("user-result")!;
    const task = await writeTask(systemFs, {
      workNodeIds: [resultNode],
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    const result = await readyTaskResult(
      systemFs,
      task,
      resultNode,
      "Current summary",
      "2026-01-01T00:00:00.000Z"
    );
    await patchTaskRecord(systemFs, task.path, { currentResultId: "rs-missing" });
    await assert.rejects(
      () => client.workspaceCollaboration(workspaceId, ids.get("selected")!),
      /WORKSPACE_COLLABORATION_STALE|consistency error/i
    );
    await patchTaskRecord(systemFs, task.path, {
      state: "running",
      currentResultId: result.id,
    });
    await assert.rejects(
      () => client.workspaceCollaboration(workspaceId, resultNode),
      /User-reviewable Task Result identity is stale|ready Result outside submitted state/i
    );
  });
});

test("workspace.collaboration rejects current ready TaskResult without durable createdAt", async () => {
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (_svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const nodeId = ids.get("user-result")!;
    const task = await writeTask(systemFs, {
      workNodeIds: [nodeId],
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    const result = await readyTaskResult(
      systemFs,
      task,
      nodeId,
      "Missing timestamp",
      "2026-01-01T00:00:00.000Z"
    );
    const raw = await systemFs.readFile(result.path);
    await systemFs.writeFile(result.path, raw.replace(/^createdAt:.*\r?\n/m, ""));

    await assert.rejects(
      () => client.workspaceCollaboration(workspaceId, ids.get("selected")!),
      /Invalid Task Result format|lacks durable createdAt|Task Result identity is not unique|WORKSPACE_COLLABORATION_STALE/i
    );
  });
});

test("workspace.collaboration rejects duplicate identity for a current TaskResult only", async () => {
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (_svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const nodeId = ids.get("user-result")!;
    const task = await writeTask(systemFs, {
      workNodeIds: [nodeId],
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    const result = await readyTaskResult(
      systemFs,
      task,
      nodeId,
      "Current unique candidate",
      "2026-01-01T00:00:00.000Z"
    );
    const duplicateHistory = await createTaskResult(systemFs, { now: () => "2020-01-01T00:00:00.000Z" }, {
      id: result.id,
      taskId: "tk-history",
      resultsDir: "temp/roles/rl-parent/results",
      report: "Unrelated duplicate history",
    });
    duplicateHistory.status = "accepted";
    duplicateHistory.review = { reviewer: "user", at: "2020-01-01T00:00:00.000Z" };
    await writeTaskResult(systemFs, duplicateHistory);

    await assert.rejects(
      () => client.workspaceCollaboration(workspaceId, ids.get("selected")!),
      /Task Result identity is not unique|WORKSPACE_COLLABORATION_STALE/i
    );
  });
});

test("workspace.collaboration rejects a current Result stored outside its Task namespace", async () => {
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (_svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const nodeId = ids.get("user-result")!;
    const task = await writeTask(systemFs, {
      workNodeIds: [nodeId],
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    const wrongNamespace = await createTaskResult(
      systemFs,
      { now: () => "2026-01-01T00:00:00.000Z" },
      {
        taskId: task.id!,
        resultsDir: "temp/roles/rl-parent/results",
        report: "Wrong owner namespace",
        status: "ready",
      }
    );
    await patchTaskRecord(systemFs, task.path, {
      state: "submitted",
      currentResultId: wrongNamespace.id,
    });
    await assert.rejects(
      () => client.workspaceCollaboration(workspaceId),
      /Task Result identity is stale|WORKSPACE_COLLABORATION_STALE|consistency error/i
    );
  });
});
