import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createDesktopServiceGateway,
  normalizeDesktopBootstrap,
  type RendererDesktopBridge,
} from "../src/desktop/renderer-next/gateway/desktop-bridge.js";
import { shouldSeedLocalCanvas } from "../src/desktop/renderer-next/model/canvas-v5-local-persistence.js";
import { startWorkspaceProjectionBridge } from "../src/desktop/renderer-next/gateway/workspace-projection-bridge.js";
import {
  collaborationBadgeLabel,
  collaborationProjectionState,
  collaborationSummary,
  type WorkbenchNodeView,
} from "../src/desktop/renderer-next/shell/workbench-types.js";
import { InspectorPanel } from "../src/desktop/renderer-next/components/InspectorPanel.js";

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

test("non-ready collaboration never becomes a confirmed idle claim", () => {
  const node = {
    nodeId: "cx-a",
    path: "A",
    name: "A",
    type: "goal",
    tags: [],
    mode: "editable",
    archived: false,
    invalid: false,
    projectionState: "ready",
    activeTaskState: undefined,
  } satisfies WorkbenchNodeView;

  const loading = {
    ...node,
    collaborationState: collaborationProjectionState("loading"),
  } satisfies WorkbenchNodeView;
  assert.equal(collaborationBadgeLabel(loading), "正在刷新");
  assert.doesNotMatch(collaborationSummary(loading), /空闲|没有进行中的任务/);
  assert.doesNotMatch(
    renderToStaticMarkup(
      createElement(InspectorPanel, { node: loading, onCollapse: () => {} })
    ),
    /空闲|没有进行中的任务/
  );

  const failed = {
    ...node,
    collaborationState: collaborationProjectionState("error"),
  } satisfies WorkbenchNodeView;
  assert.equal(collaborationBadgeLabel(failed), "状态未知");
  assert.doesNotMatch(collaborationSummary(failed), /空闲|没有进行中的任务/);
  assert.doesNotMatch(
    renderToStaticMarkup(
      createElement(InspectorPanel, { node: failed, onCollapse: () => {} })
    ),
    /空闲|没有进行中的任务/
  );

  const idle = {
    ...node,
    collaborationState: collaborationProjectionState("ready"),
    activeTaskState: null,
  } satisfies WorkbenchNodeView;
  assert.equal(collaborationBadgeLabel(idle), "空闲");
  assert.match(collaborationSummary(idle), /没有进行中的任务/);
  assert.match(
    renderToStaticMarkup(
      createElement(InspectorPanel, { node: idle, onCollapse: () => {} })
    ),
    /空闲/
  );
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
