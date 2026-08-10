/**
 * V0.2 Output provenance (cx-f2kxd4):
 * - task.accept outputNodeIds bind (atomic, idempotent, cross-delivery fail)
 * - docs.write rejects deliveryId
 * - output.provenance unbound / bound / incomplete
 * - retention pins Output.deliveryId references
 * - node.changed on bind; CLIENT_METHODS + ServiceClient surface
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { nodeNotePath } from "../src/core/tree.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import {
  CLIENT_METHODS,
  RPC_LIFECYCLE,
  isClientMethod,
  RESERVED_DOCS_WRITE_FIELDS,
} from "../src/service/types.js";
import type { OutputProvenance } from "../src/service/types.js";
import { writeTaskEnvelope, patchTaskEnvelope } from "../src/core/task.js";
import { createDelivery } from "../src/core/delivery.js";
import {
  previewOperationalRetention,
  purgeOperationalRetention,
} from "../src/core/retention.js";

const OLD = "2026-06-01T12:00:00.000Z";

function taskNodeContext(id: string, nodePath: string) {
  return {
    workNodeIds: [id],
    contextNodeIds: [],
    nodeSnapshots: [
      { id, path: nodePath, type: "prompt", tags: [], body: "", etag: "a".repeat(24) },
    ],
  };
}

async function makeWorkspace(name = "output-prov"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-out-prov-ws-"));
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
          { id: "rl-planner", name: "planner", prompt: "plan" },
          { id: "rl-executor", name: "executor", prompt: "do work" },
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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-out-prov-data-"));
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

async function mountWorkspace(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string
): Promise<string> {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  return (mounted.result as { workspaceId: string }).workspaceId;
}

async function createNote(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  opts: { name: string; type?: string; parentPath?: string }
): Promise<{ nodeId: string; path: string }> {
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: opts.name,
    type: opts.type ?? "prompt",
    ...(opts.parentPath ? { parentPath: opts.parentPath } : {}),
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return created.result as { nodeId: string; path: string };
}

async function readForEdit(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  id: string
): Promise<{ etag: string; raw: string; path: string }> {
  const res = await rpc(svc, "docs.readForEdit", { workspaceId, nodeId: id });
  assert.ok(!res.error, JSON.stringify(res.error));
  return res.result as { etag: string; raw: string; path: string };
}

/** Dispatch → claim → deliver ready Delivery for accept tests. */
async function readyDeliveryTask(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  workspace: string,
  nodeId: string,
  role = "executor"
): Promise<{ taskPath: string; deliveryId: string }> {
  const dispatched = await rpc(svc, "task.dispatch", {
    workspaceId,
    workNodeIds: [nodeId],
    contextNodeIds: [],
    roleId: `rl-${role}`,
    prompt: "do the work",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
  const taskPath = (dispatched.result as { taskPath: string }).taskPath;

  const entered = await rpc(svc, "session.enter", {
    workspaceId,
    roleId: `rl-${role}`,
    cwd: workspace,
  });
  assert.ok(!entered.error, JSON.stringify(entered.error));
  const session = entered.result as { session: { sessionId: string }; sessionToken: string };
  const client = createServiceClient({
    baseUrl: svc.url,
    token: svc.token,
    currentSessionId: session.session.sessionId,
    currentSessionToken: session.sessionToken,
  });
  await client.taskClaim(workspaceId, taskPath);

  const delivered = await client.taskDeliver(workspaceId, taskPath, {
    summary: "work product for provenance",
  });
  const deliveryId = (delivered as { delivery: { id: string } }).delivery.id;
  return { taskPath, deliveryId };
}

test("CLIENT_METHODS + ServiceClient include output.provenance; deliveryId reserved", () => {
  assert.ok(isClientMethod("output.provenance"));
  assert.ok(CLIENT_METHODS.includes("output.provenance"));
  assert.ok(RESERVED_DOCS_WRITE_FIELDS.includes("deliveryId"));
  const client = createServiceClient({ baseUrl: "http://127.0.0.1:9", token: "t" });
  assert.equal(typeof client.outputProvenance, "function");
  assert.equal(typeof client.taskAccept, "function");
});

test("accept binds output deliveryId atomically; unbound query; same-delivery idempotent", async () => {
  await withService(async (svc) => {
    const ws = await makeWorkspace();
    const workspaceId = await mountWorkspace(svc, ws);
    const source = await createNote(svc, workspaceId, { name: "job", type: "prompt" });
    const output = await createNote(svc, workspaceId, { name: "result", type: "output" });
    const { taskPath, deliveryId } = await readyDeliveryTask(svc, workspaceId, ws, source.nodeId);

    // Unbound before accept
    const unbound = await rpc(svc, "output.provenance", { workspaceId, nodeId: output.nodeId });
    assert.ok(!unbound.error, JSON.stringify(unbound.error));
    const u = unbound.result as OutputProvenance;
    assert.equal(u.bound, false);
    assert.equal(u.deliveryId, null);
    assert.equal(u.delivery, null);
    assert.equal(u.task, null);
    assert.equal(u.sourceNode, null);
    assert.deepEqual(u.incomplete, []);

    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsub = svc.events.subscribe((env) => {
      events.push({
        type: env.type,
        payload: (env.payload ?? {}) as Record<string, unknown>,
      });
    });

    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      deliveryId,
      actor: "user",
      outputNodeIds: [output.nodeId],
    });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    const acc = accepted.result as {
      state: string;
      boundOutputIds: string[];
      changedOutputIds: string[];
      delivery: { id: string; status: string };
    };
    assert.equal(acc.state, "accepted");
    assert.equal(acc.delivery.status, "accepted");
    assert.deepEqual(acc.boundOutputIds, [output.nodeId]);
    assert.deepEqual(acc.changedOutputIds, [output.nodeId]);

    // Disk FM has deliveryId only (no taskId/sourceNodeId denorm)
    const systemRoot = path.join(ws, ".tent");
    const fsa = new NodeFs(systemRoot);
    const noteRaw = await fsa.readFile(nodeNotePath(output.path));
    const { data } = parseFrontmatter(noteRaw);
    assert.equal(data.deliveryId, deliveryId);
    assert.equal(data.taskId, undefined);
    assert.equal(data.sourceNodeId, undefined);

    const bound = await rpc(svc, "output.provenance", { workspaceId, nodeId: output.nodeId });
    assert.ok(!bound.error, JSON.stringify(bound.error));
    const b = bound.result as OutputProvenance;
    assert.equal(b.bound, true);
    assert.equal(b.deliveryId, deliveryId);
    assert.equal(b.delivery?.id, deliveryId);
    assert.equal(b.delivery?.status, "accepted");
    assert.ok(b.task?.id);
    assert.equal(b.task?.state, "accepted");
    assert.equal(b.sourceNode?.nodeId, source.nodeId);
    assert.deepEqual(b.incomplete, []);

    unsub();
    const bindEvents = events.filter(
      (e) =>
        e.type === "node.changed" &&
        e.payload.nodeId === output.nodeId &&
        e.payload.reason === "output.provenance-bind"
    );
    assert.ok(
      bindEvents.length >= 1,
      `expected output.provenance-bind event, got ${JSON.stringify(events)}`
    );
  });
});

test("ServiceClient accept response loss resolves through terminal authority projections", async () => {
  await withService(async (svc) => {
    const ws = await makeWorkspace("accept-response-loss");
    const workspaceId = await mountWorkspace(svc, ws);
    const source = await createNote(svc, workspaceId, { name: "loss-job", type: "prompt" });
    const output = await createNote(svc, workspaceId, { name: "loss-output", type: "output" });
    const { taskPath, deliveryId } = await readyDeliveryTask(
      svc,
      workspaceId,
      ws,
      source.nodeId
    );
    const readyDelivery = await rpc(svc, "delivery.get", { workspaceId, id: deliveryId });
    assert.ok(!readyDelivery.error, JSON.stringify(readyDelivery.error));
    const deliveryPath = (
      readyDelivery.result as { delivery: { path: string } }
    ).delivery.path;
    const systemFs = new NodeFs(path.join(ws, ".tent"));
    const acceptIntentPath = `${taskPath.slice(0, -3)}.delivery-accept-intent.json`;
    const acceptParams = {
      workspaceId,
      taskPath,
      deliveryId,
      actor: "user",
      outputNodeIds: [output.nodeId],
    };

    let droppedAcceptResponse = false;
    const client = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      fetchImpl: async (input, init) => {
        const request = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        const response = await fetch(input, init);
        if (!droppedAcceptResponse && request.method === "task.accept") {
          droppedAcceptResponse = true;
          await response.text();
          throw new Error("simulated task.accept transport response loss");
        }
        return response;
      },
    });

    await assert.rejects(
      () => client.taskAccept(workspaceId, taskPath, deliveryId, "user", {
        outputNodeIds: [output.nodeId],
      }),
      /simulated task\.accept transport response loss/
    );
    assert.equal(droppedAcceptResponse, true);
    assert.equal(await systemFs.exists(acceptIntentPath), false);
    const authorityBeforeRetry = await Promise.all([
      systemFs.readFile(taskPath),
      systemFs.readFile(deliveryPath),
      systemFs.readFile(nodeNotePath(output.path)),
    ]);

    const retry = await client.rpcRaw("task.accept", acceptParams);
    assert.equal(retry.error?.code, RPC_LIFECYCLE);
    assert.deepEqual(retry.error?.data, { code: "INVALID_TRANSITION" });
    assert.equal(await systemFs.exists(acceptIntentPath), false);
    assert.deepEqual(
      await Promise.all([
        systemFs.readFile(taskPath),
        systemFs.readFile(deliveryPath),
        systemFs.readFile(nodeNotePath(output.path)),
      ]),
      authorityBeforeRetry
    );

    const taskProjection = await client.rpcRaw("task.get", { workspaceId, taskPath });
    assert.ok(!taskProjection.error, JSON.stringify(taskProjection.error));
    const task = (taskProjection.result as { task: { state: string; activeDeliveryId?: string } }).task;
    assert.equal(task.state, "accepted");
    assert.equal(task.activeDeliveryId, deliveryId);

    const deliveryProjection = await client.rpcRaw("delivery.get", {
      workspaceId,
      id: deliveryId,
    });
    assert.ok(!deliveryProjection.error, JSON.stringify(deliveryProjection.error));
    const delivery = (
      deliveryProjection.result as { delivery: { id: string; status: string } }
    ).delivery;
    assert.equal(delivery.id, deliveryId);
    assert.equal(delivery.status, "accepted");

    const outputProjection = await client.rpcRaw("output.provenance", {
      workspaceId,
      nodeId: output.nodeId,
    });
    assert.ok(!outputProjection.error, JSON.stringify(outputProjection.error));
    const provenance = outputProjection.result as OutputProvenance;
    assert.equal(provenance.bound, true);
    assert.equal(provenance.deliveryId, deliveryId);
    assert.equal(provenance.delivery?.status, "accepted");
    assert.equal(provenance.task?.state, "accepted");
  });
});

test("accept all-or-nothing: bad Output leaves Task/Delivery/Output unbound", async () => {
  await withService(async (svc) => {
    const ws = await makeWorkspace();
    const workspaceId = await mountWorkspace(svc, ws);
    const source = await createNote(svc, workspaceId, { name: "job2", type: "prompt" });
    const good = await createNote(svc, workspaceId, { name: "good-out", type: "output" });
    const notOutput = await createNote(svc, workspaceId, { name: "note-like", type: "prompt" });
    const { taskPath, deliveryId } = await readyDeliveryTask(svc, workspaceId, ws, source.nodeId);

    const failed = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      deliveryId,
      actor: "user",
      outputNodeIds: [good.nodeId, notOutput.nodeId],
    });
    assert.ok(failed.error, "expected accept to fail");
    assert.equal(failed.error?.code, -32010);

    // Task still delivered, delivery still ready
    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.ok(!got.error, JSON.stringify(got.error));
    assert.equal((got.result as { task: { state: string } }).task.state, "delivered");

    const del = await rpc(svc, "delivery.get", { workspaceId, id: deliveryId });
    assert.ok(!del.error, JSON.stringify(del.error));
    assert.equal((del.result as { delivery: { status: string } }).delivery.status, "ready");

    const systemRoot = path.join(ws, ".tent");
    const fsa = new NodeFs(systemRoot);
    const goodRaw = await fsa.readFile(nodeNotePath(good.path));
    assert.equal(parseFrontmatter(goodRaw).data.deliveryId, undefined);
  });
});

test("cross-delivery bind fails; archived/missing/non-output rejected", async () => {
  await withService(async (svc) => {
    const ws = await makeWorkspace();
    const workspaceId = await mountWorkspace(svc, ws);
    const source = await createNote(svc, workspaceId, { name: "job3", type: "prompt" });
    const output = await createNote(svc, workspaceId, { name: "out3", type: "output" });
    const archivedOut = await createNote(svc, workspaceId, { name: "arch-out", type: "output" });

    // Bind first delivery
    const first = await readyDeliveryTask(svc, workspaceId, ws, source.nodeId);
    const ok = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath: first.taskPath,
      deliveryId: first.deliveryId,
      actor: "user",
      outputNodeIds: [output.nodeId],
    });
    assert.ok(!ok.error, JSON.stringify(ok.error));

    // Second task/delivery tries to rebind same Output
    const second = await readyDeliveryTask(svc, workspaceId, ws, source.nodeId);
    const conflict = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath: second.taskPath,
      deliveryId: second.deliveryId,
      actor: "user",
      outputNodeIds: [output.nodeId],
    });
    assert.ok(conflict.error);
    assert.equal(conflict.error?.code, -32010);
    const still = await rpc(svc, "task.get", { workspaceId, taskPath: second.taskPath });
    assert.equal((still.result as { task: { state: string } }).task.state, "delivered");

    // Archive output then refuse bind
    const archEdit = await readForEdit(svc, workspaceId, archivedOut.nodeId);
    const setMode = await rpc(svc, "docs.setMode", {
      workspaceId,
      nodeId: archivedOut.nodeId,
      mode: "archived",
      baseEtag: archEdit.etag,
    });
    assert.ok(!setMode.error, JSON.stringify(setMode.error));
    const archFail = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath: second.taskPath,
      deliveryId: second.deliveryId,
      actor: "user",
      outputNodeIds: [archivedOut.nodeId],
    });
    assert.ok(archFail.error);
    assert.equal(archFail.error?.code, -32010);

    // Missing id
    const missing = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath: second.taskPath,
      deliveryId: second.deliveryId,
      actor: "user",
      outputNodeIds: ["cx-doesnotexist"],
    });
    assert.ok(missing.error);
    assert.equal(missing.error?.code, -32004);

    // Accept without outputs still works
    const plain = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath: second.taskPath,
      deliveryId: second.deliveryId,
      actor: "user",
    });
    assert.ok(!plain.error, JSON.stringify(plain.error));
  });
});

test("same-delivery multi-output idempotent re-bind on accept of shared ids", async () => {
  await withService(async (svc) => {
    const ws = await makeWorkspace();
    const workspaceId = await mountWorkspace(svc, ws);
    const source = await createNote(svc, workspaceId, { name: "job4", type: "prompt" });
    const a = await createNote(svc, workspaceId, { name: "out-a", type: "output" });
    const b = await createNote(svc, workspaceId, { name: "out-b", type: "output" });
    const { taskPath, deliveryId } = await readyDeliveryTask(svc, workspaceId, ws, source.nodeId);

    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      deliveryId,
      actor: "user",
      outputNodeIds: [a.nodeId, b.nodeId, a.nodeId], // dedupe
    });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    const acc = accepted.result as { boundOutputIds: string[]; changedOutputIds: string[] };
    assert.deepEqual(acc.boundOutputIds, [a.nodeId, b.nodeId]);
    assert.deepEqual(acc.changedOutputIds, [a.nodeId, b.nodeId]);

    for (const id of [a.nodeId, b.nodeId]) {
      const p = await rpc(svc, "output.provenance", { workspaceId, nodeId: id });
      assert.ok(!p.error, JSON.stringify(p.error));
      assert.equal((p.result as OutputProvenance).deliveryId, deliveryId);
      assert.equal((p.result as OutputProvenance).bound, true);
    }
  });
});

test("docs.write rejects deliveryId (structured + raw)", async () => {
  await withService(async (svc) => {
    const ws = await makeWorkspace();
    const workspaceId = await mountWorkspace(svc, ws);
    const output = await createNote(svc, workspaceId, { name: "out-write", type: "output" });
    const edit = await readForEdit(svc, workspaceId, output.nodeId);

    const structured = await rpc(svc, "docs.write", {
      workspaceId,
      nodeId: output.nodeId,
      baseEtag: edit.etag,
      frontmatter: { deliveryId: "dl-forged01" },
    });
    assert.ok(structured.error);
    assert.equal(structured.error?.code, -32010);
    assert.match(String(structured.error?.message), /deliveryId/);

    const edit2 = await readForEdit(svc, workspaceId, output.nodeId);
    const { data, body, keyOrder } = parseFrontmatter(edit2.raw);
    data.deliveryId = "dl-forged02";
    const raw = serializeFrontmatter(data, body, keyOrder);
    const rawWrite = await rpc(svc, "docs.write", {
      workspaceId,
      nodeId: output.nodeId,
      baseEtag: edit2.etag,
      raw,
    });
    assert.ok(rawWrite.error);
    assert.equal(rawWrite.error?.code, -32010);
  });
});

test("output.provenance incomplete when delivery missing; archived output still readable", async () => {
  await withService(async (svc) => {
    const ws = await makeWorkspace();
    const workspaceId = await mountWorkspace(svc, ws);
    const source = await createNote(svc, workspaceId, { name: "job5", type: "prompt" });
    const output = await createNote(svc, workspaceId, { name: "out5", type: "output" });
    const { taskPath, deliveryId } = await readyDeliveryTask(svc, workspaceId, ws, source.nodeId);
    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      deliveryId,
      actor: "user",
      outputNodeIds: [output.nodeId],
    });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));

    // Simulate purge of delivery file only (corrupt / heat gone)
    const systemRoot = path.join(ws, ".tent");
    const fsa = new NodeFs(systemRoot);
    // Find delivery path
    const delList = await rpc(svc, "delivery.list", { workspaceId });
    assert.ok(!delList.error);
    const row = (delList.result as { deliveries: Array<{ id: string; path: string }> }).deliveries.find(
      (d) => d.id === deliveryId
    );
    assert.ok(row);
    await fsa.remove(row!.path);

    const incomplete = await rpc(svc, "output.provenance", { workspaceId, nodeId: output.nodeId });
    assert.ok(!incomplete.error, JSON.stringify(incomplete.error));
    const inc = incomplete.result as OutputProvenance;
    assert.equal(inc.bound, true);
    assert.equal(inc.deliveryId, deliveryId);
    assert.equal(inc.delivery, null);
    assert.ok(inc.incomplete.includes("delivery_missing"));

    // Archive output — provenance still readable
    const edit = await readForEdit(svc, workspaceId, output.nodeId);
    const setMode = await rpc(svc, "docs.setMode", {
      workspaceId,
      nodeId: output.nodeId,
      mode: "archived",
      baseEtag: edit.etag,
    });
    assert.ok(!setMode.error, JSON.stringify(setMode.error));
    const still = await rpc(svc, "output.provenance", { workspaceId, nodeId: output.nodeId });
    assert.ok(!still.error, JSON.stringify(still.error));
    assert.equal((still.result as OutputProvenance).bound, true);
    assert.equal((still.result as OutputProvenance).deliveryId, deliveryId);
  });
});

test("retention pins Delivery+Task referenced by Output.deliveryId (including archived)", async () => {
  const ws = await makeWorkspace("ret-pin");
  const systemRoot = path.join(ws, ".tent");
  const fsa = new NodeFs(systemRoot);
  const clock = { now: () => OLD };

  // Create output note with deliveryId by hand (simulate post-accept bind)
  await fsa.writeFile(
    "pin-out/pin-out.md",
    serializeFrontmatter(
      { id: "cx-pinout1", type: "output", deliveryId: "dl-pinned01" },
      "# pinned output\n",
      ["id", "type", "deliveryId"]
    )
  );

  const taskPath = await writeTaskEnvelope(fsa, clock, {

    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    roleId: "rl-executor",
    ...taskNodeContext("cx-src", "inbox"),
    manifestPath: "temp/roles/rl-executor/manifests/m.md",
    userPrompt: "old accepted",
    id: "tk-pinned01",
  });
  await patchTaskEnvelope(fsa, taskPath, { state: "accepted", updatedAt: OLD });
  let raw = await fsa.readFile(taskPath);
  raw = raw
    .replace(/createdAt: .*/, `createdAt: ${OLD}`)
    .replace(/updatedAt: .*/, `updatedAt: ${OLD}`);
  await fsa.writeFile(taskPath, raw);

  const delivery = await createDelivery(fsa, clock, {
    taskId: "tk-pinned01",
    sourceNodeId: "cx-src",
    deliveriesDir: "temp/roles/rl-executor/deliveries",
    summary: "accepted product",
    status: "accepted",
    id: "dl-pinned01",
  });
  // Force old timestamps on delivery
  const dRaw = await fsa.readFile(delivery.path);
  await fsa.writeFile(
    delivery.path,
    dRaw.replace(/createdAt: .*/, `createdAt: ${OLD}`).replace(/updatedAt: .*/, `updatedAt: ${OLD}`)
  );

  const preview = await previewOperationalRetention(fsa, {
    keepTerminalTasksDays: 0,
    now: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(
    preview.candidates.some((c) => c.taskId === "tk-pinned01"),
    false,
    `pinned task should not be a candidate: ${JSON.stringify(preview)}`
  );
  assert.ok(
    preview.warnings.some((w) => /pinned by Output\.deliveryId/i.test(w)),
    `expected pin warning, got ${preview.warnings.join(" | ")}`
  );

  const purged = await purgeOperationalRetention(fsa, {
    keepTerminalTasksDays: 0,
    now: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(await fsa.exists(taskPath), true);
  assert.equal(await fsa.exists(delivery.path), true);
  assert.equal(purged.deletedCount, 0);

  // Unrelated old terminal still purges
  const otherPath = await writeTaskEnvelope(fsa, clock, {

    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    roleId: "rl-executor",
    ...taskNodeContext("cx-other", "inbox"),
    manifestPath: "temp/roles/rl-executor/manifests/m2.md",
    userPrompt: "unrelated",
    id: "tk-other01",
  });
  await patchTaskEnvelope(fsa, otherPath, { state: "failed", updatedAt: OLD });
  let oRaw = await fsa.readFile(otherPath);
  oRaw = oRaw
    .replace(/createdAt: .*/, `createdAt: ${OLD}`)
    .replace(/updatedAt: .*/, `updatedAt: ${OLD}`);
  await fsa.writeFile(otherPath, oRaw);

  const purged2 = await purgeOperationalRetention(fsa, {
    keepTerminalTasksDays: 0,
    now: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(await fsa.exists(otherPath), false);
  assert.equal(await fsa.exists(taskPath), true);
  assert.ok(purged2.deletedCount >= 1);
});

test("ServiceClient.taskAccept passes outputNodeIds", async () => {
  await withService(async (svc) => {
    const ws = await makeWorkspace();
    const workspaceId = await mountWorkspace(svc, ws);
    const source = await createNote(svc, workspaceId, { name: "job-cli", type: "prompt" });
    const output = await createNote(svc, workspaceId, { name: "out-cli", type: "output" });
    const { taskPath, deliveryId } = await readyDeliveryTask(svc, workspaceId, ws, source.nodeId);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const result = (await client.taskAccept(workspaceId, taskPath, deliveryId, "user", {
      outputNodeIds: [output.nodeId],
    })) as { state: string; boundOutputIds: string[] };
    assert.equal(result.state, "accepted");
    assert.deepEqual(result.boundOutputIds, [output.nodeId]);
    const prov = (await client.outputProvenance(workspaceId, output.nodeId)) as OutputProvenance;
    assert.equal(prov.bound, true);
  });
});
