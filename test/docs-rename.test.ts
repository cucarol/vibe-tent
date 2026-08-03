import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import type { FsAdapter } from "../src/core/adapter.js";
import { createNode, renameNode } from "../src/core/ops.js";
import { loadTent } from "../src/core/tree.js";
import { loadOrder, saveOrder, ROOT_KEY } from "../src/core/order.js";
import { scaffoldInWorkspace, scaffoldTent } from "../src/core/scaffold.js";
import { buildNodeIndex } from "../src/core/okf.js";
import { rewriteNodeLinks } from "../src/core/renameOps.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { isClientMethod } from "../src/service/types.js";

function envFor(fsa: FsAdapter, name = "x") {
  // Distinct ids per createNode — fixed rand would collide across nodes.
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
function injectWriteFailure(inner: FsAdapter, failOnWriteNumber: number): {
  fs: FsAdapter;
  writeCount: () => number;
} {
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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-rename-data-"));
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

test("isClientMethod includes docs.rename", () => {
  assert.equal(isClientMethod("docs.rename"), true);
});

test("rewriteNodeLinks: md path and unique wiki name for rename root", () => {
  // Two concepts: unique alpha + unrelated gamma (index needed for unique name rewrite).
  const nodes = [
    {
      id: "cx-alpha",
      path: "alpha",
      name: "alpha",
      type: "prompt",
      body: "",
      tags: [],
      coordination: "open",
      children: [],
      parent: undefined,
      fm: {},
      archived: false,
      invalid: false,
      locked: false,
    },
    {
      id: "cx-child",
      path: "alpha/child",
      name: "child",
      type: "prompt",
      body: "",
      tags: [],
      coordination: "open",
      children: [],
      parent: undefined,
      fm: {},
      archived: false,
      invalid: false,
      locked: false,
    },
  ] as any;
  const conceptIndex = buildNodeIndex(nodes);
  const pathMap = new Map([
    ["alpha", "beta"],
    ["alpha/alpha", "beta/beta"],
    ["alpha/child", "beta/child"],
    ["alpha/child/child", "beta/child/child"],
  ]);
  const body = [
    "See [A](alpha/alpha.md) and [[alpha]] plus [[alpha/child]].",
    "Rel [C](./alpha.md).",
  ].join("\n");
  const out = rewriteNodeLinks(body, "other/other.md", pathMap, "alpha", "beta", {
    renameNodeId: "cx-alpha",
    conceptIndex,
  });
  assert.equal(out.changed, true);
  assert.match(out.body, /beta\/beta\.md/);
  assert.match(out.body, /\[\[beta\]\]/);
  assert.match(out.body, /\[\[beta\/child\]\]/);
});

test("rewriteNodeLinks: leaves ambiguous unqualified wiki name unchanged", () => {
  const nodes = [
    {
      id: "cx-a1",
      path: "branch-a/twin",
      name: "twin",
      type: "prompt",
      body: "",
      tags: [],
      coordination: "open",
      children: [],
      parent: undefined,
      fm: {},
      archived: false,
      invalid: false,
      locked: false,
    },
    {
      id: "cx-a2",
      path: "branch-b/twin",
      name: "twin",
      type: "prompt",
      body: "",
      tags: [],
      coordination: "open",
      children: [],
      parent: undefined,
      fm: {},
      archived: false,
      invalid: false,
      locked: false,
    },
  ] as any;
  const conceptIndex = buildNodeIndex(nodes);
  const pathMap = new Map([
    ["branch-a/twin", "branch-a/twin-renamed"],
    ["branch-a/twin/twin", "branch-a/twin-renamed/twin-renamed"],
  ]);
  const body = "Ambiguous [[twin]] stays; path [[branch-a/twin]] moves.\n";
  const out = rewriteNodeLinks(body, "other/other.md", pathMap, "twin", "twin-renamed", {
    renameNodeId: "cx-a1",
    conceptIndex,
  });
  assert.equal(out.changed, true);
  assert.match(out.body, /\[\[twin\]\]/);
  assert.doesNotMatch(out.body, /\[\[twin-renamed\]\]/);
  assert.match(out.body, /\[\[branch-a\/twin-renamed\]\]/);
});

test("renameNode: leaf keeps cx-, renames folder + identity note", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-rename-leaf-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const id = await createNode(env as any, { parentPath: "", name: "leaf", type: "prompt" });
  const result = await renameNode(env as any, id, "renamed-leaf");
  assert.equal(result.id, id);
  assert.equal(result.oldPath, "leaf");
  assert.equal(result.path, "renamed-leaf");
  assert.equal(await fsa.exists("leaf"), false);
  assert.equal(await fsa.exists("renamed-leaf/renamed-leaf.md"), true);
  const note = await fsa.readFile("renamed-leaf/renamed-leaf.md");
  assert.match(note, new RegExp(`id: ${id}`));
  const tent = await loadTent(fsa);
  assert.equal(tent.byId.get(id)?.path, "renamed-leaf");
  assert.equal(tent.byPath.has("leaf"), false);
});

test("renameNode: subtree preserves child relative paths and ids", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-rename-sub-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const parentId = await createNode(env as any, { parentPath: "", name: "parent", type: "prompt" });
  const childId = await createNode(env as any, { parentPath: "parent", name: "child", type: "prompt" });
  const grandId = await createNode(env as any, {
    parentPath: "parent/child",
    name: "grand",
    type: "prompt",
  });

  const result = await renameNode(env as any, parentId, "parent-new");
  assert.equal(result.id, parentId);
  assert.equal(result.path, "parent-new");
  assert.equal(result.pathMap["parent/child"], "parent-new/child");
  assert.equal(result.pathMap["parent/child/grand"], "parent-new/child/grand");

  const tent = await loadTent(fsa);
  assert.equal(tent.byId.get(parentId)?.path, "parent-new");
  assert.equal(tent.byId.get(childId)?.path, "parent-new/child");
  assert.equal(tent.byId.get(grandId)?.path, "parent-new/child/grand");
  assert.equal(tent.byId.get(childId)?.name, "child");
  assert.equal(await fsa.exists("parent-new/child/child.md"), true);
  assert.equal(await fsa.exists("parent"), false);
});

test("renameNode: rewrites inbound md links; order stays id-keyed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-rename-links-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const a = await createNode(env as any, { parentPath: "", name: "alpha", type: "prompt" });
  const b = await createNode(env as any, { parentPath: "", name: "beta", type: "prompt" });
  await fsa.writeFile(
    "beta/beta.md",
    `---\nid: ${b}\ntype: prompt\n---\n\nSee [Alpha](../alpha/alpha.md) and [[alpha]].\n`
  );
  const orderBefore = await loadOrder(fsa);
  orderBefore[ROOT_KEY] = [a, b];
  await saveOrder(fsa, orderBefore);

  const result = await renameNode(env as any, a, "alpha-renamed");
  assert.equal(result.id, a);
  const body = await fsa.readFile("beta/beta.md");
  assert.match(body, /alpha-renamed/);
  assert.doesNotMatch(body, /\balpha\/alpha\.md\b/);
  assert.match(body, /\[\[alpha-renamed\]\]/);
  const orderAfter = await loadOrder(fsa);
  assert.deepEqual(orderAfter[ROOT_KEY], [a, b]);
});

test("renameNode: duplicate display names leave unqualified wiki unchanged", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-rename-dup-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const branchA = await createNode(env as any, { parentPath: "", name: "branch-a", type: "prompt" });
  const branchB = await createNode(env as any, { parentPath: "", name: "branch-b", type: "prompt" });
  void branchA;
  void branchB;
  const twinA = await createNode(env as any, {
    parentPath: "branch-a",
    name: "twin",
    type: "prompt",
  });
  const twinB = await createNode(env as any, {
    parentPath: "branch-b",
    name: "twin",
    type: "prompt",
  });
  const hub = await createNode(env as any, { parentPath: "", name: "hub", type: "prompt" });
  const hubBody = [
    "---",
    `id: ${hub}`,
    "type: prompt",
    "---",
    "",
    "Unqualified [[twin]] is ambiguous.",
    "Path [A](../branch-a/twin/twin.md) is unique.",
    `Other twin id ${twinB}.`,
    "",
  ].join("\n");
  await fsa.writeFile("hub/hub.md", hubBody);

  await renameNode(env as any, twinA, "twin-renamed");

  const after = await fsa.readFile("hub/hub.md");
  // Ambiguous bare wiki must stay.
  assert.match(after, /\[\[twin\]\]/);
  assert.doesNotMatch(after, /\[\[twin-renamed\]\]/);
  // Path link rewrites.
  assert.match(after, /branch-a\/twin-renamed/);
  assert.doesNotMatch(after, /branch-a\/twin\/twin\.md/);
  // Tree restored to unique paths; other twin untouched.
  assert.equal(await fsa.exists("branch-a/twin-renamed/twin-renamed.md"), true);
  assert.equal(await fsa.exists("branch-b/twin/twin.md"), true);
});

test("renameNode: injected write failure restores tree and every note byte-for-byte", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-rename-rollback-"));
  const base = new NodeFs(dir);
  await scaffoldTent(base, { name: "x" });
  const setupEnv = envFor(base);
  const a = await createNode(setupEnv as any, { parentPath: "", name: "alpha", type: "prompt" });
  const b = await createNode(setupEnv as any, { parentPath: "", name: "beta", type: "prompt" });
  const c = await createNode(setupEnv as any, { parentPath: "", name: "gamma", type: "prompt" });

  const betaOriginal = [
    "---",
    `id: ${b}`,
    "type: prompt",
    "---",
    "",
    "See [Alpha](../alpha/alpha.md) and [[alpha]].",
    "",
  ].join("\n");
  const gammaOriginal = [
    "---",
    `id: ${c}`,
    "type: prompt",
    "---",
    "",
    "Also [Alpha path](../alpha/alpha.md).",
    "",
  ].join("\n");
  await base.writeFile("beta/beta.md", betaOriginal);
  await base.writeFile("gamma/gamma.md", gammaOriginal);
  const alphaOriginal = await base.readFile("alpha/alpha.md");

  // Snapshot pre-rename tree state.
  const before = {
    alphaExists: await base.exists("alpha/alpha.md"),
    beta: await base.readFile("beta/beta.md"),
    gamma: await base.readFile("gamma/gamma.md"),
    alpha: alphaOriginal,
  };

  // Fail on the 2nd writeFile after move (first is typically beta or gamma rewrite).
  // Identity rename uses move, not writeFile; planned rewrites use writeFile.
  const injected = injectWriteFailure(base, 2);
  const env = envFor(injected.fs);

  await assert.rejects(
    () => renameNode(env as any, a, "alpha-renamed"),
    /injected write failure/
  );

  // Tree fully restored.
  assert.equal(await base.exists("alpha/alpha.md"), true);
  assert.equal(await base.exists("alpha-renamed"), false);
  assert.equal(await base.exists("alpha"), true);

  // Every touched note restored byte-for-byte.
  assert.equal(await base.readFile("alpha/alpha.md"), before.alpha);
  assert.equal(await base.readFile("beta/beta.md"), before.beta);
  assert.equal(await base.readFile("gamma/gamma.md"), before.gamma);
  assert.equal(await base.readFile("beta/beta.md"), betaOriginal);
  assert.equal(await base.readFile("gamma/gamma.md"), gammaOriginal);

  const tent = await loadTent(base);
  assert.equal(tent.byId.get(a)?.path, "alpha");
  assert.equal(tent.byId.get(a)?.name, "alpha");
  assert.ok(injected.writeCount() >= 2);
});

test("renameNode: refuses collision and occupied range", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-rename-guard-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x" });
  const env = envFor(fsa);
  const a = await createNode(env as any, { parentPath: "", name: "one", type: "prompt" });
  await createNode(env as any, { parentPath: "", name: "two", type: "prompt" });
  await assert.rejects(() => renameNode(env as any, a, "two"), /already exists|sibling/i);

  // cx-tsw53f: active direct Task ref does not freeze rename (stable nodeId).
  const occupied = await createNode(env as any, { parentPath: "", name: "busy", type: "prompt" });
  await fsa.mkdir("temp/executor/tasks");
  await fsa.writeFile(
    "temp/executor/tasks/task-busy.md",
    [
      "---",
      "type: task",
      "id: tk-busy001",
      "role: executor",
      "parentActor: { kind: user, id: user }",
      "reviewer: { kind: user, id: user }",
      "status: taken",
      "state: running",
      "manifest: temp/executor/manifests/x.yml",
      "contextCard:",
      "  schemaVersion: v1",
      "  objective: hold",
      "  frozenDecisions: []",
      "  scope: { include: [], exclude: [] }",
      "  acceptance: [hold]",
      "  refs:",
      "    nodes:",
      `      - { id: ${occupied} }`,
      "    tasks: []",
      "    deliveries: []",
      "    git: []",
      "  parentActor: { kind: user, id: user }",
      "  reviewer: { kind: user, id: user }",
      "  assignee: { kind: role, id: executor }",
      "  contextGeneration: cg-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "  taskDeltaDigest: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "---",
      "",
      "# Task",
      "",
      "## User Prompt",
      "",
      "hold",
      "",
    ].join("\n")
  );
  const renamedBusy = await renameNode(env as any, occupied, "busy-free");
  assert.equal(renamedBusy.path, "busy-free");
  assert.equal(renamedBusy.id, occupied);

  // Stale Node FM alone must not block rename.
  const staleOnly = await createNode(env as any, { parentPath: "", name: "stale", type: "prompt" });
  await fsa.writeFile(
    "stale/stale.md",
    `---\nid: ${staleOnly}\ntype: prompt\nowner: ghost\nstatus: doing\n---\n\n# stale\n`
  );
  const renamed = await renameNode(env as any, staleOnly, "stale-free");
  assert.equal(renamed.path, "stale-free");
});

test("docs.rename: service user-only, event, client, etag-independent resolve by cx", async () => {
  await withService(async (svc) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-rename-ws-"));
    const fsa = new NodeFs(workspace);
    await scaffoldInWorkspace(fsa, {
      name: "demo",
      nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
    });
    // sibling for inbound links
    await fsa.mkdir(".tent/hub");
    await fsa.writeFile(
      ".tent/hub/hub.md",
      "---\nid: cx-hub001\ntype: prompt\n---\n\nLink [Inbox](../inbox/inbox.md) and [[inbox]].\n"
    );

    const mount = await rpc(svc, "workspace.mount", { workspaceRoot: workspace });
    assert.ok(!mount.error, JSON.stringify(mount.error));
    const workspaceId = (mount.result as { workspaceId: string }).workspaceId;

    const renameEvents: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type !== "node.changed" || ev.workspaceId !== workspaceId) return;
      const payload = ev.payload as Record<string, unknown>;
      // Handler emits reason docs.rename once; FS watchers may fan extra node.changed.
      if (payload.reason === "docs.rename") renameEvents.push(payload);
    });

    const denied = await rpc(svc, "docs.rename", {
      workspaceId,
      nodeId: "cx-invalid",
      newName: "inbox-2",
      actor: "agent",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);
    assert.equal(renameEvents.length, 0);

    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const loaded = await loadTent(new NodeFs(path.join(workspace, ".tent")));
    const cx = loaded.byPath.get("inbox")!.id;

    const renamed = (await client.docsRename(workspaceId, {
      nodeId: cx,
      newName: "inbox-2",
    })) as {
      nodeId: string;
      path: string;
      oldPath: string;
      name: string;
    };
    assert.equal(renamed.nodeId, cx);
    assert.equal(renamed.path, "inbox-2");
    assert.equal(renamed.oldPath, "inbox");
    assert.equal(renamed.name, "inbox-2");

    assert.equal(renameEvents.length, 1);
    assert.equal(renameEvents[0]!.reason, "docs.rename");
    assert.equal(renameEvents[0]!.nodeId, cx);
    assert.equal(renameEvents[0]!.path, "inbox-2");
    assert.equal(renameEvents[0]!.oldPath, "inbox");

    const byId = (await client.docsGet(workspaceId, cx)) as { node: { nodeId: string; path: string; name: string } };
    assert.equal(byId.node.path, "inbox-2");
    assert.equal(byId.node.name, "inbox-2");

    const hub = await fsa.readFile(".tent/hub/hub.md");
    assert.match(hub, /inbox-2/);
    assert.doesNotMatch(hub, /\binbox\/inbox\.md\b/);

    const conflict = await rpc(svc, "docs.rename", {
      workspaceId,
      id: cx,
      newName: "hub",
    });
    assert.ok(conflict.error);
    assert.equal(conflict.error!.code, -32602);

    const missing = await rpc(svc, "docs.rename", {
      workspaceId,
      nodeId: "cx-missing",
      newName: "x",
    });
    assert.ok(missing.error);
    assert.equal(missing.error!.code, -32004);

    unsub();
  });
});
