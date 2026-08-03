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
    id: "dr-0123456789",
    taskId: "tk-12345678",
    requester: { kind: "session", id: "ss-executor1" },
    target: { kind: "role", id: "implementer" },
    question: "Which implementation should ship?",
    options: [
      { id: "safe", label: "Use the safe implementation" },
      { id: "fast", label: "Use the fast implementation" },
    ],
    status: "pending",
    ...overrides,
  };
}

test("decision request: validates one shape and answers exactly once", () => {
  const request = validateDecisionRequest(pending());
  const answered = answerDecisionRequest(
    request,
    { kind: "role", id: "implementer" },
    { kind: "option", optionId: "safe" }
  );

  assert.equal(answered.status, "answered");
  assert.deepEqual(answered.response, { kind: "option", optionId: "safe" });
  assert.deepEqual(answered.resolvedBy, { kind: "role", id: "implementer" });
  assert.deepEqual(validateDecisionRequest(answered), answered);
  assert.deepEqual(answered.target, request.target);
  assert.throws(
    () => validateDecisionRequest({ ...answered, resolvedBy: { kind: "role", id: "reviewer" } }),
    /exactly match target role:implementer/
  );
  assert.throws(
    () => answerDecisionRequest(answered, { kind: "role", id: "implementer" }, { kind: "deny" }),
    /already answered/
  );
});

test("decision response: custom and deny are variants, not option records", () => {
  const request = validateDecisionRequest(
    pending({ options: [], target: { kind: "user", id: "user" } })
  );
  const user = { kind: "user", id: "user" } as const;
  assert.deepEqual(validateDecisionResponse({ kind: "deny" }, request.options), { kind: "deny" });
  assert.deepEqual(answerDecisionRequest(request, user, { kind: "custom", text: "A considered answer" }).response, {
    kind: "custom",
    text: "A considered answer",
  });
  assert.deepEqual(answerDecisionRequest(request, user, { kind: "deny" }).response, { kind: "deny" });
  assert.throws(() => answerDecisionRequest(request, user, { kind: "custom", text: "   " }), /non-empty/);
  assert.throws(() => answerDecisionRequest(request, user, { kind: "option", optionId: "missing" }), /not one/);
  assert.throws(() => validateDecisionResponse({ kind: "deny", text: "ignored" }, request.options), /unexpected/);
});

test("decision request: responder must exactly match target authority", () => {
  const userRequest = validateDecisionRequest(
    pending({ target: { kind: "user", id: "user" } })
  );
  assert.throws(
    () => answerDecisionRequest(userRequest, { kind: "role", id: "implementer" }, { kind: "deny" }),
    /exactly match target user:user/
  );

  const roleRequest = validateDecisionRequest(pending());
  assert.throws(
    () => answerDecisionRequest(roleRequest, { kind: "role", id: "reviewer" }, { kind: "deny" }),
    /exactly match target role:implementer/
  );
});

test("decision request: escalation changes the same role-targeted request to user", () => {
  const request = validateDecisionRequest(pending());
  const escalated = escalateDecisionRequest(request);

  assert.equal(escalated.id, request.id);
  assert.equal(escalated.taskId, request.taskId);
  assert.deepEqual(escalated.requester, request.requester, "executing Session identity is preserved");
  assert.deepEqual(escalated.target, { kind: "user", id: "user" });
  assert.deepEqual(escalated.options, request.options);
  assert.equal(escalated.question, request.question);
  assert.equal(escalated.status, "pending");
  assert.throws(() => escalateDecisionRequest({ ...request, target: { kind: "user", id: "user" } }), /role-targeted/);

  const answered = answerDecisionRequest(
    request,
    { kind: "role", id: "implementer" },
    { kind: "deny" }
  );
  assert.throws(() => escalateDecisionRequest(answered), /pending/);
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
  assert.throws(
    () => validateDecisionRequest({ ...pending(), requester: { kind: "role", id: "planner" } }),
    /kind must be session/
  );
  assert.throws(
    () => validateDecisionRequest({ ...pending(), requester: { kind: "session", id: "   " } }),
    /non-empty/
  );
});
