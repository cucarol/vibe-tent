// Task Node refs (V0.2 cx-tsw53f): sole persisted source is Task.contextCard.refs.nodes[].
// Durable id is authoritative; path is a refreshable hint only.
// Canonical card types / build / parse / digests live in task-context-card.ts —
// this module owns Node-ref helpers, claims→refs one-shot migration, and
// non-exclusive occupation projection helpers. No parallel nodeRefs/sourceRefs.
// New writes never persist claims[]. Runtime never falls back to claims[].

import type { FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import {
  AGENT_PROFILES_TEMP_DIR,
  TEMP_DIR,
} from "./paths.js";
import { join } from "./tree.js";
import {
  isActiveTaskState,
  legacyStatusToState,
  parseTaskActorRef,
  resolveParentReviewerPair,
  type TaskActorRef,
  type TaskState,
} from "./task-model.js";
import {
  buildTaskContextCard,
  computeContextGeneration,
  loadTaskContextCardFromFrontmatter,
  projectAssigneeFromTask,
  serializeTaskContextCardForFrontmatter,
  type TaskContextCardRef,
  type TaskContextCardV1,
} from "./task-context-card.js";

/** Re-export canonical Node ref shape (TaskContextCardRef). */
export type TaskNodeRef = TaskContextCardRef;

/**
 * Fields needed to resolve Node refs without importing TaskEnvelope (avoids cycles).
 * Runtime occupation / collaboration reads **only** contextCard.refs.nodes.
 * `claims` is never consulted here — one-shot migrator only.
 */
export type TaskNodeRefSource = {
  path?: string;
  id?: string;
  createdAt?: string;
  state?: string;
  status?: string;
  /** Full Context Card when loaded; Node refs are refs.nodes only. */
  contextCard?: Pick<TaskContextCardV1, "refs"> | TaskContextCardV1;
};

/** Legacy claim token for workspace-wide context (not a Node id). Migrator-only. */
const WORKSPACE_ROOT_CLAIM = "root";

function isWorkspaceRootClaim(id: string): boolean {
  return id.trim() === WORKSPACE_ROOT_CLAIM;
}

/** Normalize a single node ref; empty id / fake root rejected. */
export function normalizeTaskNodeRef(raw: {
  id: string;
  path?: string;
  revision?: string;
}): TaskNodeRef {
  const id = raw.id.trim();
  if (!id) throw new Error("Task node ref id cannot be empty.");
  if (isWorkspaceRootClaim(id)) {
    throw new Error(
      'Task.contextCard.refs.nodes must not include fake "root" Node ref; workspace context is separate.'
    );
  }
  const out: TaskNodeRef = { id };
  if (typeof raw.path === "string" && raw.path.trim()) {
    out.path = raw.path.trim().replace(/\\/g, "/");
  }
  if (typeof raw.revision === "string" && raw.revision.trim()) {
    out.revision = raw.revision.trim();
  }
  return out;
}

/** Parse refs.nodes from a contextCard-like object (fail-loud on bad shape). */
export function parseTaskNodeRefs(value: unknown): TaskNodeRef[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("Task.contextCard.refs.nodes must be an array.");
  }
  const out: TaskNodeRef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Task.contextCard.refs.nodes[${i}] must be an object with id.`);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || !rec.id.trim()) {
      throw new Error(`Task.contextCard.refs.nodes[${i}].id must be a non-empty string.`);
    }
    if (isWorkspaceRootClaim(rec.id)) {
      // Skip fake root — workspace context is not a Node ref.
      continue;
    }
    const ref = normalizeTaskNodeRef({
      id: rec.id,
      path: typeof rec.path === "string" ? rec.path : undefined,
      revision: typeof rec.revision === "string" ? rec.revision : undefined,
    });
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}

/**
 * Authoritative Node ids referenced by a Task (direct only).
 * **Runtime:** only `contextCard.refs.nodes`. Never reads claims[]
 * (claims access is confined to the one-shot migrator below).
 */
export function taskReferencedNodeIds(task: TaskNodeRefSource): string[] {
  const nodes = task.contextCard?.refs?.nodes;
  if (!nodes || nodes.length === 0) return [];
  return nodes.map((n) => n.id).filter((id) => id && !isWorkspaceRootClaim(id));
}

/**
 * True when Task carries workspace-level context only (no direct Node refs).
 * Not a persisted source flag and not a Tent-wide lock — concurrent workspace
 * Tasks are legal. Derived from empty refs.nodes after migration / new writes.
 */
export function taskHasWorkspaceContext(task: TaskNodeRefSource): boolean {
  return taskReferencedNodeIds(task).length === 0;
}

/** True when Task directly references this Node id (not ancestor/descendant fan-out). */
export function taskDirectlyReferencesNode(task: TaskNodeRefSource, nodeId: string): boolean {
  const id = nodeId.trim();
  if (!id || isWorkspaceRootClaim(id)) return false;
  return taskReferencedNodeIds(task).includes(id);
}

function taskIsActiveOccupation(task: TaskNodeRefSource): boolean {
  const state: TaskState =
    (task.state as TaskState | undefined) ||
    (task.status === "pending" || task.status === "taken"
      ? legacyStatusToState(task.status)
      : "failed");
  return isActiveTaskState(state);
}

/** Active Tasks that directly reference nodeId, deterministic order. */
export function listDirectActiveTasksForNode<T extends TaskNodeRefSource>(
  nodeId: string,
  tasks: readonly T[]
): T[] {
  const id = nodeId.trim();
  const matches = tasks.filter(
    (t) => taskIsActiveOccupation(t) && taskDirectlyReferencesNode(t, id)
  );
  return sortTasksDeterministically(matches);
}

/**
 * Deterministic order for multi-Task collaboration projection:
 * createdAt asc → id asc → path asc.
 */
export function sortTasksDeterministically<T extends TaskNodeRefSource>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => {
    const ca = a.createdAt || "";
    const cb = b.createdAt || "";
    if (ca !== cb) return ca.localeCompare(cb);
    const ia = a.id || "";
    const ib = b.id || "";
    if (ia !== ib) return ia.localeCompare(ib);
    return (a.path || "").localeCompare(b.path || "");
  });
}

export type ClaimsMigrationResult = {
  path: string;
  migrated: boolean;
  /** Skipped because already on nodes wire or no claims. */
  skipped: boolean;
  nodeIds: string[];
  /** True when legacy claims included "root" (discarded; not persisted). */
  discardedRootClaim: boolean;
  reason?: string;
};

/**
 * One-shot idempotent disk migration: legacy claims[] → contextCard.refs.nodes[].
 * - Deletes claims from frontmatter after success.
 * - "root" is discarded into stable workspace context (empty nodes); never a fake Node
 *   and never a persisted workspaceContext source flag.
 * - Writes a **complete** TaskContextCardV1 (actors/assignee/digests) when building
 *   a new card; merges nodes into an existing full card when present.
 * - Active Task with empty/missing objective fails loud (never chat-memory inference).
 * - Missing acceptance → mechanical reuse of exact objective text.
 *
 * This is the **only** path that may read claims[].
 */
export async function migrateTaskClaimsToContextCardRefs(
  fs: FsAdapter,
  taskPath: string,
  options?: { dryRun?: boolean }
): Promise<ClaimsMigrationResult> {
  if (!(await fs.exists(taskPath))) {
    throw new Error(`Task envelope not found: ${taskPath}.`);
  }
  const raw = await fs.readFile(taskPath);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") {
    throw new Error(`Invalid task envelope format: ${taskPath}.`);
  }

  const existingFull = tryLoadFullContextCard(data);
  const hasClaims =
    Array.isArray(data.claims) &&
    data.claims.length > 0 &&
    data.claims.every((c) => typeof c === "string");
  const claims = hasClaims ? (data.claims as string[]) : [];
  const hasClaimsKey = "claims" in data;
  const hasLegacyWorkspaceFlag = data.workspaceContext !== undefined;

  // Already on nodes wire with no residual claims / workspaceContext flag → skip.
  if (existingFull && !hasClaims && !hasClaimsKey && !hasLegacyWorkspaceFlag) {
    return {
      path: taskPath,
      migrated: false,
      skipped: true,
      nodeIds: existingFull.refs.nodes.map((n) => n.id),
      discardedRootClaim: false,
      reason: "already migrated",
    };
  }

  // Full card present: strip residual claims key and/or obsolete workspaceContext.
  if (existingFull && !hasClaims) {
    if (!options?.dryRun && (hasClaimsKey || hasLegacyWorkspaceFlag)) {
      delete data.claims;
      delete data.workspaceContext;
      await fs.writeFile(taskPath, serializeFrontmatter(data, body, keyOrder));
      return {
        path: taskPath,
        migrated: true,
        skipped: false,
        nodeIds: existingFull.refs.nodes.map((n) => n.id),
        discardedRootClaim: false,
        reason: "stripped residual claims/workspaceContext",
      };
    }
    return {
      path: taskPath,
      migrated: false,
      skipped: true,
      nodeIds: existingFull.refs.nodes.map((n) => n.id),
      discardedRootClaim: false,
      reason: "already migrated",
    };
  }

  if (!hasClaims && !existingFull) {
    // Nothing to migrate (no claims, no card) — leave alone.
    if (!options?.dryRun && (hasClaimsKey || hasLegacyWorkspaceFlag)) {
      delete data.claims;
      delete data.workspaceContext;
      await fs.writeFile(taskPath, serializeFrontmatter(data, body, keyOrder));
      return {
        path: taskPath,
        migrated: true,
        skipped: false,
        nodeIds: [],
        discardedRootClaim: false,
        reason: "stripped residual claims/workspaceContext without card",
      };
    }
    return {
      path: taskPath,
      migrated: false,
      skipped: true,
      nodeIds: [],
      discardedRootClaim: false,
      reason: "no claims to migrate",
    };
  }

  const discardedRootClaim = claims.some(isWorkspaceRootClaim);
  const nodeClaims = claims.filter((c) => !isWorkspaceRootClaim(c));

  // Merge with any existing nodes (prefer existing path hints).
  const byId = new Map<string, TaskNodeRef>();
  for (const n of existingFull?.refs.nodes ?? []) {
    if (!isWorkspaceRootClaim(n.id)) byId.set(n.id, n);
  }
  for (const id of nodeClaims) {
    if (!byId.has(id)) byId.set(id, { id });
  }
  const nodes = [...byId.values()];

  const requireObjective = isActiveEnvelopeData(data);
  const objective = resolveMigrationObjective(data, body, taskPath, requireObjective);
  const acceptanceFromCard =
    existingFull?.acceptance && existingFull.acceptance.length > 0
      ? existingFull.acceptance
      : undefined;
  const acceptance =
    acceptanceFromCard && acceptanceFromCard.length > 0
      ? acceptanceFromCard
      : objective
        ? [objective]
        : existingFull?.acceptance ?? [];

  // Build or merge a **complete** Context Card v1 — never a partial minimal card.
  const card = buildMigratedFullContextCard({
    data,
    existingFull,
    nodes,
    objective,
    acceptance,
    taskPath,
    body,
  });

  if (!options?.dryRun) {
    data.contextCard = serializeTaskContextCardForFrontmatter(card);
    data.contextGeneration = card.contextGeneration;
    data.taskDeltaDigest = card.taskDeltaDigest;
    delete data.claims;
    // Never persist workspaceContext as a Task source flag.
    delete data.workspaceContext;
    await fs.writeFile(taskPath, serializeFrontmatter(data, body, keyOrder));
  }

  return {
    path: taskPath,
    migrated: true,
    skipped: false,
    nodeIds: nodes.map((n) => n.id),
    discardedRootClaim,
  };
}

/**
 * Scan all Task envelopes under temp/ and migrate claims → contextCard.refs.nodes.
 * Idempotent; safe to re-run.
 */
export async function migrateAllTaskClaimsToContextCardRefs(
  fs: FsAdapter,
  options?: { dryRun?: boolean }
): Promise<ClaimsMigrationResult[]> {
  const results: ClaimsMigrationResult[] = [];
  if (!(await fs.exists(TEMP_DIR))) return results;

  for (const entry of await fs.listDir(TEMP_DIR)) {
    if (!entry.isDir) continue;
    if (entry.name === AGENT_PROFILES_TEMP_DIR) {
      const profilesRoot = join(TEMP_DIR, AGENT_PROFILES_TEMP_DIR);
      if (!(await fs.exists(profilesRoot))) continue;
      for (const profileEntry of await fs.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        await migrateTaskDir(
          fs,
          join(profilesRoot, profileEntry.name, "tasks"),
          results,
          options
        );
      }
      continue;
    }
    await migrateTaskDir(fs, join(TEMP_DIR, entry.name, "tasks"), results, options);
  }
  return results;
}

async function migrateTaskDir(
  fs: FsAdapter,
  taskDir: string,
  results: ClaimsMigrationResult[],
  options?: { dryRun?: boolean }
): Promise<void> {
  if (!(await fs.exists(taskDir))) return;
  for (const entry of await fs.listDir(taskDir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path = join(taskDir, entry.name);
    try {
      results.push(await migrateTaskClaimsToContextCardRefs(fs, path, options));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/missing objective|empty\/missing objective/i.test(msg)) throw err;
      results.push({
        path,
        migrated: false,
        skipped: true,
        nodeIds: [],
        discardedRootClaim: false,
        reason: msg,
      });
    }
  }
}

function tryLoadFullContextCard(data: Record<string, unknown>): TaskContextCardV1 | null {
  try {
    return loadTaskContextCardFromFrontmatter(data);
  } catch {
    return null;
  }
}

function buildMigratedFullContextCard(input: {
  data: Record<string, unknown>;
  existingFull: TaskContextCardV1 | null;
  nodes: TaskNodeRef[];
  objective: string | null;
  acceptance: string[];
  taskPath: string;
  body: string;
}): TaskContextCardV1 {
  const { data, existingFull, nodes, taskPath } = input;
  const objective =
    (input.objective?.trim() || existingFull?.objective?.trim() || "").trim();
  if (!objective) {
    throw new Error(
      `Active Task ${taskPath} has empty/missing objective; claims→contextCard migration fails loud (never invent from chat memory).`
    );
  }
  const acceptance =
    input.acceptance.length > 0
      ? input.acceptance
      : existingFull?.acceptance?.length
        ? existingFull.acceptance
        : [objective];

  const actors = resolveMigrationActors(data, existingFull);
  const assignee =
    existingFull?.assignee ??
    projectAssigneeFromTask({
      role: typeof data.role === "string" ? data.role : "unknown",
      assigneeKind:
        data.assigneeKind === "agentProfile" ? "agentProfile" : "role",
      agentId: typeof data.agentId === "string" ? data.agentId : undefined,
    });

  const contextGeneration =
    existingFull?.contextGeneration?.trim() ||
    (typeof data.contextGeneration === "string" && data.contextGeneration.trim()
      ? data.contextGeneration.trim()
      : computeContextGeneration({
          workspaceIdentity:
            (typeof data.workspace === "string" && data.workspace.trim()) ||
            "local-workspace",
          rulesPointerDigest: "migration-default-rules",
          agentsPointerDigest: "migration-default-agents",
          extraStable: {
            taskPath,
            role: typeof data.role === "string" ? data.role : "",
          },
        }));

  return buildTaskContextCard({
    objective,
    frozenDecisions: existingFull?.frozenDecisions ?? [],
    scope: existingFull?.scope ?? { include: [], exclude: [] },
    acceptance,
    refs: {
      nodes,
      tasks: existingFull?.refs.tasks ?? [],
      deliveries: existingFull?.refs.deliveries ?? [],
      git: existingFull?.refs.git ?? [],
    },
    parentActor: actors.parentActor,
    reviewer: actors.reviewer,
    assignee,
    contextGeneration,
    userPrompt: extractObjectiveFromBody(input.body) ?? objective,
  });
}

function resolveMigrationActors(
  data: Record<string, unknown>,
  existingFull: TaskContextCardV1 | null
): { parentActor: TaskActorRef; reviewer: TaskActorRef } {
  if (existingFull) {
    return {
      parentActor: existingFull.parentActor,
      reviewer: existingFull.reviewer,
    };
  }
  const hasParent = data.parentActor !== undefined && data.parentActor !== null;
  const hasReviewer = data.reviewer !== undefined && data.reviewer !== null;
  if (hasParent && hasReviewer) {
    return resolveParentReviewerPair({
      parentActor: parseTaskActorRef(data.parentActor, "parentActor"),
      reviewer: parseTaskActorRef(data.reviewer, "reviewer"),
    });
  }
  if (hasParent) {
    const parentActor = parseTaskActorRef(data.parentActor, "parentActor");
    return resolveParentReviewerPair({ parentActor });
  }
  // Last resort for pre-actor legacy envelopes: user parent (migrator-only; never invent from chat).
  return resolveParentReviewerPair({
    parentActor: { kind: "user", id: "user" },
  });
}

function isActiveEnvelopeData(data: Record<string, unknown>): boolean {
  const state = data.state;
  if (
    state === "queued" ||
    state === "running" ||
    state === "waiting" ||
    state === "delivered"
  ) {
    return true;
  }
  if (data.status === "pending" || data.status === "taken") {
    if (
      state === "accepted" ||
      state === "rejected" ||
      state === "interrupted" ||
      state === "failed"
    ) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Objective resolution order (persisted only — never chat memory):
 * 1. contextCard.objective
 * 2. top-level objective field
 * 3. ## User Prompt body section (exact persisted text)
 */
function resolveMigrationObjective(
  data: Record<string, unknown>,
  body: string,
  taskPath: string,
  require: boolean
): string | null {
  const fromCard = data.contextCard;
  if (fromCard && typeof fromCard === "object" && !Array.isArray(fromCard)) {
    const obj = (fromCard as Record<string, unknown>).objective;
    if (typeof obj === "string" && obj.trim()) return obj.trim();
  }
  if (typeof data.objective === "string" && data.objective.trim()) {
    return data.objective.trim();
  }
  const fromBody = extractObjectiveFromBody(body);
  if (fromBody) return fromBody;
  if (require) {
    throw new Error(
      `Active Task ${taskPath} has empty/missing objective; claims→contextCard migration fails loud (never invent from chat memory).`
    );
  }
  return null;
}

function extractObjectiveFromBody(body: string): string | null {
  const text = body.trim();
  if (!text) return null;
  const match = text.match(/##\s*User Prompt\s*\r?\n+([\s\S]*?)\s*$/i);
  if (match) {
    const section = match[1].trim();
    return section || null;
  }
  // Legacy body without section header: whole body is the persisted prompt.
  // Skip pure structural headers that are not an objective.
  if (/^#\s*Task\s*$/im.test(text) && !/##\s*User Prompt/i.test(text)) {
    const withoutTitle = text.replace(/^#\s*Task\s*/i, "").trim();
    if (!withoutTitle || /^##\s*Context Pointers/i.test(withoutTitle)) return null;
  }
  return text || null;
}
