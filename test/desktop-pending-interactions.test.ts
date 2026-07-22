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
  buildA2AResolvePayload,
  buildTaskSendInputPayload,
  buildToolApprovalResolvePayload,
  buildUserAskDenyPayload,
  buildUserAskReplyPayload,
  isPendingInteractionEventType,
  isTaskProjectionEventType,
  normalizeA2AApproval,
  normalizeA2AList,
  normalizeProposalList,
  normalizeTaskInput,
  normalizeTaskInputList,
  normalizeToolApproval,
  normalizeToolApprovalList,
  normalizeUserAsk,
  normalizeUserAskList,
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
    "a2a.listPending",
    "a2a.resolve",
    "toolApproval.listPending",
    "toolApproval.get",
    "toolApproval.approveOnce",
    "toolApproval.deny",
    "userAsk.listPending",
    "userAsk.get",
    "userAsk.reply",
    "userAsk.deny",
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

test("normalizeUserAsk keeps role/task/choices and never invents profile", () => {
  const item = normalizeUserAsk({
    id: "ua-1",
    taskPath: "temp/executor/tasks/t1.md",
    role: "executor",
    question: "Which approach?",
    choices: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "", label: "skip" },
    ],
    sessionId: "ss-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(item);
  assert.equal(item!.kind, "userAsk");
  assert.equal(item!.role, "executor");
  assert.equal(item!.choices.length, 2);
  assert.equal(item!.sessionId, "ss-1");
  assert.equal((item as { profileId?: string }).profileId, undefined);

  assert.equal(normalizeUserAsk({ id: "x" }), null);
  assert.deepEqual(
    normalizeUserAskList({
      asks: [
        {
          id: "ua-2",
          taskPath: "temp/r/tasks/t.md",
          question: "ok?",
          createdAt: "t",
        },
      ],
    }).map((a) => a.id),
    ["ua-2"]
  );
});

test("normalizeA2AApproval requires requester role + target profile + task", () => {
  const item = normalizeA2AApproval({
    id: "ap-1",
    taskPath: "temp/orch/tasks/t.md",
    role: "orchestrator",
    profileId: "grok-acp-default",
    policy: "ask",
    callerKind: "role",
    createdAt: "t",
  });
  assert.ok(item);
  assert.equal(item!.kind, "a2a");
  assert.equal(item!.role, "orchestrator");
  assert.equal(item!.profileId, "grok-acp-default");
  assert.equal(normalizeA2AApproval({ id: "ap-1", role: "x" }), null);
  assert.equal(normalizeA2AList({ approvals: [item!] }).length, 1);
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
      { path: "p1.md", boxId: "cx", role: "r", status: "pending", body: "hi" },
      { path: "p2.md", boxId: "cx", role: "r", status: "accepted", body: "no" },
    ],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0]!.kind, "proposal");
});

test("pendingInteractionCount sums independent types without double-count delivery", () => {
  assert.equal(
    pendingInteractionCount({
      userAsks: [{}, {}],
      a2aApprovals: [{}],
      toolApprovals: [{}, {}],
      taskInputs: [{}],
      proposals: [{}],
    }),
    7
  );
  assert.equal(pendingInteractionCount({}), 0);
});

test("resolve payload builders are user-actor and fail-loud on empty reply", () => {
  const bad = buildUserAskReplyPayload("ua-1", {});
  assert.equal(bad.ok, false);

  const ok = buildUserAskReplyPayload("ua-1", { answer: "  ship it  ", choiceId: "a" });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.payload.actor, "user");
    assert.equal(ok.payload.answer, "ship it");
    assert.equal(ok.payload.choiceId, "a");
  }

  assert.deepEqual(buildUserAskDenyPayload("ua-1"), { askId: "ua-1", actor: "user" });
  assert.deepEqual(buildA2AResolvePayload("ap-1", "approve"), {
    approvalId: "ap-1",
    decision: "approve",
    actor: "user",
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

test("pending interaction event types include a2a/tool/userAsk/taskInput/delivery", () => {
  for (const t of [
    "a2a.ask",
    "a2a.resolved",
    "toolApproval.pending",
    "toolApproval.resolved",
    "userAsk.pending",
    "userAsk.resolved",
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
  assert.ok(ids.includes("userAsk.agent-profile"));
  assert.ok(ids.includes("taskInput.global-list"));
  // Real methods stay in CLIENT_METHODS; gap ids use placeholder method names.
  for (const gap of DESKTOP_CONTRACT_GAPS) {
    if (
      gap.id === "toolApproval.params" ||
      gap.id === "userAsk.agent-profile" ||
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
