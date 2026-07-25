import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import type { FsAdapter } from "../src/core/adapter.js";
import { createBox, moveNode } from "../src/core/ops.js";
import { loadTent } from "../src/core/tree.js";
import { loadOrder, saveOrder, ROOT_KEY } from "../src/core/order.js";
import { scaffoldInWorkspace, scaffoldTent } from "../src/core/scaffold.js";
import { buildConceptIndex } from "../src/core/okf.js";
import { rewriteConceptLinks } from "../src/core/renameOps.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { isClientMethod } from "../src/service/types.js";

function envFor(fsa: FsAdapter, name = "x") {
  let n = 0;
  return {
    fs: fsa,
    clock: { now: () => "2026-07-18T00:00:00.000Z" },
    tentName: name,
    rand: () => {
      n += 1;
      return (n * 0.17) % 1;
    },
  };
}

/** Wrap FsAdapter and fail on the Nth writeFile call (1-based). */
function injectWriteFailure(
  inner: FsAdapter,
  failOnWriteNumber: number
): { fs: FsAdapter; writeCount: () => number } {
  let writes = 0;
  const fsAdapter: FsAdapter = {
    listDir: (dir) => inner.listDir(dir),
    readFile: (p) => inner.readFile(p),
    writeFile: async (p, content) => {
      writes += 1;
      if (writes === failOnWriteNumber) {
        throw new Error(`injected write failure #${failOnWriteNumber} on ${p}`);
      }
      return inner.writeFile(p, content);
    },
    readBinary: (p) => inner.readBinary(p),
    writeBinary: (p, data) => inner.writeBinary(p, data),
    exists: (p) => inner.exists(p),
    mkdir: (p) => inner.mkdir(p),
    move: (from, to) => inner.move(from, to),
    remove: (p) => inner.remove(p),
    withLock: inner.withLock?.bind(inner),
  };
  return { fs: fsAdapter, writeCount: () => writes };
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-move-data-"));
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

test("isClientMethod includes docs.move and not docs.reparent", () => {
  assert.equal(isClientMethod("docs.move"), true);
  assert.equal(isClientMethod("docs.reparent"), false);
});

test("moveNode: reparent keeps cx-, moves subtree, rewrites path links", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-move-reparent-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x", rules: "# r\n" });
  const env = envFor(fsa);
  const parentId = await createBox(env as any, { parentPath: "", name: "parent", type: "prompt" });
  const childId = await createBox(env as any, { parentPath: "parent", name: "child", type: "prompt" });
  const destId = await createBox(env as any, { parentPath: "", name: "dest", type: "prompt" });
  const hubId = await createBox(env as any, { parentPath: "", name: "hub", type: "prompt" });
  await fsa.writeFile(
    "hub/hub.md",
    `---\nid: ${hubId}\ntype: prompt\n---\n\nSee [Child](../parent/child/child.md) and [[parent/child]].\n`
  );

  const result = await moveNode(env as any, childId, destId, { mode: "inside" });
  assert.equal(result.id, childId);
  assert.equal(result.oldPath, "parent/child");
  assert.equal(result.path, "dest/child");
  assert.equal(result.pathMap["parent/child"], "dest/child");
  assert.ok(result.rewrittenNotes.length >= 1);

  const tent = await loadTent(fsa);
  assert.equal(tent.byId.get(childId)?.path, "dest/child");
  assert.equal(tent.byId.get(childId)?.name, "child");
  assert.equal(tent.byId.get(parentId)?.children.some((c) => c.id === childId), false);
  assert.ok(tent.byId.get(destId)?.children.some((c) => c.id === childId));
  assert.equal(await fsa.exists("dest/child/child.md"), true);
  assert.equal(await fsa.exists("parent/child"), false);

  const hub = await fsa.readFile("hub/hub.md");
  assert.match(hub, /dest\/child/);
  assert.doesNotMatch(hub, /parent\/child\/child\.md/);
});

test("moveNode: depth-changing reparent restyles ./ and ../ inside moved subtree", async () => {
  // Reviewer probe (dl-f9qmacqr): parent/child → dest/nest/child must not corrupt relatives.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-move-depth-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x", rules: "# r\n" });
  const env = envFor(fsa);
  await createBox(env as any, { parentPath: "", name: "parent", type: "prompt" });
  const childId = await createBox(env as any, {
    parentPath: "parent",
    name: "child",
    type: "prompt",
  });
  const grandId = await createBox(env as any, {
    parentPath: "parent/child",
    name: "grand",
    type: "prompt",
  });
  const peerId = await createBox(env as any, { parentPath: "", name: "peer", type: "prompt" });
  const destId = await createBox(env as any, { parentPath: "", name: "dest", type: "prompt" });
  const nestId = await createBox(env as any, {
    parentPath: "dest",
    name: "nest",
    type: "prompt",
  });
  void grandId;
  void peerId;
  void nestId;

  await fsa.writeFile(
    "parent/child/child.md",
    [
      "---",
      `id: ${childId}`,
      "type: prompt",
      "---",
      "",
      "[G](./grand/grand.md)",
      "[P](../../peer/peer.md)",
      "[Abs](parent/child/grand/grand.md)",
      "[[parent/child/grand]]",
      "",
    ].join("\n")
  );

  const result = await moveNode(env as any, childId, nestId, { mode: "inside" });
  assert.equal(result.path, "dest/nest/child");
  assert.equal(await fsa.exists("dest/nest/child/child.md"), true);

  const body = await fsa.readFile("dest/nest/child/child.md");
  // Relative to moved descendant: still a single-step child link (not pre-move-restyled junk).
  assert.match(body, /\[G\]\(\.\/grand\/grand\.md\)/);
  assert.doesNotMatch(body, /\[G\]\(\.\.\/\.\.\/dest\/nest\/child\/grand/);
  // Relative outbound to unmoved peer: restyled for new depth.
  assert.match(body, /\[P\]\(\.\.\/\.\.\/\.\.\/peer\/peer\.md\)/);
  assert.doesNotMatch(body, /\[P\]\(\.\.\/\.\.\/peer\/peer\.md\)/);
  // Absolute + wiki still remap via pathMap.
  assert.match(body, /\[Abs\]\(dest\/nest\/child\/grand\/grand\.md\)/);
  assert.match(body, /\[\[dest\/nest\/child\/grand\]\]/);
  assert.doesNotMatch(body, /parent\/child\/grand/);
});

test("moveNode: reparent to root restyles outbound relative to unmoved peer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-move-root-rel-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x", rules: "# r\n" });
  const env = envFor(fsa);
  await createBox(env as any, { parentPath: "", name: "parent", type: "prompt" });
  const childId = await createBox(env as any, {
    parentPath: "parent",
    name: "child",
    type: "prompt",
  });
  await createBox(env as any, { parentPath: "parent/child", name: "grand", type: "prompt" });
  await createBox(env as any, { parentPath: "", name: "peer", type: "prompt" });

  await fsa.writeFile(
    "parent/child/child.md",
    [
      "---",
      `id: ${childId}`,
      "type: prompt",
      "---",
      "",
      "Peer [P](../../peer/peer.md).",
      "Abs [G](parent/child/grand/grand.md).",
      "Wiki [[parent/child/grand]].",
      "",
    ].join("\n")
  );

  await moveNode(env as any, childId, null, { mode: "inside" });
  assert.equal(await fsa.exists("child/child.md"), true);
  const body = await fsa.readFile("child/child.md");
  assert.match(body, /\[P\]\(\.\.\/peer\/peer\.md\)/);
  assert.doesNotMatch(body, /\.\.\/\.\.\/peer/);
  assert.match(body, /\[G\]\(child\/grand\/grand\.md\)/);
  assert.match(body, /\[\[child\/grand\]\]/);
});

test("rewriteConceptLinks: restyleFromNotePath fixes relatives when source moves", () => {
  const pathMap = new Map([
    ["parent/child", "dest/nest/child"],
    ["parent/child/child", "dest/nest/child/child"],
    ["parent/child/grand", "dest/nest/child/grand"],
    ["parent/child/grand/grand", "dest/nest/child/grand/grand"],
  ]);
  const body = [
    "[G](./grand/grand.md)",
    "[P](../../peer/peer.md)",
    "[Abs](parent/child/grand/grand.md)",
    "[[parent/child/grand]]",
  ].join("\n");
  const out = rewriteConceptLinks(
    body,
    "parent/child/child.md",
    pathMap,
    "child",
    "child",
    {
      renameBoxId: "cx-child",
      conceptIndex: buildConceptIndex([] as any),
      restyleFromNotePath: "dest/nest/child/child.md",
    }
  );
  assert.equal(out.changed, true);
  assert.match(out.body, /\[G\]\(\.\/grand\/grand\.md\)/);
  assert.match(out.body, /\[P\]\(\.\.\/\.\.\/\.\.\/peer\/peer\.md\)/);
  assert.match(out.body, /\[Abs\]\(dest\/nest\/child\/grand\/grand\.md\)/);
  assert.match(out.body, /\[\[dest\/nest\/child\/grand\]\]/);
  // Must not restyle relatives as if still under parent/child.
  assert.doesNotMatch(out.body, /\[G\]\(\.\.\/\.\.\/dest/);
  assert.doesNotMatch(out.body, /\[P\]\(\.\.\/\.\.\/peer\/peer\.md\)/);
});

test("moveNode: same-parent reorder is order-only (no link rewrite)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-move-reorder-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x", rules: "# r\n" });
  const env = envFor(fsa);
  const a = await createBox(env as any, { parentPath: "", name: "alpha", type: "prompt" });
  const b = await createBox(env as any, { parentPath: "", name: "beta", type: "prompt" });
  const c = await createBox(env as any, { parentPath: "", name: "gamma", type: "prompt" });
  await fsa.writeFile(
    "beta/beta.md",
    `---\nid: ${b}\ntype: prompt\n---\n\nSee [Alpha](../alpha/alpha.md).\n`
  );
  const orderBefore = await loadOrder(fsa);
  orderBefore[ROOT_KEY] = [a, b, c];
  await saveOrder(fsa, orderBefore);
  const betaBefore = await fsa.readFile("beta/beta.md");

  const result = await moveNode(env as any, c, null, { mode: "before", siblingId: a });
  assert.equal(result.id, c);
  assert.equal(result.path, "gamma");
  assert.equal(result.oldPath, "gamma");
  assert.deepEqual(result.rewrittenNotes, []);
  assert.equal(result.pathMap["gamma"], "gamma");

  const orderAfter = await loadOrder(fsa);
  assert.deepEqual(orderAfter[ROOT_KEY], [c, a, b]);
  assert.equal(await fsa.readFile("beta/beta.md"), betaBefore);
  assert.equal(await fsa.exists("gamma/gamma.md"), true);
});

test("moveNode: occupation placeBox freeze (self blocked, ancestor-of-occupied allowed)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-move-occ-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x", rules: "# r\n" });
  const env = envFor(fsa);
  const root = await createBox(env as any, { parentPath: "", name: "zone", type: "prompt" });
  const child = await createBox(env as any, { parentPath: "zone", name: "busy", type: "prompt" });
  const free = await createBox(env as any, { parentPath: "", name: "free", type: "prompt" });
  const park = await createBox(env as any, { parentPath: "", name: "park", type: "prompt" });

  await fsa.mkdir("temp/executor/tasks");
  await fsa.writeFile(
    "temp/executor/tasks/task-busy.md",
    [
      "---",
      "type: task",
      "id: tk-busy-mv",
      "role: executor",
      `claims: [${child}]`,
      "manifest: temp/executor/manifests/x.yml",
      "status: taken",
      "state: running",
      "---",
      "",
      "# Task",
      "",
    ].join("\n")
  );

  // Self occupation blocked.
  await assert.rejects(
    () => moveNode(env as any, child, free, { mode: "inside" }),
    /active task cannot be moved|Ranges with an active task cannot be moved/i
  );
  // Into occupied range blocked.
  await assert.rejects(
    () => moveNode(env as any, free, child, { mode: "inside" }),
    /Cannot move into a range occupied by an active task/i
  );
  // Ancestor of occupied child may still move (claim moves with subtree).
  const moved = await moveNode(env as any, root, park, { mode: "inside" });
  assert.equal(moved.path, "park/zone");
  const tent = await loadTent(fsa);
  assert.equal(tent.byId.get(child)?.path, "park/zone/busy");
});

test("moveNode: refuses cycle and archived", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-move-guard-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x", rules: "# r\n" });
  const env = envFor(fsa);
  const parent = await createBox(env as any, { parentPath: "", name: "p", type: "prompt" });
  const child = await createBox(env as any, { parentPath: "p", name: "c", type: "prompt" });

  await assert.rejects(
    () => moveNode(env as any, parent, child, { mode: "inside" }),
    /own subtree/i
  );

  // Archive via mode frontmatter path used by setNodeMode-like content.
  await fsa.writeFile(
    "p/c/c.md",
    `---\nid: ${child}\ntype: prompt\nmode: archived\n---\n\n# c\n`
  );
  await assert.rejects(
    () => moveNode(env as any, child, null, { mode: "inside" }),
    /Invalid or archived/i
  );
});

test("moveNode: injected write failure restores tree and note bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-move-rollback-"));
  const base = new NodeFs(dir);
  await scaffoldTent(base, { name: "x", rules: "# r\n" });
  const setupEnv = envFor(base);
  const a = await createBox(setupEnv as any, { parentPath: "", name: "alpha", type: "prompt" });
  const b = await createBox(setupEnv as any, { parentPath: "", name: "beta", type: "prompt" });
  const dest = await createBox(setupEnv as any, { parentPath: "", name: "dest", type: "prompt" });
  void dest;

  const betaOriginal = [
    "---",
    `id: ${b}`,
    "type: prompt",
    "---",
    "",
    "See [Alpha](../alpha/alpha.md).",
    "",
  ].join("\n");
  await base.writeFile("beta/beta.md", betaOriginal);
  const alphaOriginal = await base.readFile("alpha/alpha.md");

  const injected = injectWriteFailure(base, 1);
  const env = envFor(injected.fs);

  await assert.rejects(
    () => moveNode(env as any, a, dest, { mode: "inside" }),
    /injected write failure/
  );

  assert.equal(await base.exists("alpha/alpha.md"), true);
  assert.equal(await base.exists("dest/alpha"), false);
  assert.equal(await base.readFile("alpha/alpha.md"), alphaOriginal);
  assert.equal(await base.readFile("beta/beta.md"), betaOriginal);

  const tent = await loadTent(base);
  assert.equal(tent.byId.get(a)?.path, "alpha");
});

test("docs.move: service user-only, expectedPath stale, event once, client method", async () => {
  await withService(async (svc) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-move-ws-"));
    const fsa = new NodeFs(workspace);
    await scaffoldInWorkspace(fsa, {
      name: "demo",
      rules: "# RULES\n\nmove test\n",
      boxes: [
        { name: "inbox", type: "prompt", body: "# inbox\n" },
        { name: "shelf", type: "prompt", body: "# shelf\n" },
        { name: "peer", type: "prompt", body: "Link [Inbox](../inbox/inbox.md).\n" },
      ],
    });

    const mount = await rpc(svc, "workspace.mount", { workspaceRoot: workspace });
    assert.ok(!mount.error, JSON.stringify(mount.error));
    const workspaceId = (mount.result as { workspaceId: string }).workspaceId;

    const moveEvents: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type !== "concept.changed" || ev.workspaceId !== workspaceId) return;
      const payload = ev.payload as Record<string, unknown>;
      if (payload.reason === "docs.move") moveEvents.push(payload);
    });

    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const inbox = (await client.docsGet(workspaceId, { path: "inbox" })) as {
      concept: { id: string; path: string };
    };
    const shelf = (await client.docsGet(workspaceId, { path: "shelf" })) as {
      concept: { id: string; path: string };
    };
    const cx = inbox.concept.id;
    const shelfId = shelf.concept.id;

    const denied = await rpc(svc, "docs.move", {
      workspaceId,
      id: cx,
      expectedPath: "inbox",
      newParentId: shelfId,
      position: { mode: "inside" },
      actor: "agent",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);
    assert.equal(moveEvents.length, 0);

    const stale = await rpc(svc, "docs.move", {
      workspaceId,
      id: cx,
      expectedPath: "inbox-stale",
      newParentId: shelfId,
      position: { mode: "inside" },
    });
    assert.ok(stale.error);
    assert.equal(stale.error!.code, -32009);
    assert.equal((stale.error!.data as { code?: string })?.code, "path_stale");
    assert.equal((stale.error!.data as { currentPath?: string })?.currentPath, "inbox");
    assert.equal((stale.error!.data as { expectedPath?: string })?.expectedPath, "inbox-stale");
    assert.equal(moveEvents.length, 0);

    const moved = (await client.docsMove(workspaceId, {
      id: cx,
      expectedPath: "inbox",
      newParentId: shelfId,
      position: { mode: "inside" },
    })) as {
      id: string;
      path: string;
      oldPath: string;
      pathMap: Record<string, string>;
    };
    assert.equal(moved.id, cx);
    assert.equal(moved.oldPath, "inbox");
    assert.equal(moved.path, "shelf/inbox");
    assert.equal(moved.pathMap["inbox"], "shelf/inbox");

    assert.equal(moveEvents.length, 1);
    assert.equal(moveEvents[0]!.reason, "docs.move");
    assert.equal(moveEvents[0]!.id, cx);
    assert.equal(moveEvents[0]!.path, "shelf/inbox");
    assert.equal(moveEvents[0]!.oldPath, "inbox");
    assert.ok(moveEvents[0]!.pathMap);

    const byId = (await client.docsGet(workspaceId, { id: cx })) as {
      concept: { id: string; path: string };
    };
    assert.equal(byId.concept.path, "shelf/inbox");

    // scaffoldInWorkspace places concepts under workspace/.tent/
    const peer = await fsa.readFile(".tent/peer/peer.md");
    assert.match(peer, /shelf\/inbox\/inbox\.md/);
    assert.doesNotMatch(peer, /\(\.\.\/inbox\/inbox\.md\)/);

    // Create a second child under shelf, then same-parent reorder (order-only).
    const otherNote = (await client.docsCreateNote(workspaceId, {
      name: "other",
      type: "prompt",
      parentPath: "shelf",
    })) as { id: string; path?: string };
    const reordered = (await client.docsMove(workspaceId, {
      id: cx,
      expectedPath: "shelf/inbox",
      newParentId: shelfId,
      position: { mode: "after", siblingId: otherNote.id },
    })) as { path: string; oldPath: string; rewrittenNotes: string[] };
    assert.equal(reordered.path, "shelf/inbox");
    assert.equal(reordered.oldPath, "shelf/inbox");
    assert.deepEqual(reordered.rewrittenNotes, []);

    const missing = await rpc(svc, "docs.move", {
      workspaceId,
      id: "cx-missing-xx",
      expectedPath: "x",
      newParentId: null,
      position: { mode: "inside" },
    });
    assert.ok(missing.error);
    assert.equal(missing.error!.code, -32004);

    // No dual alias.
    const alias = await rpc(svc, "docs.reparent", {
      workspaceId,
      id: cx,
      expectedPath: "shelf/inbox",
      newParentId: null,
      position: { mode: "inside" },
    });
    assert.ok(alias.error);

    unsub();
  });
});
