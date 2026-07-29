// Task Node refs (V0.2 cx-tsw53f): sole persisted source is Task.contextCard.refs.nodes[].
// Durable id is authoritative; path is a refreshable hint only.
// Canonical types / build / parse / digests: task-context-card.ts (TaskContextCardV1,
// TaskContextCardRef). This module owns Node-ref helpers, one-shot claims→refs
// migration (migrateLegacyTaskNodeRefs), and non-exclusive occupation projection.
// No parallel nodeRefs/sourceRefs. New writes never persist claims[].
// Runtime never falls back to claims[].

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

/**
 * Fields needed to resolve Node refs without importing TaskEnvelope (avoids cycles).
 * Runtime occupation / collaboration reads **only** contextCard.refs.nodes.
 * Accepts full TaskContextCardV1 or a minimal `{ refs: { nodes } }` projection.
 */
export type ContextCardNodeRefSource = {
  path?: string;
  id?: string;
  createdAt?: string;
  state?: string;
  status?: string;
  /**
   * Context Card (full or projection). `refs.nodes` must be an explicit array when
   * present; absence of contextCard / nodes fails loud in taskReferencedNodeIds.
   */
  contextCard?:
    | TaskContextCardV1
    | {
        refs?: {
          nodes?: TaskContextCardRef[] | null;
        } | null;
      }
    | null;
};

/** Normalize a single node ref; empty id / fake root rejected. */
export function normalizeContextCardNodeRef(raw: {
  id: string;
  path?: string;
  revision?: string;
}): TaskContextCardRef {
  const id = raw.id.trim();
  if (!id) throw new Error("Task node ref id cannot be empty.");
  if (id === "root") {
    throw new Error(
      'Task.contextCard.refs.nodes must not include fake "root" Node ref; workspace context is separate.'
    );
  }
  const out: TaskContextCardRef = { id };
  if (typeof raw.path === "string" && raw.path.trim()) {
    out.path = raw.path.trim().replace(/\\/g, "/");
  }
  if (typeof raw.revision === "string" && raw.revision.trim()) {
    out.revision = raw.revision.trim();
  }
  return out;
}

/** Parse refs.nodes from a contextCard-like object (fail-loud on bad shape). */
export function parseContextCardNodeRefs(value: unknown): TaskContextCardRef[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("Task.contextCard.refs.nodes must be an array.");
  }
  const out: TaskContextCardRef[] = [];
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
    if (rec.id.trim() === "root") {
      // Skip fake root — workspace context is not a Node ref.
      continue;
    }
    const ref = normalizeContextCardNodeRef({
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

/** Stable runtime error when Task.contextCard.refs.nodes is absent (not empty). */
export const MISSING_CONTEXT_CARD_NODES =
  "MISSING_CONTEXT_CARD: Task.contextCard.refs.nodes is required (run migrateLegacyTaskNodeRefs for legacy claims).";

/**
 * Authoritative Node ids referenced by a Task (direct only).
 * **Runtime:** only `contextCard.refs.nodes`. Never reads claims[].
 *
 * Fail-loud when `contextCard` or `refs.nodes` is **undefined/absent** — never treat
 * that as workspace context (would silently map corrupt/unmigrated Tasks to []).
 * An **explicitly present empty** `nodes: []` is the only valid workspace-context case.
 */
export function taskReferencedNodeIds(task: ContextCardNodeRefSource): string[] {
  const label = task.id || task.path || "(unknown)";
  if (task.contextCard == null) {
    throw new Error(`${MISSING_CONTEXT_CARD_NODES} task=${label}`);
  }
  // Require an explicit nodes array — optional chaining that yields undefined must throw.
  const nodes = task.contextCard.refs?.nodes;
  if (nodes === undefined || nodes === null) {
    throw new Error(`${MISSING_CONTEXT_CARD_NODES} task=${label}`);
  }
  if (!Array.isArray(nodes)) {
    throw new Error(`${MISSING_CONTEXT_CARD_NODES} task=${label} (nodes must be an array)`);
  }
  // Explicit empty array → workspace context (caller: taskHasWorkspaceOnlyContext).
  return nodes.map((n) => n.id).filter((id) => id && id !== "root");
}

/**
 * True when Task has no direct Node refs (stable workspace context only).
 * Not a Tent-wide lock — concurrent workspace-context Tasks are legal.
 * Only valid when contextCard.refs.nodes is an **explicit empty array**;
 * missing card/nodes fails loud via taskReferencedNodeIds (never silent []).
 */
export function taskHasWorkspaceOnlyContext(task: ContextCardNodeRefSource): boolean {
  return taskReferencedNodeIds(task).length === 0;
}

/** True when Task directly references this Node id (not ancestor/descendant fan-out). */
export function taskDirectlyReferencesNode(task: ContextCardNodeRefSource, nodeId: string): boolean {
  const id = nodeId.trim();
  if (!id || id === "root") return false;
  return taskReferencedNodeIds(task).includes(id);
}

function taskIsActiveOccupation(task: ContextCardNodeRefSource): boolean {
  const state: TaskState =
    (task.state as TaskState | undefined) ||
    (task.status === "pending" || task.status === "taken"
      ? legacyStatusToState(task.status)
      : "failed");
  return isActiveTaskState(state);
}

/** Active Tasks that directly reference nodeId, deterministic order. */
export function listDirectActiveTasksForNode<T extends ContextCardNodeRefSource>(
  nodeId: string,
  tasks: readonly T[]
): T[] {
  const id = nodeId.trim();
  const matches = tasks.filter((t) => {
    if (!taskIsActiveOccupation(t)) return false;
    if (t.contextCard == null) return false; // unmigrated: not in occupation set
    return taskDirectlyReferencesNode(t, id);
  });
  return sortTasksDeterministically(matches);
}

/**
 * Deterministic order for multi-Task collaboration projection:
 * createdAt asc → id asc → path asc.
 */
export function sortTasksDeterministically<T extends ContextCardNodeRefSource>(tasks: readonly T[]): T[] {
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

export type LegacyTaskNodeRefsMigrationResult = {
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
 * **Only** path that may read claims[] or strip obsolete residual keys.
 * - Deletes claims from frontmatter after success.
 * - "root" is discarded into stable workspace context (empty nodes); never a fake Node.
 * - Writes a **complete** TaskContextCardV1 (actors/assignee/digests).
 * - Active Task with empty/missing objective fails loud (never chat-memory inference).
 * - Missing acceptance → mechanical reuse of exact objective text.
 */
export async function migrateLegacyTaskNodeRefs(
  fs: FsAdapter,
  taskPath: string,
  options?: { dryRun?: boolean }
): Promise<LegacyTaskNodeRefsMigrationResult> {
  if (!(await fs.exists(taskPath))) {
    throw new Error(`Task envelope not found: ${taskPath}.`);
  }
  const raw = await fs.readFile(taskPath);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") {
    throw new Error(`Invalid task envelope format: ${taskPath}.`);
  }

  const existingFull = tryLoadFullContextCard(data);

  // --- migration-local legacy claims[] read (not runtime occupation) ---
  const legacyClaimsRaw = data.claims;
  const hasClaims =
    Array.isArray(legacyClaimsRaw) &&
    legacyClaimsRaw.length > 0 &&
    legacyClaimsRaw.every((c) => typeof c === "string");
  const legacyClaims = hasClaims ? (legacyClaimsRaw as string[]) : [];
  const hasClaimsKey = "claims" in data;
  // migration-local: obsolete residual dual-source flag key (never re-persist).
  const legacyObsoleteSourceFlagKey = "workspace" + "Context";
  const hasObsoleteSourceFlag = Object.prototype.hasOwnProperty.call(
    data,
    legacyObsoleteSourceFlagKey
  );

  // Already on nodes wire with no residual claims / obsolete flags → skip.
  if (existingFull && !hasClaims && !hasClaimsKey && !hasObsoleteSourceFlag) {
    return {
      path: taskPath,
      migrated: false,
      skipped: true,
      nodeIds: existingFull.refs.nodes.map((n) => n.id),
      discardedRootClaim: false,
      reason: "already migrated",
    };
  }

  // Full card present: strip residual claims key and/or obsolete residual flags.
  if (existingFull && !hasClaims) {
    if (!options?.dryRun && (hasClaimsKey || hasObsoleteSourceFlag)) {
      delete data.claims;
      delete data[legacyObsoleteSourceFlagKey];
      await fs.writeFile(taskPath, serializeFrontmatter(data, body, keyOrder));
      return {
        path: taskPath,
        migrated: true,
        skipped: false,
        nodeIds: existingFull.refs.nodes.map((n) => n.id),
        discardedRootClaim: false,
        reason: "stripped residual claims/obsolete source flag",
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
    if (!options?.dryRun && (hasClaimsKey || hasObsoleteSourceFlag)) {
      delete data.claims;
      delete data[legacyObsoleteSourceFlagKey];
      await fs.writeFile(taskPath, serializeFrontmatter(data, body, keyOrder));
      return {
        path: taskPath,
        migrated: true,
        skipped: false,
        nodeIds: [],
        discardedRootClaim: false,
        reason: "stripped residual claims/obsolete source flag without card",
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

  const discardedRootClaim = legacyClaims.some((c) => c.trim() === "root");
  const nodeClaims = legacyClaims.filter((c) => c.trim() !== "root");

  // Merge with any existing nodes (prefer existing path hints).
  const byId = new Map<string, TaskContextCardRef>();
  for (const n of existingFull?.refs.nodes ?? []) {
    if (n.id !== "root") byId.set(n.id, n);
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
    delete data[legacyObsoleteSourceFlagKey];
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
export async function migrateAllLegacyTaskNodeRefs(
  fs: FsAdapter,
  options?: { dryRun?: boolean }
): Promise<LegacyTaskNodeRefsMigrationResult[]> {
  const results: LegacyTaskNodeRefsMigrationResult[] = [];
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
  results: LegacyTaskNodeRefsMigrationResult[],
  options?: { dryRun?: boolean }
): Promise<void> {
  if (!(await fs.exists(taskDir))) return;
  for (const entry of await fs.listDir(taskDir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path = join(taskDir, entry.name);
    try {
      results.push(await migrateLegacyTaskNodeRefs(fs, path, options));
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
  nodes: TaskContextCardRef[];
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
          // Migration-only fallback: stable workspace/role identity only.
          // Never include taskPath/taskId/objective (poison cross-Task cache).
          workspaceIdentity:
            (typeof data.workspace === "string" && data.workspace.trim()) ||
            "local-workspace",
          agentsPointerDigest: "migration-default-agents",
          extraStable: {
            role: typeof data.role === "string" ? data.role : "",
            assigneeKind:
              data.assigneeKind === "agentProfile" ? "agentProfile" : "role",
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
  if (/^#\s*Task\s*$/im.test(text) && !/##\s*User Prompt/i.test(text)) {
    const withoutTitle = text.replace(/^#\s*Task\s*/i, "").trim();
    if (!withoutTitle || /^##\s*Context Pointers/i.test(withoutTitle)) return null;
  }
  return text || null;
}
