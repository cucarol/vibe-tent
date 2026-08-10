import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadTaskEnvelope, loadTaskEnvelopes, taskAsSub } from "../src/core/task.js";
import { taskInterrupt } from "../src/core/task-lifecycle.js";
import { taskReferencedNodeIds } from "../src/core/task-node-refs.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient, type ServiceClient } from "../src/service/client.js";
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
          { id: "rl-planner", name: "planner", prompt: "plan" },
          { id: "rl-executor", name: "executor", prompt: "execute" },
          { id: "rl-orchestrator", name: "orchestrator", prompt: "review" },
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

async function enterRoleSession(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  workspace: string,
  roleId: string,
  lastTaskId?: string,
  externalKey?: string
): Promise<{ sessionId: string; client: ServiceClient }> {
  const entered = await rpc(svc, "session.enter", {
    workspaceId,
    roleId,
    cwd: workspace,
    ...(lastTaskId ? { lastTaskId } : {}),
    ...(externalKey ? { externalKey } : {}),
  });
  assert.ok(!entered.error, JSON.stringify(entered.error));
  const result = entered.result as {
    session: { sessionId: string };
    sessionToken: string;
  };
  return {
    sessionId: result.session.sessionId,
    client: createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: result.session.sessionId,
      currentSessionToken: result.sessionToken,
    }),
  };
}

test("Role direct claim creates one running Task with ordered Nodes and root user responsibility", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const tentFs = new NodeFs(path.join(workspace, ".tent"));
    const workspaceId = await mount(svc, workspace);
    const first = await createNode(svc, workspaceId, "first");
    const second = await createNode(svc, workspaceId, "second");
    const plannerSession = await enterRoleSession(svc, workspaceId, workspace, "rl-planner");
    const claimed = await plannerSession.client.rpcRaw("task.claimDirect", {
      workspaceId,
      roleId: "rl-planner",
      workNodeIds: [first, second],
      contextNodeIds: [],
      prompt: "own both Nodes",
    });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));
    const result = claimed.result as { taskPath: string; state: string };
    const task = await loadTaskEnvelope(tentFs, result.taskPath);
    assert.equal(result.state, "running");
    assert.equal(task.state, "running");
    assert.equal(task.roleId, "rl-planner");
    assert.equal(task.sessionId, plannerSession.sessionId);
    assert.equal(taskAsSub(task), false);
    assert.deepEqual(task.parentActor, { kind: "user", id: "user" });
    assert.doesNotMatch(await tentFs.readFile(task.path), /^reviewer:/m);
    assert.deepEqual(task.workNodeIds, [first, second]);
    assert.deepEqual(task.contextNodeIds, []);
    assert.deepEqual(task.contextCard.nodeSnapshots.map((snapshot) => snapshot.id), [first, second]);
    assert.deepEqual(taskReferencedNodeIds(task), [first, second]);

    const forbidden = await plannerSession.client.rpcRaw("task.claimDirect", {
      workspaceId,
      roleId: "rl-planner",
      workNodeIds: [second],
      contextNodeIds: [],
      prompt: "bad authority",
      parentActor: { kind: "role", id: "rl-planner" },
    });
    assert.equal(forbidden.error?.code, -32602);
    assert.equal((await loadTaskEnvelopes(tentFs)).length, 1);
  });
});

test("Role direct claim inherits persisted parentActor while real self-subdispatch stays rejected", async () => {
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
      workNodeIds: [parentNode],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "parent responsibility",
      parentActor: { kind: "role", id: "rl-orchestrator" },
    });
    assert.ok(!sourceDispatch.error, JSON.stringify(sourceDispatch.error));
    const sourcePath = (sourceDispatch.result as { taskPath: string }).taskPath;
    const executorSession = await enterRoleSession(
      svc,
      workspaceId,
      workspace,
      "rl-executor",
      undefined,
      "direct-responsibility-source"
    );
    await executorSession.client.taskClaim(workspaceId, sourcePath);
    // sourceTaskPath is responsibility provenance. A distinct exact Role
    // Session with no active Task may inherit it; the source Session itself may
    // not create a second active binding.
    const continuationSession = await enterRoleSession(
      svc,
      workspaceId,
      workspace,
      "rl-executor",
      undefined,
      "direct-responsibility-continuation"
    );
    const direct = await continuationSession.client.rpcRaw("task.claimDirect", {
      workspaceId,
      roleId: "rl-executor",
      workNodeIds: [ownNode],
      contextNodeIds: [],
      prompt: "executor owns this attempt",
      sourceTaskPath: sourcePath,
    });
    assert.ok(!direct.error, JSON.stringify(direct.error));
    const directTask = await loadTaskEnvelope(
      tentFs,
      (direct.result as { taskPath: string }).taskPath
    );
    assert.deepEqual(directTask.parentActor, { kind: "role", id: "rl-orchestrator" });
    assert.equal(taskAsSub(directTask), false);
    await taskInterrupt(svc.hostApi.require(workspaceId).env, directTask.path);

    const viaSession = await continuationSession.client.rpcRaw("task.claimDirect", {
      workspaceId,
      roleId: "rl-executor",
      workNodeIds: [sessionNode],
      contextNodeIds: [],
      prompt: "inherit via exact Session binding",
    });
    assert.ok(!viaSession.error, JSON.stringify(viaSession.error));
    const sessionTask = await loadTaskEnvelope(
      tentFs,
      (viaSession.result as { taskPath: string }).taskPath
    );
    assert.deepEqual(sessionTask.parentActor, { kind: "role", id: "rl-orchestrator" });

    const selfDispatch = await rpc(svc, "task.dispatch", {
      workspaceId,
      workNodeIds: [downstreamNode],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "not a direct claim",
      parentActor: { kind: "role", id: "rl-executor" },
      asSub: true,
    });
    assert.ok(selfDispatch.error);
    assert.match(selfDispatch.error!.message, /must not equal the assignee/i);
  });
});

test("Role task.claim trusts only exact live transport Session binding", async () => {
  const workspace = await makeWorkspace();
  const otherWorkspace = await makeWorkspace();
  await withService(async (svc) => {
    const tentFs = new NodeFs(path.join(workspace, ".tent"));
    const workspaceId = await mount(svc, workspace);
    const otherWorkspaceId = await mount(svc, otherWorkspace);
    const firstNode = await createNode(svc, workspaceId, "transport-first");
    const secondNode = await createNode(svc, workspaceId, "transport-second");
    const dispatchTask = async (nodeId: string) => {
      const dispatched = await rpc(svc, "task.dispatch", {
        workspaceId,
        workNodeIds: [nodeId],
        contextNodeIds: [],
        roleId: "rl-executor",
        prompt: `execute ${nodeId}`,
        parentActor: { kind: "user", id: "user" },
      });
      assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
      return (dispatched.result as { taskPath: string }).taskPath;
    };
    const firstPath = await dispatchTask(firstNode);
    const secondPath = await dispatchTask(secondNode);

    const unauthenticated = await rpc(svc, "task.claim", {
      workspaceId,
      taskPath: firstPath,
    });
    assert.equal(unauthenticated.error?.code, -32001);
    assert.equal((await loadTaskEnvelope(tentFs, firstPath)).state, "queued");

    const executor = await enterRoleSession(
      svc,
      workspaceId,
      workspace,
      "rl-executor",
      undefined,
      "transport-executor-a"
    );
    await executor.client.taskClaim(workspaceId, firstPath);
    const claimed = await loadTaskEnvelope(tentFs, firstPath);
    assert.equal(claimed.roleId, "rl-executor");
    assert.equal(claimed.sessionId, executor.sessionId);
    assert.equal((await svc.ctx.runtime.registry.read(executor.sessionId))?.lastTaskId, claimed.id);

    // The same trusted Session is idempotent; a different Session cannot steal it.
    await executor.client.taskClaim(workspaceId, firstPath);
    const otherExecutor = await enterRoleSession(
      svc,
      workspaceId,
      workspace,
      "rl-executor",
      undefined,
      "transport-executor-b"
    );
    const stolen = await otherExecutor.client.tryCall("task.claim", {
      workspaceId,
      taskPath: firstPath,
    });
    assert.equal(stolen.ok, false);
    if (!stolen.ok) assert.match(stolen.error.message, /different Session|already bound|replace the exact Session/i);

    const planner = await enterRoleSession(
      svc,
      workspaceId,
      workspace,
      "rl-planner"
    );
    const wrongRole = await planner.client.tryCall("task.claim", {
      workspaceId,
      taskPath: secondPath,
    });
    assert.equal(wrongRole.ok, false);
    if (!wrongRole.ok) assert.equal(wrongRole.error.code, -32001);

    const foreignExecutor = await enterRoleSession(
      svc,
      otherWorkspaceId,
      otherWorkspace,
      "rl-executor"
    );
    const wrongWorkspace = await foreignExecutor.client.tryCall("task.claim", {
      workspaceId,
      taskPath: secondPath,
    });
    assert.equal(wrongWorkspace.ok, false);
    if (!wrongWorkspace.ok) assert.equal(wrongWorkspace.error.code, -32001);

    const nativeEntered = await rpc(svc, "session.enter", {
      workspaceId,
      roleId: "rl-executor",
      externalKey: "native-claim-key",
      cwd: workspace,
    });
    assert.ok(!nativeEntered.error, JSON.stringify(nativeEntered.error));
    const nativeClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentExternalKey: "native-claim-key",
    });
    await nativeClient.taskClaim(workspaceId, secondPath);
    const second = await loadTaskEnvelope(tentFs, secondPath);
    assert.equal(second.sessionId, (nativeEntered.result as { session: { sessionId: string } }).session.sessionId);

    const missingNative = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentExternalKey: "missing-native-key",
    });
    const missing = await missingNative.tryCall("task.claim", {
      workspaceId,
      taskPath: secondPath,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, -32001);
  });
});

test("direct create+claim failure removes only its exact Task and manifest artifacts", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const tentFs = new NodeFs(path.join(workspace, ".tent"));
    const workspaceId = await mount(svc, workspace);
    const nodeId = await createNode(svc, workspaceId, "rollback-work");
    const secondNodeId = await createNode(svc, workspaceId, "rollback-existing-init");
    const plannerSession = await enterRoleSession(svc, workspaceId, workspace, "rl-planner");
    const executorSession = await enterRoleSession(svc, workspaceId, workspace, "rl-executor");
    setBeforeTaskClaimCoreForTests(async () => {
      throw new Error("forced direct claim failure");
    });
    const failed = await plannerSession.client.rpcRaw("task.claimDirect", {
      workspaceId,
      roleId: "rl-planner",
      workNodeIds: [nodeId],
      contextNodeIds: [],
      prompt: "must not strand queued state",
    });
    assert.ok(failed.error);
    assert.match(failed.error!.message, /forced direct claim failure/i);
    assert.deepEqual(await loadTaskEnvelopes(tentFs), []);
    const plannerRoot = path.join(workspace, ".tent", "temp", "roles", "rl-planner");
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

    const executorRoot = path.join(workspace, ".tent", "temp", "roles", "rl-executor");
    await fs.mkdir(executorRoot, { recursive: true });
    const executorInit = path.join(executorRoot, "init.md");
    const originalInit = "# pre-existing exact init\n";
    await fs.writeFile(executorInit, originalInit, "utf8");
    const secondFailure = await executorSession.client.rpcRaw("task.claimDirect", {
      workspaceId,
      roleId: "rl-executor",
      workNodeIds: [secondNodeId],
      contextNodeIds: [],
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
      workNodeIds: [priorNode],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "prior delegated work",
      parentActor: { kind: "role", id: "rl-orchestrator" },
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const priorPath = (dispatched.result as { taskPath: string }).taskPath;
    const executorSession = await enterRoleSession(
      svc,
      workspaceId,
      workspace,
      "rl-executor"
    );
    await executorSession.client.taskClaim(workspaceId, priorPath);
    assert.ok(!(await rpc(svc, "task.interrupt", { workspaceId, taskPath: priorPath })).error);
    const prior = await loadTaskEnvelope(tentFs, priorPath);
    assert.equal(prior.state, "interrupted");

    const nextExecutorSession = await enterRoleSession(
      svc,
      workspaceId,
      workspace,
      "rl-executor",
      prior.id
    );

    const next = await nextExecutorSession.client.rpcRaw("task.claimDirect", {
      workspaceId,
      roleId: "rl-executor",
      workNodeIds: [nextNode],
      contextNodeIds: [],
      prompt: "new root responsibility after terminal Task",
    });
    assert.ok(!next.error, JSON.stringify(next.error));
    const nextTask = await loadTaskEnvelope(
      tentFs,
      (next.result as { taskPath: string }).taskPath
    );
    assert.deepEqual(nextTask.parentActor, { kind: "role", id: "rl-orchestrator" });

    const missingSession = await enterRoleSession(
      svc,
      workspaceId,
      workspace,
      "rl-planner",
      "tk-missing-history"
    );
    const afterMissing = await missingSession.client.rpcRaw("task.claimDirect", {
      workspaceId,
      roleId: "rl-planner",
      workNodeIds: [missingNode],
      contextNodeIds: [],
      prompt: "new root responsibility after retained pointer was purged",
    });
    assert.ok(!afterMissing.error, JSON.stringify(afterMissing.error));
    const missingTask = await loadTaskEnvelope(
      tentFs,
      (afterMissing.result as { taskPath: string }).taskPath
    );
    assert.deepEqual(missingTask.parentActor, { kind: "user", id: "user" });
  });
});
