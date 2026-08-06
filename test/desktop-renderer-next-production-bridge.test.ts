import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
import {
  CanvasV5LocalPersistence,
  shouldSeedLocalCanvas,
  type CanvasV5LocalSnapshot,
} from "../src/desktop/renderer-next/model/canvas-v5-local-persistence.js";
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
import {
  reconcileLoadedCanvasDocument,
  seedCanvasDocumentFromGraph,
} from "../src/desktop/renderer-next/model/canvas-seeding.js";
import { FocusDocumentPanel } from "../src/desktop/renderer-next/components/FocusDocumentPanel.js";
import type { FocusDocumentActions, FocusDocumentView } from "../src/desktop/renderer-next/model/focus-document-controller.js";
import { canvasPlacementSourceAuthority } from "../src/desktop/renderer-next/shell/workbench-presentation.js";
import {
  updateOutlineExpansion,
  visibleOutlineNodes,
} from "../src/desktop/renderer-next/model/outline-tree.js";

function state(workspaceId = "ws-a") {
  return {
    health: { status: "ok", protocolVersion: 5 },
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

const noDocumentActions: FocusDocumentActions = {
  beginEdit() {},
  updateBody() {},
  async save() {},
  discard() {},
  loadDisk() {},
  async overwriteWithLocal() {},
  async retry() {},
};

test("production bootstrap requires protocol 5 and exact foreground identity", () => {
  const normalized = normalizeDesktopBootstrap(state());
  assert.equal(normalized.protocolVersion, 5);
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
    health: { status: "ok", protocolVersion: 5 },
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

test("Canvas persistence retry commits the latest local snapshot", async () => {
  let failWrite = true;
  let stored: string | null = null;
  const persistence = new CanvasV5LocalPersistence(
    {
      getItem: () => stored,
      setItem: (_key, value) => {
        if (failWrite) throw new Error("quota exceeded");
        stored = value;
      },
    },
    "ws-a"
  );
  let current: CanvasV5LocalSnapshot = {
    version: 1,
    workspaceId: "ws-a",
    document: {
      ...createEmptyCanvasDocument(),
      viewport: { x: 10, y: 20, zoom: 1 },
    },
    scene: null,
  };
  const retry = { current: null as (() => void) | null };
  const attempt = () => {
    const result = persistence.beginSave(current).commit();
    retry.current = "retry" in result ? attempt : null;
    return result;
  };
  const invokeRetry = () => {
    const callback = retry.current;
    assert.ok(callback);
    callback();
  };

  const failed = attempt();
  assert.equal(failed.kind, "error");
  assert.equal(stored, null);
  assert.ok(retry.current);

  current = {
    ...current,
    document: {
      ...current.document,
      viewport: { x: 80, y: 90, zoom: 1.25 },
    },
  };
  failWrite = false;
  invokeRetry();
  assert.equal(retry.current, null);

  const loaded = persistence.load();
  assert.equal(loaded.kind, "loaded");
  assert.deepEqual(loaded.snapshot.document.viewport, {
    x: 80,
    y: 90,
    zoom: 1.25,
  });

  stored = null;
  failWrite = true;
  current = {
    ...current,
    document: {
      ...current.document,
      viewport: { x: 100, y: 110, zoom: 1 },
    },
  };
  assert.equal(attempt().kind, "error");
  current = {
    ...current,
    document: {
      ...current.document,
      viewport: { x: 200, y: 210, zoom: 1.5 },
    },
  };
  assert.ok(retry.current);
  invokeRetry();
  assert.ok(retry.current);
  assert.equal(stored, null);

  current = {
    ...current,
    document: {
      ...current.document,
      viewport: { x: 300, y: 310, zoom: 2 },
    },
  };
  failWrite = false;
  invokeRetry();
  assert.equal(retry.current, null);
  const loadedAfterRepeatedFailure = persistence.load();
  assert.equal(loadedAfterRepeatedFailure.kind, "loaded");
  assert.deepEqual(loadedAfterRepeatedFailure.snapshot.document.viewport, {
    x: 300,
    y: 310,
    zoom: 2,
  });

  const production = await readFile(
    new URL("../src/desktop/renderer-next/ProductionApp.tsx", import.meta.url),
    "utf8"
  );
  const commitBlock = production.slice(
    production.indexOf("const commitSnapshot"),
    production.indexOf("const scheduleSnapshot")
  );
  assert.match(commitBlock, /beginSave\(snapshotRef\.current\)\.commit\(\)/);
  assert.match(commitBlock, /retrySave\.current = "retry" in result \? attempt : null/);
  assert.doesNotMatch(commitBlock, /result\.retry\(\)|retried\.retry\(\)/);
});

test("initial Canvas seed materializes only the first authoritative Node", () => {
  const graph = {
    workspaceId: "ws-a",
    nodes: [
      { nodeId: "cx-first", etag: "etag-first", path: "first", name: "first", type: "goal", tags: [], mode: "editable", archived: false, invalid: false },
      { nodeId: "cx-second", etag: "etag-second", path: "second", name: "second", type: "prompt", tags: [], mode: "editable", archived: false, invalid: false },
    ],
    edges: { parent: [], markdown: [], wiki: [], relation: [] },
  } as unknown as GraphProjection;
  const seeded = seedCanvasDocumentFromGraph(graph);
  assert.deepEqual(seeded.placements.map((placement) => placement.entityRef), ["cx-first"]);
  assert.equal(seeded.focusedPlacementId, "pl-default-cx-first");
});

test("storage retry immediately materializes legacy snapshots from an already-ready graph", () => {
  const graph = {
    workspaceId: "ws-a",
    nodes: [
      { nodeId: "cx-first", etag: "etag-first", path: "first", name: "first", type: "goal", tags: ["live"], mode: "editable", archived: false, invalid: false },
    ],
    edges: { parent: [], markdown: [], wiki: [], relation: [] },
  } as unknown as GraphProjection;
  const legacy = {
    ...createEmptyCanvasDocument(),
    placements: [
      {
        placementId: "pl-legacy",
        entityRef: "cx-first",
        kind: "node",
        x: 80,
        y: 90,
      },
    ],
  };
  const reconciled = reconcileLoadedCanvasDocument("loaded", legacy, graph);
  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.seeded, true);
  assert.deepEqual(
    (reconciled.document.placements[0]?.meta as Record<string, unknown>)
      ?.tentNodeSnapshot,
    {
      version: 1,
      nodeId: "cx-first",
      name: "first",
      path: "first",
      type: "goal",
      tags: ["live"],
      mode: "editable",
      archived: false,
      invalid: false,
      etag: "etag-first",
    }
  );
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
  assert.deepEqual(nodes.map((node) => [node.parentNodeId, node.hasChildren]), [
    [null, false],
    [null, false],
  ]);
  const outline = renderToStaticMarkup(createElement(OutlinePanel, {
    nodes: [{ ...nodes[1]!, depth: 2 }],
    projection: "fresh",
    selectedNodeId: "cx-unplaced",
    onSelectNode: () => {},
    onCollapse: () => {},
  }));
  assert.match(outline, /aria-level="3"/);
});

test("Outline tree collapse hides descendants and atomically selects the collapsed parent", () => {
  const base = {
    etag: "etag",
    tags: [] as string[],
    mode: "editable" as const,
    archived: false,
    invalid: false,
    projectionState: "ready" as const,
  };
  const nodes: WorkbenchNodeView[] = [
    { ...base, nodeId: "root", path: "root", name: "Root", type: "goal", parentNodeId: null, hasChildren: true, depth: 0 },
    { ...base, nodeId: "child", path: "child", name: "Child", type: "prompt", parentNodeId: "root", hasChildren: true, depth: 1 },
    { ...base, nodeId: "leaf", path: "leaf", name: "Leaf", type: "output", parentNodeId: "child", hasChildren: false, depth: 2 },
  ];
  const expanded = new Set(["root", "child"]);
  assert.deepEqual(visibleOutlineNodes(nodes, expanded).map((node) => node.nodeId), ["root", "child", "leaf"]);
  const collapsed = updateOutlineExpansion({
    nodes,
    expandedNodeIds: expanded,
    nodeId: "root",
    expanded: false,
    selectedNodeId: "leaf",
  });
  assert.equal(collapsed.selectedNodeId, "root");
  assert.deepEqual(visibleOutlineNodes(nodes, collapsed.expandedNodeIds).map((node) => node.nodeId), ["root"]);

  const markup = renderToStaticMarkup(createElement(OutlinePanel, {
    nodes,
    projection: "fresh",
    selectedNodeId: "leaf",
    onSelectNode: () => {},
    onCollapse: () => {},
  }));
  assert.match(markup, /role="tree"/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /aria-posinset="1"/);
});

test("Focus renders externally controlled placement state without inventing a second owner", () => {
  const node = {
    nodeId: "cx-a",
    etag: "etag-a",
    path: "A",
    name: "A",
    type: "goal",
    tags: [],
    mode: "editable",
    archived: false,
    invalid: false,
    parentNodeId: null,
    hasChildren: false,
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

test("Focus source status exposes one exact sync action only when permitted", () => {
  const node = {
    nodeId: "cx-a",
    etag: "etag-live",
    path: "A",
    name: "A",
    type: "goal",
    tags: [],
    mode: "editable",
    archived: false,
    invalid: false,
    parentNodeId: null,
    hasChildren: false,
    projectionState: "ready",
    collaborationState: "ready",
    activeTaskState: null,
  } satisfies WorkbenchNodeView;
  const changed = renderToStaticMarkup(createElement(InspectorPanel, {
    node,
    placementState: "placed",
    placementSourceState: {
      state: "changed",
      reason: "revision-or-fields-changed",
      canSync: true,
    },
    onSyncSnapshot: () => {},
    onRemoveNode: () => {},
    onCollapse: () => {},
  }));
  assert.match(changed, /来源有更新/);
  assert.equal((changed.match(/同步快照/g) ?? []).length, 2, "aria label plus tooltip");

  const current = renderToStaticMarkup(createElement(InspectorPanel, {
    node,
    placementState: "placed",
    placementSourceState: { state: "current", reason: "matched", canSync: false },
    onSyncSnapshot: () => {},
    onRemoveNode: () => {},
    onCollapse: () => {},
  }));
  assert.match(current, /来源一致/);
  assert.doesNotMatch(current, /同步快照/);

  const deleted = renderToStaticMarkup(createElement(InspectorPanel, {
    node: null,
    localNode: {
      nodeId: "cx-a",
      path: "旧路径",
      name: "本地 A",
      type: "goal",
      tags: [],
      mode: "editable",
      archived: false,
      invalid: false,
      projectionState: "unresolved",
      collaborationState: "unknown",
    },
    placementState: "placed",
    placementSourceState: {
      state: "deleted",
      reason: "fresh-source-missing",
      canSync: false,
    },
    onRemoveNode: () => {},
    onCollapse: () => {},
  }));
  assert.match(deleted, /源节点已删除/);
  assert.match(deleted, /本地 A/);
  assert.doesNotMatch(deleted, /同步快照/);
  assert.doesNotMatch(deleted, /aria-label="焦点内容"/);
});

test("fresh workspace cannot authorize snapshot sync from a stale selected Node", () => {
  assert.equal(canvasPlacementSourceAuthority("fresh", "stale"), "unknown");
  assert.equal(canvasPlacementSourceAuthority("fresh", "error"), "unknown");
  assert.equal(canvasPlacementSourceAuthority("fresh", "unresolved"), "unknown");
  assert.equal(canvasPlacementSourceAuthority("fresh", "ready"), "fresh");
  assert.equal(canvasPlacementSourceAuthority("fresh", null), "fresh");
});

test("placement creation fails closed while stale and reconnecting exposes one retry", () => {
  const node = {
    nodeId: "cx-a",
    etag: "etag-a",
    path: "A",
    name: "A",
    type: "goal",
    tags: [],
    mode: "editable",
    archived: false,
    invalid: false,
    parentNodeId: null,
    hasChildren: false,
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

test("Focus conflict overwrite renders saving feedback instead of live conflict actions", () => {
  const saving = {
    workspaceId: "ws-a",
    nodeId: "cx-a",
    status: "saving",
    mode: "edit",
    body: "local",
    diskBody: "external",
    etag: "etag-1",
    dirty: true,
    canSave: false,
    archived: false,
    backlinks: [],
    backlinksState: "ready",
    artifactRefs: [],
  } satisfies FocusDocumentView;
  const html = renderToStaticMarkup(createElement(FocusDocumentPanel, {
    document: saving,
    actions: noDocumentActions,
    expanded: true,
    onExpandedChange: () => {},
  }));
  assert.match(html, /正在保存/);
  assert.doesNotMatch(html, /载入磁盘版本|保留本地并保存/);
  assert.match(html, /恢复侧栏/);
});

test("stale graph keeps an independent dirty document visible while hiding graph authority", () => {
  const node = {
    nodeId: "cx-a",
    etag: "etag-a",
    path: "cached/path",
    name: "cached-node",
    type: "output",
    tags: ["cached-tag"],
    mode: "editable",
    archived: false,
    invalid: false,
    parentNodeId: null,
    hasChildren: false,
    projectionState: "stale",
    projectionMessage: "投影连接已断开",
    collaborationState: "stale",
  } satisfies WorkbenchNodeView;
  const document = {
    workspaceId: "ws-a",
    nodeId: "cx-a",
    status: "stale",
    mode: "edit",
    body: "# 本地草稿仍在",
    etag: "etag-before-disconnect",
    dirty: true,
    canSave: false,
    archived: false,
    backlinks: [],
    backlinksState: "stale",
    artifactRefs: [],
  } satisfies FocusDocumentView;

  const html = renderToStaticMarkup(createElement(InspectorPanel, {
    node,
    document,
    documentActions: noDocumentActions,
    expanded: true,
    onExpandedChange: () => {},
    canCreatePlacement: false,
    onCollapse: () => {},
  }));

  assert.match(html, /本地草稿仍在/);
  assert.match(html, /内容已过期/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>保存<\/button>/);
  assert.match(html, /等待权威投影/);
  assert.doesNotMatch(html, /<h2>属性<\/h2>|<h2>当前协作<\/h2>|<h2>交付来源<\/h2>/);
  assert.doesNotMatch(html, /cached-tag/);
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
    etag: "etag-a",
    path: "A",
    name: "A",
    type: "goal",
    tags: [],
    mode: "editable",
    archived: false,
    invalid: false,
    parentNodeId: null,
    hasChildren: false,
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
    document: async () => ({
      ok: false,
      error: { kind: "transport", message: "document fixture not configured" },
    }),
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
    document: async () => ({
      ok: false,
      error: { kind: "transport", message: "document fixture not configured" },
    }),
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
