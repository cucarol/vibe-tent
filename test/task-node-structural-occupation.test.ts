import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { createNode, moveNode, placeNode, renameNode } from "../src/core/ops.js";
import { patchTaskRecord, writeTaskRecord } from "../src/core/task.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { loadTent } from "../src/core/tree.js";
import { captureTaskNodeSnapshot } from "../src/core/task-node-snapshot.js";
import { contentEtag } from "../src/core/etag.js";
import type { FsAdapter } from "../src/core/adapter.js";

function envFor(fsAdapter: FsAdapter) {
  return {
    fs: fsAdapter,
    clock: { now: () => "2026-08-01T00:00:00.000Z" },
    tentName: "structural-occupation",
  };
}

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-node-occupation-"));
  const fsAdapter = new NodeFs(dir);
  await scaffoldTent(fsAdapter, { name: "structural-occupation" });
  return { dir, fs: fsAdapter, env: envFor(fsAdapter) };
}

async function writeTask(
  fsAdapter: FsAdapter,
  nodeIds: string[],
  id: string,
  state: "queued" | "accepted" = "queued"
): Promise<string> {
  const tent = await loadTent(fsAdapter);
  const nodeSnapshots = nodeIds.map((nodeId) => {
    const node = tent.byId.get(nodeId);
    if (!node) throw new Error(`missing fixture Node ${nodeId}`);
    return captureTaskNodeSnapshot(node, contentEtag(node.body));
  });
  const taskPath = await writeTaskRecord(fsAdapter, {
    now: () => "2026-08-01T00:00:00.000Z",
  }, {
    executionSessionId: `ss-${id.replace(/[^a-z0-9]/gi, "").toLowerCase()}`,
    workNodeIds: nodeIds,
    contextNodeIds: [],
    nodeSnapshots,
    manifestPath: `temp/sessions/ss-${id.replace(/[^a-z0-9]/gi, "").toLowerCase()}/manifest.yml`,
    prompt: "hold this Node",
    id,
    requester: { kind: "user", id: "user" },
  });
  if (state === "accepted") await patchTaskRecord(fsAdapter, taskPath, { state });
  return taskPath;
}

test("active self ref blocks rename and exact-subtree reorder", async () => {
  const { fs: fsAdapter, env } = await makeWorkspace();
  const occupied = await createNode(env as any, {
    parentPath: "",
    name: "occupied",
    type: "prompt",
  });
  await writeTask(fsAdapter, [occupied], "tk-stself01");

  await assert.rejects(
    () => renameNode(env as any, occupied, "renamed"),
    /active Task ref.*tk-stself01/i
  );
  await assert.rejects(
    () => moveNode(env as any, occupied, null, { mode: "before", siblingId: "cx-promptzone" }),
    /active Task ref.*tk-stself01/i
  );
});

test("active descendant ref blocks moving the containing subtree", async () => {
  const { fs: fsAdapter, env } = await makeWorkspace();
  const parent = await createNode(env as any, {
    parentPath: "",
    name: "parent",
    type: "prompt",
  });
  const child = await createNode(env as any, {
    parentPath: "parent",
    name: "child",
    type: "prompt",
  });
  const destination = await createNode(env as any, {
    parentPath: "",
    name: "destination",
    type: "prompt",
  });
  await writeTask(fsAdapter, [child], "tk-stdesc01");

  await assert.rejects(
    () => moveNode(env as any, parent, destination, { mode: "inside" }),
    /active Task ref.*tk-stdesc01/i
  );
  await assert.rejects(
    () => placeNode(env as any, "parent", "destination", { mode: "inside" }),
    /active Task ref.*tk-stdesc01/i
  );
});

test("unrelated sibling and occupied destination parent do not block a move", async () => {
  const { fs: fsAdapter, env } = await makeWorkspace();
  const source = await createNode(env as any, {
    parentPath: "",
    name: "source",
    type: "prompt",
  });
  const destination = await createNode(env as any, {
    parentPath: "",
    name: "destination",
    type: "prompt",
  });
  const sibling = await createNode(env as any, {
    parentPath: "",
    name: "sibling",
    type: "prompt",
  });
  await writeTask(fsAdapter, [sibling, destination], "tk-stunrel1");

  const result = await moveNode(env as any, source, destination, { mode: "inside" });
  assert.equal(result.path, "destination/source");
});

test("terminal Task ref does not block structural rename", async () => {
  const { fs: fsAdapter, env } = await makeWorkspace();
  const target = await createNode(env as any, {
    parentPath: "",
    name: "terminal-target",
    type: "prompt",
  });
  await writeTask(fsAdapter, [target], "tk-stterm01", "accepted");

  const result = await renameNode(env as any, target, "terminal-renamed");
  assert.equal(result.path, "terminal-renamed");
});

test("structural mutation fails loud when canonical Task inventory is unreadable", async () => {
  const { dir, fs: fsAdapter, env } = await makeWorkspace();
  const target = await createNode(env as any, {
    parentPath: "",
    name: "context-card-target",
    type: "prompt",
  });
  await fs.mkdir(path.join(dir, "temp", "sessions", "ss-executor", "tasks"), { recursive: true });
  await fsAdapter.writeFile(
    "temp/sessions/ss-executor/tasks/task-no-context-card.md",
    [
      "---",
      "type: task",
      "id: tk-stnocard",
      "sessionId: ss-executor",
      "requester: { kind: user, id: user }",
      "state: running",
      "manifest: temp/sessions/ss-executor/manifest.yml",
      "---",
      "",
      "# Task",
      "",
      "corrupt canonical task without contextCard",
      "",
    ].join("\n")
  );

  await assert.rejects(
    () => renameNode(env as any, target, "context-card-renamed"),
    /missing Task Context Card v2/
  );
});
