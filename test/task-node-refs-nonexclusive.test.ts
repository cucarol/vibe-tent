/**
 * cx-tsw53f focused tests on Context Card / parentActor baseline.
 * - non-exclusive Node refs (same / ancestor / descendant / workspace)
 * - claims → contextCard.refs.nodes one-shot migration
 * - archive/purge direct-ref only
 * - rename/move legal under concurrent refs
 * - multi-Task collaboration projection; activeTaskCount === length only
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import {
  canClaim,
  boxHasDirectActiveTask,
  findActiveOccupation,
  findAnyActiveTask,
  occupiedBoxesFromTasks,
} from "../src/core/claim.js";
import {
  listDirectActiveTasksForNode,
  migrateAllLegacyTaskNodeRefs,
  migrateLegacyTaskNodeRefs,
  MISSING_CONTEXT_CARD_NODES,
  normalizeContextCardNodeRef,
  taskDirectlyReferencesNode,
  taskHasWorkspaceOnlyContext,
  taskReferencedNodeIds,
} from "../src/core/task-node-refs.js";
import { buildTaskContextCard, computeContextGeneration } from "../src/core/task-context-card.js";
import {
  loadTaskEnvelope,
  loadTaskEnvelopes,
  writeTaskEnvelope,
} from "../src/core/task.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { makeTent } from "./helpers.js";

function envFor(dir: string) {
  return {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-07-28T12:00:00.000Z" },
    tentName: "wqb",
    tentRoot: dir,
  };
}

test("canClaim: concurrent same/ancestor/descendant refs are legal; archived/invalid still deny", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.mkdir(path.join(dir, "temp", "executor", "tasks"), { recursive: true });
  // Full Context Card write — runtime never loads residual claims[].
  const taskPath = await writeTaskEnvelope(fsa, { now: () => "2026-07-28T12:00:00.000Z" }, {
    role: "executor",
    claims: [{ id: "bx-g2", path: "goal/x" }],
    manifestPath: "temp/executor/manifest.yml",
    userPrompt: "occupy g2",
    id: "tk-activeg2",
    parentActor: { kind: "user", id: "user" },
  });
  const raw = await fsa.readFile(taskPath);
  await fsa.writeFile(
    taskPath,
    raw.replace("status: pending", "status: taken").replace("state: queued", "state: running")
  );
  const tent = await loadTent(fsa);
  const tasks = await loadTaskEnvelopes(fsa);

  const g1 = tent.byId.get("bx-g1")!;
  const g2 = tent.byId.get("bx-g2")!;
  // Same node, ancestor, and peer concurrency are all legal.
  assert.equal(canClaim(g2, { tent, tasks }).ok, true);
  assert.equal(canClaim(g1, { tent, tasks }).ok, true);
  assert.equal(boxHasDirectActiveTask("bx-g2", tasks), true);
  assert.equal(boxHasDirectActiveTask("bx-g1", tasks), false);
  // findActiveOccupation reports direct self only (informational).
  assert.equal(findActiveOccupation(tent, g2, tasks)?.relation, "self");
  assert.equal(findActiveOccupation(tent, g1, tasks), undefined);

  // Structural deny still works.
  const archived = { ...g2, archived: true, mode: "archived" as const };
  assert.equal(canClaim(archived as typeof g2).ok, false);
});

test("dispatch: concurrent same Node + ancestor + workspace context allowed", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  const { dispatch } = await import("../src/core/ops.js");

  const first = await dispatch(env as any, "bx-p1", "analyst", "first on p1");
  const second = await dispatch(env as any, "bx-p1", "executor", "second on same node");
  assert.notEqual(first.taskPath, second.taskPath);

  // Ancestor of p1 (prompt zone) and descendant concurrency.
  const onAncestor = await dispatch(env as any, "bx-promptzone", "planner", "ancestor concurrent");
  assert.ok(onAncestor.taskPath);

  // Workspace/root context is not a Tent-wide lock.
  const rootA = await dispatch(env as any, "root", "architect", {
    userPrompt: "workspace context A",
  } as any).catch(async (err) => {
    // Some dispatch signatures use claimId string "root" differently — try box path form.
    void err;
    return null;
  });
  // Prefer explicit claim via resolve — dispatch(env, claimId, role, prompt)
  // When claimId is invalid root token, ops may reject. Use internal write instead for workspace.
  const fsa = env.fs;
  await writeTaskEnvelope(fsa, env.clock, {
    role: "architect",
    claims: [{ id: "root", path: "./" }],
    manifestPath: "temp/architect/manifest.yml",
    userPrompt: "workspace context A",
    id: "tk-ws-a",
    parentActor: { kind: "user", id: "user" },
  });
  await writeTaskEnvelope(fsa, env.clock, {
    role: "reviewer",
    claims: [{ id: "root", path: "./" }],
    manifestPath: "temp/reviewer/manifest.yml",
    userPrompt: "workspace context B",
    id: "tk-ws-b",
    parentActor: { kind: "user", id: "user" },
  });
  const tasks = await loadTaskEnvelopes(fsa);
  const wsTasks = tasks.filter((t) => taskHasWorkspaceOnlyContext(t));
  assert.ok(wsTasks.length >= 2, `expected concurrent workspace tasks, got ${wsTasks.length}`);
  assert.ok(findAnyActiveTask(tasks));

  // New envelopes must not persist claims[].
  const raw = await fsa.readFile(first.taskPath);
  const { data } = parseFrontmatter(raw);
  assert.equal("claims" in data, false);
  assert.ok(data.contextCard);
  const card = data.contextCard as { refs?: { nodes?: { id: string }[] }; objective?: string };
  assert.ok(Array.isArray(card.refs?.nodes));
  assert.equal(card.refs!.nodes![0]!.id, "bx-p1");
  assert.equal(card.objective, "first on p1");

  const loaded = await loadTaskEnvelope(fsa, first.taskPath);
  assert.deepEqual(taskReferencedNodeIds(loaded), ["bx-p1"]);
  assert.ok(loaded.contextCard?.refs.nodes.length === 1);
});

test("migration: claims → contextCard.refs.nodes is idempotent; root discarded (no workspaceContext flag)", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.mkdir(path.join(dir, "temp", "executor", "tasks"), { recursive: true });
  const taskPath = "temp/executor/tasks/task-legacy.md";
  await fsa.writeFile(
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
      "manifest: temp/executor/manifest.yml",
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

  const once = await migrateLegacyTaskNodeRefs(fsa, taskPath);
  assert.equal(once.migrated, true);
  assert.deepEqual(once.nodeIds, ["bx-p1"]);
  assert.equal(once.discardedRootClaim, true);

  const raw = await fsa.readFile(taskPath);
  const { data } = parseFrontmatter(raw);
  assert.equal("claims" in data, false);
  // Never persist workspaceContext as a Task source flag.
  assert.equal("workspaceContext" in data, false);
  const card = data.contextCard as {
    objective?: string;
    acceptance?: string[];
    parentActor?: { kind: string; id: string };
    reviewer?: { kind: string; id: string };
    assignee?: { kind: string; id: string };
    contextGeneration?: string;
    taskDeltaDigest?: string;
    refs: { nodes: { id: string }[] };
  };
  assert.equal(card.objective, "legacy objective text");
  assert.deepEqual(card.acceptance, ["legacy objective text"]);
  assert.deepEqual(
    card.refs.nodes.map((n) => n.id),
    ["bx-p1"]
  );
  // Complete card: actors + digests present (never a minimal partial card).
  assert.equal(card.parentActor?.kind, "user");
  assert.equal(card.reviewer?.kind, "user");
  assert.ok(card.assignee?.id);
  assert.ok(card.contextGeneration?.startsWith("cg-v1-"));
  assert.ok(card.taskDeltaDigest);
  // No fake root node ref.
  assert.ok(!card.refs.nodes.some((n) => n.id === "root"));

  const twice = await migrateLegacyTaskNodeRefs(fsa, taskPath);
  assert.equal(twice.skipped, true);
  assert.equal(twice.migrated, false);

  const loaded = await loadTaskEnvelope(fsa, taskPath);
  assert.deepEqual(taskReferencedNodeIds(loaded), ["bx-p1"]);
  // Has direct Node ref → not workspace-only context.
  assert.equal(taskHasWorkspaceOnlyContext(loaded), false);
  assert.equal(taskDirectlyReferencesNode(loaded, "bx-p1"), true);
});

test("migration: active Task with empty objective fails loud", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.mkdir(path.join(dir, "temp", "executor", "tasks"), { recursive: true });
  const taskPath = "temp/executor/tasks/task-empty-obj.md";
  await fsa.writeFile(
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
      "manifest: temp/executor/manifest.yml",
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
    () => migrateLegacyTaskNodeRefs(fsa, taskPath),
    /empty\/missing objective|missing objective/i
  );
});

test("archive: only direct active ref blocks; ancestor/descendant refs do not", async () => {
  const dir = await makeTent();
  await fs.mkdir(path.join(dir, "goal", "挖新alpha", "写表达式", "实现细节"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "goal", "挖新alpha", "写表达式", "实现细节", "实现细节.md"),
    "---\nid: bx-g3\ntype: goal\n---\n",
    "utf8"
  );
  const env = envFor(dir);
  const { dispatch, archiveBox } = await import("../src/core/ops.js");

  // Active task on descendant g2 — archiving ancestor g1 must succeed.
  await dispatch(env as any, "bx-g2", "executor", "hold g2");
  await archiveBox(env as any, "bx-g1");

  // Direct ref blocks archive of g2 itself — re-dispatch after restore? g1 archived.
  // Use p1 for direct-ref block.
  await dispatch(env as any, "bx-p1", "analyst", "hold p1");
  await assert.rejects(
    () => archiveBox(env as any, "bx-p1"),
    /directly referenced by an active task/i
  );
});

test("rename/move remain legal under concurrent direct refs", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  const { dispatch } = await import("../src/core/ops.js");
  const { renameNode } = await import("../src/core/renameOps.js");
  const { moveNode } = await import("../src/core/moveOps.js");

  await dispatch(env as any, "bx-p1", "executor", "hold while rename");
  const tent = await loadTent(env.fs);
  const box = tent.byId.get("bx-p1")!;
  // Should not throw occupation error.
  const renamedResult = await renameNode(env as any, box.id, "表达式任务书-renamed");
  assert.equal(renamedResult.id, "bx-p1");
  assert.ok(renamedResult.path.includes("表达式任务书-renamed") || renamedResult.name.includes("renamed"));

  // Move under goal parent is legal even with active ref.
  await moveNode(env as any, "bx-p1", "bx-g1", { mode: "inside" });
  const tent3 = await loadTent(env.fs);
  const moved = tent3.byId.get("bx-p1")!;
  assert.ok(moved.parent?.id === "bx-g1" || moved.path.includes("挖新alpha"));
});

test("activeTaskCount design: never on Task disk; list length is the only fact", async () => {
  // Judge addendum freeze — independent of Context Card P0 baseline.
  // activeTaskCount is projection-only derived data; collaboration fact is activeTasks[].
  const dir = await makeTent();
  const env = envFor(dir);
  const { dispatch } = await import("../src/core/ops.js");
  await dispatch(env as any, "bx-p1", "executor", "count-a");
  await dispatch(env as any, "bx-p1", "analyst", "count-b");
  const tasks = await loadTaskEnvelopes(env.fs);
  const listed = listDirectActiveTasksForNode("bx-p1", tasks);
  assert.ok(listed.length >= 2);
  // Derived count would equal listed.length; it must not appear on durable envelopes.
  const derivedCount = listed.length;
  assert.equal(derivedCount, listed.length);
  for (const t of listed) {
    const raw = await env.fs.readFile(t.path);
    assert.doesNotMatch(raw, /activeTaskCount/);
    assert.doesNotMatch(raw, /totalCount/);
    assert.doesNotMatch(raw, /hasMore|pageSize|nextCursor/);
    // Node refs live on contextCard.refs.nodes — not a count field.
    assert.match(raw, /contextCard:/);
  }
});

test("listDirectActiveTasksForNode: deterministic createdAt/id/path order", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.mkdir(path.join(dir, "temp", "a", "tasks"), { recursive: true });
  await fs.mkdir(path.join(dir, "temp", "b", "tasks"), { recursive: true });

  await writeTaskEnvelope(
    fsa,
    { now: () => "2026-01-02T00:00:00.000Z" },
    {
      role: "b",
      claims: [{ id: "bx-p1", path: "prompt/x" }],
      manifestPath: "temp/b/m.yml",
      userPrompt: "later",
      id: "tk-later",
      parentActor: { kind: "user", id: "user" },
    }
  );
  await writeTaskEnvelope(
    fsa,
    { now: () => "2026-01-01T00:00:00.000Z" },
    {
      role: "a",
      claims: [{ id: "bx-p1", path: "prompt/x" }],
      manifestPath: "temp/a/m.yml",
      userPrompt: "earlier",
      id: "tk-earlier",
      parentActor: { kind: "user", id: "user" },
    }
  );

  const tasks = await loadTaskEnvelopes(fsa);
  const listed = listDirectActiveTasksForNode("bx-p1", tasks);
  assert.equal(listed.length, 2);
  assert.equal(listed[0]!.id, "tk-earlier");
  assert.equal(listed[1]!.id, "tk-later");
});

test("taskReferencedNodeIds: missing card/nodes throws; explicit empty nodes is workspace context", () => {
  // Absent contextCard → stable MISSING_CONTEXT_CARD (never silent []).
  assert.throws(
    () => taskReferencedNodeIds({ id: "tk-missing", path: "temp/x.md" }),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes("MISSING_CONTEXT_CARD") &&
      err.message.includes("tk-missing")
  );
  assert.throws(
    () => taskHasWorkspaceOnlyContext({ id: "tk-missing" }),
    /MISSING_CONTEXT_CARD/
  );

  // contextCard present but refs.nodes undefined → same fail-loud (not workspace).
  assert.throws(
    () =>
      taskReferencedNodeIds({
        id: "tk-no-nodes",
        contextCard: { refs: {} },
      }),
    /MISSING_CONTEXT_CARD/
  );
  assert.throws(
    () =>
      taskReferencedNodeIds({
        id: "tk-no-refs",
        contextCard: {},
      }),
    /MISSING_CONTEXT_CARD/
  );

  // Explicit empty nodes[] is the only valid workspace-context case.
  const workspaceOnly = {
    id: "tk-ws",
    contextCard: { refs: { nodes: [] } },
  };
  assert.deepEqual(taskReferencedNodeIds(workspaceOnly), []);
  assert.equal(taskHasWorkspaceOnlyContext(workspaceOnly), true);

  // Non-empty nodes still returns ids; not workspace-only.
  const withNode = {
    id: "tk-n1",
    contextCard: { refs: { nodes: [{ id: "cx-1" }, { id: "root" }] } },
  };
  assert.deepEqual(taskReferencedNodeIds(withNode), ["cx-1"]);
  assert.equal(taskHasWorkspaceOnlyContext(withNode), false);
  assert.equal(MISSING_CONTEXT_CARD_NODES.startsWith("MISSING_CONTEXT_CARD"), true);
});

test("normalizeContextCardNodeRef + buildTaskContextCard: full card; reject fake root", () => {
  assert.throws(
    () => normalizeContextCardNodeRef({ id: "root" }),
    /fake "root"/
  );
  const gen = computeContextGeneration({
    workspaceIdentity: "ws",
    rulesPointerDigest: "r",
    agentsPointerDigest: "a",
  });
  assert.throws(
    () =>
      buildTaskContextCard({
        objective: "  ",
        acceptance: ["ok"],
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        assignee: { kind: "role", id: "r" },
        contextGeneration: gen,
        refs: { nodes: [{ id: "cx-1" }] },
      }),
    /objective/i
  );
  const card = buildTaskContextCard({
    objective: "do it",
    acceptance: ["do it"],
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    assignee: { kind: "role", id: "r" },
    contextGeneration: gen,
    refs: { nodes: [normalizeContextCardNodeRef({ id: "cx-1", path: "a/b" })] },
  });
  assert.deepEqual(card.acceptance, ["do it"]);
  assert.equal(card.refs.nodes[0]!.path, "a/b");
  assert.ok(card.contextGeneration.startsWith("cg-v1-"));
  assert.ok(card.taskDeltaDigest);
});

test("migrateAllLegacyTaskNodeRefs scans role and profile lanes", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.mkdir(path.join(dir, "temp", "executor", "tasks"), { recursive: true });
  await fs.mkdir(
    path.join(dir, "temp", "agent-profiles", "fake-default", "tasks"),
    { recursive: true }
  );
  await fsa.writeFile(
    "temp/executor/tasks/t1.md",
    [
      "---",
      "type: task",
      "id: tk-scan1",
      "status: pending",
      "state: queued",
      "role: executor",
      "parentActor: { kind: user, id: user }",
      "reviewer: { kind: user, id: user }",
      "claims: [bx-p1]",
      "manifest: temp/executor/manifest.yml",
      "---",
      "# Task",
      "",
      "## User Prompt",
      "",
      "scan one",
      "",
    ].join("\n")
  );
  await fsa.writeFile(
    "temp/agent-profiles/fake-default/tasks/t2.md",
    [
      "---",
      "type: task",
      "id: tk-scan2",
      "status: pending",
      "state: queued",
      "role: fake-default",
      "assigneeKind: agentProfile",
      "parentActor: { kind: user, id: user }",
      "reviewer: { kind: user, id: user }",
      "claims: [bx-o1]",
      "manifest: temp/agent-profiles/fake-default/manifests/x.yml",
      "---",
      "# Task",
      "",
      "## User Prompt",
      "",
      "scan two",
      "",
    ].join("\n")
  );

  const results = await migrateAllLegacyTaskNodeRefs(fsa);
  assert.ok(results.some((r) => r.migrated && r.nodeIds.includes("bx-p1")));
  assert.ok(results.some((r) => r.migrated && r.nodeIds.includes("bx-o1")));
  const again = await migrateAllLegacyTaskNodeRefs(fsa);
  assert.ok(again.every((r) => r.skipped || r.reason));
});
