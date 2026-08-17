import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { PendingDecisionRequest } from "../src/core/decision-request.js";
import { contentEtag } from "../src/core/etag.js";
import { createTaskResult, writeTaskResult } from "../src/core/task-result.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadTaskRecord, patchTaskRecord, writeTaskRecord, type TaskRecord } from "../src/core/task.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import type { AgentConnectionConfig } from "../src/runtime/agent-connection.js";
import { NodeFs, SystemClock } from "../src/fs/node-fs.js";
import { createServiceClient } from "../src/service/client.js";
import { startLocalTentService } from "../src/service/service.js";
import { CLIENT_METHODS, type WorkspaceCollaborationProjection } from "../src/service/types.js";

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
  return { id, path: `${id}.md`, type: "prompt", tags: [], body, etag: contentEtag(body), archived: false };
}

async function writeTask(
  systemFs: NodeFs,
  input: {
    nodeIds: string[];
    assigneeRoleId?: string;
    executionSessionId?: string;
    requester: { kind: "user" | "role"; id: string };
  }
): Promise<TaskRecord> {
  const taskPath = await writeTaskRecord(systemFs, new SystemClock(), {
    assigneeRoleId: input.assigneeRoleId,
    executionSessionId: input.executionSessionId,
    nodeIds: [...input.nodeIds],
    nodeSnapshots: input.nodeIds.map(snapshot),
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

test("workspace.collaboration joins activeTasks[] plus only current user-actionable inbox rows", async () => {
  assert.ok(CLIENT_METHODS.includes("workspace.collaboration"));
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const selected = ids.get("selected")!;
    const child = ids.get("selected-child")!;
    const resultNode = ids.get("user-result")!;

    const roleTask = await writeTask(systemFs, {
      nodeIds: [selected, child],
      assigneeRoleId: "rl-executor",
      requester: { kind: "role", id: "rl-parent" },
    });
    const roleTaskResult = await readyTaskResult(
      systemFs,
      roleTask,
      "Role review summary",
      "2026-01-01T00:00:00.000Z"
    );

    const userTask = await writeTask(systemFs, {
      nodeIds: [resultNode],
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    const userResult = await readyTaskResult(
      systemFs,
      userTask,
      "User review summary",
      "2026-01-02T00:00:00.000Z"
    );

    const promptOnlyDecisionSession = await client.sessionEnter({
      workspaceId,
      externalKey: "workspace-collaboration-decision",
      cwd: workspace,
    }) as { session: { sessionId: string } };
    const promptOnlyDecisionTask = await writeTask(systemFs, {
      nodeIds: [],
      executionSessionId: promptOnlyDecisionSession.session.sessionId,
      requester: { kind: "user", id: "user" },
    });
    await patchTaskRecord(systemFs, promptOnlyDecisionTask.path, {
      state: "waiting",
      wait: {
        reason: "user-input",
        summary: "Need user choice",
        code: "decision_request:dr-0123456789",
      },
    });
    await svc.runtime.registry.update(promptOnlyDecisionSession.session.sessionId, {
      currentTaskId: promptOnlyDecisionTask.id,
    });
    const decision: PendingDecisionRequest = {
      id: "dr-0123456789",
      status: "pending",
      requester: { kind: "session", id: promptOnlyDecisionSession.session.sessionId },
      target: { kind: "user", id: "user" },
      taskId: promptOnlyDecisionTask.id!,
      question: "Choose one?",
      options: [{ id: "yes", label: "Yes" }],
    };
    await svc.ctx.decisionRequests.add({
      workspaceId,
      taskPath: promptOnlyDecisionTask.path,
      request: decision,
    });

    const staleReadyTask = await writeTask(systemFs, {
      nodeIds: [ids.get("history")!],
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    await createTaskResult(systemFs, { now: () => "2020-01-02T00:00:00.000Z" }, {
      taskId: staleReadyTask.id!,
      resultsDir: "temp/roles/rl-executor/results",
      report: "Stale ready history",
      status: "ready",
    });

    const acceptedHistory = await createTaskResult(systemFs, { now: () => "2020-01-01T00:00:00.000Z" }, {
      taskId: "tk-zzzzzzzz",
      resultsDir: "temp/roles/rl-executor/results",
      report: "Accepted history",
    });
    acceptedHistory.status = "accepted";
    acceptedHistory.review = { reviewer: "user", at: "2020-01-01T00:00:00.000Z" };
    await writeTaskResult(systemFs, acceptedHistory);

    const result = await client.workspaceCollaboration(workspaceId, child) as WorkspaceCollaborationProjection;
    assert.deepEqual(result.selectedNode, {
      nodeId: child,
      activeTasks: [{
        taskId: roleTask.id!,
        state: "submitted",
        responsibility: { kind: "role", roleId: "rl-parent", displayName: "Parent Role" },
        execution: { kind: "role", roleId: "rl-executor", displayName: "Executor Role" },
        readyResult: {
          resultId: roleTaskResult.id,
          summary: "Role review summary",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        pendingDecision: null,
      }],
      statusDetail: null,
    });
    assert.deepEqual(result.inbox.counts, { result: 1, decision: 1, total: 2 });
    assert.deepEqual(result.inbox.items.map((item) => item.kind), ["result", "decision"]);
    assert.deepEqual(result.inbox.items[0], {
      kind: "result",
      resultId: userResult.id,
      taskId: userTask.id!,
      summary: "User review summary",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    assert.equal(result.inbox.items[1]?.kind, "decision");
    assert.equal((result.inbox.items[1] as { requestId: string }).requestId, decision.id);
  });
});

test("workspace.collaboration keeps latest failed statusDetail until a newer active Task supersedes it", async () => {
  const { workspace, systemFs, ids } = await makeWorkspace();
  await withService(async (_svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const nodeId = ids.get("selected")!;
    const older = await writeTask(systemFs, {
      nodeIds: [nodeId],
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
      nodeIds: [nodeId],
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    await patchTaskRecord(systemFs, latest.path, {
      state: "failed",
      statusDetail: {
        kind: "failed",
        error: "latest terminal failure",
        at: "2026-01-01T01:30:00.000Z",
      },
      updatedAt: "2026-01-01T01:30:00.000Z",
    });

    const failed = await client.workspaceCollaboration(workspaceId, nodeId);
    assert.deepEqual(failed.selectedNode?.activeTasks, []);
    assert.equal(failed.selectedNode?.statusDetail?.taskId, latest.id);
    assert.equal(failed.selectedNode?.statusDetail?.kind, "failed");
    assert.equal(failed.selectedNode?.statusDetail?.error, "latest terminal failure");

    const newerRunning = await writeTask(systemFs, {
      nodeIds: [nodeId],
      assigneeRoleId: "rl-executor",
      requester: { kind: "user", id: "user" },
    });
    await patchTaskRecord(systemFs, newerRunning.path, {
      state: "running",
      updatedAt: "2026-01-01T02:00:00.000Z",
    });
    const current = await client.workspaceCollaboration(workspaceId, nodeId);
    assert.equal(current.selectedNode?.activeTasks[0]?.taskId, newerRunning.id);
    assert.equal(current.selectedNode?.statusDetail, null);
  });
});

test("workspace.collaboration projects connection execution on selected activeTasks", async () => {
  const { workspace, ids } = await makeWorkspace();
  await withService(async (_svc, client) => {
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const nodeId = ids.get("connection")!;
    const dispatched = await client.taskDispatch(workspaceId, {
      nodeIds: [nodeId],
      connectionId: FAKE_CONNECTION.connectionId,
      prompt: "connection execution",
      requester: { kind: "user", id: "user" },
    });
    assert.ok((dispatched as { taskPath?: string }).taskPath);

    const result = await client.workspaceCollaboration(workspaceId, nodeId);
    assert.equal(result.selectedNode?.activeTasks[0]?.state, "running");
    assert.deepEqual(result.selectedNode?.activeTasks[0]?.responsibility, { kind: "user" });
    assert.deepEqual(result.selectedNode?.activeTasks[0]?.execution, {
      kind: "connection",
      connectionId: "fake-k",
      displayName: "Machine K",
    });
  });
});
