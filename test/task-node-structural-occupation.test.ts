import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { createBox, moveNode, placeBox, renameNode } from "../src/core/ops.js";
import { patchTaskEnvelope, writeTaskEnvelope } from "../src/core/task.js";
import { scaffoldTent } from "../src/core/scaffold.js";
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
  const taskPath = await writeTaskEnvelope(fsAdapter, {
    now: () => "2026-08-01T00:00:00.000Z",
  }, {
    role: `role-${id}`,
    claims: nodeIds.map((nodeId) => ({ id: nodeId, path: "prompt/node" })),
    manifestPath: `temp/role-${id}/manifest.yml`,
    userPrompt: "hold this Node",
    id,
    parentActor: { kind: "user", id: "user" },
  });
  if (state === "accepted") await patchTaskEnvelope(fsAdapter, taskPath, { state });
  return taskPath;
}

test("active self ref blocks rename and exact-subtree reorder", async () => {
  const { fs: fsAdapter, env } = await makeWorkspace();
  const occupied = await createBox(env as any, {
    parentPath: "",
    name: "occupied",
    type: "prompt",
  });
  await writeTask(fsAdapter, [occupied], "tk-struct-self");

  await assert.rejects(
    () => renameNode(env as any, occupied, "renamed"),
    /active Task ref.*tk-struct-self/i
  );
  await assert.rejects(
    () => moveNode(env as any, occupied, null, { mode: "before", siblingId: "bx-promptzone" }),
    /active Task ref.*tk-struct-self/i
  );
});

test("active descendant ref blocks moving the containing subtree", async () => {
  const { fs: fsAdapter, env } = await makeWorkspace();
  const parent = await createBox(env as any, {
    parentPath: "",
    name: "parent",
    type: "prompt",
  });
  const child = await createBox(env as any, {
    parentPath: "parent",
    name: "child",
    type: "prompt",
  });
  const destination = await createBox(env as any, {
    parentPath: "",
    name: "destination",
    type: "prompt",
  });
  await writeTask(fsAdapter, [child], "tk-struct-descendant");

  await assert.rejects(
    () => moveNode(env as any, parent, destination, { mode: "inside" }),
    /active Task ref.*tk-struct-descendant/i
  );
  await assert.rejects(
    () => placeBox(env as any, "parent", "destination", { mode: "inside" }),
    /active Task ref.*tk-struct-descendant/i
  );
});

test("unrelated sibling and occupied destination parent do not block a move", async () => {
  const { fs: fsAdapter, env } = await makeWorkspace();
  const source = await createBox(env as any, {
    parentPath: "",
    name: "source",
    type: "prompt",
  });
  const destination = await createBox(env as any, {
    parentPath: "",
    name: "destination",
    type: "prompt",
  });
  const sibling = await createBox(env as any, {
    parentPath: "",
    name: "sibling",
    type: "prompt",
  });
  await writeTask(fsAdapter, [sibling, destination], "tk-struct-unrelated");

  const result = await moveNode(env as any, source, destination, { mode: "inside" });
  assert.equal(result.path, "destination/source");
});

test("terminal Task ref does not block structural rename", async () => {
  const { fs: fsAdapter, env } = await makeWorkspace();
  const target = await createBox(env as any, {
    parentPath: "",
    name: "terminal-target",
    type: "prompt",
  });
  await writeTask(fsAdapter, [target], "tk-struct-terminal", "accepted");

  const result = await renameNode(env as any, target, "terminal-renamed");
  assert.equal(result.path, "terminal-renamed");
});

test("legacy claims without contextCard do not create structural occupation", async () => {
  const { dir, fs: fsAdapter, env } = await makeWorkspace();
  const target = await createBox(env as any, {
    parentPath: "",
    name: "context-card-target",
    type: "prompt",
  });
  await fs.mkdir(path.join(dir, "temp", "legacy", "tasks"), { recursive: true });
  await fsAdapter.writeFile(
    "temp/legacy/tasks/task-no-context-card.md",
    [
      "---",
      "type: task",
      "id: tk-struct-no-card",
      "role: legacy",
      "parentActor: { kind: user, id: user }",
      "reviewer: { kind: user, id: user }",
      "status: taken",
      "state: running",
      "claims: [" + target + "]",
      "manifest: temp/legacy/manifest.yml",
      "---",
      "",
      "# Task",
      "",
      "legacy claims must not be guessed as refs",
      "",
    ].join("\n")
  );

  const result = await renameNode(env as any, target, "context-card-renamed");
  assert.equal(result.path, "context-card-renamed");
});
