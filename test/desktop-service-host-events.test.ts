import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { isDesktopProjectionEventType } from "../src/desktop/main/service-host.js";
import { DesktopServiceHost } from "../src/desktop/main/service-host.js";
import type { EventEnvelope } from "../src/service/types.js";
import { refreshDesktopShellForEvent } from "../src/desktop/main/service-event-refresh.js";
import type { AttachResult } from "../src/desktop/client/service-attach.js";
import { ServiceRpcClient } from "../src/desktop/client/rpc-client.js";
import { writeServiceEndpoint } from "../src/service/data-dir.js";
import {
  recoverDesktopState,
  type DesktopRecoveryModel,
} from "../src/desktop/main/workspace-recovery.js";
import { DesktopShellModel } from "../src/desktop/workbench/shell-model.js";

test("desktop host forwards workspace and projection invalidations only", () => {
  for (const type of [
    "workspace.switched",
    "service.health",
    "node.changed",
    "task.state",
    "taskResult.updated",
    "decisionRequest.pending",
    "decisionRequest.resolved",
    "registry.roles.updated",
    "connection.changed",
  ]) {
    assert.equal(isDesktopProjectionEventType(type), true, type);
  }

  for (const type of [
    "workspace.debug",
    "session.stdout_tail",
    "session.config_options",
    "provider.log",
    "session.state",
    "toolApproval.pending",
    "taskInput.pending",
    "proposal.updated",
    "unknown.event",
  ]) {
    assert.equal(isDesktopProjectionEventType(type), false, type);
  }
});

test("desktop host coalesces identical types independently per workspace", async () => {
  const host = new DesktopServiceHost();
  const seen: Array<{ type: string; workspaceId: string }> = [];
  host.onServiceEvent((event) => seen.push(event));
  const push = (host as unknown as { handleEnvelope: (event: EventEnvelope) => void })
    .handleEnvelope.bind(host);
  const event = (workspaceId: string): EventEnvelope => ({
    id: `ev-${workspaceId}`,
    type: "node.changed",
    workspaceId,
    ts: new Date().toISOString(),
    source: "service",
    payload: {},
  });
  push(event("ws-a"));
  push(event("ws-b"));
  push(event("ws-a"));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(seen, [
    { type: "node.changed", workspaceId: "ws-a" },
    { type: "node.changed", workspaceId: "ws-b" },
  ]);
  await host.disposeShellOnly();
});

test("event stream disconnect publishes an immediate desktop-local signal", async () => {
  let disconnect!: () => void;
  const attached = {
    url: "http://127.0.0.1:4403",
    endpoint: {
      instanceId: "instance-events",
      pid: 4403,
      host: "127.0.0.1",
      port: 4403,
      startedAt: "2026-08-05T00:00:00.000Z",
      version: "0.1.0",
      token: "events-token",
    },
    started: false,
    child: null,
    client: {
      subscribeEvents(_onEvent: unknown, onError: () => void) {
        disconnect = onError;
        return { close() {} };
      },
    },
  } as unknown as AttachResult;
  const host = new DesktopServiceHost(async () => attached);
  const seen: Array<{ type: string; workspaceId: string }> = [];
  host.onServiceEvent((event) => seen.push(event));
  await host.ensureAttached();
  disconnect();
  assert.deepEqual(seen, [{ type: "service.disconnected", workspaceId: "" }]);
  assert.equal(host.client, null, "stream invalidation must discard the cached attach");
  await host.disposeShellOnly();
});

test("same-URL Service replacement discards the stale token and coalesces recovery", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-desktop-replace-"));
  const endpointA = {
    instanceId: "instance-a",
    pid: 4510,
    host: "127.0.0.1",
    port: 4510,
    startedAt: "2026-08-05T00:00:00.000Z",
    version: "0.1.0",
    token: "token-a",
  };
  const endpointB = {
    ...endpointA,
    instanceId: "instance-b",
    pid: 4511,
    startedAt: "2026-08-05T00:00:01.000Z",
    token: "token-b",
  };
  await writeServiceEndpoint(dataDir, endpointA);

  let oldSubscriptionCloses = 0;
  let oldDisconnect!: () => void;
  let newSubscriptions = 0;
  let oldAuthenticatedCalls = 0;
  const oldClient = {
    token: endpointA.token,
    url: "http://127.0.0.1:4510",
    async health() {
      // Open health already sees Service B and therefore cannot prove token A.
      return { status: "ok", ...endpointB, protocolVersion: 10, workspaceCount: 0 };
    },
    async call() {
      oldAuthenticatedCalls += 1;
      throw new Error("old token must never reach recovery RPC");
    },
    subscribeEvents(_onEvent: unknown, onError: () => void) {
      oldDisconnect = onError;
      return { close: () => (oldSubscriptionCloses += 1) };
    },
  } as unknown as ServiceRpcClient;

  let mounted = false;
  let mountCalls = 0;
  const newClient = {
    token: endpointB.token,
    url: "http://127.0.0.1:4510",
    async health() {
      return { status: "ok", ...endpointB, protocolVersion: 10, workspaceCount: 0 };
    },
    async call(method: string) {
      if (method === "service.health") {
        return { status: "ok", ...endpointB, protocolVersion: 10, workspaceCount: 0 };
      }
      if (method === "workspace.list") {
        return {
          workspaces: mounted
            ? [{
                workspaceId: "ws-remembered",
                workspaceRoot: "C:/remembered",
                tentName: "remembered",
                foreground: true,
              }]
            : [],
        };
      }
      if (method === "workspace.mount") {
        mountCalls += 1;
        mounted = true;
        return {
          workspaceId: "ws-remembered",
          workspaceRoot: "C:/remembered",
          tentName: "remembered",
          foreground: true,
        };
      }
      throw new Error(`unexpected RPC ${method}`);
    },
    subscribeEvents() {
      newSubscriptions += 1;
      return { close() {} };
    },
  } as unknown as ServiceRpcClient;

  const resultA = {
    url: oldClient.url,
    endpoint: endpointA,
    started: false,
    child: null,
    client: oldClient,
  } as AttachResult;
  const resultB = {
    url: newClient.url,
    endpoint: endpointB,
    started: false,
    child: null,
    client: newClient,
  } as AttachResult;
  let attachCalls = 0;
  const host = new DesktopServiceHost(async () => {
    attachCalls += 1;
    return attachCalls === 1 ? resultA : resultB;
  });
  await host.ensureAttached({ dataDir });

  // Service B is fully ready at the same URL before either recovery probe.
  await writeServiceEndpoint(dataDir, endpointB);
  let foregroundWorkspaceId: string | null = null;
  let rpc: ServiceRpcClient | null = null;
  const model: DesktopRecoveryModel = {
    setRpc(client) {
      rpc = client;
    },
    async refreshHealth() {
      await rpc!.health();
    },
    async refreshWorkspaces() {
      const result = await rpc!.call<{ workspaces: Array<{ workspaceId: string }> }>(
        "workspace.list",
        {}
      );
      foregroundWorkspaceId = result.workspaces[0]?.workspaceId ?? null;
    },
    getSnapshot() {
      return { foregroundWorkspaceId };
    },
    async mountWorkspace(workspaceRoot) {
      const result = await rpc!.call<{ workspaceId: string }>("workspace.mount", {
        workspaceRoot,
      });
      foregroundWorkspaceId = result.workspaceId;
    },
  };
  const recovery = {
    host,
    model,
    dataDir,
    loadPrefs: async () => ({
      recentWorkspaces: ["C:/remembered"],
      lastWorkspaceRoot: "C:/remembered",
      showFloatOnClose: true,
    }),
  };
  const [first, second] = await Promise.all([
    recoverDesktopState(recovery),
    recoverDesktopState(recovery),
  ]);

  assert.strictEqual(first, second);
  assert.equal(first.foregroundWorkspaceId, "ws-remembered");
  assert.equal(attachCalls, 2, "replacement attach must be discovered once");
  assert.equal(oldAuthenticatedCalls, 0, "stale token must not reach recovery RPC");
  assert.equal(oldSubscriptionCloses, 1);
  assert.equal(newSubscriptions, 1, "authenticated Service B events must be restored");
  assert.equal(mountCalls, 1, "remembered workspace mounts exactly once");
  oldDisconnect();
  assert.strictEqual(host.client, newClient, "late Service A close cannot clear Service B");
  await host.disposeShellOnly();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("a graceful SSE EOF is reported as a transport disconnect", async () => {
  const errors: unknown[] = [];
  const client = new ServiceRpcClient({
    baseUrl: "http://127.0.0.1:4402",
    token: "isolated-token",
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200 }
      ),
  });
  client.subscribeEvents(() => {}, (error) => errors.push(error));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /SSE stream closed/);
});

test("offline health remains publishable without a failing workspace read", async () => {
  const calls: string[] = [];
  await refreshDesktopShellForEvent(
    {
      refreshHealth: async () => {
        calls.push("health");
        return { status: "offline" };
      },
      refreshWorkspaces: async () => {
        calls.push("workspaces");
        throw new Error("must not read workspaces while offline");
      },
    },
    "service.health"
  );
  assert.deepEqual(calls, ["health"]);
});

test("desktop disconnect refreshes authoritative health without reading workspaces", async () => {
  const calls: string[] = [];
  await refreshDesktopShellForEvent(
    {
      refreshHealth: async () => {
        calls.push("health");
        return { status: "offline" };
      },
      refreshWorkspaces: async () => {
        calls.push("workspaces");
        throw new Error("must not read workspaces while disconnected");
      },
    },
    "service.disconnected"
  );
  assert.deepEqual(calls, ["health"]);
});

test("renderer invalidations never trigger retired shell collaboration reads", async () => {
  const calls: string[] = [];
  const model = {
    refreshHealth: async () => { calls.push("health"); return { status: "ok" }; },
    refreshWorkspaces: async () => { calls.push("workspaces"); },
  };
  for (const type of ["node.changed", "task.state", "taskResult.updated", "decisionRequest.pending", "session.state", "connection.changed"]) {
    assert.equal(await refreshDesktopShellForEvent(model, type), false, type);
  }
  assert.deepEqual(calls, []);
});

test("desktop bootstrap snapshot contains no Task, review, collaboration, Session, or Connection facts", () => {
  const snapshot = new DesktopShellModel().getSnapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ["foregroundWorkspaceId", "health", "workspaces"]);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ["tasks", "taskReview", "nodeCollaborations", "sessions", "connections", "taskPath", "sessionId"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("floating status refresh reads only task.list and keeps infrastructure out of its snapshot", async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const rpc = {
    url: "http://127.0.0.1:1",
    async call(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params });
      return { tasks: [{ state: "queued" }, { state: "running" }] };
    },
  } as unknown as ServiceRpcClient;
  const model = new DesktopShellModel(rpc);
  model.bindForeground("ws-a");
  await model.refreshFloatingTasks();
  assert.deepEqual(calls, [{ method: "task.list", params: { workspaceId: "ws-a" } }]);
  assert.equal(model.floatingStatus().pendingTasks, 1);
  assert.equal(model.floatingStatus().takenTasks, 1);
  assert.deepEqual(Object.keys(model.getSnapshot()).sort(), ["foregroundWorkspaceId", "health", "workspaces"]);
});

test("concurrent ensureAttached shares one attach flight and one endpoint", async () => {
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = {
    url: "http://127.0.0.1:4400",
    endpoint: { pid: 4400, port: 4400 },
    started: true,
    child: null,
    client: {
      health: async () => ({ status: "ok" }),
      subscribeEvents: () => ({ close: () => {} }),
    },
  } as unknown as AttachResult;
  const host = new DesktopServiceHost(async () => {
    calls += 1;
    await held;
    return result;
  });

  const first = host.ensureAttached({ dataDir: "C:/isolated-a" });
  const second = host.ensureAttached({ dataDir: "C:/isolated-a" });
  assert.equal(calls, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult, result);
  assert.strictEqual(secondResult, result);
  assert.strictEqual(firstResult.client, secondResult.client);
  await host.disposeShellOnly();
});

test("failed attach flight releases the single-flight gate for retry", async () => {
  let calls = 0;
  const result = {
    url: "http://127.0.0.1:4401",
    endpoint: { pid: 4401, port: 4401 },
    started: true,
    child: null,
    client: {
      health: async () => ({ status: "ok" }),
      subscribeEvents: () => ({ close: () => {} }),
    },
  } as unknown as AttachResult;
  const host = new DesktopServiceHost(async () => {
    calls += 1;
    if (calls === 1) throw new Error("isolated attach failed");
    return result;
  });

  await assert.rejects(host.ensureAttached(), /isolated attach failed/);
  assert.strictEqual(await host.ensureAttached(), result);
  assert.equal(calls, 2);
  await host.disposeShellOnly();
});
