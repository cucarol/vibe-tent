import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { nodeNotePath } from "../src/core/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createServiceClient } from "../src/service/client.js";
import { rpcCall } from "../src/service/http-server.js";
import { startLocalTentService } from "../src/service/service.js";
import type { OutputProvenance } from "../src/service/types.js";

async function withService<T>(fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-output-result-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

function rpc(svc: Awaited<ReturnType<typeof startLocalTentService>>, method: string, params?: Record<string, unknown>) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tent-output-result-ws-"));
  const fsa = new NodeFs(root);
  await scaffoldInWorkspace(fsa, { name: "output-result", nodes: [{ name: "inbox", body: "# inbox\n" }] });
  await fsa.writeFile(".tent/roles.json", JSON.stringify({ roles: [{ id: "rl-executor", name: "executor", prompt: "work" }] }) + "\n");
  return root;
}

async function createNote(svc: Awaited<ReturnType<typeof startLocalTentService>>, workspaceId: string, name: string, type?: string) {
  const created = await rpc(svc, "docs.createNote", { workspaceId, name, ...(type ? { type } : {}) });
  assert.ok(!created.error, JSON.stringify(created.error));
  return created.result as { nodeId: string; path: string };
}

async function submitReadyResult(svc: Awaited<ReturnType<typeof startLocalTentService>>, workspaceId: string, root: string, nodeId: string) {
  const dispatched = await rpc(svc, "task.dispatch", {
    workspaceId,
    nodeIds: [nodeId],
    assigneeRoleId: "rl-executor",
    prompt: "produce formal result",
    requester: { kind: "user", id: "user" },
  });
  assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
  const taskPath = (dispatched.result as { taskPath: string }).taskPath;
  const entered = await rpc(svc, "session.enter", { workspaceId, roleId: "rl-executor", cwd: root });
  assert.ok(!entered.error, JSON.stringify(entered.error));
  const session = entered.result as { session: { sessionId: string }; sessionToken: string };
  const client = createServiceClient({ baseUrl: svc.url, token: svc.token, currentSessionId: session.session.sessionId, currentSessionToken: session.sessionToken });
  await client.taskClaim(workspaceId, taskPath);
  const submitted = await client.taskSubmit(workspaceId, taskPath, {
    report: "formal result body",
    artifactRefs: [{ kind: "path", target: "dist/formal.txt" }],
  }) as { result: { id: string } };
  return { taskPath, resultId: submitted.result.id };
}

test("task.accept never mutates Node or binds Output", async () => {
  await withService(async (svc) => {
    const root = await workspace();
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: root });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const source = await createNote(svc, workspaceId, "job", "prompt");
    const output = await createNote(svc, workspaceId, "published", "output");
    const { taskPath, resultId } = await submitReadyResult(svc, workspaceId, root, source.nodeId);
    const fsa = new NodeFs(path.join(root, ".tent"));
    const before = await fsa.readFile(nodeNotePath(output.path));

    const accepted = await rpc(svc, "task.accept", { workspaceId, resultId, actor: "user" });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    assert.equal((accepted.result as { state: string }).state, "accepted");
    assert.equal(await fsa.readFile(nodeNotePath(output.path)), before);
    const task = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((task.result as { task: { state: string; currentResultId?: string } }).task.state, "accepted");
    assert.equal((task.result as { task: { currentResultId?: string } }).task.currentResultId, resultId);
  });
});

test("task.bindOutput explicitly binds an accepted Result and is idempotent", async () => {
  await withService(async (svc) => {
    const root = await workspace();
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: root });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const source = await createNote(svc, workspaceId, "job", "prompt");
    const output = await createNote(svc, workspaceId, "published", "output");
    const { resultId } = await submitReadyResult(svc, workspaceId, root, source.nodeId);
    assert.ok(!(await rpc(svc, "task.accept", { workspaceId, resultId, actor: "user" })).error);

    const bound = await rpc(svc, "task.bindOutput", {
      workspaceId,
      resultId,
      outputNodeIds: [output.nodeId],
      actor: "user",
    });
    assert.ok(!bound.error, JSON.stringify(bound.error));
    assert.deepEqual(
      (bound.result as { outputNodeIds: string[]; changedNodeIds: string[] }).outputNodeIds,
      [output.nodeId]
    );
    assert.deepEqual(
      (bound.result as { changedNodeIds: string[] }).changedNodeIds,
      [output.nodeId]
    );

    const retry = await rpc(svc, "task.bindOutput", {
      workspaceId,
      resultId,
      outputNodeIds: [output.nodeId],
      actor: "user",
    });
    assert.ok(!retry.error, JSON.stringify(retry.error));
    assert.deepEqual((retry.result as { changedNodeIds: string[] }).changedNodeIds, []);

    const provenance = await rpc(svc, "output.provenance", { workspaceId, nodeId: output.nodeId });
    assert.ok(!provenance.error, JSON.stringify(provenance.error));
    const value = provenance.result as OutputProvenance;
    assert.equal(value.resultId, resultId);
    assert.equal(value.result?.status, "accepted");
    assert.deepEqual(value.result?.artifactRefs, [{ kind: "path", target: "dist/formal.txt" }]);
  });
});

test("task.bindOutput rejects an unaccepted Result without changing any Output", async () => {
  await withService(async (svc) => {
    const root = await workspace();
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: root });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const source = await createNote(svc, workspaceId, "job", "prompt");
    const output = await createNote(svc, workspaceId, "published", "output");
    const { resultId } = await submitReadyResult(svc, workspaceId, root, source.nodeId);
    const fsa = new NodeFs(path.join(root, ".tent"));
    const before = await fsa.readFile(nodeNotePath(output.path));

    const denied = await rpc(svc, "task.bindOutput", {
      workspaceId,
      resultId,
      outputNodeIds: [output.nodeId],
      actor: "user",
    });
    assert.ok(denied.error);
    assert.equal((denied.error?.data as { code?: string })?.code, "RESULT_NOT_ACCEPTED");
    assert.equal(await fsa.readFile(nodeNotePath(output.path)), before);
  });
});

test("task.bindOutput validates every target before writing any provenance", async () => {
  await withService(async (svc) => {
    const root = await workspace();
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: root });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const source = await createNote(svc, workspaceId, "job", "prompt");
    const output = await createNote(svc, workspaceId, "published", "output");
    const notOutput = await createNote(svc, workspaceId, "ordinary", "prompt");
    const { resultId } = await submitReadyResult(svc, workspaceId, root, source.nodeId);
    assert.ok(!(await rpc(svc, "task.accept", { workspaceId, resultId, actor: "user" })).error);

    const fsa = new NodeFs(path.join(root, ".tent"));
    const before = await fsa.readFile(nodeNotePath(output.path));
    const denied = await rpc(svc, "task.bindOutput", {
      workspaceId,
      resultId,
      outputNodeIds: [output.nodeId, notOutput.nodeId],
      actor: "user",
    });
    assert.ok(denied.error);
    assert.equal(await fsa.readFile(nodeNotePath(output.path)), before);
  });
});

test("generic Node writes cannot forge an Output Result link", async () => {
  await withService(async (svc) => {
    const root = await workspace();
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: root });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const output = await createNote(svc, workspaceId, "published", "output");
    const edit = await rpc(svc, "docs.readForEdit", { workspaceId, nodeId: output.nodeId });
    const denied = await rpc(svc, "docs.write", {
      workspaceId,
      nodeId: output.nodeId,
      baseEtag: (edit.result as { etag: string }).etag,
      frontmatter: { resultId: "rs-forged01" },
    });
    assert.ok(denied.error);
  });
});
