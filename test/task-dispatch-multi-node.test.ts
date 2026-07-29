/**
 * Multi-Node dispatch runtime seam (nodeIds):
 * - Core: exact ordered refs → Context Card; dedupe; structural gates; concurrency
 * - Service: nodeIds RPC parsing; legacy compatibility; conflict reject; zero-write
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTaskEnvelope } from "../src/core/task.js";
import { taskReferencedNodeIds } from "../src/core/task-node-refs.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { dispatch, resolveDispatchNodeIds, archiveBox } from "../src/core/ops.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { makeTent } from "./helpers.js";

function envFor(dir: string) {
  return {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-07-30T12:00:00.000Z" },
    tentName: "wqb",
    tentRoot: dir,
  };
}

// ---- Core: resolveDispatchNodeIds ----

test("resolveDispatchNodeIds: prefers nodeIds, dedupes order, rejects empty/root/conflict", () => {
  assert.deepEqual(
    resolveDispatchNodeIds({
      nodeIds: ["bx-p1", "bx-o1", "bx-p1", "bx-g1"],
      tentName: "wqb",
    }),
    ["bx-p1", "bx-o1", "bx-g1"]
  );
  assert.deepEqual(
    resolveDispatchNodeIds({
      nodeIds: ["bx-p1", "bx-o1"],
      legacyClaimId: "bx-p1",
      tentName: "wqb",
    }),
    ["bx-p1", "bx-o1"]
  );
  assert.deepEqual(
    resolveDispatchNodeIds({ legacyClaimId: "bx-p1", tentName: "wqb" }),
    ["bx-p1"]
  );

  assert.throws(
    () => resolveDispatchNodeIds({ nodeIds: [], tentName: "wqb" }),
    /non-empty/
  );
  assert.throws(
    () =>
      resolveDispatchNodeIds({
        nodeIds: ["bx-p1", "  "],
        tentName: "wqb",
      }),
    /nodeIds\[1\]/
  );
  assert.throws(
    () =>
      resolveDispatchNodeIds({
        nodeIds: ["root"],
        tentName: "wqb",
      }),
    /whole Tent/
  );
  assert.throws(
    () =>
      resolveDispatchNodeIds({
        nodeIds: ["bx-p1"],
        legacyClaimId: "bx-o1",
        tentName: "wqb",
      }),
    /conflicts with authoritative nodeIds/
  );
  assert.throws(
    () => resolveDispatchNodeIds({ tentName: "wqb" }),
    /requires nodeIds or a legacy/
  );
});

// ---- Core: dispatch multi-ref ----

test("dispatch: multi nodeIds preserve exact order in Context Card; dedupe; no claims[]", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  // Legacy claimId must equal first authoritative nodeId when both are present.
  const result = await dispatch(env as any, "bx-o1", "analyst", {
    userPrompt: "multi-node ordered work",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    nodeIds: ["bx-o1", "bx-p1", "bx-g1", "bx-p1", "bx-o1"],
  });

  const loaded = await loadTaskEnvelope(env.fs, result.taskPath);
  assert.deepEqual(taskReferencedNodeIds(loaded), ["bx-o1", "bx-p1", "bx-g1"]);
  assert.deepEqual(
    loaded.contextCard?.refs.nodes.map((n) => n.id),
    ["bx-o1", "bx-p1", "bx-g1"]
  );
  // Path hints present for resolved Nodes.
  assert.ok(loaded.contextCard!.refs.nodes.every((n) => typeof n.path === "string" && n.path));

  const raw = await env.fs.readFile(result.taskPath);
  const { data } = parseFrontmatter(raw);
  assert.equal("claims" in data, false);
  // Manifest may snapshot same ids as writable pointers (auxiliary).
  assert.match(result.manifestYaml, /id: bx-o1/);
  assert.match(result.manifestYaml, /id: bx-p1/);
  assert.match(result.manifestYaml, /id: bx-g1/);
  assert.doesNotMatch(result.manifestYaml, /^claims:/m);
});

test("dispatch: Role manifest snapshots only newly requested Nodes (no prior Role aggregation)", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  // Prior active Role Task on the same Role with a different Node set.
  const prior = await dispatch(env as any, "bx-p1", "analyst", {
    userPrompt: "prior active role task",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    nodeIds: ["bx-p1", "bx-p2"],
  });
  assert.deepEqual(
    taskReferencedNodeIds(await loadTaskEnvelope(env.fs, prior.taskPath)),
    ["bx-p1", "bx-p2"]
  );

  // New Task for the same Role must not silently import prior refs into manifest
  // or Context Card — exact requested ordered selection only (one fact).
  const next = await dispatch(env as any, "bx-o1", "analyst", {
    userPrompt: "new role task exact selection",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    nodeIds: ["bx-o1", "bx-g1"],
  });

  const loaded = await loadTaskEnvelope(env.fs, next.taskPath);
  assert.deepEqual(taskReferencedNodeIds(loaded), ["bx-o1", "bx-g1"]);
  assert.deepEqual(
    loaded.contextCard?.refs.nodes.map((n) => n.id),
    ["bx-o1", "bx-g1"]
  );

  // Auxiliary manifest selection is claimBoxes → writable scope. Readable still
  // lists full Tent context, so assert only the writable section for exactness.
  const writableSection = next.manifestYaml.split(/^writable:\r?\n/m)[1] ?? "";
  assert.ok(writableSection.length > 0, "manifest must emit writable section");
  assert.match(writableSection, /id: bx-o1/);
  assert.match(writableSection, /id: bx-g1/);
  // Prior Role Task Nodes must not enter this Task's selection/writable scope.
  assert.doesNotMatch(writableSection, /id: bx-p1\b/);
  assert.doesNotMatch(writableSection, /id: bx-p2\b/);
  assert.doesNotMatch(next.manifestYaml, /^claims:/m);
});

test("dispatch: missing / archived / invalid nodeIds zero-write (no task/manifest)", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  // Missing id
  await assert.rejects(
    () =>
      dispatch(env as any, "bx-p1", "analyst", {
        userPrompt: "missing node",
        parentActor: { kind: "user", id: "user" },
        nodeIds: ["bx-p1", "bx-does-not-exist"],
      }),
    /Box not found/
  );
  assert.equal(await env.fs.exists("temp/analyst"), false);

  // Archived
  await archiveBox(env as any, "bx-o1");
  await assert.rejects(
    () =>
      dispatch(env as any, "bx-p1", "executor", {
        userPrompt: "archived node",
        parentActor: { kind: "user", id: "user" },
        nodeIds: ["bx-p1", "bx-o1"],
      }),
    /Cannot dispatch:.*[Aa]rchiv/
  );
  assert.equal(await env.fs.exists("temp/executor"), false);

  // Root token mixed with concrete ids
  await assert.rejects(
    () =>
      dispatch(env as any, "bx-p1", "planner", {
        userPrompt: "mixed root",
        parentActor: { kind: "user", id: "user" },
        nodeIds: ["bx-p1", "root"],
      }),
    /whole Tent/
  );
  assert.equal(await env.fs.exists("temp/planner"), false);
});

test("dispatch: concurrent same/ancestor multi-ref remains legal; legacy single claimId still works", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  const first = await dispatch(env as any, "bx-p1", "analyst", {
    userPrompt: "first multi",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["bx-p1", "bx-p2"],
  });
  const second = await dispatch(env as any, "bx-p1", "executor", {
    userPrompt: "same node concurrent",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["bx-p1"],
  });
  const onAncestor = await dispatch(env as any, "bx-promptzone", "planner", {
    userPrompt: "ancestor concurrent",
    parentActor: { kind: "user", id: "user" },
    nodeIds: ["bx-promptzone", "bx-p1"],
  });
  assert.notEqual(first.taskPath, second.taskPath);
  assert.ok(onAncestor.taskPath);

  // Legacy single claimId path unchanged (string prompt shorthand).
  const legacy = await dispatch(env as any, "bx-g1", "architect", "legacy single id");
  const legacyLoaded = await loadTaskEnvelope(env.fs, legacy.taskPath);
  assert.deepEqual(taskReferencedNodeIds(legacyLoaded), ["bx-g1"]);
});

test("dispatch: conflicting legacy claimId + nodeIds rejects before write", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  await assert.rejects(
    () =>
      dispatch(env as any, "bx-p1", "analyst", {
        userPrompt: "conflict",
        parentActor: { kind: "user", id: "user" },
        nodeIds: ["bx-o1", "bx-p1"],
      }),
    /conflicts with authoritative nodeIds/
  );
  assert.equal(await env.fs.exists("temp/analyst"), false);
});

// ---- Service RPC ----

async function makeWorkspace(name = "mn-dispatch"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `tent-${name}-`));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
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
    idA: (a.result as { id: string }).id,
    idB: (b.result as { id: string }).id,
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
      assigneeKind: "agentProfile",
      profileId: "fake-default",
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
  });
});

test("service task.dispatch: missing/archived nodeIds fail before write; legacy conflict rejects", async () => {
  const ws = await makeWorkspace("svc-fail");
  await withService(async (svc) => {
    const { workspaceId, idA, idB } = await mountTwoNotes(svc, ws);

    const missing = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [idA, "bx-missing-zz"],
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "missing ref",
    });
    assert.ok(missing.error, "expected missing node fail");
    assert.match(String(missing.error.message || missing.error), /Box not found|not found/i);

    // Empty nodeIds
    const empty = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [],
      assigneeKind: "agentProfile",
      profileId: "fake-default",
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
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "bad type",
    });
    assert.ok(bad.error);
    assert.match(String(bad.error.message || bad.error), /nodeIds/i);

    // Conflict: boxId primary ≠ first nodeIds
    const conflict = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId: idA,
      nodeIds: [idB, idA],
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "conflict",
    });
    assert.ok(conflict.error);
    assert.match(String(conflict.error.message || conflict.error), /conflicts/i);

    // Compatible dual input (boxId === first nodeId) succeeds
    const ok = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId: idB,
      nodeIds: [idB, idA],
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "compatible dual",
    });
    assert.ok(!ok.error, JSON.stringify(ok.error));
    const tentFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(
      tentFs,
      (ok.result as { taskPath: string }).taskPath
    );
    assert.deepEqual(taskReferencedNodeIds(task), [idB, idA]);

    // Fresh free node for archive gate (idA/idB are still directly referenced).
    const freeNote = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "gamma-free",
      type: "prompt",
    });
    assert.ok(!freeNote.error, JSON.stringify(freeNote.error));
    const idFree = (freeNote.result as { id: string }).id;

    const beforeList = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!beforeList.error);
    const beforeCount = ((beforeList.result as { tasks: unknown[] }).tasks ?? []).length;

    const arch = await rpc(svc, "docs.setMode", {
      workspaceId,
      id: idFree,
      mode: "archived",
    });
    assert.ok(!arch.error, JSON.stringify(arch.error));

    const archivedDispatch = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [idB, idFree],
      assigneeKind: "agentProfile",
      profileId: "fake-default",
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

test("service task.dispatch: Role queued vs agentProfile semantics unchanged with nodeIds", async () => {
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

    const profileD = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [idB],
      assigneeKind: "agentProfile",
      profileId: "fake-default",
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
    assert.deepEqual(taskReferencedNodeIds(profileTask), [idB]);
  });
});
