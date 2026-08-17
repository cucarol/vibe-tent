// Task lifecycle API — claim / wait / submit / accept / reject / interrupt.
// Uses Task records under temp/<owner>/tasks and Result records under results.
// Runtime in-flight oracle = active Task record only.
// Node frontmatter is not dual-written for owner/status; collaboration truth is Task/TaskResult.

import { withTentMutation, type FsAdapter } from "./adapter.js";
import {
  buildTaskResultRecord,
  createTaskResultUnlocked,
  taskResultAcceptCandidateDigest,
  taskResultReviewSemanticsDigest,
  taskResultPathForTask,
  loadTaskResult,
  writeTaskResult,
  type TaskResultRecord,
} from "./task-result.js";
import { normalizeArtifactRefs } from "./artifact.js";
import type { OpsEnv } from "./ops-context.js";
import { join } from "./tree.js";
import {
  ackTaskRecord,
  assertIsoTimestamp,
  loadTaskRecord,
  patchTaskRecord,
  parseTaskStatusDetail,
  type TaskRecord,
  type TaskRecordPatch,
} from "./task.js";
import { isSessionId } from "./id.js";
import {
  assertReviewAuthority,
  assertTransition,
  isTaskResultId,
  isTaskId,
  resolveSubmitRouting,
  TaskLifecycleError,
  type ArtifactRef,
  type SubmitDecision,
  type TaskResultCheck,
  type TaskState,
  type TaskStatusDetail,
  type WaitReason,
} from "./task-model.js";

export type TaskClaimWrite = TaskRecordPatch;

export interface TaskClaimOptions {
  /**
   * Optional single-write claim payload after structural checks.
   * When set on first claim (queued→running), state + lane/base/audit
   * are persisted in **one** Task patch. Callers must prepare lane/base before
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
  /** Internal formal return written atomically with a managed park. */
  statusDetail?: TaskStatusDetail;
}

export interface TaskSubmitOptions {
  report: string;
  commits?: string[];
  /**
   * Review-time full SHA of the resolved integration target branch HEAD.
   * Service snapshots this for commit-bearing Results; Core persists it.
   */
  targetHead?: string;
  checks?: TaskResultCheck[];
  artifactRefs?: ArtifactRef[];
  /** Required when acceptMode=agent-decide. */
  decision?: SubmitDecision;
  /** Optional integrate hook for auto-accept / agent-decide integrate. */
  integrate?: (commits: string[]) => Promise<void>;
}

export interface TaskAcceptOptions {
  actor: string;
  /** Exact ready TaskResult shown to the reviewer. */
  resultId: string;
  integrate?: (commits: string[]) => Promise<void>;
}

export interface TaskRejectOptions {
  actor: string;
  /** Exact ready TaskResult shown to the reviewer. */
  resultId: string;
  note?: string;
  /** Default true — rework path submitted → running. */
  resume?: boolean;
}

export const DEFAULT_TASK_REJECT_NOTE = "Rejected; waiting for resubmission.";

export async function taskClaim(env: OpsEnv, taskPath: string, options: TaskClaimOptions = {}): Promise<TaskRecord> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    const requestedSessionId = options.claimWrite?.executionSessionId;
    if (task.executionSessionId && requestedSessionId && requestedSessionId !== task.executionSessionId) {
      throw new Error(
        `Cannot claim task with a different Session: bound=${task.executionSessionId} requested=${requestedSessionId}`
      );
    }
    if (task.state === "running") {
      if (requestedSessionId && requestedSessionId !== task.executionSessionId) {
        throw new Error(
          `Cannot claim task with a different Session: bound=${task.executionSessionId ?? "missing"} requested=${requestedSessionId}`
        );
      }
      return task;
    }
    assertTransition(task.state, "claim", "running");

    // Claim trusts the frozen Task snapshots. Later Node changes do not rewrite
    // or invalidate existing Task context.

    // Single Task write: running + optional lane/base/audit together.
    // No intermediate lane-only patch; failed prepare must not reach this path.
    const now = env.clock.now();
    if (options.claimWrite) {
      if (options.claimWrite.executionSessionId && !isSessionId(options.claimWrite.executionSessionId)) {
        throw new Error(`task.claim requires a canonical Session id: ${options.claimWrite.executionSessionId}`);
      }
      return patchTaskRecord(env.fs, taskPath, {
        ...options.claimWrite,
        state: "running",
        updatedAt: options.claimWrite.updatedAt ?? now,
      });
    }

    // Claim only acknowledges the Task record — no Node authority dual-write.
    await ackTaskRecord(env.fs, taskPath);
    return loadTaskRecord(env.fs, taskPath);
  });
}

export async function taskWait(env: OpsEnv, taskPath: string, options: TaskWaitOptions): Promise<TaskRecord> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    assertTransition(task.state, "wait", "waiting");
    const summary = options.summary.trim();
    if (!summary) throw new Error("task.wait requires a non-empty summary.");
    const code = options.code?.trim();
    const statusDetail = options.statusDetail ? parseTaskStatusDetail(options.statusDetail)! : undefined;
    if (statusDetail?.executionSessionId && task.executionSessionId !== statusDetail.executionSessionId) {
      throw new TaskLifecycleError(
        "TASK_NOT_ACTIVE",
        `Task wait return Session mismatch: task=${task.executionSessionId ?? "unbound"} requested=${statusDetail.executionSessionId}.`
      );
    }
    return patchTaskRecord(env.fs, taskPath, {
      state: "waiting",
      wait: {
        reason: options.reason,
        summary,
        ...(code ? { code } : {}),
      },
      ...(statusDetail ? { statusDetail } : {}),
      updatedAt: env.clock.now(),
    });
  });
}

export async function taskResume(env: OpsEnv, taskPath: string): Promise<TaskRecord> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    // Idempotent: already running after concurrent approve + session.live is fine.
    if (task.state === "running" && !task.wait) return task;
    assertTransition(task.state, "resume", "running");
    return patchTaskRecord(env.fs, taskPath, {
      state: "running",
      wait: null,
      updatedAt: env.clock.now(),
    });
  });
}

/**
 * Exact-Task structural WAL preflight for composite Service mutations.
 * It performs no requested transition: pending reject and committed TaskResult
 * operations converge first, then the caller evaluates the returned Task.
 */
export interface TaskRejectResumeContinuation {
  resultId: string;
  actor: string;
  note: string;
}

export interface TaskLifecycleReconciliation {
  task: TaskRecord;
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

export interface TaskSubmitResult {
  task: TaskRecord;
  result: TaskResultRecord;
  autoIntegrated: boolean;
}

/**
 * First submit section under mutation.lock.
 * Every mode first publishes one durable ready TaskResult candidate.
 * Auto-integrate modes return that exact candidate for Git integration outside the lock.
 */
export type TaskSubmitPrepared =
  | { kind: "done"; result: TaskSubmitResult }
  | {
      kind: "auto";
      resultId: string;
      commits: string[];
      targetHead?: string;
    };

export interface CommittedTaskSubmitRecovery {
  task: TaskRecord;
  result: TaskResultRecord;
  prepared: TaskSubmitPrepared;
  options: TaskSubmitOptions;
}

const TASK_SUBMIT_INTENT_TYPE = "task-result-submit-intent";

type TaskSubmitIntent = {
  type: typeof TASK_SUBMIT_INTENT_TYPE;
  version: 1;
  taskId: string;
  resultId: string;
  candidateDigest: string;
  createdAt: string;
};

export interface TaskAcceptPrepared {
  resultId: string;
  resultPath: string;
  commits: string[];
  /** Fixed-size complete immutable ready-TaskResult semantics proof. */
  resultSemanticsDigest?: string;
  /** Present only when prepare recovered a previously committed accept intent. */
  recovered?: TaskAcceptResult;
  acceptIntent?: TaskAcceptIntent;
}

export interface TaskAcceptResult {
  task: TaskRecord;
  result: TaskResultRecord;
}

/**
 * Prepare submit under cross-process mutation.lock only.
 * Service callers should wrap this in a short MutationBus section and run
 * integrateCommits outside MutationBus when kind==="auto" and commits exist.
 */
export async function prepareTaskSubmit(
  env: OpsEnv,
  taskPath: string,
  options: TaskSubmitOptions
): Promise<TaskSubmitPrepared> {
  return withMutation(env.fs, async (): Promise<TaskSubmitPrepared> => {
    const pendingIntent = await loadTaskSubmitIntent(env.fs, taskPath);
    if (pendingIntent) {
      return recoverPendingTaskSubmit(env, taskPath, pendingIntent, options, true);
    }
    const task = await preflightTaskMutation(env, taskPath);
    const recovered = await recoverExistingTaskSubmit(env, taskPath, task, options);
    if (recovered) return recovered;
    assertSubmitPreconditions(task);
    await assertNoReadyResult(env.fs, task);

    const routing = resolveSubmitRouting(task.acceptMode, options.decision);

    const candidateInput = {
      taskId: requireCanonicalTaskId(task),
      report: options.report,
      commits: options.commits,
      targetHead: options.targetHead,
      checks: options.checks,
      artifactRefs: options.artifactRefs,
      status: "ready",
      integrationMode: routing.integrationMode,
      resultsDir: resultDirForTask(task),
    } as const;
    const candidate = buildTaskResultRecord(env.clock, candidateInput);
    const intent: TaskSubmitIntent = {
      type: TASK_SUBMIT_INTENT_TYPE,
      version: 1,
      taskId: candidate.taskId,
      resultId: candidate.id,
      candidateDigest: taskResultAcceptCandidateDigest(candidate),
      createdAt: candidate.createdAt,
    };
    await writeTaskSubmitIntent(env.fs, taskPath, intent);
    const result = await createTaskResultUnlocked(
      env.fs,
      { now: () => intent.createdAt },
      { ...candidateInput, id: intent.resultId }
    );
    assertTaskSubmitIntentMatchesResult(intent, result);

    assertTransition(task.state, "submit", "submitted");
    const next = await patchTaskRecord(env.fs, taskPath, {
      state: "submitted",
      currentResultId: result.id,
      statusDetail: null,
      updatedAt: env.clock.now(),
    });
    await env.fs.remove(taskSubmitIntentPath(taskPath));
    if (routing.autoIntegrate) {
      return {
        kind: "auto",
        resultId: result.id,
        commits: [...result.commits],
        ...(result.targetHead ? { targetHead: result.targetHead } : {}),
      };
    }
    return { kind: "done", result: { task: next, result, autoIntegrated: false } };
  });
}

/**
 * Reuse an already-committed exact-Task TaskResult after its Task pointer is
 * durable. Managed draft recovery may clean a stale submit intent, but it
 * never publishes a Result or advances the Task pointer.
 */
export async function recoverCommittedTaskResult(
  env: OpsEnv,
  taskPath: string,
  expected: { report: string }
): Promise<CommittedTaskSubmitRecovery | undefined> {
  return withMutation(env.fs, async () => {
    const submitIntent = await loadTaskSubmitIntent(env.fs, taskPath);
    if (submitIntent) await cleanupCommittedTaskSubmitIntent(env, taskPath, submitIntent);
    const task = await preflightTaskMutation(env, taskPath);
    const result = await findCommittedTaskResult(env.fs, task);
    if (!result || (result.status !== "ready" && result.status !== "accepted")) {
      return undefined;
    }
    assertCommittedResultMatchesTask(task, result);
    if (
      result.report !== expected.report.trim()
    ) {
      throw new TaskLifecycleError(
        "RESULT_CHANGED",
        "Persisted TaskResult report or outcome does not match the managed report draft."
      );
    }
    const prepared: TaskSubmitPrepared = result.status === "accepted"
      ? {
          kind: "done",
          result: { task, result, autoIntegrated: isAutoIntegrationMode(result.integrationMode) },
        }
      : isAutoIntegrationMode(result.integrationMode)
        ? {
            kind: "auto",
            resultId: result.id,
            commits: [...result.commits],
            ...(result.targetHead ? { targetHead: result.targetHead } : {}),
          }
        : {
            kind: "done",
            result: { task, result, autoIntegrated: false },
          };
    const options: TaskSubmitOptions = {
      report: result.report,
      commits: [...result.commits],
      checks: result.checks.map((check) => ({ ...check })),
      artifactRefs: result.artifactRefs.map((ref) => ({ ...ref })),
      ...(result.targetHead ? { targetHead: result.targetHead } : {}),
      ...(result.integrationMode === "agent-decided-integrate"
        ? { decision: "integrate" as const }
        : {}),
    };
    return { task, result, prepared, options };
  });
}

/**
 * Finalize auto-integrate under mutation.lock after Git ran outside the lock.
 * Integration failure deliberately leaves the durable ready TaskResult candidate intact.
 */
export async function finalizeTaskSubmitAuto(
  env: OpsEnv,
  taskPath: string,
  options: TaskSubmitOptions,
  prepared: Extract<TaskSubmitPrepared, { kind: "auto" }>
): Promise<TaskSubmitResult> {
  return withMutation(env.fs, async () => {
    let task = await preflightTaskMutation(env, taskPath);
    const persisted = await requireTaskResultById(env.fs, task, prepared.resultId);
    if (task.currentResultId !== persisted.id) {
      throw new TaskLifecycleError(
        "RESULT_CHANGED",
        "Ready result changed during auto-accept; refusing state write."
      );
    }

    if (persisted.status === "accepted") {
      if (!isAutoIntegrationMode(persisted.integrationMode)) {
        throw new TaskLifecycleError(
          "RESULT_CHANGED",
          "Accepted result is not an auto-integrate candidate; refusing recovery."
        );
      }
      if (task.state === "submitted") {
        task = await patchTaskRecord(env.fs, taskPath, {
          state: "accepted",
          currentResultId: persisted.id,
          statusDetail: null,
          wait: null,
          updatedAt: env.clock.now(),
        });
      } else if (task.state !== "accepted") {
        throw new TaskLifecycleError(
          "INVALID_TRANSITION",
          `Cannot recover accepted TaskResult while Task is ${task.state}.`
        );
      }
      assertTaskSubmitCandidateMatches(task, persisted, options);
      assertPreparedResultMatches(persisted, prepared);
      return { task, result: persisted, autoIntegrated: true };
    }

    assertTransition(task.state, "accept", "accepted");
    const result = await requireActiveReadyResult(env.fs, task);
    if (result.id !== prepared.resultId) {
      throw new TaskLifecycleError(
        "RESULT_CHANGED",
        "Ready result changed during auto-accept; refusing state write."
      );
    }
    if (!exactStringListEqual(result.commits, prepared.commits)) {
      throw new TaskLifecycleError(
        "RESULT_CHANGED",
        "Ready result commits changed during auto-accept; refusing state write."
      );
    }
    if ((result.targetHead?.trim() || undefined) !== prepared.targetHead) {
      throw new TaskLifecycleError(
        "RESULT_CHANGED",
        "Ready result targetHead changed during auto-accept; refusing state write."
      );
    }

    const routing = resolveSubmitRouting(task.acceptMode, options.decision);
    if (!routing.autoIntegrate) {
      throw new Error("Task acceptMode changed during integrate; refusing state write.");
    }
    assertTaskSubmitCandidateMatches(task, result, options);
    assertPreparedResultMatches(result, prepared);
    if (!task.requester) {
      throw new TaskLifecycleError("RESULT_CHANGED", "Task requester is missing during auto-accept.");
    }

    result.status = "accepted";
    const acceptedAt = env.clock.now();
    result.review = { reviewer: task.requester.id, at: acceptedAt };
    if (result.integrationMode !== routing.integrationMode) {
      throw new TaskLifecycleError("RESULT_CHANGED", "Task Result integration mode changed during auto-accept.");
    }
    await writeTaskResult(env.fs, result);
    // The requester authorized the frozen auto-integration policy at dispatch.
    // Task becomes accepted; no Node frontmatter write.

    const next = await patchTaskRecord(env.fs, taskPath, {
      state: "accepted",
      currentResultId: result.id,
      statusDetail: null,
      wait: null,
      updatedAt: acceptedAt,
    });
    return { task: next, result, autoIntegrated: true };
  });
}

export async function taskSubmit(
  env: OpsEnv,
  taskPath: string,
  options: TaskSubmitOptions
): Promise<TaskSubmitResult> {
  // review-required path: one atomic ready-TaskResult section (no Git).
  // Auto-integrate path: durable ready TaskResult → Git outside lock → exact
  // candidate re-validation + accepted writes. Integration failure preserves
  // the candidate and targetHead/commits for review or retry.
  const phase = await prepareTaskSubmit(env, taskPath, options);
  if (phase.kind === "done") return phase.result;

  const pendingCommits = [...phase.commits];
  if (pendingCommits.length > 0) {
    if (!options.integrate) {
      throw new Error("Auto-integrate path requires integrate() when commits are present.");
    }
    await options.integrate(pendingCommits);
  }

  return finalizeTaskSubmitAuto(env, taskPath, options, phase);
}

/**
 * Prepare accept under mutation.lock: authority and exact ready Task Result.
 * Service should wrap in a short MutationBus section; Git integrate must run outside both.
 */
export async function prepareTaskAccept(
  env: OpsEnv,
  taskPath: string,
  options: TaskAcceptOptions
): Promise<TaskAcceptPrepared> {
  return withMutation(env.fs, async () => {
    const submitIntent = await loadTaskSubmitIntent(env.fs, taskPath);
    if (submitIntent) await cleanupCommittedTaskSubmitIntent(env, taskPath, submitIntent);
    const intents = await loadTaskReviewIntents(env.fs, taskPath);
    if (intents.accept) {
      const recovered = await reconcilePendingTaskAccept(env, taskPath, intents.accept);
      if (!recovered) throw new Error("Exact-Task accept recovery intent disappeared.");
      assertTaskAcceptRequestMatchesIntent(intents.accept, options);
      return {
        resultId: recovered.result.id,
        resultPath: recovered.result.path,
        // Git integration already preceded the committed accept intent.
        commits: [],
        recovered: recovered.acceptance,
        acceptIntent: intents.accept,
      };
    }
    const task = await preflightTaskMutation(env, taskPath, {
      allowCommittedSubmitRecovery: true,
    });
    assertTransition(task.state, "accept", "accepted");
    const result = await requireExpectedActiveReadyResult(
      env.fs,
      task,
      options.resultId
    );
    const actor = canonicalTaskAcceptActor(options.actor);
    assertReviewAuthority({
      actor,
      executorRoleId: task.assigneeRoleId,
      requester: task.requester,
      action: "accept",
    });
    return {
      resultId: result.id,
      resultPath: result.path,
      commits: [...result.commits],
      resultSemanticsDigest: taskResultReviewSemanticsDigest(result),
    };
  });
}

/**
 * Finalize accept under mutation.lock after Git integrate (when any) ran outside the lock.
 * Revalidates Task Result/authority, commits an exact accept WAL, then advances
 * Task Result → Task writes with restart-safe forward recovery.
 */
export async function finalizeTaskAccept(
  env: OpsEnv,
  taskPath: string,
  options: TaskAcceptOptions,
  prepared: TaskAcceptPrepared
): Promise<TaskAcceptResult> {
  return withMutation(env.fs, async () => {
    if (prepared.recovered) {
      if (!prepared.acceptIntent) {
        throw new Error("Recovered task.accept preparation is missing its exact intent.");
      }
      assertTaskAcceptRequestMatchesIntent(prepared.acceptIntent, options);
      return prepared.recovered;
    }
    const task = await preflightTaskMutation(env, taskPath, {
      allowCommittedSubmitRecovery: true,
    });
    assertTransition(task.state, "accept", "accepted");
    const result = await requireExpectedActiveReadyResult(
      env.fs,
      task,
      options.resultId
    );
    if (result.id !== prepared.resultId) {
      throw new TaskLifecycleError(
        "RESULT_CHANGED",
        "Ready result changed during integrate; refusing accept."
      );
    }
    if (
      !prepared.resultSemanticsDigest ||
      taskResultReviewSemanticsDigest(result) !== prepared.resultSemanticsDigest
    ) {
      throw new TaskLifecycleError(
        "RESULT_CHANGED",
        "Ready result semantics changed during integrate; refusing accept."
      );
    }
    if (!exactStringListEqual(result.commits, prepared.commits)) {
      throw new TaskLifecycleError(
        "RESULT_CHANGED",
        "Ready result commits changed during accept; refusing accept."
      );
    }
    const actor = canonicalTaskAcceptActor(options.actor);
    assertReviewAuthority({
      actor,
      executorRoleId: task.assigneeRoleId,
      requester: task.requester,
      action: "accept",
    });

    const updatedAt = assertIsoTimestamp(env.clock.now(), "Task accept intent updatedAt");
    const intent: TaskAcceptIntent = {
      type: TASK_ACCEPT_INTENT_TYPE,
      version: 1,
      taskId: requireCanonicalTaskId(task),
      resultId: result.id,
      resultPath: result.path,
      candidateDigest: taskResultAcceptCandidateDigest(result),
      actor,
      commits: [...result.commits],
      updatedAt,
    };
    await writeTaskAcceptIntent(env.fs, taskPath, intent);
    result.status = "accepted";
    result.review = { reviewer: intent.actor, at: intent.updatedAt };
    await writeTaskResult(env.fs, result);
    const next = await patchTaskRecord(env.fs, taskPath, {
      state: "accepted",
      wait: null,
      updatedAt: intent.updatedAt,
    });
    const accepted: TaskAcceptResult = { task: next, result };
    // Removal is intentionally outside the compensation catch above. Once
    // TaskResult + Task are accepted, a failed remove leaves a forward-only
    // intent that the next exact-Task preflight can safely finish.
    await env.fs.remove(taskAcceptIntentPath(taskPath));
    return accepted;
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
  // Validate authority + ready result under lock; Git integrate outside;
  // then re-validate, commit the accept WAL, and converge accepted state under lock.
  const prepared = await prepareTaskAccept(env, taskPath, options);

  if (prepared.commits.length > 0) {
    if (!options.integrate) {
      throw new Error("TaskResult contains commits; workspace integration is required.");
    }
    await options.integrate(prepared.commits);
  }

  return finalizeTaskAccept(env, taskPath, options, prepared);
}

export async function taskReject(
  env: OpsEnv,
  taskPath: string,
  options: TaskRejectOptions
): Promise<{ task: TaskRecord; result: TaskResultRecord }> {
  return withMutation(env.fs, async () => {
    const submitIntent = await loadTaskSubmitIntent(env.fs, taskPath);
    if (submitIntent) await cleanupCommittedTaskSubmitIntent(env, taskPath, submitIntent);
    const intents = await loadTaskReviewIntents(env.fs, taskPath);
    if (intents.accept) {
      // A committed accept decision wins. Converge it before the later reject
      // request is evaluated against the now-accepted Task.
      await reconcilePendingTaskAccept(env, taskPath, intents.accept);
    }
    const recovered = intents.reject
      ? await reconcilePendingTaskReject(env, taskPath)
      : undefined;
    if (recovered) {
      assertTaskRejectRequestMatchesIntent(recovered.intent, options);
      // The committed reject WAL wins, then the ordinary exact-Task preflight
      // validates that no competing TaskResult WAL remains before success.
      const task = await preflightTaskMutation(env, taskPath, {
        allowCommittedSubmitRecovery: true,
      });
      return { task, result: recovered.result };
    }
    let task = await loadTaskRecord(env.fs, taskPath);
    task = await reconcileCommittedTaskResult(env, taskPath, task);
    const completed = await recoverCompletedTaskReject(env.fs, task, options);
    if (completed) return completed;
    const resume = options.resume !== false;
    const event = resume ? "reject-resume" : "reject-terminal";
    const to: TaskState = resume ? "running" : "rejected";
    assertTransition(task.state, event, to);

    const result = await requireExpectedActiveReadyResult(
      env.fs,
      task,
      options.resultId
    );
    // Exact Task.requester only (no user override on Role-reviewed); never self.
    assertReviewAuthority({
      actor: options.actor,
      executorRoleId: task.assigneeRoleId,
      requester: task.requester,
      action: "reject",
    });

    const intent: TaskRejectIntent = {
      type: TASK_REJECT_INTENT_TYPE,
      version: 1,
      taskId: requireCanonicalTaskId(task),
      resultId: result.id,
      to,
      actor: options.actor,
      note: options.note?.trim() || DEFAULT_TASK_REJECT_NOTE,
      updatedAt: env.clock.now(),
    };
    await writeTaskRejectIntent(env.fs, taskPath, intent);
    return completeTaskRejectIntent(env, taskPath, task, result, intent);
  });
}

async function recoverCompletedTaskReject(
  fs: FsAdapter,
  task: TaskRecord,
  options: TaskRejectOptions
): Promise<{ task: TaskRecord; result: TaskResultRecord } | undefined> {
  if (
    !task.currentResultId ||
    (task.state !== "running" && task.state !== "rejected")
  ) {
    return undefined;
  }
  const result = await requireTaskResultById(fs, task, task.currentResultId);
  if (result.status !== "rejected" || !result.review) {
    return undefined;
  }
  const completedIntent: TaskRejectIntent = {
    type: TASK_REJECT_INTENT_TYPE,
    version: 1,
    taskId: requireCanonicalTaskId(task),
    resultId: result.id,
    to: task.state,
    actor: result.review.reviewer,
    note: result.review.note || DEFAULT_TASK_REJECT_NOTE,
    updatedAt: result.review.at,
  };
  assertTaskRejectRequestMatchesIntent(completedIntent, options);
  return { task, result };
}

async function completedTaskRejectResume(
  fs: FsAdapter,
  task: TaskRecord
): Promise<TaskRejectResumeContinuation | undefined> {
  if (task.state !== "running" || !task.currentResultId) return undefined;
  const result = await requireTaskResultById(fs, task, task.currentResultId);
  if (result.status !== "rejected") return undefined;
  if (
    !isReadyTaskResultModeForTask(task, result.integrationMode)
  ) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      `Rejected TaskResult ${result.id} integration mode does not match its exact Task.`
    );
  }
  if (
    !result.review?.reviewer?.trim() ||
    typeof result.review.note !== "string"
  ) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      `Rejected TaskResult ${result.id} does not contain a complete review continuation.`
    );
  }
  return {
    resultId: result.id,
    actor: result.review.reviewer,
    note: result.review.note,
  };
}

export async function taskInterrupt(env: OpsEnv, taskPath: string): Promise<TaskRecord> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    if (task.state === "interrupted") {
      return task;
    }
    if (task.state === "queued") {
      assertTransition(task.state, "interrupt", "interrupted");
      await env.fs.remove(taskPath);
      // Return synthetic terminal view (file gone).
      return { ...task, state: "interrupted" };
    }
    assertTransition(task.state, "interrupt", "interrupted");

    return patchTaskRecord(env.fs, taskPath, {
      state: "interrupted",
      wait: null,
      updatedAt: env.clock.now(),
    });
  });
}

export interface TaskFailOptions {
  /** Formal terminal failure text. Persisted in Task.statusDetail.error. */
  summary?: string;
  report?: string;
  error?: string;
  code?: string;
  executionSessionId?: string;
}

export interface TaskFailedReturnOptions {
  report?: string;
  error: string;
  code?: string;
  executionSessionId?: string;
}

/** Record a pre-publication managed failure without terminalizing the Task. */
export async function taskRecordFailedReturn(
  env: OpsEnv,
  taskPath: string,
  options: TaskFailedReturnOptions
): Promise<TaskRecord> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    // A committed ready/accepted TaskResult wins. Its reconciliation clears stale
    // non-TaskResult return state; integration/review failures are not Task returns.
    if (task.state !== "running" && task.state !== "waiting") return task;
    const executionSessionId = assertTaskFailureSession(task, options.executionSessionId);
    const statusDetail = parseTaskStatusDetail({
      kind: "failed",
      ...(options.report ? { report: options.report } : {}),
      error: options.error,
      ...(options.code ? { code: options.code } : {}),
      at: env.clock.now(),
      ...(executionSessionId ? { executionSessionId } : {}),
    })!;
    return patchTaskRecord(env.fs, taskPath, {
      statusDetail,
      updatedAt: env.clock.now(),
    });
  });
}

/**
 * Unrecoverable failure: running|waiting → failed.
 * Terminal Task state ends in-flight work. Task Results are retained.
 * so the same node can be re-dispatched. No Node frontmatter dual-write.
 * Idempotent when already failed.
 */
export async function taskFail(
  env: OpsEnv,
  taskPath: string,
  options: TaskFailOptions = {}
): Promise<TaskRecord> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    if (task.state === "failed") {
      const requestedStatusDetail = buildTaskFailedReturn(task, options, env.clock.now());
      if (task.statusDetail?.kind === "failed") return task;
      return patchTaskRecord(env.fs, taskPath, {
        statusDetail: requestedStatusDetail,
        updatedAt: env.clock.now(),
      });
    }
    assertTransition(task.state, "fail", "failed");
    const statusDetail = buildTaskFailedReturn(task, options, env.clock.now());
    return patchTaskRecord(env.fs, taskPath, {
      state: "failed",
      wait: null,
      statusDetail,
      updatedAt: env.clock.now(),
    });
  });
}

function buildTaskFailedReturn(
  task: TaskRecord,
  options: TaskFailOptions,
  at: string
): TaskStatusDetail {
  const executionSessionId = assertTaskFailureSession(task, options.executionSessionId);
  return parseTaskStatusDetail({
    kind: "failed",
    ...(options.report ? { report: options.report } : {}),
    error: options.error?.trim() || options.summary?.trim() || "Task failed.",
    ...(options.code ? { code: options.code } : {}),
    at,
    ...(executionSessionId ? { executionSessionId } : {}),
  })!;
}

function assertTaskFailureSession(
  task: TaskRecord,
  requestedSessionId: string | undefined
): string | undefined {
  const requested = requestedSessionId?.trim() || undefined;
  if (requested && requested !== task.executionSessionId) {
    throw new TaskLifecycleError(
      "TASK_NOT_ACTIVE",
      `Task failure Session mismatch: task=${task.executionSessionId ?? "unbound"} requested=${requested}.`
    );
  }
  return requested ?? task.executionSessionId;
}

/** Results are immutable history; in-flight work ends solely through Task state. */
export async function taskCancel(env: OpsEnv, taskPath: string): Promise<void> {
  return withMutation(env.fs, async () => {
    const task = await preflightTaskMutation(env, taskPath);
    assertTransition(task.state, "cancel", "interrupted");
    await env.fs.remove(taskPath);
  });
}

/** TaskResult storage stays in the Task's immutable owner namespace across Session replacement. */
function resultDirForTask(task: TaskRecord): string {
  const normalized = task.path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const match = /^(temp\/(?:roles|sessions)\/[^/]+)\/tasks\/[^/]+\.md$/.exec(normalized);
  if (!match) {
    throw new Error(
      `Task ${requireCanonicalTaskId(task)} has no canonical owner result namespace.`
    );
  }
  return `${match[1]}/results`;
}

// ---- internals ----

function assertSubmitPreconditions(task: TaskRecord): void {
  if (task.state !== "running") {
    throw new TaskLifecycleError(
      "INVALID_TRANSITION",
      `task.submit requires state=running (got ${task.state}).`
    );
  }
}

async function assertNoReadyResult(fs: FsAdapter, task: TaskRecord): Promise<void> {
  const existing = task.currentResultId
    ? await loadTaskResultById(fs, task, task.currentResultId)
    : undefined;
  if (existing?.status === "ready") {
    throw new Error("A result is already ready for review; accept or reject it first.");
  }
}

async function requireActiveReadyResult(fs: FsAdapter, task: TaskRecord): Promise<TaskResultRecord> {
  if (!task.currentResultId) {
    throw new TaskLifecycleError("NO_ACTIVE_RESULT", "No ready result for this task.");
  }
  const result = await loadTaskResultById(fs, task, task.currentResultId);
  if (!result || result.status !== "ready") {
    throw new TaskLifecycleError("NO_ACTIVE_RESULT", "No ready result for this task.");
  }
  return result;
}

async function requireExpectedActiveReadyResult(
  fs: FsAdapter,
  task: TaskRecord,
  resultId: string
): Promise<TaskResultRecord> {
  if (task.currentResultId !== resultId) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "The ready result changed; refresh before reviewing it."
    );
  }
  const result = await requireActiveReadyResult(fs, task);
  if (result.id !== resultId) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "The ready result changed; refresh before reviewing it."
    );
  }
  return result;
}

function taskSubmitIntentPath(taskPath: string): string {
  if (!taskPath.endsWith(".md")) {
    throw new Error(`Task submit recovery requires a canonical markdown Task path: ${taskPath}.`);
  }
  return `${taskPath.slice(0, -3)}.result-submit-intent.json`;
}

async function writeTaskSubmitIntent(
  fs: FsAdapter,
  taskPath: string,
  intent: TaskSubmitIntent
): Promise<void> {
  const path = taskSubmitIntentPath(taskPath);
  if (await fs.exists(path)) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      `Exact-Task submit recovery intent already exists: ${path}.`
    );
  }
  await fs.writeFile(path, JSON.stringify(intent, null, 2) + "\n");
}

async function loadTaskSubmitIntent(
  fs: FsAdapter,
  taskPath: string
): Promise<TaskSubmitIntent | undefined> {
  const path = taskSubmitIntentPath(taskPath);
  if (!(await fs.exists(path))) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path));
  } catch {
    throw new Error(`Invalid exact-Task submit recovery intent: ${path}.`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid exact-Task submit recovery intent: ${path}.`);
  }
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "candidateDigest",
    "createdAt",
    "resultId",
    "taskId",
    "type",
    "version",
  ];
  let createdAt: string;
  try {
    createdAt = assertIsoTimestamp(String(value.createdAt ?? ""), "Task submit intent createdAt");
  } catch {
    throw new Error(`Invalid exact-Task submit recovery intent: ${path}.`);
  }
  if (
    !exactStringListEqual(keys, expectedKeys) ||
    value.type !== TASK_SUBMIT_INTENT_TYPE ||
    value.version !== 1 ||
    typeof value.taskId !== "string" ||
    !isTaskId(value.taskId) ||
    typeof value.resultId !== "string" ||
    !isTaskResultId(value.resultId) ||
    typeof value.candidateDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.candidateDigest) ||
    typeof value.createdAt !== "string" ||
    value.createdAt !== createdAt
  ) {
    throw new Error(`Invalid exact-Task submit recovery intent: ${path}.`);
  }
  return value as TaskSubmitIntent;
}

function taskSubmitCandidateForIntent(
  env: OpsEnv,
  task: TaskRecord,
  intent: TaskSubmitIntent,
  options: TaskSubmitOptions
): TaskResultRecord {
  const routing = resolveSubmitRouting(task.acceptMode, options.decision);
  return buildTaskResultRecord(
    { now: () => intent.createdAt },
    {
      taskId: requireCanonicalTaskId(task),
      report: options.report,
      commits: options.commits,
      targetHead: options.targetHead,
      checks: options.checks,
      artifactRefs: options.artifactRefs,
      status: "ready",
      integrationMode: routing.integrationMode,
      resultsDir: resultDirForTask(task),
      id: intent.resultId,
    }
  );
}

function assertTaskSubmitIntentMatchesResult(
  intent: TaskSubmitIntent,
  result: TaskResultRecord
): void {
  if (
    result.taskId !== intent.taskId ||
    result.id !== intent.resultId ||
    result.status !== "ready" ||
    result.review !== undefined ||
    result.createdAt !== intent.createdAt ||
    taskResultAcceptCandidateDigest(result) !== intent.candidateDigest
  ) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      `Exact-Task submit recovery Result ${intent.resultId} differs from its persisted intent.`
    );
  }
}

async function recoverPendingTaskSubmit(
  env: OpsEnv,
  taskPath: string,
  intent: TaskSubmitIntent,
  options: TaskSubmitOptions,
  allowCreate: boolean
): Promise<TaskSubmitPrepared> {
  const reviewIntents = await loadTaskReviewIntents(env.fs, taskPath);
  if (reviewIntents.accept || reviewIntents.reject) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "Conflicting exact-Task submit and review recovery intents exist; refusing mutation."
    );
  }
  let task = await loadTaskRecord(env.fs, taskPath);
  if (requireCanonicalTaskId(task) !== intent.taskId) {
    throw new TaskLifecycleError("RESULT_CHANGED", "Task submit recovery intent identity changed.");
  }
  const candidate = taskSubmitCandidateForIntent(env, task, intent, options);
  if (taskResultAcceptCandidateDigest(candidate) !== intent.candidateDigest) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "This task.submit request differs from the persisted Result publication."
    );
  }
  const resultPath = candidate.path;
  let result: TaskResultRecord;
  if (await env.fs.exists(resultPath)) {
    result = await loadTaskResult(env.fs, resultPath);
    assertTaskSubmitIntentMatchesResult(intent, result);
  } else {
    if (!allowCreate) {
      throw new TaskLifecycleError(
        "RESULT_CHANGED",
        "A Task Result submit intent exists without its Result; retry the exact task.submit request."
      );
    }
    if (task.state !== "running" || task.currentResultId !== undefined) {
      throw new TaskLifecycleError(
        "RESULT_CHANGED",
        "Task state changed before its intended Result was published."
      );
    }
    result = await createTaskResultUnlocked(
      env.fs,
      { now: () => intent.createdAt },
      {
        taskId: candidate.taskId,
        report: candidate.report,
        commits: candidate.commits,
        targetHead: candidate.targetHead,
        checks: candidate.checks,
        artifactRefs: candidate.artifactRefs,
        status: "ready",
        integrationMode: candidate.integrationMode,
        resultsDir: resultDirForTask(task),
        id: intent.resultId,
      }
    );
    assertTaskSubmitIntentMatchesResult(intent, result);
  }

  if (task.state === "running" && task.currentResultId === undefined) {
    task = await patchTaskRecord(env.fs, taskPath, {
      state: "submitted",
      currentResultId: result.id,
      statusDetail: null,
      updatedAt: env.clock.now(),
    });
  } else if (task.state !== "submitted" || task.currentResultId !== result.id) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "Task no longer matches its persisted Result publication."
    );
  }
  await env.fs.remove(taskSubmitIntentPath(taskPath));
  if (isAutoIntegrationMode(result.integrationMode)) {
    return {
      kind: "auto",
      resultId: result.id,
      commits: [...result.commits],
      ...(result.targetHead ? { targetHead: result.targetHead } : {}),
    };
  }
  return { kind: "done", result: { task, result, autoIntegrated: false } };
}

async function convergeCommittedTaskSubmitIntent(
  env: OpsEnv,
  taskPath: string,
  intent: TaskSubmitIntent
): Promise<TaskRecord> {
  const reviewIntents = await loadTaskReviewIntents(env.fs, taskPath);
  if (reviewIntents.accept || reviewIntents.reject) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "Conflicting exact-Task submit and review recovery intents exist; refusing mutation."
    );
  }
  let task = await loadTaskRecord(env.fs, taskPath);
  if (requireCanonicalTaskId(task) !== intent.taskId) {
    throw new TaskLifecycleError("RESULT_CHANGED", "Task submit recovery intent identity changed.");
  }
  const path = taskResultPathForTask(taskPath, intent.resultId);
  if (!(await env.fs.exists(path))) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "A Task Result submit intent exists without its Result; retry the exact task.submit request."
    );
  }
  const result = await loadTaskResult(env.fs, path);
  assertTaskSubmitIntentMatchesResult(intent, result);
  if (task.state === "running" && task.currentResultId === undefined) {
    task = await patchTaskRecord(env.fs, taskPath, {
      state: "submitted",
      currentResultId: result.id,
      statusDetail: null,
      updatedAt: env.clock.now(),
    });
  } else if (task.state !== "submitted" || task.currentResultId !== result.id) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "Task no longer matches its persisted Result publication."
    );
  }
  await env.fs.remove(taskSubmitIntentPath(taskPath));
  return task;
}

/**
 * Unrelated review mutations may only clean an intent after the exact Result
 * pointer is already durable. Only the matching task.submit retry may publish
 * a Result or advance a running Task to submitted.
 */
async function cleanupCommittedTaskSubmitIntent(
  env: OpsEnv,
  taskPath: string,
  intent: TaskSubmitIntent
): Promise<TaskRecord> {
  const reviewIntents = await loadTaskReviewIntents(env.fs, taskPath);
  if (reviewIntents.accept || reviewIntents.reject) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "Conflicting exact-Task submit and review recovery intents exist; refusing mutation."
    );
  }
  const task = await loadTaskRecord(env.fs, taskPath);
  if (requireCanonicalTaskId(task) !== intent.taskId) {
    throw new TaskLifecycleError("RESULT_CHANGED", "Task submit recovery intent identity changed.");
  }
  const resultPath = taskResultPathForTask(taskPath, intent.resultId);
  if (!(await env.fs.exists(resultPath))) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "A Task Result publication is incomplete; retry the exact task.submit request."
    );
  }
  const result = await loadTaskResult(env.fs, resultPath);
  assertTaskSubmitIntentMatchesResult(intent, result);
  if (task.state !== "submitted" || task.currentResultId !== result.id) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "A Task Result publication is incomplete; retry the exact task.submit request."
    );
  }
  await env.fs.remove(taskSubmitIntentPath(taskPath));
  return task;
}

const TASK_ACCEPT_INTENT_TYPE = "task-result-accept-intent";

type TaskAcceptIntent = {
  type: typeof TASK_ACCEPT_INTENT_TYPE;
  version: 1;
  taskId: string;
  resultId: string;
  resultPath: string;
  candidateDigest: string;
  actor: string;
  commits: string[];
  updatedAt: string;
};

function taskAcceptIntentPath(taskPath: string): string {
  if (!taskPath.endsWith(".md")) {
    throw new Error(`Task accept recovery requires a canonical markdown Task path: ${taskPath}.`);
  }
  return `${taskPath.slice(0, -3)}.result-accept-intent.json`;
}

async function writeTaskAcceptIntent(
  fs: FsAdapter,
  taskPath: string,
  intent: TaskAcceptIntent
): Promise<void> {
  const path = taskAcceptIntentPath(taskPath);
  if (await fs.exists(path)) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      `Exact-Task accept recovery intent already exists: ${path}.`
    );
  }
  await fs.writeFile(path, JSON.stringify(intent, null, 2) + "\n");
}

async function loadTaskAcceptIntent(
  fs: FsAdapter,
  taskPath: string
): Promise<TaskAcceptIntent | undefined> {
  const path = taskAcceptIntentPath(taskPath);
  if (!(await fs.exists(path))) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path));
  } catch {
    throw new Error(`Invalid exact-Task accept recovery intent: ${path}.`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid exact-Task accept recovery intent: ${path}.`);
  }
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "actor",
    "candidateDigest",
    "commits",
    "resultId",
    "resultPath",
    "taskId",
    "type",
    "updatedAt",
    "version",
  ];
  let updatedAt: string;
  try {
    updatedAt = assertIsoTimestamp(String(value.updatedAt ?? ""), "Task accept intent updatedAt");
  } catch {
    throw new Error(`Invalid exact-Task accept recovery intent: ${path}.`);
  }
  if (
    !exactStringListEqual(keys, expectedKeys) ||
    value.type !== TASK_ACCEPT_INTENT_TYPE ||
    value.version !== 1 ||
    typeof value.taskId !== "string" ||
    !isTaskId(value.taskId) ||
    typeof value.resultId !== "string" ||
    !isTaskResultId(value.resultId) ||
    typeof value.resultPath !== "string" ||
    !value.resultPath.trim() ||
    value.resultPath !== value.resultPath.trim() ||
    typeof value.candidateDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.candidateDigest) ||
    typeof value.actor !== "string" ||
    !value.actor.trim() ||
    value.actor !== value.actor.trim() ||
    !Array.isArray(value.commits) ||
    !value.commits.every(
      (item) => typeof item === "string" && Boolean(item.trim()) && item === item.trim()
    ) ||
    new Set(value.commits as string[]).size !== value.commits.length ||
    typeof value.updatedAt !== "string" ||
    value.updatedAt !== updatedAt
  ) {
    throw new Error(`Invalid exact-Task accept recovery intent: ${path}.`);
  }
  return value as TaskAcceptIntent;
}

async function loadTaskReviewIntents(
  fs: FsAdapter,
  taskPath: string
): Promise<{ accept?: TaskAcceptIntent; reject?: TaskRejectIntent }> {
  const accept = await loadTaskAcceptIntent(fs, taskPath);
  const reject = await loadTaskRejectIntent(fs, taskPath);
  if (accept && reject) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "Conflicting exact-Task accept and reject recovery intents exist; refusing mutation."
    );
  }
  return { ...(accept ? { accept } : {}), ...(reject ? { reject } : {}) };
}

function assertTaskAcceptRequestMatchesIntent(
  intent: TaskAcceptIntent,
  options: TaskAcceptOptions
): void {
  if (
    options.resultId !== intent.resultId ||
    canonicalTaskAcceptActor(options.actor) !== intent.actor
  ) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "This task.accept request differs from the persisted accept operation that was recovered."
    );
  }
}

function canonicalTaskAcceptActor(actor: string): string {
  return actor.trim();
}

async function reconcilePendingTaskAccept(
  env: OpsEnv,
  taskPath: string,
  knownIntent?: TaskAcceptIntent
): Promise<
  | {
      task: TaskRecord;
      result: TaskResultRecord;
      intent: TaskAcceptIntent;
      acceptance: TaskAcceptResult;
    }
  | undefined
> {
  const intent = knownIntent ?? await loadTaskAcceptIntent(env.fs, taskPath);
  if (!intent) return undefined;
  const acceptance = await completeTaskAcceptIntent(env, taskPath, intent);
  await env.fs.remove(taskAcceptIntentPath(taskPath));
  return {
    task: acceptance.task,
    result: acceptance.result,
    intent,
    acceptance,
  };
}

async function completeTaskAcceptIntent(
  env: OpsEnv,
  taskPath: string,
  intent: TaskAcceptIntent
): Promise<TaskAcceptResult> {
  const task = await loadTaskRecord(env.fs, taskPath);
  if (
    intent.taskId !== requireCanonicalTaskId(task) ||
    task.currentResultId !== intent.resultId
  ) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      `Exact-Task accept recovery intent does not match Task ${requireCanonicalTaskId(task)}.`
    );
  }
  assertReviewAuthority({
    actor: intent.actor,
    executorRoleId: task.assigneeRoleId,
    requester: task.requester,
    action: "accept",
  });
  const result = await requireTaskResultById(env.fs, task, intent.resultId);
  assertTaskAcceptIntentCanConverge(task, result, intent);

  if (result.status === "ready") {
    result.status = "accepted";
    result.review = { reviewer: intent.actor, at: intent.updatedAt };
    await writeTaskResult(env.fs, result);
  }

  let next = task;
  if (task.state === "submitted") {
    next = await patchTaskRecord(env.fs, taskPath, {
      state: "accepted",
      wait: null,
      updatedAt: intent.updatedAt,
    });
  }
  return { task: next, result };
}

function assertTaskAcceptIntentCanConverge(
  task: TaskRecord,
  result: TaskResultRecord,
  intent: TaskAcceptIntent
): void {
  const taskStateMatches =
    result.status === "ready"
      ? task.state === "submitted"
      : result.status === "accepted" &&
        (task.state === "submitted" ||
          (task.state === "accepted" &&
            task.updatedAt === intent.updatedAt &&
            task.wait == null));
  const resultMatches =
    result.status === "ready"
      ? isReadyTaskResultModeForTask(task, result.integrationMode) && !result.review
      : result.status === "accepted" &&
        isReadyTaskResultModeForTask(task, result.integrationMode) &&
        result.review?.at === intent.updatedAt &&
        result.review.reviewer === intent.actor &&
        result.review.note === undefined;
  if (
    result.path !== intent.resultPath ||
    taskResultAcceptCandidateDigest(result) !== intent.candidateDigest ||
    !exactStringListEqual(result.commits, intent.commits) ||
    !taskStateMatches ||
    !resultMatches
  ) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      `Exact-Task accept recovery cannot converge TaskResult ${result.id} from Task ${requireCanonicalTaskId(task)}.`
    );
  }
}

const TASK_REJECT_INTENT_TYPE = "task-result-reject-intent";

type TaskRejectIntent = {
  type: typeof TASK_REJECT_INTENT_TYPE;
  version: 1;
  taskId: string;
  resultId: string;
  to: "running" | "rejected";
  actor: string;
  note: string;
  updatedAt: string;
};

/**
 * Exact-Task internal intent only. It bridges the otherwise underivable
 * reject-resume vs terminal-reject choice while TaskResult and Task are written.
 * It carries no authority: taskReject writes it only after reviewer validation.
 */
function taskRejectIntentPath(taskPath: string): string {
  if (!taskPath.endsWith(".md")) {
    throw new Error(`Task reject recovery requires a canonical markdown Task path: ${taskPath}.`);
  }
  return `${taskPath.slice(0, -3)}.result-reject-intent.json`;
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
    typeof value.resultId !== "string" ||
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
  { task: TaskRecord; result: TaskResultRecord; intent: TaskRejectIntent } | undefined
> {
  const intent = await loadTaskRejectIntent(env.fs, taskPath);
  if (!intent) return undefined;
  const task = await loadTaskRecord(env.fs, taskPath);
  if (intent.taskId !== requireCanonicalTaskId(task) || task.currentResultId !== intent.resultId) {
    throw new Error(`Exact-Task reject recovery intent does not match Task ${requireCanonicalTaskId(task)}.`);
  }
  assertReviewAuthority({
    actor: intent.actor,
    executorRoleId: task.assigneeRoleId,
    requester: task.requester,
    action: "reject",
  });
  const result = await requireTaskResultById(env.fs, task, intent.resultId);
  assertTaskRejectIntentCanConverge(task, result, intent);
  const completed = await completeTaskRejectIntent(env, taskPath, task, result, intent);
  return { ...completed, intent };
}

/** Exact-Task WAL order for every public lifecycle mutation. */
async function preflightTaskMutation(
  env: OpsEnv,
  taskPath: string,
  options: { allowCommittedSubmitRecovery?: boolean } = {}
): Promise<TaskRecord> {
  const submitIntent = await loadTaskSubmitIntent(env.fs, taskPath);
  if (submitIntent) {
    if (!options.allowCommittedSubmitRecovery) {
      throw new TaskLifecycleError(
        "RESULT_CHANGED",
        "A Task Result publication is incomplete; retry the exact task.submit request."
      );
    }
    return cleanupCommittedTaskSubmitIntent(env, taskPath, submitIntent);
  }
  const intents = await loadTaskReviewIntents(env.fs, taskPath);
  const accepted = intents.accept
    ? await reconcilePendingTaskAccept(env, taskPath, intents.accept)
    : undefined;
  const rejected = intents.reject
    ? await reconcilePendingTaskReject(env, taskPath)
    : undefined;
  const task = accepted?.task ?? rejected?.task ?? await loadTaskRecord(env.fs, taskPath);
  return reconcileCommittedTaskResult(env, taskPath, task);
}

function assertTaskRejectRequestMatchesIntent(
  intent: TaskRejectIntent,
  options: TaskRejectOptions
): void {
  const expectedTo = options.resume === false ? "rejected" : "running";
  const expectedNote = options.note?.trim() || DEFAULT_TASK_REJECT_NOTE;
  if (
    options.resultId !== intent.resultId ||
    options.actor !== intent.actor ||
    expectedTo !== intent.to ||
    expectedNote !== intent.note
  ) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "This task.reject request differs from the persisted reject operation that was recovered."
    );
  }
}

async function completeTaskRejectIntent(
  env: OpsEnv,
  taskPath: string,
  task: TaskRecord,
  result: TaskResultRecord,
  intent: TaskRejectIntent
): Promise<{ task: TaskRecord; result: TaskResultRecord }> {
  if (result.status === "ready") {
    result.status = "rejected";
    result.review = {
      reviewer: intent.actor,
      at: intent.updatedAt,
      note: intent.note,
    };
    await writeTaskResult(env.fs, result);
  } else if (
    result.status !== "rejected" ||
    result.review?.reviewer !== intent.actor ||
    result.review.at !== intent.updatedAt ||
    result.review.note !== intent.note
  ) {
    throw new Error(`Exact-Task reject recovery TaskResult ${result.id} does not match its intent.`);
  }

  let next = task;
  if (task.state === "submitted") {
    next = await patchTaskRecord(env.fs, taskPath, {
      state: intent.to,
      // Keep currentResultId for history; new submit checks ready-only.
      updatedAt: intent.updatedAt,
    });
  } else if (task.state !== intent.to) {
    throw new Error(
      `Exact-Task reject recovery expected Task state submitted|${intent.to}, got ${task.state}.`
    );
  }

  await env.fs.remove(taskRejectIntentPath(taskPath));
  return { task: next, result };
}

/** Validate the complete committed reject operation before its first write. */
function assertTaskRejectIntentCanConverge(
  task: TaskRecord,
  result: TaskResultRecord,
  intent: TaskRejectIntent
): void {
  if (task.state !== "submitted" && task.state !== intent.to) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      `Exact-Task reject recovery cannot converge from Task state ${task.state}.`
    );
  }
  if (
    !isReadyTaskResultModeForTask(task, result.integrationMode)
  ) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "Persisted reject TaskResult integration mode does not match its exact Task."
    );
  }
  if (result.status === "ready") {
    if (result.review) {
      throw new TaskLifecycleError(
        "RESULT_CHANGED",
        "Ready TaskResult already carries review authority; refusing reject recovery."
      );
    }
    return;
  }
  if (
    result.status !== "rejected" ||
    result.review?.reviewer !== intent.actor ||
    result.review.at !== intent.updatedAt ||
    result.review.note !== intent.note
  ) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      `Exact-Task reject recovery TaskResult ${result.id} does not match its intent.`
    );
  }
}

async function recoverExistingTaskSubmit(
  env: OpsEnv,
  taskPath: string,
  task: TaskRecord,
  options: TaskSubmitOptions
): Promise<TaskSubmitPrepared | undefined> {
  const result = await findCommittedTaskResult(env.fs, task);
  if (!result || (result.status !== "ready" && result.status !== "accepted")) return undefined;
  assertCommittedResultMatchesTask(task, result);
  assertTaskSubmitCandidateMatches(task, result, options);

  let next = task;
  if (result.status === "ready") {
    if (task.state === "running") {
      next = await patchTaskRecord(env.fs, taskPath, {
        state: "submitted",
        currentResultId: result.id,
        statusDetail: null,
        updatedAt: env.clock.now(),
      });
    } else if (task.state !== "submitted" || task.currentResultId !== result.id) {
      return undefined;
    }
  } else {
    if (!isAutoIntegrationMode(result.integrationMode)) return undefined;
    if (task.state === "submitted" && task.currentResultId === result.id) {
      next = await patchTaskRecord(env.fs, taskPath, {
        state: "accepted",
        currentResultId: result.id,
        statusDetail: null,
        wait: null,
        updatedAt: env.clock.now(),
      });
    } else if (task.state !== "accepted" || task.currentResultId !== result.id) {
      return undefined;
    }
  }
  if (result.status === "accepted") {
    return {
      kind: "done",
      result: { task: next, result, autoIntegrated: true },
    };
  }
  if (isAutoIntegrationMode(result.integrationMode)) {
    return {
      kind: "auto",
      resultId: result.id,
      commits: [...result.commits],
      ...(result.targetHead ? { targetHead: result.targetHead } : {}),
    };
  }
  return {
    kind: "done",
    result: { task: next, result, autoIntegrated: false },
  };
}

/**
 * Reconcile only an already-committed exact-Task TaskResult WAL. This helper has
 * no caller-supplied candidate data, so competing lifecycle operations cannot
 * overwrite the prior submit operation while repairing its Task projection.
 */
async function reconcileCommittedTaskResult(
  env: OpsEnv,
  taskPath: string,
  task: TaskRecord
): Promise<TaskRecord> {
  const result = await findCommittedTaskResult(env.fs, task);
  if (!result) return task;
  if (result.status === "ready" || result.status === "accepted") {
    assertCommittedResultMatchesTask(task, result);
  }

  if (result.status === "ready") {
    if (task.state === "submitted" && task.currentResultId === result.id) return task;
    throwCommittedTaskResultStateMismatch(task, result);
  }
  if (result.status === "accepted") {
    if (task.state === "submitted" && task.currentResultId === result.id) {
      return patchTaskRecord(env.fs, taskPath, {
        state: "accepted",
        currentResultId: result.id,
        statusDetail: null,
        wait: null,
        updatedAt: env.clock.now(),
      });
    }
    if (task.state === "accepted" && task.currentResultId === result.id) return task;
    throwCommittedTaskResultStateMismatch(task, result);
  }
  return task;
}

function throwCommittedTaskResultStateMismatch(
  task: TaskRecord,
  result: TaskResultRecord
): never {
  throw new TaskLifecycleError(
    "RESULT_CHANGED",
    `Committed TaskResult ${result.id} (${result.status}) conflicts with Task ${requireCanonicalTaskId(task)} state ${task.state}; refusing mutation.`
  );
}

function assertCommittedResultMatchesTask(
  task: TaskRecord,
  result: TaskResultRecord
): void {
  const modeMatches = result.status === "ready"
    ? isReadyTaskResultModeForTask(task, result.integrationMode)
    : result.status === "accepted"
      ? isReadyTaskResultModeForTask(task, result.integrationMode)
      : true;
  if (!modeMatches) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "Persisted TaskResult integration mode does not match its exact Task; refusing recovery."
    );
  }
}

function isReadyTaskResultModeForTask(
  task: TaskRecord,
  integrationMode: TaskResultRecord["integrationMode"]
): boolean {
  return (
    (task.acceptMode === "review-required" && integrationMode === null) ||
    (task.acceptMode === "auto-accept" && integrationMode === "auto-accept") ||
    (task.acceptMode === "agent-decide" &&
      (integrationMode === null || integrationMode === "agent-decided-integrate"))
  );
}

function assertTaskSubmitCandidateMatches(
  task: TaskRecord,
  result: TaskResultRecord,
  options: TaskSubmitOptions
): void {
  const routing = resolveSubmitRouting(task.acceptMode, options.decision);
  const expectedCommits = [...new Set((options.commits ?? []).map((value) => value.trim()).filter(Boolean))];
  const expectedTargetHead = options.targetHead?.trim() || undefined;
  const expectedChecks = options.checks ?? [];
  const expectedArtifacts = normalizeArtifactRefs(options.artifactRefs ?? []);
  if (
    result.report !== options.report.trim() ||
    result.integrationMode !== routing.integrationMode ||
    !exactStringListEqual(result.commits, expectedCommits) ||
    (result.targetHead?.trim() || undefined) !== expectedTargetHead ||
    !exactTaskResultChecksEqual(result.checks, expectedChecks) ||
    !exactArtifactRefsEqual(result.artifactRefs, expectedArtifacts)
  ) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "Persisted TaskResult candidate differs from this task.submit retry; refusing duplicate publication."
    );
  }
}

function exactTaskResultChecksEqual(
  current: readonly TaskResultCheck[],
  expected: readonly TaskResultCheck[]
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

function assertPreparedResultMatches(
  result: TaskResultRecord,
  prepared: Extract<TaskSubmitPrepared, { kind: "auto" }>
): void {
  if (
    result.id !== prepared.resultId ||
    !exactStringListEqual(result.commits, prepared.commits) ||
    (result.targetHead?.trim() || undefined) !== prepared.targetHead
  ) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      "Ready result changed during auto-accept; refusing state write."
    );
  }
}

function isAutoIntegrationMode(mode: TaskResultRecord["integrationMode"]): boolean {
  return mode === "auto-accept" || mode === "agent-decided-integrate";
}

async function requireTaskResultById(
  fs: FsAdapter,
  task: TaskRecord,
  resultId: string
): Promise<TaskResultRecord> {
  const result = await loadTaskResultById(fs, task, resultId);
  if (!result) {
    throw new TaskLifecycleError("NO_ACTIVE_RESULT", "No result for this exact task and id.");
  }
  return result;
}

async function loadTaskResultById(
  fs: FsAdapter,
  task: TaskRecord,
  resultId: string
): Promise<TaskResultRecord | undefined> {
  const path = join(resultDirForTask(task), `${resultId}.md`);
  if (!(await fs.exists(path))) return undefined;
  const result = await loadTaskResult(fs, path);
  if (result.id !== resultId || result.taskId !== requireCanonicalTaskId(task)) {
    throw new TaskLifecycleError(
      "RESULT_CHANGED",
      `TaskResult ${resultId} does not belong to exact Task ${requireCanonicalTaskId(task)}.`
    );
  }
  return result;
}

async function findCommittedTaskResult(
  fs: FsAdapter,
  task: TaskRecord
): Promise<TaskResultRecord | undefined> {
  if (!task.currentResultId) return undefined;
  const current = await loadTaskResultById(fs, task, task.currentResultId);
  return current?.status === "ready" || current?.status === "accepted"
    ? current
    : undefined;
}

function requireCanonicalTaskId(task: TaskRecord): string {
  const id = task.id?.trim() || "";
  if (!isTaskId(id)) {
    throw new Error(`Task ${task.path} is missing its canonical tk-* id.`);
  }
  return id;
}

async function withMutation<T>(fs: FsAdapter, action: () => Promise<T>): Promise<T> {
  return withTentMutation(fs, action);
}
