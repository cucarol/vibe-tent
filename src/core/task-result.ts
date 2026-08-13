// Immutable Task Result payload with a mutable review projection (rs-).
// Stored under the exact Task Role/Session operational namespace (not Nodes).

import { withTentMutation, type Clock, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import {
  normalizeArtifactRefs,
  type ArtifactRef,
} from "./artifact.js";
import { canonicalSha256, sha256Hex } from "./canonical-digest.js";
import {
  ROLES_TEMP_DIR,
  SESSIONS_TEMP_DIR,
  roleTaskResultsDir,
  sessionTaskResultsDir,
  TEMP_DIR,
} from "./paths.js";
import { join } from "./tree.js";
import {
  isTaskResultId,
  isTaskId,
  makeTaskResultId,
  type TaskResultCheck,
  type TaskResultReview,
  type TaskResultStatus,
  type IntegrationMode,
} from "./task-model.js";
import { assertIsoTimestamp } from "./task.js";

export interface TaskResultRecord {
  path: string;
  id: string;
  taskId: string;
  status: TaskResultStatus;
  report: string;
  commits: string[];
  /**
   * Full SHA of the resolved integration target branch HEAD at Result creation
   * (commit-bearing only). Compared again before accept / auto-integrate.
   */
  targetHead?: string;
  checks: TaskResultCheck[];
  artifactRefs: ArtifactRef[];
  integrationMode: IntegrationMode;
  review?: TaskResultReview;
  createdAt: string;
}

export interface CreateTaskResultInput {
  taskId: string;
  report: string;
  commits?: string[];
  /**
   * Required for new commit-bearing ready Results: resolved target branch HEAD
   * at creation/review time. Omitted for zero-commit Results.
   */
  targetHead?: string;
  checks?: TaskResultCheck[];
  artifactRefs?: ArtifactRef[];
  status?: TaskResultStatus;
  integrationMode?: IntegrationMode;
  id?: string;
  /**
   * When set, write under this results directory (relative system root).
   * Derived from the Task's canonical Role/Session namespace.
   */
  resultsDir: string;
}

const KEY_ORDER = [
  "type",
  "id",
  "taskId",
  "status",
  "commits",
  "targetHead",
  "checksJson",
  "artifactRefsJson",
  "integrationMode",
  "reviewer",
  "reviewAt",
  "reviewNote",
  "createdAt",
];

export async function createTaskResult(
  fs: FsAdapter,
  clock: Clock,
  input: CreateTaskResultInput
): Promise<TaskResultRecord> {
  return withTentMutation(fs, () => createTaskResultUnlocked(fs, clock, input));
}

export async function createTaskResultUnlocked(
  fs: FsAdapter,
  clock: Clock,
  input: CreateTaskResultInput
): Promise<TaskResultRecord> {
  const record = buildTaskResultRecord(clock, input);
  const resultsDir = input.resultsDir.trim();
  if (!resultsDir) throw new Error("Task Result resultsDir cannot be empty.");
  await ensureDir(fs, resultsDir);
  if (await fs.exists(record.path)) throw new Error(`Task Result already exists: ${record.path}.`);
  await writeTaskResult(fs, record);
  return record;
}

/** Build the exact immutable Result candidate before its publication intent is written. */
export function buildTaskResultRecord(
  clock: Clock,
  input: CreateTaskResultInput
): TaskResultRecord {
  const report = input.report.trim();
  if (!report) throw new Error("Task Result report cannot be empty.");
  if (!isCanonicalTaskId(input.taskId)) {
    throw new Error(`Task Result taskId must be canonical: ${input.taskId}.`);
  }
  if (input.id !== undefined && !isCanonicalTaskResultId(input.id)) {
    throw new Error(`Task Result id must be canonical: ${input.id}.`);
  }
  const id = input.id ?? makeTaskResultId();
  const resultsDir = input.resultsDir.trim();
  if (!resultsDir) throw new Error("Task Result resultsDir cannot be empty.");
  const targetHead = normalizeTargetHead(input.targetHead);
  const createdAt = assertIsoTimestamp(clock.now(), "Task Result createdAt");
  const record: TaskResultRecord = {
    path: join(resultsDir, `${id}.md`),
    id,
    taskId: input.taskId,
    status: input.status ?? "ready",
    report,
    commits: normalizeTaskResultCommits(input.commits ?? [], "Task Result commits"),
    ...(targetHead ? { targetHead } : {}),
    checks: normalizeChecks(input.checks ?? [], "Task Result checks"),
    artifactRefs: normalizeArtifactRefs(input.artifactRefs ?? []),
    integrationMode: input.integrationMode ?? null,
    createdAt,
  };
  assertTaskResultRecord(record);
  return record;
}

export async function loadTaskResult(fs: FsAdapter, inputPath: string): Promise<TaskResultRecord> {
  const path = normalizeTaskResultPath(inputPath);
  if (!(await fs.exists(path))) throw new Error(`Task Result not found: ${path}.`);
  const raw = await fs.readFile(path);
  const identity = parseTaskResultIdentityFromRaw(raw);
  const { data, body } = parseFrontmatter(raw);
  if (
    !identity ||
    data.type !== "task-result" ||
    data.id !== identity.id ||
    data.taskId !== identity.taskId ||
    !path.endsWith(`/${identity.id}.md`)
  ) {
    throw new Error(`Invalid Task Result format: ${path}.`);
  }
  if (
    typeof data.taskId !== "string" ||
    !isCanonicalTaskId(data.taskId) ||
    typeof data.createdAt !== "string"
  ) {
    throw new Error(`Invalid Task Result format: ${path}.`);
  }
  const status = parseTaskResultStatus(data.status);
  const createdAt = assertIsoTimestamp(data.createdAt, "Task Result createdAt");
  const hasReviewer = Object.prototype.hasOwnProperty.call(data, "reviewer");
  const hasReviewAt = Object.prototype.hasOwnProperty.call(data, "reviewAt");
  const hasReviewNote = Object.prototype.hasOwnProperty.call(data, "reviewNote");
  const reviewer = typeof data.reviewer === "string" && data.reviewer.trim()
    ? data.reviewer.trim()
    : undefined;
  const reviewAt = typeof data.reviewAt === "string"
    ? assertIsoTimestamp(data.reviewAt, "Task Result reviewAt")
    : undefined;
  if (
    (status === "ready" && (hasReviewer || hasReviewAt || hasReviewNote)) ||
    (status !== "ready" && (!reviewer || !reviewAt)) ||
    (hasReviewer !== hasReviewAt) ||
    (hasReviewNote && typeof data.reviewNote !== "string")
  ) {
    throw new Error(`Invalid Task Result review projection: ${path}.`);
  }
  const report = body.trim();
  if (!report) throw new Error(`Invalid Task Result report: ${path}.`);
  const commits = parseCanonicalCommits(data.commits, path);
  if (data.targetHead !== undefined && typeof data.targetHead !== "string") {
    throw new Error(`Invalid Task Result targetHead: ${path}.`);
  }
  const targetHead = normalizeTargetHead(data.targetHead as string | undefined);
  const record: TaskResultRecord = {
    path,
    id: data.id,
    taskId: data.taskId,
    status,
    report,
    commits,
    ...(targetHead ? { targetHead } : {}),
    checks: parseChecksField(data.checksJson, path),
    artifactRefs: parseArtifactRefsField(data.artifactRefsJson, path),
    integrationMode: parseIntegrationMode(data.integrationMode),
    review: reviewer && reviewAt
      ? {
          reviewer,
          at: reviewAt,
          note: typeof data.reviewNote === "string" ? data.reviewNote : undefined,
        }
      : undefined,
    createdAt,
  };
  assertTaskResultRecord(record);
  return record;
}

const TASK_RESULT_IDENTITY_PREFIX_MAX_BYTES = 1024;

/**
 * Bounded identity peek for shared owner Result directories. It deliberately
 * validates only enough frontmatter to attribute a file to one exact Task;
 * matching files still go through loadTaskResult's complete strict parser.
 */
export async function peekTaskResultTaskId(
  fs: FsAdapter,
  inputPath: string
): Promise<string | undefined> {
  return (await peekTaskResultIdentity(fs, inputPath))?.taskId;
}

export async function peekTaskResultIdentity(
  fs: FsAdapter,
  inputPath: string
): Promise<{ id: string; taskId: string } | undefined> {
  const path = normalizeTaskResultIdentityPath(inputPath);
  if (!fs.readBinaryBounded) {
    throw new Error("Task Result identity discovery requires bounded prefix reads.");
  }
  let bounded: Awaited<ReturnType<NonNullable<FsAdapter["readBinaryBounded"]>>>;
  try {
    bounded = await fs.readBinaryBounded(path, TASK_RESULT_IDENTITY_PREFIX_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // Non-fatal decoding is intentional: an exact byte prefix may end halfway
  // through a later multibyte frontmatter/body value after the ASCII identity.
  const raw = new TextDecoder("utf-8").decode(bounded.bytes);
  return parseTaskResultIdentityFromRaw(raw);
}

/**
 * The full loader and bounded inventory share this exact identity invariant.
 * Canonical scalar identity fields may be reordered, but must all occur once
 * in the opening bounded frontmatter and agree with the complete parse.
 */
export function parseTaskResultIdentityFromRaw(
  raw: string
): { id: string; taskId: string } | undefined {
  // Encode only a bounded character prefix, then cut to the exact byte limit.
  // This preserves the inventory hard bound without allocating a second copy
  // of a potentially multi-megabyte report in the full loader.
  const prefixBytes = new TextEncoder().encode(raw.slice(0, TASK_RESULT_IDENTITY_PREFIX_MAX_BYTES));
  const prefix = new TextDecoder("utf-8").decode(
    prefixBytes.subarray(0, TASK_RESULT_IDENTITY_PREFIX_MAX_BYTES)
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
  return type === "task-result" && id && taskId && isTaskResultId(id) && /^tk-[a-z0-9]+$/.test(taskId)
    ? { id, taskId }
    : undefined;
}

/** Fixed-size proof that every immutable review candidate fact is unchanged. */
export function taskResultReviewSemanticsDigest(record: TaskResultRecord): string {
  return canonicalSha256({
    version: 1,
    id: record.id,
    taskId: record.taskId,
    status: record.status,
    reportSha256: sha256Hex(record.report),
    commits: [...record.commits],
    targetHead: record.targetHead ?? null,
    checks: record.checks.map((check) => ({ ...check })),
    artifactRefs: normalizeArtifactRefs(record.artifactRefs),
    integrationMode: record.integrationMode,
    review: record.review ? { ...record.review } : null,
    createdAt: record.createdAt,
  });
}

/**
 * Ready-candidate facts that manual acceptance must preserve through its WAL.
 * status/review are excluded because review advances exactly those projections.
 */
export function taskResultAcceptCandidateDigest(record: TaskResultRecord): string {
  return canonicalSha256({
    version: 1,
    id: record.id,
    taskId: record.taskId,
    reportSha256: sha256Hex(record.report),
    commits: [...record.commits],
    targetHead: record.targetHead ?? null,
    checks: record.checks.map((check) => ({ ...check })),
    artifactRefs: normalizeArtifactRefs(record.artifactRefs),
    integrationMode: record.integrationMode,
    createdAt: record.createdAt,
  });
}

function normalizeTaskResultIdentityPath(input: string): string {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/(roles|sessions)\/[^/]+\/results\/rs-[^/]+\.md$/i.test(path)) {
    throw new Error(
      "Task Result identity must point under a Role/Session results directory."
    );
  }
  return path;
}

export async function loadTaskResults(
  fs: FsAdapter,
  filter?: { taskId?: string }
): Promise<TaskResultRecord[]> {
  const out: TaskResultRecord[] = [];
  if (!(await fs.exists(TEMP_DIR))) return out;
  for (const entry of await fs.listDir(TEMP_DIR)) {
    if (!entry.isDir || (entry.name !== ROLES_TEMP_DIR && entry.name !== SESSIONS_TEMP_DIR)) continue;
    const ownerRoot = join(TEMP_DIR, entry.name);
    for (const ownerEntry of await fs.listDir(ownerRoot)) {
      if (!ownerEntry.isDir) continue;
      await collectTaskResultFiles(fs, join(ownerRoot, ownerEntry.name, "results"), filter, out);
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

async function collectTaskResultFiles(
  fs: FsAdapter,
  dir: string,
  filter: { taskId?: string } | undefined,
  out: TaskResultRecord[]
): Promise<void> {
  if (!(await fs.exists(dir))) return;
  for (const entry of await fs.listDir(dir)) {
    if (entry.isDir || !/^rs-[a-z0-9]+\.md$/.test(entry.name)) continue;
    const d = await loadTaskResult(fs, join(dir, entry.name));
    if (filter?.taskId && d.taskId !== filter.taskId) continue;
    out.push(d);
  }
}

export async function writeTaskResult(fs: FsAdapter, record: TaskResultRecord): Promise<void> {
  assertTaskResultRecord(record);
  if (!isCanonicalTaskResultId(record.id) || !record.path.endsWith(`/${record.id}.md`)) {
    throw new Error(`Task Result path must match its exact canonical id: ${record.path}.`);
  }
  const artifactRefs = normalizeArtifactRefs(record.artifactRefs);
  if (await fs.exists(record.path)) {
    const current = await loadTaskResult(fs, record.path);
    assertTaskResultWriteTransition(current, record);
  }
  const data: Record<string, unknown> = {
    type: "task-result",
    id: record.id,
    taskId: record.taskId,
    status: record.status,
    commits: record.commits,
    targetHead: record.targetHead,
    checksJson: record.checks.length ? JSON.stringify(record.checks) : undefined,
    artifactRefsJson: artifactRefs.length ? JSON.stringify(artifactRefs) : undefined,
    integrationMode: record.integrationMode,
    reviewer: record.review?.reviewer,
    reviewAt: record.review?.at,
    reviewNote: record.review?.note,
    createdAt: record.createdAt,
  };
  await fs.writeFile(record.path, serializeFrontmatter(data, record.report + "\n", KEY_ORDER));
}

function assertTaskResultWriteTransition(
  current: TaskResultRecord,
  next: TaskResultRecord
): void {
  if (taskResultAcceptCandidateDigest(current) !== taskResultAcceptCandidateDigest(next)) {
    throw new Error(`Task Result payload is immutable after creation: ${current.path}.`);
  }
  if (current.status === next.status) {
    if (taskResultReviewSemanticsDigest(current) !== taskResultReviewSemanticsDigest(next)) {
      throw new Error(`Task Result review projection cannot be rewritten: ${current.path}.`);
    }
    return;
  }
  if (current.status !== "ready" || (next.status !== "accepted" && next.status !== "rejected")) {
    throw new Error(
      `Task Result review may transition only once from ready to accepted or rejected: ${current.path}.`
    );
  }
}

export function roleTaskResultPath(roleId: string, id: string): string {
  return join(roleTaskResultsDir(roleId), `${id}.md`);
}

export function sessionTaskResultPath(sessionId: string, id: string): string {
  return join(sessionTaskResultsDir(sessionId), `${id}.md`);
}

/** Direct exact-Task Result path. No Result inventory/history discovery. */
export function taskResultPathForTask(taskPath: string, resultId: string): string {
  const normalizedTaskPath = taskPath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!isTaskResultId(resultId)) {
    throw new Error(`Invalid Task Result id: ${resultId}.`);
  }
  const owner = /^(temp\/(?:roles|sessions)\/[^/]+)\/tasks\/[^/]+\.md$/.exec(
    normalizedTaskPath
  )?.[1];
  if (!owner) {
    throw new Error(`Task has no canonical Result namespace: ${taskPath}.`);
  }
  return `${owner}/results/${resultId}.md`;
}

function normalizeTaskResultPath(input: string): string {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/(roles|sessions)\/[^/]+\/results\/rs-[^/]+\.md$/.test(path)) {
    throw new Error(
      "Task Result must point to temp/roles/<roleId>/results/<rs-id>.md or temp/sessions/<sessionId>/results/<rs-id>.md."
    );
  }
  return path;
}

function parseTaskResultStatus(value: unknown): TaskResultStatus {
  if (value === "ready" || value === "accepted" || value === "rejected") return value;
  throw new Error(`Invalid Task Result status: ${String(value)}`);
}

function parseIntegrationMode(value: unknown): IntegrationMode {
  if (value === undefined || value === null || value === "null") return null;
  if (value === "auto-accept" || value === "agent-decided-integrate") {
    return value;
  }
  throw new Error(`Invalid Task Result integrationMode: ${String(value)}.`);
}

function parseChecksField(value: unknown, resultPath: string): TaskResultCheck[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new Error(`Invalid Task Result checksJson: ${resultPath}.`);
  }
  try {
    return normalizeChecks(JSON.parse(value), `Task Result checks: ${resultPath}`);
  } catch {
    throw new Error(`Invalid Task Result checksJson: ${resultPath}.`);
  }
}

function normalizeChecks(value: unknown, label: string): TaskResultCheck[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label}[${index}] is invalid.`);
    }
    const o = item as Record<string, unknown>;
    if (
      Object.keys(o).some((key) => key !== "name" && key !== "command" && key !== "exitCode") ||
      typeof o.name !== "string" ||
      !o.name.trim() ||
      typeof o.command !== "string" ||
      !o.command.trim() ||
      typeof o.exitCode !== "number" ||
      !Number.isInteger(o.exitCode)
    ) {
      throw new Error(`${label}[${index}] is invalid.`);
    }
    return { name: o.name.trim(), command: o.command.trim(), exitCode: o.exitCode };
  });
}

function parseArtifactRefsField(value: unknown, resultPath: string): ArtifactRef[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new Error(`Invalid Task Result artifactRefsJson: ${resultPath}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Invalid Task Result artifactRefsJson: ${resultPath}.`);
  }
  try {
    return normalizeArtifactRefs(parsed);
  } catch {
    throw new Error(`Invalid Task Result artifact refs: ${resultPath}.`);
  }
}

async function ensureDir(fs: FsAdapter, path: string): Promise<void> {
  if (!(await fs.exists(path))) await fs.mkdir(path);
}

function uniqueCommits(commits: string[]): string[] {
  return [...new Set(commits.map((c) => c.trim()).filter(Boolean))];
}

function normalizeTaskResultCommits(commits: string[], label: string): string[] {
  const normalized = uniqueCommits(commits);
  if (normalized.some((commit) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))) {
    throw new Error(`${label} must contain canonical full 40- or 64-character Git object ids.`);
  }
  return normalized;
}

function parseCanonicalCommits(value: unknown, resultPath: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid Task Result commits: ${resultPath}.`);
  }
  const commits = normalizeTaskResultCommits(value as string[], "Task Result commits");
  if (
    commits.length !== value.length ||
    commits.some((commit, index) => commit !== value[index])
  ) {
    throw new Error(`Non-canonical Task Result commits: ${resultPath}.`);
  }
  return commits;
}

function assertTaskResultRecord(record: TaskResultRecord): void {
  if (!isCanonicalTaskResultId(record.id) || !isCanonicalTaskId(record.taskId)) {
    throw new Error("Task Result identity must be canonical.");
  }
  if (!record.report.trim()) throw new Error("Task Result report cannot be empty.");
  assertIsoTimestamp(record.createdAt, "Task Result createdAt");
  parseTaskResultStatus(record.status);
  parseIntegrationMode(record.integrationMode);
  const commits = normalizeTaskResultCommits(record.commits, "Task Result commits");
  if (
    commits.length !== record.commits.length ||
    commits.some((commit, index) => commit !== record.commits[index])
  ) {
    throw new Error("Task Result commits must be canonical.");
  }
  if (commits.length > 0 && !record.targetHead) {
    throw new Error("Commit-bearing Task Result requires a canonical targetHead.");
  }
  if (commits.length === 0 && record.targetHead !== undefined) {
    throw new Error("Zero-commit Task Result cannot carry targetHead.");
  }
  if (record.targetHead !== undefined) normalizeTargetHead(record.targetHead);
  normalizeChecks(record.checks, "Task Result checks");
  normalizeArtifactRefs(record.artifactRefs);
  if (record.status === "ready") {
    if (record.review !== undefined) {
      throw new Error("Ready Task Result cannot carry a review projection.");
    }
    return;
  }
  if (!record.review?.reviewer.trim()) {
    throw new Error(`${record.status} Task Result requires a reviewer.`);
  }
  assertIsoTimestamp(record.review.at, "Task Result reviewAt");
  if (record.review.note !== undefined && typeof record.review.note !== "string") {
    throw new Error("Task Result review note must be a string.");
  }
}

function isCanonicalTaskResultId(value: string): boolean {
  return isTaskResultId(value) && /^rs-[a-z0-9]+$/.test(value);
}

function isCanonicalTaskId(value: string): boolean {
  return isTaskId(value) && /^tk-[a-z0-9]+$/.test(value);
}

/** Normalize optional full-SHA target HEAD; empty → undefined. */
function normalizeTargetHead(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value !== value.trim() ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  ) {
    throw new Error("Task Result targetHead must be a canonical full 40- or 64-character Git object id.");
  }
  return value;
}
