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
  createBox as createNode,
  dispatch,
  archiveBox as archiveNode,
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
  migrateAllLegacyTaskNodeRefs,
  migrateLegacyTaskNodeRefs,
  MISSING_CONTEXT_CARD_NODES,
  normalizeContextCardNodeRef,
  sortTasksDeterministically,
  taskDirectlyReferencesNode,
  taskHasWorkspaceOnlyContext,
  taskReferencedNodeIds,
} from "../src/core/task-node-refs.js";
import { buildTaskContextCard, computeContextGeneration } from "../src/core/task-context-card.js";
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

async function writeNodeTask(
  fsAdapter: NodeFs,
  nodeIds: string[],
  id: string,
  state: "queued" | "running" | "waiting" | "delivered" | "accepted" | "rejected" | "interrupted" | "failed" = "queued"
): Promise<string> {
  const taskPath = await writeTaskEnvelope(fsAdapter, clock, {
    role: `role-${id}`,
    claims: nodeIds.map((nodeId) => ({ id: nodeId, path: `node/${nodeId}` })),
    manifestPath: `temp/role-${id}/manifests/${id}.yml`,
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
  const node = (await loadTent(fsAdapter)).byId.get("bx-p1")!;
  const taskPath = await writeNodeTask(fsAdapter, [node.id], "tk-occupation");

  for (const state of ["queued", "running", "waiting", "delivered"] as const) {
    await patchTaskEnvelope(fsAdapter, taskPath, { state });
    const tasks = await loadTaskEnvelopes(fsAdapter);
    const tent = await loadTent(fsAdapter);
    const hit = findActiveOccupation(tent, node, tasks);

    assert.equal(hit?.relation, "self");
    assert.equal(hit?.task.id, "tk-occupation");
    assert.equal(listDirectActiveTasksForNode(node.id, tasks).length, 1);
    assert.equal(canClaim(node, { tent, tasks }).ok, false);
  }

  for (const state of ["accepted", "rejected", "interrupted", "failed"] as const) {
    await patchTaskEnvelope(fsAdapter, taskPath, { state });
    const tasks = await loadTaskEnvelopes(fsAdapter);
    const tent = await loadTent(fsAdapter);
    assert.equal(listDirectActiveTasksForNode(node.id, tasks).length, 0);
    assert.equal(canClaim(node, { tent, tasks }).ok, true);
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

  const multi = await dispatch(env as any, "bx-p1", "analyst", {
    userPrompt: "work across two Nodes",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["bx-p1", "bx-p2"],
  });
  const parent = await dispatch(env as any, "bx-g1", "planner", {
    userPrompt: "work on the parent Node",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["bx-g1"],
  });
  const child = await dispatch(env as any, "bx-g2", "executor", {
    userPrompt: "work on the child Node",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["bx-g2"],
  });
  const firstSibling = await dispatch(env as any, siblingA, "reviewer", {
    userPrompt: "work on sibling A",
    parentActor: { kind: "user", id: "user" },
    nodeIds: [siblingA],
  });
  const secondSibling = await dispatch(env as any, siblingB, "writer", {
    userPrompt: "work on sibling B",
    parentActor: { kind: "user", id: "user" },
    nodeIds: [siblingB],
  });

  assert.deepEqual(
    taskReferencedNodeIds(await loadTaskEnvelope(env.fs, multi.taskPath)),
    ["bx-p1", "bx-p2"]
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
  const first = await dispatch(env as any, "bx-p1", "analyst", {
    userPrompt: "first exact Node task",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["bx-p1"],
  });

  await assert.rejects(
    () =>
      dispatch(env as any, "bx-p1", "executor", {
        userPrompt: "second exact Node task",
        parentActor: { kind: "user", id: "user" },
        nodeIds: ["bx-p1"],
      }),
    /occupied by active task/i
  );
  assert.equal(await env.fs.exists("temp/executor"), false);

  for (const state of ["accepted", "rejected", "interrupted", "failed"] as const) {
    await patchTaskEnvelope(env.fs, first.taskPath, { state });
    const released = await dispatch(env as any, "bx-p1", `released-${state}`, {
      userPrompt: `reuse after ${state}`,
      parentActor: { kind: "user", id: "user" },
      nodeIds: ["bx-p1"],
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

test("migration: legacy claims become contextCard.refs.nodes once and discard fake root", async () => {
  const dir = await makeTent();
  const fsAdapter = new NodeFs(dir);
  await fs.mkdir(path.join(dir, "temp", "executor", "tasks"), { recursive: true });
  const taskPath = "temp/executor/tasks/task-legacy.md";
  await fsAdapter.writeFile(
    taskPath,
    [
      "---",
      "type: task",
      "id: tk-legacy1",
      "status: taken",
      "state: running",
      "role: executor",
      "parentActor: { kind: user, id: user }",
      "reviewer: { kind: user, id: user }",
      "claims: [bx-p1, root]",
      "manifest: temp/executor/manifests/tk-legacy1.yml",
      "createdAt: 2026-01-01T00:00:00.000Z",
      "---",
      "# Task",
      "",
      "## User Prompt",
      "",
      "legacy objective text",
      "",
    ].join("\n")
  );

  const once = await migrateLegacyTaskNodeRefs(fsAdapter, taskPath);
  assert.equal(once.migrated, true);
  assert.deepEqual(once.nodeIds, ["bx-p1"]);
  assert.equal(once.discardedRootClaim, true);

  const raw = await fsAdapter.readFile(taskPath);
  const { data } = parseFrontmatter(raw);
  assert.equal("claims" in data, false);
  assert.equal("workspaceContext" in data, false);
  const card = data.contextCard as {
    objective?: string;
    acceptance?: string[];
    refs: { nodes: { id: string }[] };
  };
  assert.equal(card.objective, "legacy objective text");
  assert.deepEqual(card.acceptance, ["legacy objective text"]);
  assert.deepEqual(card.refs.nodes.map((node) => node.id), ["bx-p1"]);
  assert.ok(!card.refs.nodes.some((node) => node.id === "root"));

  const twice = await migrateLegacyTaskNodeRefs(fsAdapter, taskPath);
  assert.equal(twice.skipped, true);
  assert.deepEqual(taskReferencedNodeIds(await loadTaskEnvelope(fsAdapter, taskPath)), ["bx-p1"]);
  assert.equal(taskHasWorkspaceOnlyContext(await loadTaskEnvelope(fsAdapter, taskPath)), false);
  assert.equal(taskDirectlyReferencesNode(await loadTaskEnvelope(fsAdapter, taskPath), "bx-p1"), true);
});

test("migration: active Task with empty objective fails loud", async () => {
  const dir = await makeTent();
  const fsAdapter = new NodeFs(dir);
  await fs.mkdir(path.join(dir, "temp", "executor", "tasks"), { recursive: true });
  const taskPath = "temp/executor/tasks/task-empty-obj.md";
  await fsAdapter.writeFile(
    taskPath,
    [
      "---",
      "type: task",
      "id: tk-emptyobj",
      "status: taken",
      "state: running",
      "role: executor",
      "parentActor: { kind: user, id: user }",
      "reviewer: { kind: user, id: user }",
      "claims: [bx-p1]",
      "manifest: temp/executor/manifests/tk-emptyobj.yml",
      "---",
      "# Task",
      "",
      "## Context Pointers",
      "",
      "- bx-p1: prompt/x",
      "",
    ].join("\n")
  );

  await assert.rejects(
    () => migrateLegacyTaskNodeRefs(fsAdapter, taskPath),
    /empty\/missing objective|missing objective/i
  );
});

test("migration: all legacy Task lanes are scanned and idempotent", async () => {
  const dir = await makeTent();
  const fsAdapter = new NodeFs(dir);
  await fs.mkdir(path.join(dir, "temp", "executor", "tasks"), { recursive: true });
  await fs.mkdir(path.join(dir, "temp", "agent-profiles", "fake-default", "tasks"), {
    recursive: true,
  });
  for (const [relative, id, role, nodeId] of [
    ["temp/executor/tasks/t1.md", "tk-scan1", "executor", "bx-p1"],
    [
      "temp/agent-profiles/fake-default/tasks/t2.md",
      "tk-scan2",
      "fake-default",
      "bx-o1",
    ],
  ] as const) {
    await fsAdapter.writeFile(
      relative,
      [
        "---",
        "type: task",
        `id: ${id}`,
        "status: pending",
        "state: queued",
        `role: ${role}`,
        ...(role === "fake-default" ? ["assigneeKind: agentProfile"] : []),
        "parentActor: { kind: user, id: user }",
        "reviewer: { kind: user, id: user }",
        `claims: [${nodeId}]`,
        `manifest: temp/${role}/manifests/${id}.yml`,
        "---",
        "# Task",
        "",
        "## User Prompt",
        "",
        `scan ${id}`,
        "",
      ].join("\n")
    );
  }

  const results = await migrateAllLegacyTaskNodeRefs(fsAdapter);
  assert.ok(results.some((result) => result.migrated && result.nodeIds.includes("bx-p1")));
  assert.ok(results.some((result) => result.migrated && result.nodeIds.includes("bx-o1")));
  const again = await migrateAllLegacyTaskNodeRefs(fsAdapter);
  assert.ok(again.every((result) => result.skipped || result.reason));
});

test("Node ref normalization rejects fake root and preserves deterministic Task ordering", () => {
  assert.throws(
    () => normalizeContextCardNodeRef({ id: "root" }),
    /fake "root"/
  );
  assert.deepEqual(
    sortTasksDeterministically([
      { id: "tk-late", path: "temp/b.md", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "tk-early", path: "temp/a.md", createdAt: "2026-01-01T00:00:00.000Z" },
    ]),
    [
      { id: "tk-early", path: "temp/a.md", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "tk-late", path: "temp/b.md", createdAt: "2026-01-02T00:00:00.000Z" },
    ]
  );
});

test("Task Node context validation is fail-loud; explicit empty refs mean workspace context", () => {
  assert.throws(
    () => taskReferencedNodeIds({ id: "tk-missing", path: "temp/x.md" }),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(MISSING_CONTEXT_CARD_NODES) &&
      err.message.includes("tk-missing")
  );
  assert.throws(
    () => taskReferencedNodeIds({ id: "tk-no-nodes", contextCard: { refs: {} } }),
    /MISSING_CONTEXT_CARD/
  );
  assert.deepEqual(
    taskReferencedNodeIds({ id: "tk-workspace", contextCard: { refs: { nodes: [] } } }),
    []
  );
  assert.equal(
    taskHasWorkspaceOnlyContext({ id: "tk-workspace", contextCard: { refs: { nodes: [] } } }),
    true
  );
  assert.deepEqual(
    taskReferencedNodeIds({
      id: "tk-node",
      contextCard: { refs: { nodes: [{ id: "cx-1" }, { id: "root" }] } },
    }),
    ["cx-1"]
  );
});

test("Context Card keeps structured objective optional and durable Node refs explicit", () => {
  const generation = computeContextGeneration({
    workspaceIdentity: "workspace",
    agentsPointerDigest: "agents",
  });
  const promptOnly = buildTaskContextCard({
    contextGeneration: generation,
    refs: { nodes: [{ id: "cx-1" }] },
  });
  assert.equal(promptOnly.objective, "");
  assert.deepEqual(promptOnly.acceptance, []);
  const card = buildTaskContextCard({
    objective: "do it",
    acceptance: ["do it"],
    contextGeneration: generation,
    refs: { nodes: [normalizeContextCardNodeRef({ id: "cx-1", path: "a/b" })] },
  });
  assert.deepEqual(card.acceptance, ["do it"]);
  assert.equal(card.refs.nodes[0]!.path, "a/b");
  assert.ok(card.contextGeneration.startsWith("cg-v1-"));
  assert.ok(card.taskDeltaDigest);
});
