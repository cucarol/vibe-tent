// Task / Result domain model + pure state machine.
// Operational records only — not OKF Nodes.

import { makeNodeId, type RandomSource } from "./id.js";

/** Canonical task states (task-api §2.1). */
export type TaskState =
  | "queued"
  | "running"
  | "waiting"
  | "submitted"
  | "accepted"
  | "rejected"
  | "interrupted"
  | "failed";

/** Canonical Task-frozen acceptance policy (V0.2 hard cut). */
export type AcceptMode = "review-required" | "auto-accept" | "agent-decide";

/** Default for new Tasks and workspace settings. */
export const DEFAULT_ACCEPT_MODE: AcceptMode = "review-required";

export type SubmitDecision = "integrate" | "request-review";
export type WaitReason = "user-input" | "review" | "external";

/**
 * Explicit Task execution terminal outcome (V0.2).
 * Service may publish a ready Task Result only for `submitted`.
 */
export type TaskOutcome = "blocked";

/** Formal blocked/failed detail that has not been superseded by a Task Result. */
export type TaskStatusDetail = {
  kind: "blocked" | "failed";
  report?: string;
  error?: string;
  code?: string;
  at?: string;
  executionSessionId?: string;
};

/** Exact requester on a Task; this is also the sole review authority. */
export type TaskActorKind = "user" | "role";
export type TaskActorRef = {
  kind: TaskActorKind;
  /** `user` when kind=user; durable role name when kind=role. */
  id: string;
};

export type TaskResultStatus = "ready" | "accepted" | "rejected";
export type IntegrationMode = "auto-accept" | "agent-decided-integrate" | null;

export type TransitionErrorCode =
  | "INVALID_TRANSITION"
  | "INVALID_ACCEPT_MODE"
  | "POLICY_FORBIDS_AUTO_INTEGRATE"
  | "DECISION_REQUIRED"
  | "SELF_ACCEPT_FORBIDDEN"
  | "REVIEW_FORBIDDEN"
  | "INVALID_ACTOR"
  | "OUTCOME_REQUIRED"
  | "NO_ACTIVE_RESULT"
  | "RESULT_CHANGED"
  | "TASK_NOT_ACTIVE"
  | "RESULT_NOT_READY";

export class TaskLifecycleError extends Error {
  code: TransitionErrorCode;
  constructor(code: TransitionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "TaskLifecycleError";
  }
}

export function isTaskActorKind(value: unknown): value is TaskActorKind {
  return value === "user" || value === "role";
}

/**
 * Fail-loud parse of the requester wire object.
 * Accepts `{ kind, id }` only.
 */
export function parseTaskActorRef(
  value: unknown,
  label: "requester"
): TaskActorRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label} must be an object { kind, id }.`
    );
  }
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!isTaskActorKind(kind)) {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label}.kind must be user|role; got ${String(kind)}.`
    );
  }
  if (!id) {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label}.id must be a non-empty string.`
    );
  }
  if (kind === "user" && id !== "user") {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label} with kind=user requires id "user"; got ${id}.`
    );
  }
  if (kind === "role" && id === "user") {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label} with kind=role must name a durable role (not user).`
    );
  }
  return { kind, id };
}

/**
 * Non-review acceptMode is legal only for a Task directly accountable to User.
 * Whether execution uses a Role, a Session, or both is orthogonal. Downstream
 * Task → parent Role remains review-required.
 */
export function allowsNonReviewAcceptMode(input: { requester?: TaskActorRef }): boolean {
  const parent = input.requester;
  return Boolean(parent && parent.kind === "user" && parent.id === "user");
}

/**
 * Parse the explicit blocked control from a managed final assistant report.
 * A normal non-empty report is submitted directly without an outcome wrapper.
 */
export function parseTaskOutcomeReport(text: string): {
  outcome: TaskOutcome;
  report: string;
} | null {
  const raw = typeof text === "string" ? text.replace(/^\uFEFF/, "") : "";
  if (!raw.trim()) return null;
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  if (i >= lines.length) return null;

  let fence = false;
  if (lines[i].trim() === "---") {
    fence = true;
    i += 1;
    while (i < lines.length && lines[i].trim() === "") i += 1;
  }
  if (i >= lines.length) return null;

  const match = lines[i].trim().match(/^outcome\s*:\s*(blocked)\s*$/i);
  if (!match) return null;
  const outcome = match[1].toLowerCase() as TaskOutcome;
  i += 1;

  if (fence) {
    while (i < lines.length && lines[i].trim() === "") i += 1;
    if (i < lines.length && lines[i].trim() === "---") i += 1;
  }
  // Drop one blank line after the outcome header for cleaner summaries.
  if (i < lines.length && lines[i].trim() === "") i += 1;
  const report = lines.slice(i).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return { outcome, report };
}

/** True only for the canonical hard-cut wire values. */
export function isAcceptMode(value: unknown): value is AcceptMode {
  return (
    value === "review-required" ||
    value === "auto-accept" ||
    value === "agent-decide"
  );
}

export type { ArtifactRef } from "./artifact.js";

/**
 * Task Git lane projection (operational truth on the record).
 * baseCommit + targetBranch + integrationAuthority are authoritative;
 * Context Card executionLane is a derived dynamic view only (cx-5q6za6).
 */
export type WorkspaceLane = {
  workspace?: string;
  worktree?: string;
  branch?: string;
  targetBranch?: string;
  /**
   * Exact full SHA of the Task worktree start (first parent of the first Task commit).
   * Capture-once at lane bind; never rewrite on resume.
   */
  baseCommit?: string;
  /**
   * Integration authority: actor equals requester; mutator is always service.
   * Ordinary executors do not hold Git integration authority.
   */
  integrationAuthority?: {
    actor: TaskActorRef;
    mutator: "service";
  };
};

export type TaskWait = {
  reason: WaitReason;
  summary: string;
  /**
   * Optional stable machine code for recovery UX (e.g. session_unavailable).
   * Human text stays in `summary`; UI localization uses `code` when present.
   */
  code?: string;
};

export type TaskResultCheck = {
  name: string;
  command: string;
  exitCode: number;
};

export type TaskResultReview = {
  reviewer: string;
  at: string;
  note?: string;
};

/**
 * States that keep a Task in flight.
 * Rework after reject uses `running` (not a lingering `rejected` state).
 * Terminal `rejected` is no longer in flight.
 */
export const ACTIVE_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "queued",
  "running",
  "waiting",
  "submitted",
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

export function makeTaskId(rand: RandomSource = Math.random, len = 8): string {
  // Reuse the Node id alphabet via makeNodeId stem, then re-prefix.
  const stem = makeNodeId(rand, len).slice(3);
  return `tk-${stem}`;
}

export function makeTaskResultId(rand: RandomSource = Math.random, len = 8): string {
  const stem = makeNodeId(rand, len).slice(3);
  return `rs-${stem}`;
}

export function isTaskId(id: string): boolean {
  return /^tk-[a-z0-9]+$/.test(id);
}

export function isTaskResultId(id: string): boolean {
  return /^rs-[a-z0-9]+$/.test(id);
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
        { event: "submit", to: "submitted" },
        { event: "interrupt", to: "interrupted" },
        { event: "fail", to: "failed" },
      ];
    case "waiting":
      return [
        { event: "resume", to: "running" },
        { event: "interrupt", to: "interrupted" },
        { event: "fail", to: "failed" },
      ];
    case "submitted":
      return [
        { event: "accept", to: "accepted" },
        { event: "reject-resume", to: "running" },
        { event: "reject-terminal", to: "rejected" },
      ];
    case "rejected":
      // Terminal rejected has no further transitions; rework uses running instead.
      return [];
    default:
      return [];
  }
}

export function resolveSubmitRouting(
  mode: AcceptMode,
  decision?: SubmitDecision
): { autoIntegrate: boolean; integrationMode: IntegrationMode; enterSubmitted: boolean } {
  if (!isAcceptMode(mode)) {
    throw new TaskLifecycleError(
      "INVALID_ACCEPT_MODE",
      `Invalid acceptMode: ${String(mode)}.`
    );
  }
  if (mode === "auto-accept") {
    return { autoIntegrate: true, integrationMode: "auto-accept", enterSubmitted: false };
  }
  if (mode === "review-required") {
    if (decision === "integrate") {
      throw new TaskLifecycleError(
        "POLICY_FORBIDS_AUTO_INTEGRATE",
        "acceptMode=review-required forbids decision=integrate; use request-review or change mode."
      );
    }
    return { autoIntegrate: false, integrationMode: null, enterSubmitted: true };
  }
  // agent-decide
  if (!decision) {
    throw new TaskLifecycleError(
      "DECISION_REQUIRED",
      "acceptMode=agent-decide requires decision: integrate | request-review."
    );
  }
  if (decision === "integrate") {
    return {
      autoIntegrate: true,
      integrationMode: "agent-decided-integrate",
      enterSubmitted: false,
    };
  }
  return { autoIntegrate: false, integrationMode: null, enterSubmitted: true };
}

/**
 * Review authority for task.accept / task.reject.
 * Ordinary accept/reject must equal the **exact** persisted Task.requester and
 * never the submitter. There is no user root override on Role-reviewed Tasks.
 *
 * - `requester.kind=user` → only `actor=user`.
 * - `requester.kind=role` → only `actor === requester.id` (exact parent Role).
 * - Self-review (actor === submitter) always forbidden.
 * - Soft policy only — not cryptographic auth on the shared service token.
 *
 * Responsibility always comes from the exact requester record.
 */
export function assertReviewAuthority(input: {
  actor: string;
  executorRoleId?: string;
  requester?: TaskActorRef;
  action?: "accept" | "reject";
}): void {
  const actor = input.actor.trim();
  const executorRoleId = input.executorRoleId?.trim();
  const action = input.action ?? "accept";
  if (!actor) {
    throw new TaskLifecycleError(
      "REVIEW_FORBIDDEN",
      `task.${action} requires a non-empty actor.`
    );
  }
  if (executorRoleId && actor === executorRoleId) {
    throw new TaskLifecycleError(
      "SELF_ACCEPT_FORBIDDEN",
      `task.${action} actor must not equal executing Role (${executorRoleId}).`
    );
  }
  const requester = input.requester;
  if (!requester) {
    throw new TaskLifecycleError(
      "REVIEW_FORBIDDEN",
      `task.${action} requires an explicit Task.requester.`
    );
  }
  if (requester.kind === "user") {
    // Exact match only: kind=user requires id "user" (enforced by parseTaskActorRef).
    if (actor === requester.id && actor === "user") return;
    throw new TaskLifecycleError(
      "REVIEW_FORBIDDEN",
      `task.${action} on user-reviewed task requires actor user; got ${actor}.`
    );
  }
  // Role-reviewed: exact parent Role id only — never an ordinary user override.
  if (actor === requester.id) return;
  throw new TaskLifecycleError(
    "REVIEW_FORBIDDEN",
    `task.${action} requires actor equal to requester role (${requester.id}); got ${actor}.`
  );
}
