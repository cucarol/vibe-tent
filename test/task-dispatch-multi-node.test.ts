import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { archiveNode, dispatch } from "../src/core/ops.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadTaskRecord } from "../src/core/task.js";
import { normalizeTaskNodeSelection } from "../src/core/task-node-selection.js";
import { taskReferencedNodeIds } from "../src/core/task-node-refs.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { rpcCall } from "../src/service/http-server.js";
import { startLocalTentService } from "../src/service/service.js";
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

async function ensureRole(env: { fs: NodeFs }, roleId: string) {
  const canonicalRoleId = roleId.startsWith("rl-") ? roleId : `rl-${roleId}`;
  const registryPath = "roles.json";
  const registry = await env.fs.exists(registryPath)
    ? JSON.parse(await env.fs.readFile(registryPath)) as { roles?: Array<Record<string, unknown>> }
    : { roles: [] as Array<Record<string, unknown>> };
  if (!(registry.roles ?? []).some((role) => role.id === canonicalRoleId)) {
    registry.roles = [
      ...(registry.roles ?? []),
      { id: canonicalRoleId, name: roleId.replace(/^rl-/, ""), displayName: roleId.replace(/^rl-/, "") },
    ];
    await env.fs.writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n");
  }
  return canonicalRoleId;
}

async function dispatchToRole(
  env: ReturnType<typeof envFor>,
  roleId: string,
  input: {
    nodeIds: string[];
    prompt: string;
    requester?: { kind: "user" | "role"; id: string };
  }
) {
  return dispatch(env as any, {
    assigneeRoleId: await ensureRole({ fs: env.fs }, roleId),
    nodeIds: input.nodeIds,
    prompt: input.prompt,
    requester: input.requester ?? { kind: "user", id: "user" },
  });
}

async function withService<T>(fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-dispatch-data-"));
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

function rpc(svc: Awaited<ReturnType<typeof startLocalTentService>>, method: string, params?: Record<string, unknown>) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

async function makeWorkspace(name: string) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `tent-dispatch-${name}-`));
  const workspaceFs = new NodeFs(workspace);
  await scaffoldInWorkspace(workspaceFs, {
    name,
    nodes: [
      { name: "alpha", type: "prompt", body: "# Alpha\n" },
      { name: "beta", type: "goal", body: "# Beta\n" },
      { name: "gamma", type: "reference", body: "# Gamma\n" },
    ],
  });
  await workspaceFs.writeFile(
    ".tent/roles.json",
    JSON.stringify({
      roles: [{ id: "rl-executor", name: "executor", displayName: "Executor", prompt: "work" }],
    }, null, 2) + "\n"
  );
  return workspace;
}

async function mountNamedNodes(svc: Awaited<ReturnType<typeof startLocalTentService>>, workspace: string) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: workspace });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
  const tentFs = new NodeFs(path.join(workspace, ".tent"));
  const tree = await import("../src/core/tree.js").then(({ loadTent }) => loadTent(tentFs));
  const ids = new Map<string, string>();
  for (const node of tree.byId.values()) ids.set(node.name, node.id);
  return { workspaceId, tentFs, ids };
}

test("Task nodeIds keep order and allow prompt-only Tasks", () => {
  assert.deepEqual(
    normalizeTaskNodeSelection({
      nodeIds: ["cx-p1", "cx-o1", "cx-g1"],
    }),
    { nodeIds: ["cx-p1", "cx-o1", "cx-g1"] }
  );
  assert.deepEqual(
    normalizeTaskNodeSelection({
      nodeIds: [],
    }),
    { nodeIds: [] }
  );
  assert.throws(
    () =>
      normalizeTaskNodeSelection({
        nodeIds: ["cx-p1", "  "],
      }),
    /canonical lowercase cx-\* Node ids/
  );
  assert.throws(
    () =>
      normalizeTaskNodeSelection({
        nodeIds: ["root"],
      }),
    /canonical lowercase cx-\* Node ids/
  );
  assert.throws(
    () =>
      normalizeTaskNodeSelection({
        nodeIds: undefined,
      }),
    /Task nodeIds must be an array/
  );
});

test("dispatch freezes exact nodeIds order and archived roots remain legal context", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  await archiveNode(env as any, "cx-o1");

  const result = await dispatchToRole(env, "analyst", {
    prompt: "multi-node ordered work",
    nodeIds: ["cx-o1", "cx-p1", "cx-g1"],
  });

  const loaded = await loadTaskRecord(env.fs, result.taskPath);
  assert.deepEqual(taskReferencedNodeIds(loaded), ["cx-o1", "cx-p1", "cx-g1"]);
  assert.deepEqual(loaded.contextCard.nodeIds, ["cx-o1", "cx-p1", "cx-g1"]);
  assert.deepEqual(
    loaded.contextCard.nodeSnapshots.map((snapshot) => snapshot.id),
    ["cx-o1", "cx-p1", "cx-p2", "cx-g1", "cx-g2"]
  );
  assert.equal(loaded.contextCard.nodeSnapshots[0]?.archived, true);

  const raw = await env.fs.readFile(result.taskPath);
  const { data } = parseFrontmatter(raw);
  assert.equal("claims" in data, false);
  assert.match(result.manifestYaml, /id: cx-p1/);
  assert.match(result.manifestYaml, /id: cx-g1/);
  assert.doesNotMatch(result.manifestYaml, /id: cx-o1/);
  assert.doesNotMatch(result.manifestYaml, /^claims:/m);
});

test("dispatch dedupes overlapping selected roots inside frozen subtree snapshots", async () => {
  const dir = await makeTent();
  const env = envFor(dir);

  const result = await dispatchToRole(env, "analyst", {
    prompt: "overlapping roots stay deterministic",
    nodeIds: ["cx-p1", "cx-p2"],
  });

  const loaded = await loadTaskRecord(env.fs, result.taskPath);
  assert.deepEqual(taskReferencedNodeIds(loaded), ["cx-p1", "cx-p2"]);
  assert.deepEqual(loaded.contextCard.nodeIds, ["cx-p1", "cx-p2"]);
  assert.deepEqual(
    loaded.contextCard.nodeSnapshots.map((snapshot) => snapshot.id),
    ["cx-p1", "cx-p2"]
  );
});

test("dispatch keeps archived roots and descendants as frozen context without manifest authority", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  await archiveNode(env as any, "cx-p1");

  const result = await dispatchToRole(env, "analyst", {
    prompt: "archived subtree remains frozen context",
    nodeIds: ["cx-p1"],
  });

  const loaded = await loadTaskRecord(env.fs, result.taskPath);
  assert.deepEqual(taskReferencedNodeIds(loaded), ["cx-p1"]);
  assert.deepEqual(loaded.contextCard.nodeSnapshots.map((snapshot) => snapshot.id), ["cx-p1", "cx-p2"]);
  assert.deepEqual(loaded.contextCard.nodeSnapshots.map((snapshot) => snapshot.archived), [true, true]);
  assert.doesNotMatch(result.manifestYaml, /id: cx-p1/);
  assert.doesNotMatch(result.manifestYaml, /id: cx-p2/);
  assert.doesNotMatch(result.manifestYaml, /path: prompt\/表达式任务书\/?$/m);
  assert.doesNotMatch(result.manifestYaml, /path: prompt\/表达式任务书\/草稿\/?$/m);
});

test("dispatch supports prompt-only Tasks without a placeholder Node", async () => {
  const dir = await makeTent();
  const env = envFor(dir);
  const result = await dispatch(env as any, {
    executionSessionId: "ss-promptonly",
    nodeIds: [],
    prompt: "prompt only",
    requester: { kind: "user", id: "user" },
  });
  const loaded = await loadTaskRecord(env.fs, result.taskPath);
  assert.deepEqual(taskReferencedNodeIds(loaded), []);
  assert.deepEqual(loaded.contextCard.nodeIds, []);
  assert.deepEqual(loaded.contextCard.nodeSnapshots, []);
});

test("service task.dispatch preserves exact nodeIds order and allows concurrent references", async () => {
  const workspace = await makeWorkspace("svc-multi");
  await withService(async (svc) => {
    const { workspaceId, tentFs, ids } = await mountNamedNodes(svc, workspace);
    const alpha = ids.get("alpha")!;
    const beta = ids.get("beta")!;
    const gamma = ids.get("gamma")!;

    const first = await rpc(svc, "task.dispatch", {
      requester: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [beta, alpha, gamma],
      connectionId: FAKE_CONNECTION.connectionId,
      prompt: "service multi-node ordered",
    });
    assert.ok(!first.error, JSON.stringify(first.error));
    const firstTask = await loadTaskRecord(tentFs, (first.result as { taskPath: string }).taskPath);
    assert.deepEqual(taskReferencedNodeIds(firstTask), [beta, alpha, gamma]);
    assert.deepEqual(firstTask.contextCard.nodeIds, [beta, alpha, gamma]);

    const second = await rpc(svc, "task.dispatch", {
      requester: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [beta],
      connectionId: FAKE_CONNECTION.connectionId,
      prompt: "same node, still legal",
    });
    assert.ok(!second.error, JSON.stringify(second.error));

    const listed = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!listed.error, JSON.stringify(listed.error));
    const tasks = (listed.result as { tasks: Array<{ nodeIds: string[] }> }).tasks;
    assert.equal(tasks.filter((task) => task.nodeIds.includes(beta)).length, 2);
  });
});

test("service task.dispatch rejects retired fields and malformed nodeIds before write", async () => {
  const workspace = await makeWorkspace("svc-invalid");
  await withService(async (svc) => {
    const { workspaceId, ids } = await mountNamedNodes(svc, workspace);

    const before = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!before.error, JSON.stringify(before.error));
    const beforeCount = ((before.result as { tasks: unknown[] }).tasks ?? []).length;

    const retired = await rpc(svc, "task.dispatch", {
      requester: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [ids.get("alpha")!],
      workNodeIds: ["cx-retired"],
      prompt: "retired field",
      connectionId: FAKE_CONNECTION.connectionId,
    });
    assert.ok(retired.error);
    assert.equal(retired.error.code, -32602);
    assert.match(String(retired.error.message || retired.error), /unknown parameter/i);

    const malformed = await rpc(svc, "task.dispatch", {
      requester: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: ["cx-alpha", 42],
      prompt: "bad nodeIds",
      connectionId: FAKE_CONNECTION.connectionId,
    });
    assert.ok(malformed.error);
    assert.match(String(malformed.error.message || malformed.error), /canonical lowercase cx-\* Node ids|nodeIds/i);

    const promptOnly = await rpc(svc, "task.dispatch", {
      requester: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [],
      prompt: "prompt-only service",
      connectionId: FAKE_CONNECTION.connectionId,
    });
    assert.ok(!promptOnly.error, JSON.stringify(promptOnly.error));

    const after = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!after.error, JSON.stringify(after.error));
    const afterCount = ((after.result as { tasks: unknown[] }).tasks ?? []).length;
    assert.equal(afterCount, beforeCount + 1, "only the prompt-only valid dispatch should create a Task");
  });
});
