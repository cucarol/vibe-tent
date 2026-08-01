/**
 * Production collectors for contextGeneration + Session reuse facts (cx-5q6za6).
 * Core owns pure digests/gates; Service loads workspace/skill/role/profile facts here.
 */
import type { FsAdapter } from "../core/adapter.js";
import {
  BUILTIN_TENT_ROLE_SKILL,
  BUILTIN_TENT_TASK_SKILL,
  managedSkillCompatibilityInputs,
  readBundledSkillBody,
  readBundledSkillVersion,
} from "../core/managed-skill-compose.js";
import {
  agentsBodyCompatibilityDigest,
  assertRefsResolved,
  computeContextGenerationFromStableFacts,
  evaluateSessionReuseCompatibility,
  managedSessionPurpose,
  profileLaunchCompatibilityDigest,
  sessionRecordToReuseCompatibilityFacts,
  skillBodyCompatibilityDigest,
  skillSetCompatibilityDigest,
  TaskContextCardError,
  type SessionReuseCompatibilityFacts,
  type SessionReuseEvaluation,
  type SessionReuseRuntimeGates,
  type TaskContextCardV1,
} from "../core/task-context-card.js";
import type { AgentProfileConfig } from "../runtime/types.js";
import { loadDeliveries, type DeliveryRecord } from "../core/delivery.js";
import { isDeliveryId, isTaskId, type AssigneeKind } from "../core/task-model.js";
// isDeliveryId / isTaskId: durable id shape checks before workspace lookup.
import { envelopeIsActiveOccupation } from "../core/claim.js";
import {
  loadTaskEnvelope,
  loadTaskEnvelopes,
  type TaskEnvelope,
} from "../core/task.js";
import { loadTent } from "../core/tree.js";
import { loadWorkspaceAgents } from "../core/workspace-agents.js";
import {
  loadRolesRegistry,
  resolveRole,
  type RoleDefinition,
} from "../core/skillRoleRegistry.js";
import type { SessionRecord } from "../runtime/types.js";

export type StableContextGenerationBundle = {
  contextGeneration: string;
  agentsPointerDigest: string;
  tentRoleDigest: string;
  tentRoleVersion: string;
  tentTaskDigest: string;
  tentTaskVersion: string;
  rolePrompt: string;
  /**
   * Skill-set compatibility digest (name + body/version).
   * Session row field remains `skillsDigest` for wire compatibility.
   */
  skillsDigest: string;
  /** Alias of skillsDigest — body/version aware skill-set digest. */
  skillSetDigest: string;
  purpose: string;
  profileId: string;
  adapterId: string;
  /** Non-secret launch snapshot (same profileId edited in place). */
  profileLaunchDigest: string;
  agentId: string;
  parentRoleId: string;
  assigneeKind: AssigneeKind;
};

export type CollectStableContextGenerationInput = {
  workspaceRoot: string;
  /** Mounted workspace id when available; else absolute root. */
  workspaceIdentity: string;
  packageRoot: string;
  packageVersion?: string;
  assigneeKind: AssigneeKind;
  /** Role name or profileId assignee label. */
  assigneeLabel: string;
  agentId?: string;
  profileId: string;
  adapterId: string;
  purpose?: string;
  subKey?: string;
  /** Parent Role operational id when parent is a Role. */
  parentRoleId?: string;
  roleFs?: FsAdapter;
  /** Optional preloaded Role definition (avoids double load). */
  role?: RoleDefinition;
  capabilityFlags?: readonly string[];
  /**
   * Full machine-local profile for launch compatibility digest.
   * Required for honest same-profileId edit detection (never secret values).
   */
  profile?: AgentProfileConfig;
};

/**
 * Resolve a required Role from the workspace registry.
 * Fail loud on missing roleFs, registry read/parse failure, or missing named Role —
 * never invent an empty Role prompt fallback for a required Role.
 */
async function requireResolvedRoleFromRegistry(
  roleFs: FsAdapter | undefined,
  roleName: string,
  reason: string
): Promise<RoleDefinition> {
  const key = roleName.trim();
  if (!key) {
    throw new Error(
      `contextGeneration requires a non-empty Role name (${reason})`
    );
  }
  if (!roleFs) {
    throw new Error(
      `contextGeneration requires Role "${key}" (${reason}) but roleFs was not provided`
    );
  }
  let registry: Awaited<ReturnType<typeof loadRolesRegistry>>;
  try {
    registry = await loadRolesRegistry(roleFs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `contextGeneration cannot load roles registry for Role "${key}" (${reason}): ${message}`
    );
  }
  const role = resolveRole(registry.roles, key);
  if (!role) {
    throw new Error(
      `contextGeneration required Role not found: "${key}" (${reason})`
    );
  }
  return role;
}

/**
 * Collect real stable compatibility facts and compute contextGeneration.
 * Excludes taskId / objective / acceptance / Task delta.
 *
 * Collector failures (missing required Role, unreadable registry, missing built-in
 * Skill body) throw — never yield reusable empty/fallback facts.
 * User-direct agentProfile with no parentRoleId does not require Role resolution.
 */
export async function collectStableContextGeneration(
  input: CollectStableContextGenerationInput
): Promise<StableContextGenerationBundle> {
  const agents = await loadWorkspaceAgents(input.workspaceRoot);
  const agentsPointerDigest = agentsBodyCompatibilityDigest(agents.content);

  let role = input.role;
  if (input.assigneeKind === "role") {
    // Durable Role assignee: Role definition is required for real generation facts.
    if (!role) {
      role = await requireResolvedRoleFromRegistry(
        input.roleFs,
        input.assigneeLabel,
        "durable Role assignee"
      );
    }
  } else if (
    input.assigneeKind === "agentProfile" &&
    input.parentRoleId?.trim()
  ) {
    // Parent-Role-bound agentProfile: parent Role must resolve (no empty fallback).
    // User-direct one-shot agentProfile without parentRoleId skips Role resolution.
    if (!role) {
      role = await requireResolvedRoleFromRegistry(
        input.roleFs,
        input.parentRoleId,
        "parent Role for agentProfile"
      );
    }
  }

  // Skill body/version reads fail loud when required built-in SKILL.md is missing.
  const skillInputs = managedSkillCompatibilityInputs({
    packageRoot: input.packageRoot,
    assigneeKind: input.assigneeKind,
    role: input.assigneeKind === "role" ? role : undefined,
    packageVersion: input.packageVersion,
  });

  // Always digest tent-task (every managed Task). tent-role when durable Role assignee
  // or when parent Role skill contracts apply to the executor kind.
  const tentTaskBody =
    skillInputs.skillBodies[BUILTIN_TENT_TASK_SKILL] ??
    readBundledSkillBody(input.packageRoot, BUILTIN_TENT_TASK_SKILL);
  const tentTaskVersion =
    skillInputs.skillVersions[BUILTIN_TENT_TASK_SKILL] ??
    readBundledSkillVersion(
      input.packageRoot,
      BUILTIN_TENT_TASK_SKILL,
      input.packageVersion
    );
  const tentTaskDigest = skillBodyCompatibilityDigest({
    body: tentTaskBody,
    version: tentTaskVersion,
    name: BUILTIN_TENT_TASK_SKILL,
  });

  let tentRoleBody = "";
  let tentRoleVersion = "";
  let tentRoleDigest = "";
  if (input.assigneeKind === "role") {
    tentRoleBody =
      skillInputs.skillBodies[BUILTIN_TENT_ROLE_SKILL] ??
      readBundledSkillBody(input.packageRoot, BUILTIN_TENT_ROLE_SKILL);
    tentRoleVersion =
      skillInputs.skillVersions[BUILTIN_TENT_ROLE_SKILL] ??
      readBundledSkillVersion(
        input.packageRoot,
        BUILTIN_TENT_ROLE_SKILL,
        input.packageVersion
      );
    tentRoleDigest = skillBodyCompatibilityDigest({
      body: tentRoleBody,
      version: tentRoleVersion,
      name: BUILTIN_TENT_ROLE_SKILL,
    });
  }

  const rolePrompt =
    input.assigneeKind === "role" ? skillInputs.rolePrompt : role?.prompt?.trim() || "";
  const purpose = managedSessionPurpose({
    purpose: input.purpose,
    subKey: input.subKey,
  });
  const agentId =
    input.agentId?.trim() ||
    (input.assigneeKind === "agentProfile" ? input.assigneeLabel : input.assigneeLabel);

  const profileLaunchDigest = input.profile
    ? profileLaunchCompatibilityDigestFromConfig(input.profile)
    : profileLaunchCompatibilityDigest({
        profileId: input.profileId,
        adapterId: input.adapterId,
        capabilityFlags: input.capabilityFlags,
      });

  const contextGeneration = computeContextGenerationFromStableFacts({
    workspaceIdentity: input.workspaceIdentity,
    agentsBody: agents.content,
    agentsPointerDigest,
    tentRoleBody: input.assigneeKind === "role" ? tentRoleBody : undefined,
    tentRoleVersion: input.assigneeKind === "role" ? tentRoleVersion : undefined,
    tentTaskBody,
    tentTaskVersion,
    rolePrompt: input.assigneeKind === "role" ? rolePrompt : undefined,
    profileId: input.profileId,
    adapterId: input.adapterId,
    purpose,
    agentId,
    assigneeKind: input.assigneeKind,
    capabilityFlags: input.capabilityFlags,
    profileLaunchDigest,
  });

  // Body+version aware skill-set digest (not names-only).
  const skillSetRows: { name: string; bodyDigest: string; version?: string }[] = [
    {
      name: BUILTIN_TENT_TASK_SKILL,
      bodyDigest: tentTaskDigest,
      version: tentTaskVersion,
    },
  ];
  if (input.assigneeKind === "role" && tentRoleDigest) {
    skillSetRows.push({
      name: BUILTIN_TENT_ROLE_SKILL,
      bodyDigest: tentRoleDigest,
      version: tentRoleVersion,
    });
  }
  const skillSetDigest = skillSetCompatibilityDigest(skillSetRows);

  return {
    contextGeneration,
    agentsPointerDigest,
    tentRoleDigest,
    tentRoleVersion,
    tentTaskDigest,
    tentTaskVersion,
    rolePrompt,
    skillsDigest: skillSetDigest,
    skillSetDigest,
    purpose,
    profileId: input.profileId,
    adapterId: input.adapterId,
    profileLaunchDigest,
    agentId,
    parentRoleId: input.parentRoleId?.trim() || "",
    assigneeKind: input.assigneeKind,
  };
}

/**
 * Build launch compatibility digest from a machine-local profile (no secrets).
 * Passes the full non-secret ACP/MCP/Skill launch snapshot into
 * {@link profileLaunchCompatibilityDigest} so in-place edits to model,
 * baseUrlEnvKey, MCP credentialRef/env-key mappings, etc. flip the digest.
 */
export function profileLaunchCompatibilityDigestFromConfig(
  profile: AgentProfileConfig
): string {
  return profileLaunchCompatibilityDigest({
    profileId: profile.id,
    adapterId: profile.adapterId,
    command: profile.command,
    args: profile.args,
    // Profile env: key names only — never values (may hold non-secret config, but
    // secret-shaped values must never enter the digest).
    envKeyNames: Object.keys(profile.env ?? {}),
    acp: profile.acp
      ? {
          executable: profile.acp.executable,
          model: profile.acp.model,
          envKey: profile.acp.envKey,
          credentialRef: profile.acp.credentialRef,
          baseUrlEnvKey: profile.acp.baseUrlEnvKey,
          baseUrl: profile.acp.baseUrl,
          permissionPolicy: profile.acp.permissionPolicy,
          promptTimeoutMs: profile.acp.promptTimeoutMs,
          permissionTimeoutMs: profile.acp.permissionTimeoutMs,
        }
      : undefined,
    fake: profile.fake
      ? {
          canResume: profile.fake.canResume,
          failLaunch: profile.fake.failLaunch,
          waitForSignal: profile.fake.waitForSignal,
        }
      : undefined,
    skills: (profile.skills ?? [])
      .filter((s) => s && s.enabled !== false && s.name?.trim())
      .map((s) => ({
        name: s.name,
        path: s.path,
      })),
    mcpServers: (profile.mcpServers ?? [])
      .filter((m) => m && m.enabled !== false && m.name?.trim())
      .map((m) => ({
        name: m.name,
        transport: m.transport,
        command: m.command,
        args: m.args,
        url: m.url,
        // Mapping values are process env *key names* or credentialRef *ids* —
        // hashed fully (keys + values), never resolved secret plaintext.
        envKeys: m.envKeys,
        envCredentialRefs: m.envCredentialRefs,
        headerEnvKeys: m.headerEnvKeys,
        headerCredentialRefs: m.headerCredentialRefs,
      })),
  });
}

/**
 * Build reuse-gate request facts from a live Task + collected stable bundle.
 */
export function buildSessionReuseRequestFacts(input: {
  workspaceId: string;
  bundle: StableContextGenerationBundle;
  /** Prefer live recomputed generation; fall back to Task card. */
  contextGeneration: string;
  worktree?: string;
}): SessionReuseCompatibilityFacts {
  return {
    workspaceId: input.workspaceId,
    parentRoleId: input.bundle.parentRoleId,
    agentId: input.bundle.agentId,
    purpose: input.bundle.purpose,
    skillsDigest: input.bundle.skillsDigest,
    profileId: input.bundle.profileId,
    adapterId: input.bundle.adapterId,
    contextGeneration: input.contextGeneration,
    worktree: input.worktree,
  };
}

/**
 * Validate every declared durable Node/Task/Delivery ref against persisted workspace facts.
 * Fail loud (TaskContextCardError UNRESOLVED_REF) — never invent or drop.
 * git refs only require non-empty id (revision pointer).
 */
export async function assertDurableContextCardRefsResolved(
  fs: FsAdapter,
  card: TaskContextCardV1
): Promise<void> {
  let tent: Awaited<ReturnType<typeof loadTent>> | null = null;
  let tasks: TaskEnvelope[] | null = null;
  let deliveries: Awaited<ReturnType<typeof loadDeliveries>> | null = null;

  const ensureTent = async () => {
    if (!tent) tent = await loadTent(fs);
    return tent;
  };
  const ensureTasks = async () => {
    if (!tasks) tasks = await loadTaskEnvelopes(fs);
    return tasks;
  };
  const ensureDeliveries = async () => {
    if (!deliveries) deliveries = await loadDeliveries(fs);
    return deliveries;
  };

  // Pre-resolve async, then assertRefsResolved with sync predicate.
  const nodeOk = new Map<string, boolean>();
  for (const ref of card.refs.nodes) {
    const id = ref.id.trim();
    if (!id) {
      nodeOk.set(ref.id, false);
      continue;
    }
    try {
      const t = await ensureTent();
      nodeOk.set(ref.id, t.byId.has(id));
    } catch {
      nodeOk.set(ref.id, false);
    }
  }

  const taskOk = new Map<string, boolean>();
  for (const ref of card.refs.tasks) {
    const id = ref.id.trim();
    if (!id || !isTaskId(id)) {
      taskOk.set(ref.id, false);
      continue;
    }
    try {
      const all = await ensureTasks();
      const hit = all.some((t) => t.id === id);
      if (hit) {
        taskOk.set(ref.id, true);
        continue;
      }
      // Path hint: try load by path when provided.
      if (ref.path?.trim()) {
        try {
          const loaded = await loadTaskEnvelope(fs, ref.path.trim());
          taskOk.set(ref.id, loaded.id === id);
          continue;
        } catch {
          /* fall through */
        }
      }
      taskOk.set(ref.id, false);
    } catch {
      taskOk.set(ref.id, false);
    }
  }

  const deliveryOk = new Map<string, boolean>();
  for (const ref of card.refs.deliveries) {
    const id = ref.id.trim();
    if (!id || !isDeliveryId(id)) {
      deliveryOk.set(ref.id, false);
      continue;
    }
    try {
      const all = await ensureDeliveries();
      deliveryOk.set(ref.id, all.some((d) => d.id === id));
    } catch {
      deliveryOk.set(ref.id, false);
    }
  }

  try {
    assertRefsResolved(card, (bucket, ref) => {
      if (bucket === "git") return Boolean(ref.id?.trim());
      if (bucket === "nodes") return nodeOk.get(ref.id) === true;
      if (bucket === "tasks") return taskOk.get(ref.id) === true;
      if (bucket === "deliveries") return deliveryOk.get(ref.id) === true;
      return false;
    });
  } catch (err) {
    if (err instanceof TaskContextCardError) throw err;
    throw err;
  }
}

/**
 * Unresolved Delivery statuses that block Session reuse.
 * accepted/rejected are historical/resolved and do not block.
 */
const UNRESOLVED_DELIVERY_STATUSES = new Set(["ready", "draft"]);

export type TaskBlockingDeliveryEvaluation = {
  blocking: boolean;
  reason?: string;
};

/**
 * Decide whether a Task still has an unresolved Delivery that blocks Session reuse.
 *
 * Uses persisted Delivery truth — never treats Task.activeDeliveryId alone as blocking:
 * real task.accept keeps the historical pointer to the accepted Delivery.
 *
 * - task.state === "delivered" → blocking (awaiting accept)
 * - activeDeliveryId present → must resolve to a Delivery owned by this Task;
 *   missing/foreign → fail loud (never prove safety)
 * - pointed Delivery ready/draft → blocking; accepted/rejected → not blocking by itself
 * - any ready/draft Delivery for this Task → blocking (even when active pointer is historical)
 */
export function evaluateTaskBlockingDelivery(input: {
  task: Pick<TaskEnvelope, "id" | "path" | "state" | "activeDeliveryId">;
  deliveries: readonly Pick<DeliveryRecord, "id" | "taskId" | "status">[];
}): TaskBlockingDeliveryEvaluation {
  const taskId = input.task.id?.trim() || "";
  const taskPath = input.task.path?.trim() || "";
  const belongsToTask = (d: Pick<DeliveryRecord, "taskId">): boolean => {
    const dt = d.taskId?.trim() || "";
    if (!dt) return false;
    if (taskId && dt === taskId) return true;
    if (taskPath && dt === taskPath) return true;
    return false;
  };

  // Lifecycle: delivered means a ready Delivery is still awaiting accept/reject.
  if (input.task.state === "delivered") {
    return { blocking: true, reason: "task_state_delivered" };
  }

  const activeId = input.task.activeDeliveryId?.trim() || "";
  if (activeId) {
    const pointed = input.deliveries.find((d) => d.id === activeId);
    if (!pointed) {
      throw new Error(
        `Task activeDeliveryId ${activeId} does not resolve to a persisted Delivery ` +
          `(missing/foreign); cannot prove noPendingDelivery`
      );
    }
    if (!belongsToTask(pointed)) {
      throw new Error(
        `Task activeDeliveryId ${activeId} is foreign ` +
          `(delivery.taskId=${pointed.taskId}, taskId=${taskId || taskPath || "?"}); ` +
          `cannot prove noPendingDelivery`
      );
    }
    if (UNRESOLVED_DELIVERY_STATUSES.has(pointed.status)) {
      return { blocking: true, reason: "active_delivery_unresolved" };
    }
    // accepted/rejected historical pointer: not blocking by itself.
  }

  // Scan Task deliveries for any unresolved ready/draft even when the active
  // pointer is a historical accepted/rejected Delivery.
  if (taskId || taskPath) {
    const unresolved = input.deliveries.some(
      (d) => belongsToTask(d) && UNRESOLVED_DELIVERY_STATUSES.has(d.status)
    );
    if (unresolved) {
      return { blocking: true, reason: "task_has_unresolved_delivery" };
    }
  }

  return { blocking: false };
}

/**
 * Tasks that currently bind or last-bound a candidate Session.
 * Scans persisted envelopes by sessionId and by lastTaskId (id or path).
 */
export function findTasksBoundToSession(
  allTasks: readonly TaskEnvelope[],
  candidate: Pick<SessionRecord, "id" | "lastTaskId">
): TaskEnvelope[] {
  const sessionId = candidate.id?.trim() || "";
  const last = candidate.lastTaskId?.trim() || "";
  const out: TaskEnvelope[] = [];
  const seen = new Set<string>();
  for (const t of allTasks) {
    const key = t.path || t.id || "";
    if (!key || seen.has(key)) continue;
    const boundBySession =
      !!sessionId && typeof t.sessionId === "string" && t.sessionId.trim() === sessionId;
    const boundByLast =
      !!last && (t.id === last || t.path === last || t.path.endsWith(last));
    if (boundBySession || boundByLast) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function isSameTaskRef(
  task: TaskEnvelope,
  requestTaskPath: string,
  requestTaskId?: string
): boolean {
  if (task.path === requestTaskPath) return true;
  if (requestTaskId && task.id === requestTaskId) return true;
  return false;
}

/**
 * Whether a Task lifecycle is safely settled for **cross-Task** Session reuse.
 * Only `accepted` proves continuity-safe settlement.
 * rejected / interrupted / failed are terminal but must force a fresh Session
 * (even with no unresolved Delivery). Same-Task resume is handled separately
 * and does not use this helper for the request Task's own occupation.
 */
export function isTaskLifecycleSafelySettledForReuse(task: TaskEnvelope): boolean {
  return task.state === "accepted";
}

export type CandidateSessionLeaseEvaluation = SessionReuseRuntimeGates & {
  /** Diagnostic reasons (not fed to pure gate; for tests/logs). */
  reasons: string[];
  boundTasks: TaskEnvelope[];
};

/**
 * Build runtime gates for a candidate Session by scanning **bound/last Tasks**,
 * not the request Task alone (P0: exclusive lease / pending / Delivery).
 *
 * Cross-Task reuse requires:
 * - Session stopped (idle);
 * - no other active Task owns this Session (exclusive lease);
 * - prior turn settled (!turnBusy);
 * - every other bound Task is lifecycle-settled (`accepted` only);
 * - no pending TaskInput/UserAsk on any other bound Task;
 * - no ready/unresolved Delivery on any other bound Task.
 *
 * Same-Task resume: the request Task may still be running and own the Session.
 */
export async function evaluateCandidateSessionLeaseGates(input: {
  allTasks: readonly TaskEnvelope[];
  candidate: Pick<SessionRecord, "id" | "lastTaskId" | "state">;
  requestTaskPath: string;
  requestTaskId?: string;
  turnBusy: boolean;
  workspaceId: string;
  listPendingInputs: (
    workspaceId: string,
    taskPath: string
  ) => Promise<readonly unknown[]>;
  hasPendingUserAsk: (workspaceId: string, taskPath: string) => Promise<boolean>;
  /**
   * Optional Delivery probe: true when task has a ready/unresolved Delivery.
   * Prefer {@link evaluateTaskBlockingDelivery} with loaded Delivery records.
   * Default (no probe): only task.state===delivered blocks — bare activeDeliveryId
   * is a historical pointer after accept and must not block by itself.
   */
  hasBlockingDelivery?: (task: TaskEnvelope) => boolean | Promise<boolean>;
}): Promise<CandidateSessionLeaseEvaluation> {
  const reasons: string[] = [];
  const boundTasks = findTasksBoundToSession(input.allTasks, input.candidate);
  const others = boundTasks.filter(
    (t) => !isSameTaskRef(t, input.requestTaskPath, input.requestTaskId)
  );

  const sessionStopped = input.candidate.state === "stopped";
  if (!sessionStopped) reasons.push("session_not_stopped");

  const otherActive = others.filter((t) => envelopeIsActiveOccupation(t));
  if (otherActive.length > 0) {
    reasons.push("other_active_task_owns_session");
  }

  // Dual binding: more than one active envelope carries this sessionId.
  const activeWithSession = input.allTasks.filter(
    (t) =>
      envelopeIsActiveOccupation(t) &&
      typeof t.sessionId === "string" &&
      t.sessionId.trim() === input.candidate.id
  );
  const dualBind = activeWithSession.some(
    (t) => !isSameTaskRef(t, input.requestTaskPath, input.requestTaskId)
  );
  if (dualBind) reasons.push("dual_session_binding");

  // Cross-Task: every other bound Task must be accepted (only). Active states
  // already covered above; rejected/interrupted/failed force fresh Session.
  let othersSettled = true;
  for (const prior of others) {
    if (!isTaskLifecycleSafelySettledForReuse(prior)) {
      othersSettled = false;
      if (!reasons.includes("prior_task_not_settled")) {
        reasons.push("prior_task_not_settled");
      }
    }
  }

  const exclusiveLease =
    sessionStopped &&
    otherActive.length === 0 &&
    !dualBind &&
    othersSettled;

  const previousTurnSettled = input.turnBusy !== true;
  if (!previousTurnSettled) reasons.push("previous_turn_not_settled");

  let noPendingInput = true;
  let noPendingDelivery = true;

  for (const prior of others) {
    const pending = await input.listPendingInputs(input.workspaceId, prior.path);
    const ask = await input.hasPendingUserAsk(input.workspaceId, prior.path);
    if (pending.length > 0 || ask) {
      noPendingInput = false;
      reasons.push("prior_pending_input");
    }
    const blockingDelivery =
      input.hasBlockingDelivery != null
        ? await input.hasBlockingDelivery(prior)
        : prior.state === "delivered";
    if (blockingDelivery) {
      noPendingDelivery = false;
      reasons.push("prior_pending_delivery");
    }
  }

  // Request Task itself: pending input/delivery also blocks (same-Task resume safety).
  const reqPending = await input.listPendingInputs(
    input.workspaceId,
    input.requestTaskPath
  );
  const reqAsk = await input.hasPendingUserAsk(
    input.workspaceId,
    input.requestTaskPath
  );
  if (reqPending.length > 0 || reqAsk) {
    noPendingInput = false;
    reasons.push("request_pending_input");
  }
  const requestTask = input.allTasks.find((t) =>
    isSameTaskRef(t, input.requestTaskPath, input.requestTaskId)
  );
  if (requestTask) {
    const reqDel =
      input.hasBlockingDelivery != null
        ? await input.hasBlockingDelivery(requestTask)
        : requestTask.state === "delivered";
    if (reqDel) {
      noPendingDelivery = false;
      reasons.push("request_pending_delivery");
    }
  }

  return {
    previousTurnSettled,
    exclusiveLease,
    noPendingInput,
    noPendingDelivery,
    reasons,
    boundTasks,
  };
}

/**
 * Evaluate whether a candidate Session may be resumed for this request.
 * Fail closed: any mismatch → allowed=false (caller starts fresh generation).
 */
export function evaluateManagedSessionReuse(input: {
  request: SessionReuseCompatibilityFacts;
  candidate: SessionRecord;
  runtime: SessionReuseRuntimeGates;
}): SessionReuseEvaluation {
  return evaluateSessionReuseCompatibility({
    request: input.request,
    candidate: sessionRecordToReuseCompatibilityFacts(input.candidate),
    runtime: input.runtime,
  });
}

/** Read optional stable purpose/subKey from Task envelope (Session reuse identity). */
function taskPurposeFromEnvelope(
  task: Pick<TaskEnvelope, "purpose"> | { purpose?: string }
): string {
  return managedSessionPurpose({ purpose: task.purpose });
}

/** Public thin wrapper used by Service start path. */
export function readTaskPurpose(
  task: Pick<TaskEnvelope, "purpose"> | { purpose?: string }
): string {
  return taskPurposeFromEnvelope(task);
}

/**
 * Official managed bootstrap is always Service-owned.
 * Optional public bootstrapPrompt is appended as a dynamic section only —
 * never a replacement of stable+delta (fresh or resumed).
 */
export function appendCallerBootstrapSection(
  officialManagedBootstrap: string,
  callerAppend?: string | null
): string {
  const base = officialManagedBootstrap.trimEnd();
  const append = typeof callerAppend === "string" ? callerAppend.trim() : "";
  if (!append) return base ? `${base}\n` : "";
  return `${base}\n\n--- Caller bootstrap append ---\n${append}\n`;
}
