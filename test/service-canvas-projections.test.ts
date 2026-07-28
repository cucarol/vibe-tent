/**
 * Working-set Canvas backend projections:
 * - graph.projection (workspace node summary + parent/markdown/wiki edges)
 * - box.projections (batch collab projection; same item semantics as box.projection)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { boxNotePath } from "../src/core/tree.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";
import type {
  BoxProjection,
  BoxProjectionsResult,
  GraphProjection,
} from "../src/service/types.js";

async function makeWorkspace(name = "canvas-proj"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-canvas-proj-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    rules: "# RULES\n\nCanvas projection service\n",
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "planner", prompt: "plan" },
          { name: "executor", prompt: "do work" },
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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-canvas-proj-data-"));
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
  opts: { name: string; type?: string; parentPath?: string; body?: string }
): Promise<{ id: string; path: string }> {
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: opts.name,
    type: opts.type ?? "prompt",
    ...(opts.parentPath ? { parentPath: opts.parentPath } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return created.result as { id: string; path: string };
}

async function writeBody(ws: string, boxPath: string, body: string): Promise<void> {
  const fsa = new NodeFs(path.join(ws, ".tent"));
  const notePath = boxNotePath(boxPath);
  const raw = await fsa.readFile(notePath);
  const { data, keyOrder } = parseFrontmatter(raw);
  await fsa.writeFile(notePath, serializeFrontmatter(data, body, keyOrder));
}

async function writeStaleOwnerDoing(ws: string, boxPath: string, owner: string): Promise<void> {
  const fsa = new NodeFs(path.join(ws, ".tent"));
  const notePath = boxNotePath(boxPath);
  const raw = await fsa.readFile(notePath);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  data.owner = owner;
  data.status = "doing";
  await fsa.writeFile(notePath, serializeFrontmatter(data, body, keyOrder));
}

async function removeBoxId(ws: string, boxPath: string): Promise<void> {
  const fsa = new NodeFs(path.join(ws, ".tent"));
  const notePath = boxNotePath(boxPath);
  const raw = await fsa.readFile(notePath);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  delete data.id;
  await fsa.writeFile(notePath, serializeFrontmatter(data, body, keyOrder));
}

test("CLIENT_METHODS includes graph.projection and box.projections", () => {
  assert.ok(isClientMethod("graph.projection"));
  assert.ok(isClientMethod("box.projections"));
  assert.ok(CLIENT_METHODS.includes("graph.projection"));
  assert.ok(CLIENT_METHODS.includes("box.projections"));
});

test("graph.projection: nodes + parent edges; no body fields", async () => {
  const ws = await makeWorkspace("graph-tree");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const parent = await createNote(svc, workspaceId, { name: "parent-goal", type: "goal" });
    const child = await createNote(svc, workspaceId, {
      name: "child-note",
      type: "prompt",
      parentPath: parent.path,
    });

    const graph = (await client.graphProjection(workspaceId)) as GraphProjection;
    assert.equal(graph.workspaceId, workspaceId);
    assert.ok(Array.isArray(graph.nodes));
    assert.ok(graph.nodes.length >= 2);

    const parentNode = graph.nodes.find((n) => n.id === parent.id);
    const childNode = graph.nodes.find((n) => n.id === child.id);
    assert.ok(parentNode, "parent node present");
    assert.ok(childNode, "child node present");
    assert.equal(parentNode!.path, parent.path);
    assert.equal(parentNode!.name, "parent-goal");
    assert.equal(parentNode!.invalid, false);
    assert.equal(parentNode!.archived, false);
    assert.equal(childNode!.path, child.path);
    assert.equal("coordination" in parentNode!, false);

    // Stable summary only — never body / bodyPreview / status / assignee / coordination.
    for (const n of graph.nodes) {
      assert.equal("body" in n, false);
      assert.equal("bodyPreview" in n, false);
      assert.equal("coordination" in n, false);
      assert.ok(typeof n.id === "string");
      assert.ok(typeof n.path === "string");
      assert.ok(typeof n.name === "string");
      assert.ok(typeof n.type === "string");
      assert.ok(Array.isArray(n.tags));
      assert.ok(typeof n.mode === "string");
      assert.ok(typeof n.archived === "boolean");
      assert.ok(typeof n.invalid === "boolean");
    }

    const parentEdge = graph.edges.parent.find((e) => e.childId === child.id);
    assert.ok(parentEdge);
    assert.equal(parentEdge!.parentId, parent.id);

    const rootEdge = graph.edges.parent.find((e) => e.childId === parent.id);
    assert.ok(rootEdge);
    assert.equal(rootEdge!.parentId, null);
  });
});

test("graph.projection: resolved markdown + wiki edges; unresolved kept explicitly", async () => {
  const ws = await makeWorkspace("graph-links");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const alpha = await createNote(svc, workspaceId, { name: "Alpha", type: "prompt" });
    const beta = await createNote(svc, workspaceId, { name: "Beta", type: "prompt" });
    const source = await createNote(svc, workspaceId, { name: "Source", type: "prompt" });

    // Write body with resolved wiki, resolved md, unresolved wiki, unresolved md.
    // Relative md destination must resolve against source note path.
    await writeBody(
      ws,
      source.path,
      [
        `# Source`,
        ``,
        `Wiki ok: [[Alpha]]`,
        `Wiki missing: [[DoesNotExist]]`,
        `MD ok: [Beta](Beta.md)`,
        `MD missing: [Ghost](Ghost.md)`,
        `External (not a concept edge): [x](https://example.test)`,
      ].join("\n")
    );

    const graph = (await client.graphProjection(workspaceId)) as GraphProjection;

    const wikiResolved = graph.edges.wiki.find(
      (e) => e.fromId === source.id && e.toId === alpha.id
    );
    assert.ok(wikiResolved, "resolved wiki edge present");
    assert.equal(wikiResolved!.unresolved, undefined);
    assert.equal(wikiResolved!.raw, "Alpha");

    const wikiUnresolved = graph.edges.wiki.find(
      (e) => e.fromId === source.id && e.raw.includes("DoesNotExist")
    );
    assert.ok(wikiUnresolved, "unresolved wiki edge retained");
    assert.equal(wikiUnresolved!.toId, undefined);
    assert.ok(wikiUnresolved!.unresolved);
    assert.equal(wikiUnresolved!.unresolved!.raw, "DoesNotExist");

    const mdResolved = graph.edges.markdown.find(
      (e) => e.fromId === source.id && e.toId === beta.id
    );
    assert.ok(mdResolved, "resolved markdown edge present");
    assert.equal(mdResolved!.unresolved, undefined);

    const mdUnresolved = graph.edges.markdown.find(
      (e) => e.fromId === source.id && e.raw.includes("Ghost")
    );
    assert.ok(mdUnresolved, "unresolved markdown edge retained");
    assert.equal(mdUnresolved!.toId, undefined);
    assert.ok(mdUnresolved!.unresolved);
    assert.equal(mdUnresolved!.unresolved!.raw.includes("Ghost"), true);

    // External artifacts must not appear as markdown/wiki concept edges.
    assert.equal(
      graph.edges.markdown.some((e) => e.fromId === source.id && e.raw.includes("example.test")),
      false
    );
    assert.equal(
      graph.edges.wiki.some((e) => e.fromId === source.id && e.raw.includes("example.test")),
      false
    );
  });
});

test("box.projections: order stable; item semantics match box.projection", async () => {
  const ws = await makeWorkspace("batch-collab");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);

    const a = await createNote(svc, workspaceId, { name: "item-a", type: "prompt" });
    const b = await createNote(svc, workspaceId, { name: "item-b", type: "prompt" });
    const c = await createNote(svc, workspaceId, { name: "item-c", type: "prompt" });

    // Active task on a → doing
    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: a.id,
      role: "executor",
      prompt: "work a",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string };
    assert.ok(dispatched.taskPath);

    // Stale owner/doing on b without active task → todo
    await writeStaleOwnerDoing(ws, b.path, "ghost-role");

    // Accept path on c → no active task → todo (Node FM done is not product truth)
    const d2 = (await client.taskDispatch(workspaceId, {
      boxId: c.id,
      role: "executor",
      prompt: "finish c",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      deliveryPolicy: "review",
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, d2.taskPath);
    await client.taskDeliver(workspaceId, d2.taskPath, { summary: "c done" });
    await client.taskAccept(workspaceId, d2.taskPath, "user");

    // Request order intentionally not creation order.
    const ids = [c.id, a.id, b.id];
    const batch = (await client.boxProjections(workspaceId, ids)) as BoxProjectionsResult;
    assert.equal(batch.workspaceId, workspaceId);
    assert.equal(batch.projections.length, 3);
    assert.deepEqual(
      batch.projections.map((p) => p.boxId),
      ids
    );

    // Match single box.projection item-for-item.
    for (let i = 0; i < ids.length; i++) {
      const single = (await client.boxProjection(workspaceId, { id: ids[i] })) as BoxProjection;
      const item = batch.projections[i]!;
      assert.equal(item.workspaceId, single.workspaceId);
      assert.equal(item.boxId, single.boxId);
      assert.equal(item.status, single.status);
      assert.equal(item.assignee, single.assignee);
      assert.equal(item.activeTaskId, single.activeTaskId);
    }

    assert.equal(batch.projections[0]!.status, "done"); // c accepted → historical done
    assert.equal(batch.projections[1]!.status, "doing"); // a
    assert.ok(batch.projections[1]!.assignee === "executor");
    assert.ok(batch.projections[1]!.activeTaskId);
    assert.equal(batch.projections[2]!.status, "todo"); // b stale
    assert.equal(batch.projections[2]!.assignee, undefined);
    assert.equal(batch.projections[2]!.activeTaskId, undefined);
  });
});

test("box.projections: empty ids → empty projections", async () => {
  const ws = await makeWorkspace("batch-empty");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const batch = (await client.boxProjections(workspaceId, [])) as BoxProjectionsResult;
    assert.equal(batch.workspaceId, workspaceId);
    assert.deepEqual(batch.projections, []);
  });
});

test("box.projections: missing id fails cleanly; invalid concept fails", async () => {
  const ws = await makeWorkspace("batch-errors");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const ok = await createNote(svc, workspaceId, { name: "ok-item", type: "prompt" });

    const missing = await client.tryCall("box.projections", {
      workspaceId,
      ids: [ok.id, "cx-does-not-exist"],
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.error.code, -32004);
      assert.match(missing.error.message, /not found/i);
    }

    const noIds = await client.tryCall("box.projections", { workspaceId });
    assert.equal(noIds.ok, false);
    if (!noIds.ok) {
      assert.equal(noIds.error.code, -32602);
    }

    await removeBoxId(ws, ok.path);
    // After removing id, path still exists but concept may be invalid / not in byId.
    // Re-create a valid id then strip it and query by the id we had.
    const again = await createNote(svc, workspaceId, { name: "invalid-item", type: "prompt" });
    await removeBoxId(ws, again.path);
    // byId lookup uses id; after strip the id is gone from index → not found.
    // Prefer projecting a still-indexed invalid concept: create, then use path-based
    // single RPC invalid check is covered by box.projection; for batch we only take ids.
    // Force invalid while keeping id: write unknown type if available, else just assert
    // missing-id path above. Additional invalid-with-id: patch type to nonexistent.
    const fsa = new NodeFs(path.join(ws, ".tent"));
    const live = await createNote(svc, workspaceId, { name: "bad-type", type: "prompt" });
    const notePath = boxNotePath(live.path);
    const raw = await fsa.readFile(notePath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    data.type = "type-that-does-not-exist-xyz";
    await fsa.writeFile(notePath, serializeFrontmatter(data, body, keyOrder));

    const invalid = await client.tryCall("box.projections", {
      workspaceId,
      ids: [live.id],
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.error.code, -32004);
      assert.match(invalid.error.message, /invalid/i);
    }
  });
});
