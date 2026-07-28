// Task Node refs (V0.2 cx-tsw53f): sole persisted source is Task.contextCard.refs.nodes[].
// Durable id is authoritative; path is a refreshable hint only.
// Integrated on Context Card / parentActor / roster baseline (36a38bf).
// Full TaskContextCardV1 lives in task-context-card.ts; this module owns Node-ref
// helpers, claims→refs migration, and non-exclusive occupation retirement.
// No parallel nodeRefs/sourceRefs. New writes never persist claims[].

import type { FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import {
  AGENT_PROFILES_TEMP_DIR,
  TEMP_DIR,
} from "./paths.js";
import { join } from "./tree.js";
import { isActiveTaskState, legacyStatusToState, type TaskState } from "./task-model.js";

/** Durable Node pointer on Task.contextCard.refs.nodes[]. */
export type TaskNodeRef = {
  id: string;
  /** Refreshable path hint — never authoritative. */
  path?: string;
  revision?: string;
};

/**
 * Partial / migration Context Card shape carrying Node refs.
 * Full TaskContextCardV1 (actors/digests/…) is authoritative when present on TaskEnvelope;
 * this shape is used by claims→refs migration and by ref helpers that only need nodes[].
 */
export type TaskContextCardNodeRefs = {
  schemaVersion?: "v1";
  /** Required on active Tasks after migration (fail-loud when missing/empty). */
  objective?: string;
  /** Minimal acceptance; may equal objective when legacy had no explicit acceptance. */
  acceptance?: string[];
  refs: {
    nodes: TaskNodeRef[];
    tasks?: TaskNodeRef[];
    deliveries?: TaskNodeRef[];
    git?: TaskNodeRef[];
  };
};

/** Fields needed to resolve Node refs without importing TaskEnvelope (avoids cycles). */
export type TaskNodeRefSource = {
  path?: string;
  id?: string;
  createdAt?: string;
  state?: string;
  status?: string;
  claims?: string[];
  contextCard?: TaskContextCardNodeRefs;
  /** Workspace-wide context flag (legacy claims included "root"). */
  workspaceContext?: boolean;
};

/** Legacy claim token for workspace-wide context (not a Node id). */
export const WORKSPACE_ROOT_CLAIM = "root";

export function isWorkspaceRootClaim(id: string): boolean {
  return id.trim() === WORKSPACE_ROOT_CLAIM;
}

/** Normalize a single node ref; empty id rejected. */
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
 * Prefers contextCard.refs.nodes when present; otherwise legacy claims (migrate bridge only).
 */
export function taskReferencedNodeIds(task: TaskNodeRefSource): string[] {
  if (task.contextCard?.refs?.nodes) {
    return task.contextCard.refs.nodes
      .map((n) => n.id)
      .filter((id) => id && !isWorkspaceRootClaim(id));
  }
  return (task.claims ?? []).filter((id) => id && !isWorkspaceRootClaim(id));
}

/** True when Task carries workspace/root context (not a Tent-wide lock). */
export function taskHasWorkspaceContext(task: TaskNodeRefSource): boolean {
  if (task.workspaceContext === true) return true;
  if ((task.claims ?? []).some(isWorkspaceRootClaim)) return true;
  return false;
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

/** Build contextCard.refs.nodes (+ objective/acceptance) for new Task writes. */
export function buildContextCardNodeRefs(input: {
  nodes: Array<{ id: string; path?: string; revision?: string }>;
  objective: string;
  acceptance?: string[];
}): TaskContextCardNodeRefs {
  const objective = input.objective.trim();
  if (!objective) {
    throw new Error("Task.contextCard.objective cannot be empty.");
  }
  const acceptance =
    input.acceptance && input.acceptance.length > 0
      ? input.acceptance.map((s) => s.trim()).filter(Boolean)
      : [objective];
  if (acceptance.length === 0) {
    throw new Error("Task.contextCard.acceptance cannot be empty.");
  }
  const nodes = input.nodes.map((n) => normalizeTaskNodeRef(n));
  return {
    schemaVersion: "v1",
    objective,
    acceptance,
    refs: { nodes },
  };
}

/** Serialize minimal contextCard for frontmatter (plain JSON-compatible). */
export function serializeContextCardNodeRefs(
  card: TaskContextCardNodeRefs
): Record<string, unknown> {
  const refs: Record<string, unknown> = {
    nodes: card.refs.nodes.map((n) => {
      const o: Record<string, string> = { id: n.id };
      if (n.path) o.path = n.path;
      if (n.revision) o.revision = n.revision;
      return o;
    }),
  };
  if (card.refs.tasks?.length) {
    refs.tasks = card.refs.tasks.map((n) => ({ ...n }));
  }
  if (card.refs.deliveries?.length) {
    refs.deliveries = card.refs.deliveries.map((n) => ({ ...n }));
  }
  if (card.refs.git?.length) {
    refs.git = card.refs.git.map((n) => ({ ...n }));
  }
  const out: Record<string, unknown> = {
    schemaVersion: card.schemaVersion ?? "v1",
    refs,
  };
  if (card.objective) out.objective = card.objective;
  if (card.acceptance?.length) out.acceptance = [...card.acceptance];
  return out;
}

/** Load minimal contextCard from frontmatter data. */
export function loadContextCardNodeRefsFromFrontmatter(
  data: Record<string, unknown>
): TaskContextCardNodeRefs | undefined {
  const raw = data.contextCard;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const card = raw as Record<string, unknown>;
  const refsRaw = card.refs;
  if (refsRaw == null || typeof refsRaw !== "object" || Array.isArray(refsRaw)) {
    return undefined;
  }
  const refsObj = refsRaw as Record<string, unknown>;
  const nodes = parseTaskNodeRefs(refsObj.nodes ?? []);
  const out: TaskContextCardNodeRefs = {
    refs: { nodes },
  };
  if (card.schemaVersion === "v1") out.schemaVersion = "v1";
  if (typeof card.objective === "string") out.objective = card.objective;
  if (Array.isArray(card.acceptance) && card.acceptance.every((a) => typeof a === "string")) {
    out.acceptance = card.acceptance as string[];
  }
  return out;
}

export type ClaimsMigrationResult = {
  path: string;
  migrated: boolean;
  /** Skipped because already on nodes wire or no claims. */
  skipped: boolean;
  nodeIds: string[];
  workspaceContext: boolean;
  reason?: string;
};

/**
 * One-shot idempotent disk migration: legacy claims[] → contextCard.refs.nodes[].
 * - Deletes claims from frontmatter after success.
 * - "root" becomes workspaceContext (not a fake Node ref).
 * - Active Task with empty/missing objective fails loud (never chat-memory inference).
 * - Missing acceptance → mechanical reuse of exact objective text.
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

  const existingCard = loadContextCardNodeRefsFromFrontmatter(data);
  const hasClaims =
    Array.isArray(data.claims) &&
    data.claims.length > 0 &&
    data.claims.every((c) => typeof c === "string");
  const claims = hasClaims ? (data.claims as string[]) : [];

  // Already on nodes wire with no residual claims → idempotent skip.
  if (existingCard && !hasClaims && !("claims" in data)) {
    return {
      path: taskPath,
      migrated: false,
      skipped: true,
      nodeIds: existingCard.refs.nodes.map((n) => n.id),
      workspaceContext: data.workspaceContext === true,
      reason: "already migrated",
    };
  }

  // contextCard.refs present and claims already gone (empty claims key or absent)
  if (existingCard && !hasClaims) {
    if (!options?.dryRun && "claims" in data) {
      delete data.claims;
      await fs.writeFile(taskPath, serializeFrontmatter(data, body, keyOrder));
      return {
        path: taskPath,
        migrated: true,
        skipped: false,
        nodeIds: existingCard.refs.nodes.map((n) => n.id),
        workspaceContext: data.workspaceContext === true,
        reason: "stripped residual empty claims",
      };
    }
    return {
      path: taskPath,
      migrated: false,
      skipped: true,
      nodeIds: existingCard.refs.nodes.map((n) => n.id),
      workspaceContext: data.workspaceContext === true,
      reason: "already migrated",
    };
  }

  const workspaceContext = claims.some(isWorkspaceRootClaim) || data.workspaceContext === true;
  const nodeClaims = claims.filter((c) => !isWorkspaceRootClaim(c));

  // Merge with any existing nodes (prefer existing path hints).
  const byId = new Map<string, TaskNodeRef>();
  for (const n of existingCard?.refs.nodes ?? []) {
    byId.set(n.id, n);
  }
  for (const id of nodeClaims) {
    if (!byId.has(id)) byId.set(id, { id });
  }
  const nodes = [...byId.values()];

  const requireObjective = isActiveEnvelopeData(data);
  let objective: string | null = null;
  try {
    objective = resolveMigrationObjective(data, body, taskPath, requireObjective);
  } catch (err) {
    throw err;
  }

  const acceptanceFromCard =
    existingCard?.acceptance && existingCard.acceptance.length > 0
      ? existingCard.acceptance
      : undefined;

  const card: TaskContextCardNodeRefs = {
    schemaVersion: "v1",
    refs: { nodes },
  };
  if (objective) {
    card.objective = objective;
    card.acceptance =
      acceptanceFromCard && acceptanceFromCard.length > 0
        ? acceptanceFromCard
        : [objective];
  } else if (existingCard?.objective?.trim()) {
    card.objective = existingCard.objective.trim();
    card.acceptance =
      existingCard.acceptance && existingCard.acceptance.length > 0
        ? existingCard.acceptance
        : [card.objective];
  }

  if (!options?.dryRun) {
    data.contextCard = serializeContextCardNodeRefs(card);
    delete data.claims;
    if (workspaceContext) data.workspaceContext = true;
    else delete data.workspaceContext;
    await fs.writeFile(taskPath, serializeFrontmatter(data, body, keyOrder));
  }

  return {
    path: taskPath,
    migrated: true,
    skipped: false,
    nodeIds: nodes.map((n) => n.id),
    workspaceContext,
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
        workspaceContext: false,
        reason: msg,
      });
    }
  }
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
