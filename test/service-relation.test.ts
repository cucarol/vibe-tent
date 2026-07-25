/**
 * Service Relation CRUD P0 — MutationBus, baseEtag, concept.changed, graph separation.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { boxNotePath, loadTent } from "../src/core/tree.js";
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
    rules: "# RULES\n\nrelation service\n",
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
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
): Promise<{ id: string; path: string }> {
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name,
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return created.result as { id: string; path: string };
}

async function readEtag(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  id: string
): Promise<string> {
  const snap = await rpc(svc, "docs.readForEdit", { workspaceId, id });
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
      if (ev.type === "concept.changed") {
        const payload = ev.payload as Record<string, unknown>;
        if (typeof payload.reason === "string" && payload.reason.startsWith("relation.")) {
          conceptEvents.push(payload);
        }
      }
    });

    // Non-user rejected
    const denied = await rpc(svc, "relation.create", {
      workspaceId,
      id: alpha.id,
      kind: "related",
      direction: "directed",
      target: { nodeId: beta.id },
      baseEtag: "x",
      actor: "agent",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);

    let etag = await readEtag(svc, workspaceId, alpha.id);

    // Missing baseEtag
    const missingEtag = await rpc(svc, "relation.create", {
      workspaceId,
      id: alpha.id,
      kind: "related",
      direction: "directed",
      target: { nodeId: beta.id },
      actor: "user",
    });
    assert.ok(missingEtag.error);
    assert.equal(missingEtag.error!.code, -32008);

    // Stale baseEtag
    const stale = await rpc(svc, "relation.create", {
      workspaceId,
      id: alpha.id,
      kind: "related",
      direction: "directed",
      target: { nodeId: beta.id },
      baseEtag: "stale-etag-not-real",
      actor: "user",
    });
    assert.ok(stale.error);
    assert.equal(stale.error!.code, -32009);

    // Create resolved
    const created = (await client.relationCreate(workspaceId, {
      id: alpha.id,
      kind: "depends-on",
      direction: "directed",
      label: "needs",
      target: { nodeId: beta.id },
      baseEtag: etag,
    })) as RelationMutationResult;
    assert.ok(created.relation.id.startsWith("rl-"));
    assert.equal(created.relation.kind, "depends-on");
    assert.deepEqual(created.relation.target, { nodeId: beta.id });
    assert.ok(created.etag);
    etag = created.etag;
    assert.equal(
      conceptEvents.filter((e) => e.reason === "relation.create").length,
      1
    );

    // list outgoing on alpha / incoming on beta
    const onAlpha = (await client.relationList(workspaceId, {
      id: alpha.id,
    })) as RelationListResult;
    assert.equal(onAlpha.outgoing.length, 1);
    assert.equal(onAlpha.outgoing[0]!.id, created.relation.id);
    assert.equal(onAlpha.incoming.length, 0);

    const onBeta = (await client.relationList(workspaceId, {
      id: beta.id,
    })) as RelationListResult;
    assert.equal(onBeta.outgoing.length, 0);
    assert.equal(onBeta.incoming.length, 1);
    assert.equal(onBeta.incoming[0]!.sourceId, alpha.id);
    assert.equal(onBeta.incoming[0]!.id, created.relation.id);

    // Unresolved target create
    const open = (await client.relationCreate(workspaceId, {
      id: alpha.id,
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
      id: alpha.id,
      kind: "related",
      direction: "directed",
      target: { nodeId: "cx-does-not-exist" },
      baseEtag: etag,
      actor: "user",
    });
    assert.ok(badTarget.error);
    assert.equal(badTarget.error!.code, -32602);

    // Update kind/label/target; id stable
    const updated = (await client.relationUpdate(workspaceId, {
      id: alpha.id,
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
      id: beta.id,
    })) as RelationListResult;
    assert.equal(onBetaAfter.incoming.length, 0);

    // Delete missing fails loud
    const delMissing = await rpc(svc, "relation.delete", {
      workspaceId,
      id: alpha.id,
      relationId: "rl-missing999",
      baseEtag: etag,
      actor: "user",
    });
    assert.ok(delMissing.error);
    assert.equal(delMissing.error!.code, -32004);

    // Delete success
    const deleted = await client.relationDelete(workspaceId, {
      id: alpha.id,
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
      id: alpha.id,
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
      id: alpha.id,
      baseEtag: etag,
      frontmatter: { relations: [] },
      actor: "user",
    });
    assert.ok(writeDenied.error);
    assert.equal(writeDenied.error!.code, -32010);
    assert.match(writeDenied.error!.message, /semantic fields|relations/i);

    // Disk still holds remaining relation via loadTent
    const tent = await loadTent(systemFs);
    assert.equal(tent.byId.get(alpha.id)!.relations.length, 1);

    unsub();
  });
});

test("relation.create rejects archived/invalid source; graph keeps relation edges separate", async () => {
  await withService(async (svc) => {
    const { workspaceId, workspace } = await mountScaffold(svc);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const source = await createNote(svc, workspaceId, "Source");
    const target = await createNote(svc, workspaceId, "Target");

    let etag = await readEtag(svc, workspaceId, source.id);
    const created = (await client.relationCreate(workspaceId, {
      id: source.id,
      kind: "related",
      direction: "directed",
      target: { nodeId: target.id },
      baseEtag: etag,
    })) as RelationMutationResult;

    // Body wiki link must not appear in edges.relation
    const fsa = new NodeFs(path.join(workspace, ".tent"));
    const notePath = boxNotePath(source.path);
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
    assert.equal(relEdge!.fromId, source.id);
    assert.equal(relEdge!.toId, target.id);
    assert.equal(relEdge!.kind, "related");

    // markdown/wiki derived edges exist but are separate collections
    assert.ok(graph.edges.wiki.some((e) => e.fromId === source.id && e.toId === target.id));
    assert.ok(graph.edges.markdown.some((e) => e.fromId === source.id && e.toId === target.id));
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
      id: source.id,
      mode: "archived",
      actor: "user",
    });
    etag = await readEtag(svc, workspaceId, source.id);
    const archivedCreate = await rpc(svc, "relation.create", {
      workspaceId,
      id: source.id,
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
