import { Clock, FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import {
  AGENT_PROFILES_TEMP_DIR,
  agentProfileTasksDir,
  TEMP_DIR,
} from "./paths.js";
import { join } from "./tree.js";
import type { RoleDefinition } from "./skillRoleRegistry.js";
import {
  assertParentReviewerEqual,
  DEFAULT_DELIVERY_POLICY,
  isTaskId,
  legacyStatusToState,
  makeTaskId,
  mayElevateDeliveryPolicy,
  migrateParentReviewerFromLegacy,
  normalizeDeliveryPolicyRead,
  parseTaskActorRef,
  resolveParentReviewerPair,
  roleTaskActors,
  stateToLegacyStatus,
  userTaskActors,
  type AssigneeKind,
  type DeliveryPolicy,
  type TaskActorRef,
  type TaskOutcome,
  type TaskState,
  type TaskWait,
  type WorkspaceLane,
} from "./task-model.js";
import {
  assertIntegrationAuthorityMatchesParent,
  buildTaskContextCard,
  computeContextGeneration,
  deriveIntegrationAuthority,
  loadTaskContextCardFromFrontmatter,
  projectAssigneeFromTask,
  serializeTaskContextCardForFrontmatter,
  type IntegrationAuthority,
  type TaskContextCardRef,
  type TaskContextCardV1,
} from "./task-context-card.js";
import {
  normalizeContextCardNodeRef,
  taskReferencedNodeIds,
} from "./task-node-refs.js";

export interface RoleWorkspaceContract {
  workspace: string;
  worktree: string;
  branch: string;
  targetBranch: string;
  /**
   * Exact branch tip (full SHA) at ensure/create time.
   * Written as Task baseCommit + roleBranchBase when the lane is first bound
   * (dispatch for Role/asSub; startSession for peer agentProfile).
   */
  baseCommit?: string;
}

/** How workspaceLane.baseCommit was first recorded (compact Task audit; no new entity). */
export type BaseCommitCaptureSource = "first-claim" | "explicit-backfill";

/**
 * Compact audit bag for capture-once baseCommit.
 * Written on Role first-claim or explicit legacy backfill; never rewritten on same-SHA idempotent repeat.
 */
export type BaseCommitCapture = {
  source: BaseCommitCaptureSource;
  /** Exact full SHA captured (same as Task.baseCommit). */
  baseCommit: string;
  /** Authorizing actor (parent/reviewer for backfill; parentActor for first-claim). */
  actor: TaskActorRef;
  /** ISO-8601 capture timestamp. */
  capturedAt: string;
};

export interface TaskEnvelopeInput {
  /**
   * Stable assignee label.
   * Role tasks: durable role name. Profile tasks: profileId (legacy field name kept).
   */
  role: string;
  /**
   * Node refs for this Task (durable id + optional path hint).
   * Persisted only as Task.contextCard.refs.nodes[] — never as claims[].
   * Pass `[{ id: "root", path: "./" }]` (or claimRoot via ops) for workspace-only
   * context: "root" is discarded and yields empty refs.nodes (stable workspace
   * context already present; no second source flag).
   */
  claims: { id: string; path: string }[];
  manifestPath: string;
  userPrompt: string;
  workspace?: RoleWorkspaceContract;
  /**
   * Explicit parent actor (V0.2). Required on new writes — no dispatchedBy fallback.
   */
  parentActor: TaskActorRef;
  /**
   * Explicit Delivery reviewer (V0.2). Optional: when omitted, derived equal to
   * parentActor once. When present, must match parentActor exactly (both
   * fields are still persisted).
   */
  reviewer?: TaskActorRef;
  /**
   * Sub-dispatch Git lane flag. Missing on disk reads as false (peer).
   * When true, targetBranch is the parent role branch. Review authority uses
   * parentActor/reviewer, not this flag. asSub is lane-only.
   */
  asSub?: boolean;
  /** Full operational id (tk-…). Generated if omitted. */
  id?: string;
  deliveryPolicy?: DeliveryPolicy;
  assigneeKind?: AssigneeKind;
  /**
   * Logical AgentDefinition id for Role-agent dispatch (persisted on envelope).
   * User-direct profile Tasks omit this.
   */
  agentId?: string;
  sessionId?: string;
  /**
   * Override task directory (relative system root).
   * Profile tasks use temp/agent-profiles/<safe-id>/tasks; roles use temp/<role>/tasks.
   */
  tasksDir?: string;
  /**
   * Optional explicit objective/acceptance for contextCard.
   * Defaults: objective = userPrompt; acceptance = [objective] when omitted.
   */
  objective?: string;
  acceptance?: string[];
  /**
   * Optional precomputed contextGeneration for new writes.
   * When omitted, a deterministic dispatch-time generation is derived from
   * workspace/assignee identity (no chat-memory invention).
   */
  contextGeneration?: string;
}

/** Legacy two-state for B2 / dogfood CLI. */
export type TaskEnvelopeStatus = "pending" | "taken";

/**
 * Operational task record.
 * - `status` is the legacy envelope field (pending|taken) kept for B2 projections.
 * - `state` is the full lifecycle state (task-api §2).
 */
export interface TaskEnvelope {
  path: string;
  role: string;
  /**
   * Node refs are sole-sourced from `contextCard.refs.nodes` via
   * `taskReferencedNodeIds(task)` / `primaryBoxId(task)`.
   * No in-memory claims[] projection — migrator is the only on-disk claims reader.
   */
  manifest: string;
  status: TaskEnvelopeStatus;
  /** Full lifecycle state; always derived for legacy files. */
  state: TaskState;
  /** Operational task id (tk-…). May be absent on pre-B4 envelopes. */
  id?: string;
  /**
   * Explicit parent actor (V0.2). Required after disk migration / on new writes.
   * Optional only on synthetic/partial fixtures before write.
   */
  parentActor?: TaskActorRef;
  /**
   * Explicit Delivery reviewer (V0.2). Required with parentActor; ordinary
   * accept/reject authority equals this actor exactly.
   */
  reviewer?: TaskActorRef;
  /**
   * Peer vs sub Git lane. Missing field reads as false.
   * Persisted only when true; see taskAsSub(). Not used for review authority.
   */
  asSub?: boolean;
  workspace?: string;
  worktree?: string;
  branch?: string;
  targetBranch?: string;
  /**
   * Immutable full SHA of the role branch tip at first Git-lane bind for this task.
   * Optional; absent on non-Git / pre-baseline envelopes until backfilled once.
   * Kept in sync with baseCommit for managed collection (same capture-once baseline).
   */
  roleBranchBase?: string;
  /**
   * Exact full SHA of the Task worktree start (cx-5q6za6).
   * Authoritative for pre-ready Delivery history gate; capture-once with roleBranchBase.
   */
  baseCommit?: string;
  /**
   * Compact audit for capture-once workspaceLane.baseCommit (no separate entity).
   * source distinguishes Role first-claim vs explicit legacy backfill.
   * Immutable once written: same-SHA backfill leaves this bag unchanged.
   */
  baseCommitCapture?: BaseCommitCapture;
  /**
   * Integration authority on the workspace lane (actor = parent/reviewer, mutator = service).
   * Ordinary executors never mutate target; Service integrates after parent accept.
   */
  integrationAuthority?: IntegrationAuthority;
  /**
   * Authoritative Task Context Card v1 (cx-5q6za6).
   * Projected from envelope frontmatter `contextCard` (or flat card fields).
   * Missing on legacy envelopes; when any card body field is present, load fails loud
   * on incomplete cards (never invent from chat memory).
   */
  contextCard?: TaskContextCardV1;
  /**
   * Convenience projection of contextCard.contextGeneration when present.
   * Also readable as a top-level frontmatter key for Session compatibility.
   */
  contextGeneration?: string;
  /** Convenience projection of contextCard.taskDeltaDigest when present. */
  taskDeltaDigest?: string;
  deliveryPolicy?: DeliveryPolicy;
  assigneeKind?: AssigneeKind;
  /**
   * Logical AgentDefinition id chosen at Role-agent dispatch.
   * Authoritative for startSession / bootstrap roster auth — not re-inferred from profileId.
   * Omitted on user-direct one-shot profile Tasks.
   */
  agentId?: string;
  sessionId?: string;
  wait?: TaskWait;
  activeDeliveryId?: string;
  /**
   * Last explicit Task execution outcome when recorded (managed final report).
   * Optional; absence does not block public task.deliver.
   */
  lastOutcome?: TaskOutcome;
  createdAt?: string;
  updatedAt?: string;
  /** Immutable user prompt body (after frontmatter). */
  prompt?: string;
}

/**
 * Discover task envelopes under role lanes and nested agent-profile lanes.
 * - Role: temp/<role>/tasks/*.md
 * - Profile: temp/agent-profiles/<safe-profile-id>/tasks/*.md
 */
export async function loadTaskEnvelopes(fs: FsAdapter): Promise<TaskEnvelope[]> {
  const tasks: TaskEnvelope[] = [];
  if (!(await fs.exists(TEMP_DIR))) return tasks;

  for (const entry of await fs.listDir(TEMP_DIR)) {
    if (!entry.isDir) continue;
    if (entry.name === AGENT_PROFILES_TEMP_DIR) {
      const profilesRoot = join(TEMP_DIR, AGENT_PROFILES_TEMP_DIR);
      if (!(await fs.exists(profilesRoot))) continue;
      for (const profileEntry of await fs.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        await collectTaskFiles(fs, join(profilesRoot, profileEntry.name, "tasks"), tasks);
      }
      continue;
    }
    await collectTaskFiles(fs, join(TEMP_DIR, entry.name, "tasks"), tasks);
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}

export type ParentReviewerMigrationReport = {
  scanned: number;
  rewritten: string[];
  skipped: string[];
  warnings: string[];
};

/**
 * One-time disk migration: write explicit parentActor/reviewer and strip
 * legacy `dispatchedBy` from task envelopes that still carry it without
 * parentActor. Preserves asSub (Git lane), accepted records, and audit body.
 * Idempotent — envelopes that already have parentActor+reviewer and no
 * dispatchedBy are left untouched. Fail-loud per file is recorded in warnings
 * without aborting the whole scan.
 */
export async function migrateParentReviewerEnvelopes(
  fs: FsAdapter,
  clock: Clock,
  options?: { dryRun?: boolean }
): Promise<ParentReviewerMigrationReport> {
  const dryRun = options?.dryRun === true;
  const report: ParentReviewerMigrationReport = {
    scanned: 0,
    rewritten: [],
    skipped: [],
    warnings: [],
  };
  if (!(await fs.exists(TEMP_DIR))) return report;

  const paths: string[] = [];
  for (const entry of await fs.listDir(TEMP_DIR)) {
    if (!entry.isDir) continue;
    if (entry.name === AGENT_PROFILES_TEMP_DIR) {
      const profilesRoot = join(TEMP_DIR, AGENT_PROFILES_TEMP_DIR);
      if (!(await fs.exists(profilesRoot))) continue;
      for (const profileEntry of await fs.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        const taskDir = join(profilesRoot, profileEntry.name, "tasks");
        if (!(await fs.exists(taskDir))) continue;
        for (const f of await fs.listDir(taskDir)) {
          if (!f.isDir && f.name.endsWith(".md")) paths.push(join(taskDir, f.name));
        }
      }
      continue;
    }
    const taskDir = join(TEMP_DIR, entry.name, "tasks");
    if (!(await fs.exists(taskDir))) continue;
    for (const f of await fs.listDir(taskDir)) {
      if (!f.isDir && f.name.endsWith(".md")) paths.push(join(taskDir, f.name));
    }
  }

  for (const path of paths.sort((a, b) => a.localeCompare(b))) {
    report.scanned += 1;
    try {
      const raw = await fs.readFile(path);
      const { data, body, keyOrder } = parseFrontmatter(raw);
      if (data.type !== "task") {
        report.skipped.push(path);
        continue;
      }
      const hasParent =
        data.parentActor !== undefined && data.parentActor !== null;
      const hasReviewer = data.reviewer !== undefined && data.reviewer !== null;
      const hasLegacyDispatcher =
        typeof data.dispatchedBy === "string" && data.dispatchedBy.trim() !== "";

      // Already on V0.2 wire with matching pair and no legacy key — nothing to do.
      // Mismatched explicit pairs fail loud (recorded as warnings; not silently repaired).
      if (hasParent && hasReviewer && !hasLegacyDispatcher) {
        try {
          resolveParentReviewerPair({
            parentActor: parseTaskActorRef(data.parentActor, "parentActor"),
            reviewer: parseTaskActorRef(data.reviewer, "reviewer"),
          });
          report.skipped.push(path);
        } catch (err) {
          report.warnings.push(
            `${path}: ${err instanceof Error ? err.message : String(err)}`
          );
          report.skipped.push(path);
        }
        continue;
      }

      let parentActor: TaskActorRef;
      let reviewer: TaskActorRef;
      if (hasParent && hasReviewer) {
        // Has legacy key too — parse via shared pair resolver, then strip dispatchedBy.
        const pair = resolveParentReviewerPair({
          parentActor: parseTaskActorRef(data.parentActor, "parentActor"),
          reviewer: parseTaskActorRef(data.reviewer, "reviewer"),
        });
        parentActor = pair.parentActor;
        reviewer = pair.reviewer;
      } else if (hasParent || hasReviewer) {
        report.warnings.push(
          `${path}: partial parentActor/reviewer pair; refusing silent repair`
        );
        report.skipped.push(path);
        continue;
      } else {
        // Legacy derives equal parent+reviewer pair (never mismatched).
        const migrated = migrateParentReviewerFromLegacy({
          asSub: data.asSub === true,
          dispatchedBy:
            typeof data.dispatchedBy === "string" ? data.dispatchedBy : undefined,
        });
        parentActor = migrated.parentActor;
        reviewer = migrated.reviewer;
      }

      const next: Record<string, unknown> = { ...data };
      next.parentActor = serializeTaskActorRef(parentActor);
      next.reviewer = serializeTaskActorRef(reviewer);
      delete next.dispatchedBy;

      const nextRaw = serializeFrontmatter(next, body, keyOrder);
      if (nextRaw === raw) {
        report.skipped.push(path);
        continue;
      }
      if (!dryRun) {
        // Touch updatedAt only when we actually rewrite keys.
        next.updatedAt = clock.now();
        await fs.writeFile(path, serializeFrontmatter(next, body, keyOrder));
      }
      report.rewritten.push(path);
    } catch (err) {
      report.warnings.push(
        `${path}: ${err instanceof Error ? err.message : String(err)}`
      );
      report.skipped.push(path);
    }
  }
  return report;
}

async function collectTaskFiles(
  fs: FsAdapter,
  taskDir: string,
  tasks: TaskEnvelope[]
): Promise<void> {
  if (!(await fs.exists(taskDir))) return;
  for (const entry of await fs.listDir(taskDir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path = join(taskDir, entry.name);
    try {
      tasks.push(await loadTaskEnvelope(fs, path));
    } catch {
      // Invalid temp documents stay inspectable on disk but do not enter UI state.
    }
  }
}

/** Effective assignee kind; missing field reads as role (backward compatible). */
export function taskAssigneeKind(task: Pick<TaskEnvelope, "assigneeKind">): AssigneeKind {
  return task.assigneeKind === "agentProfile" ? "agentProfile" : "role";
}

/** Effective sub-dispatch Git-lane flag; missing field reads as false (peer). */
export function taskAsSub(task: Pick<TaskEnvelope, "asSub">): boolean {
  return task.asSub === true;
}

/** Parent is a durable Role (Role-dispatched Task). */
export function taskParentIsRole(
  task: Pick<TaskEnvelope, "parentActor">
): boolean {
  return task.parentActor?.kind === "role";
}

/** Durable parent role id, or undefined when parent is user. */
export function taskParentRoleId(
  task: Pick<TaskEnvelope, "parentActor">
): string | undefined {
  return task.parentActor?.kind === "role" ? task.parentActor.id : undefined;
}

/**
 * Serialize actor ref for frontmatter (inline map).
 * Kept small and explicit — no dual-write of dispatchedBy.
 */
export function serializeTaskActorRef(actor: TaskActorRef): { kind: string; id: string } {
  return { kind: actor.kind, id: actor.id };
}

/** Serialize compact baseCommit capture audit for frontmatter. */
export function serializeBaseCommitCapture(
  capture: BaseCommitCapture
): { source: string; baseCommit: string; actor: { kind: string; id: string }; capturedAt: string } {
  return {
    source: capture.source,
    baseCommit: capture.baseCommit,
    actor: serializeTaskActorRef(capture.actor),
    capturedAt: capture.capturedAt,
  };
}

/**
 * Fail-loud ISO-8601 timestamp check for baseCommitCapture.capturedAt.
 * Requires a real parseable instant with explicit timezone (Z or ±HH:MM).
 */
export function assertIsoTimestamp(value: string, label: string): string {
  const raw = value.trim();
  if (!raw) {
    throw new Error(`${label} must be a non-empty ISO-8601 timestamp.`);
  }
  // Accept fractional seconds; require timezone designator (Z or offset).
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)
  ) {
    throw new Error(
      `${label} must be a real ISO-8601 timestamp with timezone; got ${raw}.`
    );
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`${label} is not a parseable ISO-8601 instant: ${raw}.`);
  }
  return raw;
}

/**
 * Parse compact baseCommit capture audit from frontmatter.
 * Missing/empty → undefined. Partial or invalid bags fail loud.
 * Caller must still enforce baseCommit presence/equality when capture is present.
 */
export function parseBaseCommitCapture(value: unknown): BaseCommitCapture | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "Task baseCommitCapture must be an object { source, baseCommit, actor, capturedAt }."
    );
  }
  const raw = value as Record<string, unknown>;
  const source = raw.source;
  if (source !== "first-claim" && source !== "explicit-backfill") {
    throw new Error(
      `Task baseCommitCapture.source must be first-claim|explicit-backfill; got ${String(source)}.`
    );
  }
  const baseCommit =
    typeof raw.baseCommit === "string" ? raw.baseCommit.trim() : "";
  if (!baseCommit) {
    throw new Error("Task baseCommitCapture.baseCommit must be a non-empty SHA.");
  }
  const capturedAtRaw =
    typeof raw.capturedAt === "string" ? raw.capturedAt.trim() : "";
  const capturedAt = assertIsoTimestamp(
    capturedAtRaw,
    "Task baseCommitCapture.capturedAt"
  );
  // Reuse parent/reviewer wire shape; re-label errors for capture audit.
  let actor: TaskActorRef;
  try {
    actor = parseTaskActorRef(raw.actor, "parentActor");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.replace(/Task parentActor/g, "Task baseCommitCapture.actor"));
  }
  return { source, baseCommit, actor, capturedAt };
}

/**
 * Resolve parentActor + reviewer for a **new** dispatch write.
 * Requires explicit parentActor. Reviewer may be omitted and is then derived
 * equal to parentActor; when present it must match exactly (no Role A → Role B).
 * Equality is enforced only via resolveParentReviewerPair (shared with load/RPC).
 * Legacy dispatchedBy is not accepted on create.
 */
export function resolveDispatchActors(input: {
  parentActor?: TaskActorRef;
  reviewer?: TaskActorRef;
}): { parentActor: TaskActorRef; reviewer: TaskActorRef } {
  if (!input.parentActor) {
    throw new Error(
      "task.dispatch requires explicit parentActor { kind, id } (legacy dispatchedBy is migration-only)."
    );
  }
  return resolveParentReviewerPair({
    parentActor: input.parentActor,
    reviewer: input.reviewer,
  });
}

export async function loadTaskEnvelope(fs: FsAdapter, path: string): Promise<TaskEnvelope> {
  if (!(await fs.exists(path))) throw new Error(`Task envelope not found: ${path}.`);
  const { data, body } = parseFrontmatter(await fs.readFile(path));
  if (data.type !== "task" || typeof data.role !== "string" || typeof data.manifest !== "string") {
    throw new Error(`Invalid task envelope format: ${path}.`);
  }

  const legacyStatus: TaskEnvelopeStatus = data.status === "taken" ? "taken" : "pending";
  const state = parseTaskState(data.state, legacyStatus);

  // V0.2 parent/reviewer: explicit wire required after disk migration.
  // Resolve actors before Context Card so mismatch / unmigrated dispatchedBy fail with
  // their own messages (not masked by missing-card errors).
  const actors = resolveActorsFromDisk(data);

  // Complete Context Card v1 is the sole Node-ref source. Incomplete/partial → fail loud.
  // Transitional pre-migration envelopes may still carry residual claims[] on disk;
  // those are NOT used at runtime (migrator-only). hasClaimsKey only gates load so
  // unmigrated envelopes can still be loaded (without claims projection) until
  // migrateLegacyTaskNodeRefs writes a full card.
  const contextCard = loadTaskContextCardFromFrontmatter(data) ?? undefined;
  const hasClaimsKey =
    Array.isArray(data.claims) &&
    data.claims.every((claim: unknown) => typeof claim === "string");
  if (!contextCard && !hasClaimsKey) {
    throw new Error(
      `Invalid task envelope format: ${path} (missing Task.contextCard.refs.nodes; run claims→refs migration).`
    );
  }

  const task: TaskEnvelope = {
    path,
    role: data.role,
    manifest: data.manifest,
    status: stateToLegacyStatus(state),
    state,
    parentActor: actors.parentActor,
    reviewer: actors.reviewer,
    prompt: body.trim() || undefined,
  };
  if (typeof data.id === "string" && isTaskId(data.id)) task.id = data.id;
  if (data.asSub === true) task.asSub = true;
  if (typeof data.workspace === "string") task.workspace = data.workspace;
  if (typeof data.worktree === "string") task.worktree = data.worktree;
  if (typeof data.branch === "string") task.branch = data.branch;
  if (typeof data.targetBranch === "string") task.targetBranch = data.targetBranch;
  if (typeof data.roleBranchBase === "string" && data.roleBranchBase.trim()) {
    task.roleBranchBase = data.roleBranchBase.trim();
  }
  // Exact workspaceLane.baseCommit only — never silently substitute roleBranchBase.
  // Legacy envelopes without baseCommit stay without it until explicit migration / new bind.
  if (typeof data.baseCommit === "string" && data.baseCommit.trim()) {
    task.baseCommit = data.baseCommit.trim();
  }
  // Compact baseCommit audit (first-claim | explicit-backfill). Absence is fine for
  // pre-audit envelopes and non-Git Tasks; never invent from roleBranchBase.
  // When capture exists: baseCommit must exist and equal capture.baseCommit (fail loud).
  const baseCommitCapture = parseBaseCommitCapture(data.baseCommitCapture);
  if (baseCommitCapture) {
    const recordedBase = task.baseCommit?.trim() || "";
    if (!recordedBase) {
      throw new Error(
        `Invalid task envelope format: ${path} (baseCommitCapture present but baseCommit missing).`
      );
    }
    if (recordedBase !== baseCommitCapture.baseCommit) {
      throw new Error(
        `Invalid task envelope format: ${path} (baseCommit ${recordedBase} !== ` +
          `baseCommitCapture.baseCommit ${baseCommitCapture.baseCommit}).`
      );
    }
    task.baseCommitCapture = baseCommitCapture;
  }
  // Recorded lane truth: only set TaskEnvelope.integrationAuthority when the on-disk
  // bag exists and validates against parent/reviewer + service mutator.
  // Absence stays absent so ensureTaskWorkspaceLane can detect and persist the
  // canonical derived bag (no in-memory phantom that skips the write).
  // Context / workspaceLane projections derive separately via deriveIntegrationAuthority.
  if (
    data.integrationAuthority !== undefined &&
    data.integrationAuthority !== null &&
    task.parentActor &&
    task.reviewer
  ) {
    task.integrationAuthority = assertIntegrationAuthorityMatchesParent(
      data.integrationAuthority,
      task.parentActor,
      task.reviewer
    );
  }
  // Context Card v1 already loaded above (nested or flat). Partial → fail loud.
  if (contextCard) {
    task.contextCard = contextCard;
    task.contextGeneration = contextCard.contextGeneration;
    task.taskDeltaDigest = contextCard.taskDeltaDigest;
  } else if (typeof data.contextGeneration === "string" && data.contextGeneration.trim()) {
    task.contextGeneration = data.contextGeneration.trim();
  }
  if (
    !task.taskDeltaDigest &&
    typeof data.taskDeltaDigest === "string" &&
    data.taskDeltaDigest.trim()
  ) {
    task.taskDeltaDigest = data.taskDeltaDigest.trim();
  }
  // Narrow read boundary: historical on-disk `manual` projects as `review`.
  const deliveryPolicy = normalizeDeliveryPolicyRead(data.deliveryPolicy);
  if (deliveryPolicy) task.deliveryPolicy = deliveryPolicy;
  if (data.assigneeKind === "role" || data.assigneeKind === "agentProfile") {
    task.assigneeKind = data.assigneeKind;
  }
  if (typeof data.agentId === "string" && data.agentId.trim()) {
    task.agentId = data.agentId.trim();
  }
  if (typeof data.sessionId === "string") task.sessionId = data.sessionId;
  if (typeof data.activeDeliveryId === "string") task.activeDeliveryId = data.activeDeliveryId;
  if (data.lastOutcome === "delivered" || data.lastOutcome === "blocked" || data.lastOutcome === "needs-input") {
    task.lastOutcome = data.lastOutcome;
  }
  if (typeof data.createdAt === "string") task.createdAt = data.createdAt;
  if (typeof data.updatedAt === "string") task.updatedAt = data.updatedAt;
  const wait = parseWaitFields(data);
  if (wait) task.wait = wait;
  return task;
}

/**
 * Resolve parentActor/reviewer from on-disk frontmatter.
 * Explicit fields required. Legacy `dispatchedBy` is **not** read here — only
 * `migrateParentReviewerEnvelopes` (one-time disk migrator) may consume it.
 * Unmigrated envelopes fail loud so callers remount / migrate first.
 */
function resolveActorsFromDisk(data: Record<string, unknown>): {
  parentActor: TaskActorRef;
  reviewer: TaskActorRef;
} {
  const hasParent = data.parentActor !== undefined && data.parentActor !== null;
  const hasReviewer = data.reviewer !== undefined && data.reviewer !== null;
  if (hasParent || hasReviewer) {
    if (!hasParent || !hasReviewer) {
      throw new Error(
        "Invalid task envelope: parentActor and reviewer must both be present when either is set."
      );
    }
    // Shared pair resolver — equality enforced; never return unchecked pair.
    return resolveParentReviewerPair({
      parentActor: parseTaskActorRef(data.parentActor, "parentActor"),
      reviewer: parseTaskActorRef(data.reviewer, "reviewer"),
    });
  }
  const hasLegacy =
    typeof data.dispatchedBy === "string" && data.dispatchedBy.trim() !== "";
  throw new Error(
    hasLegacy
      ? "Invalid task envelope: legacy dispatchedBy present without parentActor/reviewer; " +
          "run workspace.mount migration (migrateParentReviewerEnvelopes) before load."
      : "Invalid task envelope: missing parentActor/reviewer."
  );
}

/**
 * Roots for agent-facing task prompts.
 * - workspaceRoot: real project; run `tent` CLI here.
 * - systemRoot: tent system root (`<workspace>/.tent`); taskPath base.
 */
export type TaskPromptRoots = {
  workspaceRoot: string;
  systemRoot: string;
};

/**
 * Normalize legacy string root (system root / tentRoot) or explicit dual roots.
 * When only systemRoot is known, workspaceRoot is its parent if the leaf is `.tent`.
 */
export function resolveTaskPromptRoots(
  roots: string | TaskPromptRoots
): TaskPromptRoots {
  if (typeof roots !== "string") {
    return {
      workspaceRoot: roots.workspaceRoot,
      systemRoot: roots.systemRoot,
    };
  }
  const systemRoot = roots;
  const normalized = systemRoot.replace(/[\\/]+$/, "");
  const base = normalized.split(/[\\/]/).pop() ?? "";
  const workspaceRoot =
    base === ".tent"
      ? normalized.replace(/[\\/]+[^\\/]+$/, "") || systemRoot
      : systemRoot;
  return { workspaceRoot, systemRoot };
}

/**
 * Dynamic task pointers only — no workspaceRoot/CLI/file-read tutorial.
 * Path contract lives once on Context Card (managed) or in external relay path block.
 */
function formatTaskPointers(task: TaskEnvelope): string {
  const kind = taskAssigneeKind(task);
  const lines = [
    `Task envelope: ${task.path}`,
    `Manifest: ${task.manifest}`,
  ];
  if (task.contextCard) {
    const nodeIds = taskReferencedNodeIds(task);
    if (nodeIds.length) {
      lines.push(`contextCard.refs.nodes: ${nodeIds.join(", ")}`);
    } else {
      lines.push(`workspace context: true (no direct Node refs)`);
    }
  }
  if (task.parentActor) {
    lines.push(
      `parentActor: ${task.parentActor.kind}:${task.parentActor.id}`
    );
  }
  if (task.reviewer) {
    lines.push(`reviewer: ${task.reviewer.kind}:${task.reviewer.id}`);
  }
  if (task.deliveryPolicy) {
    lines.push(`deliveryPolicy: ${task.deliveryPolicy}`);
  }
  if (kind === "role") {
    const initCli = join("temp", task.role, "init.md");
    const initFile = join(".tent", "temp", task.role, "init.md");
    lines.push(`role: ${task.role}`);
    lines.push(`Role init file: ${initFile} (CLI path remains ${initCli}).`);
  } else {
    lines.push(`assigneeKind: agentProfile`);
    lines.push(`profileId: ${task.role}`);
    lines.push(
      `Assignee: agentProfile ${task.role} (one-shot; no durable role init / tent-role lane).`
    );
  }
  return lines.join("\n");
}

/**
 * Path roots for external relay only (managed bootstrap uses Context Card once).
 */
function formatExternalPathBlock(task: TaskEnvelope, roots: TaskPromptRoots): string {
  const taskFile = join(".tent", task.path);
  const systemRoot = roots.systemRoot.replace(/[\\/]+$/, "");
  return [
    `workspaceRoot: ${roots.workspaceRoot}`,
    `systemRoot: ${roots.systemRoot}`,
    `CLI: run tent from workspaceRoot; taskPath is relative to systemRoot (.tent), e.g. ${task.path}.`,
    `File reads: use ${taskFile} (workspace-relative) or ${systemRoot}/${task.path} — never <workspaceRoot>/temp.`,
  ].join("\n");
}

/**
 * External / manual wake relay: task is still queued — agent must claim + deliver via CLI.
 * Used for clipboard relay and dispatch.relayPrompt, NOT for service startSession bootstrap.
 */
export function relayPromptForTask(
  task: TaskEnvelope,
  roots: string | TaskPromptRoots
): string {
  const resolved = resolveTaskPromptRoots(roots);
  const kind = taskAssigneeKind(task);
  const assigneeLine =
    kind === "agentProfile"
      ? `A Tent task has been dispatched to agentProfile ${task.role}.\n`
      : `A Tent task has been dispatched to role ${task.role}.\n`;
  const initStep =
    kind === "agentProfile"
      ? `4. Read the task envelope and task-scoped manifest pointers above; do not look for a role init file.`
      : `4. If this is a new session for this role, complete role init first (read the init file above).`;
  return (
    assigneeLine +
    `${formatExternalPathBlock(task, resolved)}\n` +
    `${formatTaskPointers(task)}\n` +
    `1. Run \`tent task claim ${task.path}\` to take this task (Local Service RPC).\n` +
    `2. Inspect with \`tent task get ${task.path}\` (or read the envelope file), then open the claimed boxes; the box notes contain the task definition.\n` +
    `3. When finished, run \`tent task deliver ${task.path} --summary <text>\` (optional: --commits sha,sha).\n` +
    initStep
  );
}

/**
 * Extract the near-field user prompt from a task envelope body.
 * Envelope layout: Context Pointers + `## User Prompt` — never the box/manifest body.
 */
export function extractTaskUserPrompt(task: TaskEnvelope): string {
  const body = task.prompt?.trim() || "";
  if (!body) return "";
  const match = body.match(/##\s*User Prompt\s*\r?\n+([\s\S]*?)\s*$/i);
  if (match) return match[1].trim();
  // Legacy / override bodies without the section header: treat whole body as the prompt.
  return body;
}

/**
 * Managed ACP startSession bootstrap body (service already claimed).
 * Dynamic task pointers + near-field user prompt only.
 * Path tutorial is owned by Context Card; no claim/get/deliver CLI steps.
 * Final assistant response is captured by Local Service and auto-delivered.
 *
 * `roots` is accepted for call-site compatibility but not repeated here —
 * managed bootstrap prefixes Context Card (which carries workspaceRoot/systemRoot).
 */
export function sessionBootstrapPromptForTask(
  task: TaskEnvelope,
  _roots?: string | TaskPromptRoots
): string {
  const userPrompt = extractTaskUserPrompt(task);
  const kind = taskAssigneeKind(task);
  const readyLine =
    kind === "agentProfile"
      ? `A Tent managed ACP session is ready for agentProfile ${task.role}.\n`
      : `A Tent managed ACP session is ready for role ${task.role}.\n`;
  return (
    readyLine +
    `${formatTaskPointers(task)}\n` +
    `Service status: this task is already claimed (state=${task.state || "running"}).\n` +
    `Managed path: Local Service already claimed this task; end with an explicit outcome wire ` +
    `(\`outcome: delivered|blocked|needs-input\`) then the report body. Only \`delivered\` may become a ready Delivery after turn settle; blocker/question must use needs-input/blocked or ask-user — never self-accept.\n` +
    (kind === "agentProfile"
      ? `One-shot agentProfile task: rely on task/manifest pointers only — no role init.\n`
      : "") +
    (userPrompt
      ? `\n## User Prompt\n\n${userPrompt}\n`
      : `\n## User Prompt\n\n(no user prompt on envelope)\n`)
  );
}

export async function ensureRoleInit(
  fs: FsAdapter,
  role: RoleDefinition,
  tentName: string
): Promise<string> {
  const path = join("temp", role.name, "init.md");
  const body =
    `# Role Init\n\n` +
    `- Tent: ${tentName}\n` +
    `- Agent rules (workspace file read): AGENTS.md at the workspace root\n` +
    `- Role registry (workspace file read): .tent/roles.json (or run \`tent roles\` from workspace root)\n\n` +
    `## Role Prompt\n\n${role.prompt?.trim() || "(no persistent role prompt)"}\n\n` +
    `## Operating Model\n\n` +
    `Manifest readable/writable entries are an honor-system contract, not a security sandbox. If prompts conflict or a boundary cannot be followed, stop and ask the user.\n` +
    `Task lifecycle uses \`tent task *\` (Local Service). Do not invent paths as <workspace>/temp — operational files live under .tent/temp.\n`;
  await fs.writeFile(path, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path;
}

export async function writeTaskEnvelope(
  fs: FsAdapter,
  clock: Clock,
  input: TaskEnvelopeInput
): Promise<string> {
  const userPrompt = input.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");

  const assigneeKind: AssigneeKind = input.assigneeKind ?? "role";
  const dir =
    input.tasksDir?.trim() ||
    (assigneeKind === "agentProfile"
      ? agentProfileTasksDir(input.role)
      : join(TEMP_DIR, input.role, "tasks"));
  await ensureDir(fs, dir);
  const id = input.id && isTaskId(input.id) ? input.id : makeTaskId();

  // Split workspace/root context from Node refs — never persist fake "root" Node.
  // Empty nodes = stable workspace context (no second source flag).
  const isRootToken = (id: string) => id.trim() === "root";
  const workspaceOnly = input.claims.length > 0 && input.claims.every((c) => isRootToken(c.id));
  const nodeRefs: TaskContextCardRef[] = input.claims
    .filter((c) => !isRootToken(c.id))
    .map((c) => normalizeContextCardNodeRef({ id: c.id, path: c.path }));
  const primaryRef = nodeRefs[0]?.id || (workspaceOnly ? "root" : "node");
  const stem = taskStem(clock.now(), primaryRef);
  const path = await uniqueMarkdownPath(fs, dir, stem);
  const now = clock.now();
  const actors = resolveDispatchActors({
    parentActor: input.parentActor,
    reviewer: input.reviewer,
  });
  const deliveryPolicy = input.deliveryPolicy ?? DEFAULT_DELIVERY_POLICY;
  // Downstream Task Agent → parent: always review. Elevated policies only for
  // durable Role user-facing deliveries (parent=user + assigneeKind=role).
  if (
    deliveryPolicy !== "review" &&
    !mayElevateDeliveryPolicy({
      parentActor: actors.parentActor,
      assigneeKind,
    })
  ) {
    throw new Error(
      `deliveryPolicy=${deliveryPolicy} is only legal for a durable Role's user-facing delivery; ` +
        `downstream Task Agent → parent must use review (parent=${actors.parentActor.kind}:${actors.parentActor.id}).`
    );
  }

  const objective = (input.objective?.trim() || userPrompt).trim();
  if (!objective) throw new Error("Dispatch requires a non-empty objective (user prompt).");
  const acceptance =
    input.acceptance && input.acceptance.length > 0
      ? input.acceptance.map((s) => s.trim()).filter(Boolean)
      : [objective];
  if (acceptance.length === 0) {
    throw new Error("Dispatch requires non-empty acceptance (or objective).");
  }

  // Full Context Card v1 on every new write — sole Node-ref wire is refs.nodes[].
  // contextGeneration is deterministic from workspace/assignee identity (no secrets).
  const contextGeneration =
    input.contextGeneration?.trim() ||
    computeContextGeneration({
      workspaceIdentity: input.workspace?.workspace || "local-workspace",
      agentsPointerDigest: "dispatch-default-agents",
      extraStable: {
        assigneeKind,
        assignee: input.role,
        taskId: id,
      },
    });
  const assignee = projectAssigneeFromTask({
    role: input.role,
    assigneeKind,
    agentId: input.agentId,
  });
  const contextCard = buildTaskContextCard({
    objective,
    acceptance,
    refs: {
      nodes: nodeRefs,
      tasks: [],
      deliveries: [],
      git: [],
    },
    parentActor: actors.parentActor,
    reviewer: actors.reviewer,
    assignee,
    contextGeneration,
    userPrompt,
  });

  const data: Record<string, unknown> = {
    type: "task",
    id,
    status: "pending",
    state: "queued",
    role: input.role,
    assigneeKind,
    parentActor: serializeTaskActorRef(actors.parentActor),
    reviewer: serializeTaskActorRef(actors.reviewer),
    // Sole new persisted source wire — do not write claims[].
    contextCard: serializeTaskContextCardForFrontmatter(contextCard),
    contextGeneration: contextCard.contextGeneration,
    taskDeltaDigest: contextCard.taskDeltaDigest,
    manifest: input.manifestPath,
    deliveryPolicy,
    createdAt: now,
    updatedAt: now,
  };
  // Persist only when true; missing means peer (false). Git-lane sub marker only.
  if (input.asSub === true) data.asSub = true;
  if (input.agentId?.trim()) data.agentId = input.agentId.trim();
  if (input.sessionId) data.sessionId = input.sessionId;
  if (input.workspace) {
    data.workspace = input.workspace.workspace;
    data.worktree = input.workspace.worktree;
    data.branch = input.workspace.branch;
    data.targetBranch = input.workspace.targetBranch;
    // Lane exists: persist exact tip as Delivery baseCommit + legacy collection baseline.
    // Peer agentProfile / non-Git dispatch omit workspace entirely (no fake base).
    const tip =
      typeof input.workspace.baseCommit === "string"
        ? input.workspace.baseCommit.trim()
        : "";
    if (tip) {
      data.baseCommit = tip;
      data.roleBranchBase = tip;
    }
  }
  const pointers = [
    ...(workspaceOnly || nodeRefs.length === 0
      ? [`- workspace: ./ (stable workspace context; not a Node ref)`]
      : []),
    ...nodeRefs.map((claim) => `- ${claim.id}: ${claim.path || "(path hint pending)"}`),
  ].join("\n");
  const body =
    `# Task\n\n` +
    `## Context Pointers\n\n${pointers || "(none)"}\n\n` +
    `- Manifest: ${input.manifestPath}\n` +
    (input.id || id ? `- Task id: ${id}\n` : "") +
    `\n## User Prompt\n\n${userPrompt}\n`;
  await fs.writeFile(path, serializeFrontmatter(data, body));
  return path;
}

export async function ackTaskEnvelope(fs: FsAdapter, path: string): Promise<void> {
  await patchTaskEnvelope(fs, path, {
    status: "taken",
    state: "running",
  });
}

export async function cancelTaskEnvelope(fs: FsAdapter, path: string): Promise<void> {
  const task = await loadTaskEnvelope(fs, path);
  if (task.state !== "queued" && task.status !== "pending") {
    throw new Error("Only queued (pending) task envelopes can be cancelled.");
  }
  await fs.remove(path);
}

export interface TaskEnvelopePatch {
  status?: TaskEnvelopeStatus;
  state?: TaskState;
  sessionId?: string | null;
  wait?: TaskWait | null;
  activeDeliveryId?: string | null;
  deliveryPolicy?: DeliveryPolicy;
  parentActor?: TaskActorRef;
  reviewer?: TaskActorRef;
  lastOutcome?: TaskOutcome | null;
  /**
   * When true, strip legacy dispatchedBy from disk after parent/reviewer write
   * (one-time migration). Does not dual-write.
   */
  clearLegacyDispatchedBy?: boolean;
  updatedAt?: string;
  /** Role WorkspaceLane fields (real workspace Git only). */
  workspace?: string | null;
  worktree?: string | null;
  branch?: string | null;
  targetBranch?: string | null;
  /**
   * Capture-once baseline for managed collection. Prefer omit once set;
   * null clears (tests only). Never overwrite an existing non-empty value from
   * normal bind/resume paths.
   */
  roleBranchBase?: string | null;
  /**
   * Capture-once Task lane start (cx-5q6za6 history gate). Prefer omit once set.
   * When set, also mirrors roleBranchBase for collection compatibility unless
   * roleBranchBase is already present.
   */
  baseCommit?: string | null;
  /**
   * Compact capture audit. Prefer omit once set; null clears (tests only).
   * Same-SHA idempotent backfill must not rewrite an existing bag.
   */
  baseCommitCapture?: BaseCommitCapture | null;
  /** Persist integrationAuthority; null clears. */
  integrationAuthority?: IntegrationAuthority | null;
  /**
   * Persist authoritative Context Card v1 under frontmatter `contextCard`.
   * Also mirrors contextGeneration / taskDeltaDigest as top-level keys for
   * Session compatibility projections. null clears all three.
   */
  contextCard?: TaskContextCardV1 | null;
  /** Top-level generation only (when full card is not yet written). */
  contextGeneration?: string | null;
  taskDeltaDigest?: string | null;
}

/** Low-level patch of task operational frontmatter (body stays immutable). */
export async function patchTaskEnvelope(
  fs: FsAdapter,
  path: string,
  patch: TaskEnvelopePatch
): Promise<TaskEnvelope> {
  if (!(await fs.exists(path))) throw new Error(`Task envelope not found: ${path}.`);
  const raw = await fs.readFile(path);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") throw new Error(`Invalid task envelope format: ${path}.`);

  if (patch.state) {
    data.state = patch.state;
    data.status = stateToLegacyStatus(patch.state);
  } else if (patch.status) {
    data.status = patch.status;
    if (!data.state) data.state = legacyStatusToState(patch.status);
  }
  if (patch.sessionId === null) delete data.sessionId;
  else if (typeof patch.sessionId === "string") data.sessionId = patch.sessionId;

  if (patch.wait === null) {
    delete data.waitReason;
    delete data.waitSummary;
    delete data.waitCode;
  } else if (patch.wait) {
    data.waitReason = patch.wait.reason;
    data.waitSummary = patch.wait.summary;
    const code = patch.wait.code?.trim();
    if (code) data.waitCode = code;
    else delete data.waitCode;
  }

  if (patch.activeDeliveryId === null) delete data.activeDeliveryId;
  else if (typeof patch.activeDeliveryId === "string") data.activeDeliveryId = patch.activeDeliveryId;

  if (patch.deliveryPolicy) data.deliveryPolicy = patch.deliveryPolicy;
  if (patch.parentActor || patch.reviewer) {
    // Keep parent/reviewer equal on every write via shared pair resolver.
    const nextParent = patch.parentActor
      ? parseTaskActorRef(patch.parentActor, "parentActor")
      : data.parentActor !== undefined && data.parentActor !== null
        ? parseTaskActorRef(data.parentActor, "parentActor")
        : undefined;
    if (!nextParent) {
      throw new Error(
        "patchTaskEnvelope parentActor/reviewer requires an existing or explicit parentActor."
      );
    }
    const nextReviewer = patch.reviewer
      ? parseTaskActorRef(patch.reviewer, "reviewer")
      : patch.parentActor
        ? undefined // derive equal to parent
        : data.reviewer !== undefined && data.reviewer !== null
          ? parseTaskActorRef(data.reviewer, "reviewer")
          : undefined;
    const pair = resolveParentReviewerPair({
      parentActor: nextParent,
      reviewer: nextReviewer,
    });
    data.parentActor = serializeTaskActorRef(pair.parentActor);
    data.reviewer = serializeTaskActorRef(pair.reviewer);
    // Authority is a projection of parent/reviewer + service — re-derive on actor write.
    const derived = deriveIntegrationAuthority({
      parentActor: pair.parentActor,
      reviewer: pair.reviewer,
    });
    data.integrationAuthority = {
      actor: { kind: derived.actor.kind, id: derived.actor.id },
      mutator: "service",
    };
  }
  if (patch.clearLegacyDispatchedBy) {
    delete data.dispatchedBy;
  }
  if (patch.lastOutcome === null) delete data.lastOutcome;
  else if (
    patch.lastOutcome === "delivered" ||
    patch.lastOutcome === "blocked" ||
    patch.lastOutcome === "needs-input"
  ) {
    data.lastOutcome = patch.lastOutcome;
  }
  if (patch.updatedAt) data.updatedAt = patch.updatedAt;

  for (const key of ["workspace", "worktree", "branch", "targetBranch"] as const) {
    const value = patch[key];
    if (value === null) delete data[key];
    else if (typeof value === "string") data[key] = value;
  }

  if (patch.roleBranchBase === null) delete data.roleBranchBase;
  else if (typeof patch.roleBranchBase === "string" && patch.roleBranchBase.trim()) {
    data.roleBranchBase = patch.roleBranchBase.trim();
  }

  if (patch.baseCommit === null) delete data.baseCommit;
  else if (typeof patch.baseCommit === "string" && patch.baseCommit.trim()) {
    // Exact workspaceLane.baseCommit only — do not auto-mirror into roleBranchBase.
    data.baseCommit = patch.baseCommit.trim();
  }

  if (patch.baseCommitCapture === null) delete data.baseCommitCapture;
  else if (patch.baseCommitCapture) {
    data.baseCommitCapture = serializeBaseCommitCapture(patch.baseCommitCapture);
  }

  if (patch.integrationAuthority === null) delete data.integrationAuthority;
  else if (patch.integrationAuthority) {
    // Persist only after validating against envelope parent/reviewer (already
    // equal-resolved above when actors were patched). Reject forged bags.
    if (data.parentActor === undefined || data.parentActor === null) {
      throw new Error(
        "patchTaskEnvelope integrationAuthority requires parentActor/reviewer on the envelope."
      );
    }
    const parentForAuth = parseTaskActorRef(data.parentActor, "parentActor");
    const reviewerForAuth =
      data.reviewer !== undefined && data.reviewer !== null
        ? parseTaskActorRef(data.reviewer, "reviewer")
        : parentForAuth;
    const validated = assertIntegrationAuthorityMatchesParent(
      patch.integrationAuthority,
      parentForAuth,
      reviewerForAuth
    );
    data.integrationAuthority = {
      actor: { kind: validated.actor.kind, id: validated.actor.id },
      mutator: "service",
    };
  }

  if (patch.contextCard === null) {
    delete data.contextCard;
    delete data.contextGeneration;
    delete data.taskDeltaDigest;
  } else if (patch.contextCard) {
    data.contextCard = serializeTaskContextCardForFrontmatter(patch.contextCard);
    data.contextGeneration = patch.contextCard.contextGeneration;
    data.taskDeltaDigest = patch.contextCard.taskDeltaDigest;
  }
  if (patch.contextGeneration === null) delete data.contextGeneration;
  else if (typeof patch.contextGeneration === "string" && patch.contextGeneration.trim()) {
    data.contextGeneration = patch.contextGeneration.trim();
  }
  if (patch.taskDeltaDigest === null) delete data.taskDeltaDigest;
  else if (typeof patch.taskDeltaDigest === "string" && patch.taskDeltaDigest.trim()) {
    data.taskDeltaDigest = patch.taskDeltaDigest.trim();
  }

  await fs.writeFile(path, serializeFrontmatter(data, body, keyOrder));
  return loadTaskEnvelope(fs, path);
}

export function workspaceLaneOf(task: TaskEnvelope): WorkspaceLane | undefined {
  if (
    !task.workspace &&
    !task.worktree &&
    !task.branch &&
    !task.targetBranch &&
    !task.baseCommit &&
    !task.integrationAuthority
  ) {
    return undefined;
  }
  // baseCommit is exact only — never substitute roleBranchBase in the projection.
  // integrationAuthority on the lane projection: prefer recorded envelope field;
  // otherwise derive for Context projection only (does not invent envelope truth).
  const integrationAuthority = task.integrationAuthority
    ? task.integrationAuthority
    : task.parentActor && task.reviewer
      ? deriveIntegrationAuthority({
          parentActor: task.parentActor,
          reviewer: task.reviewer,
        })
      : undefined;
  return {
    workspace: task.workspace,
    worktree: task.worktree,
    branch: task.branch,
    targetBranch: task.targetBranch,
    ...(task.baseCommit ? { baseCommit: task.baseCommit } : {}),
    ...(integrationAuthority ? { integrationAuthority } : {}),
  };
}

export function primaryBoxId(task: TaskEnvelope): string | undefined {
  if (task.contextCard == null) return undefined;
  return taskReferencedNodeIds(task)[0];
}

function parseTaskState(value: unknown, legacy: TaskEnvelopeStatus): TaskState {
  if (
    value === "queued" ||
    value === "running" ||
    value === "waiting" ||
    value === "delivered" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "interrupted" ||
    value === "failed"
  ) {
    return value;
  }
  return legacyStatusToState(legacy);
}

function parseWaitFields(data: Record<string, unknown>): TaskWait | undefined {
  const reason = data.waitReason;
  const summary = data.waitSummary;
  if (
    (reason === "user-input" ||
      reason === "a2a-approval" ||
      reason === "review" ||
      reason === "external") &&
    typeof summary === "string"
  ) {
    const code =
      typeof data.waitCode === "string" && data.waitCode.trim()
        ? data.waitCode.trim()
        : undefined;
    return { reason, summary, ...(code ? { code } : {}) };
  }
  return undefined;
}

function taskStem(now: string, claimId: string): string {
  const stamp = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 14) || "task";
  return `task-${stamp}-${claimId.replace(/[^0-9A-Za-z_-]+/g, "-")}`;
}

async function uniqueMarkdownPath(fs: FsAdapter, dir: string, stem: string): Promise<string> {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path = join(dir, `${stem}${suffix}.md`);
    if (!(await fs.exists(path))) return path;
  }
}

async function ensureDir(fs: FsAdapter, path: string): Promise<void> {
  if (!(await fs.exists(path))) await fs.mkdir(path);
}
