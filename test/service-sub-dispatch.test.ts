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
    JSON.stringify({ roles: [{ id: "rl-helper", name: "helper", prompt: "help" }] }) + "\n"
  );
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-dispatch-data-"));
  const service = await startLocalTentService({ dataDir, writeEndpoint: false });
  try {
    const client = createServiceClient({ baseUrl: service.url, token: service.token });
    const { workspaceId } = await client.mount(workspace) as { workspaceId: string };
    const node = await client.docsCreateNote(workspaceId, { name: "extra" });
    const dispatched = await client.taskDispatch(workspaceId, {
      workNodeIds: [node.nodeId],
      contextNodeIds: [],
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
