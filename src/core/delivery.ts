// Delivery operational entity (dl-) — task-api §1.3.
// Stored under temp/<role>/deliveries/<dl-id>.md (not OKF concepts).

import { withTentMutation, type Clock, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { join } from "./tree.js";
import {
  isDeliveryId,
  makeDeliveryId,
  type ArtifactRef,
  type DeliveryCheck,
  type DeliveryReview,
  type DeliveryStatus,
  type IntegrationMode,
} from "./task-model.js";

export interface DeliveryRecord {
  path: string;
  id: string;
  taskId: string;
  boxId: string;
  role: string;
  status: DeliveryStatus;
  summary: string;
  commits: string[];
  checks: DeliveryCheck[];
  artifactRefs: ArtifactRef[];
  integrationMode: IntegrationMode;
  review?: DeliveryReview;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateDeliveryInput {
  taskId: string;
  boxId: string;
  role: string;
  summary: string;
  commits?: string[];
  checks?: DeliveryCheck[];
  artifactRefs?: ArtifactRef[];
  status?: DeliveryStatus;
  integrationMode?: IntegrationMode;
  id?: string;
}

const KEY_ORDER = [
  "type",
  "id",
  "taskId",
  "boxId",
  "role",
  "status",
  "commits",
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
  const dir = join("temp", input.role, "deliveries");
  await ensureDir(fs, dir);
  const path = join(dir, `${id}.md`);
  if (await fs.exists(path)) throw new Error(`Delivery already exists: ${path}.`);

  const record: DeliveryRecord = {
    path,
    id,
    taskId: input.taskId,
    boxId: input.boxId,
    role: input.role,
    status: input.status ?? "ready",
    summary,
    commits: uniqueCommits(input.commits ?? []),
    checks: input.checks ?? [],
    artifactRefs: input.artifactRefs ?? [],
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
  const { data, body } = parseFrontmatter(await fs.readFile(path));
  if (data.type !== "delivery" || typeof data.id !== "string" || !isDeliveryId(data.id)) {
    throw new Error(`Invalid delivery format: ${path}.`);
  }
  if (typeof data.taskId !== "string" || typeof data.boxId !== "string" || typeof data.role !== "string") {
    throw new Error(`Invalid delivery format: ${path}.`);
  }
  const status = parseDeliveryStatus(data.status);
  const reviewBy = typeof data.reviewBy === "string" ? data.reviewBy : undefined;
  const reviewDecision =
    data.reviewDecision === "accept" || data.reviewDecision === "reject"
      ? data.reviewDecision
      : undefined;
  return {
    path,
    id: data.id,
    taskId: data.taskId,
    boxId: data.boxId,
    role: data.role,
    status,
    summary: body.trim(),
    commits: Array.isArray(data.commits)
      ? uniqueCommits(data.commits.filter((c): c is string => typeof c === "string"))
      : [],
    checks: parseJsonArrayField(data.checksJson, parseChecks),
    artifactRefs: parseJsonArrayField(data.artifactRefsJson, parseArtifactRefs),
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

export async function loadDeliveries(fs: FsAdapter, filter?: { taskId?: string; boxId?: string }): Promise<DeliveryRecord[]> {
  const out: DeliveryRecord[] = [];
  if (!(await fs.exists("temp"))) return out;
  for (const roleDir of await fs.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "deliveries");
    if (!(await fs.exists(dir))) continue;
    for (const entry of await fs.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      try {
        const d = await loadDelivery(fs, join(dir, entry.name));
        if (filter?.taskId && d.taskId !== filter.taskId) continue;
        if (filter?.boxId && d.boxId !== filter.boxId) continue;
        out.push(d);
      } catch {
        // Invalid operational files stay on disk but are skipped.
      }
    }
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export async function updateDelivery(
  fs: FsAdapter,
  clock: Clock,
  inputPath: string,
  patch: Partial<
    Pick<
      DeliveryRecord,
      "status" | "summary" | "commits" | "checks" | "artifactRefs" | "integrationMode" | "review"
    >
  >
): Promise<DeliveryRecord> {
  return withTentMutation(fs, async () => {
    const current = await loadDelivery(fs, inputPath);
    const next: DeliveryRecord = {
      ...current,
      ...patch,
      commits: patch.commits ? uniqueCommits(patch.commits) : current.commits,
      updatedAt: clock.now(),
    };
    await writeDelivery(fs, next);
    return next;
  });
}

export async function writeDelivery(fs: FsAdapter, record: DeliveryRecord): Promise<void> {
  const data: Record<string, unknown> = {
    type: "delivery",
    id: record.id,
    taskId: record.taskId,
    boxId: record.boxId,
    role: record.role,
    status: record.status,
    commits: record.commits,
    checksJson: record.checks.length ? JSON.stringify(record.checks) : undefined,
    artifactRefsJson: record.artifactRefs.length ? JSON.stringify(record.artifactRefs) : undefined,
    integrationMode: record.integrationMode,
    reviewBy: record.review?.by,
    reviewDecision: record.review?.decision,
    reviewNote: record.review?.note,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  await fs.writeFile(record.path, serializeFrontmatter(data, record.summary + "\n", KEY_ORDER));
}

export function deliveryPath(role: string, id: string): string {
  return join("temp", role, "deliveries", `${id}.md`);
}

function normalizeDeliveryPath(input: string): string {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/deliveries\/dl-[^/]+\.md$/.test(path)) {
    throw new Error("Delivery must point to temp/<role>/deliveries/<dl-id>.md.");
  }
  return path;
}

function parseDeliveryStatus(value: unknown): DeliveryStatus {
  if (value === "draft" || value === "ready" || value === "accepted" || value === "rejected") return value;
  throw new Error(`Invalid delivery status: ${String(value)}`);
}

function parseIntegrationMode(value: unknown): IntegrationMode {
  if (value === undefined || value === null || value === "null") return null;
  if (value === "manual-accept" || value === "bypass-auto" || value === "agent-decided-integrate") {
    return value;
  }
  return null;
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

function parseArtifactRefs(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  const out: ArtifactRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.kind !== "string" || typeof o.target !== "string") continue;
    if (!["path", "dir", "commit", "url", "other"].includes(o.kind)) continue;
    out.push({
      kind: o.kind as ArtifactRef["kind"],
      target: o.target,
      label: typeof o.label === "string" ? o.label : undefined,
    });
  }
  return out;
}

async function ensureDir(fs: FsAdapter, path: string): Promise<void> {
  if (!(await fs.exists(path))) await fs.mkdir(path);
}

function uniqueCommits(commits: string[]): string[] {
  return [...new Set(commits.map((c) => c.trim()).filter(Boolean))];
}
