// Delivery operational entity (dl-) — task-api §1.3.
// Stored under the exact Task Role/Session operational namespace (not Nodes).

import { withTentMutation, type Clock, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { isNodeId } from "./id.js";
import {
  normalizeArtifactRefs,
  type ArtifactRef,
} from "./artifact.js";
import { canonicalSha256, sha256Hex } from "./canonical-digest.js";
import {
  ROLES_TEMP_DIR,
  SESSIONS_TEMP_DIR,
  roleDeliveriesDir,
  sessionDeliveriesDir,
  TEMP_DIR,
} from "./paths.js";
import { join } from "./tree.js";
import {
  isDeliveryId,
  makeDeliveryId,
  type DeliveryCheck,
  type DeliveryReview,
  type DeliveryStatus,
  type IntegrationMode,
} from "./task-model.js";

export interface DeliveryRecord {
  path: string;
  id: string;
  taskId: string;
  /** Source Node selected from the Task's ordered Node refs when delivered. */
  sourceNodeId: string;
  status: DeliveryStatus;
  summary: string;
  commits: string[];
  /**
   * Full SHA of the resolved integration target branch HEAD at ready Delivery
   * creation (commit-bearing only). Compared again before accept / auto-integrate
   * applies Git. Absent on no-commit Deliveries and on legacy pre-field rows.
   */
  targetHead?: string;
  checks: DeliveryCheck[];
  artifactRefs: ArtifactRef[];
  integrationMode: IntegrationMode;
  review?: DeliveryReview;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateDeliveryInput {
  taskId: string;
  sourceNodeId: string;
  summary: string;
  commits?: string[];
  /**
   * Required for new commit-bearing ready Deliveries: resolved target branch HEAD
   * at creation/review time. Omitted for zero-commit Deliveries.
   */
  targetHead?: string;
  checks?: DeliveryCheck[];
  artifactRefs?: ArtifactRef[];
  status?: DeliveryStatus;
  integrationMode?: IntegrationMode;
  id?: string;
  /**
   * When set, write under this deliveries directory (relative system root).
   * Derived from the Task's canonical Role/Session namespace.
   */
  deliveriesDir: string;
}

const KEY_ORDER = [
  "type",
  "id",
  "taskId",
  "sourceNodeId",
  "status",
  "commits",
  "targetHead",
  "checksJson",
  "artifactRefsJson",
  "integrationMode",
  "reviewBy",
  "reviewDecision",
  "reviewNote",
  "createdAt",
  "updatedAt",
];

export async function createDelivery(
  fs: FsAdapter,
  clock: Clock,
  input: CreateDeliveryInput
): Promise<DeliveryRecord> {
  return withTentMutation(fs, () => createDeliveryUnlocked(fs, clock, input));
}

export async function createDeliveryUnlocked(
  fs: FsAdapter,
  clock: Clock,
  input: CreateDeliveryInput
): Promise<DeliveryRecord> {
  const summary = input.summary.trim();
  if (!summary) throw new Error("Delivery summary cannot be empty.");
  const now = clock.now();
  const id = input.id && isDeliveryId(input.id) ? input.id : makeDeliveryId();
  const deliveriesDir = input.deliveriesDir.trim();
  if (!deliveriesDir) throw new Error("Delivery deliveriesDir cannot be empty.");
  await ensureDir(fs, deliveriesDir);
  const path = join(deliveriesDir, `${id}.md`);
  if (await fs.exists(path)) throw new Error(`Delivery already exists: ${path}.`);

  const commits = uniqueCommits(input.commits ?? []);
  const targetHead = normalizeTargetHead(input.targetHead);
  const record: DeliveryRecord = {
    path,
    id,
    taskId: input.taskId,
    sourceNodeId: input.sourceNodeId,
    status: input.status ?? "ready",
    summary,
    commits,
    ...(targetHead ? { targetHead } : {}),
    checks: input.checks ?? [],
    artifactRefs: normalizeArtifactRefs(input.artifactRefs ?? []),
    integrationMode: input.integrationMode ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await writeDelivery(fs, record);
  return record;
}

export async function loadDelivery(fs: FsAdapter, inputPath: string): Promise<DeliveryRecord> {
  const path = normalizeDeliveryPath(inputPath);
  if (!(await fs.exists(path))) throw new Error(`Delivery not found: ${path}.`);
  const raw = await fs.readFile(path);
  const identity = parseDeliveryIdentityFromRaw(raw);
  const { data, body } = parseFrontmatter(raw);
  if (
    !identity ||
    data.type !== "delivery" ||
    data.id !== identity.id ||
    data.taskId !== identity.taskId
  ) {
    throw new Error(`Invalid delivery format: ${path}.`);
  }
  if (
    typeof data.taskId !== "string" ||
    typeof data.sourceNodeId !== "string" ||
    !isNodeId(data.sourceNodeId)
  ) {
    throw new Error(`Invalid delivery format: ${path}.`);
  }
  const status = parseDeliveryStatus(data.status);
  const reviewBy = typeof data.reviewBy === "string" ? data.reviewBy : undefined;
  const reviewDecision =
    data.reviewDecision === "accept" || data.reviewDecision === "reject"
      ? data.reviewDecision
      : undefined;
  const targetHead = normalizeTargetHead(
    typeof data.targetHead === "string" ? data.targetHead : undefined
  );
  return {
    path,
    id: data.id,
    taskId: data.taskId,
    sourceNodeId: data.sourceNodeId,
    status,
    summary: body.trim(),
    commits: Array.isArray(data.commits)
      ? uniqueCommits(data.commits.filter((c): c is string => typeof c === "string"))
      : [],
    ...(targetHead ? { targetHead } : {}),
    checks: parseJsonArrayField(data.checksJson, parseChecks),
    artifactRefs: parseArtifactRefsField(data.artifactRefsJson, path),
    integrationMode: parseIntegrationMode(data.integrationMode),
    review:
      reviewBy && reviewDecision
        ? {
            by: reviewBy,
            decision: reviewDecision,
            note: typeof data.reviewNote === "string" ? data.reviewNote : undefined,
          }
        : undefined,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : undefined,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : undefined,
  };
}

const DELIVERY_IDENTITY_PREFIX_MAX_BYTES = 1024;

/**
 * Bounded identity peek for shared owner delivery directories. It deliberately
 * validates only enough frontmatter to attribute a file to one exact Task;
 * matching files still go through loadDelivery's complete strict parser.
 */
export async function peekDeliveryTaskId(
  fs: FsAdapter,
  inputPath: string
): Promise<string | undefined> {
  return (await peekDeliveryIdentity(fs, inputPath))?.taskId;
}

export async function peekDeliveryIdentity(
  fs: FsAdapter,
  inputPath: string
): Promise<{ id: string; taskId: string } | undefined> {
  const path = normalizeDeliveryIdentityPath(inputPath);
  if (!fs.readBinaryBounded) {
    throw new Error("Delivery identity discovery requires bounded prefix reads.");
  }
  let bounded: Awaited<ReturnType<NonNullable<FsAdapter["readBinaryBounded"]>>>;
  try {
    bounded = await fs.readBinaryBounded(path, DELIVERY_IDENTITY_PREFIX_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // Non-fatal decoding is intentional: an exact byte prefix may end halfway
  // through a later multibyte frontmatter/body value after the ASCII identity.
  const raw = new TextDecoder("utf-8").decode(bounded.bytes);
  return parseDeliveryIdentityFromRaw(raw);
}

/**
 * The full loader and bounded inventory share this exact identity invariant.
 * Canonical scalar identity fields may be reordered, but must all occur once
 * in the opening bounded frontmatter and agree with the complete parse.
 */
export function parseDeliveryIdentityFromRaw(
  raw: string
): { id: string; taskId: string } | undefined {
  // Encode only a bounded character prefix, then cut to the exact byte limit.
  // This preserves the inventory hard bound without allocating a second copy
  // of a potentially multi-megabyte report in the full loader.
  const prefixBytes = new TextEncoder().encode(raw.slice(0, DELIVERY_IDENTITY_PREFIX_MAX_BYTES));
  const prefix = new TextDecoder("utf-8").decode(
    prefixBytes.subarray(0, DELIVERY_IDENTITY_PREFIX_MAX_BYTES)
  );
  if (!prefix.startsWith("---\n") && !prefix.startsWith("---\r\n")) return undefined;
  const values = new Map<string, string>();
  for (const line of prefix.split(/\r?\n/).slice(1)) {
    if (line === "---") break;
    const match = line.match(/^(type|id|taskId):\s*["']?([^"']+?)["']?\s*$/);
    if (!match) continue;
    if (values.has(match[1]!)) return undefined;
    values.set(match[1]!, match[2]!);
  }
  const type = values.get("type");
  const id = values.get("id");
  const taskId = values.get("taskId");
  return type === "delivery" && id && taskId && isDeliveryId(id) && /^tk-[a-z0-9]+$/.test(taskId)
    ? { id, taskId }
    : undefined;
}

/** Fixed-size proof that every immutable review candidate fact is unchanged. */
export function deliveryReviewSemanticsDigest(record: DeliveryRecord): string {
  return canonicalSha256({
    version: 1,
    id: record.id,
    taskId: record.taskId,
    sourceNodeId: record.sourceNodeId,
    status: record.status,
    summarySha256: sha256Hex(record.summary),
    commits: [...record.commits],
    targetHead: record.targetHead ?? null,
    checks: record.checks.map((check) => ({ ...check })),
    artifactRefs: normalizeArtifactRefs(record.artifactRefs),
    integrationMode: record.integrationMode,
    review: record.review ? { ...record.review } : null,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
  });
}

/**
 * Ready-candidate facts that manual acceptance must preserve through its WAL.
 * status/integrationMode/review/updatedAt are intentionally excluded because
 * the accept operation itself advances exactly those projections.
 */
export function deliveryAcceptCandidateDigest(record: DeliveryRecord): string {
  return canonicalSha256({
    version: 1,
    id: record.id,
    taskId: record.taskId,
    sourceNodeId: record.sourceNodeId,
    summarySha256: sha256Hex(record.summary),
    commits: [...record.commits],
    targetHead: record.targetHead ?? null,
    checks: record.checks.map((check) => ({ ...check })),
    artifactRefs: normalizeArtifactRefs(record.artifactRefs),
    createdAt: record.createdAt ?? null,
  });
}

function normalizeDeliveryIdentityPath(input: string): string {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/(roles|sessions)\/[^/]+\/deliveries\/dl-[^/]+\.md$/i.test(path)) {
    throw new Error(
      "Delivery identity must point under a Role/Session deliveries directory."
    );
  }
  return path;
}

export async function loadDeliveries(
  fs: FsAdapter,
  filter?: { taskId?: string; sourceNodeId?: string }
): Promise<DeliveryRecord[]> {
  const out: DeliveryRecord[] = [];
  if (!(await fs.exists(TEMP_DIR))) return out;
  for (const entry of await fs.listDir(TEMP_DIR)) {
    if (!entry.isDir || (entry.name !== ROLES_TEMP_DIR && entry.name !== SESSIONS_TEMP_DIR)) continue;
    const ownerRoot = join(TEMP_DIR, entry.name);
    for (const ownerEntry of await fs.listDir(ownerRoot)) {
      if (!ownerEntry.isDir) continue;
      await collectDeliveryFiles(fs, join(ownerRoot, ownerEntry.name, "deliveries"), filter, out);
    }
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

async function collectDeliveryFiles(
  fs: FsAdapter,
  dir: string,
  filter: { taskId?: string; sourceNodeId?: string } | undefined,
  out: DeliveryRecord[]
): Promise<void> {
  if (!(await fs.exists(dir))) return;
  for (const entry of await fs.listDir(dir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    try {
      const d = await loadDelivery(fs, join(dir, entry.name));
      if (filter?.taskId && d.taskId !== filter.taskId) continue;
      if (filter?.sourceNodeId && d.sourceNodeId !== filter.sourceNodeId) continue;
      out.push(d);
    } catch {
      // Invalid operational files stay on disk but are skipped.
    }
  }
}

export async function updateDelivery(
  fs: FsAdapter,
  clock: Clock,
  inputPath: string,
  patch: Partial<
    Pick<
      DeliveryRecord,
      | "status"
      | "summary"
      | "commits"
      | "targetHead"
      | "checks"
      | "artifactRefs"
      | "integrationMode"
      | "review"
    >
  >
): Promise<DeliveryRecord> {
  return withTentMutation(fs, async () => {
    const current = await loadDelivery(fs, inputPath);
    const nextTargetHead =
      patch.targetHead !== undefined
        ? normalizeTargetHead(patch.targetHead)
        : current.targetHead;
    const next: DeliveryRecord = {
      ...current,
      ...patch,
      commits: patch.commits ? uniqueCommits(patch.commits) : current.commits,
      ...(nextTargetHead ? { targetHead: nextTargetHead } : { targetHead: undefined }),
      updatedAt: clock.now(),
    };
    await writeDelivery(fs, next);
    return next;
  });
}

/**
 * Drop non-accepted deliveries for a source Node (ready / rejected / draft).
 * Accepted deliveries stay as operational history for retention.
 */
export async function removeNonAcceptedDeliveriesForNode(
  fs: FsAdapter,
  sourceNodeId: string
): Promise<void> {
  for (const delivery of await loadDeliveries(fs, { sourceNodeId })) {
    if (delivery.status === "accepted") continue;
    if (await fs.exists(delivery.path)) await fs.remove(delivery.path);
  }
}

/**
 * Drop non-accepted deliveries for one exact Task only.
 * Ordinary Task terminal transitions must never delete another Task's Delivery
 * merely because both Tasks reference the same Node.
 */
export async function removeNonAcceptedDeliveriesForTask(
  fs: FsAdapter,
  taskId: string
): Promise<void> {
  for (const delivery of await loadDeliveries(fs, { taskId })) {
    if (delivery.status === "accepted") continue;
    if (await fs.exists(delivery.path)) await fs.remove(delivery.path);
  }
}

export async function writeDelivery(fs: FsAdapter, record: DeliveryRecord): Promise<void> {
  const artifactRefs = normalizeArtifactRefs(record.artifactRefs);
  const data: Record<string, unknown> = {
    type: "delivery",
    id: record.id,
    taskId: record.taskId,
    sourceNodeId: record.sourceNodeId,
    status: record.status,
    commits: record.commits,
    targetHead: record.targetHead,
    checksJson: record.checks.length ? JSON.stringify(record.checks) : undefined,
    artifactRefsJson: artifactRefs.length ? JSON.stringify(artifactRefs) : undefined,
    integrationMode: record.integrationMode,
    reviewBy: record.review?.by,
    reviewDecision: record.review?.decision,
    reviewNote: record.review?.note,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  await fs.writeFile(record.path, serializeFrontmatter(data, record.summary + "\n", KEY_ORDER));
}

export function roleDeliveryPath(roleId: string, id: string): string {
  return join(roleDeliveriesDir(roleId), `${id}.md`);
}

export function sessionDeliveryPath(sessionId: string, id: string): string {
  return join(sessionDeliveriesDir(sessionId), `${id}.md`);
}

function normalizeDeliveryPath(input: string): string {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/(roles|sessions)\/[^/]+\/deliveries\/dl-[^/]+\.md$/.test(path)) {
    throw new Error(
      "Delivery must point to temp/roles/<roleId>/deliveries/<dl-id>.md or temp/sessions/<sessionId>/deliveries/<dl-id>.md."
    );
  }
  return path;
}

function parseDeliveryStatus(value: unknown): DeliveryStatus {
  if (value === "draft" || value === "ready" || value === "accepted" || value === "rejected") return value;
  throw new Error(`Invalid delivery status: ${String(value)}`);
}

function parseIntegrationMode(value: unknown): IntegrationMode {
  if (value === undefined || value === null || value === "null") return null;
  if (value === "manual-accept" || value === "auto-accept" || value === "agent-decided-integrate") {
    return value;
  }
  throw new Error(`Invalid delivery integrationMode: ${String(value)}.`);
}

function parseJsonArrayField<T>(value: unknown, parse: (arr: unknown) => T[]): T[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    return parse(JSON.parse(value));
  } catch {
    return [];
  }
}

function parseChecks(value: unknown): DeliveryCheck[] {
  if (!Array.isArray(value)) return [];
  const out: DeliveryCheck[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.command !== "string" || typeof o.exitCode !== "number") continue;
    out.push({ name: o.name, command: o.command, exitCode: o.exitCode });
  }
  return out;
}

function parseArtifactRefsField(value: unknown, deliveryPath: string): ArtifactRef[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new Error(`Invalid delivery artifactRefsJson: ${deliveryPath}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Invalid delivery artifactRefsJson: ${deliveryPath}.`);
  }
  try {
    return normalizeArtifactRefs(parsed);
  } catch {
    throw new Error(`Invalid delivery artifact refs: ${deliveryPath}.`);
  }
}

async function ensureDir(fs: FsAdapter, path: string): Promise<void> {
  if (!(await fs.exists(path))) await fs.mkdir(path);
}

function uniqueCommits(commits: string[]): string[] {
  return [...new Set(commits.map((c) => c.trim()).filter(Boolean))];
}

/** Normalize optional full-SHA target HEAD; empty → undefined. */
function normalizeTargetHead(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
