/**
 * A Session is the host relationship for a delegated agent. Responsibility
 * remains the requester and assignee fields on the exact Task.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadTaskRecords } from "../src/core/task.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { createServiceClient } from "../src/service/client.js";

test("task.dispatch persists requester and assignee as the canonical responsibility facts", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-dispatch-"));
  const fsAdapter = new NodeFs(workspace);
  await scaffoldInWorkspace(fsAdapter, {
    name: "dispatch",
    nodes: [{ name: "work", body: "# Work\n" }],
  });
  await fsAdapter.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [
      { id: "rl-helper", name: "helper", prompt: "help" },
      { id: "rl-other", name: "other", prompt: "other" },
    ] }) + "\n"
  );
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-dispatch-data-"));
  const service = await startLocalTentService({ dataDir, writeEndpoint: false });
  try {
    const client = createServiceClient({ baseUrl: service.url, token: service.token });
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const node = await client.docsCreateNote(workspaceId, { name: "extra" });
    const dispatched = await client.taskDispatch(workspaceId, {
      nodeIds: [node.nodeId],
      assigneeRoleId: "rl-helper",
      prompt: "delegate this work",
      requester: { kind: "user", id: "user" },
    }) as { taskPath: string };
    const got = await client.taskGet(workspaceId, dispatched.taskPath) as {
      task: { requester: { kind: string; id: string }; assigneeRoleId?: string };
    };
    assert.deepEqual(got.task.requester, { kind: "user", id: "user" });
    assert.equal(got.task.assigneeRoleId, "rl-helper");
    assert.deepEqual(Object.keys(got.task).filter((key) => /sub/i.test(key)), []);
  } finally {
    await service.stop();
  }
});

test("task.dispatch binds only Role requester authority to the exact Role Session", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-dispatch-authority-"));
  const fsAdapter = new NodeFs(workspace);
  await scaffoldInWorkspace(fsAdapter, {
    name: "dispatch-authority",
    nodes: [
      { name: "one", body: "# One\n" },
      { name: "two", body: "# Two\n" },
    ],
  });
  await fsAdapter.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [
      { id: "rl-helper", name: "helper", prompt: "help" },
      { id: "rl-other", name: "other", prompt: "other" },
    ] }) + "\n"
  );
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-dispatch-authority-data-"));
  const service = await startLocalTentService({ dataDir, writeEndpoint: false });
  try {
    const local = createServiceClient({ baseUrl: service.url, token: service.token });
    const { workspaceId } = await local.mount(workspace) as { workspaceId: string };
    const created = await local.docsCreateNote(workspaceId, { name: "authority-work" });
    const systemFs = new NodeFs(path.join(workspace, ".tent"));
    const taskCount = async () => (await loadTaskRecords(systemFs)).length;
    const registryCount = async () => (await service.ctx.runtime.registry.list()).length;

    await assert.rejects(
      () => local.taskDispatch(workspaceId, {
        nodeIds: [created.nodeId],
        assigneeRoleId: "rl-helper",
        prompt: "impersonate helper",
        requester: { kind: "role", id: "rl-helper" },
      }),
      /trusted current Role Session context|REQUESTER_TRANSPORT/i
    );
    assert.equal(await taskCount(), 0);
    assert.equal(await registryCount(), 0);

    const entered = await local.sessionEnter({
      workspaceId,
      roleId: "rl-helper",
      cwd: workspace,
      externalKey: "dispatch-authority-helper",
    }) as { session: { sessionId: string }; sessionToken: string };
    const helper = createServiceClient({
      baseUrl: service.url,
      token: service.token,
      currentSessionId: entered.session.sessionId,
      currentSessionToken: entered.sessionToken,
    });
    const userNode = await local.docsCreateNote(workspaceId, { name: "user-requested-work" });
    const roleNode = await local.docsCreateNote(workspaceId, { name: "role-requested-work" });
    const userRequested = await helper.taskDispatch(workspaceId, {
      nodeIds: [userNode.nodeId],
      assigneeRoleId: "rl-helper",
      prompt: "ordinary attached Session may create a user-requested Task",
      requester: { kind: "user", id: "user" },
    }) as { taskPath: string };
    assert.ok(userRequested.taskPath);
    const beforeFailures = await taskCount();
    await assert.rejects(
      () => helper.taskDispatch(workspaceId, {
        nodeIds: [roleNode.nodeId],
        assigneeRoleId: "rl-other",
        prompt: "impersonate another role",
        requester: { kind: "role", id: "rl-other" },
      }),
      /exact live workspace\/Role binding|REQUESTER_TRANSPORT/i
    );
    assert.equal(await taskCount(), beforeFailures);
    assert.equal(await registryCount(), 1);

    const dispatched = await helper.taskDispatch(workspaceId, {
      nodeIds: [roleNode.nodeId],
      assigneeRoleId: "rl-helper",
      prompt: "authorized self dispatch",
      requester: { kind: "role", id: "rl-helper" },
    }) as { taskPath: string };
    assert.ok(dispatched.taskPath);
    assert.equal(await taskCount(), beforeFailures + 1);
  } finally {
    await service.stop();
  }
});
