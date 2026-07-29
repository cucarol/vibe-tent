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
import { loadDeliveries } from "../core/delivery.js";
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
  rosterAgentIds: string[];
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
 * Collect real stable compatibility facts and compute contextGeneration.
 * Excludes taskId / objective / acceptance / Task delta.
 */
export async function collectStableContextGeneration(
  input: CollectStableContextGenerationInput
): Promise<StableContextGenerationBundle> {
  const agents = await loadWorkspaceAgents(input.workspaceRoot);
  const agentsPointerDigest = agentsBodyCompatibilityDigest(agents.content);

  let role = input.role;
  if (
    !role &&
    input.assigneeKind === "role" &&
    input.assigneeLabel &&
    input.roleFs
  ) {
    try {
      const registry = await loadRolesRegistry(input.roleFs);
      role = resolveRole(registry.roles, input.assigneeLabel);
    } catch {
      role = undefined;
    }
  }
  // For agentProfile under a parent Role, roster/prompt come from parent Role when provided.
  if (
    !role &&
    input.parentRoleId &&
    input.roleFs &&
    input.assigneeKind === "agentProfile"
  ) {
    try {
      const registry = await loadRolesRegistry(input.roleFs);
      role = resolveRole(registry.roles, input.parentRoleId);
    } catch {
      role = undefined;
    }
  }

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
  const rosterAgentIds =
    input.assigneeKind === "role"
      ? skillInputs.roster
      : [...(role?.roster ?? [])]
          .map((s) => s.trim())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));

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
    rosterAgentIds: input.assigneeKind === "role" ? rosterAgentIds : undefined,
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
    rosterAgentIds,
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
 * Whether a Task lifecycle is safely settled for cross-Task Session reuse.
 * Terminal accepted/rejected/interrupted/failed only — not running/waiting/delivered/queued.
 */
export function isTaskLifecycleSafelySettledForReuse(task: TaskEnvelope): boolean {
  const state = task.state;
  return (
    state === "accepted" ||
    state === "rejected" ||
    state === "interrupted" ||
    state === "failed"
  );
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
 * - every other bound Task is lifecycle-settled (accepted/…);
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
   * Defaults to activeDeliveryId presence + state===delivered.
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

  // Cross-Task: every other bound Task must be fully lifecycle-settled
  // (accepted/rejected/interrupted/failed). Active states already covered above;
  // this also rejects odd non-terminal leftovers.
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
        : Boolean(prior.activeDeliveryId) || prior.state === "delivered";
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
        : Boolean(requestTask.activeDeliveryId) || requestTask.state === "delivered";
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
