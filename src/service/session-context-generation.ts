/**
 * Production collector for Session contextGeneration.
 * Service loads workspace/Node/Skill/Role/immutable-Connection facts here.
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
  canonicalJson,
  computeContextGenerationFromStableFacts,
  sha256Hex,
  skillBodyCompatibilityDigest,
  TaskContextCardError,
  type TaskContextCardV1,
} from "../core/task-context-card.js";
import type { AgentConnectionSnapshot, SessionRecord } from "../runtime/types.js";
import {
  calculateAgentConnectionLaunchDigest,
  connectionConfigFromSnapshot,
} from "../runtime/agent-connection.js";
import { loadDeliveries } from "../core/delivery.js";
import { isDeliveryId, isTaskId } from "../core/task-model.js";
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
  /** Current exact referenced-Node facts, ordered as persisted on the Task. */
  nodeContextDigest: string;
  /** Immutable, non-secret launch snapshot digest. */
  connectionLaunchDigest: string;
};

export type CollectStableContextGenerationInput = {
  workspaceRoot: string;
  /** Mounted workspace id when available; else absolute root. */
  workspaceIdentity: string;
  packageRoot: string;
  packageVersion?: string;
  /** Exact durable Task facts. Managed collection requires its bound Session. */
  task: Pick<TaskEnvelope, "roleId" | "sessionId" | "contextCard">;
  /**
   * Exact machine-local Session row. Connection facts are read only from this
   * row's immutable non-secret snapshot; live Settings never reinterpret it.
   */
  session: Pick<SessionRecord, "id" | "connectionSnapshot">;
  /** Mounted Tent system filesystem for exact Role and referenced-Node facts. */
  fs: FsAdapter;
  capabilityFlags?: readonly string[];
};

/**
 * Resolve a required Role from the workspace registry.
 * Fail loud on registry read/parse failure or missing exact Role id —
 * never invent an empty Role prompt fallback for a required Role.
 */
async function requireResolvedRoleFromRegistry(
  fs: FsAdapter,
  roleId: string,
  reason: string
): Promise<RoleDefinition> {
  const key = roleId.trim();
  if (!key) {
    throw new Error(
      `contextGeneration requires a non-empty Role id (${reason})`
    );
  }
  let registry: Awaited<ReturnType<typeof loadRolesRegistry>>;
  try {
    registry = await loadRolesRegistry(fs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `contextGeneration cannot load roles registry for Role "${key}" (${reason}): ${message}`
    );
  }
  const role = registry.roles.find((candidate) => candidate.id === key);
  if (!role) {
    throw new Error(
      `contextGeneration required Role not found: "${key}" (${reason})`
    );
  }
  return role;
}

async function collectReferencedNodeDigest(
  fs: FsAdapter,
  task: Pick<TaskEnvelope, "contextCard">
): Promise<string> {
  const tent = await loadTent(fs);
  const rows = task.contextCard.refs.nodes.map((ref) => {
    const node = tent.byId.get(ref.id);
    if (!node) {
      throw new Error(
        `contextGeneration referenced Node not found: ${ref.id}`
      );
    }
    return {
      id: node.id,
      path: node.path,
      type: node.type,
      tags: node.tags,
      mode: node.mode,
      relations: node.relations,
      frontmatter: node.fm,
      body: node.body,
      pointer: {
        path: ref.path?.trim() || "",
        revision: ref.revision?.trim() || "",
      },
    };
  });
  return sha256Hex(canonicalJson(rows));
}

/**
 * Collect real stable compatibility facts and compute contextGeneration.
 * Excludes taskId / objective / acceptance / Task delta.
 *
 * Collector failures (binding mismatch, missing required Role/Node, unreadable
 * registry, missing built-in Skill body) throw — never yield reusable fallback
 * facts. A temporary Session Task with no roleId does not invent Role facts.
 */
export async function collectStableContextGeneration(
  input: CollectStableContextGenerationInput
): Promise<StableContextGenerationBundle> {
  const agents = await loadWorkspaceAgents(input.workspaceRoot);
  const agentsPointerDigest = agentsBodyCompatibilityDigest(agents.content);

  const taskSessionId = input.task.sessionId?.trim() || "";
  const sessionId = input.session.id.trim();
  if (!taskSessionId || taskSessionId !== sessionId) {
    throw new Error(
      `contextGeneration requires exact Task/Session binding: Task ${taskSessionId || "<none>"}, Session ${sessionId || "<none>"}`
    );
  }
  const connectionSnapshot = input.session.connectionSnapshot;
  if (!connectionSnapshot) {
    throw new Error(
      `contextGeneration requires immutable Connection snapshot on Session ${sessionId}`
    );
  }
  const connectionId = connectionSnapshot.connectionId.trim();
  const provider = connectionSnapshot.provider.trim();
  const adapterId = connectionSnapshot.adapterId.trim();
  const connectionLaunchDigest = connectionLaunchDigestFromSnapshot(connectionSnapshot);
  if (!connectionId || !provider || !adapterId || !connectionLaunchDigest) {
    throw new Error(
      "contextGeneration requires a complete immutable Agent Connection snapshot"
    );
  }

  // Role facts belong only to an exact durable Task.roleId. A temporary Session
  // receives Task/Node context, never a parent/reviewer Role's private prompt.
  const roleId = input.task.roleId?.trim() || "";
  const role = roleId
    ? await requireResolvedRoleFromRegistry(
        input.fs,
        roleId,
        "durable Role responsibility"
      )
    : undefined;
  const nodeContextDigest = await collectReferencedNodeDigest(
    input.fs,
    input.task
  );

  // Skill body/version reads fail loud when required built-in SKILL.md is missing.
  const skillInputs = managedSkillCompatibilityInputs({
    packageRoot: input.packageRoot,
    roleId: roleId || undefined,
    role,
    packageVersion: input.packageVersion,
  });

  // Every managed Task receives tent-task. A temporary Session is not a second Role,
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
  if (roleId) {
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

  const rolePrompt = roleId ? role?.prompt?.trim() || "" : "";
  const contextGeneration = computeContextGenerationFromStableFacts({
    workspaceIdentity: input.workspaceIdentity,
    agentsBody: agents.content,
    agentsPointerDigest,
    tentRoleBody: roleId ? tentRoleBody : undefined,
    tentRoleVersion: roleId ? tentRoleVersion : undefined,
    tentTaskBody,
    tentTaskVersion,
    rolePrompt: roleId ? rolePrompt : undefined,
    connectionId,
    adapterId,
    roleId: roleId || undefined,
    capabilityFlags: input.capabilityFlags,
    connectionLaunchDigest,
    extraStable: { nodeContextDigest },
  });

  return {
    contextGeneration,
    agentsPointerDigest,
    tentRoleDigest,
    tentRoleVersion,
    tentTaskDigest,
    tentTaskVersion,
    rolePrompt,
    nodeContextDigest,
    connectionLaunchDigest,
  };
}

/**
 * Read the canonical runtime launch digest from an immutable machine-local snapshot.
 * The runtime digest covers provider, adapter, launch topology, credential references,
 * and the hashed effective endpoint without exposing secret or raw environment values.
 */
export function connectionLaunchDigestFromSnapshot(
  connection: AgentConnectionSnapshot
): string {
  const digest = connection.launchDigest.trim();
  if (!digest) {
    throw new Error("Agent Connection snapshot is missing launchDigest");
  }
  const expected = calculateAgentConnectionLaunchDigest(
    connectionConfigFromSnapshot(connection),
    connection.effectiveEndpointDigest
  );
  if (digest !== expected) {
    throw new Error(
      `Agent Connection snapshot launchDigest mismatch for ${connection.connectionId}`
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
