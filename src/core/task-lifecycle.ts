// Task lifecycle API (B4) — claim / wait / deliver / accept / reject / interrupt.
// Uses existing envelope files under temp/<role>/tasks and delivery records.
// Runtime occupation oracle = active Task envelope only.
// Node frontmatter is not dual-written for owner/status; collaboration truth is Task/Delivery.

import { withTentMutation, type FsAdapter } from "./adapter.js";
import { canClaim, envelopeIsActiveOccupation } from "./claim.js";
import {
  createDeliveryUnlocked,
  loadDeliveries,
  removeNonAcceptedDeliveriesForBox,
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
import type { Box } from "./types.js";
import {
  ackTaskEnvelope,
  loadTaskEnvelope,
  loadTaskEnvelopes,
  patchTaskEnvelope,
  primaryBoxId,
  taskAssigneeKind,
  taskAsSub,
  type TaskEnvelope,
} from "./task.js";
import { agentProfileDeliveriesDir } from "./paths.js";
import {
  assertReviewAuthority,
  assertTransition,
  evaluateA2A,
  projectBoxFromTask,
  resolveDeliverRouting,
  TaskLifecycleError,
  type A2APolicy,
  type ArtifactRef,
  type DeliverDecision,
  type DeliveryCheck,
  type DeliveryPolicy,
  type TaskState,
  type WaitReason,
} from "./task-model.js";

export interface TaskClaimOptions {
  sessionId?: string;
}

export interface TaskWaitOptions {
  reason: WaitReason;
  summary: string;
}

export interface TaskDeliverOptions {
  summary: string;
  commits?: string[];
  checks?: DeliveryCheck[];
  artifactRefs?: ArtifactRef[];
  /** Required when deliveryPolicy=agent-decide. */
  decision?: DeliverDecision;
  /** Optional integrate hook for auto-integrate paths (bypass / agent-decide integrate). */
  integrate?: (commits: string[]) => Promise<void>;
}

export interface TaskAcceptOptions {
  actor: string;
  commits?: string[];
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

export interface TaskStartSessionGateInput {
  callerKind: "user" | "role";
  policy?: A2APolicy;
  profileAllowed?: boolean;
}

export async function taskClaim(env: OpsEnv, taskPath: string, options: TaskClaimOptions = {}): Promise<TaskEnvelope> {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    if (task.state === "running" && task.status === "taken") {
      // Idempotent re-ack (legacy taskAck behavior).
      if (options.sessionId) {
        return patchTaskEnvelope(env.fs, taskPath, {
          sessionId: options.sessionId,
          updatedAt: env.clock.now(),
        });
      }
      return task;
    }
    assertTransition(task.state, "claim", "running");

    const tent = await loadTent(env.fs);
    const claimedBoxes = task.claims
      .filter((claimId) => claimId !== "root")
      .map((claimId) => requireBoxById(tent, claimId));

    // asSub: helper may claim a free child under dispatchedBy's active ancestor occupation.
    // Peer claims still require a fully free ancestor/descendant chain.
    // Occupation oracle = active Task envelopes only.
    const allowAncestorClaimedBy =
      taskAsSub(task) && task.dispatchedBy && task.dispatchedBy !== "user" && task.dispatchedBy !== task.role
        ? task.dispatchedBy
        : undefined;

    const allTasks = await loadTaskEnvelopes(env.fs);
    // Exclude this task itself (still queued) so claim is not blocked by its own envelope.
    const peerTasks = allTasks.filter((t) => t.path !== taskPath && t.path !== task.path);

    for (const box of claimedBoxes) {
      const claimable = canClaim(box, {
        tent,
        tasks: peerTasks,
        ...(allowAncestorClaimedBy ? { allowAncestorClaimedBy } : {}),
      });
      if (!claimable.ok) throw new Error(`Cannot claim task: ${claimable.reason || "box cannot be claimed"}`);
    }

    // Claim only acks the envelope — no Node frontmatter owner/status dual-write.
    await ackTaskEnvelope(env.fs, taskPath);
    if (options.sessionId) {
      return patchTaskEnvelope(env.fs, taskPath, {
        sessionId: options.sessionId,
        updatedAt: env.clock.now(),
      });
    }
    return loadTaskEnvelope(env.fs, taskPath);
  });
}

export async function taskWait(env: OpsEnv, taskPath: string, options: TaskWaitOptions): Promise<TaskEnvelope> {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "wait", "waiting");
    const summary = options.summary.trim();
    if (!summary) throw new Error("task.wait requires a non-empty summary.");
    return patchTaskEnvelope(env.fs, taskPath, {
      state: "waiting",
      wait: { reason: options.reason, summary },
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

export async function taskDeliver(
  env: OpsEnv,
  taskPath: string,
  options: TaskDeliverOptions
): Promise<TaskDeliverResult> {
  // Manual path: single atomic lock section (no Git).
  // Auto-integrate path: validate under lock → Git outside lock → re-validate +
  // state write under lock. Failure before the second section keeps running and
  // leaves no delivery (same semantics as holding the lock across integrate).
  type DeliverPhase =
    | { kind: "done"; result: TaskDeliverResult }
    | { kind: "auto"; boxId: string };

  const phase = await withMutation(env.fs, async (): Promise<DeliverPhase> => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertDeliverPreconditions(task);
    const boxId = primaryBoxId(task);
    if (!boxId) throw new Error("task.deliver requires a non-root box claim.");
    await assertNoReadyDelivery(env.fs, task.id || taskPath);

    const policy: DeliveryPolicy = task.deliveryPolicy ?? "manual";
    const routing = resolveDeliverRouting(policy, options.decision);

    if (routing.autoIntegrate) {
      return { kind: "auto", boxId };
    }

    const delivery = await createDeliveryUnlocked(env.fs, env.clock, {
      taskId: task.id || taskPath,
      boxId,
      role: task.role,
      summary: options.summary,
      commits: options.commits,
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
      updatedAt: env.clock.now(),
    });
    return { kind: "done", result: { task: next, delivery, autoIntegrated: false } };
  });

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

  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertDeliverPreconditions(task);
    const boxId = primaryBoxId(task);
    if (!boxId || boxId !== phase.boxId) {
      throw new Error("task.deliver requires a non-root box claim.");
    }
    await assertNoReadyDelivery(env.fs, task.id || taskPath);

    const policy: DeliveryPolicy = task.deliveryPolicy ?? "manual";
    const routing = resolveDeliverRouting(policy, options.decision);
    if (!routing.autoIntegrate) {
      throw new Error("Delivery policy changed during integrate; refusing state write.");
    }

    const delivery = await createDeliveryUnlocked(env.fs, env.clock, {
      taskId: task.id || taskPath,
      boxId,
      role: task.role,
      summary: options.summary,
      commits: options.commits,
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
      wait: null,
      updatedAt: env.clock.now(),
    });
    return { task: next, delivery, autoIntegrated: true };
  });
}

export async function taskAccept(
  env: OpsEnv,
  taskPath: string,
  options: TaskAcceptOptions
): Promise<{
  task: TaskEnvelope;
  delivery: DeliveryRecord;
  /** Output Node ids successfully bound (including same-delivery idempotent). */
  boundOutputIds: string[];
  /** Subset that newly wrote deliveryId (for concept.changed). */
  changedOutputIds: string[];
}> {
  // Validate authority + ready delivery under lock; Git integrate outside;
  // then re-validate, bind Outputs, and write accepted atomically under lock.
  const prepared = await withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "accept", "accepted");
    const delivery = await requireActiveReadyDelivery(env.fs, task);
    assertReviewAuthority({
      actor: options.actor,
      submitterRole: delivery.role,
      asSub: taskAsSub(task),
      dispatchedBy: task.dispatchedBy,
      action: "accept",
    });
    // Pre-validate Outputs before integrate so bad selectors fail before side effects.
    if (options.outputNodeIds && options.outputNodeIds.length > 0) {
      const tent = await loadTent(env.fs);
      validateOutputBindingsForAccept(tent, options.outputNodeIds, delivery.id);
    }
    const commits = options.commits ?? delivery.commits;
    return {
      deliveryId: delivery.id,
      deliveryPath: delivery.path,
      commits: [...commits],
    };
  });

  if (prepared.commits.length > 0) {
    if (!options.integrate) {
      throw new Error("Delivery contains commits; workspace integration is required.");
    }
    await options.integrate(prepared.commits);
  }

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
    assertReviewAuthority({
      actor: options.actor,
      submitterRole: delivery.role,
      asSub: taskAsSub(task),
      dispatchedBy: task.dispatchedBy,
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
    // Self-reject-as-review forbidden; sub tasks further require user or exact dispatchedBy.
    assertReviewAuthority({
      actor: options.actor,
      submitterRole: delivery.role,
      asSub: taskAsSub(task),
      dispatchedBy: task.dispatchedBy,
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
    if (task.state === "queued") {
      assertTransition(task.state, "interrupt", "interrupted");
      await env.fs.remove(taskPath);
      // Return synthetic terminal view (file gone).
      return { ...task, state: "interrupted", status: "taken" };
    }
    assertTransition(task.state, "interrupt", "interrupted");

    await releaseOccupationForTask(env, task);

    return patchTaskEnvelope(env.fs, taskPath, {
      state: "interrupted",
      wait: null,
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
 * Releases box occupation via task terminal state (and non-accepted delivery cleanup)
 * so the same box can be re-dispatched. No Node frontmatter dual-write.
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

/** Clear non-accepted deliveries for claimed boxes; occupation ends with task state. */
async function releaseOccupationForTask(env: OpsEnv, task: TaskEnvelope): Promise<void> {
  for (const claimId of task.claims) {
    if (claimId === "root") continue;
    await removeNonAcceptedDeliveriesForBox(env.fs, claimId);
  }
}

export async function taskCancel(env: OpsEnv, taskPath: string): Promise<void> {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "cancel", "interrupted");
    await env.fs.remove(taskPath);
  });
}

/** Pure A2A gate used by service before startSession (B8c hardens storage). */
export function gateStartSession(input: TaskStartSessionGateInput): "allow" | "ask" | "deny" {
  return evaluateA2A(input);
}

export function assertA2AAllow(input: TaskStartSessionGateInput): void {
  const decision = evaluateA2A(input);
  if (decision === "deny") {
    throw new TaskLifecycleError("A2A_DENIED", "A2A policy denies starting a new runtime session.");
  }
  if (decision === "ask") {
    throw new TaskLifecycleError(
      "A2A_DENIED",
      "A2A policy requires user approval before starting a new runtime session (ask)."
    );
  }
}

/** Find active operational task for a box (envelope oracle; not frontmatter owner). */
export async function findActiveTaskForBox(fs: FsAdapter, boxId: string): Promise<TaskEnvelope | undefined> {
  const tasks = await loadTaskEnvelopes(fs);
  return tasks.find((t) => t.claims.includes(boxId) && envelopeIsActiveOccupation(t));
}

export function boxProjectionOf(task: TaskEnvelope | undefined): {
  status: "todo" | "doing" | "done";
  assignee?: string;
  activeTaskId?: string;
} {
  if (!task) return { status: "todo" };
  const active = envelopeIsActiveOccupation(task);
  const proj = projectBoxFromTask({
    active,
    terminalState: active ? undefined : task.state,
  });
  return {
    status: proj.status,
    // assignee is the stable label (role name or profileId).
    assignee: proj.clearAssignee ? undefined : task.role,
    activeTaskId: active ? task.id || task.path : undefined,
  };
}

/** Delivery storage dir for a task (role lane or agent-profiles namespace). */
function deliveryDirForTask(task: TaskEnvelope): string | undefined {
  if (taskAssigneeKind(task) === "agentProfile") {
    return agentProfileDeliveriesDir(task.role);
  }
  return undefined;
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

function requireBoxById(tent: LoadedTent, boxId: string): Box {
  if (tent.duplicateIds.has(boxId)) {
    throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  }
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  return box;
}

async function withMutation<T>(fs: FsAdapter, action: () => Promise<T>): Promise<T> {
  return withTentMutation(fs, action);
}

