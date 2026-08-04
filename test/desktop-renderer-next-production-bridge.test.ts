import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { handleDesktopRecoveryEvent } from "../src/desktop/renderer-next/model/desktop-recovery.js";
import {
  createDesktopServiceGateway,
  normalizeDesktopBootstrap,
  type RendererDesktopBridge,
} from "../src/desktop/renderer-next/gateway/desktop-bridge.js";
import { DesktopServiceHost } from "../src/desktop/main/service-host.js";
import type { EventEnvelope } from "../src/service/types.js";
import { shouldSeedLocalCanvas } from "../src/desktop/renderer-next/model/canvas-v5-local-persistence.js";
import { startWorkspaceProjectionBridge } from "../src/desktop/renderer-next/gateway/workspace-projection-bridge.js";
import {
  collaborationBadgeLabel,
  collaborationProjectionState,
  collaborationSummary,
  type WorkbenchNodeView,
} from "../src/desktop/renderer-next/shell/workbench-types.js";
import { InspectorPanel } from "../src/desktop/renderer-next/components/InspectorPanel.js";
import { OutlinePanel } from "../src/desktop/renderer-next/components/OutlinePanel.js";
import { StatusBar } from "../src/desktop/renderer-next/components/StatusBar.js";
import { projectionForConnection, workspaceProjectionStatus } from "../src/desktop/renderer-next/model/workspace-projection-view.js";
import type { GraphProjection } from "../src/service/types.js";
import { createEmptyCanvasDocument } from "../src/desktop/renderer-next/types/identity.js";
import { workbenchNodesFromResources } from "../src/desktop/renderer-next/model/workbench-nodes.js";
import { ConnectionBanner } from "../src/desktop/renderer-next/components/ConnectionBanner.js";
import { seedCanvasDocumentFromGraph } from "../src/desktop/renderer-next/model/canvas-seeding.js";

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

test("initial Canvas seed materializes only the first authoritative Node", () => {
  const graph = {
    workspaceId: "ws-a",
    nodes: [
      { nodeId: "cx-first", path: "first", name: "first", type: "goal", tags: [], mode: "editable", archived: false, invalid: false },
      { nodeId: "cx-second", path: "second", name: "second", type: "prompt", tags: [], mode: "editable", archived: false, invalid: false },
    ],
    edges: { parent: [], markdown: [], wiki: [], relation: [] },
  } as unknown as GraphProjection;
  const seeded = seedCanvasDocumentFromGraph(graph);
  assert.deepEqual(seeded.placements.map((placement) => placement.entityRef), ["cx-first"]);
  assert.equal(seeded.focusedPlacementId, "pl-default-cx-first");
});

test("Outline keeps every authoritative Node even when Canvas has no placement", () => {
  const graph = {
    workspaceId: "ws-a",
    nodes: [
      { nodeId: "cx-placed", path: "placed", name: "placed", type: "goal", tags: [], mode: "editable", archived: false, invalid: false },
      { nodeId: "cx-unplaced", path: "unplaced", name: "unplaced", type: "prompt", tags: [], mode: "editable", archived: false, invalid: false },
    ],
    edges: { parent: [], markdown: [], wiki: [], relation: [] },
  } as unknown as GraphProjection;
  const nodes = workbenchNodesFromResources(
    { state: "ready", workspaceId: "ws-a", value: graph, fetchedAt: "now" },
    {
      state: "ready",
      workspaceId: "ws-a",
      value: {
        workspaceId: "ws-a",
        items: ["cx-placed", "cx-unplaced"].map((nodeId) => ({
          workspaceId: "ws-a",
          nodeId,
          activeTask: null,
        })),
      },
      fetchedAt: "now",
    },
    {
      ...createEmptyCanvasDocument(),
      placements: [{ placementId: "pl-placed", entityRef: "cx-placed", kind: "node" }],
    }
  );
  assert.deepEqual(nodes.map((node) => node.nodeId), ["cx-placed", "cx-unplaced"]);
  const outline = renderToStaticMarkup(createElement(OutlinePanel, {
    nodes: [{ ...nodes[1]!, depth: 2 }],
    projection: "fresh",
    selectedNodeId: "cx-unplaced",
    onSelectNode: () => {},
    onCollapse: () => {},
  }));
  assert.match(outline, /aria-level="3"/);
});

test("Focus renders externally controlled placement state without inventing a second owner", () => {
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
    collaborationState: "ready",
    activeTaskState: null,
  } satisfies WorkbenchNodeView;
  const unplaced = renderToStaticMarkup(createElement(InspectorPanel, {
    node,
    placementState: "unplaced",
    canCreatePlacement: true,
    onPlaceNode: () => {},
    onRemoveNode: () => {},
    onCollapse: () => {},
  }));
  assert.match(unplaced, /尚未放入画布/);
  assert.match(unplaced, /放入画布/);

  const placed = renderToStaticMarkup(createElement(InspectorPanel, {
    node,
    placementState: "placed",
    canCreatePlacement: true,
    onPlaceNode: () => {},
    onRemoveNode: () => {},
    onCollapse: () => {},
  }));
  assert.match(placed, /已放入当前画布/);
  assert.match(placed, /从画布移除/);
});

test("placement creation fails closed while stale and reconnecting exposes one retry", () => {
  const node = {
    nodeId: "cx-a",
    path: "A",
    name: "A",
    type: "goal",
    tags: [],
    mode: "editable",
    archived: false,
    invalid: false,
    projectionState: "stale",
    collaborationState: "stale",
  } satisfies WorkbenchNodeView;
  const focus = renderToStaticMarkup(createElement(InspectorPanel, {
    node,
    placementState: "unplaced",
    canCreatePlacement: false,
    onPlaceNode: () => {},
    onRemoveNode: () => {},
    onCollapse: () => {},
  }));
  assert.match(focus, /权威节点恢复后才能创建本地位置/);
  assert.match(focus, /<button[^>]*disabled=""[^>]*>放入画布<\/button>/);

  const banner = renderToStaticMarkup(createElement(ConnectionBanner, {
    connection: "reconnecting",
    onRetry: () => {},
  }));
  assert.equal((banner.match(/重试连接/g) ?? []).length, 1);
  assert.doesNotMatch(banner, /disabled/);
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
  invalidation!({ keys: ["service.health"], event: { workspaceId: "" } });
  assert.equal(reads, 3, "global health recovery schedules a named projection reread");
  releaseInitial();
  await initialRead;
  stop();
  assert.equal(started, false);
  assert.equal(invalidation, null);
});

test("desktop disconnect becomes reconnecting before held bootstrap recovery", async () => {
  const states: string[] = [];
  let release!: () => void;
  const heldRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;

  const pending = handleDesktopRecoveryEvent(
    "service.disconnected",
    (connection) => states.push(connection),
    async () => {
      reads += 1;
      await heldRead;
      states.push("online");
    }
  );

  assert.ok(pending);
  assert.deepEqual(states, ["reconnecting"]);
  assert.equal(reads, 1);
  release();
  await pending;
  assert.deepEqual(states, ["reconnecting", "online"]);
});

test("initial projection loading/error stays distinct from authoritative ready-empty", () => {
  const emptyGraph = {
    workspaceId: "ws-a",
    nodes: [],
    edges: { parent: [], markdown: [], wiki: [], relation: [] },
  } as unknown as GraphProjection;
  assert.equal(workspaceProjectionStatus({ state: "idle" }, []), "loading");
  assert.equal(
    workspaceProjectionStatus({ state: "loading", workspaceId: "ws-a" }, []),
    "loading"
  );
  assert.equal(
    workspaceProjectionStatus({ state: "error", workspaceId: "ws-a", issue: { kind: "transport", message: "offline" }, failedAt: "now" }, []),
    "error"
  );
  assert.equal(
    workspaceProjectionStatus({ state: "ready", workspaceId: "ws-a", value: emptyGraph, fetchedAt: "now" }, []),
    "fresh"
  );
  assert.equal(
    workspaceProjectionStatus(
      projectionForConnection(
        { state: "ready", workspaceId: "ws-a", value: emptyGraph, fetchedAt: "now" },
        "ws-a",
        "offline"
      ),
      []
    ),
    "stale",
    "cached ready data becomes stale when transport authority is offline"
  );

  const outlineProps = {
    nodes: [],
    selectedNodeId: null,
    onSelectNode: () => {},
    onCollapse: () => {},
  };
  const loading = renderToStaticMarkup(
    createElement(OutlinePanel, { ...outlineProps, projection: "loading" })
  ) + renderToStaticMarkup(
    createElement(StatusBar, { connection: "connecting", projection: "loading", nodeCount: 0 })
  );
  assert.match(loading, /正在加载节点/);
  assert.match(loading, /正在读取投影/);
  assert.doesNotMatch(loading, /还没有节点|投影已同步/);

  const failed = renderToStaticMarkup(
    createElement(OutlinePanel, { ...outlineProps, projection: "error" })
  );
  assert.match(failed, /节点加载失败/);
  assert.doesNotMatch(failed, /还没有节点/);

  const staleEmpty = renderToStaticMarkup(
    createElement(OutlinePanel, { ...outlineProps, projection: "stale" })
  );
  assert.match(staleEmpty, /节点状态已过期/);
  assert.doesNotMatch(staleEmpty, /还没有节点/);

  const readyEmpty = renderToStaticMarkup(
    createElement(OutlinePanel, { ...outlineProps, projection: "fresh" })
  ) + renderToStaticMarkup(
    createElement(StatusBar, { connection: "online", projection: "fresh", nodeCount: 0 })
  );
  assert.match(readyEmpty, /还没有节点/);
  assert.match(readyEmpty, /投影已同步/);
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

test("client-visible session.state crosses the desktop host into renderer invalidation", async () => {
  const host = new DesktopServiceHost();
  const bridge: RendererDesktopBridge = {
    getState: async () => state(),
    rpc: async () => ({ workspaceId: "ws-a", nodes: [], edges: {} }),
    onStateChanged: () => () => {},
    // This has the same narrow `{ type, workspaceId }` contract exposed by
    // preload. The host remains responsible for event filtering/debouncing.
    onServiceEvent: (handler) => host.onServiceEvent(handler),
  };
  const gateway = createDesktopServiceGateway(bridge);
  const hints: Array<readonly string[]> = [];
  gateway.onInvalidation((hint) => hints.push(hint.keys));
  gateway.startEventBridge();

  const push = (host as unknown as {
    handleEnvelope: (event: EventEnvelope) => void;
  }).handleEnvelope.bind(host);
  push({
    id: "ev-session-state",
    type: "session.state",
    workspaceId: "ws-a",
    ts: new Date().toISOString(),
    source: "service",
    payload: {},
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(hints.length, 1);
  assert.ok(hints[0]!.includes("node.collaborations"));
  assert.ok(hints[0]!.includes("output.provenance"));

  gateway.stopEventBridge();
  await host.disposeShellOnly();
});
