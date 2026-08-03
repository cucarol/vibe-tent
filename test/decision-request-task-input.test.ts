import assert from "node:assert/strict";
import test from "node:test";

import type { AnsweredDecisionRequest } from "../src/core/decision-request.js";
import {
  decisionResponseTaskInputText,
  formatTaskInputPrompt,
  taskInputIdForDecisionRequest,
} from "../src/service/task-input-store.js";

const answered: AnsweredDecisionRequest = {
  id: "dr-0123456789",
  taskId: "tk-taskone",
  requester: { kind: "session", id: "ss-session1" },
  target: { kind: "user", id: "user" },
  question: "Choose a direction.",
  options: [{ id: "a", label: "Direction A" }],
  status: "answered",
  response: { kind: "option", optionId: "a" },
  resolvedBy: { kind: "user", id: "user" },
};

test("DecisionRequest maps to one deterministic TaskInput identity", () => {
  assert.equal(taskInputIdForDecisionRequest(answered.id), "ti-0123456789");
  assert.throws(() => taskInputIdForDecisionRequest("dr-not-canonical"));
});

test("Decision response TaskInput preserves the exact structured answer", () => {
  const text = decisionResponseTaskInputText(answered);
  assert.match(text, /^requestId: dr-0123456789/m);
  assert.match(text, /^response: option/m);
  assert.match(text, /^optionId: a/m);
  assert.match(text, /^optionLabel: "Direction A"/m);

  const prompt = formatTaskInputPrompt({
    id: taskInputIdForDecisionRequest(answered.id),
    workspaceId: "ws-one",
    taskPath: "temp/tasks/task.md",
    kind: "decision-response",
    text,
    status: "pending",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  assert.match(prompt, /^## Decision Response/);
  assert.match(prompt, /kind: decision-response/);
  assert.match(prompt, /requestId: dr-0123456789/);
});
