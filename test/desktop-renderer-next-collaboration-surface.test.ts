import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CollaborationSurfaceController,
  type CollaborationSurfaceGateway,
} from "../src/desktop/renderer-next/model/collaboration-surface-controller.js";
import {
  guardCollaborationActionsOnline,
  guardCollaborationViewIdentity,
} from "../src/desktop/renderer-next/model/use-collaboration-surface.js";
import { InspectorPanel } from "../src/desktop/renderer-next/components/InspectorPanel.js";
import {
  CollaborationPanel,
  collaborationPanelIdentity,
  canSubmitDispatchDraft,
  decisionResponseFromDraft,
  updateOrderedDispatchNodes,
} from "../src/desktop/renderer-next/components/CollaborationPanel.js";
import type { WorkbenchNodeView } from "../src/desktop/renderer-next/shell/workbench-types.js";
import type {
  CollaborationMutation,
  CollaborationRead,
  CollaborationSnapshot,
} from "../src/desktop/renderer-next/gateway/collaboration-protocol.js";

const now = "2026-08-04T12:00:00.000Z";

function snapshot(nodeId: string, task: CollaborationSnapshot["task"] = null): CollaborationSnapshot {
  return {
    workspaceId: "ws-a",
    nodeId,
    roles: [{ roleId: "rl-ui", name: "UI", displayName: "界面" }],
    connections: [{ connectionId: "cn-grok", displayName: "Grok UI", provider: "grok", adapterId: "acp" }],
    task,
    session: task?.sessionId
      ? { sessionId: task.sessionId, connectionId: "cn-grok", state: "live", alive: true, turnBusy: false }
      : null,
    decisionRequests: [],
    deliveryReview: null,
  };
}

function ok<T>(value: T): CollaborationRead<T> {
  return { ok: true, workspaceId: "ws-a", value, fetchedAt: now };
}

function commandOk(): CollaborationRead<CollaborationMutation> {
  return ok({ workspaceId: "ws-a" });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function gateway(read: (nodeId: string) => Promise<CollaborationRead<CollaborationSnapshot>>): CollaborationSurfaceGateway {
  return {
    collaborationSnapshot: async (_workspaceId, nodeId) => read(nodeId),
    dispatchTask: async () => commandOk(),
    acceptDelivery: async () => commandOk(),
    rejectDelivery: async () => commandOk(),
    respondDecision: async () => commandOk(),
  };
}

test("exact Node snapshot confirms idle only after an authoritative ready read", async () => {
  const controller = new CollaborationSurfaceController(gateway(async (nodeId) => ok(snapshot(nodeId))));
  controller.select("ws-a", "cx-a");
  assert.equal(controller.getView().status, "loading");
  assert.equal(controller.getView().snapshot, null);
  await flush();
  assert.equal(controller.getView().status, "ready");
  assert.equal(controller.getView().snapshot?.nodeId, "cx-a");
  assert.equal(controller.getView().snapshot?.task, null);
  assert.equal(controller.getView().canMutate, true);
});

test("late Node A read is discarded and queued Node B read always drains", async () => {
  let releaseA!: (value: CollaborationRead<CollaborationSnapshot>) => void;
  const heldA = new Promise<CollaborationRead<CollaborationSnapshot>>((resolve) => { releaseA = resolve; });
  const reads: string[] = [];
  const controller = new CollaborationSurfaceController(gateway(async (nodeId) => {
    reads.push(nodeId);
    return nodeId === "cx-a" ? heldA : ok(snapshot(nodeId));
  }));
  controller.select("ws-a", "cx-a");
  controller.select("ws-a", "cx-b");
  assert.equal(controller.getView().nodeId, "cx-b");
  assert.equal(controller.getView().snapshot, null);
  releaseA(ok(snapshot("cx-a")));
  await flush();
  await flush();
  assert.deepEqual(reads, ["cx-a", "cx-b"]);
  assert.equal(controller.getView().status, "ready");
  assert.equal(controller.getView().snapshot?.nodeId, "cx-b");
});

test("an invalidation during the held initial snapshot always schedules a second authoritative read", async () => {
  let releaseInitial!: (value: CollaborationRead<CollaborationSnapshot>) => void;
  const heldInitial = new Promise<CollaborationRead<CollaborationSnapshot>>((resolve) => {
    releaseInitial = resolve;
  });
  const reads: CollaborationSnapshot[] = [
    snapshot("cx-a"),
    snapshot("cx-a", {
      id: "tk-new",
      path: "temp/tasks/new.md",
      state: "running",
      workNodeIds: ["cx-a"],
      contextNodeIds: [],
      acceptMode: "review-required",
    }),
  ];
  let callCount = 0;
  const controller = new CollaborationSurfaceController(gateway(async () => {
    callCount += 1;
    return callCount === 1 ? heldInitial : ok(reads[1]!);
  }));

  // The hook subscribes before select(); this models the invalidation handler
  // firing while the initial selected-Node read is held.
  controller.select("ws-a", "cx-a");
  const invalidated = controller.invalidate();
  releaseInitial(ok(reads[0]!));
  await invalidated;
  await flush();
  await flush();

  assert.equal(callCount, 2);
  assert.equal(controller.getView().snapshot?.task?.id, "tk-new");
  assert.equal(controller.getView().status, "ready");
});

test("disconnect preserves exact-node summary as stale and disables every mutation", async () => {
  const task = {
    id: "tk-a",
    path: "temp/tasks/a.md",
    state: "running",
    workNodeIds: ["cx-a"],
    contextNodeIds: [],
    acceptMode: "review-required" as const,
    sessionId: "ss-a",
  };
  const controller = new CollaborationSurfaceController(gateway(async (nodeId) => ok(snapshot(nodeId, task))));
  controller.select("ws-a", "cx-a");
  await flush();
  controller.setOnline(false);
  assert.equal(controller.getView().status, "stale");
  assert.equal(controller.getView().snapshot?.task?.id, "tk-a");
  assert.equal(controller.getView().canMutate, false);
  assert.equal(await controller.actions().acceptDelivery("temp/tasks/a.md", "dl-a"), false);
});

test("commands never fabricate lifecycle state and converge through exact reread", async () => {
  let current = snapshot("cx-a");
  let dispatches = 0;
  const base = gateway(async () => ok(current));
  const controller = new CollaborationSurfaceController({
    ...base,
    dispatchTask: async () => {
      dispatches += 1;
      current = snapshot("cx-a", {
        id: "tk-new",
        path: "temp/tasks/new.md",
        state: "running",
        workNodeIds: ["cx-a"],
        contextNodeIds: [],
        acceptMode: "agent-decide",
        sessionId: "ss-new",
      });
      return commandOk();
    },
  });
  controller.select("ws-a", "cx-a");
  await flush();
  const pending = controller.actions().dispatch({
    workNodeIds: ["cx-a"],
    contextNodeIds: [],
    prompt: "完成界面",
    target: { kind: "connection", id: "cn-grok" },
    acceptMode: "agent-decide",
  });
  assert.equal(controller.getView().snapshot?.task, null);
  assert.equal(controller.getView().busyKey, "dispatch");
  assert.equal(await pending, true);
  assert.equal(dispatches, 1);
  assert.equal(controller.getView().snapshot?.task?.id, "tk-new");
});

test("a late Node A command cannot overwrite Node B action state", async () => {
  let resolveA!: (value: CollaborationRead<CollaborationMutation>) => void;
  let resolveB!: (value: CollaborationRead<CollaborationMutation>) => void;
  const heldA = new Promise<CollaborationRead<CollaborationMutation>>((resolve) => { resolveA = resolve; });
  const heldB = new Promise<CollaborationRead<CollaborationMutation>>((resolve) => { resolveB = resolve; });
  const base = gateway(async (nodeId) => ok(snapshot(nodeId)));
  const controller = new CollaborationSurfaceController({
    ...base,
    rejectDelivery: async (_workspaceId, taskPath) =>
      taskPath.includes("a.md") ? heldA : commandOk(),
    acceptDelivery: async (_workspaceId, taskPath) =>
      taskPath.includes("b.md") ? heldB : commandOk(),
  });

  controller.select("ws-a", "cx-a");
  await flush();
  const actionA = controller.actions().rejectDelivery("temp/tasks/a.md", "dl-a", "返工");
  assert.equal(controller.getView().busyKey, "delivery:dl-a");

  controller.select("ws-a", "cx-b");
  await flush();
  assert.equal(controller.getView().snapshot?.nodeId, "cx-b");
  const actionB = controller.actions().acceptDelivery("temp/tasks/b.md", "dl-b");
  assert.equal(controller.getView().busyKey, "delivery:dl-b");

  resolveA({
    ok: false,
    workspaceId: "ws-a",
    issue: { kind: "rpc", message: "A failed", code: -32022 },
    failedAt: now,
  });
  assert.equal(await actionA, false);
  assert.equal(controller.getView().nodeId, "cx-b");
  assert.equal(controller.getView().busyKey, "delivery:dl-b");
  assert.equal(controller.getView().actionIssue, undefined);

  resolveB(commandOk());
  assert.equal(await actionB, true);
  assert.equal(controller.getView().nodeId, "cx-b");
  assert.equal(controller.getView().busyKey, null);
});

test("hook identity guard cannot expose Node A actions during the first Node B render", () => {
  const staleIdentity = {
    workspaceId: "ws-a",
    nodeId: "cx-a",
    status: "ready" as const,
    snapshot: {
      workspaceId: "ws-a",
      nodeId: "cx-a",
      targets: [],
      task: null,
      delivery: null,
      decisions: [],
    },
    busyKey: null,
    canMutate: true,
  };
  const guarded = guardCollaborationViewIdentity(staleIdentity, {
    workspaceId: "ws-a",
    nodeId: "cx-b",
    online: true,
  });
  assert.equal(guarded.nodeId, "cx-b");
  assert.equal(guarded.status, "loading");
  assert.equal(guarded.snapshot, null);
  assert.equal(guarded.canMutate, false);
});

test("hook identity guard disables the first offline render before controller effects run", async () => {
  const ready = {
    workspaceId: "ws-a",
    nodeId: "cx-a",
    status: "ready" as const,
    snapshot: {
      workspaceId: "ws-a",
      nodeId: "cx-a",
      targets: [],
      task: null,
      delivery: null,
      decisions: [],
    },
    busyKey: "dispatch",
    canMutate: true,
  };
  const guarded = guardCollaborationViewIdentity(ready, {
    workspaceId: "ws-a",
    nodeId: "cx-a",
    online: false,
  });
  assert.equal(guarded.status, "stale");
  assert.equal(guarded.snapshot?.nodeId, "cx-a");
  assert.equal(guarded.busyKey, null);
  assert.equal(guarded.canMutate, false);
  assert.equal(guarded.issue?.kind, "transport");
  let mutationCalls = 0;
  const blocked = guardCollaborationActionsOnline({
    retry: async () => {},
    dispatch: async () => { mutationCalls += 1; return true; },
    acceptDelivery: async () => { mutationCalls += 1; return true; },
    rejectDelivery: async () => { mutationCalls += 1; return true; },
    respondDecision: async () => { mutationCalls += 1; return true; },
  }, false);
  assert.equal(await blocked.dispatch({
    workNodeIds: ["cx-a"],
    contextNodeIds: [],
    prompt: "不应发送",
    target: { kind: "role", id: "rl-ui" },
    acceptMode: "review-required",
  }), false);
  assert.equal(mutationCalls, 0);
});

test("Node switch gives the collaboration form a new remount identity", () => {
  const base = {
    workspaceId: "ws-a",
    status: "ready" as const,
    snapshot: null,
    busyKey: null,
    canMutate: false,
  };
  assert.equal(collaborationPanelIdentity({ ...base, nodeId: "cx-a" }), "ws-a:cx-a");
  assert.equal(collaborationPanelIdentity({ ...base, nodeId: "cx-b" }), "ws-a:cx-b");
  assert.notEqual(
    collaborationPanelIdentity({ ...base, nodeId: "cx-a" }),
    collaborationPanelIdentity({ ...base, nodeId: "cx-b" })
  );
});

test("dispatch target and Decision answer require explicit user selection", () => {
  assert.equal(canSubmitDispatchDraft({ canMutate: true, busy: false, targetId: "", prompt: "做事" }), false);
  assert.equal(canSubmitDispatchDraft({ canMutate: true, busy: false, targetId: "rl-ui", prompt: "做事" }), true);
  assert.equal(decisionResponseFromDraft({ customMode: false, optionId: "", custom: "" }), null);
  assert.deepEqual(decisionResponseFromDraft({ customMode: false, optionId: "yes", custom: "" }), { kind: "option", optionId: "yes" });
  assert.equal(decisionResponseFromDraft({ customMode: true, optionId: "", custom: "  " }), null);
  assert.deepEqual(decisionResponseFromDraft({ customMode: true, optionId: "", custom: "明确回复" }), { kind: "custom", text: "明确回复" });
});

test("ordered multi-Node dispatch keeps the selected Node first and work/context disjoint", () => {
  let draft = { additionalWorkNodeIds: [] as string[], contextNodeIds: [] as string[] };
  draft = updateOrderedDispatchNodes(draft, "cx-b", "work");
  draft = updateOrderedDispatchNodes(draft, "cx-c", "work");
  assert.deepEqual(["cx-a", ...draft.additionalWorkNodeIds], ["cx-a", "cx-b", "cx-c"]);
  draft = updateOrderedDispatchNodes(draft, "cx-d", "context");
  draft = updateOrderedDispatchNodes(draft, "cx-b", "context");
  assert.deepEqual(draft.additionalWorkNodeIds, ["cx-c"]);
  assert.deepEqual(draft.contextNodeIds, ["cx-d", "cx-b"]);
  draft = updateOrderedDispatchNodes(draft, "cx-d", "none");
  draft = updateOrderedDispatchNodes(draft, "cx-d", "work");
  assert.deepEqual(draft.additionalWorkNodeIds, ["cx-c", "cx-d"]);
  assert.deepEqual(draft.contextNodeIds, ["cx-b"]);
  assert.equal(canSubmitDispatchDraft({
    canMutate: true,
    busy: false,
    targetId: "rl-ui",
    prompt: "一起处理",
    primaryNodeId: "cx-a",
    additionalWorkNodeIds: draft.additionalWorkNodeIds,
    contextNodeIds: draft.contextNodeIds,
  }), true);
  assert.equal(canSubmitDispatchDraft({
    canMutate: true,
    busy: false,
    targetId: "rl-ui",
    prompt: "错误重叠",
    primaryNodeId: "cx-a",
    additionalWorkNodeIds: ["cx-b"],
    contextNodeIds: ["cx-b"],
  }), false);
});

test("initial loading and error without a snapshot never claim authoritative empty collaboration", () => {
  const node: WorkbenchNodeView = {
    nodeId: "cx-a",
    etag: "etag-a",
    path: "产品/界面",
    name: "界面",
    type: "prompt",
    tags: [],
    mode: "editable",
    archived: false,
    invalid: false,
    parentNodeId: null,
    hasChildren: false,
    projectionState: "ready",
    collaborationState: "stale",
  };
  const actions = new CollaborationSurfaceController(
    gateway(async () => ok(snapshot("cx-a")))
  ).actions();
  for (const view of [
    {
      workspaceId: "ws-a",
      nodeId: "cx-a",
      status: "loading" as const,
      snapshot: null,
      busyKey: null,
      canMutate: false,
    },
    {
      workspaceId: "ws-a",
      nodeId: "cx-a",
      status: "error" as const,
      snapshot: null,
      issue: { kind: "transport" as const, message: "连接失败" },
      busyKey: null,
      canMutate: false,
    },
  ]) {
    const html = renderToStaticMarkup(createElement(CollaborationPanel, {
      node,
      allNodes: [node],
      view,
      actions,
    }));
    assert.doesNotMatch(html, /没有进行中的任务/);
    assert.doesNotMatch(html, /没有待审交付或决策请求/);
    assert.doesNotMatch(html, />派活</);
    assert.match(html, /协作状态|协作数据不可用/);
  }
});

test("Focus collaboration stays a flat exact-Node workflow and stale content is non-mutating", () => {
  const node: WorkbenchNodeView = {
    nodeId: "cx-a",
    etag: "etag-a",
    path: "产品/界面",
    name: "界面",
    type: "prompt",
    tags: [],
    mode: "editable",
    archived: false,
    invalid: false,
    parentNodeId: null,
    hasChildren: false,
    projectionState: "ready",
    collaborationState: "ready",
    activeTaskState: "delivered",
  };
  const task = {
    id: "tk-a",
    path: "temp/tasks/a.md",
    state: "delivered",
    workNodeIds: ["cx-a"],
    contextNodeIds: [],
    acceptMode: "agent-decide" as const,
    assignee: { kind: "connection" as const, label: "Grok UI" },
    session: { id: "ss-a", state: "live", alive: true, turnBusy: false },
  };
  const view = {
    workspaceId: "ws-a",
    nodeId: "cx-a",
    status: "stale" as const,
    snapshot: {
      workspaceId: "ws-a",
      nodeId: "cx-a",
      targets: [],
      task,
      delivery: {
        id: "dl-a",
        taskId: "tk-a",
        taskPath: task.path,
        sourceNodeId: "cx-a",
        summary: "完成主界面协作闭环",
        status: "ready" as const,
        createdAt: now,
      },
      decisions: [{
        id: "dr-a",
        taskId: "tk-a",
        taskPath: task.path,
        question: "选择审阅方向",
        options: [{ id: "a", label: "方向 A" }],
        createdAt: now,
      }],
    },
    issue: { kind: "transport" as const, message: "连接已中断" },
    busyKey: null,
    canMutate: false,
  };
  const actions = new CollaborationSurfaceController(gateway(async () => ok(snapshot("cx-a")))).actions();
  const html = renderToStaticMarkup(createElement(InspectorPanel, {
    node,
    allNodes: [node],
    collaboration: view,
    collaborationActions: actions,
    initialTab: "collaboration",
    onCollapse() {},
  }));
  assert.match(html, /完成主界面协作闭环/);
  assert.match(html, /选择审阅方向/);
  assert.match(html, /执行者决定/);
  assert.match(html, /当前已进入正式人工审阅/);
  assert.match(html, /disabled=""/);
});
