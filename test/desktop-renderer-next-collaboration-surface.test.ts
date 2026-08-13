import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CollaborationPanel } from "../src/desktop/renderer-next/components/CollaborationPanel.js";
import { CollaborationSurfaceController, type CollaborationSurfaceGateway } from "../src/desktop/renderer-next/model/collaboration-surface-controller.js";
import type { WorkspaceCollaborationView } from "../src/desktop/renderer-next/model/workspace-collaboration-view.js";
import { guardCollaborationViewIdentity } from "../src/desktop/renderer-next/model/use-collaboration-surface.js";

const ok = <T>(workspaceId: string, value: T) => ({ ok: true as const, workspaceId, value, fetchedAt: "now" });
const command = (workspaceId: string) => ok(workspaceId, { workspaceId });
const snapshot = (nodeId: string | null): WorkspaceCollaborationView => ({ workspaceId: "ws-a", selectedNode: nodeId ? { nodeId, activeTask: null, statusDetail: null } : null, inbox: { items: [{ kind: "result", resultId: "rs-a", summary: "完成", createdAt: "now" }], counts: { result: 1, decision: 0, total: 1 } } });
function gateway(overrides: Partial<CollaborationSurfaceGateway> = {}): CollaborationSurfaceGateway {
  return {
    workspaceCollaboration: async (workspaceId, nodeId) => ok(workspaceId, snapshot(nodeId)),
    dispatchTargets: async (workspaceId) => ok(workspaceId, { workspaceId, targets: [{ kind: "role", id: "rl-ui", label: "界面" }] }),
    dispatchTask: async (input) => command(input.workspaceId),
    acceptTaskResult: async (workspaceId) => command(workspaceId),
    rejectTaskResult: async (workspaceId) => command(workspaceId),
    respondDecision: async (workspaceId) => command(workspaceId),
    ...overrides,
  };
}

test("workspace Inbox loads with null selected Node and never invents a surrogate", async () => {
  const seen: Array<string | null> = [];
  const controller = new CollaborationSurfaceController(gateway({ workspaceCollaboration: async (workspaceId, nodeId) => { seen.push(nodeId); return ok(workspaceId, snapshot(nodeId)); } }));
  controller.select("ws-a", null); await controller.reload();
  assert.ok(seen.length >= 1 && seen.every((nodeId) => nodeId === null));
  assert.equal(controller.getView().status, "ready");
  assert.equal(controller.getView().snapshot?.selectedNode, null);
  assert.equal(controller.getView().snapshot?.inbox.counts.total, 1);
});

test("selected identity switch clears old content synchronously and late A is discarded", async () => {
  let release!: (value: ReturnType<typeof ok<WorkspaceCollaborationView>>) => void;
  const held = new Promise<ReturnType<typeof ok<WorkspaceCollaborationView>>>((resolve) => { release = resolve; });
  const controller = new CollaborationSurfaceController(gateway({ workspaceCollaboration: async (workspaceId, nodeId) => nodeId === "cx-a" ? held : ok(workspaceId, snapshot(nodeId)) }));
  controller.select("ws-a", "cx-a");
  controller.select("ws-a", "cx-b");
  assert.equal(controller.getView().snapshot, null);
  release(ok("ws-a", snapshot("cx-a")));
  await new Promise((resolve) => setTimeout(resolve, 0)); await controller.reload();
  assert.equal(controller.getView().snapshot?.selectedNode?.nodeId, "cx-b");
});

test("same-workspace A to B or null retains Inbox while selected collaboration fails closed", async () => {
  let release!: (value: ReturnType<typeof ok<WorkspaceCollaborationView>>) => void;
  let held = false;
  const controller = new CollaborationSurfaceController(gateway({ workspaceCollaboration: async (workspaceId, nodeId) => {
    if (held) return new Promise((resolve) => { release = resolve; });
    return ok(workspaceId, snapshot(nodeId));
  } }));
  controller.select("ws-a", "cx-a"); await controller.reload();
  held = true;
  controller.select("ws-a", "cx-b");
  assert.equal(controller.getView().status, "refreshing");
  assert.equal(controller.getView().snapshot?.inbox.counts.total, 1);
  assert.equal(controller.getView().snapshot?.selectedNode, null);
  assert.equal(controller.getView().canMutate, false);
  release(ok("ws-a", snapshot("cx-b"))); await new Promise((resolve) => setTimeout(resolve, 0));
  held = false;
  controller.select("ws-a", null);
  assert.equal(controller.getView().snapshot?.inbox.counts.total, 1);
  assert.equal(controller.getView().snapshot?.selectedNode, null);
  assert.equal(controller.getView().canMutate, false);
});

test("disconnect retains Inbox/selected content stale and disables commands", async () => {
  const controller = new CollaborationSurfaceController(gateway()); controller.select("ws-a", "cx-a"); await controller.reload();
  controller.setOnline(false);
  assert.equal(controller.getView().status, "stale"); assert.equal(controller.getView().snapshot?.inbox.counts.total, 1); assert.equal(controller.getView().canMutate, false);
  assert.equal(await controller.actions().acceptTaskResult("rs-a"), false);
});

test("commands use exact TaskResult/Decision identities and reread", async () => {
  const calls: unknown[] = []; let reads = 0;
  const controller = new CollaborationSurfaceController(gateway({
    workspaceCollaboration: async (workspaceId, nodeId) => { reads += 1; return ok(workspaceId, snapshot(nodeId)); },
    acceptTaskResult: async (workspaceId, resultId) => { calls.push(["accept", workspaceId, resultId]); return command(workspaceId); },
    respondDecision: async (workspaceId, requestId, response) => { calls.push(["decision", workspaceId, requestId, response]); return command(workspaceId); },
  }));
  controller.select("ws-a", "cx-a"); await controller.reload();
  assert.equal(await controller.actions().acceptTaskResult("rs-a"), true);
  assert.equal(await controller.actions().respondDecision("dr-a", { kind: "deny" }), true);
  assert.deepEqual(calls, [["accept", "ws-a", "rs-a"], ["decision", "ws-a", "dr-a", { kind: "deny" }]]);
  assert.ok(reads >= 3);
});

test("identity guard represents null selection as workspace loading/error, not idle", () => {
  const view = { workspaceId: "ws-old", nodeId: "cx-a", status: "ready" as const, snapshot: snapshot("cx-a"), targets: [], targetsReady: true, busyKey: null, canMutate: true };
  const next = guardCollaborationViewIdentity(view, { workspaceId: "ws-a", nodeId: null, online: true });
  assert.equal(next.status, "loading"); assert.equal(next.snapshot, null); assert.equal(next.canMutate, false);
});

test("identity guard keeps same-workspace Inbox but never the prior selected Task", () => {
  const prior: WorkspaceCollaborationView = {
    ...snapshot("cx-a"),
    selectedNode: { nodeId: "cx-a", activeTask: { taskId: "tk-a", state: "running", responsibility: { kind: "user" }, execution: null, readyResult: null, pendingDecision: null }, statusDetail: null },
  };
  const view = { workspaceId: "ws-a", nodeId: "cx-a", status: "ready" as const, snapshot: prior, targets: [], targetsReady: true, busyKey: null, canMutate: true };
  const guarded = guardCollaborationViewIdentity(view, { workspaceId: "ws-a", nodeId: "cx-b", online: true });
  assert.equal(guarded.status, "refreshing");
  assert.equal(guarded.snapshot?.inbox.counts.total, 1);
  assert.equal(guarded.snapshot?.selectedNode, null);
  assert.equal(guarded.canMutate, false);
});

test("same-workspace retained Inbox does not render a surrogate selected-Node workflow", () => {
  const prior: WorkspaceCollaborationView = {
    ...snapshot("cx-a"),
    selectedNode: { nodeId: "cx-a", activeTask: { taskId: "tk-a", state: "running", responsibility: { kind: "user" }, execution: null, readyResult: null, pendingDecision: null }, statusDetail: null },
  };
  const guarded = guardCollaborationViewIdentity(
    { workspaceId: "ws-a", nodeId: "cx-a", status: "ready", snapshot: prior, targets: [], targetsReady: true, busyKey: null, canMutate: true },
    { workspaceId: "ws-a", nodeId: "cx-b", online: true }
  );
  const node = { nodeId: "cx-b", etag: "etag-b", path: "B", name: "B", type: "prompt", tags: [], mode: "editable" as const, archived: false, invalid: false, parentNodeId: null, hasChildren: false, projectionState: "ready" as const };
  const html = renderToStaticMarkup(createElement(CollaborationPanel, {
    node,
    allNodes: [node],
    view: guarded,
    actions: { retry: async () => {}, dispatch: async () => false, acceptTaskResult: async () => false, rejectTaskResult: async () => false, respondDecision: async () => false },
  }));
  assert.match(html, /协作内容正在刷新/);
  assert.doesNotMatch(html, /开始委托|委托进展|工作正在推进/);
});

test("Role-responsible return stays readable without exposing user review mutations", () => {
  const node = { nodeId: "cx-a", etag: "etag-a", path: "A", name: "A", type: "prompt", tags: [], mode: "editable" as const, archived: false, invalid: false, parentNodeId: null, hasChildren: false, projectionState: "ready" as const };
  const roleSnapshot: WorkspaceCollaborationView = {
    ...snapshot("cx-a"),
    selectedNode: { nodeId: "cx-a", activeTask: {
      taskId: "tk-role",
      state: "submitted",
      responsibility: { kind: "role", roleId: "rl-parent", label: "规划" },
      execution: { kind: "role", roleId: "rl-worker", label: "执行" },
      readyResult: { resultId: "rs-role", summary: "已完成方案", createdAt: "now" },
      pendingDecision: null,
    }, statusDetail: null },
  };
  const view = { workspaceId: "ws-a", nodeId: "cx-a", status: "ready" as const, snapshot: roleSnapshot, targets: [], targetsReady: true, busyKey: null, canMutate: true };
  const html = renderToStaticMarkup(createElement(CollaborationPanel, {
    node,
    allNodes: [node],
    view,
    actions: { retry: async () => {}, dispatch: async () => false, acceptTaskResult: async () => false, rejectTaskResult: async () => false, respondDecision: async () => false },
  }));
  assert.match(html, /已完成方案/);
  assert.match(html, /等待规划接纳|等待负责角色/);
  assert.doesNotMatch(html, />接纳<|>退回<|退回修改/);
});

test("selected pending Decision remains actionable because workspace projection admits only user targets", () => {
  const node = { nodeId: "cx-a", etag: "etag-a", path: "A", name: "A", type: "prompt", tags: [], mode: "editable" as const, archived: false, invalid: false, parentNodeId: null, hasChildren: false, projectionState: "ready" as const };
  const decisionSnapshot: WorkspaceCollaborationView = {
    ...snapshot("cx-a"),
    selectedNode: { nodeId: "cx-a", activeTask: {
      taskId: "tk-waiting",
      state: "waiting",
      responsibility: { kind: "role", roleId: "rl-parent", label: "规划" },
      execution: { kind: "role", roleId: "rl-worker", label: "执行" },
      readyResult: null,
      pendingDecision: { requestId: "dr-user", question: "是否继续？", options: [{ id: "yes", label: "继续" }] },
    }, statusDetail: null },
  };
  const view = { workspaceId: "ws-a", nodeId: "cx-a", status: "ready" as const, snapshot: decisionSnapshot, targets: [], targetsReady: true, busyKey: null, canMutate: true };
  const html = renderToStaticMarkup(createElement(CollaborationPanel, {
    node,
    allNodes: [node],
    view,
    actions: { retry: async () => {}, dispatch: async () => false, acceptTaskResult: async () => false, rejectTaskResult: async () => false, respondDecision: async () => false },
  }));
  assert.match(html, /是否继续？/);
  assert.match(html, /提交回复|拒绝此次请求/);
});
