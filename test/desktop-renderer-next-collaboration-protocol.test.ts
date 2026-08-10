import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceRpcError } from "../src/desktop/client/rpc-client.js";
import { handleDesktopCollaborationRequest } from "../src/desktop/main/collaboration-ipc-handler.js";
import {
  acceptDelivery,
  readCollaborationSnapshot,
  rejectDelivery,
  respondDecision,
} from "../src/desktop/renderer-next/gateway/collaboration-protocol.js";

type RpcCall = { method: string; params: Record<string, unknown> | undefined };

function serviceFixture() {
  const calls: RpcCall[] = [];
  const client = {
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "registry.roles") {
        return {
          workspaceId: "ws-a",
          roles: [{ roleId: "rl-ui", name: "UI", displayName: "界面", description: "产品界面", prompt: "SECRET_ROLE_PROMPT" }],
        };
      }
      if (method === "connection.list") {
        return {
          connections: [{ connectionId: "grok-ui", displayName: "Grok UI", provider: "grok", adapterId: "acp", launchSecretExists: true, command: "SECRET_COMMAND" }],
        };
      }
      if (method === "node.collaboration") {
        return {
          workspaceId: "ws-a",
          nodeId: "cx-a",
          activeTask: {
            task: { id: "tk-a", path: "temp/tasks/a.md", state: "delivered", roleId: "rl-ui", sessionId: "ss-a", activeDeliveryId: "dl-a" },
            session: { id: "ss-a", state: "stopped", alive: false, turnBusy: false },
            delivery: { id: "dl-a", status: "ready" },
          },
        };
      }
      if (method === "task.get") {
        return {
          workspaceId: "ws-a",
          task: {
            id: "tk-a",
            path: "temp/tasks/a.md",
            state: "delivered",
            roleId: "rl-ui",
            workNodeIds: ["cx-source", "cx-a"],
            contextNodeIds: ["cx-context"],
            acceptMode: "review-required",
            sessionId: "ss-a",
            activeDeliveryId: "dl-a",
            prompt: "SECRET_TASK_PROMPT",
            contextCard: { objective: "SECRET_CONTEXT_CARD" },
          },
        };
      }
      if (method === "session.get") {
        return {
          session: {
            sessionId: "ss-a",
            connectionId: "grok-ui",
            roleId: "rl-ui",
            state: "stopped",
            alive: false,
            turnBusy: false,
            workspace: "ws-a",
            lastTaskId: "tk-a",
            externalKey: "SECRET_EXTERNAL_KEY",
          },
        };
      }
      if (method === "interaction.listPending") {
        return {
          workspaceId: "ws-a",
          items: [
            { kind: "decisionRequest", id: "dr-a", workspaceId: "ws-a", createdAt: "2026-08-04T00:00:00Z", taskPath: "temp/tasks/a.md", taskId: "tk-a", sessionId: "ss-a", target: { kind: "user", id: "user" }, question: "继续吗？", options: [{ id: "yes", label: "继续" }], role: "SECRET_PENDING_ROLE", futureField: "SECRET_PENDING_FIELD" },
            { kind: "toolApproval", id: "ta-a", workspaceId: "ws-a", createdAt: "2026-08-04T00:00:01Z", taskPath: "temp/tasks/a.md", taskId: "tk-a", sessionId: "ss-a", toolTitle: "测试", options: [] },
            { kind: "delivery", id: "dl-a", workspaceId: "ws-a", createdAt: "2026-08-04T00:00:02Z", taskPath: "temp/tasks/a.md", taskId: "tk-a", sourceNodeId: "cx-source", path: "SECRET_DELIVERY_PATH", status: "ready", futureField: "SECRET_DELIVERY_FIELD" },
            { kind: "decisionRequest", id: "dr-other", workspaceId: "ws-a", createdAt: "2026-08-04T00:00:03Z", taskPath: "temp/tasks/b.md", taskId: "tk-b", sessionId: "ss-b", target: { kind: "user", id: "user" }, question: "其他任务", options: [] },
          ],
          counts: { decisionRequest: 2, toolApproval: 1, delivery: 1, total: 4 },
        };
      }
      if (method === "delivery.get") {
        return {
          workspaceId: "ws-a",
          delivery: {
            id: "dl-a",
            path: "deliveries/a.md",
            taskId: "tk-a",
            sourceNodeId: "cx-source",
            status: "ready",
            summary: "完成了界面闭环",
            commits: ["a".repeat(40)],
            targetHead: "b".repeat(40),
            integrationMode: null,
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { client, calls };
}

test("selected-node snapshot reads only exact active Task/Session/Delivery and ignores Tool Approval UI", async () => {
  const { client, calls } = serviceFixture();
  const result = await readCollaborationSnapshot(
    (request) => handleDesktopCollaborationRequest(client as never, request),
    "ws-a",
    "cx-a"
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.nodeId, "cx-a");
  assert.equal(result.value.task?.id, "tk-a");
  assert.equal(result.value.session?.connectionId, "grok-ui");
  assert.equal(result.value.deliveryReview?.id, "dl-a");
  assert.equal(result.value.deliveryReview?.sourceNodeId, "cx-source");
  assert.deepEqual(result.value.decisionRequests.map((item) => item.id), ["dr-a"]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.value, "toolApprovalCount"),
    false
  );
  assert.equal(calls.some((call) => call.method === "task.list"), false);
  assert.deepEqual(
    calls.find((call) => call.method === "session.get")?.params,
    { sessionId: "ss-a" }
  );
  assert.deepEqual(
    calls.filter((call) => call.method === "delivery.get").map((call) => call.params?.id),
    ["dl-a"]
  );
});

test("main returns only the minimal collaboration DTO across Electron IPC", async () => {
  const { client } = serviceFixture();
  const result = await handleDesktopCollaborationRequest(client as never, {
    operation: "snapshot",
    workspaceId: "ws-a",
    nodeId: "cx-a",
  });
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "SECRET_ROLE_PROMPT",
    "SECRET_COMMAND",
    "SECRET_TASK_PROMPT",
    "SECRET_CONTEXT_CARD",
    "SECRET_EXTERNAL_KEY",
    "commits",
    "targetHead",
    "SECRET_PENDING_ROLE",
    "SECRET_PENDING_FIELD",
    "SECRET_DELIVERY_PATH",
    "SECRET_DELIVERY_FIELD",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("dispatch fixes user authority and excludes renderer lifecycle overrides", async () => {
  const calls: RpcCall[] = [];
  const client = {
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return { workspaceId: "ws-a", taskPath: "temp/tasks/new.md" };
    },
  };
  const result = await handleDesktopCollaborationRequest(client as never, {
    operation: "dispatch",
    workspaceId: "ws-a",
    workNodeIds: ["cx-a"],
    contextNodeIds: ["cx-b"],
    prompt: "完成界面",
    target: { kind: "connection", id: "grok-ui" },
    acceptMode: "agent-decide",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    method: "task.dispatch",
    params: {
      workspaceId: "ws-a",
      workNodeIds: ["cx-a"],
      contextNodeIds: ["cx-b"],
      prompt: "完成界面",
      parentActor: { kind: "user", id: "user" },
      asSub: false,
      acceptMode: "agent-decide",
      connectionId: "grok-ui",
    },
  }]);

  const rejectedOverride = await handleDesktopCollaborationRequest(client as never, {
    operation: "dispatch",
    workspaceId: "ws-a",
    workNodeIds: ["cx-a"],
    contextNodeIds: [],
    prompt: "bad",
    target: { kind: "role", id: "rl-ui" },
    acceptMode: "review-required",
    actor: "role",
  });
  assert.equal(rejectedOverride.ok, false);
  if (!rejectedOverride.ok) assert.equal(rejectedOverride.error.kind, "invalid-request");

  const rejectedOverlap = await handleDesktopCollaborationRequest(client as never, {
    operation: "dispatch",
    workspaceId: "ws-a",
    workNodeIds: ["cx-a", "cx-b"],
    contextNodeIds: ["cx-b"],
    prompt: "ambiguous",
    target: { kind: "role", id: "rl-ui" },
    acceptMode: "review-required",
  });
  assert.equal(rejectedOverlap.ok, false);
  if (!rejectedOverlap.ok) assert.equal(rejectedOverlap.error.kind, "invalid-request");
});

test("accept/reject fix actor=user and reject resumes the same Task", async () => {
  const calls: RpcCall[] = [];
  const client = {
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return { workspaceId: "ws-a" };
    },
  };
  assert.equal((await handleDesktopCollaborationRequest(client as never, { operation: "acceptDelivery", workspaceId: "ws-a", taskPath: "temp/tasks/a.md", deliveryId: "dl-a" })).ok, true);
  assert.equal((await handleDesktopCollaborationRequest(client as never, { operation: "rejectDelivery", workspaceId: "ws-a", taskPath: "temp/tasks/a.md", deliveryId: "dl-a", note: "请补测试" })).ok, true);
  assert.deepEqual(calls, [
    { method: "task.accept", params: { workspaceId: "ws-a", taskPath: "temp/tasks/a.md", deliveryId: "dl-a", actor: "user" } },
    { method: "task.reject", params: { workspaceId: "ws-a", taskPath: "temp/tasks/a.md", deliveryId: "dl-a", actor: "user", note: "请补测试", resume: true } },
  ]);

  const rendererRequests: unknown[] = [];
  const transport = async (request: unknown) => {
    rendererRequests.push(request);
    return { ok: true as const, value: { workspaceId: "ws-a" } };
  };
  assert.equal((await acceptDelivery(
    transport,
    "ws-a",
    "temp/tasks/a.md",
    "dl-a"
  )).ok, true);
  assert.equal((await rejectDelivery(
    transport,
    "ws-a",
    "temp/tasks/a.md",
    "dl-a",
    "请补测试"
  )).ok, true);
  assert.deepEqual(rendererRequests, [
    {
      operation: "acceptDelivery",
      workspaceId: "ws-a",
      taskPath: "temp/tasks/a.md",
      deliveryId: "dl-a",
    },
    {
      operation: "rejectDelivery",
      workspaceId: "ws-a",
      taskPath: "temp/tasks/a.md",
      deliveryId: "dl-a",
      note: "请补测试",
    },
  ]);
});

test("Decision Request exposes only option/custom/deny and preserves RPC errors", async () => {
  const responses = [
    { kind: "option", optionId: "yes" } as const,
    { kind: "custom", text: "按 B 方案" } as const,
    { kind: "deny" } as const,
  ];
  const seen: unknown[] = [];
  for (const response of responses) {
    const result = await respondDecision(
      async (request) => {
        seen.push(request);
        return { ok: true, value: { workspaceId: "ws-a", taskPath: "temp/tasks/a.md", requestId: "dr-a" } };
      },
      "ws-a",
      "temp/tasks/a.md",
      "dr-a",
      response
    );
    assert.equal(result.ok, true);
  }
  assert.deepEqual(seen.map((item) => (item as { response: unknown }).response), responses);

  const rpc = await handleDesktopCollaborationRequest({
    call: async () => { throw new ServiceRpcError({ code: -32001, message: "authority denied", data: { requestId: "dr-a" } }); },
  } as never, {
    operation: "respondDecision",
    workspaceId: "ws-a",
    taskPath: "temp/tasks/a.md",
    requestId: "dr-a",
    response: { kind: "deny" },
  });
  assert.equal(rpc.ok, false);
  if (!rpc.ok) {
    assert.equal(rpc.error.kind, "rpc");
    assert.equal(rpc.error.code, -32001);
    assert.deepEqual(rpc.error.data, { requestId: "dr-a" });
  }
});

test("snapshot identity and IPC envelopes fail closed", async () => {
  const invalidService = await handleDesktopCollaborationRequest({
    call: async (method: string) => {
      if (method === "registry.roles") return { workspaceId: "ws-a", roles: [] };
      if (method === "connection.list") return { connections: [] };
      if (method === "interaction.listPending") return { workspaceId: "ws-a", items: [], counts: { decisionRequest: 0, toolApproval: 0, delivery: 0, total: 0 } };
      return { workspaceId: "ws-a", nodeId: "cx-wrong", activeTask: null };
    },
  } as never, { operation: "snapshot", workspaceId: "ws-a", nodeId: "cx-a" });
  assert.equal(invalidService.ok, false);
  if (!invalidService.ok) assert.equal(invalidService.error.kind, "invalid-response");

  const mismatch = await readCollaborationSnapshot(
    async () => ({ ok: true, value: { workspaceId: "ws-other" } }),
    "ws-a",
    "cx-a"
  );
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.issue.kind, "corrupt");

  const corruptEnvelope = await readCollaborationSnapshot(
    async () => ({ value: {} } as never),
    "ws-a",
    "cx-a"
  );
  assert.equal(corruptEnvelope.ok, false);
  if (!corruptEnvelope.ok) assert.equal(corruptEnvelope.issue.kind, "corrupt");
});

test("exact Task pending items fail loud when taskPath disagrees with the collaboration pointer", async () => {
  const { client } = serviceFixture();
  const corruptClient = {
    call: async (method: string, params?: Record<string, unknown>) => {
      if (method !== "interaction.listPending") return client.call(method, params);
      return {
        workspaceId: "ws-a",
        items: [{
          kind: "decisionRequest",
          id: "dr-corrupt",
          workspaceId: "ws-a",
          createdAt: "2026-08-04T00:00:00Z",
          taskPath: "temp/tasks/foreign.md",
          taskId: "tk-a",
          sessionId: "ss-a",
          target: { kind: "user", id: "user" },
          question: "错误来源",
          options: [],
        }],
        counts: { decisionRequest: 1, toolApproval: 0, delivery: 0, total: 1 },
      };
    },
  };
  const result = await handleDesktopCollaborationRequest(corruptClient as never, {
    operation: "snapshot",
    workspaceId: "ws-a",
    nodeId: "cx-a",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "invalid-response");
});

test("joined ready Delivery must have an exact pending review pointer", async () => {
  const { client } = serviceFixture();
  const missingPendingDelivery = {
    call: async (method: string, params?: Record<string, unknown>) => {
      if (method !== "interaction.listPending") return client.call(method, params);
      return {
        workspaceId: "ws-a",
        items: [],
        counts: { decisionRequest: 0, toolApproval: 0, delivery: 0, total: 0 },
      };
    },
  };
  const result = await handleDesktopCollaborationRequest(
    missingPendingDelivery as never,
    { operation: "snapshot", workspaceId: "ws-a", nodeId: "cx-a" }
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "invalid-response");
});

test("snapshot boundary rejects Session identity that disagrees with the exact Task join", async () => {
  const { client } = serviceFixture();
  const corruptClient = {
    call: async (method: string, params?: Record<string, unknown>) => {
      const value = await client.call(method, params);
      if (method !== "session.get") return value;
      return {
        session: {
          ...(value as { session: Record<string, unknown> }).session,
          sessionId: "ss-foreign",
        },
      };
    },
  };
  const result = await readCollaborationSnapshot(
    (request) => handleDesktopCollaborationRequest(corruptClient as never, request),
    "ws-a",
    "cx-a"
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issue.kind, "invalid-response");
});

test("Session workspace, lastTaskId, and Task sessionId must all match the exact Node join", async () => {
  const corruptions: Array<{
    method: string;
    mutate: (value: unknown) => unknown;
  }> = [
    {
      method: "session.get",
      mutate: (value) => ({
        session: {
          ...(value as { session: Record<string, unknown> }).session,
          workspace: "ws-foreign",
        },
      }),
    },
    {
      method: "session.get",
      mutate: (value) => ({
        session: {
          ...(value as { session: Record<string, unknown> }).session,
          lastTaskId: "tk-foreign",
        },
      }),
    },
    {
      method: "task.get",
      mutate: (value) => ({
        ...(value as Record<string, unknown>),
        task: {
          ...((value as { task: Record<string, unknown> }).task),
          sessionId: "ss-foreign",
        },
      }),
    },
  ];
  for (const corruption of corruptions) {
    const { client } = serviceFixture();
    const corruptClient = {
      call: async (method: string, params?: Record<string, unknown>) => {
        const value = await client.call(method, params);
        return method === corruption.method ? corruption.mutate(value) : value;
      },
    };
    const result = await handleDesktopCollaborationRequest(corruptClient as never, {
      operation: "snapshot",
      workspaceId: "ws-a",
      nodeId: "cx-a",
    });
    assert.equal(result.ok, false, corruption.method);
    if (!result.ok) assert.equal(result.error.kind, "invalid-response");
  }
});
