import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleDesktopInboxRequest,
  normalizeDesktopInboxSnapshot,
  type DesktopInboxSnapshot,
} from "../src/desktop/inbox-ipc.js";
import {
  createDesktopServiceGateway,
  type RendererDesktopBridge,
} from "../src/desktop/renderer-next/gateway/desktop-bridge.js";
import { invalidationFromEvent } from "../src/desktop/renderer-next/gateway/service-gateway.js";
import { InboxController } from "../src/desktop/renderer-next/model/inbox-controller.js";
import { isDesktopProjectionMethod, invokeDesktopProjectionRpc } from "../src/desktop/projection-ipc.js";
import type { ProjectionRead } from "../src/desktop/renderer-next/gateway/workspace-projections.js";
import type { InvalidationHint } from "../src/desktop/renderer-next/gateway/service-gateway.js";

function rawPending(workspaceId = "ws-a", overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    items: [
      {
        id: "interaction-1",
        kind: "delivery",
        workspaceId,
        createdAt: "2026-08-09T00:00:00.000Z",
        path: "nodes/never-a-node-id.md",
        title: "Never infer this title as an id",
        sourceNodeId: "node-authoritative",
      },
    ],
    counts: { decisionRequest: 0, toolApproval: 0, delivery: 1, total: 1 },
    ...overrides,
  };
}

function ready(workspaceId: string, id = "interaction-1"): ProjectionRead<DesktopInboxSnapshot> {
  return {
    ok: true,
    workspaceId,
    value: normalizeDesktopInboxSnapshot(rawPending(workspaceId, {
      items: [{
        id,
        kind: "delivery",
        workspaceId,
        createdAt: "2026-08-09T00:00:00.000Z",
        sourceNodeId: "node-authoritative",
      }],
    }), workspaceId),
    fetchedAt: new Date().toISOString(),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function eventFor(workspaceId: string) {
  return {
    id: `event-${workspaceId}`,
    type: "interaction.pending",
    workspaceId,
    ts: "2026-08-09T00:00:00.000Z",
    source: "service" as const,
    payload: {},
  };
}

function bridgeWithInbox(read: (workspaceId: string) => Promise<unknown>): RendererDesktopBridge {
  return {
    getState: async () => ({}),
    rpc: async () => {
      throw new Error("generic projection RPC must not be used by Inbox");
    },
    listPendingInteractions: read as (workspaceId: string) => Promise<DesktopInboxSnapshot>,
    document: async () => ({ ok: false, error: { kind: "transport", message: "unused" } }),
    onStateChanged: () => () => {},
    onServiceEvent: () => () => {},
  };
}

test("named Inbox bridge calls only interaction.listPending and strips the domain bag", async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const snapshot = await handleDesktopInboxRequest(() => ({
    call: async (method, params) => {
      calls.push({ method, params });
      return rawPending();
    },
  }), "ws-a");

  assert.deepEqual(calls, [{ method: "interaction.listPending", params: { workspaceId: "ws-a" } }]);
  assert.deepEqual(snapshot, {
    workspaceId: "ws-a",
    count: 1,
    items: [{
      id: "interaction-1",
      kind: "delivery",
      createdAt: "2026-08-09T00:00:00.000Z",
      summary: "Delivery ready for review",
      sourceNodeId: "node-authoritative",
    }],
  });
  assert.equal("path" in snapshot.items[0]!, false);
  assert.equal("title" in snapshot.items[0]!, false);
});

test("main Inbox request validates workspace before touching the lazy client getter", async () => {
  let accesses = 0;
  const client = {
    call: async () => rawPending(),
  };
  const host = new Proxy({} as { client: typeof client }, {
    get(_target, property) {
      if (property === "client") accesses += 1;
      return client;
    },
  });

  await assert.rejects(
    handleDesktopInboxRequest(() => host.client, "  "),
    /workspaceId is required/
  );
  assert.equal(accesses, 0);

  await handleDesktopInboxRequest(() => host.client, "ws-a");
  assert.equal(accesses, 1);
});

test("forbidden generic projection calls remain rejected before the client getter", async () => {
  let getterCalls = 0;
  assert.equal(isDesktopProjectionMethod("interaction.listPending"), false);
  await assert.rejects(
    invokeDesktopProjectionRpc(() => {
      getterCalls += 1;
      return { call: async () => ({}) };
    }, "interaction.listPending"),
    /Unsupported desktop projection method/
  );
  assert.equal(getterCalls, 0);
});

test("corrupt and mismatched workspace responses fail closed in the renderer gateway", async () => {
  const corrupt = createDesktopServiceGateway(
    bridgeWithInbox(async () => ({ ...rawPending(), workspaceId: "ws-other" }))
  );
  const mismatch = await corrupt.pendingInteractions("ws-a");
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.ok ? "" : mismatch.issue.kind, "corrupt");

  const counts = createDesktopServiceGateway(
    bridgeWithInbox(async () => rawPending("ws-a", {
      counts: { decisionRequest: 0, toolApproval: 0, delivery: 0, total: 0 },
    }))
  );
  const badCounts = await counts.pendingInteractions("ws-a");
  assert.equal(badCounts.ok, false);
  assert.equal(badCounts.ok ? "" : badCounts.issue.kind, "corrupt");
});

test("same workspace reads coalesce exactly while other workspaces stay independent", async () => {
  const releaseA = deferred<void>();
  const releaseB = deferred<void>();
  let calls = 0;
  const gateway = createDesktopServiceGateway(
    bridgeWithInbox(async (workspaceId) => {
      calls += 1;
      if (workspaceId === "ws-a") await releaseA.promise;
      if (workspaceId === "ws-b") await releaseB.promise;
      return rawPending(workspaceId);
    })
  );

  const firstA = gateway.pendingInteractions("ws-a");
  const secondA = gateway.pendingInteractions("ws-a");
  const firstB = gateway.pendingInteractions("ws-b");
  assert.strictEqual(firstA, secondA);
  assert.notStrictEqual(firstA, firstB);
  assert.equal(calls, 2);
  releaseA.resolve();
  releaseB.resolve();
  assert.equal((await firstA).ok, true);
  assert.equal((await firstB).ok, true);
});

test("controller subscribes before its first read and rereads after an event race", async () => {
  let onInvalidation: ((hint: InvalidationHint) => void) | null = null;
  const firstRead = deferred<void>();
  let reads = 0;
  const controller = new InboxController({
    onInvalidation(handler) {
      onInvalidation = handler;
      return () => { onInvalidation = null; };
    },
    async pendingInteractions(workspaceId) {
      reads += 1;
      if (reads === 1) {
        // Simulate an SSE delivery during the first transport call itself.
        onInvalidation!({ keys: ["pending.interactions"], event: eventFor("ws-a") });
        await firstRead.promise;
      }
      return ready(workspaceId, `interaction-${reads}`);
    },
  });

  controller.select("ws-a");
  await flush();
  assert.equal(reads, 1);
  assert.ok(onInvalidation, "subscription must exist before the first read");
  assert.equal(reads, 1, "the event queues a reread behind the held first read");
  firstRead.resolve();
  await flush();
  await flush();
  assert.equal(reads, 2);
  assert.equal(controller.getView().state, "ready");
  controller.dispose();
});

test("workspace switch discards held A and authoritatively reads B", async () => {
  const releaseA = deferred<void>();
  const reads: string[] = [];
  const controller = new InboxController({
    onInvalidation: () => () => {},
    async pendingInteractions(workspaceId) {
      reads.push(workspaceId);
      if (workspaceId === "ws-a") await releaseA.promise;
      return ready(workspaceId, `interaction-${workspaceId}`);
    },
  });

  controller.select("ws-a");
  await flush();
  assert.deepEqual(reads, ["ws-a"]);
  controller.select("ws-b");
  const loading = controller.getView();
  assert.equal(loading.state, "loading");
  if (loading.state !== "loading") throw new Error("workspace B did not start loading");
  assert.equal(loading.workspaceId, "ws-b");
  assert.equal("snapshot" in loading, false);

  releaseA.resolve();
  await flush();
  await flush();
  assert.deepEqual(reads, ["ws-a", "ws-b"]);
  const view = controller.getView();
  assert.equal(view.state, "ready");
  if (view.state !== "ready") throw new Error("workspace B did not become ready");
  assert.equal(view.workspaceId, "ws-b");
  assert.equal(view.snapshot.workspaceId, "ws-b");
  assert.equal(view.snapshot.items[0]?.id, "interaction-ws-b");
  controller.dispose();
});

test("known content is retained only as explicitly stale after a failed reread", async () => {
  let onInvalidation: ((hint: InvalidationHint) => void) | null = null;
  let reads = 0;
  const controller = new InboxController({
    onInvalidation(handler) {
      onInvalidation = handler;
      return () => { onInvalidation = null; };
    },
    async pendingInteractions(workspaceId) {
      reads += 1;
      if (reads === 1) return ready(workspaceId);
      return {
        ok: false,
        workspaceId,
        issue: { kind: "transport", message: "service disconnected" },
        failedAt: new Date().toISOString(),
      };
    },
  });

  controller.select("ws-a");
  await flush();
  await flush();
  assert.equal(controller.getView().state, "ready");
  onInvalidation!({ keys: ["pending.interactions"], event: eventFor("ws-a") });
  await flush();
  await flush();
  const stale = controller.getView();
  assert.equal(stale.state, "stale");
  assert.equal(stale.state === "stale" ? stale.snapshot.items[0]?.id : "", "interaction-1");
  assert.equal(stale.state === "stale" ? stale.issue.kind : "", "transport");
  controller.dispose();
});

test("initial loading and failure expose no inbox content", async () => {
  const held = deferred<void>();
  const controller = new InboxController({
    onInvalidation: () => () => {},
    async pendingInteractions(workspaceId) {
      await held.promise;
      return {
        ok: false,
        workspaceId,
        issue: { kind: "transport", message: "offline" },
        failedAt: new Date().toISOString(),
      };
    },
  });
  controller.select("ws-a");
  await flush();
  assert.equal(controller.getView().state, "loading");
  assert.equal("snapshot" in controller.getView(), false);
  held.resolve();
  await flush();
  await flush();
  assert.equal(controller.getView().state, "error");
  assert.equal("snapshot" in controller.getView(), false);
  controller.dispose();
});

test("session-state invalidation includes the Inbox projection", () => {
  const hint = invalidationFromEvent({
    id: "session-state",
    type: "session.state",
    workspaceId: "ws-a",
    ts: "2026-08-09T00:00:00.000Z",
    source: "service",
    payload: {},
  });
  assert.ok(hint.keys.includes("pending.interactions"));
});

test("an absent authoritative source Node id stays absent", () => {
  const snapshot = normalizeDesktopInboxSnapshot(rawPending("ws-a", {
    items: [{
      id: "delivery-without-node",
      kind: "delivery",
      workspaceId: "ws-a",
      createdAt: "2026-08-09T00:00:00.000Z",
      path: "nodes/looks-like-an-id.md",
      title: "looks-like-a-node-id",
    }],
  }), "ws-a");
  assert.deepEqual(snapshot.items[0], {
    id: "delivery-without-node",
    kind: "delivery",
    createdAt: "2026-08-09T00:00:00.000Z",
    summary: "Delivery ready for review",
  });
  assert.equal("sourceNodeId" in snapshot.items[0]!, false);
});
