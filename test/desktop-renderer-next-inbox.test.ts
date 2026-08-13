import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InboxView, inboxModelCount, resolveInboxItemNode } from "../src/desktop/renderer-next/components/InboxView.js";
import type { CollaborationSurfaceView } from "../src/desktop/renderer-next/model/collaboration-surface-controller.js";
import type { WorkbenchNodeView } from "../src/desktop/renderer-next/shell/workbench-types.js";

const node = (nodeId: string): WorkbenchNodeView => ({ nodeId, etag: `etag-${nodeId}`, path: nodeId, name: nodeId, type: "prompt", tags: [], mode: "editable", archived: false, invalid: false, parentNodeId: null, hasChildren: false, projectionState: "ready" });
const view: CollaborationSurfaceView = { workspaceId: "ws-a", nodeId: null, status: "ready", targets: [], targetsReady: true, busyKey: null, canMutate: true, snapshot: { workspaceId: "ws-a", selectedNode: null, inbox: { items: [
  { kind: "result", resultId: "rs-a", summary: "返回内容", createdAt: "now" },
  { kind: "decision", requestId: "dr-a", nodeIds: ["cx-missing", "cx-b"], question: "选择方向", options: [], createdAt: "now" },
], counts: { result: 1, decision: 1, total: 2 } } } };

test("Inbox is workspace-level and renders only actionable TaskResult/Decision", () => {
  const html = renderToStaticMarkup(createElement(InboxView, { view, nodes: [node("cx-a"), node("cx-b")], projection: "fresh", onSelectNode() {} }));
  assert.match(html, /返回内容/); assert.match(html, /需要决定/); assert.doesNotMatch(html, /工具许可|Task|Session|taskPath/);
  assert.equal(inboxModelCount(view), 2);
});

test("Inbox resolves exact source without a selected-node surrogate and fails closed on stale graph", () => {
  const result = view.snapshot!.inbox.items[0]!;
  const decision = view.snapshot!.inbox.items[1]!;
  assert.equal(resolveInboxItemNode(result, [node("cx-a")], "fresh"), null);
  assert.equal(resolveInboxItemNode(decision, [node("cx-b")], "fresh")?.nodeId, "cx-b");
  assert.equal(resolveInboxItemNode(result, [node("cx-a")], "stale"), null);
});

test("retained stale Inbox remains visible but non-authoritative", () => {
  const stale: CollaborationSurfaceView = { ...view, status: "stale", canMutate: false, issue: { kind: "transport", message: "离线" } };
  const html = renderToStaticMarkup(createElement(InboxView, { view: stale, nodes: [node("cx-a"), node("cx-b")], projection: "stale", onSelectNode() {} }));
  assert.match(html, /收件箱正在刷新/); assert.match(html, /返回内容/); assert.match(html, /aria-disabled="true"/);
});
