/**
 * Production collectors for contextGeneration + Session reuse facts (cx-5q6za6).
 * Core owns pure digests/gates; Service loads workspace/skill/role/profile facts here.
 */
import * as nodePath from "node:path";
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
  sessionRecordToReuseCompatibilityFacts,
  skillsCompatibilityDigest,
  skillBodyCompatibilityDigest,
  TaskContextCardError,
  type SessionReuseCompatibilityFacts,
  type SessionReuseEvaluation,
  type SessionReuseRuntimeGates,
  type TaskContextCardV1,
} from "../core/task-context-card.js";
import { loadDeliveries } from "../core/delivery.js";
import { isDeliveryId, isTaskId, type AssigneeKind } from "../core/task-model.js";
// isDeliveryId / isTaskId: durable id shape checks before workspace lookup.
import {
  loadTaskEnvelope,
  loadTaskEnvelopes,
  taskAssigneeKind,
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
  skillsDigest: string;
  purpose: string;
  profileId: string;
  adapterId: string;
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
  });

  const skillsDigest = skillsCompatibilityDigest([
    ...(input.assigneeKind === "role" ? [BUILTIN_TENT_ROLE_SKILL] : []),
    BUILTIN_TENT_TASK_SKILL,
  ]);

  return {
    contextGeneration,
    agentsPointerDigest,
    tentRoleDigest,
    tentRoleVersion,
    tentTaskDigest,
    tentTaskVersion,
    rolePrompt,
    rosterAgentIds,
    skillsDigest,
    purpose,
    profileId: input.profileId,
    adapterId: input.adapterId,
    agentId,
    parentRoleId: input.parentRoleId?.trim() || "",
    assigneeKind: input.assigneeKind,
  };
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
 * Runtime gates for Session reuse (Service probe + stores).
 */
export async function collectSessionReuseRuntimeGates(input: {
  previousTurnSettled: boolean;
  exclusiveLease: boolean;
  noPendingInput: boolean;
  noPendingDelivery: boolean;
}): Promise<SessionReuseRuntimeGates> {
  return {
    previousTurnSettled: input.previousTurnSettled,
    exclusiveLease: input.exclusiveLease,
    noPendingInput: input.noPendingInput,
    noPendingDelivery: input.noPendingDelivery,
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

/**
 * Normalize path comparison for worktree / cwd (Windows-safe).
 */
export function sameWorkspacePath(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  const na = nodePath.resolve(a).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const nb = nodePath.resolve(b).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return na === nb;
}

export function taskPurposeFromEnvelope(task: TaskEnvelope): string {
  // No first-class purpose field on Task yet — empty keeps gate optional-match.
  void taskAssigneeKind;
  return managedSessionPurpose({});
}
