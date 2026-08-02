/**
 * Multi-Node dispatch runtime seam (nodeIds):
 * - Core: exact ordered refs → Context Card; dedupe; structural gates; concurrency
 * - Service: nodeIds RPC parsing; retired field rejection; conflict reject; zero-write
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTaskEnvelope, patchTaskEnvelope } from "../src/core/task.js";
import { taskReferencedNodeIds } from "../src/core/task-node-refs.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { dispatch, resolveDispatchNodeIds, archiveNode } from "../src/core/ops.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { makeTent } from "./helpers.js";

function envFor(dir: string) {
  return {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-07-30T12:00:00.000Z" },
    tentName: "demo",
    tentRoot: dir,
  };
}

// ---- Core: resolveDispatchNodeIds ----

test("resolveDispatchNodeIds: nodeIds are ordered, deduped, and validated", () => {
  assert.deepEqual(
    resolveDispatchNodeIds({
      nodeIds: ["cx-p1", "cx-o1", "cx-p1", "cx-g1"],
      tentName: "demo",
    }),
    ["cx-p1", "cx-o1", "cx-g1"]
  );
  assert.throws(
    () => resolveDispatchNodeIds({ nodeIds: [], tentName: "demo" }),
    /non-empty/
  );
  assert.throws(
    () =>
      resolveDispatchNodeIds({
        nodeIds: ["cx-p1", "  "],
        tentName: "demo",
      }),
    /nodeIds\[1\]/
  );
  assert.throws(
    () =>
      resolveDispatchNodeIds({
        nodeIds: ["root"],
        tentName: "demo",
      }),
    /whole Tent/
  );
  assert.throws(
    () => resolveDispatchNodeIds({ tentName: "demo" }),
    /requires at least one Node/
  );
});

// ---- Core: dispatch multi-ref ----

test("dispatch: multi nodeIds preserve exact order in Context Card; dedupe; no claims[]", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  const result = await dispatch(env as any, "cx-o1", "analyst", {
    userPrompt: "multi-node ordered work",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    nodeIds: ["cx-o1", "cx-p1", "cx-g1", "cx-p1", "cx-o1"],
  });

  const loaded = await loadTaskEnvelope(env.fs, result.taskPath);
  assert.deepEqual(taskReferencedNodeIds(loaded), ["cx-o1", "cx-p1", "cx-g1"]);
  assert.deepEqual(
    loaded.contextCard?.refs.nodes.map((n) => n.id),
    ["cx-o1", "cx-p1", "cx-g1"]
  );
  // Path hints present for resolved Nodes.
  assert.ok(loaded.contextCard!.refs.nodes.every((n) => typeof n.path === "string" && n.path));

  const raw = await env.fs.readFile(result.taskPath);
  const { data } = parseFrontmatter(raw);
  assert.equal("claims" in data, false);
  // Manifest snapshots the same ids as writable pointers (auxiliary).
  assert.match(result.manifestYaml, /id: cx-o1/);
  assert.match(result.manifestYaml, /id: cx-p1/);
  assert.match(result.manifestYaml, /id: cx-g1/);
  assert.doesNotMatch(result.manifestYaml, /^claims:/m);
});

test("dispatch: multiline Context Card strings round-trip without corrupting the Task envelope", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  const prompt = "先读取项目说明\n\n只修改核心解析器\n\n完成后运行测试";

  const result = await dispatch(env as any, "cx-o1", "analyst", {
    userPrompt: prompt,
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    nodeIds: ["cx-o1"],
  });

  const raw = await env.fs.readFile(result.taskPath);
  assert.doesNotMatch(raw, /objective: "先读取项目说明/);
  const loaded = await loadTaskEnvelope(env.fs, result.taskPath);
  assert.equal(loaded.contextCard.objective, "");
  assert.deepEqual(loaded.contextCard.acceptance, []);
  assert.ok(loaded.prompt?.endsWith(prompt));
  assert.equal(loaded.prompt?.split(prompt).length, 2, "raw prompt appears exactly once");
});

test("dispatch: Role manifest snapshots only newly requested Nodes (no prior Role aggregation)", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  // Prior active Role Task on the same Role with a different Node set.
  const prior = await dispatch(env as any, "cx-p1", "analyst", {
    userPrompt: "prior active role task",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    nodeIds: ["cx-p1", "cx-p2"],
  });
  assert.deepEqual(
    taskReferencedNodeIds(await loadTaskEnvelope(env.fs, prior.taskPath)),
    ["cx-p1", "cx-p2"]
  );

  // New Task for the same Role must not silently import prior refs into manifest
  // or Context Card — exact requested ordered selection only (one fact).
  const next = await dispatch(env as any, "cx-o1", "analyst", {
    userPrompt: "new role task exact selection",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    nodeIds: ["cx-o1", "cx-g1"],
  });

  const loaded = await loadTaskEnvelope(env.fs, next.taskPath);
  assert.deepEqual(taskReferencedNodeIds(loaded), ["cx-o1", "cx-g1"]);
  assert.deepEqual(
    loaded.contextCard?.refs.nodes.map((n) => n.id),
    ["cx-o1", "cx-g1"]
  );

  // Each Task owns a distinct manifest snapshot; a later Task cannot overwrite
  // the earlier Task's writable Node selection.
  assert.notEqual(prior.manifestPath, next.manifestPath);
  assert.match(prior.manifestPath, /temp\/analyst\/manifests\/[^/]+\.yml$/);
  assert.match(next.manifestPath, /temp\/analyst\/manifests\/[^/]+\.yml$/);
  assert.equal(await env.fs.exists(prior.manifestPath), true);
  assert.equal(await env.fs.exists(next.manifestPath), true);
  assert.equal(await env.fs.readFile(prior.manifestPath), prior.manifestYaml);
  assert.equal(await env.fs.readFile(next.manifestPath), next.manifestYaml);

  // Auxiliary manifest selection is claimNodes → writable scope. Readable still
  // lists full Tent context, so assert only the writable section for exactness.
  const writableSection = next.manifestYaml.split(/^writable:\r?\n/m)[1] ?? "";
  assert.ok(writableSection.length > 0, "manifest must emit writable section");
  assert.match(writableSection, /id: cx-o1/);
  assert.match(writableSection, /id: cx-g1/);
  // Prior Role Task Nodes must not enter this Task's selection/writable scope.
  assert.doesNotMatch(writableSection, /id: cx-p1\b/);
  assert.doesNotMatch(writableSection, /id: cx-p2\b/);
  assert.doesNotMatch(next.manifestYaml, /^claims:/m);
});

test("dispatch: missing / archived / invalid nodeIds zero-write (no task/manifest)", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  // Missing id
  await assert.rejects(
    () =>
      dispatch(env as any, "cx-p1", "analyst", {
        userPrompt: "missing node",
        parentActor: { kind: "user", id: "user" },
        nodeIds: ["cx-p1", "cx-doesnotexist"],
      }),
    /Node not found/
  );
  assert.equal(await env.fs.exists("temp/analyst"), false);

  // Archived
  await archiveNode(env as any, "cx-o1");
  await assert.rejects(
    () =>
      dispatch(env as any, "cx-p1", "executor", {
        userPrompt: "archived node",
        parentActor: { kind: "user", id: "user" },
        nodeIds: ["cx-p1", "cx-o1"],
      }),
    /Cannot dispatch:.*[Aa]rchiv/
  );
  assert.equal(await env.fs.exists("temp/executor"), false);

  // Root token mixed with concrete ids
  await assert.rejects(
    () =>
      dispatch(env as any, "cx-p1", "planner", {
        userPrompt: "mixed root",
        parentActor: { kind: "user", id: "user" },
        nodeIds: ["cx-p1", "root"],
      }),
    /whole Tent/
  );
  assert.equal(await env.fs.exists("temp/planner"), false);
});

test("dispatch: exact Node occupation blocks only the same Node and releases on terminal states", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  const first = await dispatch(env as any, "cx-p1", "analyst", {
    userPrompt: "first exact Node task",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["cx-p1", "cx-p2"],
  });
  await assert.rejects(
    () =>
      dispatch(env as any, "cx-p1", "executor", {
        userPrompt: "same Node concurrent",
        parentActor: { kind: "user", id: "user" },
        nodeIds: ["cx-p1"],
      }),
    /occupied by active task/
  );
  assert.equal(await env.fs.exists("temp/executor"), false);

  // Parent/child and sibling Nodes are separate contexts and remain concurrent.
  const parent = await dispatch(env as any, "cx-promptzone", "planner", {
    userPrompt: "parent context concurrent",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["cx-promptzone"],
  });
  const sibling = await dispatch(env as any, "cx-g1", "reviewer", {
    userPrompt: "sibling context concurrent",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["cx-g1"],
  });

  assert.ok(parent.taskPath);
  assert.ok(sibling.taskPath);

  const expectOccupied = async (state: "queued" | "running" | "waiting" | "delivered") => {
    await patchTaskEnvelope(env.fs, first.taskPath, {
      state,
      updatedAt: "2026-07-30T12:00:00.000Z",
    });
    await assert.rejects(
      () =>
        dispatch(env as any, "cx-p1", "executor", {
          userPrompt: `blocked while ${state}`,
          parentActor: { kind: "user", id: "user" },
          nodeIds: ["cx-p1"],
        }),
      /occupied by active task/
    );
  };

  await expectOccupied("queued");
  await expectOccupied("running");
  await expectOccupied("waiting");
  await expectOccupied("delivered");

  for (const state of ["accepted", "rejected", "interrupted", "failed"] as const) {
    await patchTaskEnvelope(env.fs, first.taskPath, {
      state,
      updatedAt: "2026-07-30T12:00:00.000Z",
    });
    const released = await dispatch(env as any, "cx-p1", "executor", {
      userPrompt: `released after ${state}`,
      parentActor: { kind: "user", id: "user" },
      nodeIds: ["cx-p1"],
    });
    assert.ok(released.taskPath);
    await patchTaskEnvelope(env.fs, released.taskPath, {
      state: "failed",
      updatedAt: "2026-07-30T12:00:00.000Z",
    });
  }
});

test("dispatch: malformed nodeIds reject before any Task or manifest write", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  await assert.rejects(
    () =>
      dispatch(env as any, "cx-o1", "analyst", {
        userPrompt: "conflict",
        parentActor: { kind: "user", id: "user" },
        nodeIds: ["cx-o1", " "],
      }),
    /nodeIds\[1\]/
  );
  assert.equal(await env.fs.exists("temp/analyst"), false);
});

// ---- Service RPC ----

async function makeWorkspace(name = "mn-dispatch"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `tent-${name}-`));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "executor", prompt: "do work" },
          { name: "orchestrator", prompt: "dispatch work" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-mn-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

function rpc(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  method: string,
  params?: Record<string, unknown>
) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

async function mountTwoNotes(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string
) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
  const a = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: "alpha-node",
    type: "prompt",
  });
  assert.ok(!a.error, JSON.stringify(a.error));
  const b = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: "beta-node",
    type: "prompt",
  });
  assert.ok(!b.error, JSON.stringify(b.error));
  return {
    workspaceId,
    idA: (a.result as { nodeId: string }).nodeId,
    idB: (b.result as { nodeId: string }).nodeId,
  };
}

test("service task.dispatch: nodeIds 2+ refs ordered + deduped in Context Card", async () => {
  const ws = await makeWorkspace("svc-multi");
  await withService(async (svc) => {
    const { workspaceId, idA, idB } = await mountTwoNotes(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [idB, idA, idB, idA],
      assigneeKind: "route",
      routeId: "fake-default",
      prompt: "service multi-node ordered",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const result = d.result as { taskPath: string; assigneeKind: string; state: string };
    assert.equal(result.assigneeKind, "agentProfile");
    assert.equal(result.state, "queued");

    const tentFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(tentFs, result.taskPath);
    assert.deepEqual(taskReferencedNodeIds(task), [idB, idA]);
    assert.equal("claims" in (parseFrontmatter(await tentFs.readFile(result.taskPath)).data), false);

    const blocked = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [idA],
      assigneeKind: "route",
      routeId: "fake-default",
      prompt: "same exact Node must wait",
    });
    assert.ok(blocked.error, "an active Task must occupy each exact referenced Node");
    assert.match(String(blocked.error.message || blocked.error), /occupied by active task/i);
  });
});

test("service task.dispatch: invalid and retired selection fields fail before write", async () => {
  const ws = await makeWorkspace("svc-fail");
  await withService(async (svc) => {
    const { workspaceId, idA, idB } = await mountTwoNotes(svc, ws);

    const initialList = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!initialList.error);
    const initialCount = ((initialList.result as { tasks: unknown[] }).tasks ?? []).length;

    const missing = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [idA, "cx-missingzz"],
      assigneeKind: "route",
      routeId: "fake-default",
      prompt: "missing ref",
    });
    assert.ok(missing.error, "expected missing node fail");
    assert.match(String(missing.error.message || missing.error), /Node not found|not found/i);

    // Empty nodeIds
    const empty = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [],
      assigneeKind: "route",
      routeId: "fake-default",
      prompt: "empty",
    });
    assert.ok(empty.error);
    assert.match(String(empty.error.message || empty.error), /non-empty|nodeIds/i);

    // Malformed nodeIds (not string[])
    const bad = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [idA, 42],
      assigneeKind: "route",
      routeId: "fake-default",
      prompt: "bad type",
    });
    assert.ok(bad.error);
    assert.match(String(bad.error.message || bad.error), /nodeIds/i);

    for (const retiredField of ["nodeId", "id", "claimId"] as const) {
      const retired = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        [retiredField]: idA,
        nodeIds: [idB],
        assigneeKind: "route",
        routeId: "fake-default",
        prompt: `retired ${retiredField}`,
      });
      assert.ok(retired.error, `${retiredField} must fail loud`);
      assert.match(
        String(retired.error.message || retired.error),
        new RegExp(`${retiredField}.*retired|nodeIds`, "i")
      );
    }

    const afterInvalid = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!afterInvalid.error);
    assert.equal(
      ((afterInvalid.result as { tasks: unknown[] }).tasks ?? []).length,
      initialCount,
      "invalid and retired dispatches must not create Tasks"
    );

    // Fresh free node for archive gate (idA/idB are still directly referenced).
    const freeNote = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "gamma-free",
      type: "prompt",
    });
    assert.ok(!freeNote.error, JSON.stringify(freeNote.error));
    const idFree = (freeNote.result as { nodeId: string }).nodeId;

    const beforeList = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!beforeList.error);
    const beforeCount = ((beforeList.result as { tasks: unknown[] }).tasks ?? []).length;

    const arch = await rpc(svc, "docs.setMode", {
      workspaceId,
      nodeId: idFree,
      mode: "archived",
    });
    assert.ok(!arch.error, JSON.stringify(arch.error));

    const archivedDispatch = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [idB, idFree],
      assigneeKind: "route",
      routeId: "fake-default",
      prompt: "archived multi",
    });
    assert.ok(archivedDispatch.error, "archived ref must fail loud");
    assert.match(
      String(archivedDispatch.error.message || archivedDispatch.error),
      /[Aa]rchiv|Cannot dispatch/
    );

    const afterList = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!afterList.error);
    const afterCount = ((afterList.result as { tasks: unknown[] }).tasks ?? []).length;
    assert.equal(
      afterCount,
      beforeCount,
      "archived multi-node dispatch must not create a Task"
    );
  });
});

test("service task.dispatch: Role and agentProfile Tasks use distinct Node selections", async () => {
  const ws = await makeWorkspace("svc-role");
  await withService(async (svc) => {
    const { workspaceId, idA, idB } = await mountTwoNotes(svc, ws);

    const roleD = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [idA, idB],
      role: "executor",
      prompt: "role multi-node",
    });
    assert.ok(!roleD.error, JSON.stringify(roleD.error));
    const roleResult = roleD.result as {
      assigneeKind: string;
      assignee: string;
      state: string;
      taskPath: string;
    };
    assert.equal(roleResult.assigneeKind, "role");
    assert.equal(roleResult.assignee, "executor");
    assert.equal(roleResult.state, "queued");
    assert.match(roleResult.taskPath, /^temp\/executor\/tasks\//);

    const extra = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "gamma-node",
      type: "prompt",
    });
    assert.ok(!extra.error, JSON.stringify(extra.error));
    const idC = (extra.result as { nodeId: string }).nodeId;

    const profileD = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [idC],
      assigneeKind: "route",
      routeId: "fake-default",
      prompt: "profile multi-node",
    });
    assert.ok(!profileD.error, JSON.stringify(profileD.error));
    const profileResult = profileD.result as {
      assigneeKind: string;
      assignee: string;
      state: string;
      taskPath: string;
    };
    assert.equal(profileResult.assigneeKind, "agentProfile");
    assert.equal(profileResult.assignee, "fake-default");
    assert.equal(profileResult.state, "queued");
    assert.match(profileResult.taskPath, /^temp\/agent-profiles\/fake-default\/tasks\//);

    const tentFs = new NodeFs(path.join(ws, ".tent"));
    const roleTask = await loadTaskEnvelope(tentFs, roleResult.taskPath);
    const profileTask = await loadTaskEnvelope(tentFs, profileResult.taskPath);
    assert.deepEqual(taskReferencedNodeIds(roleTask), [idA, idB]);
    assert.deepEqual(taskReferencedNodeIds(profileTask), [idC]);
  });
});
