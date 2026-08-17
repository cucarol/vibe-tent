import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { archiveNode, createNode, deleteArchivedNode, dispatch, moveNode, renameNode } from "../src/core/ops.js";
import { taskPackageForTask, loadTaskRecord } from "../src/core/task.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import type { FsAdapter } from "../src/core/adapter.js";

function envFor(fsAdapter: FsAdapter) {
  return {
    fs: fsAdapter,
    clock: { now: () => "2026-08-01T00:00:00.000Z" },
    tentName: "structural-independence",
  };
}

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-node-refs-"));
  const fsAdapter = new NodeFs(dir);
  await scaffoldTent(fsAdapter, { name: "structural-independence" });
  return { dir, fs: fsAdapter, env: envFor(fsAdapter) };
}

test("frozen Task snapshots stay byte-identical while current Node structure changes", async () => {
  const { fs: fsAdapter, env } = await makeWorkspace();
  const parentId = await createNode(env as any, {
    parentPath: "",
    name: "parent",
    type: "prompt",
  });
  const childId = await createNode(env as any, {
    parentPath: "parent",
    name: "child",
    type: "prompt",
  });
  const destinationId = await createNode(env as any, {
    parentPath: "",
    name: "destination",
    type: "prompt",
  });

  const dispatched = await dispatch(env as any, {
    executionSessionId: "ss-reviewer",
    nodeIds: [parentId],
    prompt: "freeze the subtree",
    requester: { kind: "user", id: "user" },
  });
  const initial = await loadTaskRecord(fsAdapter, dispatched.taskPath);
  const expectedPackage = taskPackageForTask(initial);
  assert.deepEqual(initial.contextCard.nodeSnapshots.map((snapshot) => snapshot.id), [parentId, childId]);

  const renamed = await renameNode(env as any, parentId, "renamed-parent");
  await moveNode(env as any, renamed.id, destinationId, { mode: "inside" });
  await archiveNode(env as any, renamed.id);
  await deleteArchivedNode(env as any, renamed.id);

  const reloaded = await loadTaskRecord(fsAdapter, dispatched.taskPath);
  assert.equal(taskPackageForTask(reloaded), expectedPackage);
  assert.deepEqual(reloaded.contextCard.nodeSnapshots.map((snapshot) => snapshot.id), [parentId, childId]);
  assert.equal(await fsAdapter.exists("destination/renamed-parent/renamed-parent.md"), false);
});
