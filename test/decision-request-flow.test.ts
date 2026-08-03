import assert from "node:assert/strict";
import test from "node:test";

import type { PendingDecisionRequest } from "../src/core/decision-request.js";
import {
  assertDecisionResponseTaskInputMatches,
  prepareDecisionResponse,
} from "../src/service/decision-request-flow.js";

const request: PendingDecisionRequest = {
  id: "dr-0123456789",
  taskId: "tk-taskone",
  requester: { kind: "session", id: "ss-session1" },
  target: { kind: "role", id: "rl-reviewer" },
  question: "Choose the implementation.",
  options: [{ id: "a", label: "Implementation A" }],
  status: "pending",
};

const binding = {
  workspaceId: "ws-one",
  taskPath: "temp/tasks/task.md",
  taskId: request.taskId,
  sessionId: request.requester.id,
  role: "规划",
};

test("DecisionRequest response prepares one exact-Task deterministic TaskInput", () => {
  const prepared = prepareDecisionResponse({
    request,
    responder: request.target,
    response: { kind: "option", optionId: "a" },
    binding,
    now: "2026-08-03T00:00:00.000Z",
  });
  assert.equal(prepared.answered.status, "answered");
  assert.equal(prepared.taskInput.id, "ti-0123456789");
  assert.equal(prepared.taskInput.kind, "decision-response");
  assert.equal(prepared.taskInput.taskId, request.taskId);
  assert.equal(prepared.taskInput.sessionId, request.requester.id);
  assert.match(prepared.taskInput.text || "", /optionLabel: "Implementation A"/);
});

test("DecisionRequest response rejects cross-Task, cross-Session, and wrong authority", () => {
  const common = {
    request,
    responder: request.target,
    response: { kind: "deny" } as const,
    binding,
    now: "2026-08-03T00:00:00.000Z",
  };
  assert.throws(
    () => prepareDecisionResponse({ ...common, binding: { ...binding, taskId: "tk-other" } }),
    /Task mismatch/
  );
  assert.throws(
    () => prepareDecisionResponse({ ...common, binding: { ...binding, sessionId: "ss-other" } }),
    /Session mismatch/
  );
  assert.throws(
    () =>
      prepareDecisionResponse({
        ...common,
        responder: { kind: "role", id: "rl-other" },
      }),
    /exactly match target/
  );
});

test("DecisionRequest retry accepts the same durable TaskInput but rejects a conflicting row", () => {
  const prepared = prepareDecisionResponse({
    request,
    responder: request.target,
    response: { kind: "deny" },
    binding,
    now: "2026-08-03T00:00:00.000Z",
  });
  assert.doesNotThrow(() =>
    assertDecisionResponseTaskInputMatches(
      { ...prepared.taskInput, status: "failed", lastError: "provider unavailable" },
      prepared.taskInput
    )
  );
  assert.throws(
    () =>
      assertDecisionResponseTaskInputMatches(
        { ...prepared.taskInput, text: "different answer" },
        prepared.taskInput
      ),
    /conflicts on immutable field text/
  );
});
