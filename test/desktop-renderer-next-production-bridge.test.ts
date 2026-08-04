import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDesktopServiceGateway,
  normalizeDesktopBootstrap,
  type RendererDesktopBridge,
} from "../src/desktop/renderer-next/gateway/desktop-bridge.js";
import { shouldSeedLocalCanvas } from "../src/desktop/renderer-next/model/canvas-v5-local-persistence.js";
import { startWorkspaceProjectionBridge } from "../src/desktop/renderer-next/gateway/workspace-projection-bridge.js";

function state(workspaceId = "ws-a") {
  return {
    health: { status: "ok", protocolVersion: 4 },
    foregroundWorkspaceId: workspaceId,
    workspaces: [
      {
        workspaceId,
        workspaceRoot: `C:/work/${workspaceId}`,
        tentName: "Tent",
        foreground: true,
      },
    ],
  };
}

test("production bootstrap requires protocol 4 and exact foreground identity", () => {
  const normalized = normalizeDesktopBootstrap(state());
  assert.equal(normalized.protocolVersion, 4);
  assert.equal(normalized.foregroundWorkspace?.workspaceId, "ws-a");

  assert.throws(() =>
    normalizeDesktopBootstrap({
      ...state(),
      health: { status: "ok", protocolVersion: 3 },
    })
  );
  assert.throws(() =>
    normalizeDesktopBootstrap({ ...state(), foregroundWorkspaceId: "ws-missing" })
  );

  const unmounted = normalizeDesktopBootstrap({
    health: { status: "ok", protocolVersion: 4 },
    foregroundWorkspaceId: null,
    workspaces: [],
  });
  assert.equal(unmounted.foregroundWorkspace, null);
});

test("first non-empty graph seeds only a truly absent local Canvas", () => {
  assert.equal(shouldSeedLocalCanvas("empty", 0, 0), false);
  assert.equal(shouldSeedLocalCanvas("empty", 0, 1), true);
  assert.equal(shouldSeedLocalCanvas("loaded", 0, 1), false);
  assert.equal(shouldSeedLocalCanvas("error", 0, 1), false);
  assert.equal(shouldSeedLocalCanvas("unavailable", 0, 1), false);
  assert.equal(shouldSeedLocalCanvas("empty", 1, 1), false);
});

test("projection events during the held initial read schedule a newer read", async () => {
  let invalidation:
    | ((hint: {
        keys: readonly string[];
        event?: { workspaceId?: string };
      }) => void)
    | null = null;
  let started = false;
  let reads = 0;
  let releaseInitial!: () => void;
  const initialRead = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const gateway = {
    onInvalidation(handler: typeof invalidation) {
      invalidation = handler;
      return () => {
        invalidation = null;
      };
    },
    startEventBridge() {
      started = true;
    },
    stopEventBridge() {
      started = false;
    },
  };
  const refresh = async () => {
    reads += 1;
    if (reads === 1) await initialRead;
  };

  const stop = startWorkspaceProjectionBridge(
    gateway as Parameters<typeof startWorkspaceProjectionBridge>[0],
    "ws-a",
    refresh
  );
  assert.equal(started, true);
  assert.equal(reads, 1);
  invalidation!({ keys: ["graph.projection"], event: { workspaceId: "ws-a" } });
  assert.equal(reads, 2);
  releaseInitial();
  await initialRead;
  stop();
  assert.equal(started, false);
  assert.equal(invalidation, null);
});

test("desktop event payload is invalidation only and named RPC stays closed", async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let serviceEvent: ((event: { type: string; workspaceId?: string }) => void) | null = null;
  const bridge: RendererDesktopBridge = {
    getState: async () => state(),
    rpc: async (method, params) => {
      calls.push({ method, params });
      return {
        workspaceId: "ws-a",
        nodes: [],
        edges: { parent: [], markdown: [], wiki: [], relation: [] },
      };
    },
    onStateChanged: () => () => {},
    onServiceEvent: (handler) => {
      serviceEvent = handler;
      return () => {
        serviceEvent = null;
      };
    },
  };
  const gateway = createDesktopServiceGateway(bridge);
  const reasons: string[] = [];
  gateway.onInvalidation((hint) => reasons.push(hint.reason ?? ""));
  gateway.startEventBridge();
  serviceEvent!({ type: "node.changed", workspaceId: "ws-a" });
  assert.deepEqual(reasons, ["node.changed"]);

  const read = await gateway.graphProjection("ws-a");
  assert.equal(read.ok, true);
  assert.deepEqual(calls, [
    { method: "graph.projection", params: { workspaceId: "ws-a" } },
  ]);
  gateway.stopEventBridge();
  assert.equal(serviceEvent, null);
});
