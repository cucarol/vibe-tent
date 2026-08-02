// Task lifecycle API (B4) — claim / wait / deliver / accept / reject / interrupt.
// Uses existing envelope files under temp/<role>/tasks and delivery records.
// Runtime occupation oracle = active Task envelope only.
// Node frontmatter is not dual-written for owner/status; collaboration truth is Task/Delivery.

import { withTentMutation, type FsAdapter } from "./adapter.js";
import { canClaim, envelopeIsActiveOccupation } from "./claim.js";
import {
  listDirectActiveTasksForNode,
  taskReferencedNodeIds,
} from "./task-node-refs.js";
import {
  createDeliveryUnlocked,
  loadDeliveries,
  removeNonAcceptedDeliveriesForTask,
  writeDelivery,
  type DeliveryRecord,
} from "./delivery.js";
import {
  bindOutputsToDeliveryUnlocked,
  restoreOutputBindSnapshots,
  validateOutputBindingsForAccept,
  type OutputBindSnapshot,
} from "./output.js";
import type { OpsEnv } from "./ops-context.js";
import { loadTent, type LoadedTent } from "./tree.js";
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
import { roleDeliveriesDir, sessionDeliveriesDir } from "./paths.js";
import { isSessionId } from "./id.js";
import {
  assertReviewAuthority,
  assertTransition,
  DEFAULT_DELIVERY_POLICY,
  resolveDeliverRouting,
  TaskLifecycleError,
  type ArtifactRef,
  type DeliverDecision,
  type DeliveryCheck,
  type DeliveryPolicy,
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
  /** Required when deliveryPolicy=agent-decide. */
  decision?: DeliverDecision;
  /** Optional integrate hook for auto-integrate paths (bypass / agent-decide integrate). */
  integrate?: (commits: string[]) => Promise<void>;
}

export interface TaskAcceptOptions {
  actor: string;
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
  note?: string;
  /** Default true — rework path delivered → running. */
  resume?: boolean;
}

export async function taskClaim(env: OpsEnv, taskPath: string, options: TaskClaimOptions = {}): Promise<TaskEnvelope> {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
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
    if (task.contextCard == null) {
      throw new Error(
        `Cannot claim task: missing Task.contextCard.refs.nodes.`
      );
    }
    const claimedNodes = taskReferencedNodeIds(task).map((claimId) =>
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
    const task = await loadTaskEnvelope(env.fs, taskPath);
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
    const task = await loadTaskEnvelope(env.fs, taskPath);
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

export interface TaskDeliverResult {
  task: TaskEnvelope;
  delivery: DeliveryRecord;
  autoIntegrated: boolean;
}

/**
 * First deliver section under mutation.lock.
 * Manual/review: publishes ready Delivery and returns done.
 * Auto-integrate policies: validates only and returns auto (caller integrates Git outside lock).
 */
export type TaskDeliverPrepared =
  | { kind: "done"; result: TaskDeliverResult }
  | { kind: "auto"; sourceNodeId: string };

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
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertDeliverPreconditions(task);
    const nodeId = primaryNodeId(task);
    if (!nodeId) throw new Error("task.deliver requires a non-root node claim.");
    await assertNoReadyDelivery(env.fs, task.id || taskPath);

    const policy: DeliveryPolicy = task.deliveryPolicy ?? DEFAULT_DELIVERY_POLICY;
    const routing = resolveDeliverRouting(policy, options.decision);

    if (routing.autoIntegrate) {
      return { kind: "auto", sourceNodeId: nodeId };
    }

    const delivery = await createDeliveryUnlocked(env.fs, env.clock, {
      taskId: task.id || taskPath,
      sourceNodeId: nodeId,
      summary: options.summary,
      commits: options.commits,
      targetHead: options.targetHead,
      checks: options.checks,
      artifactRefs: options.artifactRefs,
      status: "ready",
      integrationMode: routing.integrationMode,
      deliveriesDir: deliveryDirForTask(task),
    });

    assertTransition(task.state, "deliver", "delivered");
    const next = await patchTaskEnvelope(env.fs, taskPath, {
      state: "delivered",
      activeDeliveryId: delivery.id,
      ...(options.lastOutcome ? { lastOutcome: options.lastOutcome } : {}),
      updatedAt: env.clock.now(),
    });
    return { kind: "done", result: { task: next, delivery, autoIntegrated: false } };
  });
}

/**
 * Finalize auto-integrate deliver under mutation.lock after Git ran outside the lock.
 * Failure leaves running with no Delivery (same as holding the lock across integrate).
 */
export async function finalizeTaskDeliverAuto(
  env: OpsEnv,
  taskPath: string,
  options: TaskDeliverOptions,
  prepared: Extract<TaskDeliverPrepared, { kind: "auto" }>
): Promise<TaskDeliverResult> {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertDeliverPreconditions(task);
    const nodeId = primaryNodeId(task);
    if (!nodeId || nodeId !== prepared.sourceNodeId) {
      throw new Error("task.deliver requires a non-root node claim.");
    }
    await assertNoReadyDelivery(env.fs, task.id || taskPath);

    const policy: DeliveryPolicy = task.deliveryPolicy ?? DEFAULT_DELIVERY_POLICY;
    const routing = resolveDeliverRouting(policy, options.decision);
    if (!routing.autoIntegrate) {
      throw new Error("Delivery policy changed during integrate; refusing state write.");
    }

    const delivery = await createDeliveryUnlocked(env.fs, env.clock, {
      taskId: task.id || taskPath,
      sourceNodeId: nodeId,
      summary: options.summary,
      commits: options.commits,
      targetHead: options.targetHead,
      checks: options.checks,
      artifactRefs: options.artifactRefs,
      status: "accepted",
      integrationMode: routing.integrationMode,
      deliveriesDir: deliveryDirForTask(task),
    });
    // No review.by = submitter — integrate is service policy engine action.
    // Occupation ends via task state=accepted; no Node frontmatter write.

    const next = await patchTaskEnvelope(env.fs, taskPath, {
      state: "accepted",
      activeDeliveryId: delivery.id,
      ...(options.lastOutcome ? { lastOutcome: options.lastOutcome } : {}),
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
  // Manual path: single atomic lock section (no Git).
  // Auto-integrate path: validate under lock → Git outside lock → re-validate +
  // state write under lock. Failure before the second section keeps running and
  // leaves no delivery (same semantics as holding the lock across integrate).
  const phase = await prepareTaskDeliver(env, taskPath, options);
  if (phase.kind === "done") return phase.result;

  const pendingCommits = [
    ...new Set((options.commits ?? []).map((c) => c.trim()).filter(Boolean)),
  ];
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
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "accept", "accepted");
    const delivery = await requireActiveReadyDelivery(env.fs, task);
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
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "accept", "accepted");
    const delivery = await requireActiveReadyDelivery(env.fs, task);
    if (delivery.id !== prepared.deliveryId) {
      throw new TaskLifecycleError(
        "NO_ACTIVE_DELIVERY",
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
    const task = await loadTaskEnvelope(env.fs, taskPath);
    const resume = options.resume !== false;
    const event = resume ? "reject-resume" : "reject-terminal";
    const to: TaskState = resume ? "running" : "rejected";
    assertTransition(task.state, event, to);

    const delivery = await requireActiveReadyDelivery(env.fs, task);
    // Exact Task.reviewer only (no user bypass on Role-reviewed); never self.
    assertReviewAuthority({
      actor: options.actor,
      executorRoleId: task.roleId,
      reviewer: task.reviewer,
      action: "reject",
    });

    delivery.status = "rejected";
    delivery.review = {
      by: options.actor,
      decision: "reject",
      note: options.note?.trim() || "Rejected; waiting for resubmission.",
    };
    delivery.updatedAt = env.clock.now();
    await writeDelivery(env.fs, delivery);

    // Terminal reject ends occupation via task state only (no FM owner clear).
    const next = await patchTaskEnvelope(env.fs, taskPath, {
      state: to,
      // Keep activeDeliveryId for history; new deliver checks ready-only.
      updatedAt: env.clock.now(),
    });
    return { task: next, delivery };
  });
}

export async function taskInterrupt(env: OpsEnv, taskPath: string): Promise<TaskEnvelope> {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
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
    const task = await loadTaskEnvelope(env.fs, taskPath);
    if (task.state === "failed") {
      // Already terminal non-active — ensure non-accepted deliveries are cleared (repair path).
      await releaseOccupationForTask(env, task);
      return task;
    }
    assertTransition(task.state, "fail", "failed");
    await releaseOccupationForTask(env, task);
    void options.summary;
    return patchTaskEnvelope(env.fs, taskPath, {
      state: "failed",
      wait: null,
      updatedAt: env.clock.now(),
    });
  });
}

/** Clear this Task's non-accepted deliveries; occupation ends with task state. */
async function releaseOccupationForTask(env: OpsEnv, task: TaskEnvelope): Promise<void> {
  await removeNonAcceptedDeliveriesForTask(env.fs, task.id || task.path);
}

export async function taskCancel(env: OpsEnv, taskPath: string): Promise<void> {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "cancel", "interrupted");
    await env.fs.remove(taskPath);
  });
}

/** Find active operational task for a node (envelope oracle; not frontmatter owner). */
export async function findActiveTaskForNode(fs: FsAdapter, nodeId: string): Promise<TaskEnvelope | undefined> {
  const tasks = await loadTaskEnvelopes(fs);
  return listDirectActiveTasksForNode(nodeId, tasks)[0];
}

/** Delivery storage dir is derived from canonical Task Role/Session facts. */
function deliveryDirForTask(task: TaskEnvelope): string {
  if (task.roleId) return roleDeliveriesDir(task.roleId);
  if (task.sessionId) return sessionDeliveriesDir(task.sessionId);
  throw new Error(`Task ${task.id || task.path} has no Role or Session delivery namespace.`);
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

async function assertNoReadyDelivery(fs: FsAdapter, taskId: string): Promise<void> {
  const existing = await loadDeliveries(fs, { taskId });
  if (existing.some((d) => d.status === "ready")) {
    throw new Error("A delivery is already ready for review; accept or reject it first.");
  }
}

async function requireActiveReadyDelivery(fs: FsAdapter, task: TaskEnvelope): Promise<DeliveryRecord> {
  if (task.activeDeliveryId) {
    const byId = (await loadDeliveries(fs, { taskId: task.id || task.path })).find(
      (d) => d.id === task.activeDeliveryId
    );
    if (byId && byId.status === "ready") return byId;
    // Fall through: try path via role
    if (byId) {
      // reload by path if status drifted
    }
  }
  const ready = (await loadDeliveries(fs, { taskId: task.id || task.path })).find((d) => d.status === "ready");
  if (!ready) {
    throw new TaskLifecycleError("NO_ACTIVE_DELIVERY", "No ready delivery for this task.");
  }
  return ready;
}

function requireNodeById(tent: LoadedTent, nodeId: string): Node {
  if (tent.duplicateIds.has(nodeId)) {
    throw new Error(`Duplicate node id '${nodeId}' found; repair or fork the duplicate nodes before using this id.`);
  }
  const node = tent.byId.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}.`);
  return node;
}

async function withMutation<T>(fs: FsAdapter, action: () => Promise<T>): Promise<T> {
  return withTentMutation(fs, action);
}
