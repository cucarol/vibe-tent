/**
 * Working-set Canvas backend projections:
 * - graph.projection (workspace node summary + parent/markdown/wiki edges)
 * - graph.projection uses canonical Node identity fields
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { nodeNotePath } from "../src/core/tree.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { contentEtag } from "../src/core/etag.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";

async function makeWorkspace(name = "canvas-proj"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-canvas-proj-ws-"));
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
): Promise<{ nodeId: string; path: string }> {
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: opts.name,
    type: opts.type ?? "prompt",
    ...(opts.parentPath ? { parentPath: opts.parentPath } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return created.result as { nodeId: string; path: string };
}

async function writeBody(ws: string, nodePath: string, body: string): Promise<void> {
  const fsa = new NodeFs(path.join(ws, ".tent"));
  const notePath = nodeNotePath(nodePath);
  const raw = await fsa.readFile(notePath);
  const { data, keyOrder } = parseFrontmatter(raw);
  await fsa.writeFile(notePath, serializeFrontmatter(data, body, keyOrder));
}

test("CLIENT_METHODS includes graph.projection and excludes retired Box projections", () => {
  assert.ok(isClientMethod("graph.projection"));
  assert.ok(CLIENT_METHODS.includes("graph.projection"));
  assert.equal((CLIENT_METHODS as readonly string[]).includes("box.projection"), false);
  assert.equal((CLIENT_METHODS as readonly string[]).includes("box.projections"), false);
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

    const graph = await client.graphProjection(workspaceId);
    assert.equal(graph.workspaceId, workspaceId);
    assert.ok(Array.isArray(graph.nodes));
    assert.ok(graph.nodes.length >= 2);

    const parentNode = graph.nodes.find((n) => n.nodeId === parent.nodeId);
    const childNode = graph.nodes.find((n) => n.nodeId === child.nodeId);
    assert.ok(parentNode, "parent node present");
    assert.ok(childNode, "child node present");
    assert.equal(parentNode!.path, parent.path);
    assert.equal(parentNode!.name, "parent-goal");
    const tentFs = new NodeFs(path.join(ws, ".tent"));
    const parentRaw = await tentFs.readFile(nodeNotePath(parent.path));
    assert.equal(parentNode!.etag, contentEtag(parentRaw));
    assert.equal(parentNode!.invalid, false);
    assert.equal(parentNode!.archived, false);
    assert.equal(childNode!.path, child.path);
    assert.equal("coordination" in parentNode!, false);

    // Stable summary only — never body / bodyPreview / status / assignee / coordination.
    for (const n of graph.nodes) {
      assert.equal("body" in n, false);
      assert.equal("bodyPreview" in n, false);
      assert.equal("coordination" in n, false);
      assert.ok(typeof n.nodeId === "string");
      assert.ok(typeof n.etag === "string");
      assert.ok(typeof n.path === "string");
      assert.ok(typeof n.name === "string");
      assert.ok(typeof n.type === "string");
      assert.ok(Array.isArray(n.tags));
      assert.ok(typeof n.mode === "string");
      assert.ok(typeof n.archived === "boolean");
      assert.ok(typeof n.invalid === "boolean");
    }

    const parentEdge = graph.edges.parent.find((e) => e.childNodeId === child.nodeId);
    assert.ok(parentEdge);
    assert.equal(parentEdge!.parentNodeId, parent.nodeId);

    const rootEdge = graph.edges.parent.find((e) => e.childNodeId === parent.nodeId);
    assert.ok(rootEdge);
    assert.equal(rootEdge!.parentNodeId, null);

    await writeBody(ws, parent.path, "# changed parent\n");
    const updatedGraph = await client.graphProjection(workspaceId);
    const updatedParent = updatedGraph.nodes.find((n) => n.nodeId === parent.nodeId);
    assert.ok(updatedParent);
    const updatedRaw = await tentFs.readFile(nodeNotePath(parent.path));
    assert.equal(updatedParent!.etag, contentEtag(updatedRaw));
    assert.notEqual(updatedParent!.etag, parentNode!.etag);
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

    const graph = await client.graphProjection(workspaceId);

    const wikiResolved = graph.edges.wiki.find(
      (e) => e.fromNodeId === source.nodeId && e.toNodeId === alpha.nodeId
    );
    assert.ok(wikiResolved, "resolved wiki edge present");
    assert.equal(wikiResolved!.unresolved, undefined);
    assert.equal(wikiResolved!.raw, "Alpha");

    const wikiUnresolved = graph.edges.wiki.find(
      (e) => e.fromNodeId === source.nodeId && e.raw.includes("DoesNotExist")
    );
    assert.ok(wikiUnresolved, "unresolved wiki edge retained");
    assert.equal(wikiUnresolved!.toNodeId, undefined);
    assert.ok(wikiUnresolved!.unresolved);
    assert.equal(wikiUnresolved!.unresolved!.raw, "DoesNotExist");

    const mdResolved = graph.edges.markdown.find(
      (e) => e.fromNodeId === source.nodeId && e.toNodeId === beta.nodeId
    );
    assert.ok(mdResolved, "resolved markdown edge present");
    assert.equal(mdResolved!.unresolved, undefined);

    const mdUnresolved = graph.edges.markdown.find(
      (e) => e.fromNodeId === source.nodeId && e.raw.includes("Ghost")
    );
    assert.ok(mdUnresolved, "unresolved markdown edge retained");
    assert.equal(mdUnresolved!.toNodeId, undefined);
    assert.ok(mdUnresolved!.unresolved);
    assert.equal(mdUnresolved!.unresolved!.raw.includes("Ghost"), true);

    // External artifacts must not appear as markdown/wiki concept edges.
    assert.equal(
      graph.edges.markdown.some((e) => e.fromNodeId === source.nodeId && e.raw.includes("example.test")),
      false
    );
    assert.equal(
      graph.edges.wiki.some((e) => e.fromNodeId === source.nodeId && e.raw.includes("example.test")),
      false
    );
  });
});
