import assert from "node:assert/strict";
import { test } from "node:test";
import { handleDesktopCollaborationRequest } from "../src/desktop/main/collaboration-ipc-handler.js";
import { acceptTaskResult, readDispatchTargets, rejectTaskResult, respondDecision } from "../src/desktop/renderer-next/gateway/collaboration-protocol.js";
import { normalizeWorkspaceCollaboration } from "../src/desktop/renderer-next/model/workspace-collaboration-view.js";

test("workspace collaboration strips Task identity and accepts workspace-level null selection", () => {
  const raw = {
    workspaceId: "ws-a", selectedNode: null,
    inbox: { items: [{ kind: "result", resultId: "rs-a", taskId: "tk-a", summary: "完成", createdAt: "2026-08-12T00:00:00Z" }], counts: { result: 1, decision: 0, total: 1 } },
  };
  const normalized = normalizeWorkspaceCollaboration(raw, "ws-a", null);
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  assert.equal(normalized.value.selectedNode, null);
  assert.equal(JSON.stringify(normalized.value).includes("tk-secret"), false);
});

test("workspace collaboration validates exact selected identity and minimal action DTOs", () => {
  const raw = {
    workspaceId: "ws-a",
    selectedNode: { nodeId: "cx-a", activeTasks: [{ taskId: "tk-a", state: "submitted", responsibility: { kind: "role", roleId: "rl-ui", displayName: "界面" }, execution: { kind: "connection", connectionId: "cn-a", displayName: "本机" }, readyResult: { resultId: "rs-a", summary: "完成", createdAt: "2026-08-12T00:00:00Z" }, pendingDecision: null }], statusDetail: { taskId: "tk-a", kind: "failed", error: "失败", executionSessionId: "SS-A" } },
    inbox: { items: [{ kind: "decision", requestId: "dr-a", taskId: "tk-a", nodeIds: ["cx-a"], question: "继续？", options: [{ id: "yes", label: "继续" }], createdAt: "2026-08-12T00:00:00Z" }], counts: { result: 0, decision: 1, total: 1 } },
  };
  const normalized = normalizeWorkspaceCollaboration(raw, "ws-a", "cx-a");
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  const serialized = JSON.stringify(normalized.value);
  assert.equal(
    serialized.includes("\"taskId\":\"tk-a\""),
    true,
    "selected terminal return retains its exact Task identity"
  );
  assert.equal(serialized.includes("taskPath"), false);
  for (const forbidden of [
    "activeSession",
    "sessionState",
    "alive",
    "isTurnActive",
    "provider",
    "transport",
  ]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false, forbidden);
  }
  assert.equal(normalized.value.selectedNode?.activeTasks[0]?.readyResult?.resultId, "rs-a");
  assert.equal(normalized.value.selectedNode?.statusDetail?.taskId, "tk-a");
  assert.equal(normalized.value.selectedNode?.statusDetail?.error, "失败");
  assert.equal(normalized.value.selectedNode?.statusDetail?.executionSessionId, "SS-A");
});

test("workspace collaboration fails closed on mismatch, extra infrastructure and corrupt counts", () => {
  const base = { workspaceId: "ws-a", selectedNode: null, inbox: { items: [], counts: { result: 0, decision: 0, total: 0 } } };
  assert.equal(normalizeWorkspaceCollaboration({ ...base, selectedNode: { nodeId: "cx-a", activeTasks: [] } }, "ws-a", null).ok, false);
  assert.equal(normalizeWorkspaceCollaboration({ ...base, sessionId: "ss-no" }, "ws-a", null).ok, false);
  assert.equal(normalizeWorkspaceCollaboration({ ...base, inbox: { items: [], counts: { result: 0, decision: 0, total: 1 } } }, "ws-a", null).ok, false);
});

test("main collaboration handler returns minimal targets and ID-only mutations", async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const client = { call: async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "registry.roles") return { workspaceId: "ws-a", roles: [{ roleId: "rl-ui", displayName: "界面", description: "UI", prompt: "SECRET" }] };
    if (method === "connection.list") return { connections: [{ connectionId: "cn-a", displayName: "本机", provider: "secret-provider", command: "SECRET" }] };
    if (method === "task.dispatch") return { workspaceId: "ws-a", taskPath: "secret/path.md" };
    return { workspaceId: "ws-a" };
  }};
  const targets = await handleDesktopCollaborationRequest(client as never, { operation: "targets", workspaceId: "ws-a" });
  assert.equal(targets.ok, true);
  assert.equal(JSON.stringify(targets).includes("SECRET"), false);
  await handleDesktopCollaborationRequest(client as never, { operation: "acceptTaskResult", workspaceId: "ws-a", resultId: "rs-a" });
  await handleDesktopCollaborationRequest(client as never, { operation: "rejectTaskResult", workspaceId: "ws-a", resultId: "rs-a", note: "补充", resume: true });
  await handleDesktopCollaborationRequest(client as never, { operation: "respondDecision", workspaceId: "ws-a", requestId: "dr-a", response: { kind: "deny" } });
  assert.deepEqual(calls.slice(-3), [
    { method: "task.accept", params: { workspaceId: "ws-a", resultId: "rs-a", actor: "user" } },
    { method: "task.reject", params: { workspaceId: "ws-a", resultId: "rs-a", actor: "user", note: "补充", resume: true } },
    { method: "decisionRequest.respond", params: { workspaceId: "ws-a", requestId: "dr-a", response: { kind: "deny" } } },
  ]);
});

test("old taskPath mutation shapes fail before Service access", async () => {
  let calls = 0;
  const client = { call: async () => { calls += 1; return {}; } };
  const result = await handleDesktopCollaborationRequest(client as never, { operation: "acceptTaskResult", workspaceId: "ws-a", resultId: "rs-a", taskPath: "old.md" });
  assert.equal(result.ok, false); assert.equal(calls, 0);
});

test("renderer target and mutation transport emits no Task identity", async () => {
  const requests: unknown[] = [];
  const transport = async (request: unknown) => { requests.push(request); return { ok: true, value: (request as { operation: string }).operation === "targets" ? { workspaceId: "ws-a", targets: [] } : { workspaceId: "ws-a" } }; };
  assert.equal((await readDispatchTargets(transport as never, "ws-a")).ok, true);
  assert.equal((await acceptTaskResult(transport as never, "ws-a", "rs-a")).ok, true);
  assert.equal((await rejectTaskResult(transport as never, "ws-a", "rs-a", "补充")).ok, true);
  assert.equal((await respondDecision(transport as never, "ws-a", "dr-a", { kind: "deny" })).ok, true);
  const serialized = JSON.stringify(requests);
  assert.equal(serialized.includes("taskPath"), false); assert.equal(serialized.includes("taskId"), false);
});
