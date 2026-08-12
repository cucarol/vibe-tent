import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import {
  loadDeliveries,
  sessionDeliveryPath,
  writeDelivery,
} from "../src/core/delivery.js";
import { dispatch } from "../src/core/ops.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadTaskEnvelope, patchTaskEnvelope } from "../src/core/task.js";
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
  parentActor: { kind: "user" | "role"; id: string },
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
    parentActor,
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
    const legacyBefore = await snapshotReviewRows(svc, local);
    for (const method of ["task.accept", "task.reject"] as const) {
      for (const retired of [
        { taskPath: local.taskPath },
        { taskId: "tk-retired" },
      ]) {
        const legacy = await root.tryCall(method, {
          workspaceId,
          deliveryId: local.deliveryId,
          actor: "user",
          ...(method === "task.reject" ? { resume: false } : {}),
          ...retired,
        });
        assert.equal(legacy.ok, false);
        if (!legacy.ok) assert.equal(legacy.error.code, -32602);
        assert.deepEqual(await snapshotReviewRows(svc, local), legacyBefore);
      }
    }
    const accepted = await root.tryCall("task.accept", {
      workspaceId,
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
      deliveryId: rejectedFixture.deliveryId,
      actor: "rl-reviewer",
      resume: false,
    });
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
  });
});

test("review RPC fails closed when one Delivery id binds multiple canonical Tasks", async () => {
  await withService(async (svc, workspace) => {
    const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId } = (await root.mount(workspace)) as { workspaceId: string };
    const first = await makeReadyFixture(
      svc,
      workspaceId,
      { kind: "user", id: "user" },
      "duplicate-first"
    );
    const second = await makeReadyFixture(
      svc,
      workspaceId,
      { kind: "user", id: "user" },
      "duplicate-second"
    );
    const mount = svc.hostApi.require(workspaceId);
    await patchTaskEnvelope(mount.env.fs, second.taskPath, {
      activeDeliveryId: first.deliveryId,
    });
    const beforeFirst = await snapshotReviewRows(svc, first);
    const beforeSecondTask = await mount.env.fs.readFile(second.taskPath);
    const response = await root.tryCall("task.reject", {
      workspaceId,
      deliveryId: first.deliveryId,
      actor: "user",
      resume: false,
    });
    assert.equal(response.ok, false);
    if (!response.ok) {
      assert.equal(
        (response.error.data as { code?: string } | undefined)?.code,
        "REVIEW_DELIVERY_TASK_NOT_UNIQUE"
      );
    }
    assert.deepEqual(await snapshotReviewRows(svc, first), beforeFirst);
    assert.equal(await mount.env.fs.readFile(second.taskPath), beforeSecondTask);
  });
});

test("review RPC requires one exact Delivery record and one canonical Task identity", async () => {
  await withService(async (svc, workspace) => {
    const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId } = (await root.mount(workspace)) as { workspaceId: string };
    const fixture = await makeReadyFixture(
      svc,
      workspaceId,
      { kind: "user", id: "user" },
      "strict-delivery"
    );
    const mount = svc.hostApi.require(workspaceId);
    const task = await loadTaskEnvelope(mount.env.fs, fixture.taskPath);
    const delivery = (await loadDeliveries(mount.env.fs, { taskId: task.id })).find(
      (row) => row.id === fixture.deliveryId
    );
    assert.ok(delivery);
    const before = await snapshotReviewRows(svc, fixture);

    const uppercaseRequest = await root.tryCall("task.accept", {
      workspaceId,
      deliveryId: fixture.deliveryId.toUpperCase(),
      actor: "user",
    });
    assert.equal(uppercaseRequest.ok, false);
    if (!uppercaseRequest.ok) assert.equal(uppercaseRequest.error.code, -32602);
    assert.deepEqual(await snapshotReviewRows(svc, fixture), before);

    const duplicatePath = sessionDeliveryPath("ss-review-duplicate", fixture.deliveryId);
    await writeDelivery(mount.env.fs, { ...delivery, path: duplicatePath });
    const duplicate = await root.tryCall("task.accept", {
      workspaceId,
      deliveryId: fixture.deliveryId,
      actor: "user",
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) {
      assert.equal(
        (duplicate.error.data as { deliveryMatches?: number } | undefined)?.deliveryMatches,
        2
      );
    }
    assert.deepEqual(await snapshotReviewRows(svc, fixture), before);
    await mount.env.fs.remove(duplicatePath);

    const duplicateTaskPath = fixture.taskPath.replace(/\.md$/, "-duplicate-id.md");
    const duplicateTaskRaw = (await mount.env.fs.readFile(fixture.taskPath)).replace(
      `activeDeliveryId: ${fixture.deliveryId}`,
      "activeDeliveryId: dl-unrelated"
    );
    await mount.env.fs.writeFile(duplicateTaskPath, duplicateTaskRaw);
    const duplicateTask = await root.tryCall("task.reject", {
      workspaceId,
      deliveryId: fixture.deliveryId,
      actor: "user",
      resume: false,
    });
    assert.equal(duplicateTask.ok, false);
    assert.deepEqual(await snapshotReviewRows(svc, fixture), before);
    await mount.env.fs.remove(duplicateTaskPath);

    const duplicateAlias = sessionDeliveryPath("ss-review-alias", "dl-alias");
    await writeDelivery(mount.env.fs, { ...delivery, path: duplicateAlias });
    const aliasRejected = await root.tryCall("task.accept", {
      workspaceId,
      deliveryId: fixture.deliveryId,
      actor: "user",
    });
    assert.equal(aliasRejected.ok, false);
    assert.deepEqual(await snapshotReviewRows(svc, fixture), before);
    await mount.env.fs.remove(duplicateAlias);

    const malformedAlias = sessionDeliveryPath("ss-review-malformed-alias", "dl-alias");
    await mount.env.fs.writeFile(
      malformedAlias,
      [
        "---",
        "type: delivery",
        `id: ${fixture.deliveryId}`,
        `taskId: ${task.id}`,
        `sourceNodeId: ${delivery.sourceNodeId}`,
        "status: broken",
        "---",
        "corrupt target-claiming body",
        "",
      ].join("\n")
    );
    const malformedAliasRejected = await root.tryCall("task.reject", {
      workspaceId,
      deliveryId: fixture.deliveryId,
      actor: "user",
      resume: false,
    });
    assert.equal(malformedAliasRejected.ok, false);
    assert.deepEqual(await snapshotReviewRows(svc, fixture), before);
    await mount.env.fs.remove(malformedAlias);

    const canonicalMismatch = sessionDeliveryPath("ss-review-mismatch", fixture.deliveryId);
    await writeDelivery(mount.env.fs, {
      ...delivery,
      path: canonicalMismatch,
      id: "dl-other",
    });
    const mismatchRejected = await root.tryCall("task.accept", {
      workspaceId,
      deliveryId: fixture.deliveryId,
      actor: "user",
    });
    assert.equal(mismatchRejected.ok, false);
    assert.deepEqual(await snapshotReviewRows(svc, fixture), before);
    await mount.env.fs.remove(canonicalMismatch);

    const uppercaseExtension = sessionDeliveryPath(
      "ss-review-uppercase-extension",
      fixture.deliveryId
    ).replace(/\.md$/, ".MD");
    await writeDelivery(mount.env.fs, { ...delivery, path: uppercaseExtension });
    const uppercaseExtensionRejected = await root.tryCall("task.accept", {
      workspaceId,
      deliveryId: fixture.deliveryId,
      actor: "user",
    });
    assert.equal(uppercaseExtensionRejected.ok, false);
    assert.deepEqual(await snapshotReviewRows(svc, fixture), before);
    await mount.env.fs.remove(uppercaseExtension);

    const exactDeliveryRaw = await mount.env.fs.readFile(delivery.path);
    const taskBeforeMalformedTarget = await mount.env.fs.readFile(fixture.taskPath);
    await mount.env.fs.writeFile(delivery.path, "malformed exact target\n");
    const malformedTarget = await root.tryCall("task.reject", {
      workspaceId,
      deliveryId: fixture.deliveryId,
      actor: "user",
      resume: false,
    });
    assert.equal(malformedTarget.ok, false);
    assert.equal(await mount.env.fs.readFile(fixture.taskPath), taskBeforeMalformedTarget);
    await mount.env.fs.writeFile(delivery.path, exactDeliveryRaw);

    const unrelatedMalformed = sessionDeliveryPath("ss-review-unrelated", "dl-unrelated");
    await mount.env.fs.writeFile(unrelatedMalformed, "not a Delivery\n");
    const unrelatedLarge = sessionDeliveryPath("ss-review-unrelated", "dl-large");
    await writeDelivery(mount.env.fs, {
      ...delivery,
      path: unrelatedLarge,
      id: "dl-large",
      summary: "x".repeat(4 * 1024 * 1024),
    });
    const originalReadFile = mount.env.fs.readFile.bind(mount.env.fs);
    mount.env.fs.readFile = async (inputPath) => {
      if (inputPath === unrelatedMalformed || inputPath === unrelatedLarge) {
        throw new Error(`unrelated Delivery body must stay unread: ${inputPath}`);
      }
      return originalReadFile(inputPath);
    };
    try {
      const accepted = await root.tryCall("task.accept", {
        workspaceId,
        deliveryId: fixture.deliveryId,
        actor: "user",
      });
      assert.equal(accepted.ok, true, JSON.stringify(accepted));
    } finally {
      mount.env.fs.readFile = originalReadFile;
    }
  });
});
