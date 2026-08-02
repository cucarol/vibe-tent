/**
 * Service Relation CRUD P0 — MutationBus, baseEtag, node.changed, graph separation.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { nodeNotePath, loadTent } from "../src/core/tree.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createServiceClient } from "../src/service/client.js";
import { rpcCall } from "../src/service/http-server.js";
import { startLocalTentService } from "../src/service/service.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";
import type {
  GraphProjection,
  RelationListResult,
  RelationMutationResult,
} from "../src/service/types.js";

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-rel-data-"));
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

async function mountScaffold(
  svc: Awaited<ReturnType<typeof startLocalTentService>>
): Promise<{ workspaceId: string; workspace: string; systemFs: NodeFs }> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-rel-ws-"));
  const workspaceFs = new NodeFs(workspace);
  await scaffoldInWorkspace(workspaceFs, {
    name: "rel-svc",
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  const systemFs = new NodeFs(path.join(workspace, ".tent"));
  const mount = await rpc(svc, "workspace.mount", { workspaceRoot: workspace });
  assert.ok(!("error" in mount && mount.error), JSON.stringify(mount));
  const workspaceId = (mount.result as { workspaceId: string }).workspaceId;
  return { workspaceId, workspace, systemFs };
}

async function createNote(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  name: string
): Promise<{ nodeId: string; path: string }> {
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name,
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return created.result as { nodeId: string; path: string };
}

async function readEtag(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  nodeId: string
): Promise<string> {
  const snap = await rpc(svc, "docs.readForEdit", { workspaceId, nodeId });
  assert.ok(!snap.error, JSON.stringify(snap.error));
  return (snap.result as { etag: string }).etag;
}

test("isClientMethod includes relation.* commands", () => {
  for (const method of [
    "relation.list",
    "relation.create",
    "relation.update",
    "relation.delete",
  ]) {
    assert.equal(isClientMethod(method), true, method);
    assert.ok(CLIENT_METHODS.includes(method as (typeof CLIENT_METHODS)[number]), method);
  }
});

test("relation CRUD: outgoing/incoming, stable ids, update/delete, etag, events", async () => {
  await withService(async (svc) => {
    const { workspaceId, systemFs } = await mountScaffold(svc);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const alpha = await createNote(svc, workspaceId, "Alpha");
    const beta = await createNote(svc, workspaceId, "Beta");

    const conceptEvents: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.workspaceId !== workspaceId) return;
      if (ev.type === "node.changed") {
        const payload = ev.payload as Record<string, unknown>;
        if (typeof payload.reason === "string" && payload.reason.startsWith("relation.")) {
          conceptEvents.push(payload);
        }
      }
    });

    // Non-user rejected
    const denied = await rpc(svc, "relation.create", {
      workspaceId,
      nodeId: alpha.nodeId,
      kind: "related",
      direction: "directed",
      target: { nodeId: beta.nodeId },
      baseEtag: "x",
      actor: "agent",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);

    let etag = await readEtag(svc, workspaceId, alpha.nodeId);

    // Missing baseEtag
    const missingEtag = await rpc(svc, "relation.create", {
      workspaceId,
      nodeId: alpha.nodeId,
      kind: "related",
      direction: "directed",
      target: { nodeId: beta.nodeId },
      actor: "user",
    });
    assert.ok(missingEtag.error);
    assert.equal(missingEtag.error!.code, -32008);

    // Stale baseEtag
    const stale = await rpc(svc, "relation.create", {
      workspaceId,
      nodeId: alpha.nodeId,
      kind: "related",
      direction: "directed",
      target: { nodeId: beta.nodeId },
      baseEtag: "stale-etag-not-real",
      actor: "user",
    });
    assert.ok(stale.error);
    assert.equal(stale.error!.code, -32009);

    // Create resolved
    const created = (await client.relationCreate(workspaceId, {
      nodeId: alpha.nodeId,
      kind: "depends-on",
      direction: "directed",
      label: "needs",
      target: { nodeId: beta.nodeId },
      baseEtag: etag,
    })) as RelationMutationResult;
    assert.ok(created.relation.id.startsWith("rl-"));
    assert.equal(created.relation.kind, "depends-on");
    assert.deepEqual(created.relation.target, { nodeId: beta.nodeId });
    assert.ok(created.etag);
    etag = created.etag;
    assert.equal(
      conceptEvents.filter((e) => e.reason === "relation.create").length,
      1
    );

    // list outgoing on alpha / incoming on beta
    const onAlpha = (await client.relationList(workspaceId, {
      nodeId: alpha.nodeId,
    })) as RelationListResult;
    assert.equal(onAlpha.outgoing.length, 1);
    assert.equal(onAlpha.outgoing[0]!.id, created.relation.id);
    assert.equal(onAlpha.incoming.length, 0);

    const onBeta = (await client.relationList(workspaceId, {
      nodeId: beta.nodeId,
    })) as RelationListResult;
    assert.equal(onBeta.outgoing.length, 0);
    assert.equal(onBeta.incoming.length, 1);
    assert.equal(onBeta.incoming[0]!.sourceNodeId, alpha.nodeId);
    assert.equal(onBeta.incoming[0]!.id, created.relation.id);

    // Unresolved target create
    const open = (await client.relationCreate(workspaceId, {
      nodeId: alpha.nodeId,
      kind: "mentions",
      direction: "bidirectional",
      target: { unresolved: "FutureNode" },
      baseEtag: etag,
    })) as RelationMutationResult;
    assert.deepEqual(open.relation.target, { unresolved: "FutureNode" });
    etag = open.etag;

    // Missing resolved target fails
    const badTarget = await rpc(svc, "relation.create", {
      workspaceId,
      nodeId: alpha.nodeId,
      kind: "related",
      direction: "directed",
      target: { nodeId: "cx-doesnotexist" },
      baseEtag: etag,
      actor: "user",
    });
    assert.ok(badTarget.error);
    assert.equal(badTarget.error!.code, -32602);

    // Update kind/label/target; id stable
    const updated = (await client.relationUpdate(workspaceId, {
      nodeId: alpha.nodeId,
      relationId: created.relation.id,
      kind: "blocks",
      label: null,
      target: { unresolved: "MovedTarget" },
      baseEtag: etag,
    })) as RelationMutationResult;
    assert.equal(updated.relation.id, created.relation.id);
    assert.equal(updated.relation.kind, "blocks");
    assert.equal(updated.relation.label, undefined);
    assert.deepEqual(updated.relation.target, { unresolved: "MovedTarget" });
    etag = updated.etag;
    assert.equal(
      conceptEvents.filter((e) => e.reason === "relation.update").length,
      1
    );

    // Incoming no longer on beta
    const onBetaAfter = (await client.relationList(workspaceId, {
      nodeId: beta.nodeId,
    })) as RelationListResult;
    assert.equal(onBetaAfter.incoming.length, 0);

    // Delete missing fails loud
    const delMissing = await rpc(svc, "relation.delete", {
      workspaceId,
      nodeId: alpha.nodeId,
      relationId: "rl-missing999",
      baseEtag: etag,
      actor: "user",
    });
    assert.ok(delMissing.error);
    assert.equal(delMissing.error!.code, -32004);

    // Delete success
    const deleted = await client.relationDelete(workspaceId, {
      nodeId: alpha.nodeId,
      relationId: created.relation.id,
      baseEtag: etag,
    });
    assert.equal((deleted as { deleted: string }).deleted, created.relation.id);
    etag = (deleted as { etag: string }).etag;
    assert.equal(
      conceptEvents.filter((e) => e.reason === "relation.delete").length,
      1
    );

    const afterDelete = (await client.relationList(workspaceId, {
      nodeId: alpha.nodeId,
    })) as RelationListResult;
    assert.equal(
      afterDelete.outgoing.some((r) => r.id === created.relation.id),
      false
    );
    // unresolved one still present
    assert.equal(afterDelete.outgoing.length, 1);

    // docs.write cannot set relations
    const writeDenied = await rpc(svc, "docs.write", {
      workspaceId,
      nodeId: alpha.nodeId,
      baseEtag: etag,
      frontmatter: { relations: [] },
      actor: "user",
    });
    assert.ok(writeDenied.error);
    assert.equal(writeDenied.error!.code, -32010);
    assert.match(writeDenied.error!.message, /semantic fields|relations/i);

    // Disk still holds remaining relation via loadTent
    const tent = await loadTent(systemFs);
    assert.equal(tent.byId.get(alpha.nodeId)!.relations.length, 1);

    unsub();
  });
});

test("relation.create rejects archived/invalid source; graph keeps relation edges separate", async () => {
  await withService(async (svc) => {
    const { workspaceId, workspace } = await mountScaffold(svc);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const source = await createNote(svc, workspaceId, "Source");
    const target = await createNote(svc, workspaceId, "Target");

    let etag = await readEtag(svc, workspaceId, source.nodeId);
    const created = (await client.relationCreate(workspaceId, {
      nodeId: source.nodeId,
      kind: "related",
      direction: "directed",
      target: { nodeId: target.nodeId },
      baseEtag: etag,
    })) as RelationMutationResult;

    // Body wiki link must not appear in edges.relation
    const fsa = new NodeFs(path.join(workspace, ".tent"));
    const notePath = nodeNotePath(source.path);
    const raw = await fsa.readFile(notePath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    await fsa.writeFile(
      notePath,
      serializeFrontmatter(data, `${body}\nSee [[Target]] and [t](Target.md)\n`, keyOrder)
    );

    const graph = (await client.graphProjection(workspaceId)) as GraphProjection;
    assert.ok(Array.isArray(graph.edges.relation));
    const relEdge = graph.edges.relation.find((e) => e.id === created.relation.id);
    assert.ok(relEdge, "semantic relation edge present");
    assert.equal(relEdge!.fromNodeId, source.nodeId);
    assert.equal(relEdge!.toNodeId, target.nodeId);
    assert.equal(relEdge!.kind, "related");

    // markdown/wiki derived edges exist but are separate collections
    assert.ok(graph.edges.wiki.some((e) => e.fromNodeId === source.nodeId && e.toNodeId === target.nodeId));
    assert.ok(graph.edges.markdown.some((e) => e.fromNodeId === source.nodeId && e.toNodeId === target.nodeId));
    // relation collection does not include raw body link shapes
    assert.equal(
      graph.edges.relation.every((e) => typeof e.id === "string" && e.id.startsWith("rl-")),
      true
    );
    assert.equal(
      graph.edges.wiki.some((e) => "kind" in e && (e as { kind?: string }).kind === "related"),
      false
    );

    // Archive source → mutations rejected
    await rpc(svc, "docs.setMode", {
      workspaceId,
      nodeId: source.nodeId,
      mode: "archived",
      actor: "user",
    });
    etag = await readEtag(svc, workspaceId, source.nodeId);
    const archivedCreate = await rpc(svc, "relation.create", {
      workspaceId,
      nodeId: source.nodeId,
      kind: "related",
      direction: "directed",
      target: { unresolved: "x" },
      baseEtag: etag,
      actor: "user",
    });
    assert.ok(archivedCreate.error);
    assert.equal(archivedCreate.error!.code, -32010);
  });
});

test("corrupt/future-format relations: mutation fails loud; disk + no node.changed", async () => {
  await withService(async (svc) => {
    const { workspaceId, systemFs } = await mountScaffold(svc);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const alpha = await createNote(svc, workspaceId, "Alpha");
    const beta = await createNote(svc, workspaceId, "Beta");

    let etag = await readEtag(svc, workspaceId, alpha.nodeId);
    const created = (await client.relationCreate(workspaceId, {
      nodeId: alpha.nodeId,
      kind: "related",
      direction: "directed",
      target: { nodeId: beta.nodeId },
      baseEtag: etag,
    })) as RelationMutationResult;

    const notePath = nodeNotePath(alpha.path);
    const before = await systemFs.readFile(notePath);
    const { data, body, keyOrder } = parseFrontmatter(before);
    data.relations = [
      ...(Array.isArray(data.relations) ? (data.relations as unknown[]) : []),
      {
        id: "rl-future99",
        kind: "related",
        direction: "directed",
        nodeId: beta.nodeId,
        futureField: "do-not-erase",
      },
    ];
    const planted = serializeFrontmatter(data, body, keyOrder);
    await systemFs.writeFile(notePath, planted);
    etag = await readEtag(svc, workspaceId, alpha.nodeId);

    const conceptEvents: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.workspaceId !== workspaceId) return;
      if (ev.type === "node.changed") {
        const payload = ev.payload as Record<string, unknown>;
        if (typeof payload.reason === "string" && payload.reason.startsWith("relation.")) {
          conceptEvents.push(payload);
        }
      }
    });

    // Read projection is migration-tolerant (projects canonical core of future-format row).
    const listed = (await client.relationList(workspaceId, {
      nodeId: alpha.nodeId,
    })) as RelationListResult;
    assert.ok(listed.outgoing.some((r) => r.id === created.relation.id));
    assert.ok(listed.outgoing.some((r) => r.id === "rl-future99"));
    assert.equal(
      listed.outgoing.some(
        (r) => "futureField" in (r as unknown as Record<string, unknown>)
      ),
      false,
      "wire projection is canonical only"
    );

    for (const [method, params] of [
      [
        "relation.create",
        {
          workspaceId,
          nodeId: alpha.nodeId,
          kind: "other",
          direction: "directed",
          target: { unresolved: "x" },
          baseEtag: etag,
          actor: "user",
        },
      ],
      [
        "relation.update",
        {
          workspaceId,
          nodeId: alpha.nodeId,
          relationId: created.relation.id,
          kind: "blocks",
          baseEtag: etag,
          actor: "user",
        },
      ],
      [
        "relation.delete",
        {
          workspaceId,
          nodeId: alpha.nodeId,
          relationId: created.relation.id,
          baseEtag: etag,
          actor: "user",
        },
      ],
    ] as const) {
      const res = await rpc(svc, method, params as Record<string, unknown>);
      assert.ok(res.error, `${method} should fail`);
      assert.equal(res.error!.code, -32602, method);
      const data = res.error!.data as { code?: string } | undefined;
      assert.equal(data?.code, "relations_corrupt", method);
    }

    assert.equal(conceptEvents.length, 0);
    const after = await systemFs.readFile(notePath);
    assert.equal(after, planted, "disk bytes must be unchanged");
    unsub();
  });
});

test("relation validation compact: dual target, empty kind, direction, empty patch, wrong source, invalid nodes, raw write, unresolved graph", async () => {
  await withService(async (svc) => {
    const { workspaceId, systemFs, workspace } = await mountScaffold(svc);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const alpha = await createNote(svc, workspaceId, "Alpha");
    const beta = await createNote(svc, workspaceId, "Beta");
    const gamma = await createNote(svc, workspaceId, "Gamma");

    let etag = await readEtag(svc, workspaceId, alpha.nodeId);
    const created = (await client.relationCreate(workspaceId, {
      nodeId: alpha.nodeId,
      kind: "related",
      direction: "directed",
      target: { unresolved: "OpenTarget" },
      baseEtag: etag,
    })) as RelationMutationResult;
    etag = created.etag;

    // Dual target (nodeId + unresolved) rejected
    const dual = await rpc(svc, "relation.create", {
      workspaceId,
      nodeId: alpha.nodeId,
      kind: "related",
      direction: "directed",
      target: { nodeId: beta.nodeId, unresolved: "also" },
      baseEtag: etag,
      actor: "user",
    });
    assert.ok(dual.error);
    assert.equal(dual.error!.code, -32602);

    // Empty kind
    const emptyKind = await rpc(svc, "relation.create", {
      workspaceId,
      nodeId: alpha.nodeId,
      kind: "   ",
      direction: "directed",
      target: { unresolved: "x" },
      baseEtag: etag,
      actor: "user",
    });
    assert.ok(emptyKind.error);
    assert.equal(emptyKind.error!.code, -32602);

    // Invalid direction
    const badDir = await rpc(svc, "relation.create", {
      workspaceId,
      nodeId: alpha.nodeId,
      kind: "related",
      direction: "sideways",
      target: { unresolved: "x" },
      baseEtag: etag,
      actor: "user",
    });
    assert.ok(badDir.error);
    assert.equal(badDir.error!.code, -32602);

    // Empty update patch
    const emptyPatch = await rpc(svc, "relation.update", {
      workspaceId,
      nodeId: alpha.nodeId,
      relationId: created.relation.id,
      baseEtag: etag,
      actor: "user",
    });
    assert.ok(emptyPatch.error);
    assert.equal(emptyPatch.error!.code, -32602);
    assert.match(emptyPatch.error!.message, /at least one/i);

    // Wrong-source update/delete: relation lives on alpha, not beta
    const betaEtag = await readEtag(svc, workspaceId, beta.nodeId);
    const wrongUpdate = await rpc(svc, "relation.update", {
      workspaceId,
      nodeId: beta.nodeId,
      relationId: created.relation.id,
      kind: "hijack",
      baseEtag: betaEtag,
      actor: "user",
    });
    assert.ok(wrongUpdate.error);
    assert.equal(wrongUpdate.error!.code, -32004);

    const wrongDelete = await rpc(svc, "relation.delete", {
      workspaceId,
      nodeId: beta.nodeId,
      relationId: created.relation.id,
      baseEtag: betaEtag,
      actor: "user",
    });
    assert.ok(wrongDelete.error);
    assert.equal(wrongDelete.error!.code, -32004);

    // Invalid target (archived)
    await rpc(svc, "docs.setMode", {
      workspaceId,
      nodeId: gamma.nodeId,
      mode: "archived",
      actor: "user",
    });
    const archivedTarget = await rpc(svc, "relation.create", {
      workspaceId,
      nodeId: alpha.nodeId,
      kind: "related",
      direction: "directed",
      target: { nodeId: gamma.nodeId },
      baseEtag: etag,
      actor: "user",
    });
    assert.ok(archivedTarget.error);
    assert.equal(archivedTarget.error!.code, -32602);

    // Invalid source (unknown type → invalid node)
    const inv = await createNote(svc, workspaceId, "Broken");
    const invEtag = await readEtag(svc, workspaceId, inv.nodeId);
    const invNote = nodeNotePath(inv.path);
    const invRaw = await systemFs.readFile(invNote);
    const invParsed = parseFrontmatter(invRaw);
    invParsed.data.type = "not-a-real-type";
    await systemFs.writeFile(
      invNote,
      serializeFrontmatter(invParsed.data, invParsed.body, invParsed.keyOrder)
    );
    const invalidSource = await rpc(svc, "relation.create", {
      workspaceId,
      nodeId: inv.nodeId,
      kind: "related",
      direction: "directed",
      target: { unresolved: "x" },
      baseEtag: invEtag,
      actor: "user",
    });
    assert.ok(invalidSource.error);
    assert.equal(invalidSource.error!.code, -32004);

    // raw docs.write cannot bypass relations semantic guard
    const rawBypass = await rpc(svc, "docs.write", {
      workspaceId,
      nodeId: alpha.nodeId,
      baseEtag: etag,
      raw: serializeFrontmatter(
        {
          id: alpha.nodeId,
          type: "prompt",
          relations: [
            {
              id: "rl-sneaky01",
              kind: "related",
              direction: "directed",
              unresolved: "hack",
            },
          ],
        },
        "# Alpha\n",
        ["id", "type", "relations"]
      ),
      actor: "user",
    });
    assert.ok(rawBypass.error);
    assert.equal(rawBypass.error!.code, -32010);
    assert.match(rawBypass.error!.message, /relations|semantic/i);

    // Unresolved graph edge shape
    const graph = (await client.graphProjection(workspaceId)) as GraphProjection;
    const openEdge = graph.edges.relation.find((e) => e.id === created.relation.id);
    assert.ok(openEdge);
    assert.equal(openEdge!.toNodeId, undefined);
    assert.equal(openEdge!.unresolved, "OpenTarget");
    assert.equal(openEdge!.fromNodeId, alpha.nodeId);
    assert.equal(openEdge!.kind, "related");
    assert.equal(openEdge!.direction, "directed");

    // Ensure alpha still has only the original relation (no silent writes)
    const listed = (await client.relationList(workspaceId, {
      nodeId: alpha.nodeId,
    })) as RelationListResult;
    assert.equal(listed.outgoing.length, 1);
    assert.equal(listed.outgoing[0]!.id, created.relation.id);

    void workspace;
  });
});
