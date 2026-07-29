/**
 * Service annotation.* RPCs — CLIENT_METHODS, user-only MutationBus, relocate projection.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";
import { ANNOTATIONS_PATH } from "../src/core/paths.js";

async function makeWorkspace(name = "ws-ann"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ann-svc-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    boxes: [{ name: "doc", type: "prompt", body: "hello world hello\n" }],
  });
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ann-data-"));
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

async function mount(svc: Awaited<ReturnType<typeof startLocalTentService>>, ws: string) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  return (mounted.result as { workspaceId: string }).workspaceId;
}

test("CLIENT_METHODS includes annotation.* surface", () => {
  for (const m of [
    "annotation.list",
    "annotation.create",
    "annotation.resolve",
    "annotation.reopen",
    "annotation.delete",
  ]) {
    assert.ok(isClientMethod(m), m);
    assert.ok(CLIENT_METHODS.includes(m as (typeof CLIENT_METHODS)[number]), m);
  }
});

test("annotation.create validates etag/range; list relocates; resolve/reopen/delete user-only", async () => {
  const ws = await makeWorkspace("full");
  await withService(async (svc) => {
    const workspaceId = await mount(svc, ws);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    const createdNote = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "annotated",
      type: "prompt",
    });
    assert.ok(!createdNote.error, JSON.stringify(createdNote.error));
    const nodeId = (createdNote.result as { id: string }).id;

    // Write known body via docs.write
    const read1 = await rpc(svc, "docs.readForEdit", { workspaceId, id: nodeId });
    assert.ok(!read1.error, JSON.stringify(read1.error));
    const snap1 = read1.result as { body: string; etag: string; raw: string };
    const bodyText = "alpha beta gamma beta\n";
    const write1 = await rpc(svc, "docs.write", {
      workspaceId,
      id: nodeId,
      body: bodyText,
      baseEtag: snap1.etag,
    });
    assert.ok(!write1.error, JSON.stringify(write1.error));

    const read2 = await rpc(svc, "docs.readForEdit", { workspaceId, id: nodeId });
    assert.ok(!read2.error);
    const snap2 = read2.result as { body: string; etag: string };
    assert.equal(snap2.body, bodyText);
    const quote = "beta";
    const start = snap2.body.indexOf(quote);
    const end = start + quote.length;

    const events: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "annotation.changed") {
        events.push(ev.payload as Record<string, unknown>);
      }
    });

    // Non-user denied
    const denied = await rpc(svc, "annotation.create", {
      workspaceId,
      nodeId,
      quote,
      start,
      end,
      body: "comment",
      documentEtag: snap2.etag,
      actor: "executor",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);
    assert.equal(events.length, 0);

    // Empty body
    const emptyBody = await rpc(svc, "annotation.create", {
      workspaceId,
      nodeId,
      quote,
      start,
      end,
      body: "  ",
      documentEtag: snap2.etag,
    });
    assert.ok(emptyBody.error);
    assert.equal(emptyBody.error!.code, -32602);

    // Bad etag
    const etagConflict = await rpc(svc, "annotation.create", {
      workspaceId,
      nodeId,
      quote,
      start,
      end,
      body: "stale",
      documentEtag: "not-the-etag",
    });
    assert.ok(etagConflict.error);
    assert.equal(etagConflict.error!.code, -32009);

    // Quote mismatch
    const mismatch = await rpc(svc, "annotation.create", {
      workspaceId,
      nodeId,
      quote: "BETA",
      start,
      end,
      body: "x",
      documentEtag: snap2.etag,
    });
    assert.ok(mismatch.error);
    assert.equal(mismatch.error!.code, -32602);

    // Happy path via ServiceClient
    const created = (await client.annotationCreate(workspaceId, {
      nodeId,
      quote,
      start,
      end,
      body: "underline note",
      documentEtag: snap2.etag,
    })) as {
      annotation: {
        id: string;
        status: string;
        anchorState: string;
        author: string;
        body: string;
      };
    };
    assert.equal(created.annotation.status, "open");
    assert.equal(created.annotation.author, "user");
    assert.equal(created.annotation.anchorState, "anchored");
    assert.equal(created.annotation.body, "underline note");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.action, "create");

    // Persist under workspace .tent
    const annPath = path.join(ws, ".tent", ANNOTATIONS_PATH);
    const disk = JSON.parse(await fs.readFile(annPath, "utf8")) as {
      annotations: Array<{ id: string; nodeId: string }>;
    };
    assert.equal(disk.annotations.length, 1);
    assert.equal(disk.annotations[0]!.nodeId, nodeId);

    // Shift body so original offsets miss but quote still unique-nearest → relocated
    const read3 = await rpc(svc, "docs.readForEdit", { workspaceId, id: nodeId });
    const snap3 = read3.result as { etag: string };
    const shifted = "zzz " + bodyText;
    const write2 = await rpc(svc, "docs.write", {
      workspaceId,
      id: nodeId,
      body: shifted,
      baseEtag: snap3.etag,
    });
    assert.ok(!write2.error, JSON.stringify(write2.error));

    const listed = (await client.annotationList(workspaceId, nodeId)) as {
      annotations: Array<{
        id: string;
        anchorState: string;
        start: number;
        currentStart?: number;
        quote: string;
      }>;
    };
    assert.equal(listed.annotations.length, 1);
    assert.equal(listed.annotations[0]!.anchorState, "relocated");
    assert.equal(listed.annotations[0]!.start, start); // persistent anchor
    assert.equal(listed.annotations[0]!.currentStart, shifted.indexOf(quote));

    // Remove quote → orphan
    const read4 = await rpc(svc, "docs.readForEdit", { workspaceId, id: nodeId });
    const snap4 = read4.result as { etag: string };
    const write3 = await rpc(svc, "docs.write", {
      workspaceId,
      id: nodeId,
      body: "no hits\n",
      baseEtag: snap4.etag,
    });
    assert.ok(!write3.error);
    const orphanList = (await client.annotationList(workspaceId, nodeId)) as {
      annotations: Array<{ anchorState: string; orphanReason?: string }>;
    };
    assert.equal(orphanList.annotations[0]!.anchorState, "orphan");
    assert.equal(orphanList.annotations[0]!.orphanReason, "quote-mismatch");

    // resolve / reopen
    const annId = created.annotation.id;
    const resolved = (await client.annotationResolve(workspaceId, annId)) as {
      annotation: { status: string };
    };
    assert.equal(resolved.annotation.status, "resolved");
    assert.ok(events.some((e) => e.action === "resolve"));

    const reopened = (await client.annotationReopen(workspaceId, annId)) as {
      annotation: { status: string };
    };
    assert.equal(reopened.annotation.status, "open");

    // Missing node identity still lists by nodeId as orphan/missing-node
    // (annotation still keyed by nodeId after concept gone — simulate by listing fake id)
    const missingNodeList = (await client.annotationList(workspaceId, "cx-missing")) as {
      annotations: unknown[];
    };
    assert.equal(missingNodeList.annotations.length, 0);

    // Manually point record at missing node via second create then rename is heavy;
    // create on node then list after we only check delete path.

    const delDenied = await rpc(svc, "annotation.delete", {
      workspaceId,
      id: annId,
      actor: "agent",
    });
    assert.ok(delDenied.error);
    assert.equal(delDenied.error!.code, -32001);

    const deleted = (await client.annotationDelete(workspaceId, annId)) as {
      deleted: boolean;
      id: string;
    };
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.id, annId);
    assert.ok(events.some((e) => e.action === "delete"));

    const empty = (await client.annotationList(workspaceId, nodeId)) as {
      annotations: unknown[];
    };
    assert.equal(empty.annotations.length, 0);

    unsub();
  });
});

test("annotation.list projects missing-node when nodeId has records but concept is gone", async () => {
  const ws = await makeWorkspace("missing-node");
  await withService(async (svc) => {
    const workspaceId = await mount(svc, ws);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    const createdNote = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "temp-node",
      type: "prompt",
    });
    const nodeId = (createdNote.result as { id: string }).id;
    const read = await rpc(svc, "docs.readForEdit", { workspaceId, id: nodeId });
    const snap = read.result as { body: string; etag: string };
    // body from scaffold createNote may vary; write fixed
    const body = "pick me please\n";
    const w = await rpc(svc, "docs.write", {
      workspaceId,
      id: nodeId,
      body,
      baseEtag: snap.etag,
    });
    assert.ok(!w.error, JSON.stringify(w.error));
    const read2 = await rpc(svc, "docs.readForEdit", { workspaceId, id: nodeId });
    const snap2 = read2.result as { body: string; etag: string };
    const quote = "pick me";
    const start = snap2.body.indexOf(quote);
    await client.annotationCreate(workspaceId, {
      nodeId,
      quote,
      start,
      end: start + quote.length,
      body: "keep me",
      documentEtag: snap2.etag,
    });

    // Physically remove the concept folder so byId misses, annotations remain.
    const tentRoot = path.join(ws, ".tent");
    const entries = await fs.readdir(tentRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const note = path.join(tentRoot, ent.name, `${ent.name}.md`);
      try {
        const raw = await fs.readFile(note, "utf8");
        if (raw.includes(nodeId)) {
          await fs.rm(path.join(tentRoot, ent.name), { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }

    const listed = (await client.annotationList(workspaceId, nodeId)) as {
      annotations: Array<{ anchorState: string; orphanReason?: string; id: string }>;
    };
    assert.equal(listed.annotations.length, 1);
    assert.equal(listed.annotations[0]!.anchorState, "orphan");
    assert.equal(listed.annotations[0]!.orphanReason, "missing-node");
  });
});
