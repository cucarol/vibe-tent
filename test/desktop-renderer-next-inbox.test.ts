import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopInboxSnapshot } from "../src/desktop/inbox-ipc.js";
import { InboxController } from "../src/desktop/renderer-next/model/inbox-controller.js";
import {
  activateInboxItem,
  InboxView,
  resolveInboxItemNode,
} from "../src/desktop/renderer-next/components/InboxView.js";
import { OutlinePanel } from "../src/desktop/renderer-next/components/OutlinePanel.js";
import type { InboxModel } from "../src/desktop/renderer-next/model/inbox.js";
import type { ProjectionRead } from "../src/desktop/renderer-next/gateway/workspace-projections.js";
import type { InvalidationHint } from "../src/desktop/renderer-next/gateway/service-gateway.js";
import type { WorkbenchNodeView } from "../src/desktop/renderer-next/shell/workbench-types.js";
import { createEmptyCanvasDocument } from "../src/desktop/renderer-next/types/identity.js";
import { selectPresentationNodeFromOutline } from "../src/desktop/renderer-next/shell/workbench-presentation.js";

const node: WorkbenchNodeView = {
  nodeId: "node-authoritative",
  etag: "etag-1",
  path: "nodes/authoritative.md",
  name: "Authoritative Node",
  type: "goal",
  tags: [],
  mode: "editable",
  archived: false,
  invalid: false,
  parentNodeId: null,
  hasChildren: false,
  projectionState: "ready",
};

const snapshot: DesktopInboxSnapshot = {
  workspaceId: "ws-a",
  count: 2,
  items: [
    {
      id: "delivery-1",
      kind: "delivery",
      createdAt: "2026-01-01T12:34:00.000Z",
      summary: "请审阅这个交付",
      sourceNodeId: "node-authoritative",
    },
    {
      id: "tool-1",
      kind: "toolApproval",
      createdAt: "2026-01-01T12:35:00.000Z",
      summary: "允许执行一个很长的工具摘要，应该被限制长度并保持可扫描。",
    },
  ],
};

function readyModel(): InboxModel {
  return { state: "ready", workspaceId: "ws-a", snapshot, fetchedAt: "now" };
}

function renderInbox(model: InboxModel, nodes: readonly WorkbenchNodeView[] = [node]) {
  return renderToStaticMarkup(createElement(InboxView, {
    model,
    nodes,
    projection: "fresh",
    onSelectNode: () => {},
  }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function read(workspaceId: string): ProjectionRead<DesktopInboxSnapshot> {
  return {
    ok: true,
    workspaceId,
    value: { ...snapshot, workspaceId },
    fetchedAt: "now",
  };
}

test("Inbox view keeps every loading, ready, stale, and error state honest", () => {
  const idle = renderInbox({ state: "idle" }, []);
  assert.match(idle, /data-inbox-state="idle"/);
  assert.match(idle, /收件箱未挂载/);
  assert.doesNotMatch(idle, /暂时没有待处理事项/);

  const loading = renderInbox({ state: "loading", workspaceId: "ws-a" }, []);
  assert.match(loading, /data-testid="inbox-loading"/);
  assert.doesNotMatch(loading, /待处理事项/);

  const empty: InboxModel = {
    state: "ready",
    workspaceId: "ws-a",
    snapshot: { workspaceId: "ws-a", items: [], count: 0 },
    fetchedAt: "now",
  };
  assert.match(renderInbox(empty, []), /data-testid="inbox-ready-empty"/);

  const ready = renderInbox(readyModel());
  assert.match(ready, /data-inbox-state="ready"/);
  assert.match(ready, /交付审阅/);
  assert.match(ready, /工具许可/);
  assert.match(ready, /data-actionable="true"/);
  assert.match(ready, /来源节点不可解析/);
  assert.match(ready, /1\/1/);

  const loadingKnown = renderInbox({
    state: "loading",
    workspaceId: "ws-a",
    previous: snapshot,
  });
  assert.match(loadingKnown, /data-testid="inbox-refreshing"/);
  assert.match(loadingKnown, /data-actionable="true"/);
  assert.match(loadingKnown, /已知事项 2 条/);

  const stale = renderInbox({
    state: "stale",
    workspaceId: "ws-a",
    snapshot,
    issue: { kind: "transport", message: "offline" },
    failedAt: "now",
  });
  assert.match(stale, /data-testid="inbox-stale"/);
  assert.match(stale, /内容已过期/);
  assert.match(stale, /交付审阅/);

  const error = renderInbox({
    state: "error",
    workspaceId: "ws-a",
    issue: { kind: "rpc", message: "failed" },
    failedAt: "now",
  });
  assert.match(error, /data-testid="inbox-error"/);
  assert.doesNotMatch(error, /交付审阅|工具许可/);
});

test("Inbox controller wiring keeps one controller, selects the exact workspace, and disposes", async () => {
  let invalidation: ((hint: InvalidationHint) => void) | null = null;
  const release = deferred<void>();
  const calls: string[] = [];
  const controller = new InboxController({
    onInvalidation(handler) {
      invalidation = handler;
      return () => { invalidation = null; };
    },
    async pendingInteractions(workspaceId) {
      calls.push(workspaceId);
      if (workspaceId === "ws-a") await release.promise;
      return read(workspaceId);
    },
  });

  controller.select("ws-a");
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.select("ws-b");
  release.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["ws-a", "ws-b"]);
  const view = controller.getView();
  assert.equal(view.state, "ready");
  if (view.state !== "ready") throw new Error("workspace B did not become ready");
  assert.equal(view.workspaceId, "ws-b");
  assert.ok(invalidation);
  controller.dispose();
  assert.equal(invalidation, null);
});

test("Inbox activation requires an exact authoritative Node and never changes Canvas presentation", () => {
  const item = snapshot.items[0]!;
  const selected: string[] = [];
  assert.equal(resolveInboxItemNode(item, [node], "fresh")?.nodeId, node.nodeId);
  assert.equal(activateInboxItem(item, [node], "fresh", (nodeId) => selected.push(nodeId)), true);
  assert.deepEqual(selected, [node.nodeId]);

  const absentSource = { ...item, sourceNodeId: undefined };
  const unknownSource = { ...item, sourceNodeId: "node-unknown" };
  assert.equal(activateInboxItem(absentSource, [node], "fresh", () => selected.push("bad")), false);
  assert.equal(activateInboxItem(unknownSource, [node], "fresh", () => selected.push("bad")), false);
  assert.equal(activateInboxItem(item, [node], "stale", () => selected.push("bad")), false);
  assert.deepEqual(selected, [node.nodeId]);

  const presentation = {
    document: createEmptyCanvasDocument(),
    selectedNodeId: null,
  };
  const next = selectPresentationNodeFromOutline(presentation, node.nodeId);
  assert.equal(next.selectedNodeId, node.nodeId);
  assert.strictEqual(next.document, presentation.document);
  assert.equal(next.document.placements.length, 0);
});

test("Inbox mode stays selected and ordinary Inbox activation cannot reopen a collapsed pane", async () => {
  const modeChanges: string[] = [];
  const markup = renderToStaticMarkup(createElement(OutlinePanel, {
    mode: "inbox",
    onModeChange: (mode) => modeChanges.push(mode),
    nodes: [node],
    projection: "fresh",
    selectedNodeId: null,
    onSelectNode: () => {},
    inboxModel: readyModel(),
    onCollapse: () => {},
  }));
  assert.match(markup, /data-outline-mode="inbox"/);
  assert.match(markup, /收件箱/);
  assert.match(markup, /tn-ui-pane-header-meta"> 2/);
  assert.doesNotMatch(markup, /收件箱尚未接入/);
  assert.deepEqual(modeChanges, []);

  const appShell = await readFile(
    new URL("../src/desktop/renderer-next/shell/AppShell.tsx", import.meta.url),
    "utf8"
  );
  const outlineSelection = appShell.slice(
    appShell.indexOf("const selectNodeFromOutline"),
    appShell.indexOf("const updateDocument")
  );
  assert.doesNotMatch(outlineSelection, /layout\.(toggle|restore|collapse)\(/);
  assert.match(appShell, /inboxModel=\{inboxModel\}/);
});

test("Production owns InboxController through the leak-free external-store hook", async () => {
  const production = await readFile(
    new URL("../src/desktop/renderer-next/ProductionApp.tsx", import.meta.url),
    "utf8"
  );
  const hook = await readFile(
    new URL("../src/desktop/renderer-next/model/use-inbox-controller.ts", import.meta.url),
    "utf8"
  );
  assert.match(production, /useInboxController\(gateway, workspace\.workspaceId\)/);
  assert.match(production, /inboxModel=\{inboxModel\}/);
  assert.match(hook, /useSyncExternalStore/);
  assert.match(hook, /controller\.select\(workspaceId\)/);
  assert.match(hook, /controller\.dispose\(\)/);
});
