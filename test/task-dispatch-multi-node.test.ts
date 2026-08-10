/**
 * Multi-Node dispatch runtime seam (work/context Node selection):
 * - Core: exact ordered selection → frozen Node snapshots; structural gates; concurrency
 * - Service: canonical work/context parsing; retired field rejection; conflict reject; zero-write
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
import { dispatch, resolveDispatchTaskNodeSelection, archiveNode } from "../src/core/ops.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { makeTent } from "./helpers.js";

function envFor(dir: string) {
  return {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-07-30T12:00:00.000Z" },
    tentName: "demo",
    tentRoot: dir,
  };
}

const FAKE_CONNECTION = {
  connectionId: "fake-default",
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, sleepMs: 60_000 },
} as const;

async function dispatchToRole(env: any, nodeId: string, roleId: string, input: Record<string, unknown>) {
  const canonicalRoleId = roleId.startsWith("rl-") ? roleId : `rl-${roleId}`;
  const registry = await env.fs.exists("roles.json")
    ? JSON.parse(await env.fs.readFile("roles.json")) as { roles?: Array<Record<string, unknown>> }
    : { roles: [] as Array<Record<string, unknown>> };
  if (!(registry.roles ?? []).some((role) => role.id === canonicalRoleId)) {
    registry.roles = [...(registry.roles ?? []), {
      id: canonicalRoleId,
      name: roleId.replace(/^rl-/, ""),
      displayName: roleId.replace(/^rl-/, ""),
    }];
    await env.fs.writeFile("roles.json", JSON.stringify(registry, null, 2) + "\n");
  }
  const { workNodeIds, contextNodeIds, ...rest } = input as {
    workNodeIds?: string[];
    contextNodeIds?: string[];
  };
  return dispatch(env, nodeId, {
    roleId: canonicalRoleId,
    workNodeIds: workNodeIds ?? [nodeId],
    contextNodeIds: contextNodeIds ?? [],
    parentActor: { kind: "user", id: "user" },
    ...rest,
  });
}

// ---- Core: resolveDispatchTaskNodeSelection ----

test("resolveDispatchTaskNodeSelection: work/context Nodes are ordered and validated", () => {
  assert.deepEqual(
    resolveDispatchTaskNodeSelection({
      workNodeIds: ["cx-p1", "cx-o1"],
      contextNodeIds: ["cx-g1"],
      tentName: "demo",
    }),
    { workNodeIds: ["cx-p1", "cx-o1"], contextNodeIds: ["cx-g1"] }
  );
  assert.throws(
    () => resolveDispatchTaskNodeSelection({ workNodeIds: [], contextNodeIds: [], tentName: "demo" }),
    /at least one Node/
  );
  assert.throws(
    () =>
      resolveDispatchTaskNodeSelection({
        workNodeIds: ["cx-p1"],
        contextNodeIds: ["  "],
        tentName: "demo",
      }),
    /canonical lowercase cx-\* Node ids/
  );
  assert.throws(
    () =>
      resolveDispatchTaskNodeSelection({
        workNodeIds: ["root"],
        contextNodeIds: [],
        tentName: "demo",
      }),
    /canonical lowercase cx-\* Node ids/
  );
  assert.throws(
    () => resolveDispatchTaskNodeSelection({ workNodeIds: undefined, contextNodeIds: [], tentName: "demo" }),
    /workNodeIds must be an array/
  );
});

// ---- Core: dispatch multi-ref ----

test("dispatch: work/context Nodes preserve exact order in Context Card; dedupe; no claims[]", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  const result = await dispatchToRole(env as any, "cx-o1", "analyst", {
    userPrompt: "multi-node ordered work",
    parentActor: { kind: "user", id: "user" },
    workNodeIds: ["cx-o1", "cx-p1"],
    contextNodeIds: ["cx-g1"],
  });

  const loaded = await loadTaskEnvelope(env.fs, result.taskPath);
  assert.deepEqual(taskReferencedNodeIds(loaded), ["cx-o1", "cx-p1", "cx-g1"]);
  assert.deepEqual(
    loaded.contextCard?.workNodeIds,
    ["cx-o1", "cx-p1"]
  );
  assert.deepEqual(loaded.contextCard?.contextNodeIds, ["cx-g1"]);
  assert.deepEqual(loaded.contextCard?.nodeSnapshots.map((snapshot) => snapshot.id), ["cx-o1", "cx-p1", "cx-g1"]);

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

  const result = await dispatchToRole(env as any, "cx-o1", "analyst", {
    userPrompt: prompt,
    parentActor: { kind: "user", id: "user" },
    workNodeIds: ["cx-o1"],
    contextNodeIds: [],
  });

  const raw = await env.fs.readFile(result.taskPath);
  assert.doesNotMatch(raw, /objective:|acceptance:|refs:/);
  const loaded = await loadTaskEnvelope(env.fs, result.taskPath);
  assert.equal(loaded.contextCard.schemaVersion, "v2");
  assert.deepEqual(loaded.contextCard.workNodeIds, ["cx-o1"]);
  assert.deepEqual(loaded.contextCard.contextNodeIds, []);
  assert.ok(loaded.prompt?.endsWith(prompt));
  assert.equal(loaded.prompt?.split(prompt).length, 2, "raw prompt appears exactly once");
});

test("dispatch: Role manifest snapshots only newly requested Nodes (no prior Role aggregation)", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  const prior = await dispatchToRole(env as any, "cx-p1", "analyst", {
    userPrompt: "prior role task",
    workNodeIds: ["cx-p1", "cx-p2"],
    contextNodeIds: [],
  });
  assert.deepEqual(
    taskReferencedNodeIds(await loadTaskEnvelope(env.fs, prior.taskPath)),
    ["cx-p1", "cx-p2"]
  );

  const next = await dispatchToRole(env as any, "cx-o1", "analyst", {
    userPrompt: "new role task exact selection",
    workNodeIds: ["cx-o1"],
    contextNodeIds: ["cx-g1"],
  });
  const loaded = await loadTaskEnvelope(env.fs, next.taskPath);
  assert.deepEqual(taskReferencedNodeIds(loaded), ["cx-o1", "cx-g1"]);
  assert.deepEqual(
    loaded.contextCard.nodeSnapshots.map((node) => node.id),
    ["cx-o1", "cx-g1"]
  );
  assert.equal(await env.fs.readFile(next.manifestPath), next.manifestYaml);

  const writableSection = next.manifestYaml.split(/^writable:\r?\n/m)[1] ?? "";
  assert.ok(writableSection.length > 0, "manifest must emit writable section");
  assert.match(writableSection, /id: cx-o1/);
  assert.doesNotMatch(writableSection, /id: cx-g1/);
  assert.doesNotMatch(writableSection, /id: cx-p1\b/);
  assert.doesNotMatch(writableSection, /id: cx-p2\b/);
  assert.doesNotMatch(next.manifestYaml, /^claims:/m);
});

test("dispatch: missing / archived / invalid Node selection zero-write (no task/manifest)", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  // Missing id
  await assert.rejects(
    () =>
      dispatchToRole(env as any, "cx-p1", "analyst", {
        userPrompt: "missing node",
        parentActor: { kind: "user", id: "user" },
        workNodeIds: ["cx-p1"],
        contextNodeIds: ["cx-doesnotexist"],
      }),
    /Node not found/
  );
  assert.equal(await env.fs.exists("temp/analyst"), false);

  // Archived
  await archiveNode(env as any, "cx-o1");
  await assert.rejects(
    () =>
      dispatchToRole(env as any, "cx-o1", "executor", {
        userPrompt: "archived node",
        parentActor: { kind: "user", id: "user" },
        workNodeIds: ["cx-o1"],
        contextNodeIds: [],
      }),
    /Cannot dispatch:.*[Aa]rchiv/
  );
  assert.equal(await env.fs.exists("temp/executor"), false);

  // An archived Node may remain read-only context for a different work Node.
  const contextDir = await makeTent();
  const contextEnv = envFor(contextDir);
  await archiveNode(contextEnv as any, "cx-o1");
  const contextDispatch = await dispatchToRole(contextEnv as any, "cx-p1", "reader", {
    userPrompt: "read archived context",
    workNodeIds: ["cx-p1"],
    contextNodeIds: ["cx-o1"],
  });
  assert.ok(contextDispatch.taskPath);

  // Root token mixed with concrete ids
  await assert.rejects(
    () =>
      dispatchToRole(env as any, "cx-p1", "planner", {
        userPrompt: "mixed root",
        parentActor: { kind: "user", id: "user" },
        workNodeIds: ["cx-p1"],
        contextNodeIds: ["root"],
      }),
    /canonical lowercase cx-\* Node ids/
  );
  assert.equal(await env.fs.exists("temp/planner"), false);
});

test("dispatch: canonical Task id is fail-loud and cannot alias an existing Task", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  await assert.rejects(
    () =>
      dispatch(env as any, "cx-p1", {
        sessionId: "ss-invalidtask",
        taskId: "tk-bad/path",
        workNodeIds: ["cx-p1"],
        contextNodeIds: [],
        userPrompt: "invalid Task id must not allocate paths",
        parentActor: { kind: "user", id: "user" },
      }),
    /Invalid Task id/
  );
  assert.equal(await env.fs.exists("temp/sessions/ss-invalidtask"), false);

  const first = await dispatch(env as any, "cx-p1", {
    sessionId: "ss-firsttask",
    taskId: "tk-exactcollision",
    workNodeIds: ["cx-p1"],
    contextNodeIds: [],
    userPrompt: "first exact Task identity",
    parentActor: { kind: "user", id: "user" },
  });
  assert.equal((await loadTaskEnvelope(env.fs, first.taskPath)).id, "tk-exactcollision");

  await assert.rejects(
    () =>
      dispatch(env as any, "cx-o1", {
        sessionId: "ss-secondtask",
        taskId: "tk-exactcollision",
        workNodeIds: ["cx-o1"],
        contextNodeIds: [],
        userPrompt: "duplicate Task identity must fail before writes",
        parentActor: { kind: "user", id: "user" },
      }),
    /Task id already exists/
  );
  assert.equal(await env.fs.exists("temp/sessions/ss-secondtask"), false);
});

test("dispatch: exact Node occupation blocks only the same Node and releases on terminal states", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  const first = await dispatchToRole(env as any, "cx-p1", "analyst", {
    userPrompt: "first exact Node task",
    parentActor: { kind: "user", id: "user" },
    workNodeIds: ["cx-p1", "cx-p2"],
    contextNodeIds: [],
  });
  await assert.rejects(
    () =>
      dispatchToRole(env as any, "cx-p1", "executor", {
        userPrompt: "same Node concurrent",
        parentActor: { kind: "user", id: "user" },
        workNodeIds: ["cx-p1"],
        contextNodeIds: [],
      }),
    /occupied by active task/
  );
  assert.equal(await env.fs.exists("temp/executor"), false);

  // Parent/child and sibling Nodes are separate contexts and remain concurrent.
  const parent = await dispatchToRole(env as any, "cx-promptzone", "planner", {
    userPrompt: "parent context concurrent",
    parentActor: { kind: "user", id: "user" },
    workNodeIds: ["cx-promptzone"],
    contextNodeIds: [],
  });
  const sibling = await dispatchToRole(env as any, "cx-g1", "reviewer", {
    userPrompt: "sibling context concurrent",
    parentActor: { kind: "user", id: "user" },
    workNodeIds: ["cx-g1"],
    contextNodeIds: [],
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
        dispatchToRole(env as any, "cx-p1", "executor", {
          userPrompt: `blocked while ${state}`,
          parentActor: { kind: "user", id: "user" },
          workNodeIds: ["cx-p1"],
          contextNodeIds: [],
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
    const released = await dispatchToRole(env as any, "cx-p1", "executor", {
      userPrompt: `released after ${state}`,
      parentActor: { kind: "user", id: "user" },
      workNodeIds: ["cx-p1"],
      contextNodeIds: [],
    });
    assert.ok(released.taskPath);
    await patchTaskEnvelope(env.fs, released.taskPath, {
      state: "failed",
      updatedAt: "2026-07-30T12:00:00.000Z",
    });
  }
});

test("dispatch: malformed work/context selection rejects before any Task or manifest write", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  await assert.rejects(
    () =>
      dispatchToRole(env as any, "cx-o1", "analyst", {
        userPrompt: "conflict",
        parentActor: { kind: "user", id: "user" },
        workNodeIds: ["cx-o1"],
        contextNodeIds: [" "],
      }),
    /canonical lowercase cx-\* Node ids/
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
          { id: "rl-executor", name: "executor", prompt: "do work" },
          { id: "rl-orchestrator", name: "orchestrator", prompt: "dispatch work" },
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
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    connections: [FAKE_CONNECTION],
  });
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

test("service task.dispatch: work/context Nodes are ordered in the Context Card", async () => {
  const ws = await makeWorkspace("svc-multi");
  await withService(async (svc) => {
    const { workspaceId, idA, idB } = await mountTwoNotes(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [idB],
      contextNodeIds: [idA],
      connectionId: "fake-default",
      prompt: "service multi-node ordered",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const result = d.result as { taskPath: string; state: string; sessionId?: string };
    assert.equal(result.state, "running");

    const tentFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(tentFs, result.taskPath);
    assert.deepEqual(taskReferencedNodeIds(task), [idB, idA]);
    assert.deepEqual(task.workNodeIds, [idB]);
    assert.deepEqual(task.contextNodeIds, [idA]);
    assert.equal(task.sessionId, result.sessionId);
    assert.equal("claims" in (parseFrontmatter(await tentFs.readFile(result.taskPath)).data), false);

    const blocked = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [idB],
      contextNodeIds: [],
      connectionId: "fake-default",
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
      workspaceId,
      workNodeIds: [idA],
      contextNodeIds: ["cx-missingzz"],
      connectionId: "fake-default",
      prompt: "missing ref",
    });
    assert.ok(missing.error, "expected missing node fail");
    assert.match(String(missing.error.message || missing.error), /Node not found|not found/i);

    // Empty work selection
    const empty = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "empty",
    });
    assert.ok(empty.error);
    assert.match(String(empty.error.message || empty.error), /non-empty|workNodeIds/i);

    // Malformed context selection (not string[])
    const bad = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [idA],
      contextNodeIds: [42],
      connectionId: "fake-default",
      prompt: "bad type",
    });
    assert.ok(bad.error);
    assert.match(String(bad.error.message || bad.error), /contextNodeIds/i);

    for (const retiredField of ["nodeId", "id", "claimId"] as const) {
      const retired = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        workspaceId,
        [retiredField]: idA,
        workNodeIds: [idB],
        contextNodeIds: [],
        connectionId: "fake-default",
        prompt: `retired ${retiredField}`,
      });
      assert.ok(retired.error, `${retiredField} must fail loud`);
      assert.match(
        String(retired.error.message || retired.error),
        new RegExp(`unknown parameter.*${retiredField}|workNodeIds|contextNodeIds`, "i")
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
      workspaceId,
      workNodeIds: [idFree],
      contextNodeIds: [],
      connectionId: "fake-default",
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

test("service task.dispatch: Role and route Tasks use distinct Node selections", async () => {
  const ws = await makeWorkspace("svc-role");
  await withService(async (svc) => {
    const { workspaceId, idA, idB } = await mountTwoNotes(svc, ws);

    const roleD = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [idA],
      contextNodeIds: [idB],
      roleId: "rl-executor",
      prompt: "role multi-node",
    });
    assert.ok(!roleD.error, JSON.stringify(roleD.error));
    const roleResult = roleD.result as { roleId?: string; state: string; taskPath: string };
    assert.equal(roleResult.roleId, "rl-executor");
    assert.equal(roleResult.state, "queued");
    assert.match(roleResult.taskPath, /^temp\/roles\/rl-executor\/tasks\//);

    const extra = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "gamma-node",
      type: "prompt",
    });
    assert.ok(!extra.error, JSON.stringify(extra.error));
    const idC = (extra.result as { nodeId: string }).nodeId;

    const routeD = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [idC],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "route multi-node",
    });
    assert.ok(!routeD.error, JSON.stringify(routeD.error));
    const routeResult = routeD.result as { sessionId?: string; state: string; taskPath: string };
    assert.equal(typeof routeResult.sessionId, "string");
    assert.match(routeResult.taskPath, /^temp\/sessions\//);

    const tentFs = new NodeFs(path.join(ws, ".tent"));
    const roleTask = await loadTaskEnvelope(tentFs, roleResult.taskPath);
    const routeTask = await loadTaskEnvelope(tentFs, routeResult.taskPath);
    assert.deepEqual(taskReferencedNodeIds(roleTask), [idA, idB]);
    assert.deepEqual(taskReferencedNodeIds(routeTask), [idC]);
  });
});
