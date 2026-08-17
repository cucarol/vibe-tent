import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { get as httpGet } from "node:http";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import {
  nodeContextCard,
  contextCardToDragText,
  parseContextCardText,
} from "../src/core/context-card.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { listenOnFetchCompatiblePort } from "../src/service/http-server.js";
import { ServiceRpcClient, ServiceRpcError } from "../src/desktop/client/rpc-client.js";
import {
  tryAttach,
  attachOrStartService,
  serviceChildEnv,
} from "../src/desktop/client/service-attach.js";
import { ServiceDocsClient } from "../src/desktop/client/service-docs-client.js";
import { DesktopShellModel } from "../src/desktop/workbench/shell-model.js";
import { WorkspaceController } from "../src/markdown/workspace-controller.js";
import { loadDesktopPrefs, rememberWorkspace, saveDesktopPrefs } from "../src/desktop/prefs.js";
import { CLIENT_METHODS } from "../src/service/types.js";
import { readServiceEndpoint, serviceEndpointPath } from "../src/service/data-dir.js";
import { serviceLeasePath } from "../src/service/service-lease.js";

const repoRoot = path.resolve(".");
const sourceServiceEntry = path.join(repoRoot, "src", "service", "cli.ts");
const sourceServiceModuleUrl = pathToFileURL(
  path.join(repoRoot, "src", "service", "service.ts")
).href;
const spawnSourceService = ((
  _command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {}
) => {
  const dataDirFlag = args.indexOf("--data-dir");
  assert.ok(dataDirFlag >= 0 && args[dataDirFlag + 1]);
  return spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      sourceServiceEntry,
      "start",
      "--data-dir",
      args[dataDirFlag + 1]!,
    ],
    { ...options, cwd: repoRoot }
  );
}) as typeof spawn;

function spawnDelayedSourceService(dataDir: string, options: SpawnOptions) {
  const script = `
    setTimeout(async () => {
      const { startLocalTentService } = await import(${JSON.stringify(sourceServiceModuleUrl)});
      await startLocalTentService({ dataDir: ${JSON.stringify(dataDir)}, writeEndpoint: true });
    }, 250);
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ["--import", "tsx", "--eval", script], {
    ...options,
    cwd: repoRoot,
  });
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} did not exit within ${timeoutMs}ms`);
}

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-desktop-attach-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "desk",
    nodes: [
      { name: "inbox", type: "prompt", body: "# inbox\nhello desktop\n" },
      { name: "goal-a", type: "goal", body: "# goal\n" },
    ],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [{ name: "executor", prompt: "do" }] }, null, 2) + "\n"
  );
  return workspace;
}

test("CLIENT_METHODS includes docs.search/backlinks/importAttachment for desktop", () => {
  assert.ok(CLIENT_METHODS.includes("docs.search"));
  assert.ok(CLIENT_METHODS.includes("docs.backlinks"));
  assert.ok(CLIENT_METHODS.includes("docs.importAttachment"));
});

test("canonical Context Card text remains a stable pointer prompt", () => {
  const card = nodeContextCard("cx-demo", "inbox", { label: "inbox" });
  const text = contextCardToDragText(card);
  assert.match(text, /Tent contextCard v1/);
  assert.match(text, /contextRef: node\/cx-demo/);
  assert.equal(parseContextCardText(text)?.id, "cx-demo");

});

test("ServiceDocsClient over real Local Service: list/open/write/search", async () => {
  const ws = await makeWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-desktop-attach-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const rpc = new ServiceRpcClient({ baseUrl: svc.url, token: svc.token });
    const mounted = await rpc.call<{ workspaceId: string }>("workspace.mount", {
      workspaceRoot: ws,
    });
    const docs = new ServiceDocsClient({ rpc, workspaceId: mounted.workspaceId });

    const tree = await docs.list();
    assert.ok(tree.length >= 1);
    assert.ok(tree.some((n) => n.name === "inbox" || n.path === "inbox"));

    const created = await docs.createNote({ name: "from-desk", type: "prompt", body: "# from desk\n" });
    assert.match(created.nodeId, /^cx-/);

    const edit = await docs.readForEdit(created.nodeId);
    assert.ok(edit.etag);
    assert.ok(edit.raw.includes("from desk") || edit.body.includes("from desk"));

    const written = await docs.write({
      nodeId: created.nodeId,
      baseEtag: edit.etag,
      raw: edit.raw.replace("from desk", "from desk v2"),
    });
    assert.equal(written.ok, true);

    const hits = await docs.search("from desk v2");
    assert.ok(hits.some((h) => h.nodeId === created.nodeId));


    const bin = new Uint8Array([0x00, 0x01, 0xff, 0xfe]);
    const att = await docs.importAttachment(created.nodeId, "desk.bin", bin);
    assert.match(att.relativePath, new RegExp(`^attachments/${created.nodeId}/`));
    const disk = await fs.readFile(path.join(ws, ".tent", ...att.relativePath.split("/")));
    assert.deepEqual([...disk], [...bin]);

    const controller = new WorkspaceController(docs);
    await controller.refreshTree();
    await controller.openNode(created.nodeId);
    const snap = controller.getSnapshot();
    assert.equal(snap.activeCx, created.nodeId);
    assert.ok(snap.tree.length > 0);

    const model = new DesktopShellModel(rpc);
    await model.refreshHealth();
    assert.equal(model.getSnapshot().health.status, "ok");
    await model.refreshWorkspaces();
    await model.bindForeground(mounted.workspaceId);
    const floating = model.floatingStatus();
    assert.equal(floating.health.status, "ok");
  } finally {
    await svc.stop();
  }
});

test("DesktopShellModel mount makes the mounted workspace authoritative foreground", async () => {
  const workspaceA = await makeWorkspace();
  const workspaceB = await makeWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-desktop-attach-switch-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const rpc = new ServiceRpcClient({ baseUrl: svc.url, token: svc.token });
    const model = new DesktopShellModel(rpc);
    const mountedA = await model.mountWorkspace(workspaceA);
    assert.equal(model.getSnapshot().foregroundWorkspaceId, mountedA.workspaceId);

    const mountedB = await model.mountWorkspace(workspaceB);
    const snapshot = model.getSnapshot();
    assert.equal(snapshot.foregroundWorkspaceId, mountedB.workspaceId);
    assert.equal(
      snapshot.workspaces.find((workspace) => workspace.foreground)?.workspaceId,
      mountedB.workspaceId
    );
    assert.equal((await rpc.health()).foregroundWorkspaceId, mountedB.workspaceId);
  } finally {
    await svc.stop();
  }
});

test("tryAttach finds healthy endpoint; attach leaves service alive after client drop", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-desktop-attach-attach-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const attached = await tryAttach(dataDir);
    assert.ok(attached);
    assert.equal(attached!.url, svc.url);
    assert.equal(attached!.client.token, svc.token);
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

test("desktop attach propagates endpoint token for RPC/SSE; health stays open", async () => {
  const ws = await makeWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-desktop-attach-token-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    // Discovery probe: /health without token
    const openHealth = await fetch(`${svc.url}/health`);
    assert.equal(openHealth.status, 200);

    // Missing / wrong token still rejected at service edge
    const noTok = await fetch(`${svc.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "workspace.list", params: {} }),
    });
    assert.equal(noTok.status, 401);
    const sseNoTok = await fetch(`${svc.url}/events`);
    assert.equal(sseNoTok.status, 401);

    const attached = await tryAttach(dataDir);
    assert.ok(attached);
    assert.equal(attached!.endpoint.token, svc.token);
    assert.equal(attached!.client.token, svc.token);

    // workspace.mount must succeed with attach-propagated token (the joint-test failure)
    const mounted = await attached!.client.call<{ workspaceId: string }>("workspace.mount", {
      workspaceRoot: ws,
    });
    assert.ok(mounted.workspaceId);

    const listed = await attached!.client.call<{ workspaces: unknown[] }>("workspace.list", {});
    assert.ok(Array.isArray(listed.workspaces));
    assert.ok(listed.workspaces.length >= 1);

    // SSE with attach client token
    const events: unknown[] = [];
    const sub = attached!.client.subscribeEvents((ev) => events.push(ev));
    await attached!.client.call("workspace.setForeground", { workspaceId: mounted.workspaceId });
    await new Promise((r) => setTimeout(r, 150));
    sub.close();
    // At least the connection must authenticate; events may or may not fire depending on bus
    // Wrong-token client must not mount
    const bad = new ServiceRpcClient({ baseUrl: svc.url, token: "not-the-token" });
    await assert.rejects(
      () => bad.call("workspace.list", {}),
      (err: unknown) =>
        err instanceof ServiceRpcError &&
        (err.message.includes("Unauthorized") || err.code === -32001)
    );
  } finally {
    await svc.stop();
  }
});

test("tryAttach rejects endpoint without token even if health is open", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-desktop-attach-notoken-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    // Corrupt endpoint: strip token while service still healthy
    const epPath = serviceEndpointPath(
      dataDir,
      svc.endpoint!.instanceId,
      svc.endpoint!.startedAt
    );
    const raw = JSON.parse(await fs.readFile(epPath, "utf8")) as Record<string, unknown>;
    delete raw.token;
    await fs.writeFile(epPath, JSON.stringify(raw, null, 2) + "\n", "utf8");

    const attached = await tryAttach(dataDir);
    assert.equal(attached, null);

    // Health remains open for discovery
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpGet(`${svc.url}/health`, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
    });
    assert.equal(status, 200);
  } finally {
    await svc.stop();
  }
});

test("attachOrStartService can bootstrap via spawn of service entry", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-desktop-attach-boot-"));
  const serviceEntry = path.resolve("service.mjs");
  let childPid: number | undefined;
  try {
    const result = await attachOrStartService({
      dataDir,
      serviceEntry,
      spawnFn: spawnSourceService,
      readyTimeoutMs: 20_000,
    });
    assert.equal(result.started, true);
    assert.ok(result.url);
    assert.ok(result.endpoint.token);
    assert.equal(result.client.token, result.endpoint.token);
    childPid = result.endpoint.pid;
    assert.doesNotThrow(() => process.kill(childPid!, 0));
    const health = await result.client.health();
    assert.equal(health.status, "ok");

    // Bootstrap client must authenticate RPC with endpoint token
    const listed = await result.client.call<{ workspaces: unknown[] }>("workspace.list", {});
    assert.ok(Array.isArray(listed.workspaces));

    // Service still healthy without holding Electron
    const again = await tryAttach(dataDir);
    assert.ok(again);
    assert.equal(again!.client.token, result.endpoint.token);
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

test("desktop concurrent bootstraps attach to the same Local Service", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-desktop-attach-boot-race-"));
  const serviceEntry = path.resolve("service.mjs");
  try {
    const [first, second] = await Promise.all([
      attachOrStartService({
        dataDir,
        serviceEntry,
        spawnFn: spawnSourceService,
        readyTimeoutMs: 20_000,
      }),
      attachOrStartService({
        dataDir,
        serviceEntry,
        spawnFn: spawnSourceService,
        readyTimeoutMs: 20_000,
      }),
    ]);
    assert.equal(first.endpoint.instanceId, second.endpoint.instanceId);
    assert.equal(first.endpoint.pid, second.endpoint.pid);
    assert.equal(first.url, second.url);
    assert.equal((await first.client.health()).status, "ok");
    assert.equal((await second.client.health()).status, "ok");
  } finally {
    const endpoint = await readServiceEndpoint(dataDir);
    if (endpoint?.pid) {
      try {
        process.kill(endpoint.pid);
      } catch {
        // already stopped
      }
    }
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("desktop attach timeout stops its owned child before any endpoint or lease can publish", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-desktop-timeout-pipes-"));
  const serviceEntry = path.resolve("service.mjs");
  let spawned: ReturnType<typeof spawn> | undefined;
  const spawnHung = ((_command: string, _args: readonly string[], options: SpawnOptions) => {
    spawned = spawnDelayedSourceService(dataDir, options);
    return spawned;
  }) as typeof spawn;
  await assert.rejects(
    () =>
      attachOrStartService({
        dataDir,
        serviceEntry,
        spawnFn: spawnHung,
        readyTimeoutMs: 50,
        pollMs: 5,
      }),
    /Timed out waiting/
  );
  assert.ok(spawned?.pid);
  await waitForProcessExit(spawned!.pid!);
  assert.equal(spawned?.stdout?.destroyed, true);
  assert.equal(spawned?.stderr?.destroyed, true);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(await readServiceEndpoint(dataDir), null);
  await assert.rejects(() => fs.access(serviceLeasePath(dataDir)), /ENOENT/);
});

test("packaged service spawn forces Electron into Node mode", () => {
  const env = serviceChildEnv({ CUSTOM_SENTINEL: "yes" }, "C:\\tent-data");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.TENT_SERVICE_DATA_DIR, "C:\\tent-data");
  assert.equal(env.CUSTOM_SENTINEL, "yes");
});

test("desktop prefs remember workspaces", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-desktop-attach-prefs-"));
  const prefs = rememberWorkspace(await loadDesktopPrefs(dataDir), "C:\\ws\\a");
  const next = rememberWorkspace(prefs, "C:\\ws\\b");
  await saveDesktopPrefs(next, dataDir);
  const loaded = await loadDesktopPrefs(dataDir);
  assert.equal(loaded.lastWorkspaceRoot, "C:\\ws\\b");
  assert.deepEqual(loaded.recentWorkspaces.slice(0, 2), ["C:\\ws\\b", "C:\\ws\\a"]);
});

test("drop target receives full text/plain context card payload", async () => {
  const card = nodeContextCard("cx-drop", "path/to/node", { label: "drop-me" });
  const payload = contextCardToDragText(card);

  // Minimal HTTP drop target simulating external app receiving text/plain
  // (cross-app HTML5 drag on Windows; not a clipboard or file path).
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
  const port = await listenOnFetchCompatiblePort(server, "127.0.0.1");
  const res = await fetch(`http://127.0.0.1:${port}/drop`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: payload,
  });
  assert.equal(res.status, 200);
  assert.equal(received[0], payload);
  assert.match(received[0], /Tent contextCard v1/);
  assert.match(received[0], /cx-drop/);
  assert.doesNotMatch(received[0], /\.md\b/);
  await new Promise<void>((r) => server.close(() => r()));
});
