/**
 * Node occupation and Task context contract.
 *
 * A Task may reference several Nodes, but one exact Node has at most one active
 * Task. Parent/child and sibling Nodes remain independent contexts. Structural
 * edits protect the affected subtree, while unrelated Nodes stay editable.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { canClaim, findActiveOccupation } from "../src/core/claim.js";
import {
  createNode as createNode,
  dispatch,
  archiveNode as archiveNode,
  moveNode,
  renameNode,
} from "../src/core/ops.js";
import { loadTent } from "../src/core/tree.js";
import {
  loadTaskEnvelope,
  loadTaskEnvelopes,
  patchTaskEnvelope,
  writeTaskEnvelope,
} from "../src/core/task.js";
import {
  listDirectActiveTasksForNode,
  MISSING_CONTEXT_CARD_NODES,
  normalizeContextCardNodeRef,
  sortTasksDeterministically,
  taskDirectlyReferencesNode,
  taskReferencedNodeIds,
  type ContextCardNodeRefSource,
} from "../src/core/task-node-refs.js";
import { buildTaskContextCard } from "../src/core/task-context-card.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { makeTent } from "./helpers.js";

const clock = { now: () => "2026-08-01T00:00:00.000Z" };

function envFor(dir: string) {
  return {
    fs: new NodeFs(dir),
    clock,
    tentName: "node-occupation",
    tentRoot: dir,
  };
}

function dispatchToRole(env: any, nodeId: string, roleLabel: string, input: Record<string, unknown>) {
  return dispatch(env, nodeId, {
    sessionId: `ss-${roleLabel.replace(/[^a-z0-9]/gi, "").toLowerCase()}`,
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    ...input,
  });
}

test("writeTaskEnvelope rejects duplicate canonical Node refs", async () => {
  const dir = await makeTent();
  const fsAdapter = new NodeFs(dir);
  await assert.rejects(
    writeTaskEnvelope(fsAdapter, clock, {
      sessionId: "ss-executor",
      nodeRefs: [
        { id: "cx-p1", path: "prompt/x" },
        { id: "cx-p1", path: "prompt/x" },
      ],
      manifestPath: "temp/sessions/ss-executor/manifests/tk-duplicate.yml",
      userPrompt: "duplicate refs",
      id: "tk-duplicate",
      parentActor: { kind: "user", id: "user" },
    }),
    /duplicate Node id: cx-p1/
  );
});

async function writeNodeTask(
  fsAdapter: NodeFs,
  nodeIds: string[],
  id: string,
  state: "queued" | "running" | "waiting" | "delivered" | "accepted" | "rejected" | "interrupted" | "failed" = "queued"
): Promise<string> {
  const taskPath = await writeTaskEnvelope(fsAdapter, clock, {
    sessionId: `ss-${id.replace(/[^a-z0-9]/gi, "").toLowerCase()}`,
    nodeRefs: nodeIds.map((nodeId) => ({ id: nodeId, path: `node/${nodeId}` })),
    manifestPath: `temp/sessions/ss-${id.replace(/[^a-z0-9]/gi, "").toLowerCase()}/manifests/${id}.yml`,
    userPrompt: `hold ${id}`,
    id,
    parentActor: { kind: "user", id: "user" },
  });
  if (state !== "queued") await patchTaskEnvelope(fsAdapter, taskPath, { state });
  return taskPath;
}

test("exact Node occupation covers every active Task state", async () => {
  const dir = await makeTent();
  const fsAdapter = new NodeFs(dir);
  const node = (await loadTent(fsAdapter)).byId.get("cx-p1")!;
  const taskPath = await writeNodeTask(fsAdapter, [node.id], "tk-occupation");

  for (const state of ["queued", "running", "waiting", "delivered"] as const) {
    await patchTaskEnvelope(fsAdapter, taskPath, { state });
    const tasks = await loadTaskEnvelopes(fsAdapter);
    const tent = await loadTent(fsAdapter);
    const hit = findActiveOccupation(node, tasks);

    assert.equal(hit?.relation, "self");
    assert.equal(hit?.task.id, "tk-occupation");
    assert.equal(listDirectActiveTasksForNode(node.id, tasks).length, 1);
    assert.equal(canClaim(node, { tasks }).ok, false);
  }

  for (const state of ["accepted", "rejected", "interrupted", "failed"] as const) {
    await patchTaskEnvelope(fsAdapter, taskPath, { state });
    const tasks = await loadTaskEnvelopes(fsAdapter);
    const tent = await loadTent(fsAdapter);
    assert.equal(listDirectActiveTasksForNode(node.id, tasks).length, 0);
    assert.equal(canClaim(node, { tasks }).ok, true);
  }
});

test("Task can reference multiple Nodes; parent, child, and sibling Tasks run concurrently", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  const siblingA = await createNode(env as any, {
    parentPath: "goal/挖新alpha",
    name: "sibling-a",
    type: "goal",
  });
  const siblingB = await createNode(env as any, {
    parentPath: "goal/挖新alpha",
    name: "sibling-b",
    type: "goal",
  });

  const multi = await dispatchToRole(env as any, "cx-p1", "analyst", {
    userPrompt: "work across two Nodes",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["cx-p1", "cx-p2"],
  });
  const parent = await dispatchToRole(env as any, "cx-g1", "planner", {
    userPrompt: "work on the parent Node",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["cx-g1"],
  });
  const child = await dispatchToRole(env as any, "cx-g2", "executor", {
    userPrompt: "work on the child Node",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["cx-g2"],
  });
  const firstSibling = await dispatchToRole(env as any, siblingA, "reviewer", {
    userPrompt: "work on sibling A",
    parentActor: { kind: "user", id: "user" },
    nodeIds: [siblingA],
  });
  const secondSibling = await dispatchToRole(env as any, siblingB, "writer", {
    userPrompt: "work on sibling B",
    parentActor: { kind: "user", id: "user" },
    nodeIds: [siblingB],
  });

  assert.deepEqual(
    taskReferencedNodeIds(await loadTaskEnvelope(env.fs, multi.taskPath)),
    ["cx-p1", "cx-p2"]
  );
  assert.ok(parent.taskPath && child.taskPath && firstSibling.taskPath && secondSibling.taskPath);
  assert.notEqual(parent.taskPath, child.taskPath);

  const raw = await env.fs.readFile(multi.taskPath);
  const { data } = parseFrontmatter(raw);
  assert.equal("claims" in data, false);
});

test("same exact Node rejects a second active Task and releases on terminal state", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  const first = await dispatchToRole(env as any, "cx-p1", "analyst", {
    userPrompt: "first exact Node task",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["cx-p1"],
  });

  await assert.rejects(
    () =>
      dispatchToRole(env as any, "cx-p1", "executor", {
        userPrompt: "second exact Node task",
        parentActor: { kind: "user", id: "user" },
        nodeIds: ["cx-p1"],
      }),
    /occupied by active task/i
  );
  assert.equal(await env.fs.exists("temp/sessions/ss-executor"), false);

  for (const state of ["accepted", "rejected", "interrupted", "failed"] as const) {
    await patchTaskEnvelope(env.fs, first.taskPath, { state });
    const released = await dispatchToRole(env as any, "cx-p1", `released-${state}`, {
      userPrompt: `reuse after ${state}`,
      parentActor: { kind: "user", id: "user" },
      nodeIds: ["cx-p1"],
    });
    assert.ok(released.taskPath);
    await patchTaskEnvelope(env.fs, released.taskPath, { state: "failed" });
  }
});

test("archive, move, and rename protect an affected Node subtree", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  const parent = await createNode(env as any, {
    parentPath: "",
    name: "occupied-parent",
    type: "prompt",
  });
  const child = await createNode(env as any, {
    parentPath: "occupied-parent",
    name: "occupied-child",
    type: "prompt",
  });
  const destination = await createNode(env as any, {
    parentPath: "",
    name: "move-destination",
    type: "prompt",
  });
  const active = await writeNodeTask(env.fs, [child], "tk-subtree-occupation");

  await assert.rejects(
    () => archiveNode(env as any, parent),
    /subtree has an active task/i
  );
  await assert.rejects(
    () => renameNode(env as any, parent, "occupied-parent-renamed"),
    /active task/i
  );
  await assert.rejects(
    () => moveNode(env as any, parent, destination, { mode: "inside" }),
    /active task/i
  );

  await patchTaskEnvelope(env.fs, active, { state: "accepted" });
  const renamed = await renameNode(env as any, parent, "occupied-parent-renamed");
  assert.equal(renamed.id, parent);
});

test("unrelated sibling and occupied destination parent remain structurally editable", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  const source = await createNode(env as any, {
    parentPath: "",
    name: "editable-source",
    type: "prompt",
  });
  const destination = await createNode(env as any, {
    parentPath: "",
    name: "occupied-destination",
    type: "prompt",
  });
  const unrelated = await createNode(env as any, {
    parentPath: "",
    name: "unrelated-sibling",
    type: "prompt",
  });
  await writeNodeTask(env.fs, [unrelated, destination], "tk-unrelated");

  const renamed = await renameNode(env as any, source, "editable-source-renamed");
  assert.equal(renamed.id, source);
  const moved = await moveNode(env as any, source, destination, { mode: "inside" });
  assert.equal(moved.id, source);
  assert.equal(moved.path, "occupied-destination/editable-source-renamed");
  await archiveNode(env as any, source);
});

test("claims-only Task envelopes are rejected without byte rewrite", async () => {
  const dir = await makeTent();
  const fsAdapter = new NodeFs(dir);
  await fs.mkdir(path.join(dir, "temp", "sessions", "ss-executor", "tasks"), { recursive: true });
  const taskPath = "temp/sessions/ss-executor/tasks/task-legacy.md";
  const raw = [
      "---",
      "type: task",
      "id: tk-legacy1",
      "status: taken",
      "state: running",
      "sessionId: ss-executor",
      "parentActor: { kind: user, id: user }",
      "reviewer: { kind: user, id: user }",
      "claims: [cx-p1, root]",
      "manifest: temp/sessions/ss-executor/manifests/tk-legacy1.yml",
      "createdAt: 2026-01-01T00:00:00.000Z",
      "---",
      "# Task",
      "",
      "## User Prompt",
      "",
      "legacy objective text",
      "",
    ].join("\n");
  await fsAdapter.writeFile(taskPath, raw);

  await assert.rejects(() => loadTaskEnvelope(fsAdapter, taskPath), /missing Task\.contextCard\.refs\.nodes/);
  assert.equal(await fsAdapter.readFile(taskPath), raw);
});

test("Node ref normalization rejects fake root and preserves deterministic Task ordering", () => {
  assert.throws(
    () => normalizeContextCardNodeRef({ id: "root" }),
    /canonical cx-\*/
  );
  const late: ContextCardNodeRefSource = {
    id: "tk-late",
    path: "temp/b.md",
    createdAt: "2026-01-02T00:00:00.000Z",
    state: "queued",
    contextCard: { refs: { nodes: [{ id: "cx-1" }] } },
  };
  const early: ContextCardNodeRefSource = {
    id: "tk-early",
    path: "temp/a.md",
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "queued",
    contextCard: { refs: { nodes: [{ id: "cx-1" }] } },
  };
  assert.deepEqual(sortTasksDeterministically([late, early]), [early, late]);
});

test("Task Node context validation requires non-empty canonical refs", () => {
  assert.throws(
    () => taskReferencedNodeIds({ id: "tk-missing", path: "temp/x.md" } as unknown as ContextCardNodeRefSource),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(MISSING_CONTEXT_CARD_NODES) &&
      err.message.includes("tk-missing")
  );
  assert.throws(
    () => taskReferencedNodeIds({ id: "tk-no-nodes", state: "queued", contextCard: { refs: {} } } as ContextCardNodeRefSource),
    /MISSING_CONTEXT_CARD/
  );
  assert.throws(
    () => taskReferencedNodeIds({ id: "tk-empty", state: "queued", contextCard: { refs: { nodes: [] } } }),
    /requires at least one Node/
  );
  assert.deepEqual(
    taskReferencedNodeIds({
      id: "tk-node",
      state: "queued",
      contextCard: { refs: { nodes: [{ id: "cx-1" }, { id: "cx-2" }] } },
    }),
    ["cx-1", "cx-2"]
  );
  assert.throws(
    () => taskReferencedNodeIds({ id: "tk-bx", state: "queued", contextCard: { refs: { nodes: [{ id: "bx-old" }] } } }),
    /canonical cx-\*/
  );
});

test("Context Card keeps structured objective optional and durable Node refs explicit", () => {
  const promptOnly = buildTaskContextCard({
    refs: { nodes: [{ id: "cx-1" }] },
  });
  assert.equal(promptOnly.objective, "");
  assert.deepEqual(promptOnly.acceptance, []);
  const card = buildTaskContextCard({
    objective: "do it",
    acceptance: ["do it"],
    refs: { nodes: [normalizeContextCardNodeRef({ id: "cx-1", path: "a/b" })] },
  });
  assert.deepEqual(card.acceptance, ["do it"]);
  assert.equal(card.refs.nodes[0]!.path, "a/b");
  assert.equal("contextGeneration" in card, false);
  assert.ok(card.taskDeltaDigest);
});
