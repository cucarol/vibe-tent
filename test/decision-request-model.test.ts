import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerDecisionRequest,
  escalateDecisionRequest,
  validateDecisionRequest,
  validateDecisionResponse,
  type PendingDecisionRequest,
} from "../src/core/decision-request.js";

function pending(overrides: Partial<PendingDecisionRequest> = {}): PendingDecisionRequest {
  return {
    id: "dr-1",
    taskId: "tk-12345678",
    requester: { kind: "role", id: "planner" },
    target: { kind: "role", id: "implementer" },
    question: "Which implementation should ship?",
    options: [
      { id: "safe", label: "Use the safe implementation" },
      { id: "fast", label: "Use the fast implementation" },
    ],
    blocking: true,
    status: "pending",
    ...overrides,
  };
}

test("decision request: validates one shape and answers exactly once", () => {
  const request = validateDecisionRequest(pending());
  const answered = answerDecisionRequest(request, { kind: "option", optionId: "safe" });

  assert.equal(answered.status, "answered");
  assert.deepEqual(answered.response, { kind: "option", optionId: "safe" });
  assert.deepEqual(answered.target, request.target);
  assert.throws(
    () => answerDecisionRequest(answered, { kind: "deny" }),
    /already answered/
  );
});

test("decision response: custom and deny are variants, not option records", () => {
  const request = validateDecisionRequest(pending({ options: [] }));
  assert.deepEqual(validateDecisionResponse({ kind: "deny" }, request.options), { kind: "deny" });
  assert.deepEqual(answerDecisionRequest(request, { kind: "custom", text: "A considered answer" }).response, {
    kind: "custom",
    text: "A considered answer",
  });
  assert.deepEqual(answerDecisionRequest(request, { kind: "deny" }).response, { kind: "deny" });
  assert.throws(() => answerDecisionRequest(request, { kind: "custom", text: "   " }), /non-empty/);
  assert.throws(() => answerDecisionRequest(request, { kind: "option", optionId: "missing" }), /not one/);
  assert.throws(() => validateDecisionResponse({ kind: "deny", text: "ignored" }, request.options), /unexpected/);
});

test("decision request: escalation changes the same role-targeted request to user", () => {
  const request = validateDecisionRequest(pending());
  const escalated = escalateDecisionRequest(request);

  assert.equal(escalated.id, request.id);
  assert.equal(escalated.taskId, request.taskId);
  assert.deepEqual(escalated.requester, request.requester, "requester is the audit identity");
  assert.deepEqual(escalated.target, { kind: "user", id: "user" });
  assert.deepEqual(escalated.options, request.options);
  assert.equal(escalated.question, request.question);
  assert.equal(escalated.status, "pending");
  assert.throws(() => escalateDecisionRequest({ ...request, target: { kind: "user", id: "user" } }), /role-targeted/);
});

test("decision request: strict validation rejects aliases, extra fields, and malformed actors", () => {
  assert.throws(
    () => validateDecisionRequest({ ...pending(), choices: pending().options }),
    /unexpected or missing fields/
  );
  assert.throws(
    () => validateDecisionRequest({ ...pending(), options: [{ id: "safe", label: "Safe" }, { id: "safe", label: "Again" }] }),
    /Duplicate/
  );
  assert.throws(
    () => validateDecisionRequest({ ...pending(), target: { kind: "user", id: "other-user" } }),
    /must be user/
  );
});
