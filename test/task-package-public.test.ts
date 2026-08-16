import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runTaskCommand } from "../src/cli/task-rpc.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadTaskRecord, taskPackageForTask } from "../src/core/task.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createServiceClient } from "../src/service/client.js";
import { rpcCall } from "../src/service/http-server.js";
import { startLocalTentService } from "../src/service/service.js";

test("task package exports canonical bytes through typed client and CLI without mutation", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-task-package-data-"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tent-task-package-ws-"));
  const workspaceFs = new NodeFs(root);
  await scaffoldInWorkspace(workspaceFs, {
    name: "task-package",
    nodes: [
      { name: "work", type: "prompt", body: "# Work\n\nFrozen work body.\n" },
      { name: "context", type: "reference", body: "# Context\n\nFrozen context body.\n" },
    ],
  });
  await workspaceFs.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [{ id: "rl-native", name: "native", prompt: "work" }] }) + "\n"
  );

  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const call = (method: string, params?: Record<string, unknown>) =>
      rpcCall(svc.url, method, params, { token: svc.token });
    const mounted = await call("workspace.mount", { workspaceRoot: root });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const listed = await call("docs.list", { workspaceId });
    assert.ok(!listed.error, JSON.stringify(listed.error));
    const nodes = (listed.result as { nodes: Array<{ nodeId: string; name: string }> }).nodes;
    const workNodeId = nodes.find((node) => node.name === "work")!.nodeId;
    const contextNodeId = nodes.find((node) => node.name === "context")!.nodeId;
    const dispatched = await call("task.dispatch", {
      workspaceId,
      workNodeIds: [workNodeId],
      contextNodeIds: [contextNodeId],
      assigneeRoleId: "rl-native",
      prompt: "Use the frozen package and return one Result.",
      requester: { kind: "user", id: "user" },
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    const systemFs = new NodeFs(path.join(root, ".tent"));
    const before = await systemFs.readFile(taskPath);
    const persistedTask = await loadTaskRecord(systemFs, taskPath);
    const canonical = taskPackageForTask(persistedTask);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    const got = await client.taskGet(workspaceId, taskPath);
    assert.equal(got.task.id, persistedTask.id);
    assert.equal("taskPackage" in got, false);
    const exported = await client.taskPackage(workspaceId, taskPath);
    assert.equal(exported.taskPackage, canonical);

    const cli = await runTaskCommand("package", [taskPath], {
      client,
      cwd: root,
    });
    assert.equal(cli.exitCode, 0, cli.stderr);
    assert.equal(cli.stdout, canonical);
    assert.equal(await systemFs.readFile(taskPath), before);
  } finally {
    await svc.stop();
  }
});
