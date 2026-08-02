import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadTaskEnvelope, loadTaskEnvelopes, taskAsSub } from "../src/core/task.js";
import { taskReferencedNodeIds } from "../src/core/task-node-refs.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { rpcCall } from "../src/service/http-server.js";
import {
  setBeforeTaskClaimCoreForTests,
} from "../src/service/handlers.js";
import { startLocalTentService } from "../src/service/service.js";

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-direct-claim-"));
  const adapter = new NodeFs(workspace);
  await scaffoldInWorkspace(adapter, {
    name: "direct-claim",
    nodes: [{ name: "seed", type: "prompt", body: "# seed\n" }],
  });
  await adapter.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "planner", prompt: "plan" },
          { name: "executor", prompt: "execute" },
          { name: "orchestrator", prompt: "review" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-direct-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc);
  } finally {
    setBeforeTaskClaimCoreForTests(null);
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

async function mount(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspace: string
): Promise<string> {
  const result = await rpc(svc, "workspace.mount", { workspaceRoot: workspace });
  assert.ok(!result.error, JSON.stringify(result.error));
  return (result.result as { workspaceId: string }).workspaceId;
}

async function createNode(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  name: string
): Promise<string> {
  const result = await rpc(svc, "docs.createNote", {
    workspaceId,
    name,
    type: "prompt",
  });
  assert.ok(!result.error, JSON.stringify(result.error));
  return (result.result as { nodeId: string }).nodeId;
}

test("Role direct claim creates one running Task with ordered Nodes and root user responsibility", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const tentFs = new NodeFs(path.join(workspace, ".tent"));
    const workspaceId = await mount(svc, workspace);
    const first = await createNode(svc, workspaceId, "first");
    const second = await createNode(svc, workspaceId, "second");
    const claimed = await rpc(svc, "task.claimDirect", {
      workspaceId,
      role: "planner",
      nodeIds: [first, second, first],
      prompt: "own both Nodes",
    });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));
    const result = claimed.result as { taskPath: string; state: string };
    const task = await loadTaskEnvelope(tentFs, result.taskPath);
    assert.equal(result.state, "running");
    assert.equal(task.state, "running");
    assert.equal(task.assigneeKind, "role");
    assert.equal(task.assigneeId, "planner");
    assert.equal(taskAsSub(task), false);
    assert.deepEqual(task.parentActor, { kind: "user", id: "user" });
    assert.deepEqual(task.reviewer, { kind: "user", id: "user" });
    assert.deepEqual(taskReferencedNodeIds(task), [first, second]);

    const forbidden = await rpc(svc, "task.claimDirect", {
      workspaceId,
      role: "planner",
      nodeIds: [second],
      prompt: "bad authority",
      parentActor: { kind: "role", id: "planner" },
    });
    assert.equal(forbidden.error?.code, -32602);
    assert.equal((await loadTaskEnvelopes(tentFs)).length, 1);
  });
});

test("Role direct claim inherits persisted parent/reviewer while real self-subdispatch stays rejected", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const tentFs = new NodeFs(path.join(workspace, ".tent"));
    const workspaceId = await mount(svc, workspace);
    const parentNode = await createNode(svc, workspaceId, "parent-work");
    const ownNode = await createNode(svc, workspaceId, "own-work");
    const sessionNode = await createNode(svc, workspaceId, "session-work");
    const downstreamNode = await createNode(svc, workspaceId, "downstream-work");

    const sourceDispatch = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [parentNode],
      assigneeKind: "role",
      assigneeId: "executor",
      prompt: "parent responsibility",
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    assert.ok(!sourceDispatch.error, JSON.stringify(sourceDispatch.error));
    const sourcePath = (sourceDispatch.result as { taskPath: string }).taskPath;
    const sourceClaim = await rpc(svc, "task.claim", { workspaceId, taskPath: sourcePath });
    assert.ok(!sourceClaim.error, JSON.stringify(sourceClaim.error));
    const source = await loadTaskEnvelope(tentFs, sourcePath);

    const direct = await rpc(svc, "task.claimDirect", {
      workspaceId,
      role: "executor",
      nodeIds: [ownNode],
      prompt: "executor owns this attempt",
      sourceTaskPath: sourcePath,
    });
    assert.ok(!direct.error, JSON.stringify(direct.error));
    const directTask = await loadTaskEnvelope(
      tentFs,
      (direct.result as { taskPath: string }).taskPath
    );
    assert.deepEqual(directTask.parentActor, { kind: "role", id: "orchestrator" });
    assert.deepEqual(directTask.reviewer, { kind: "role", id: "orchestrator" });
    assert.equal(taskAsSub(directTask), false);

    const entered = await rpc(svc, "session.enter", {
      workspaceId,
      roleName: "executor",
      lastTaskId: source.id,
      cwd: workspace,
    });
    assert.ok(!entered.error, JSON.stringify(entered.error));
    const sessionId = (entered.result as { session: { sessionId: string } }).session.sessionId;
    const viaSession = await rpc(svc, "task.claimDirect", {
      workspaceId,
      role: "executor",
      nodeIds: [sessionNode],
      prompt: "inherit via exact Session binding",
      sourceSessionId: sessionId,
    });
    assert.ok(!viaSession.error, JSON.stringify(viaSession.error));
    const sessionTask = await loadTaskEnvelope(
      tentFs,
      (viaSession.result as { taskPath: string }).taskPath
    );
    assert.deepEqual(sessionTask.parentActor, { kind: "role", id: "orchestrator" });
    assert.deepEqual(sessionTask.reviewer, { kind: "role", id: "orchestrator" });

    const selfDispatch = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [downstreamNode],
      assigneeKind: "role",
      assigneeId: "executor",
      prompt: "not a direct claim",
      parentActor: { kind: "role", id: "executor" },
      reviewer: { kind: "role", id: "executor" },
      asSub: true,
    });
    assert.ok(selfDispatch.error);
    assert.match(selfDispatch.error!.message, /must not equal the assignee/i);
  });
});

test("direct create+claim failure removes only its exact Task and manifest artifacts", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const tentFs = new NodeFs(path.join(workspace, ".tent"));
    const workspaceId = await mount(svc, workspace);
    const nodeId = await createNode(svc, workspaceId, "rollback-work");
    const secondNodeId = await createNode(svc, workspaceId, "rollback-existing-init");
    setBeforeTaskClaimCoreForTests(async () => {
      throw new Error("forced direct claim failure");
    });
    const failed = await rpc(svc, "task.claimDirect", {
      workspaceId,
      role: "planner",
      nodeIds: [nodeId],
      prompt: "must not strand queued state",
    });
    assert.ok(failed.error);
    assert.match(failed.error!.message, /forced direct claim failure/i);
    assert.deepEqual(await loadTaskEnvelopes(tentFs), []);
    const plannerRoot = path.join(workspace, ".tent", "temp", "planner");
    assert.equal(
      await fs.stat(path.join(plannerRoot, "init.md")).then(() => true, () => false),
      false
    );
    assert.deepEqual(
      await fs.readdir(path.join(plannerRoot, "manifests")).catch(() => [] as string[]),
      []
    );
    assert.deepEqual(
      await fs.readdir(path.join(plannerRoot, "tasks")).catch(() => [] as string[]),
      []
    );

    const executorRoot = path.join(workspace, ".tent", "temp", "executor");
    await fs.mkdir(executorRoot, { recursive: true });
    const executorInit = path.join(executorRoot, "init.md");
    const originalInit = "# pre-existing exact init\n";
    await fs.writeFile(executorInit, originalInit, "utf8");
    const secondFailure = await rpc(svc, "task.claimDirect", {
      workspaceId,
      role: "executor",
      nodeIds: [secondNodeId],
      prompt: "restore existing init on failure",
    });
    assert.ok(secondFailure.error);
    assert.equal(await fs.readFile(executorInit, "utf8"), originalInit);
    assert.deepEqual(await loadTaskEnvelopes(tentFs), []);
    assert.deepEqual(
      await fs.readdir(path.join(executorRoot, "manifests")).catch(() => [] as string[]),
      []
    );
  });
});

test("open Role Session inherits terminal lastTask responsibility and tolerates missing history", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const tentFs = new NodeFs(path.join(workspace, ".tent"));
    const workspaceId = await mount(svc, workspace);
    const priorNode = await createNode(svc, workspaceId, "prior-terminal");
    const nextNode = await createNode(svc, workspaceId, "next-after-terminal");
    const missingNode = await createNode(svc, workspaceId, "next-after-missing");

    const dispatched = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [priorNode],
      assigneeKind: "role",
      assigneeId: "executor",
      prompt: "prior delegated work",
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const priorPath = (dispatched.result as { taskPath: string }).taskPath;
    assert.ok(!(await rpc(svc, "task.claim", { workspaceId, taskPath: priorPath })).error);
    assert.ok(!(await rpc(svc, "task.interrupt", { workspaceId, taskPath: priorPath })).error);
    const prior = await loadTaskEnvelope(tentFs, priorPath);
    assert.equal(prior.state, "interrupted");

    const entered = await rpc(svc, "session.enter", {
      workspaceId,
      roleName: "executor",
      lastTaskId: prior.id,
      cwd: workspace,
    });
    assert.ok(!entered.error, JSON.stringify(entered.error));
    const sessionId = (entered.result as { session: { sessionId: string } }).session.sessionId;
    const next = await rpc(svc, "task.claimDirect", {
      workspaceId,
      role: "executor",
      nodeIds: [nextNode],
      prompt: "new root responsibility after terminal Task",
      sourceSessionId: sessionId,
    });
    assert.ok(!next.error, JSON.stringify(next.error));
    const nextTask = await loadTaskEnvelope(
      tentFs,
      (next.result as { taskPath: string }).taskPath
    );
    assert.deepEqual(nextTask.parentActor, { kind: "role", id: "orchestrator" });
    assert.deepEqual(nextTask.reviewer, { kind: "role", id: "orchestrator" });

    const missingSession = await rpc(svc, "session.enter", {
      workspaceId,
      roleName: "planner",
      lastTaskId: "tk-missing-history",
      cwd: workspace,
    });
    assert.ok(!missingSession.error, JSON.stringify(missingSession.error));
    const missingSessionId = (missingSession.result as { session: { sessionId: string } }).session
      .sessionId;
    const afterMissing = await rpc(svc, "task.claimDirect", {
      workspaceId,
      role: "planner",
      nodeIds: [missingNode],
      prompt: "new root responsibility after retained pointer was purged",
      sourceSessionId: missingSessionId,
    });
    assert.ok(!afterMissing.error, JSON.stringify(afterMissing.error));
    const missingTask = await loadTaskEnvelope(
      tentFs,
      (afterMissing.result as { taskPath: string }).taskPath
    );
    assert.deepEqual(missingTask.parentActor, { kind: "user", id: "user" });
    assert.deepEqual(missingTask.reviewer, { kind: "user", id: "user" });
  });
});
