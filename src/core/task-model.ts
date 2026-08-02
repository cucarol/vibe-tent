// Task / delivery domain model + pure state machine (B0 task-api.md).
// Operational records only — not OKF Nodes.

import { makeNodeId, type RandomSource } from "./id.js";

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

/**
 * Canonical delivery-policy wire values (V0.2).
 * Product-facing display labels (Review / Bypass / Agent Decide) live in UI/docs,
 * not Core. Historical on-disk `manual` is normalized to `review` only at a narrow
 * read boundary.
 */
export type DeliveryPolicy = "review" | "bypass" | "agent-decide";

/** Default for new tasks / workspace settings when policy is omitted. */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = "review";

export type DeliverDecision = "integrate" | "request-review";
export type WaitReason = "user-input" | "a2a-approval" | "review" | "external";
export type AssigneeKind = "role" | "agentProfile";
export type A2APolicy = "allow" | "ask" | "deny";

/**
 * Explicit Task execution terminal outcome (V0.2).
 * Service may publish a ready Delivery only for `delivered`.
 */
export type TaskOutcome = "delivered" | "blocked" | "needs-input";

/** Parent / reviewer actor on a Task (V0.2 explicit wire; replaces asSub+dispatchedBy inference). */
export type TaskActorKind = "user" | "role";
export type TaskActorRef = {
  kind: TaskActorKind;
  /** `user` when kind=user; durable role name when kind=role. */
  id: string;
};

export type DeliveryStatus = "draft" | "ready" | "accepted" | "rejected";
export type IntegrationMode = "manual-accept" | "bypass-auto" | "agent-decided-integrate" | null;

export type TransitionErrorCode =
  | "INVALID_TRANSITION"
  | "POLICY_FORBIDS_AUTO_INTEGRATE"
  | "DECISION_REQUIRED"
  | "SELF_ACCEPT_FORBIDDEN"
  | "REVIEW_FORBIDDEN"
  | "INVALID_ACTOR"
  | "OUTCOME_REQUIRED"
  | "OUTCOME_NOT_DELIVERED"
  | "A2A_DENIED"
  | "NO_ACTIVE_DELIVERY"
  | "TASK_NOT_ACTIVE"
  | "DELIVERY_NOT_READY"
  /** Compensating rollback after partial accept (Output bind + Delivery/Task) failed. */
  | "ACCEPT_ROLLBACK_FAILED";

export class TaskLifecycleError extends Error {
  code: TransitionErrorCode;
  constructor(code: TransitionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "TaskLifecycleError";
  }
}

export const TASK_OUTCOMES: readonly TaskOutcome[] = [
  "delivered",
  "blocked",
  "needs-input",
] as const;

export function isTaskOutcome(value: unknown): value is TaskOutcome {
  return value === "delivered" || value === "blocked" || value === "needs-input";
}

export function isTaskActorKind(value: unknown): value is TaskActorKind {
  return value === "user" || value === "role";
}

/**
 * Fail-loud parse of parentActor / reviewer wire objects.
 * Accepts `{ kind, id }` only — no dual-read of legacy dispatchedBy here.
 */
export function parseTaskActorRef(
  value: unknown,
  label: "parentActor" | "reviewer"
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
 * V0.2 invariant: reviewer is derived from parentActor — not arbitrary delegation.
 * `reviewer.kind/id` must equal `parentActor.kind/id`. Role A may not assign
 * reviewer Role B. Fail-loud on mismatch.
 */
export function assertParentReviewerEqual(
  parentActor: TaskActorRef,
  reviewer: TaskActorRef
): void {
  if (parentActor.kind !== reviewer.kind || parentActor.id !== reviewer.id) {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task reviewer must equal parentActor (no arbitrary delegation); ` +
        `got parentActor=${parentActor.kind}:${parentActor.id} ` +
        `reviewer=${reviewer.kind}:${reviewer.id}.`
    );
  }
}

/** True when parent and reviewer are the same actor ref. */
export function parentReviewerEqual(
  parentActor: TaskActorRef,
  reviewer: TaskActorRef
): boolean {
  return parentActor.kind === reviewer.kind && parentActor.id === reviewer.id;
}

/**
 * Single authoritative resolve for parentActor + reviewer pairs.
 * Used by Core new-write, load, migration, and Service RPC — equality is
 * enforced here so no boundary can parse two actors and return them unchecked.
 *
 * - `parentActor` required (already-parsed TaskActorRef).
 * - `reviewer` optional: when omitted, derived as a copy of parentActor.
 * - When present, must equal parentActor (assertParentReviewerEqual).
 * - Always returns both fields (both must be persisted on write).
 */
export function resolveParentReviewerPair(input: {
  parentActor: TaskActorRef;
  reviewer?: TaskActorRef;
}): { parentActor: TaskActorRef; reviewer: TaskActorRef } {
  const parentActor = parseTaskActorRef(input.parentActor, "parentActor");
  const reviewer = input.reviewer
    ? parseTaskActorRef(input.reviewer, "reviewer")
    : { ...parentActor };
  assertParentReviewerEqual(parentActor, reviewer);
  return { parentActor, reviewer };
}

/** User parent + user reviewer (user-direct Task). */
export function userTaskActors(): { parentActor: TaskActorRef; reviewer: TaskActorRef } {
  const parentActor: TaskActorRef = { kind: "user", id: "user" };
  return { parentActor, reviewer: { ...parentActor } };
}

/** Role parent + same-role reviewer (Role-dispatched Task Agent / sub). */
export function roleTaskActors(
  roleName: string
): { parentActor: TaskActorRef; reviewer: TaskActorRef } {
  const id = roleName.trim();
  if (!id || id === "user") {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      "Role parent/reviewer requires a durable role name (not user)."
    );
  }
  const parentActor: TaskActorRef = { kind: "role", id };
  return { parentActor, reviewer: { ...parentActor } };
}

/**
 * Elevated deliveryPolicy (bypass | agent-decide) is legal only for a durable
 * Role's own user-facing delivery (parent=user, assigneeKind=role).
 * Downstream Task Agent → parent is always review-to-parent.
 */
export function mayElevateDeliveryPolicy(input: {
  parentActor?: TaskActorRef;
  assigneeKind?: AssigneeKind;
}): boolean {
  const parent = input.parentActor;
  if (!parent || parent.kind !== "user") return false;
  return (input.assigneeKind ?? "role") === "role";
}

/**
 * Parse explicit outcome from a managed final assistant report.
 * Accepts a leading `outcome: delivered|blocked|needs-input` line, optionally
 * inside a leading `---` / `---` fence. Returns remainder as report body.
 * Missing/invalid outcome → null (caller must not publish ready Delivery).
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

  const match = lines[i].trim().match(/^outcome\s*:\s*(delivered|blocked|needs-input)\s*$/i);
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

/** True for canonical wire values only (not historical `manual`). */
export function isDeliveryPolicy(value: unknown): value is DeliveryPolicy {
  return value === "review" || value === "bypass" || value === "agent-decide";
}

/**
 * Narrow read/migration boundary for on-disk task/workspace policy fields.
 * Historical `manual` → `review`. Canonical values pass through. Other values → undefined.
 * Does not accept `manual` as a write/RPC value — callers must reject that at write boundaries.
 */
export function normalizeDeliveryPolicyRead(value: unknown): DeliveryPolicy | undefined {
  if (value === "manual") return "review";
  if (isDeliveryPolicy(value)) return value;
  return undefined;
}

export type ArtifactRef = {
  kind: "path" | "dir" | "commit" | "url" | "other";
  target: string;
  label?: string;
};

/**
 * Task Git lane projection (operational truth on the envelope).
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
   * Integration authority: actor equals parent/reviewer; mutator is always service.
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
 * States that occupy a node (active task).
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

export function makeTaskId(rand: RandomSource = Math.random, len = 8): string {
  // Reuse the Node id alphabet via makeNodeId stem, then re-prefix.
  const stem = makeNodeId(rand, len).slice(3);
  return `tk-${stem}`;
}

export function makeDeliveryId(rand: RandomSource = Math.random, len = 8): string {
  const stem = makeNodeId(rand, len).slice(3);
  return `dl-${stem}`;
}

export function isTaskId(id: string): boolean {
  return id.startsWith("tk-") && id.length > 3;
}

export function isDeliveryId(id: string): boolean {
  return id.startsWith("dl-") && id.length > 3;
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
      ];
    case "rejected":
      // Terminal rejected has no further transitions; rework uses running instead.
      return [];
    default:
      return [];
  }
}

export function resolveDeliverRouting(
  policy: DeliveryPolicy,
  decision?: DeliverDecision
): { autoIntegrate: boolean; integrationMode: IntegrationMode; enterDelivered: boolean } {
  if (policy === "bypass") {
    return { autoIntegrate: true, integrationMode: "bypass-auto", enterDelivered: false };
  }
  if (policy === "review") {
    if (decision === "integrate") {
      throw new TaskLifecycleError(
        "POLICY_FORBIDS_AUTO_INTEGRATE",
        "deliveryPolicy=review forbids decision=integrate; use request-review or change policy."
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
 * Review authority for task.accept / task.reject (V0.2 parent/reviewer wire).
 * Ordinary accept/reject must equal the **exact** persisted Task.reviewer and
 * never the submitter. There is no user root bypass on Role-reviewed Tasks.
 *
 * - `reviewer.kind=user` → only `actor=user`.
 * - `reviewer.kind=role` → only `actor === reviewer.id` (exact parent Role).
 * - Self-review (actor === submitter) always forbidden.
 * - Soft policy only — not cryptographic auth on the shared service token.
 *
 * Callers pass the explicit envelope `reviewer` (after migration). This function
 * never reads `asSub` or legacy `dispatchedBy`.
 */
export function assertReviewAuthority(input: {
  actor: string;
  submitterRole: string;
  reviewer?: TaskActorRef;
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
  const reviewer = input.reviewer;
  if (!reviewer) {
    throw new TaskLifecycleError(
      "REVIEW_FORBIDDEN",
      `task.${action} requires an explicit Task.reviewer (parent-reviewer wire).`
    );
  }
  if (reviewer.kind === "user") {
    // Exact match only: kind=user requires id "user" (enforced by parseTaskActorRef).
    if (actor === reviewer.id && actor === "user") return;
    throw new TaskLifecycleError(
      "REVIEW_FORBIDDEN",
      `task.${action} on user-reviewed task requires actor user; got ${actor}.`
    );
  }
  // Role-reviewed: exact parent Role id only — never user ordinary-bypass.
  if (actor === reviewer.id) return;
  throw new TaskLifecycleError(
    "REVIEW_FORBIDDEN",
    `task.${action} requires actor equal to reviewer role (${reviewer.id}); got ${actor}.`
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
