import assert from "node:assert/strict";
import { test } from "node:test";
import { isDesktopProjectionEventType } from "../src/desktop/main/service-host.js";
import { DesktopServiceHost } from "../src/desktop/main/service-host.js";
import type { EventEnvelope } from "../src/service/types.js";
import { refreshDesktopShellForEvent } from "../src/desktop/main/service-event-refresh.js";
import type { AttachResult } from "../src/desktop/client/service-attach.js";
import { ServiceRpcClient } from "../src/desktop/client/rpc-client.js";

test("desktop host forwards workspace and projection invalidations only", () => {
  for (const type of [
    "workspace.switched",
    "service.health",
    "node.changed",
    "task.state",
    "delivery.updated",
    "session.state",
  ]) {
    assert.equal(isDesktopProjectionEventType(type), true, type);
  }

  for (const type of [
    "workspace.debug",
    "session.stdout_tail",
    "session.config_options",
    "provider.log",
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
  const host = new DesktopServiceHost();
  const seen: Array<{ type: string; workspaceId: string }> = [];
  host.onServiceEvent((event) => seen.push(event));
  (host as unknown as { handleEventStreamClosed: () => void }).handleEventStreamClosed();
  assert.deepEqual(seen, [{ type: "service.disconnected", workspaceId: "" }]);
  await host.disposeShellOnly();
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
      refreshTasks: async () => {
        calls.push("tasks");
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
      refreshTasks: async () => {
        calls.push("tasks");
      },
    },
    "service.disconnected"
  );
  assert.deepEqual(calls, ["health"]);
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
