import { withTentMutation, type Clock, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { loadTent, join } from "./tree.js";

export type ReportStatus = "ready" | "rejected";

export interface DeliveryReport {
  path: string;
  boxId: string;
  role: string;
  status: ReportStatus;
  commits: string[];
  timestamp?: string;
  review?: string;
  body: string;
}

export async function submitReport(
  fs: FsAdapter,
  clock: Clock,
  boxId: string,
  body: string,
  commits: string[]
): Promise<DeliveryReport> {
  return withTentMutation(fs, async () => submitReportUnlocked(fs, clock, boxId, body, commits));
}

async function submitReportUnlocked(
  fs: FsAdapter,
  clock: Clock,
  boxId: string,
  body: string,
  commits: string[]
): Promise<DeliveryReport> {
  const text = body.trim();
  if (!text) throw new Error("Report body cannot be empty.");
  const tent = await loadTent(fs);
  if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  const role = box.fm.owner;
  if (!role) throw new Error("Only claimed boxes with a direct owner can submit reports.");

  const path = reportPath(role, box.id);
  if (await fs.exists(path)) {
    const current = await loadReport(fs, path);
    if (current.status === "ready") throw new Error("A report is already pending triage; the user must confirm or reject it first.");
  }

  const report: DeliveryReport = {
    path,
    boxId: box.id,
    role,
    status: "ready",
    commits: uniqueCommits(commits),
    timestamp: clock.now(),
    body: text,
  };
  await ensureDir(fs, join("temp", role, "reports"));
  await writeReport(fs, report);
  return report;
}

export async function loadReports(fs: FsAdapter): Promise<DeliveryReport[]> {
  const reports: DeliveryReport[] = [];
  if (!(await fs.exists("temp"))) return reports;
  for (const roleDir of await fs.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "reports");
    if (!(await fs.exists(dir))) continue;
    for (const entry of await fs.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path = join(dir, entry.name);
      try {
        reports.push(await loadReport(fs, path));
      } catch {
        // Invalid temp documents stay inspectable on disk but do not enter UI state.
      }
    }
  }
  return reports.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
}

export async function loadReport(fs: FsAdapter, inputPath: string): Promise<DeliveryReport> {
  const path = normalizeReportPath(inputPath);
  if (!(await fs.exists(path))) throw new Error(`Report not found: ${path}.`);
  const { data, body } = parseFrontmatter(await fs.readFile(path));
  if (
    data.type !== "report" ||
    typeof data.box !== "string" ||
    typeof data.role !== "string" ||
    (data.status !== "ready" && data.status !== "rejected")
  ) {
    throw new Error(`Invalid report format: ${path}.`);
  }
  return {
    path,
    boxId: data.box,
    role: data.role,
    status: data.status,
    commits: Array.isArray(data.commits)
      ? uniqueCommits(data.commits.filter((item): item is string => typeof item === "string"))
      : [],
    timestamp: typeof data.ts === "string" ? data.ts : undefined,
    review: typeof data.review === "string" ? data.review : undefined,
    body: body.trim(),
  };
}

export async function rejectReport(fs: FsAdapter, inputPath: string, review?: string): Promise<void> {
  await withTentMutation(fs, async () => {
    const report = await loadReport(fs, inputPath);
    if (report.status !== "ready") throw new Error("Only ready reports can be rejected.");
    report.status = "rejected";
    report.review = review?.trim() || "User rejected; waiting for resubmission.";
    await writeReport(fs, report);
  });
}

export async function removeReportsForBox(fs: FsAdapter, boxId: string): Promise<void> {
  for (const report of await loadReports(fs)) {
    if (report.boxId === boxId && await fs.exists(report.path)) await fs.remove(report.path);
  }
}

function reportPath(role: string, boxId: string): string {
  return join("temp", role, "reports", `${boxId}.md`);
}

function normalizeReportPath(input: string): string {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/reports\/bx-[^/]+\.md$/.test(path)) {
    throw new Error("Report must point to temp/<role>/reports/<boxId>.md.");
  }
  return path;
}

async function writeReport(fs: FsAdapter, report: DeliveryReport): Promise<void> {
  const data: Record<string, unknown> = {
    type: "report",
    box: report.boxId,
    role: report.role,
    status: report.status,
    commits: report.commits,
    ts: report.timestamp,
    review: report.review,
  };
  await fs.writeFile(
    report.path,
    serializeFrontmatter(data, report.body + "\n", ["type", "box", "role", "status", "commits", "ts", "review"])
  );
}

async function ensureDir(fs: FsAdapter, path: string): Promise<void> {
  if (!(await fs.exists(path))) await fs.mkdir(path);
}

function uniqueCommits(commits: string[]): string[] {
  return [...new Set(commits.map((item) => item.trim()).filter(Boolean))];
}
