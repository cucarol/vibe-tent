// Task lifecycle API (B4) — claim / wait / deliver / accept / reject / interrupt.
// Uses existing envelope files under temp/<role>/tasks and delivery records.
// Runtime occupation oracle = active Task envelope only.
// Box status/owner remain optional frontmatter projections (legacy-compatible summary).

import { withTentMutation, type FsAdapter } from "./adapter.js";
import { canClaim, envelopeIsActiveOccupation } from "./claim.js";
import {
  createDeliveryUnlocked,
  loadDeliveries,
  removeNonAcceptedDeliveriesForBox,
  writeDelivery,
  type DeliveryRecord,
} from "./delivery.js";
import { BOX_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import type { OpsEnv } from "./ops-context.js";
import { boxNotePath, loadTent, type LoadedTent } from "./tree.js";
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
    const previous = claimedBoxes.map((box) => ({
      box,
      owner: box.fm.owner,
      status: box.fm.status,
      acceptedBy: box.fm.acceptedBy,
    }));

    // asSub: helper may claim a free child under dispatchedBy's active ancestor occupation.
    // Peer claims still require a fully free ancestor/descendant chain.
    // Occupation oracle = active Task envelopes only (not stale frontmatter owner).
    const allowAncestorClaimedBy =
      taskAsSub(task) && task.dispatchedBy && task.dispatchedBy !== "user" && task.dispatchedBy !== task.role
        ? task.dispatchedBy
        : undefined;

    const allTasks = await loadTaskEnvelopes(env.fs);
    // Exclude this task itself (still queued) so claim is not blocked by its own envelope.
    const peerTasks = allTasks.filter((t) => t.path !== taskPath && t.path !== task.path);

    for (const box of claimedBoxes) {
      if (!box.coordination) {
        throw new Error(
          `Cannot claim task: ${box.name} has coordination=false (type ${box.type}); ordinary notes cannot enter the task lifecycle.`
        );
      }
      const claimable = canClaim(box, {
        tent,
        tasks: peerTasks,
        ...(allowAncestorClaimedBy ? { allowAncestorClaimedBy } : {}),
      });
      if (!claimable.ok) throw new Error(`Cannot claim task: ${claimable.reason || "box cannot be claimed"}`);
    }

    try {
      for (const box of claimedBoxes) {
        await projectAssignee(env.fs, box, task.role, "doing");
      }
      await ackTaskEnvelope(env.fs, taskPath);
      if (options.sessionId) {
        return patchTaskEnvelope(env.fs, taskPath, {
          sessionId: options.sessionId,
          updatedAt: env.clock.now(),
        });
      }
      return loadTaskEnvelope(env.fs, taskPath);
    } catch (error) {
      for (const item of previous) {
        await restoreProjection(env.fs, item.box, item.owner, item.status, item.acceptedBy);
      }
      throw error;
    }
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
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    if (task.state !== "running") {
      throw new TaskLifecycleError(
        "INVALID_TRANSITION",
        `task.deliver requires state=running (got ${task.state}).`
      );
    }
    const boxId = primaryBoxId(task);
    if (!boxId) throw new Error("task.deliver requires a non-root box claim.");

    // At most one ready delivery at a time.
    const existing = await loadDeliveries(env.fs, { taskId: task.id || taskPath });
    if (existing.some((d) => d.status === "ready")) {
      throw new Error("A delivery is already ready for review; accept or reject it first.");
    }

    const policy: DeliveryPolicy = task.deliveryPolicy ?? "manual";
    const routing = resolveDeliverRouting(policy, options.decision);

    const taskId = task.id || taskPath;
    // Auto-integrate must run before any accepted/done/occupation release write.
    // Failure keeps task running and does not leave a ready delivery behind.
    if (routing.autoIntegrate) {
      const pendingCommits = [...new Set((options.commits ?? []).map((c) => c.trim()).filter(Boolean))];
      if (pendingCommits.length > 0) {
        if (!options.integrate) {
          throw new Error("Auto-integrate path requires integrate() when commits are present.");
        }
        await options.integrate(pendingCommits);
      }

      const delivery = await createDeliveryUnlocked(env.fs, env.clock, {
        taskId,
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

      const tent = await loadTent(env.fs);
      const box = requireBoxById(tent, boxId);
      await projectAssignee(env.fs, box, undefined, "done", "service");

      const next = await patchTaskEnvelope(env.fs, taskPath, {
        state: "accepted",
        activeDeliveryId: delivery.id,
        wait: null,
        updatedAt: env.clock.now(),
      });
      return { task: next, delivery, autoIntegrated: true };
    }

    const delivery = await createDeliveryUnlocked(env.fs, env.clock, {
      taskId,
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
    return { task: next, delivery, autoIntegrated: false };
  });
}

export async function taskAccept(
  env: OpsEnv,
  taskPath: string,
  options: TaskAcceptOptions
): Promise<{ task: TaskEnvelope; delivery: DeliveryRecord }> {
  return withMutation(env.fs, async () => {
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

    const commits = options.commits ?? delivery.commits;
    if (commits.length > 0) {
      if (!options.integrate) throw new Error("Delivery contains commits; workspace integration is required.");
      await options.integrate(commits);
    }

    delivery.status = "accepted";
    delivery.integrationMode = "manual-accept";
    delivery.review = { by: options.actor, decision: "accept" };
    delivery.updatedAt = env.clock.now();
    await writeDelivery(env.fs, delivery);

    const tent = await loadTent(env.fs);
    const box = requireBoxById(tent, delivery.boxId);
    await projectAssignee(env.fs, box, undefined, "done", options.actor);

    const next = await patchTaskEnvelope(env.fs, taskPath, {
      state: "accepted",
      wait: null,
      updatedAt: env.clock.now(),
    });
    return { task: next, delivery };
  });
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

    if (!resume) {
      const tent = await loadTent(env.fs);
      const box = requireBoxById(tent, delivery.boxId);
      await projectAssignee(env.fs, box, undefined, "todo");
    }

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

    const tent = await loadTent(env.fs);
    for (const claimId of task.claims) {
      if (claimId === "root") continue;
      const box = tent.byId.get(claimId);
      if (!box) continue;
      await projectAssignee(env.fs, box, undefined, "todo");
      await removeNonAcceptedDeliveriesForBox(env.fs, box.id);
    }

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
 * Releases box occupation (owner/assignee + service-owned doing → todo) so the same
 * box can be re-dispatched without manual frontmatter edits or docs.fork.
 * Idempotent when already failed (no second occupation release error).
 */
export async function taskFail(
  env: OpsEnv,
  taskPath: string,
  options: TaskFailOptions = {}
): Promise<TaskEnvelope> {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    if (task.state === "failed") {
      // Already terminal non-active — ensure occupation is cleared (repair path).
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

async function releaseOccupationForTask(env: OpsEnv, task: TaskEnvelope): Promise<void> {
  const tent = await loadTent(env.fs);
  for (const claimId of task.claims) {
    if (claimId === "root") continue;
    const box = tent.byId.get(claimId);
    if (!box) continue;
    await projectAssignee(env.fs, box, undefined, "todo");
    await removeNonAcceptedDeliveriesForBox(env.fs, box.id);
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

async function projectAssignee(
  fs: FsAdapter,
  box: Box,
  owner: string | undefined,
  status?: Box["fm"]["status"],
  acceptedBy?: string
): Promise<void> {
  const patch: Record<string, unknown> = { owner: owner ?? undefined };
  if (owner) patch.acceptedBy = undefined;
  else if (acceptedBy) patch.acceptedBy = acceptedBy;
  if (status) patch.status = status;
  await patchFrontmatter(fs, box, patch);
}

async function restoreProjection(
  fs: FsAdapter,
  box: Box,
  owner: string | undefined,
  status: Box["fm"]["status"] | undefined,
  acceptedBy: unknown
): Promise<void> {
  await patchFrontmatter(fs, box, {
    owner: owner ?? undefined,
    status: status ?? undefined,
    acceptedBy: acceptedBy ?? undefined,
  });
}

async function patchFrontmatter(fs: FsAdapter, box: Box, patch: Record<string, unknown>): Promise<void> {
  const boxFile = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete data[k];
    else data[k] = v;
  }
  const order = [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...keyOrder.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key)),
  ];
  await fs.writeFile(boxFile, serializeFrontmatter(data, body, order));
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

