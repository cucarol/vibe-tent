/**
 * Service type/tags P0 contract — registry + docs semantic mutations.
 * User-only MutationBus, baseEtag, dedicated public path (not free-form docs.write).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createServiceClient } from "../src/service/client.js";
import { rpcCall } from "../src/service/http-server.js";
import { startLocalTentService } from "../src/service/service.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";
import { loadTagRegistry } from "../src/core/tags.js";
import { loadTypeRegistry } from "../src/core/typeRegistry.js";
import { loadTent } from "../src/core/tree.js";

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-type-tags-data-"));
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
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-type-tags-ws-"));
  const workspaceFs = new NodeFs(workspace);
  await scaffoldInWorkspace(workspaceFs, {
    name: "demo",
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  // Core FsAdapter for Tent data is the system root (.tent), not workspace root.
  const systemFs = new NodeFs(path.join(workspace, ".tent"));
  const mount = await rpc(svc, "workspace.mount", { workspaceRoot: workspace });
  assert.ok(!("error" in mount && mount.error), JSON.stringify(mount));
  const workspaceId = (mount.result as { workspaceId: string }).workspaceId;
  return { workspaceId, workspace, systemFs };
}

test("isClientMethod includes type/tags registry and docs semantic commands", () => {
  for (const method of [
    "docs.setType",
    "docs.tags.set",
    "docs.tag.add",
    "docs.tag.remove",
    "registry.type.create",
    "registry.type.delete",
    "registry.tags",
    "registry.tag.create",
    "registry.tag.delete",
  ]) {
    assert.equal(isClientMethod(method), true, method);
    assert.ok(CLIENT_METHODS.includes(method as (typeof CLIENT_METHODS)[number]), method);
  }
  assert.equal(isClientMethod("registry.type.update"), false);
  assert.equal(isClientMethod("docs.setTags"), false);
});

test("registry type + docs.setType + in-use delete + tags cascade", async () => {
  await withService(async (svc) => {
    const { workspaceId, systemFs } = await mountScaffold(svc);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    const typeEvents: Array<Record<string, unknown>> = [];
    const tagEvents: Array<Record<string, unknown>> = [];
    const conceptEvents: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.workspaceId !== workspaceId) return;
      if (ev.type === "registry.types.updated") {
        typeEvents.push(ev.payload as Record<string, unknown>);
      }
      if (ev.type === "registry.tags.updated") {
        tagEvents.push(ev.payload as Record<string, unknown>);
      }
      if (ev.type === "concept.changed") {
        const payload = ev.payload as Record<string, unknown>;
        if (
          typeof payload.reason === "string" &&
          (payload.reason.startsWith("docs.setType") ||
            payload.reason.startsWith("docs.tags") ||
            payload.reason.startsWith("docs.tag"))
        ) {
          conceptEvents.push(payload);
        }
      }
    });

    // Non-user rejected
    const denied = await rpc(svc, "registry.type.create", {
      workspaceId,
      name: "snippet",
      actor: "agent",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);

    // Create custom secondary
    const created = (await client.registryTypeCreate(workspaceId, {
      name: "snippet",
    })) as { name: string; tier: string };
    assert.equal(created.name, "snippet");
    assert.equal(created.tier, "modifier");
    assert.equal(typeEvents.length, 1);
    assert.equal(typeEvents[0]!.action, "create");
    assert.equal(typeEvents[0]!.name, "snippet");

    // Builtin create fails
    const builtinCreate = await rpc(svc, "registry.type.create", {
      workspaceId,
      name: "asset",
      actor: "user",
    });
    assert.ok(builtinCreate.error);
    assert.equal(builtinCreate.error!.code, -32602);

    // Primary create fails
    const primaryCreate = await rpc(svc, "registry.type.create", {
      workspaceId,
      name: "goal",
      actor: "user",
    });
    assert.ok(primaryCreate.error);

    const types = (await client.registryTypes(workspaceId)) as {
      types: Array<{ name: string; tier: string }>;
    };
    assert.ok(types.types.some((t) => t.name === "snippet" && t.tier === "modifier"));

    const editRpc = await rpc(svc, "docs.readForEdit", {
      workspaceId,
      path: "inbox",
    });
    assert.ok(!editRpc.error, JSON.stringify(editRpc.error));
    const edit = editRpc.result as { id: string; etag: string };
    const cx = edit.id;
    let etag = edit.etag;

    // Missing baseEtag
    const missingEtag = await rpc(svc, "docs.setType", {
      workspaceId,
      id: cx,
      type: "prompt-snippet",
      actor: "user",
    });
    assert.ok(missingEtag.error);
    assert.equal(missingEtag.error!.code, -32008);
    assert.ok((missingEtag.error!.data as { currentEtag?: string })?.currentEtag);

    // Stale baseEtag
    const stale = await rpc(svc, "docs.setType", {
      workspaceId,
      id: cx,
      type: "prompt-snippet",
      baseEtag: "not-the-etag",
      actor: "user",
    });
    assert.ok(stale.error);
    assert.equal(stale.error!.code, -32009);

    // setType compound
    const setType = (await client.docsSetType(workspaceId, {
      id: cx,
      type: "prompt-snippet",
      baseEtag: etag,
    })) as { id: string; etag: string };
    assert.equal(setType.id, cx);
    assert.ok(setType.etag);
    etag = setType.etag;
    assert.equal(
      conceptEvents.filter((e) => e.reason === "docs.setType").length,
      1
    );

    const afterType = (await client.docsGet(workspaceId, { id: cx })) as {
      concept: { type: string };
    };
    assert.equal(afterType.concept.type, "prompt-snippet");

    // In-use delete fails
    const inUse = await rpc(svc, "registry.type.delete", {
      workspaceId,
      name: "snippet",
      confirmation: "snippet",
      actor: "user",
    });
    assert.ok(inUse.error);
    assert.equal(inUse.error!.code, -32602);
    assert.match(inUse.error!.message, /still in use/i);

    // Builtin delete fails
    const delAsset = await rpc(svc, "registry.type.delete", {
      workspaceId,
      name: "asset",
      confirmation: "asset",
      actor: "user",
    });
    assert.ok(delAsset.error);
    assert.equal(delAsset.error!.code, -32602);

    // Retype off custom secondary then delete OK
    const setBack = (await client.docsSetType(workspaceId, {
      id: cx,
      type: "prompt",
      baseEtag: etag,
    })) as { etag: string };
    etag = setBack.etag;
    const deleted = (await client.registryTypeDelete(workspaceId, {
      name: "snippet",
      confirmation: "snippet",
    })) as { deleted: string };
    assert.equal(deleted.deleted, "snippet");
    assert.equal(
      typeEvents.filter((e) => e.action === "delete" && e.name === "snippet").length,
      1
    );
    assert.equal((await loadTypeRegistry(systemFs)).snippet, undefined);

    // Tags: registry create + list
    await client.registryTagCreate(workspaceId, { name: "alpha" });
    assert.equal(tagEvents.filter((e) => e.action === "create").length, 1);
    const tagsList = (await client.registryTags(workspaceId)) as { tags: string[] };
    assert.ok(tagsList.tags.includes("alpha"));

    // docs.tag.add
    const add = (await client.docsTagAdd(workspaceId, {
      id: cx,
      tag: "beta",
      baseEtag: etag,
    })) as { etag: string };
    etag = add.etag;
    assert.equal(conceptEvents.filter((e) => e.reason === "docs.tag.add").length, 1);
    let tent = await loadTent(systemFs);
    assert.deepEqual(tent.byId.get(cx)?.tags, ["beta"]);
    assert.ok((await loadTagRegistry(systemFs)).tags.includes("beta"));

    // docs.tags.set replace
    const setTags = (await client.docsTagsSet(workspaceId, {
      id: cx,
      tags: ["beta", "gamma"],
      baseEtag: etag,
    })) as { etag: string };
    etag = setTags.etag;
    tent = await loadTent(systemFs);
    assert.deepEqual(tent.byId.get(cx)?.tags, ["beta", "gamma"]);

    // docs.tag.remove — detach only
    const remove = (await client.docsTagRemove(workspaceId, {
      id: cx,
      tag: "beta",
      baseEtag: etag,
    })) as { etag: string };
    etag = remove.etag;
    tent = await loadTent(systemFs);
    assert.deepEqual(tent.byId.get(cx)?.tags, ["gamma"]);
    assert.ok(
      (await loadTagRegistry(systemFs)).tags.includes("beta"),
      "detach must not prune registry"
    );

    // registry.tag.delete cascades (rewrites Node identity note → refresh etag)
    await client.registryTagDelete(workspaceId, { name: "gamma" });
    tent = await loadTent(systemFs);
    assert.deepEqual(tent.byId.get(cx)?.tags, []);
    assert.equal((await loadTagRegistry(systemFs)).tags.includes("gamma"), false);
    assert.ok(tagEvents.some((e) => e.action === "delete" && e.name === "gamma"));

    const afterCascade = await rpc(svc, "docs.readForEdit", { workspaceId, id: cx });
    assert.ok(!afterCascade.error, JSON.stringify(afterCascade.error));
    etag = (afterCascade.result as { etag: string }).etag;

    // docs.write structured cannot set type/tags
    const writeDenied = await rpc(svc, "docs.write", {
      workspaceId,
      id: cx,
      baseEtag: etag,
      frontmatter: { type: "prompt-asset", tags: ["sneaky"] },
    });
    assert.ok(writeDenied.error);
    assert.equal(writeDenied.error!.code, -32010);
    assert.match(writeDenied.error!.message, /semantic fields/);

    // docs.write raw cannot change type/tags either
    const editForRaw = await rpc(svc, "docs.readForEdit", { workspaceId, id: cx });
    assert.ok(!editForRaw.error, JSON.stringify(editForRaw.error));
    const rawSnapshot = editForRaw.result as { etag: string; raw: string };
    etag = rawSnapshot.etag;
    const rawTypeBypass = await rpc(svc, "docs.write", {
      workspaceId,
      id: cx,
      baseEtag: etag,
      raw: rawSnapshot.raw.replace(/type:\s*prompt\b/, "type: prompt-asset"),
    });
    assert.ok(rawTypeBypass.error);
    assert.equal(rawTypeBypass.error!.code, -32010);
    assert.match(rawTypeBypass.error!.message, /semantic fields/);

    const rawTagsBypass = await rpc(svc, "docs.write", {
      workspaceId,
      id: cx,
      baseEtag: etag,
      raw: rawSnapshot.raw.includes("tags:")
        ? rawSnapshot.raw.replace(/tags:\s*\[[^\]]*\]/, "tags: [sneaky]")
        : rawSnapshot.raw.replace(/^---\n/, "---\ntags: [sneaky]\n"),
    });
    assert.ok(rawTagsBypass.error);
    assert.equal(rawTagsBypass.error!.code, -32010);
    assert.match(rawTagsBypass.error!.message, /semantic fields/);

    // Body-only docs.write still works
    const bodyOk = await rpc(svc, "docs.write", {
      workspaceId,
      id: cx,
      baseEtag: etag,
      body: "# inbox updated\n",
    });
    assert.ok(!bodyOk.error, JSON.stringify(bodyOk.error));

    unsub();
  });
});

test("type/tags hardening: etag on all four commands, idempotent tags, archived gate, event counts", async () => {
  await withService(async (svc) => {
    const { workspaceId, systemFs } = await mountScaffold(svc);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    const conceptEvents: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.workspaceId !== workspaceId) return;
      if (ev.type === "concept.changed") {
        const payload = ev.payload as Record<string, unknown>;
        if (
          typeof payload.reason === "string" &&
          (payload.reason.startsWith("docs.setType") ||
            payload.reason.startsWith("docs.tags") ||
            payload.reason.startsWith("docs.tag"))
        ) {
          conceptEvents.push(payload);
        }
      }
    });

    const editRpc = await rpc(svc, "docs.readForEdit", {
      workspaceId,
      path: "inbox",
    });
    assert.ok(!editRpc.error, JSON.stringify(editRpc.error));
    const edit = editRpc.result as { id: string; etag: string };
    const cx = edit.id;
    let etag = edit.etag;

    const semanticCommands: Array<{
      method: string;
      params: Record<string, unknown>;
    }> = [
      { method: "docs.setType", params: { type: "prompt" } },
      { method: "docs.tags.set", params: { tags: [] } },
      { method: "docs.tag.add", params: { tag: "eta-check" } },
      { method: "docs.tag.remove", params: { tag: "eta-check" } },
    ];

    for (const { method, params } of semanticCommands) {
      const missing = await rpc(svc, method, {
        workspaceId,
        id: cx,
        actor: "user",
        ...params,
      });
      assert.ok(missing.error, `${method} missing baseEtag should fail`);
      assert.equal(missing.error!.code, -32008, method);
      assert.ok((missing.error!.data as { currentEtag?: string })?.currentEtag, method);

      const stale = await rpc(svc, method, {
        workspaceId,
        id: cx,
        actor: "user",
        baseEtag: "not-the-etag",
        ...params,
      });
      assert.ok(stale.error, `${method} stale baseEtag should fail`);
      assert.equal(stale.error!.code, -32009, method);
    }

    // Seed one tag for idempotent remove / exact event counts
    const add1 = (await client.docsTagAdd(workspaceId, {
      id: cx,
      tag: "keep",
      baseEtag: etag,
    })) as { etag: string };
    etag = add1.etag;
    const beforeIdempotent = conceptEvents.length;

    // Idempotent add: state unchanged, still one success event (accepted contract L2)
    const addAgain = (await client.docsTagAdd(workspaceId, {
      id: cx,
      tag: "keep",
      baseEtag: etag,
    })) as { etag: string };
    etag = addAgain.etag;
    let tent = await loadTent(systemFs);
    assert.deepEqual(tent.byId.get(cx)?.tags, ["keep"]);
    assert.equal(
      conceptEvents.filter((e) => e.reason === "docs.tag.add").length,
      beforeIdempotent + 1
    );

    // Idempotent remove of absent tag: Node tags unchanged; success event still fires
    const removeAbsent = (await client.docsTagRemove(workspaceId, {
      id: cx,
      tag: "never-attached",
      baseEtag: etag,
    })) as { etag: string };
    etag = removeAbsent.etag;
    tent = await loadTent(systemFs);
    assert.deepEqual(tent.byId.get(cx)?.tags, ["keep"]);
    assert.equal(conceptEvents.filter((e) => e.reason === "docs.tag.remove").length, 1);

    // Exact one concept.changed per successful tags.set / tag.remove (mutating path)
    const setTagsCountBefore = conceptEvents.filter((e) => e.reason === "docs.tags.set").length;
    const setTags = (await client.docsTagsSet(workspaceId, {
      id: cx,
      tags: ["keep", "extra"],
      baseEtag: etag,
    })) as { etag: string };
    etag = setTags.etag;
    assert.equal(
      conceptEvents.filter((e) => e.reason === "docs.tags.set").length,
      setTagsCountBefore + 1
    );

    const removeCountBefore = conceptEvents.filter((e) => e.reason === "docs.tag.remove").length;
    const removeExtra = (await client.docsTagRemove(workspaceId, {
      id: cx,
      tag: "extra",
      baseEtag: etag,
    })) as { etag: string };
    etag = removeExtra.etag;
    tent = await loadTent(systemFs);
    assert.deepEqual(tent.byId.get(cx)?.tags, ["keep"]);
    assert.equal(
      conceptEvents.filter((e) => e.reason === "docs.tag.remove").length,
      removeCountBefore + 1
    );

    // Archived mode rejects all four Node semantic commands
    const archived = await rpc(svc, "docs.setMode", {
      workspaceId,
      id: cx,
      mode: "archived",
      actor: "user",
    });
    assert.ok(!archived.error, JSON.stringify(archived.error));

    const afterArchEdit = await rpc(svc, "docs.readForEdit", { workspaceId, id: cx });
    // readForEdit may still return etag for archived notes; use disk etag if available
    const archEtag =
      !afterArchEdit.error && (afterArchEdit.result as { etag?: string })?.etag
        ? (afterArchEdit.result as { etag: string }).etag
        : etag;

    for (const { method, params } of [
      { method: "docs.setType", params: { type: "prompt" } },
      { method: "docs.tags.set", params: { tags: ["x"] } },
      { method: "docs.tag.add", params: { tag: "blocked" } },
      { method: "docs.tag.remove", params: { tag: "keep" } },
    ]) {
      const blocked = await rpc(svc, method, {
        workspaceId,
        id: cx,
        actor: "user",
        baseEtag: archEtag,
        ...params,
      });
      assert.ok(blocked.error, `${method} on archived should fail`);
      assert.equal(blocked.error!.code, -32010, method);
      assert.match(blocked.error!.message, /archived/i, method);
    }

    unsub();
  });
});
