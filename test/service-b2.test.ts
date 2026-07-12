import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { contentEtag } from "../src/service/etag.js";
import { rpcCall } from "../src/service/http-server.js";
import { startLocalTentService } from "../src/service/service.js";
import { MutationBus } from "../src/service/mutation-bus.js";
import { defaultServiceDataDir, readServiceEndpoint } from "../src/service/data-dir.js";
import { CLIENT_METHODS } from "../src/service/types.js";

async function makeWorkspace(name = "demo"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b2-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    rules: "# RULES\n\nB2 test tent\n",
    boxes: [{ name: "inbox", type: "note", body: "# inbox\n" }],
  });
  // Register a role so dispatch manifest preloads cleanly
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [{ name: "executor", prompt: "do work" }] }, null, 2) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>, dataDir: string) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b2-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc, dataDir);
  } finally {
    await svc.stop();
  }
}

/** Authenticated RPC helper bound to a running service token. */
function rpc(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  method: string,
  params?: Record<string, unknown>
) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

test("service.health + endpoint file written for attach discovery", async () => {
  await withService(async (svc, dataDir) => {
    const res = await fetch(`${svc.url}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; pid: number; version: string };
    assert.equal(body.status, "ok");
    assert.equal(typeof body.pid, "number");

    const ep = await readServiceEndpoint(dataDir);
    assert.ok(ep);
    assert.equal(ep!.port, svc.port);
    assert.equal(ep!.host, svc.host);
    assert.ok(ep!.token);
    assert.equal(ep!.token, svc.token);
  });
});

test("WorkspaceHost mount multi-workspace + setForeground emits workspace.switched", async () => {
  const ws1 = await makeWorkspace("a");
  const ws2 = await makeWorkspace("b");
  await withService(async (svc) => {
    const switched: string[] = [];
    svc.events.subscribe((ev) => {
      if (ev.type === "workspace.switched") switched.push(ev.workspaceId);
    });

    const m1 = await rpc(svc, "workspace.mount", { workspaceRoot: ws1 });
    assert.ok(m1.result);
    const m2 = await rpc(svc, "workspace.mount", { workspaceRoot: ws2 });
    assert.ok(m2.result);

    const list = await rpc(svc, "workspace.list", {});
    const workspaces = (list.result as { workspaces: { workspaceId: string }[] }).workspaces;
    assert.equal(workspaces.length, 2);

    const id2 = (m2.result as { workspaceId: string }).workspaceId;
    await rpc(svc, "workspace.setForeground", { workspaceId: id2 });
    assert.ok(switched.includes(id2));

    const health = await rpc(svc, "service.health", {});
    assert.equal((health.result as { foregroundWorkspaceId: string }).foregroundWorkspaceId, id2);
  });
});

test("docs.createNote / list / get / write with etag; promote + fork", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const created = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "idea",
      type: "note",
    });
    assert.ok(!created.error, JSON.stringify(created.error));
    const id = (created.result as { id: string }).id;
    assert.match(id, /^cx-/);

    const listed = await rpc(svc, "docs.list", { workspaceId });
    const concepts = (listed.result as { concepts: { id: string; name: string }[] }).concepts;
    assert.ok(concepts.some((c) => c.id === id));

    const edit = await rpc(svc, "docs.readForEdit", { workspaceId, id });
    assert.ok(!edit.error, JSON.stringify(edit.error));
    const { etag, body } = edit.result as { etag: string; body: string };

    const written = await rpc(svc, "docs.write", {
      workspaceId,
      id,
      body: body + "\nupdated\n",
      baseEtag: etag,
    });
    assert.ok(!written.error, JSON.stringify(written.error));

    const conflict = await rpc(svc, "docs.write", {
      workspaceId,
      id,
      body: "stale\n",
      baseEtag: etag,
    });
    assert.ok(conflict.error);
    assert.equal(conflict.error!.code, -32009);

    const promoted = await rpc(svc, "docs.promote", {
      workspaceId,
      id,
      toType: "goal",
    });
    assert.ok(!promoted.error, JSON.stringify(promoted.error));
    assert.equal((promoted.result as { toType: string }).toType, "goal");

    const forked = await rpc(svc, "docs.fork", { workspaceId, id });
    assert.ok(!forked.error, JSON.stringify(forked.error));
    const forkId = (forked.result as { id: string }).id;
    assert.match(forkId, /^cx-/);
    assert.notEqual(forkId, id);
  });
});

test("task.dispatch + task.claim project doing; docs.write blocks collab fields", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const created = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "work-item",
      type: "prompt",
    });
    const boxId = (created.result as { id: string }).id;

    const dispatched = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "implement the thing",
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    assert.match(taskPath, /^temp\//);

    // pending task occupies — cannot patch status via docs.write
    const blockedPending = await rpc(svc, "docs.write", {
      workspaceId,
      id: boxId,
      frontmatter: { status: "done" },
    });
    assert.ok(blockedPending.error);
    assert.equal(blockedPending.error!.code, -32010);

    const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));
    assert.equal((claimed.result as { state: string }).state, "running");

    const got = await rpc(svc, "docs.get", { workspaceId, id: boxId });
    const concept = (got.result as { concept: { status?: string; assignee?: string } }).concept;
    assert.equal(concept.status, "doing");
    assert.equal(concept.assignee, "executor");

    const blockedOwner = await rpc(svc, "docs.write", {
      workspaceId,
      id: boxId,
      frontmatter: { assignee: "hacker" },
    });
    assert.ok(blockedOwner.error);
    assert.equal(blockedOwner.error!.code, -32010);

    // body-only write still allowed
    const edit = await rpc(svc, "docs.readForEdit", { workspaceId, id: boxId });
    const { etag, body } = edit.result as { etag: string; body: string };
    const bodyWrite = await rpc(svc, "docs.write", {
      workspaceId,
      id: boxId,
      body: body + "\nnote\n",
      baseEtag: etag,
    });
    assert.ok(!bodyWrite.error, JSON.stringify(bodyWrite.error));

    const listed = await rpc(svc, "task.list", { workspaceId });
    const tasks = (listed.result as { tasks: { path: string; status: string }[] }).tasks;
    assert.ok(tasks.some((t) => t.path === taskPath && t.status === "taken"));
  });
});

test("AgentRuntimePort.* rejected; not in client method table", async () => {
  assert.ok(!CLIENT_METHODS.some((m) => m.startsWith("AgentRuntime")));
  await withService(async (svc) => {
    const res = await rpc(svc, "AgentRuntimePort.startSession", { cwd: "." });
    assert.ok(res.error);
    assert.equal(res.error!.code, -32601);
    assert.match(res.error!.message, /service-internal|not found/i);
  });
});

test("external concept file change fans concept.changed via watch", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const events: string[] = [];
    svc.events.subscribe((ev) => {
      if (ev.type === "concept.changed" && ev.workspaceId === workspaceId) {
        events.push(ev.type);
      }
    });

    // External write under system root (bypass service)
    const notePath = path.join(ws, ".tent", "inbox", "inbox.md");
    const raw = await fs.readFile(notePath, "utf8");
    await fs.writeFile(notePath, raw + "\n<!-- external -->\n", "utf8");

    // Wait for debounced watch
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && events.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(events.length >= 1, "expected concept.changed from watch");
  });
});

test("MutationBus serializes concurrent work per workspace", async () => {
  const bus = new MutationBus();
  const order: number[] = [];
  await Promise.all([
    bus.run("w1", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
    }),
    bus.run("w1", async () => {
      order.push(3);
      order.push(4);
    }),
  ]);
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test("contentEtag stable for same content", () => {
  assert.equal(contentEtag("a\n"), contentEtag("a\n"));
  assert.notEqual(contentEtag("a\n"), contentEtag("b\n"));
});

test("defaultServiceDataDir respects TENT_SERVICE_DATA_DIR", () => {
  const dir = defaultServiceDataDir({ TENT_SERVICE_DATA_DIR: "C:\\tmp\\tent-data" } as NodeJS.ProcessEnv);
  assert.match(dir.replace(/\\/g, "/"), /tent-data$/);
});

test("service continues after client disconnect (process independent of UI)", async () => {
  // Simulate: open SSE, close it, still RPC works — closing window ≠ stop service
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    await rpc(svc, "workspace.mount", { workspaceRoot: ws });

    const ac = new AbortController();
    const sse = fetch(`${svc.url}/events`, {
      signal: ac.signal,
      headers: { "x-tent-token": svc.token },
    });
    // Give SSE a moment to connect
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    try {
      await sse;
    } catch {
      // aborted
    }

    const health = await rpc(svc, "service.health", {});
    assert.equal((health.result as { status: string }).status, "ok");
  });
});
