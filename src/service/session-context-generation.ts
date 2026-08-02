/**
 * Production collector for Session contextGeneration.
 * Service loads workspace/Skill/Role/immutable-route facts here.
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
  skillBodyCompatibilityDigest,
  TaskContextCardError,
  type TaskContextCardV1,
} from "../core/task-context-card.js";
import type { SettingsRouteSnapshot } from "../runtime/types.js";
import {
  calculateSettingsRouteLaunchDigest,
  routeConfigFromSnapshot,
} from "../runtime/route-config.js";
import { loadDeliveries } from "../core/delivery.js";
import { isDeliveryId, isTaskId, type AssigneeKind } from "../core/task-model.js";
// isDeliveryId / isTaskId: durable id shape checks before workspace lookup.
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

export type StableContextGenerationBundle = {
  contextGeneration: string;
  agentsPointerDigest: string;
  tentRoleDigest: string;
  tentRoleVersion: string;
  tentTaskDigest: string;
  tentTaskVersion: string;
  rolePrompt: string;
  /** Immutable, non-secret launch snapshot digest. */
  routeLaunchDigest: string;
};

export type CollectStableContextGenerationInput = {
  workspaceRoot: string;
  /** Mounted workspace id when available; else absolute root. */
  workspaceIdentity: string;
  packageRoot: string;
  packageVersion?: string;
  assigneeKind: AssigneeKind;
  /** Exact persisted Task assignee id (Role name or Settings route id). */
  assigneeId: string;
  /** Immutable non-secret launch facts used by this managed Session. */
  routeSnapshot: SettingsRouteSnapshot;
  roleFs?: FsAdapter;
  /** Optional preloaded Role definition (avoids double load). */
  role?: RoleDefinition;
  capabilityFlags?: readonly string[];
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
 * User-direct route Tasks with no parent Role do not invent Role facts.
 */
export async function collectStableContextGeneration(
  input: CollectStableContextGenerationInput
): Promise<StableContextGenerationBundle> {
  const agents = await loadWorkspaceAgents(input.workspaceRoot);
  const agentsPointerDigest = agentsBodyCompatibilityDigest(agents.content);

  const assigneeId = input.assigneeId.trim();
  if (!assigneeId) {
    throw new Error("contextGeneration requires a non-empty Task assigneeId");
  }
  const routeId = input.routeSnapshot.routeId.trim();
  const provider = input.routeSnapshot.provider.trim();
  const adapterId = input.routeSnapshot.adapterId.trim();
  const routeLaunchDigest = routeLaunchDigestFromSnapshot(input.routeSnapshot);
  if (!routeId || !provider || !adapterId || !routeLaunchDigest) {
    throw new Error(
      "contextGeneration requires a complete immutable Settings route snapshot"
    );
  }
  if (input.assigneeKind === "route" && assigneeId !== routeId) {
    throw new Error(
      `contextGeneration route assignee ${assigneeId} does not match snapshot route ${routeId}`
    );
  }

  // Role facts belong only to a durable Role assignee. A route executor receives
  // Task/Node context, never the parent Role's private operating prompt.
  const responsibilityRoleId =
    input.assigneeKind === "role"
      ? assigneeId
      : "";
  let role = input.role;
  if (responsibilityRoleId && !role) {
    role = await requireResolvedRoleFromRegistry(
      input.roleFs,
      responsibilityRoleId,
      "durable Role assignee"
    );
  }
  if (role && responsibilityRoleId) {
    const resolvedRoleName = role.name.trim();
    const resolvedRoleId = role.id?.trim() || "";
    if (
      resolvedRoleName !== responsibilityRoleId &&
      resolvedRoleId !== responsibilityRoleId
    ) {
      throw new Error(
        `contextGeneration Role fact mismatch: expected ${responsibilityRoleId}, got ${resolvedRoleId || resolvedRoleName}`
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

  // Every managed Task receives tent-task. A route executor is not a second Role,
  // so tent-role is included only for an actual Role assignee.
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

  const rolePrompt = responsibilityRoleId ? role?.prompt?.trim() || "" : "";
  const contextGeneration = computeContextGenerationFromStableFacts({
    workspaceIdentity: input.workspaceIdentity,
    agentsBody: agents.content,
    agentsPointerDigest,
    tentRoleBody: input.assigneeKind === "role" ? tentRoleBody : undefined,
    tentRoleVersion: input.assigneeKind === "role" ? tentRoleVersion : undefined,
    tentTaskBody,
    tentTaskVersion,
    rolePrompt: responsibilityRoleId ? rolePrompt : undefined,
    routeId,
    adapterId,
    capabilityFlags: input.capabilityFlags,
    routeLaunchDigest,
  });

  return {
    contextGeneration,
    agentsPointerDigest,
    tentRoleDigest,
    tentRoleVersion,
    tentTaskDigest,
    tentTaskVersion,
    rolePrompt,
    routeLaunchDigest,
  };
}

/**
 * Read the canonical runtime launch digest from an immutable machine-local snapshot.
 * The runtime digest covers provider, adapter, launch topology, credential references,
 * and the hashed effective endpoint without exposing secret or raw environment values.
 */
export function routeLaunchDigestFromSnapshot(
  route: SettingsRouteSnapshot
): string {
  const digest = route.launchDigest.trim();
  if (!digest) {
    throw new Error("Settings route snapshot is missing launchDigest");
  }
  const expected = calculateSettingsRouteLaunchDigest(
    routeConfigFromSnapshot(route),
    route.effectiveEndpointDigest
  );
  if (digest !== expected) {
    throw new Error(
      `Settings route snapshot launchDigest mismatch for route ${route.routeId}`
    );
  }
  return digest;
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
