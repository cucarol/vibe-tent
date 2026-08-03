/**
 * Desktop A2U pending closed-loop: pure adapters + CLIENT_METHODS wiring.
 * No Electron; no full-suite run.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_METHODS } from "../src/service/types.js";
import {
  PENDING_INTERACTION_EVENT_TYPES,
  PENDING_INTERACTION_GAPS,
  buildTaskSendInputPayload,
  buildToolApprovalResolvePayload,
  buildDecisionDenyPayload,
  buildDecisionResponsePayload,
  isPendingInteractionEventType,
  isTaskProjectionEventType,
  normalizeProposalList,
  normalizeTaskInput,
  normalizeTaskInputList,
  normalizeToolApproval,
  normalizeToolApprovalList,
  normalizeDecisionRequest,
  normalizeDecisionRequestList,
  pendingInteractionCount,
  summarizeToolApprovalOptions,
  taskInputKindLabel,
} from "../src/desktop/workbench/pending-interactions.js";
import {
  DESKTOP_CONTRACT_GAPS,
  contractGapIds,
  findContractGap,
} from "../src/desktop/renderer/main/contract-gaps.js";

test("CLIENT_METHODS covers all pending closed-loop RPCs used by Desktop", () => {
  for (const m of [
    "toolApproval.listPending",
    "toolApproval.get",
    "toolApproval.approveOnce",
    "toolApproval.deny",
    "decisionRequest.listPending",
    "decisionRequest.get",
    "decisionRequest.respond",
    "decisionRequest.escalate",
    "interaction.listPending",
    "taskInput.listPending",
    "taskInput.get",
    "taskInput.ack",
    "task.sendInput",
    "delivery.list",
    "delivery.get",
    "task.accept",
    "task.reject",
    "task.interrupt",
    "proposal.list",
    "proposal.resolve",
  ]) {
    assert.ok(
      CLIENT_METHODS.includes(m as (typeof CLIENT_METHODS)[number]),
      `missing CLIENT_METHODS entry: ${m}`
    );
  }
});

test("normalizeDecisionRequest keeps exact requester, target, task, and options", () => {
  const item = normalizeDecisionRequest({
    id: "dr-1",
    taskPath: "temp/executor/tasks/t1.md",
    taskId: "tk-1",
    requester: { kind: "session", id: "ss-1" },
    target: { kind: "role", id: "rl-reviewer" },
    question: "Which approach?",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "", label: "skip" },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(item);
  assert.equal(item!.kind, "decisionRequest");
  assert.equal(item!.taskId, "tk-1");
  assert.deepEqual(item!.requester, { kind: "session", id: "ss-1" });
  assert.deepEqual(item!.target, { kind: "role", id: "rl-reviewer" });
  assert.equal(item!.options.length, 2);

  assert.equal(normalizeDecisionRequest({ id: "x" }), null);
  assert.deepEqual(
    normalizeDecisionRequestList({
      requests: [
        {
          id: "dr-2",
          taskPath: "temp/r/tasks/t.md",
          taskId: "tk-2",
          requester: { kind: "session", id: "ss-2" },
          target: { kind: "user", id: "user" },
          question: "ok?",
          createdAt: "t",
        },
      ],
    }).map((a) => a.id),
    ["dr-2"]
  );
});

test("toolApproval paramsSummary uses options only — never invents args", () => {
  assert.equal(
    summarizeToolApprovalOptions([
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", kind: "reject" },
    ]),
    "Allow once · reject"
  );
  const item = normalizeToolApproval({
    id: "ta-1",
    sessionId: "ss-tool",
    toolTitle: "read_file",
    role: "executor",
    options: [{ optionId: "allow_once", name: "Allow once" }],
    createdAt: "t",
    expiresAt: "t2",
    // Malicious / future field — must not be copied into summary blindly as "params"
    arguments: { path: "/etc/passwd" },
  });
  assert.ok(item);
  assert.equal(item!.paramsSummary, "Allow once");
  assert.ok(!JSON.stringify(item).includes("/etc/passwd"));
  assert.equal(normalizeToolApprovalList({ approvals: [item!] }).length, 1);
});

test("normalizeTaskInput is independent type and drops non-pending", () => {
  const pending = normalizeTaskInput({
    id: "ti-1",
    taskPath: "temp/executor/tasks/t.md",
    role: "executor",
    kind: "user-input",
    text: "please continue",
    contextRefs: ["cx-1"],
    status: "pending",
    createdAt: "t",
  });
  assert.ok(pending);
  assert.equal(pending!.kind, "taskInput");
  assert.equal(pending!.inputKind, "user-input");
  assert.equal(taskInputKindLabel(pending!.inputKind), "TASK INPUT");
  assert.equal(taskInputKindLabel("review-feedback"), "REVIEW FEEDBACK");

  assert.equal(
    normalizeTaskInput({
      id: "ti-2",
      taskPath: "temp/executor/tasks/t.md",
      status: "consumed",
      text: "gone",
    }),
    null
  );

  const list = normalizeTaskInputList({
    inputs: [
      {
        id: "ti-3",
        taskPath: "temp/x/tasks/t.md",
        status: "pending",
        kind: "review-feedback",
        text: "need tests",
      },
      {
        id: "ti-4",
        taskPath: "temp/x/tasks/t.md",
        status: "delivered",
        text: "old",
      },
    ],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0]!.inputKind, "review-feedback");
});

test("proposal normalize keeps only pending triage rows", () => {
  const list = normalizeProposalList({
    proposals: [
      { path: "p1.md", nodeId: "cx", role: "r", status: "pending", body: "hi" },
      { path: "p2.md", nodeId: "cx", role: "r", status: "accepted", body: "no" },
    ],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0]!.kind, "proposal");
});

test("pendingInteractionCount sums independent types without double-count delivery", () => {
  assert.equal(
    pendingInteractionCount({
      decisionRequests: [{}, {}],
      toolApprovals: [{}, {}],
      taskInputs: [{}],
      proposals: [{}],
    }),
    6
  );
  assert.equal(pendingInteractionCount({}), 0);
});

test("DecisionResponse payload builders are authority-free and fail-loud on empty reply", () => {
  const bad = buildDecisionResponsePayload("ws", "task.md", "dr-1", {});
  assert.equal(bad.ok, false);

  const ok = buildDecisionResponsePayload("ws", "task.md", "dr-1", {
    text: "  ship it  ",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.payload.response, { kind: "custom", text: "ship it" });
  }

  assert.deepEqual(buildDecisionDenyPayload("ws", "task.md", "dr-1"), {
    workspaceId: "ws",
    taskPath: "task.md",
    requestId: "dr-1",
    response: { kind: "deny" },
  });
  const allow = buildToolApprovalResolvePayload("ta-1", true);
  assert.equal(allow.method, "toolApproval.approveOnce");
  assert.deepEqual(allow.params, { approvalId: "ta-1", actor: "user" });
  const deny = buildToolApprovalResolvePayload("ta-1", false);
  assert.equal(deny.method, "toolApproval.deny");

  const send = buildTaskSendInputPayload("ws", "temp/r/tasks/t.md", "  more  ");
  assert.equal(send.ok, true);
  if (send.ok) {
    assert.equal(send.payload.text, "more");
    assert.equal(send.payload.actor, "user");
  }
  assert.equal(buildTaskSendInputPayload("ws", "t", "  ").ok, false);
});

test("pending interaction event types include tool/decisionRequest/taskInput/delivery", () => {
  for (const t of [
    "toolApproval.pending",
    "toolApproval.resolved",
    "decisionRequest.pending",
    "decisionRequest.resolved",
    "taskInput.pending",
    "taskInput.delivered",
    "taskInput.consumed",
    "taskInput.cancelled",
    "delivery.updated",
    "task.state",
    "proposal.updated",
  ]) {
    assert.ok(isPendingInteractionEventType(t), t);
  }
  assert.equal(isPendingInteractionEventType("session.live"), false);
  assert.ok(isTaskProjectionEventType("task.state"));
  assert.ok(isTaskProjectionEventType("delivery.updated"));
  assert.equal(PENDING_INTERACTION_EVENT_TYPES.length > 8, true);
});

test("contract gaps record field holes without claiming missing RPCs that exist", () => {
  const ids = contractGapIds();
  assert.ok(ids.includes("toolApproval.params"));
  assert.ok(ids.includes("taskInput.global-list"));
  // Real methods stay in CLIENT_METHODS; gap ids use placeholder method names.
  for (const gap of DESKTOP_CONTRACT_GAPS) {
    if (
      gap.id === "toolApproval.params" ||
      gap.id === "taskInput.global-list"
    ) {
      for (const m of gap.methods) {
        assert.equal(
          CLIENT_METHODS.includes(m as (typeof CLIENT_METHODS)[number]),
          false,
          `gap method ${m} must not collide with real CLIENT_METHODS`
        );
      }
    }
  }
  assert.match(findContractGap("toolApproval.params")!.fallback, /options/);
  assert.ok(PENDING_INTERACTION_GAPS.some((g) => g.id === "toolApproval.params"));
});
