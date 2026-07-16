// Task / delivery domain model + pure state machine (B0 task-api.md).
// Operational records only — not OKF concepts.

import { makeConceptId, type RandomSource } from "./id.js";

/** Canonical task states (task-api §2.1). */
export type TaskState =
  | "queued"
  | "running"
  | "waiting"
  | "delivered"
  | "accepted"
  | "rejected"
  | "interrupted"
  | "failed";

/** Legacy envelope two-state (B2 / dogfood CLI). */
export type LegacyTaskStatus = "pending" | "taken";

export type DeliveryPolicy = "manual" | "bypass" | "agent-decide";
export type DeliverDecision = "integrate" | "request-review";
export type WaitReason = "user-input" | "a2a-approval" | "review" | "external";
export type AssigneeKind = "role" | "agentProfile";
export type A2APolicy = "allow" | "ask" | "deny";

export type DeliveryStatus = "draft" | "ready" | "accepted" | "rejected";
export type IntegrationMode = "manual-accept" | "bypass-auto" | "agent-decided-integrate" | null;

export type ArtifactRef = {
  kind: "path" | "dir" | "commit" | "url" | "other";
  target: string;
  label?: string;
};

export type WorkspaceLane = {
  workspace?: string;
  worktree?: string;
  branch?: string;
  targetBranch?: string;
};

export type TaskWait = {
  reason: WaitReason;
  summary: string;
};

export type DeliveryCheck = {
  name: string;
  command: string;
  exitCode: number;
};

export type DeliveryReview = {
  by: string;
  decision: "accept" | "reject";
  note?: string;
};

/**
 * States that occupy a box (active task).
 * Rework after reject uses `running` (not a lingering `rejected` occupation).
 * Terminal `rejected` does not occupy.
 */
export const ACTIVE_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "queued",
  "running",
  "waiting",
  "delivered",
]);

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "accepted",
  "rejected",
  "interrupted",
  "failed",
]);

export function isActiveTaskState(state: TaskState): boolean {
  return ACTIVE_TASK_STATES.has(state);
}

/** Map full state → legacy envelope status for B2/CLI compatibility. */
export function stateToLegacyStatus(state: TaskState): LegacyTaskStatus {
  return state === "queued" ? "pending" : "taken";
}

/** Map legacy envelope status → state when state field is absent. */
export function legacyStatusToState(status: LegacyTaskStatus): TaskState {
  return status === "pending" ? "queued" : "running";
}

export function makeTaskId(rand: RandomSource = Math.random, len = 8): string {
  // Reuse concept alphabet via makeConceptId stem, then re-prefix.
  const stem = makeConceptId(rand, len).slice(3);
  return `tk-${stem}`;
}

export function makeDeliveryId(rand: RandomSource = Math.random, len = 8): string {
  const stem = makeConceptId(rand, len).slice(3);
  return `dl-${stem}`;
}

export function isTaskId(id: string): boolean {
  return id.startsWith("tk-") && id.length > 3;
}

export function isDeliveryId(id: string): boolean {
  return id.startsWith("dl-") && id.length > 3;
}

export type TransitionErrorCode =
  | "INVALID_TRANSITION"
  | "POLICY_FORBIDS_AUTO_INTEGRATE"
  | "DECISION_REQUIRED"
  | "SELF_ACCEPT_FORBIDDEN"
  | "REVIEW_FORBIDDEN"
  | "A2A_DENIED"
  | "NO_ACTIVE_DELIVERY"
  | "TASK_NOT_ACTIVE"
  | "DELIVERY_NOT_READY";

export class TaskLifecycleError extends Error {
  code: TransitionErrorCode;
  constructor(code: TransitionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "TaskLifecycleError";
  }
}

/** Pure transition table (task-api §2.2). */
export function assertTransition(from: TaskState, event: string, to: TaskState): void {
  const ok = allowedTransitions(from).some((t) => t.event === event && t.to === to);
  if (!ok) {
    throw new TaskLifecycleError(
      "INVALID_TRANSITION",
      `Invalid task transition: ${from} --${event}→ ${to}`
    );
  }
}

export function allowedTransitions(from: TaskState): { event: string; to: TaskState }[] {
  switch (from) {
    case "queued":
      return [
        { event: "claim", to: "running" },
        { event: "cancel", to: "interrupted" },
        { event: "interrupt", to: "interrupted" },
      ];
    case "running":
      return [
        { event: "wait", to: "waiting" },
        { event: "deliver", to: "delivered" },
        { event: "interrupt", to: "interrupted" },
        { event: "fail", to: "failed" },
      ];
    case "waiting":
      return [
        { event: "resume", to: "running" },
        { event: "interrupt", to: "interrupted" },
        { event: "fail", to: "failed" },
      ];
    case "delivered":
      return [
        { event: "accept", to: "accepted" },
        { event: "reject-resume", to: "running" },
        { event: "reject-terminal", to: "rejected" },
        { event: "interrupt", to: "interrupted" },
      ];
    case "rejected":
      // Terminal rejected has no further transitions; rework uses running instead.
      return [];
    default:
      return [];
  }
}

/** Box projection from active/terminal task (task-api §2.3). */
export function projectBoxFromTask(input: {
  active: boolean;
  terminalState?: TaskState;
}): { status: "todo" | "doing" | "done"; clearAssignee: boolean } {
  if (input.active) return { status: "doing", clearAssignee: false };
  if (input.terminalState === "accepted") return { status: "done", clearAssignee: true };
  return { status: "todo", clearAssignee: true };
}

export function resolveDeliverRouting(
  policy: DeliveryPolicy,
  decision?: DeliverDecision
): { autoIntegrate: boolean; integrationMode: IntegrationMode; enterDelivered: boolean } {
  if (policy === "bypass") {
    return { autoIntegrate: true, integrationMode: "bypass-auto", enterDelivered: false };
  }
  if (policy === "manual") {
    if (decision === "integrate") {
      throw new TaskLifecycleError(
        "POLICY_FORBIDS_AUTO_INTEGRATE",
        "deliveryPolicy=manual forbids decision=integrate; use request-review or change policy."
      );
    }
    return { autoIntegrate: false, integrationMode: null, enterDelivered: true };
  }
  // agent-decide
  if (!decision) {
    throw new TaskLifecycleError(
      "DECISION_REQUIRED",
      "deliveryPolicy=agent-decide requires decision: integrate | request-review."
    );
  }
  if (decision === "integrate") {
    return {
      autoIntegrate: true,
      integrationMode: "agent-decided-integrate",
      enterDelivered: false,
    };
  }
  return { autoIntegrate: false, integrationMode: null, enterDelivered: true };
}

export function assertNotSelfAccept(actor: string, submitterRole: string): void {
  if (actor.trim() === submitterRole.trim()) {
    throw new TaskLifecycleError(
      "SELF_ACCEPT_FORBIDDEN",
      `task.accept actor must not equal delivery submitter (${submitterRole}).`
    );
  }
}

/**
 * Review authority for task.accept / task.reject (task-api §4.4 / §4.5).
 * - Self-review (actor === submitter) is always forbidden.
 * - Peer tasks: any non-submitter actor may review (typically user; not crypto-bound).
 * - Sub tasks (`asSub`): actor must be `user` or the exact `dispatchedBy` role.
 *   Unrelated roles fail. This is a soft policy check, not cryptographic auth.
 */
export function assertReviewAuthority(input: {
  actor: string;
  submitterRole: string;
  asSub?: boolean;
  dispatchedBy?: string;
  action?: "accept" | "reject";
}): void {
  const actor = input.actor.trim();
  const submitter = input.submitterRole.trim();
  const action = input.action ?? "accept";
  if (!actor) {
    throw new TaskLifecycleError(
      "REVIEW_FORBIDDEN",
      `task.${action} requires a non-empty actor.`
    );
  }
  if (actor === submitter) {
    throw new TaskLifecycleError(
      "SELF_ACCEPT_FORBIDDEN",
      `task.${action} actor must not equal delivery submitter (${submitter}).`
    );
  }
  if (input.asSub !== true) return;
  const dispatcher = (input.dispatchedBy || "").trim();
  if (actor === "user") return;
  if (dispatcher && actor === dispatcher) return;
  throw new TaskLifecycleError(
    "REVIEW_FORBIDDEN",
    `task.${action} on sub task requires actor user or dispatchedBy role` +
      (dispatcher ? ` (${dispatcher})` : "") +
      `; got ${actor}.`
  );
}

/** A2A hard gate pure evaluation (task-api §4). User is root authority. */
export function evaluateA2A(input: {
  callerKind: "user" | "role";
  policy?: A2APolicy;
  profileAllowed?: boolean;
}): "allow" | "ask" | "deny" {
  if (input.callerKind === "user") return "allow";
  const policy = input.policy ?? "deny";
  if (policy === "deny") return "deny";
  if (policy === "ask") return "ask";
  if (input.profileAllowed === false) return "deny";
  return "allow";
}
