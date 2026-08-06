import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { loadDeliveries } from "../src/core/delivery.js";
import { dispatch } from "../src/core/ops.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadTaskEnvelope } from "../src/core/task.js";
import { taskClaim, taskDeliver } from "../src/core/task-lifecycle.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { makeSessionId } from "../src/runtime/index.js";
import { deriveSessionToken } from "../src/runtime/session-token.js";
import { createServiceClient, type ServiceClient } from "../src/service/client.js";
import { startLocalTentService } from "../src/service/service.js";

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-review-auth-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "review-authority",
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { id: "rl-executor", name: "executor", prompt: "execute" },
          { id: "rl-reviewer", name: "reviewer", prompt: "review" },
          { id: "rl-wrong", name: "wrong", prompt: "not reviewer" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>, workspace: string) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-review-auth-data-"));
  const workspace = await makeWorkspace();
  const svc = await startLocalTentService({
    dataDir,
    connections: [
      {
        connectionId: "fake-default",
        provider: "fake",
        adapterId: FAKE_ADAPTER_ID,
        fake: { waitForSignal: true },
      },
    ],
  });
  try {
    return await fn(svc, workspace);
  } finally {
    await svc.stop();
  }
}

type ReadyFixture = {
  workspaceId: string;
  taskPath: string;
  deliveryId: string;
};

async function makeReadyFixture(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  reviewer: { kind: "user" | "role"; id: string },
  label: string
): Promise<ReadyFixture> {
  const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
  const created = (await root.call("docs.createNote", {
    workspaceId,
    name: `review-${label}`,
    type: "prompt",
  })) as { nodeId: string };
  const mount = svc.hostApi.require(workspaceId);
  const task = await dispatch(mount.env, created.nodeId, {
    roleId: "rl-executor",
    parentActor: reviewer,
    reviewer,
    workNodeIds: [created.nodeId],
    contextNodeIds: [],
    userPrompt: `review authority ${label}`,
  });
  await taskClaim(mount.env, task.taskPath);
  const delivered = await taskDeliver(mount.env, task.taskPath, {
    summary: `ready ${label}`,
    commits: [],
  });
  return {
    workspaceId,
    taskPath: task.taskPath,
    deliveryId: delivered.delivery.id,
  };
}

async function snapshotReviewRows(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  fixture: ReadyFixture
): Promise<{ task: string; delivery: string }> {
  const mount = svc.hostApi.require(fixture.workspaceId);
  const task = await loadTaskEnvelope(mount.env.fs, fixture.taskPath);
  const delivery = (await loadDeliveries(mount.env.fs, { taskId: task.id || task.path })).find(
    (row) => row.id === fixture.deliveryId
  );
  assert.ok(delivery, "fixture requires exact ready Delivery");
  return {
    task: await mount.env.fs.readFile(fixture.taskPath),
    delivery: await mount.env.fs.readFile(delivery.path),
  };
}

async function assertReviewRejectedWithoutMutation(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  client: ServiceClient,
  fixture: ReadyFixture,
  action: "accept" | "reject",
  actor: string
): Promise<void> {
  const before = await snapshotReviewRows(svc, fixture);
  const result = await client.tryCall(`task.${action}`, {
    workspaceId: fixture.workspaceId,
    taskPath: fixture.taskPath,
    deliveryId: fixture.deliveryId,
    actor,
    ...(action === "reject" ? { resume: false } : {}),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, -32001);
  assert.match(String((result.error.data as { code?: string } | undefined)?.code), /^REVIEW_CALLER_/);
  assert.deepEqual(await snapshotReviewRows(svc, fixture), before);
}

async function enterRoleClient(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  workspace: string,
  roleId: string
): Promise<ServiceClient> {
  const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
  const entered = (await root.sessionEnter({
    workspaceId,
    roleId,
    cwd: workspace,
    externalKey: `review:${roleId}`,
  })) as { session: { sessionId: string }; sessionToken: string };
  return createServiceClient({
    baseUrl: svc.url,
    token: svc.token,
    currentSessionId: entered.session.sessionId,
    currentSessionToken: entered.sessionToken,
  });
}

test("review RPC authority: local user is derived and Session callers cannot impersonate user", async () => {
  await withService(async (svc, workspace) => {
    const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await root.mount(workspace)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;

    const local = await makeReadyFixture(svc, workspaceId, { kind: "user", id: "user" }, "local");
    const accepted = await root.tryCall("task.accept", {
      workspaceId,
      taskPath: local.taskPath,
      deliveryId: local.deliveryId,
      actor: "user",
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));

    const roleClient = await enterRoleClient(svc, workspaceId, workspace, "rl-reviewer");
    const roleSpoof = await makeReadyFixture(
      svc,
      workspaceId,
      { kind: "user", id: "user" },
      "role-spoof"
    );
    await assertReviewRejectedWithoutMutation(svc, roleClient, roleSpoof, "accept", "user");

    const managedSessionId = makeSessionId();
    await svc.runtime.reserveSession({
      sessionId: managedSessionId,
      connectionId: "fake-default",
      lastTaskId: "tk-review-authority",
      workspace: workspaceId,
      runtimeWorkspace: { cwd: workspace },
    });
    const managedClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: managedSessionId,
      currentSessionToken: deriveSessionToken(svc.token, managedSessionId),
    });
    const managedSpoof = await makeReadyFixture(
      svc,
      workspaceId,
      { kind: "user", id: "user" },
      "managed-spoof"
    );
    await assertReviewRejectedWithoutMutation(svc, managedClient, managedSpoof, "reject", "user");

    const keyOnly = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentExternalKey: "codex:unverified-reviewer",
    });
    const keySpoof = await makeReadyFixture(
      svc,
      workspaceId,
      { kind: "user", id: "user" },
      "key-spoof"
    );
    await assertReviewRejectedWithoutMutation(svc, keyOnly, keySpoof, "accept", "user");
  });
});

test("review RPC authority: only the exact external Role Session may accept or reject", async () => {
  await withService(async (svc, workspace) => {
    const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await root.mount(workspace)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const exact = await enterRoleClient(svc, workspaceId, workspace, "rl-reviewer");
    const wrong = await enterRoleClient(svc, workspaceId, workspace, "rl-wrong");

    const otherWorkspace = await makeWorkspace();
    const otherMounted = (await root.mount(otherWorkspace)) as { workspaceId: string };
    const crossWorkspace = await makeReadyFixture(
      svc,
      otherMounted.workspaceId,
      { kind: "role", id: "rl-reviewer" },
      "cross-workspace"
    );
    await assertReviewRejectedWithoutMutation(
      svc,
      exact,
      crossWorkspace,
      "accept",
      "rl-reviewer"
    );

    const rootSpoof = await makeReadyFixture(
      svc,
      workspaceId,
      { kind: "role", id: "rl-reviewer" },
      "root-role-spoof"
    );
    await assertReviewRejectedWithoutMutation(svc, root, rootSpoof, "accept", "rl-reviewer");

    const wrongRole = await makeReadyFixture(
      svc,
      workspaceId,
      { kind: "role", id: "rl-reviewer" },
      "wrong-role"
    );
    await assertReviewRejectedWithoutMutation(svc, wrong, wrongRole, "reject", "rl-reviewer");

    const acceptedFixture = await makeReadyFixture(
      svc,
      workspaceId,
      { kind: "role", id: "rl-reviewer" },
      "exact-accept"
    );
    const accepted = await exact.tryCall("task.accept", {
      workspaceId,
      taskPath: acceptedFixture.taskPath,
      deliveryId: acceptedFixture.deliveryId,
      actor: "rl-reviewer",
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));

    const rejectedFixture = await makeReadyFixture(
      svc,
      workspaceId,
      { kind: "role", id: "rl-reviewer" },
      "exact-reject"
    );
    const rejected = await exact.tryCall("task.reject", {
      workspaceId,
      taskPath: rejectedFixture.taskPath,
      deliveryId: rejectedFixture.deliveryId,
      actor: "rl-reviewer",
      resume: false,
    });
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
  });
});
