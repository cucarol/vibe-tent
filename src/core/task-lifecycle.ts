// Task lifecycle API (B4) — claim / wait / deliver / accept / reject / interrupt.
// Uses existing envelope files under temp/<role>/tasks and delivery records.
// Runtime occupation oracle = active Task envelope only.
// Node frontmatter is not dual-written for owner/status; collaboration truth is Task/Delivery.

import { withTentMutation, type FsAdapter } from "./adapter.js";
import { canClaim, envelopeIsActiveOccupation } from "./claim.js";
import {
  listDirectActiveTasksForNode,
} from "./task-node-refs.js";
import {
  createDeliveryUnlocked,
  loadDelivery,
  peekDeliveryTaskId,
  removeNonAcceptedDeliveriesForTask,
  writeDelivery,
  type DeliveryRecord,
} from "./delivery.js";
import { normalizeArtifactRefs } from "./artifact.js";
import {
  bindOutputsToDeliveryUnlocked,
  restoreOutputBindSnapshots,
  validateOutputBindingsForAccept,
  type OutputBindSnapshot,
} from "./output.js";
import type { OpsEnv } from "./ops-context.js";
import { join, loadTent, type LoadedTent } from "./tree.js";
import type { Node } from "./types.js";
import {
  ackTaskEnvelope,
  loadTaskEnvelope,
  loadTaskEnvelopes,
  patchTaskEnvelope,
  primaryNodeId,
  type TaskEnvelope,
  type TaskEnvelopePatch,
} from "./task.js";
import { isSessionId } from "./id.js";
import {
  assertReviewAuthority,
  assertTransition,
  isTaskId,
  resolveDeliverRouting,
  TaskLifecycleError,
  type ArtifactRef,
  type DeliverDecision,
  type DeliveryCheck,
  type TaskState,
  type WaitReason,
} from "./task-model.js";

export type TaskClaimWrite = TaskEnvelopePatch;

export interface TaskClaimOptions {
  /**
   * Optional single-write claim payload after structural checks.
   * When set on first claim (queued→running), state + lane/base/audit
   * are persisted in **one** envelope patch. Callers must prepare lane/base before
   * invoking claim so a failed prepare leaves the Task queued.
   * A queued Role handoff binds its trusted caller Session in this same write.
   * Connection-launched Tasks already carry their reserved Session. Lifecycle
   * state is forced to running by claim.
   */
  claimWrite?: TaskClaimWrite;
}

export interface TaskWaitOptions {
  reason: WaitReason;
  summary: string;
  /** Optional stable machine code (e.g. session_unavailable). */
  code?: string;
}

export interface TaskDeliverOptions {
  summary: string;
  commits?: string[];
  /**
   * Internal explicit execution outcome to publish with the legal Delivery
   * transition. Service callers must never persist it before Delivery creation.
   */
  lastOutcome?: "delivered";
  /**
   * Review-time full SHA of the resolved integration target branch HEAD.
   * Service snapshots this for commit-bearing Deliveries; Core persists it.
   */
  targetHead?: string;
  checks?: DeliveryCheck[];
  artifactRefs?: ArtifactRef[];
  /** Required when acceptMode=agent-decide. */
  decision?: DeliverDecision;
  /** Optional integrate hook for auto-accept / agent-decide integrate. */
  integrate?: (commits: string[]) => Promise<void>;
}

export interface TaskAcceptOptions {
  actor: string;
  /** Exact ready Delivery shown to the reviewer. */
  deliveryId: string;
  integrate?: (commits: string[]) => Promise<void>;
  /**
   * Optional Output Node ids to bind to the accepted Delivery (`deliveryId` FM).
   * Validated all-or-nothing inside the final accept mutation; any failure
   * leaves Task/Delivery/Output unchanged (not partially accepted).
   */
  outputNodeIds?: string[];
}

export interface TaskRejectOptions {
  actor: string;
  /** Exact ready Delivery shown to the reviewer. */
  deliveryId: string;
  note?: string;
  /** Default true — rework path delivered → running. */
  resume?: boolean;
}

export const DEFAULT_TASK_REJECT_NOTE = "Rejected; waiting for resubmission.";

export async function taskClaim(env: OpsEnv, taskPath: string, options: TaskClaimOptions = {}): Promise<TaskEnvelope> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    const requestedSessionId = options.claimWrite?.sessionId;
    if (task.sessionId && requestedSessionId && requestedSessionId !== task.sessionId) {
      throw new Error(
        `Cannot claim task with a different Session: bound=${task.sessionId} requested=${requestedSessionId}`
      );
    }
    if (task.state === "running") {
      if (requestedSessionId && requestedSessionId !== task.sessionId) {
        throw new Error(
          `Cannot claim task with a different Session: bound=${task.sessionId ?? "missing"} requested=${requestedSessionId}`
        );
      }
      return task;
    }
    assertTransition(task.state, "claim", "running");

    const tent = await loadTent(env.fs);
    const claimedNodes = task.workNodeIds.map((claimId) =>
      requireNodeById(tent, claimId)
    );

    // Re-check exact Node occupation at claim. Exclude this queued Task itself;
    // another active Task on any requested Node blocks the all-or-none claim.
    const otherTasks = (await loadTaskEnvelopes(env.fs)).filter(
      (candidate) => candidate.path !== task.path
    );
    for (const node of claimedNodes) {
      const claimable = canClaim(node, { tasks: otherTasks });
      if (!claimable.ok) throw new Error(`Cannot claim task: ${claimable.reason || "node cannot be claimed"}`);
    }

    // Single envelope write: running + optional lane/base/audit together.
    // No intermediate lane-only patch; failed prepare must not reach this path.
    const now = env.clock.now();
    if (options.claimWrite) {
      if (options.claimWrite.sessionId && !isSessionId(options.claimWrite.sessionId)) {
        throw new Error(`task.claim requires a canonical Session id: ${options.claimWrite.sessionId}`);
      }
      return patchTaskEnvelope(env.fs, taskPath, {
        ...options.claimWrite,
        state: "running",
        updatedAt: options.claimWrite.updatedAt ?? now,
      });
    }

    // Claim only acks the envelope — no Node frontmatter owner/status dual-write.
    await ackTaskEnvelope(env.fs, taskPath);
    return loadTaskEnvelope(env.fs, taskPath);
  });
}

export async function taskWait(env: OpsEnv, taskPath: string, options: TaskWaitOptions): Promise<TaskEnvelope> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    assertTransition(task.state, "wait", "waiting");
    const summary = options.summary.trim();
    if (!summary) throw new Error("task.wait requires a non-empty summary.");
    const code = options.code?.trim();
    return patchTaskEnvelope(env.fs, taskPath, {
      state: "waiting",
      wait: {
        reason: options.reason,
        summary,
        ...(code ? { code } : {}),
      },
      updatedAt: env.clock.now(),
    });
  });
}

export async function taskResume(env: OpsEnv, taskPath: string): Promise<TaskEnvelope> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    // Idempotent: already running after concurrent approve + session.live is fine.
    if (task.state === "running" && !task.wait) return task;
    assertTransition(task.state, "resume", "running");
    return patchTaskEnvelope(env.fs, taskPath, {
      state: "running",
      wait: null,
      updatedAt: env.clock.now(),
    });
  });
}

/**
 * Exact-Task structural WAL preflight for composite Service mutations.
 * It performs no requested transition: pending reject and committed Delivery
 * operations converge first, then the caller evaluates the returned Task.
 */
export interface TaskRejectResumeContinuation {
  deliveryId: string;
  actor: string;
  note: string;
}

export interface TaskLifecycleReconciliation {
  task: TaskEnvelope;
  rejectResume?: TaskRejectResumeContinuation;
}

export async function reconcileTaskLifecycle(
  env: OpsEnv,
  taskPath: string
): Promise<TaskLifecycleReconciliation> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    const rejectResume = await completedTaskRejectResume(env.fs, task);
    return {
      task,
      ...(rejectResume ? { rejectResume } : {}),
    };
  });
}

export interface TaskDeliverResult {
  task: TaskEnvelope;
  delivery: DeliveryRecord;
  autoIntegrated: boolean;
}

/**
 * First deliver section under mutation.lock.
 * Every mode first publishes one durable ready Delivery candidate.
 * Auto-integrate modes return that exact candidate for Git integration outside the lock.
 */
export type TaskDeliverPrepared =
  | { kind: "done"; result: TaskDeliverResult }
  | {
      kind: "auto";
      sourceNodeId: string;
      deliveryId: string;
      commits: string[];
      targetHead?: string;
    };

export interface CommittedTaskDeliverRecovery {
  task: TaskEnvelope;
  delivery: DeliveryRecord;
  prepared: TaskDeliverPrepared;
  options: TaskDeliverOptions;
}

export interface TaskAcceptPrepared {
  deliveryId: string;
  deliveryPath: string;
  commits: string[];
}

export interface TaskAcceptResult {
  task: TaskEnvelope;
  delivery: DeliveryRecord;
  /** Output Node ids successfully bound (including same-delivery idempotent). */
  boundOutputIds: string[];
  /** Subset that newly wrote deliveryId (for node.changed). */
  changedOutputIds: string[];
}

/**
 * Prepare deliver under cross-process mutation.lock only.
 * Service callers should wrap this in a short MutationBus section and run
 * integrateCommits outside MutationBus when kind==="auto" and commits exist.
 */
export async function prepareTaskDeliver(
  env: OpsEnv,
  taskPath: string,
  options: TaskDeliverOptions
): Promise<TaskDeliverPrepared> {
  return withMutation(env.fs, async (): Promise<TaskDeliverPrepared> => {
    const task = await preflightTaskMutation(env, taskPath);
    const recovered = await recoverExistingTaskDeliver(env, taskPath, task, options);
    if (recovered) return recovered;
    assertDeliverPreconditions(task);
    const nodeId = primaryNodeId(task);
    if (!nodeId) throw new Error("task.deliver requires a non-root node claim.");
    await assertNoReadyDelivery(env.fs, task);

    const routing = resolveDeliverRouting(task.acceptMode, options.decision);

    const delivery = await createDeliveryUnlocked(env.fs, env.clock, {
      taskId: requireCanonicalTaskId(task),
      sourceNodeId: nodeId,
      summary: options.summary,
      commits: options.commits,
      targetHead: options.targetHead,
      checks: options.checks,
      artifactRefs: options.artifactRefs,
      taskLastOutcome: options.lastOutcome,
      status: "ready",
      integrationMode: routing.integrationMode,
      deliveriesDir: deliveryDirForTask(task),
    });

    assertTransition(task.state, "deliver", "delivered");
    const next = await patchTaskEnvelope(env.fs, taskPath, {
      state: "delivered",
      activeDeliveryId: delivery.id,
      ...(delivery.taskLastOutcome ? { lastOutcome: delivery.taskLastOutcome } : {}),
      updatedAt: env.clock.now(),
    });
    if (routing.autoIntegrate) {
      return {
        kind: "auto",
        sourceNodeId: nodeId,
        deliveryId: delivery.id,
        commits: [...delivery.commits],
        ...(delivery.targetHead ? { targetHead: delivery.targetHead } : {}),
      };
    }
    return { kind: "done", result: { task: next, delivery, autoIntegrated: false } };
  });
}

/**
 * Recover an already-committed exact-Task Delivery WAL without reconstructing
 * its immutable candidate from current Git/lane state. Used by the managed
 * report-draft retry path after a Service crash. It never creates a Delivery.
 */
export async function recoverCommittedTaskDeliver(
  env: OpsEnv,
  taskPath: string,
  expected: { summary: string; lastOutcome?: "delivered" }
): Promise<CommittedTaskDeliverRecovery | undefined> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    const delivery = await findCommittedTaskDelivery(env.fs, task);
    if (!delivery || (delivery.status !== "ready" && delivery.status !== "accepted")) {
      return undefined;
    }
    assertCommittedDeliveryMatchesTask(task, delivery);
    if (
      delivery.summary !== expected.summary.trim() ||
      delivery.taskLastOutcome !== expected.lastOutcome
    ) {
      throw new TaskLifecycleError(
        "DELIVERY_CHANGED",
        "Persisted Delivery report or outcome does not match the managed report draft."
      );
    }
    const prepared: TaskDeliverPrepared = delivery.status === "accepted"
      ? {
          kind: "done",
          result: { task, delivery, autoIntegrated: isAutoIntegrationMode(delivery.integrationMode) },
        }
      : isAutoIntegrationMode(delivery.integrationMode)
        ? {
            kind: "auto",
            sourceNodeId: delivery.sourceNodeId,
            deliveryId: delivery.id,
            commits: [...delivery.commits],
            ...(delivery.targetHead ? { targetHead: delivery.targetHead } : {}),
          }
        : {
            kind: "done",
            result: { task, delivery, autoIntegrated: false },
          };
    const options: TaskDeliverOptions = {
      summary: delivery.summary,
      commits: [...delivery.commits],
      checks: delivery.checks.map((check) => ({ ...check })),
      artifactRefs: delivery.artifactRefs.map((ref) => ({ ...ref })),
      ...(delivery.targetHead ? { targetHead: delivery.targetHead } : {}),
      ...(delivery.taskLastOutcome ? { lastOutcome: delivery.taskLastOutcome } : {}),
      ...(delivery.integrationMode === "agent-decided-integrate"
        ? { decision: "integrate" as const }
        : {}),
    };
    return { task, delivery, prepared, options };
  });
}

/**
 * Finalize auto-integrate under mutation.lock after Git ran outside the lock.
 * Integration failure deliberately leaves the durable ready Delivery candidate intact.
 */
export async function finalizeTaskDeliverAuto(
  env: OpsEnv,
  taskPath: string,
  options: TaskDeliverOptions,
  prepared: Extract<TaskDeliverPrepared, { kind: "auto" }>
): Promise<TaskDeliverResult> {
  return withMutation(env.fs, async () => {
    let task = await preflightTaskMutation(env, taskPath);
    const persisted = await requireTaskDeliveryById(env.fs, task, prepared.deliveryId);
    if (task.activeDeliveryId !== persisted.id) {
      throw new TaskLifecycleError(
        "DELIVERY_CHANGED",
        "Ready delivery changed during auto-accept; refusing state write."
      );
    }

    if (persisted.status === "accepted") {
      if (!isAutoIntegrationMode(persisted.integrationMode)) {
        throw new TaskLifecycleError(
          "DELIVERY_CHANGED",
          "Accepted delivery is not an auto-integrate candidate; refusing recovery."
        );
      }
      if (task.state === "delivered") {
        task = await patchTaskEnvelope(env.fs, taskPath, {
          state: "accepted",
          activeDeliveryId: persisted.id,
          ...(persisted.taskLastOutcome ? { lastOutcome: persisted.taskLastOutcome } : {}),
          wait: null,
          updatedAt: env.clock.now(),
        });
      } else if (task.state !== "accepted") {
        throw new TaskLifecycleError(
          "INVALID_TRANSITION",
          `Cannot recover accepted Delivery while Task is ${task.state}.`
        );
      }
      assertTaskDeliverCandidateMatches(task, persisted, options);
      assertPreparedDeliveryMatches(persisted, prepared);
      return { task, delivery: persisted, autoIntegrated: true };
    }

    assertTransition(task.state, "accept", "accepted");
    const nodeId = primaryNodeId(task);
    if (!nodeId || nodeId !== prepared.sourceNodeId) {
      throw new Error("task.deliver requires a non-root node claim.");
    }
    const delivery = await requireActiveReadyDelivery(env.fs, task);
    if (delivery.id !== prepared.deliveryId) {
      throw new TaskLifecycleError(
        "DELIVERY_CHANGED",
        "Ready delivery changed during auto-accept; refusing state write."
      );
    }
    if (!exactStringListEqual(delivery.commits, prepared.commits)) {
      throw new TaskLifecycleError(
        "DELIVERY_CHANGED",
        "Ready delivery commits changed during auto-accept; refusing state write."
      );
    }
    if ((delivery.targetHead?.trim() || undefined) !== prepared.targetHead) {
      throw new TaskLifecycleError(
        "DELIVERY_CHANGED",
        "Ready delivery targetHead changed during auto-accept; refusing state write."
      );
    }

    const routing = resolveDeliverRouting(task.acceptMode, options.decision);
    if (!routing.autoIntegrate) {
      throw new Error("Task acceptMode changed during integrate; refusing state write.");
    }
    assertTaskDeliverCandidateMatches(task, delivery, options);
    assertPreparedDeliveryMatches(delivery, prepared);

    delivery.status = "accepted";
    delivery.integrationMode = routing.integrationMode;
    delivery.updatedAt = env.clock.now();
    await writeDelivery(env.fs, delivery);
    // No review.by = submitter — integrate is service policy engine action.
    // Occupation ends via task state=accepted; no Node frontmatter write.

    const next = await patchTaskEnvelope(env.fs, taskPath, {
      state: "accepted",
      activeDeliveryId: delivery.id,
      ...(delivery.taskLastOutcome ? { lastOutcome: delivery.taskLastOutcome } : {}),
      wait: null,
      updatedAt: env.clock.now(),
    });
    return { task: next, delivery, autoIntegrated: true };
  });
}

export async function taskDeliver(
  env: OpsEnv,
  taskPath: string,
  options: TaskDeliverOptions
): Promise<TaskDeliverResult> {
  // review-required path: one atomic ready-Delivery section (no Git).
  // Auto-integrate path: durable ready Delivery → Git outside lock → exact
  // candidate re-validation + accepted writes. Integration failure preserves
  // the candidate and targetHead/commits for review or retry.
  const phase = await prepareTaskDeliver(env, taskPath, options);
  if (phase.kind === "done") return phase.result;

  const pendingCommits = [...phase.commits];
  if (pendingCommits.length > 0) {
    if (!options.integrate) {
      throw new Error("Auto-integrate path requires integrate() when commits are present.");
    }
    await options.integrate(pendingCommits);
  }

  return finalizeTaskDeliverAuto(env, taskPath, options, phase);
}

/**
 * Prepare accept under mutation.lock: authority, ready Delivery, optional Output pre-check.
 * Service should wrap in a short MutationBus section; Git integrate must run outside both.
 */
export async function prepareTaskAccept(
  env: OpsEnv,
  taskPath: string,
  options: TaskAcceptOptions
): Promise<TaskAcceptPrepared> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    assertTransition(task.state, "accept", "accepted");
    const delivery = await requireExpectedActiveReadyDelivery(
      env.fs,
      task,
      options.deliveryId
    );
    assertReviewAuthority({
      actor: options.actor,
      executorRoleId: task.roleId,
      reviewer: task.reviewer,
      action: "accept",
    });
    // Pre-validate Outputs before integrate so bad selectors fail before side effects.
    if (options.outputNodeIds && options.outputNodeIds.length > 0) {
      const tent = await loadTent(env.fs);
      validateOutputBindingsForAccept(tent, options.outputNodeIds, delivery.id);
    }
    return {
      deliveryId: delivery.id,
      deliveryPath: delivery.path,
      commits: [...delivery.commits],
    };
  });
}

/**
 * Finalize accept under mutation.lock after Git integrate (when any) ran outside the lock.
 * Revalidates Delivery/authority, binds Outputs, writes accepted Task/Delivery atomically.
 */
export async function finalizeTaskAccept(
  env: OpsEnv,
  taskPath: string,
  options: TaskAcceptOptions,
  prepared: TaskAcceptPrepared
): Promise<TaskAcceptResult> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    assertTransition(task.state, "accept", "accepted");
    const delivery = await requireExpectedActiveReadyDelivery(
      env.fs,
      task,
      options.deliveryId
    );
    if (delivery.id !== prepared.deliveryId) {
      throw new TaskLifecycleError(
        "DELIVERY_CHANGED",
        "Ready delivery changed during integrate; refusing accept."
      );
    }
    if (!exactStringListEqual(delivery.commits, prepared.commits)) {
      throw new TaskLifecycleError(
        "DELIVERY_CHANGED",
        "Ready delivery commits changed during accept; refusing accept."
      );
    }
    assertReviewAuthority({
      actor: options.actor,
      executorRoleId: task.roleId,
      reviewer: task.reviewer,
      action: "accept",
    });

    // Snapshot Delivery + Task raw BEFORE any Output write so a later snapshot-read
    // failure cannot leave Outputs bound with no operational rollback material.
    // Order (final mutation, after delivery revalidation):
    //   1) operational raw snapshots (fail here → zero Output writes)
    //   2) Output bind (own raw snapshots + write rollback)
    //   3) accepted Delivery/Task persistence (compensate with 1+2 on failure)
    const deliveryRawBefore = await env.fs.readFile(delivery.path);
    const taskRawBefore = await env.fs.readFile(taskPath);

    const tent = await loadTent(env.fs);
    /** Populated only after bind returns; mid-bind failures roll back inside bind. */
    let outputSnapshots: OutputBindSnapshot[] = [];

    try {
      const bindResult = await bindOutputsToDeliveryUnlocked(
        env.fs,
        tent,
        options.outputNodeIds,
        delivery.id
      );
      outputSnapshots = bindResult.snapshots;

      delivery.status = "accepted";
      delivery.integrationMode = "manual-accept";
      delivery.review = { by: options.actor, decision: "accept" };
      delivery.updatedAt = env.clock.now();
      await writeDelivery(env.fs, delivery);

      // Accept ends occupation via task state; collab FM dual-write stays retired.
      // Output.deliveryId is the sole provenance write path (not collab projection).
      const next = await patchTaskEnvelope(env.fs, taskPath, {
        state: "accepted",
        wait: null,
        updatedAt: env.clock.now(),
      });
      return {
        task: next,
        delivery,
        boundOutputIds: bindResult.boundIds,
        changedOutputIds: bindResult.changedIds,
      };
    } catch (err) {
      // Restore Delivery/Task from pre-accept raw (no-op if never written).
      // Restore Outputs when bind completed and a later step failed.
      // Snapshot-read failures never reach here with bound Outputs.
      await compensateAcceptAfterOutputBind(env.fs, {
        deliveryPath: delivery.path,
        deliveryRawBefore,
        taskPath,
        taskRawBefore,
        outputSnapshots,
      });
      throw err;
    }
  });
}

function exactStringListEqual(
  current: readonly string[],
  prepared: readonly string[]
): boolean {
  return (
    current.length === prepared.length &&
    current.every((value, index) => value === prepared[index])
  );
}

export async function taskAccept(
  env: OpsEnv,
  taskPath: string,
  options: TaskAcceptOptions
): Promise<TaskAcceptResult> {
  // Validate authority + ready delivery under lock; Git integrate outside;
  // then re-validate, bind Outputs, and write accepted atomically under lock.
  const prepared = await prepareTaskAccept(env, taskPath, options);

  if (prepared.commits.length > 0) {
    if (!options.integrate) {
      throw new Error("Delivery contains commits; workspace integration is required.");
    }
    await options.integrate(prepared.commits);
  }

  return finalizeTaskAccept(env, taskPath, options, prepared);
}

/**
 * After Outputs were bound but Delivery/Task accepted persistence failed:
 * restore Task + Delivery raw, then Output snapshots. Fail loud if any restore fails.
 */
async function compensateAcceptAfterOutputBind(
  fs: FsAdapter,
  args: {
    deliveryPath: string;
    deliveryRawBefore: string;
    taskPath: string;
    taskRawBefore: string;
    outputSnapshots: readonly OutputBindSnapshot[];
  }
): Promise<void> {
  const failures: string[] = [];
  try {
    await fs.writeFile(args.deliveryPath, args.deliveryRawBefore);
  } catch (err) {
    failures.push(
      `delivery ${args.deliveryPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  try {
    await fs.writeFile(args.taskPath, args.taskRawBefore);
  } catch (err) {
    failures.push(
      `task ${args.taskPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  try {
    await restoreOutputBindSnapshots(fs, args.outputSnapshots);
  } catch (err) {
    failures.push(
      `outputs: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (failures.length > 0) {
    throw new TaskLifecycleError(
      "ACCEPT_ROLLBACK_FAILED",
      `task.accept failed after Output bind and compensating rollback also failed: ${failures.join("; ")}`
    );
  }
}

export async function taskReject(
  env: OpsEnv,
  taskPath: string,
  options: TaskRejectOptions
): Promise<{ task: TaskEnvelope; delivery: DeliveryRecord }> {
  return withMutation(env.fs, async () => {
    const recovered = await reconcilePendingTaskReject(env, taskPath);
    if (recovered) {
      assertTaskRejectRequestMatchesIntent(recovered.intent, options);
      // The committed reject WAL wins, then the ordinary exact-Task preflight
      // validates that no competing Delivery WAL remains before success.
      const task = await preflightTaskMutation(env, taskPath);
      return { task, delivery: recovered.delivery };
    }
    let task = await loadTaskEnvelope(env.fs, taskPath);
    task = await reconcileCommittedTaskDelivery(env, taskPath, task);
    const completed = await recoverCompletedTaskReject(env.fs, task, options);
    if (completed) return completed;
    const resume = options.resume !== false;
    const event = resume ? "reject-resume" : "reject-terminal";
    const to: TaskState = resume ? "running" : "rejected";
    assertTransition(task.state, event, to);

    const delivery = await requireExpectedActiveReadyDelivery(
      env.fs,
      task,
      options.deliveryId
    );
    // Exact Task.reviewer only (no user override on Role-reviewed); never self.
    assertReviewAuthority({
      actor: options.actor,
      executorRoleId: task.roleId,
      reviewer: task.reviewer,
      action: "reject",
    });

    const intent: TaskRejectIntent = {
      type: TASK_REJECT_INTENT_TYPE,
      version: 1,
      taskId: requireCanonicalTaskId(task),
      deliveryId: delivery.id,
      to,
      actor: options.actor,
      note: options.note?.trim() || DEFAULT_TASK_REJECT_NOTE,
      updatedAt: env.clock.now(),
    };
    await writeTaskRejectIntent(env.fs, taskPath, intent);
    return completeTaskRejectIntent(env, taskPath, task, delivery, intent);
  });
}

async function recoverCompletedTaskReject(
  fs: FsAdapter,
  task: TaskEnvelope,
  options: TaskRejectOptions
): Promise<{ task: TaskEnvelope; delivery: DeliveryRecord } | undefined> {
  if (
    !task.activeDeliveryId ||
    (task.state !== "running" && task.state !== "rejected")
  ) {
    return undefined;
  }
  const delivery = await requireTaskDeliveryById(fs, task, task.activeDeliveryId);
  if (delivery.status !== "rejected" || delivery.review?.decision !== "reject") {
    return undefined;
  }
  const completedIntent: TaskRejectIntent = {
    type: TASK_REJECT_INTENT_TYPE,
    version: 1,
    taskId: requireCanonicalTaskId(task),
    deliveryId: delivery.id,
    to: task.state,
    actor: delivery.review.by,
    note: delivery.review.note || DEFAULT_TASK_REJECT_NOTE,
    updatedAt: delivery.updatedAt || task.updatedAt || "",
  };
  assertTaskRejectRequestMatchesIntent(completedIntent, options);
  return { task, delivery };
}

async function completedTaskRejectResume(
  fs: FsAdapter,
  task: TaskEnvelope
): Promise<TaskRejectResumeContinuation | undefined> {
  if (task.state !== "running" || !task.activeDeliveryId) return undefined;
  const delivery = await requireTaskDeliveryById(fs, task, task.activeDeliveryId);
  if (delivery.status !== "rejected") return undefined;
  if (
    delivery.sourceNodeId !== primaryNodeId(task) ||
    !isReadyDeliveryModeForTask(task, delivery.integrationMode)
  ) {
    throw new TaskLifecycleError(
      "DELIVERY_CHANGED",
      `Rejected Delivery ${delivery.id} source or integration mode does not match its exact Task.`
    );
  }
  if (
    delivery.review?.decision !== "reject" ||
    !delivery.review.by?.trim() ||
    typeof delivery.review.note !== "string"
  ) {
    throw new TaskLifecycleError(
      "DELIVERY_CHANGED",
      `Rejected Delivery ${delivery.id} does not contain a complete review continuation.`
    );
  }
  return {
    deliveryId: delivery.id,
    actor: delivery.review.by,
    note: delivery.review.note,
  };
}

export async function taskInterrupt(env: OpsEnv, taskPath: string): Promise<TaskEnvelope> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    if (task.state === "interrupted") {
      // Repair legacy/racy terminal projections idempotently. An interrupted
      // Task never has an active Delivery; a delivered outcome is impossible.
      await releaseOccupationForTask(env, task);
      if (!task.activeDeliveryId && task.lastOutcome !== "delivered") {
        return task;
      }
      return patchTaskEnvelope(env.fs, taskPath, {
        activeDeliveryId: null,
        ...(task.lastOutcome === "delivered" ? { lastOutcome: null } : {}),
        updatedAt: env.clock.now(),
      });
    }
    if (task.state === "queued") {
      assertTransition(task.state, "interrupt", "interrupted");
      await env.fs.remove(taskPath);
      // Return synthetic terminal view (file gone).
      return { ...task, state: "interrupted" };
    }
    assertTransition(task.state, "interrupt", "interrupted");

    await releaseOccupationForTask(env, task);

    return patchTaskEnvelope(env.fs, taskPath, {
      state: "interrupted",
      wait: null,
      activeDeliveryId: null,
      ...(task.lastOutcome === "delivered" ? { lastOutcome: null } : {}),
      updatedAt: env.clock.now(),
    });
  });
}

export interface TaskFailOptions {
  /** Optional diagnostic summary (not written as collaboration chat). */
  summary?: string;
}

/**
 * Unrecoverable failure: running|waiting → failed.
 * Releases node occupation via task terminal state (and non-accepted delivery cleanup)
 * so the same node can be re-dispatched. No Node frontmatter dual-write.
 * Idempotent when already failed.
 */
export async function taskFail(
  env: OpsEnv,
  taskPath: string,
  options: TaskFailOptions = {}
): Promise<TaskEnvelope> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    if (task.state === "failed") {
      // Already terminal non-active — ensure non-accepted deliveries are cleared (repair path).
      await releaseOccupationForTask(env, task);
      if (!task.activeDeliveryId && task.lastOutcome !== "delivered") return task;
      return patchTaskEnvelope(env.fs, taskPath, {
        activeDeliveryId: null,
        ...(task.lastOutcome === "delivered" ? { lastOutcome: null } : {}),
        updatedAt: env.clock.now(),
      });
    }
    assertTransition(task.state, "fail", "failed");
    await releaseOccupationForTask(env, task);
    void options.summary;
    return patchTaskEnvelope(env.fs, taskPath, {
      state: "failed",
      wait: null,
      activeDeliveryId: null,
      ...(task.lastOutcome === "delivered" ? { lastOutcome: null } : {}),
      updatedAt: env.clock.now(),
    });
  });
}

/** Clear this Task's non-accepted deliveries; occupation ends with task state. */
async function releaseOccupationForTask(env: OpsEnv, task: TaskEnvelope): Promise<void> {
  await removeNonAcceptedDeliveriesForTask(env.fs, requireCanonicalTaskId(task));
}

export async function taskCancel(env: OpsEnv, taskPath: string): Promise<void> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    assertTransition(task.state, "cancel", "interrupted");
    await env.fs.remove(taskPath);
  });
}

/** Find active operational task for a node (envelope oracle; not frontmatter owner). */
export async function findActiveTaskForNode(fs: FsAdapter, nodeId: string): Promise<TaskEnvelope | undefined> {
  const tasks = await loadTaskEnvelopes(fs);
  return listDirectActiveTasksForNode(nodeId, tasks)[0];
}

/** Delivery storage stays in the Task's immutable owner namespace across Session replacement. */
function deliveryDirForTask(task: TaskEnvelope): string {
  const normalized = task.path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const match = /^(temp\/(?:roles|sessions)\/[^/]+)\/tasks\/[^/]+\.md$/.exec(normalized);
  if (!match) {
    throw new Error(
      `Task ${requireCanonicalTaskId(task)} has no canonical owner delivery namespace.`
    );
  }
  return `${match[1]}/deliveries`;
}

// ---- internals ----

function assertDeliverPreconditions(task: TaskEnvelope): void {
  if (task.state !== "running") {
    throw new TaskLifecycleError(
      "INVALID_TRANSITION",
      `task.deliver requires state=running (got ${task.state}).`
    );
  }
}

async function assertNoReadyDelivery(fs: FsAdapter, task: TaskEnvelope): Promise<void> {
  const existing = await discoverTaskDeliveries(fs, task);
  if (existing.some((d) => d.status === "ready")) {
    throw new Error("A delivery is already ready for review; accept or reject it first.");
  }
}

async function requireActiveReadyDelivery(fs: FsAdapter, task: TaskEnvelope): Promise<DeliveryRecord> {
  if (task.activeDeliveryId) {
    const byId = await loadTaskDeliveryById(fs, task, task.activeDeliveryId);
    if (byId && byId.status === "ready") return byId;
    // Fall through: try path via role
    if (byId) {
      // reload by path if status drifted
    }
  }
  const ready = (await discoverTaskDeliveries(fs, task)).find((d) => d.status === "ready");
  if (!ready) {
    throw new TaskLifecycleError("NO_ACTIVE_DELIVERY", "No ready delivery for this task.");
  }
  return ready;
}

async function requireExpectedActiveReadyDelivery(
  fs: FsAdapter,
  task: TaskEnvelope,
  deliveryId: string
): Promise<DeliveryRecord> {
  if (task.activeDeliveryId !== deliveryId) {
    throw new TaskLifecycleError(
      "DELIVERY_CHANGED",
      "The ready delivery changed; refresh before reviewing it."
    );
  }
  const delivery = await requireActiveReadyDelivery(fs, task);
  if (delivery.id !== deliveryId) {
    throw new TaskLifecycleError(
      "DELIVERY_CHANGED",
      "The ready delivery changed; refresh before reviewing it."
    );
  }
  return delivery;
}

const TASK_REJECT_INTENT_TYPE = "task-delivery-reject-intent";

type TaskRejectIntent = {
  type: typeof TASK_REJECT_INTENT_TYPE;
  version: 1;
  taskId: string;
  deliveryId: string;
  to: "running" | "rejected";
  actor: string;
  note: string;
  updatedAt: string;
};

/**
 * Exact-Task internal intent only. It bridges the otherwise underivable
 * reject-resume vs terminal-reject choice while Delivery and Task are written.
 * It carries no authority: taskReject writes it only after reviewer validation.
 */
function taskRejectIntentPath(taskPath: string): string {
  if (!taskPath.endsWith(".md")) {
    throw new Error(`Task reject recovery requires a canonical markdown Task path: ${taskPath}.`);
  }
  return `${taskPath.slice(0, -3)}.delivery-reject-intent.json`;
}

async function writeTaskRejectIntent(
  fs: FsAdapter,
  taskPath: string,
  intent: TaskRejectIntent
): Promise<void> {
  await fs.writeFile(taskRejectIntentPath(taskPath), JSON.stringify(intent, null, 2) + "\n");
}

async function loadTaskRejectIntent(
  fs: FsAdapter,
  taskPath: string
): Promise<TaskRejectIntent | undefined> {
  const path = taskRejectIntentPath(taskPath);
  if (!(await fs.exists(path))) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path));
  } catch {
    throw new Error(`Invalid exact-Task reject recovery intent: ${path}.`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid exact-Task reject recovery intent: ${path}.`);
  }
  const value = raw as Record<string, unknown>;
  if (
    value.type !== TASK_REJECT_INTENT_TYPE ||
    value.version !== 1 ||
    typeof value.taskId !== "string" ||
    typeof value.deliveryId !== "string" ||
    (value.to !== "running" && value.to !== "rejected") ||
    typeof value.actor !== "string" ||
    !value.actor.trim() ||
    typeof value.note !== "string" ||
    !value.note.trim() ||
    typeof value.updatedAt !== "string" ||
    !value.updatedAt.trim()
  ) {
    throw new Error(`Invalid exact-Task reject recovery intent: ${path}.`);
  }
  return value as TaskRejectIntent;
}

async function reconcilePendingTaskReject(
  env: OpsEnv,
  taskPath: string
): Promise<
  { task: TaskEnvelope; delivery: DeliveryRecord; intent: TaskRejectIntent } | undefined
> {
  const intent = await loadTaskRejectIntent(env.fs, taskPath);
  if (!intent) return undefined;
  const task = await loadTaskEnvelope(env.fs, taskPath);
  if (intent.taskId !== requireCanonicalTaskId(task) || task.activeDeliveryId !== intent.deliveryId) {
    throw new Error(`Exact-Task reject recovery intent does not match Task ${requireCanonicalTaskId(task)}.`);
  }
  assertReviewAuthority({
    actor: intent.actor,
    executorRoleId: task.roleId,
    reviewer: task.reviewer,
    action: "reject",
  });
  const delivery = await requireTaskDeliveryById(env.fs, task, intent.deliveryId);
  assertTaskRejectIntentCanConverge(task, delivery, intent);
  const completed = await completeTaskRejectIntent(env, taskPath, task, delivery, intent);
  return { ...completed, intent };
}

/** Exact-Task WAL order for every public lifecycle mutation. */
async function preflightTaskMutation(
  env: OpsEnv,
  taskPath: string
): Promise<TaskEnvelope> {
  const rejected = await reconcilePendingTaskReject(env, taskPath);
  const task = rejected?.task ?? await loadTaskEnvelope(env.fs, taskPath);
  return reconcileCommittedTaskDelivery(env, taskPath, task);
}

function assertTaskRejectRequestMatchesIntent(
  intent: TaskRejectIntent,
  options: TaskRejectOptions
): void {
  const expectedTo = options.resume === false ? "rejected" : "running";
  const expectedNote = options.note?.trim() || DEFAULT_TASK_REJECT_NOTE;
  if (
    options.deliveryId !== intent.deliveryId ||
    options.actor !== intent.actor ||
    expectedTo !== intent.to ||
    expectedNote !== intent.note
  ) {
    throw new TaskLifecycleError(
      "DELIVERY_CHANGED",
      "This task.reject request differs from the persisted reject operation that was recovered."
    );
  }
}

async function completeTaskRejectIntent(
  env: OpsEnv,
  taskPath: string,
  task: TaskEnvelope,
  delivery: DeliveryRecord,
  intent: TaskRejectIntent
): Promise<{ task: TaskEnvelope; delivery: DeliveryRecord }> {
  if (delivery.status === "ready") {
    delivery.status = "rejected";
    delivery.review = {
      by: intent.actor,
      decision: "reject",
      note: intent.note,
    };
    delivery.updatedAt = intent.updatedAt;
    await writeDelivery(env.fs, delivery);
  } else if (
    delivery.status !== "rejected" ||
    delivery.review?.decision !== "reject" ||
    delivery.review.by !== intent.actor ||
    delivery.review.note !== intent.note
  ) {
    throw new Error(`Exact-Task reject recovery Delivery ${delivery.id} does not match its intent.`);
  }

  let next = task;
  if (task.state === "delivered") {
    next = await patchTaskEnvelope(env.fs, taskPath, {
      state: intent.to,
      // Keep activeDeliveryId for history; new deliver checks ready-only.
      updatedAt: intent.updatedAt,
    });
  } else if (task.state !== intent.to) {
    throw new Error(
      `Exact-Task reject recovery expected Task state delivered|${intent.to}, got ${task.state}.`
    );
  }

  await env.fs.remove(taskRejectIntentPath(taskPath));
  return { task: next, delivery };
}

/** Validate the complete committed reject operation before its first write. */
function assertTaskRejectIntentCanConverge(
  task: TaskEnvelope,
  delivery: DeliveryRecord,
  intent: TaskRejectIntent
): void {
  if (task.state !== "delivered" && task.state !== intent.to) {
    throw new TaskLifecycleError(
      "DELIVERY_CHANGED",
      `Exact-Task reject recovery cannot converge from Task state ${task.state}.`
    );
  }
  if (
    delivery.sourceNodeId !== primaryNodeId(task) ||
    !isReadyDeliveryModeForTask(task, delivery.integrationMode)
  ) {
    throw new TaskLifecycleError(
      "DELIVERY_CHANGED",
      "Persisted reject Delivery source or integration mode does not match its exact Task."
    );
  }
  if (delivery.status === "ready") {
    if (delivery.review) {
      throw new TaskLifecycleError(
        "DELIVERY_CHANGED",
        "Ready Delivery already carries review authority; refusing reject recovery."
      );
    }
    return;
  }
  if (
    delivery.status !== "rejected" ||
    delivery.review?.decision !== "reject" ||
    delivery.review.by !== intent.actor ||
    delivery.review.note !== intent.note
  ) {
    throw new TaskLifecycleError(
      "DELIVERY_CHANGED",
      `Exact-Task reject recovery Delivery ${delivery.id} does not match its intent.`
    );
  }
}

async function recoverExistingTaskDeliver(
  env: OpsEnv,
  taskPath: string,
  task: TaskEnvelope,
  options: TaskDeliverOptions
): Promise<TaskDeliverPrepared | undefined> {
  const delivery = await findCommittedTaskDelivery(env.fs, task);
  if (!delivery || (delivery.status !== "ready" && delivery.status !== "accepted")) return undefined;
  assertCommittedDeliveryMatchesTask(task, delivery);

  let next = task;
  if (delivery.status === "ready") {
    if (task.state === "running") {
      next = await patchTaskEnvelope(env.fs, taskPath, {
        state: "delivered",
        activeDeliveryId: delivery.id,
        ...(delivery.taskLastOutcome ? { lastOutcome: delivery.taskLastOutcome } : {}),
        updatedAt: env.clock.now(),
      });
    } else if (task.state !== "delivered" || task.activeDeliveryId !== delivery.id) {
      return undefined;
    }
  } else {
    if (!isAutoIntegrationMode(delivery.integrationMode)) return undefined;
    if (task.state === "delivered" && task.activeDeliveryId === delivery.id) {
      next = await patchTaskEnvelope(env.fs, taskPath, {
        state: "accepted",
        activeDeliveryId: delivery.id,
        ...(delivery.taskLastOutcome ? { lastOutcome: delivery.taskLastOutcome } : {}),
        wait: null,
        updatedAt: env.clock.now(),
      });
    } else if (task.state !== "accepted" || task.activeDeliveryId !== delivery.id) {
      return undefined;
    }
  }

  assertTaskDeliverCandidateMatches(next, delivery, options);
  if (delivery.status === "accepted") {
    return {
      kind: "done",
      result: { task: next, delivery, autoIntegrated: true },
    };
  }
  if (isAutoIntegrationMode(delivery.integrationMode)) {
    return {
      kind: "auto",
      sourceNodeId: delivery.sourceNodeId,
      deliveryId: delivery.id,
      commits: [...delivery.commits],
      ...(delivery.targetHead ? { targetHead: delivery.targetHead } : {}),
    };
  }
  return {
    kind: "done",
    result: { task: next, delivery, autoIntegrated: false },
  };
}

/**
 * Reconcile only an already-committed exact-Task Delivery WAL. This helper has
 * no caller-supplied candidate data, so competing lifecycle operations cannot
 * overwrite the prior deliver operation while repairing its Task projection.
 */
async function reconcileCommittedTaskDelivery(
  env: OpsEnv,
  taskPath: string,
  task: TaskEnvelope
): Promise<TaskEnvelope> {
  const delivery = await findCommittedTaskDelivery(env.fs, task);
  if (!delivery) return task;
  if (delivery.status === "ready" || delivery.status === "accepted") {
    assertCommittedDeliveryMatchesTask(task, delivery);
  }

  if (delivery.status === "ready") {
    if (task.state === "running") {
      return patchTaskEnvelope(env.fs, taskPath, {
        state: "delivered",
        activeDeliveryId: delivery.id,
        ...(delivery.taskLastOutcome ? { lastOutcome: delivery.taskLastOutcome } : {}),
        updatedAt: env.clock.now(),
      });
    }
    if (task.state === "delivered" && task.activeDeliveryId === delivery.id) return task;
    throwCommittedDeliveryStateMismatch(task, delivery);
  }
  if (delivery.status === "accepted") {
    if (task.state === "delivered" && task.activeDeliveryId === delivery.id) {
      return patchTaskEnvelope(env.fs, taskPath, {
        state: "accepted",
        activeDeliveryId: delivery.id,
        ...(delivery.taskLastOutcome ? { lastOutcome: delivery.taskLastOutcome } : {}),
        wait: null,
        updatedAt: env.clock.now(),
      });
    }
    if (task.state === "accepted" && task.activeDeliveryId === delivery.id) return task;
    throwCommittedDeliveryStateMismatch(task, delivery);
  }
  return task;
}

function throwCommittedDeliveryStateMismatch(
  task: TaskEnvelope,
  delivery: DeliveryRecord
): never {
  throw new TaskLifecycleError(
    "DELIVERY_CHANGED",
    `Committed Delivery ${delivery.id} (${delivery.status}) conflicts with Task ${requireCanonicalTaskId(task)} state ${task.state}; refusing mutation.`
  );
}

function assertCommittedDeliveryMatchesTask(
  task: TaskEnvelope,
  delivery: DeliveryRecord
): void {
  const nodeId = primaryNodeId(task);
  const modeMatches = delivery.status === "ready"
    ? isReadyDeliveryModeForTask(task, delivery.integrationMode)
    : delivery.status === "accepted"
      ? delivery.integrationMode === "manual-accept" ||
        (task.acceptMode === "auto-accept" && delivery.integrationMode === "auto-accept") ||
        (task.acceptMode === "agent-decide" && delivery.integrationMode === "agent-decided-integrate")
      : true;
  if (!nodeId || delivery.sourceNodeId !== nodeId || !modeMatches) {
    throw new TaskLifecycleError(
      "DELIVERY_CHANGED",
      "Persisted Delivery source or integration mode does not match its exact Task; refusing recovery."
    );
  }
}

function isReadyDeliveryModeForTask(
  task: TaskEnvelope,
  integrationMode: DeliveryRecord["integrationMode"]
): boolean {
  return (
    (task.acceptMode === "review-required" && integrationMode === null) ||
    (task.acceptMode === "auto-accept" && integrationMode === "auto-accept") ||
    (task.acceptMode === "agent-decide" &&
      (integrationMode === null || integrationMode === "agent-decided-integrate"))
  );
}

function assertTaskDeliverCandidateMatches(
  task: TaskEnvelope,
  delivery: DeliveryRecord,
  options: TaskDeliverOptions
): void {
  const routing = resolveDeliverRouting(task.acceptMode, options.decision);
  const nodeId = primaryNodeId(task);
  const expectedCommits = [...new Set((options.commits ?? []).map((value) => value.trim()).filter(Boolean))];
  const expectedTargetHead = options.targetHead?.trim() || undefined;
  const expectedChecks = options.checks ?? [];
  const expectedArtifacts = normalizeArtifactRefs(options.artifactRefs ?? []);
  if (
    !nodeId ||
    delivery.sourceNodeId !== nodeId ||
    delivery.summary !== options.summary.trim() ||
    delivery.integrationMode !== routing.integrationMode ||
    !exactStringListEqual(delivery.commits, expectedCommits) ||
    (delivery.targetHead?.trim() || undefined) !== expectedTargetHead ||
    delivery.taskLastOutcome !== options.lastOutcome ||
    !exactDeliveryChecksEqual(delivery.checks, expectedChecks) ||
    !exactArtifactRefsEqual(delivery.artifactRefs, expectedArtifacts)
  ) {
    throw new TaskLifecycleError(
      "DELIVERY_CHANGED",
      "Persisted Delivery candidate differs from this task.deliver retry; refusing duplicate publication."
    );
  }
}

function exactDeliveryChecksEqual(
  current: readonly DeliveryCheck[],
  expected: readonly DeliveryCheck[]
): boolean {
  return (
    current.length === expected.length &&
    current.every((check, index) => {
      const candidate = expected[index];
      return (
        !!candidate &&
        check.name === candidate.name &&
        check.command === candidate.command &&
        check.exitCode === candidate.exitCode
      );
    })
  );
}

function exactArtifactRefsEqual(
  current: readonly ArtifactRef[],
  expected: readonly ArtifactRef[]
): boolean {
  return (
    current.length === expected.length &&
    current.every((ref, index) => {
      const candidate = expected[index];
      return (
        !!candidate &&
        ref.kind === candidate.kind &&
        ref.target === candidate.target &&
        ref.label === candidate.label
      );
    })
  );
}

function assertPreparedDeliveryMatches(
  delivery: DeliveryRecord,
  prepared: Extract<TaskDeliverPrepared, { kind: "auto" }>
): void {
  if (
    delivery.id !== prepared.deliveryId ||
    delivery.sourceNodeId !== prepared.sourceNodeId ||
    !exactStringListEqual(delivery.commits, prepared.commits) ||
    (delivery.targetHead?.trim() || undefined) !== prepared.targetHead
  ) {
    throw new TaskLifecycleError(
      "DELIVERY_CHANGED",
      "Ready delivery changed during auto-accept; refusing state write."
    );
  }
}

function isAutoIntegrationMode(mode: DeliveryRecord["integrationMode"]): boolean {
  return mode === "auto-accept" || mode === "agent-decided-integrate";
}

async function requireTaskDeliveryById(
  fs: FsAdapter,
  task: TaskEnvelope,
  deliveryId: string
): Promise<DeliveryRecord> {
  const delivery = await loadTaskDeliveryById(fs, task, deliveryId);
  if (!delivery) {
    throw new TaskLifecycleError("NO_ACTIVE_DELIVERY", "No delivery for this exact task and id.");
  }
  return delivery;
}

async function loadTaskDeliveryById(
  fs: FsAdapter,
  task: TaskEnvelope,
  deliveryId: string
): Promise<DeliveryRecord | undefined> {
  const path = join(deliveryDirForTask(task), `${deliveryId}.md`);
  if (!(await fs.exists(path))) return undefined;
  const delivery = await loadDelivery(fs, path);
  if (delivery.id !== deliveryId || delivery.taskId !== requireCanonicalTaskId(task)) {
    throw new TaskLifecycleError(
      "DELIVERY_CHANGED",
      `Delivery ${deliveryId} does not belong to exact Task ${requireCanonicalTaskId(task)}.`
    );
  }
  return delivery;
}

async function findCommittedTaskDelivery(
  fs: FsAdapter,
  task: TaskEnvelope
): Promise<DeliveryRecord | undefined> {
  if (task.activeDeliveryId) {
    const active = await loadTaskDeliveryById(fs, task, task.activeDeliveryId);
    if (active?.status === "ready" || active?.status === "accepted") return active;
  }
  const ready = (await discoverTaskDeliveries(fs, task)).filter(
    (delivery) => delivery.status === "ready"
  );
  if (ready.length > 1) {
    throw new Error(`Task ${requireCanonicalTaskId(task)} has multiple ready Deliveries; refusing recovery.`);
  }
  return ready[0];
}

/**
 * Shared owner directory, exact-Task validation: bounded identity-peek every
 * filename, then fully parse only records whose frontmatter names this Task.
 */
async function discoverTaskDeliveries(fs: FsAdapter, task: TaskEnvelope): Promise<DeliveryRecord[]> {
  const dir = deliveryDirForTask(task);
  if (!(await fs.exists(dir))) return [];
  const taskId = requireCanonicalTaskId(task);
  const out: DeliveryRecord[] = [];
  const entries = (await fs.listDir(dir))
    .filter((entry) => !entry.isDir && entry.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if ((await peekDeliveryTaskId(fs, path)) !== taskId) continue;
    const delivery = await loadDelivery(fs, path);
    if (entry.name !== `${delivery.id}.md` || delivery.taskId !== taskId) {
      throw new TaskLifecycleError(
        "DELIVERY_CHANGED",
        `Delivery identity does not match its exact Task path: ${path}.`
      );
    }
    out.push(delivery);
  }
  return out;
}

function requireNodeById(tent: LoadedTent, nodeId: string): Node {
  if (tent.duplicateIds.has(nodeId)) {
    throw new Error(`Duplicate node id '${nodeId}' found; repair or fork the duplicate nodes before using this id.`);
  }
  const node = tent.byId.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}.`);
  return node;
}

function requireCanonicalTaskId(task: TaskEnvelope): string {
  const id = task.id?.trim() || "";
  if (!isTaskId(id)) {
    throw new Error(`Task ${task.path} is missing its canonical tk-* id.`);
  }
  return id;
}

async function withMutation<T>(fs: FsAdapter, action: () => Promise<T>): Promise<T> {
  return withTentMutation(fs, action);
}
