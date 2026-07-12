import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import {
  boxContextCard,
  contextCardToDragText,
  parseContextCardText,
} from "../src/core/context-card.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { ServiceRpcClient } from "../src/desktop/client/rpc-client.js";
import { tryAttach, attachOrStartService } from "../src/desktop/client/service-attach.js";
import { ServiceDocsClient } from "../src/desktop/client/service-docs-client.js";
import { ContextCardStore } from "../src/desktop/workbench/context-card-store.js";
import { DesktopShellModel } from "../src/desktop/workbench/shell-model.js";
import { WorkspaceController } from "../src/markdown/workspace-controller.js";
import { loadDesktopPrefs, rememberWorkspace, saveDesktopPrefs } from "../src/desktop/prefs.js";
import { CLIENT_METHODS } from "../src/service/types.js";

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "desk",
    rules: "# RULES\n\nB5 desktop test\n",
    boxes: [
      { name: "inbox", type: "note", body: "# inbox\nhello desktop\n" },
      { name: "goal-a", type: "goal", body: "# goal\n" },
    ],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [{ name: "executor", prompt: "do" }] }, null, 2) + "\n"
  );
  return workspace;
}

test("CLIENT_METHODS includes docs.search/backlinks for desktop", () => {
  assert.ok(CLIENT_METHODS.includes("docs.search"));
  assert.ok(CLIENT_METHODS.includes("docs.backlinks"));
});

test("ContextCardStore + drag text/plain payload is stable pointer prompt", () => {
  const store = new ContextCardStore(3);
  const card = boxContextCard("cx-demo", "inbox", { label: "inbox" });
  const text = contextCardToDragText(card);
  assert.match(text, /Tent contextCard v1/);
  assert.match(text, /contextRef: box\/cx-demo/);
  assert.equal(parseContextCardText(text)?.id, "cx-demo");

  store.pushFromCard(card);
  store.pushBox("cx-2", "other");
  store.pushBox("cx-demo", "inbox", "inbox again");
  const list = store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].refId, "cx-demo");
  assert.match(list[0].text, /text\/plain|contextRef|Tent contextCard/);
});

test("ServiceDocsClient over real Local Service: list/open/write/search/promote", async () => {
  const ws = await makeWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const rpc = new ServiceRpcClient({ baseUrl: svc.url });
    const mounted = await rpc.call<{ workspaceId: string }>("workspace.mount", {
      workspaceRoot: ws,
    });
    const docs = new ServiceDocsClient({ rpc, workspaceId: mounted.workspaceId });

    const tree = await docs.list();
    assert.ok(tree.length >= 1);
    assert.ok(tree.some((n) => n.name === "inbox" || n.path === "inbox"));

    const created = await docs.createNote({ name: "from-desk", type: "note", body: "# from desk\n" });
    assert.match(created.cx, /^cx-/);

    const edit = await docs.readForEdit(created.cx);
    assert.ok(edit.etag);
    assert.ok(edit.raw.includes("from desk") || edit.body.includes("from desk"));

    const written = await docs.write({
      cx: created.cx,
      baseEtag: edit.etag,
      raw: edit.raw.replace("from desk", "from desk v2"),
    });
    assert.equal(written.ok, true);

    const hits = await docs.search("from desk v2");
    assert.ok(hits.some((h) => h.cx === created.cx));

    const promoted = await docs.promote(created.cx, "goal");
    assert.equal(promoted.toType, "goal");

    const controller = new WorkspaceController(docs);
    await controller.refreshTree();
    await controller.openConcept(created.cx);
    const snap = controller.getSnapshot();
    assert.equal(snap.activeCx, created.cx);
    assert.ok(snap.tree.length > 0);

    const model = new DesktopShellModel(rpc);
    await model.refreshHealth();
    assert.equal(model.getSnapshot().health.status, "ok");
    await model.refreshWorkspaces();
    await model.bindForeground(mounted.workspaceId);
    const shellController = model.getController();
    assert.ok(shellController);
    await shellController!.openConcept(created.cx);
    model.emitContextCardForActive();
    // Also allow explicit push without active tab
    model.cards.pushBox(created.cx, created.path, "from-desk");
    const floating = model.floatingStatus();
    assert.equal(floating.health.status, "ok");
    assert.ok(floating.recentCards.length >= 1);
    assert.match(floating.recentCards[0].text, /Tent contextCard v1/);
  } finally {
    await svc.stop();
  }
});

test("tryAttach finds healthy endpoint; attach leaves service alive after client drop", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-attach-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const attached = await tryAttach(dataDir);
    assert.ok(attached);
    assert.equal(attached!.url, svc.url);
    const health = await attached!.client.health();
    assert.equal(health.status, "ok");

    // Simulate desktop main disposeShellOnly: drop client, service remains
    const re = await tryAttach(dataDir);
    assert.ok(re);
    const h2 = await fetch(`${svc.url}/health`);
    assert.equal(h2.status, 200);
  } finally {
    await svc.stop();
  }
});

test("attachOrStartService can bootstrap via spawn of service entry", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-boot-"));
  const serviceEntry = path.resolve("service.mjs");
  let childPid: number | undefined;
  try {
    const result = await attachOrStartService({
      dataDir,
      serviceEntry,
      readyTimeoutMs: 20_000,
    });
    assert.equal(result.started, true);
    assert.ok(result.url);
    childPid = result.endpoint.pid;
    const health = await result.client.health();
    assert.equal(health.status, "ok");

    // Service still healthy without holding Electron
    const again = await tryAttach(dataDir);
    assert.ok(again);
  } finally {
    // Tear down spawned service
    try {
      const ep = await tryAttach(dataDir);
      if (ep) {
        // No stop RPC — kill by pid from endpoint for test cleanup
        process.kill(ep.endpoint.pid);
      } else if (childPid) {
        process.kill(childPid);
      }
    } catch {
      /* already gone */
    }
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("desktop prefs remember workspaces", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-prefs-"));
  const prefs = rememberWorkspace(await loadDesktopPrefs(dataDir), "C:\\ws\\a");
  const next = rememberWorkspace(prefs, "C:\\ws\\b");
  await saveDesktopPrefs(next, dataDir);
  const loaded = await loadDesktopPrefs(dataDir);
  assert.equal(loaded.lastWorkspaceRoot, "C:\\ws\\b");
  assert.deepEqual(loaded.recentWorkspaces.slice(0, 2), ["C:\\ws\\b", "C:\\ws\\a"]);
});

test("drop target receives full text/plain context card payload", async () => {
  const card = boxContextCard("cx-drop", "path/to/box", { label: "drop-me" });
  const payload = contextCardToDragText(card);

  // Minimal HTTP drop target simulating external app paste/drop
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/drop") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200);
        res.end("ok");
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const res = await fetch(`http://127.0.0.1:${addr.port}/drop`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: payload,
  });
  assert.equal(res.status, 200);
  assert.equal(received[0], payload);
  assert.match(received[0], /Tent contextCard v1/);
  assert.match(received[0], /cx-drop/);
  await new Promise<void>((r) => server.close(() => r()));
});
