import { withTentMutation, type Clock, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { loadTent, join } from "./tree.js";

export type ProposalStatus = "pending" | "accepted" | "rejected";

export interface Proposal {
  path: string;
  boxId: string;
  role: string;
  status: ProposalStatus;
  createdAt?: string;
  body: string;
}

export async function submitProposal(
  fs: FsAdapter,
  clock: Clock,
  role: string,
  boxId: string,
  body: string
): Promise<Proposal> {
  return withTentMutation(fs, async () => submitProposalUnlocked(fs, clock, role, boxId, body));
}

async function submitProposalUnlocked(
  fs: FsAdapter,
  clock: Clock,
  roleInput: string,
  boxId: string,
  body: string
): Promise<Proposal> {
  const text = body.trim();
  if (!text) throw new Error("Proposal body cannot be empty.");
  const role = normalizeRole(roleInput);
  const tent = await loadTent(fs);
  if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);

  const path = proposalPath(role, box.id);
  if (await fs.exists(path)) {
    const current = await loadProposal(fs, path);
    if (current.status === "pending") throw new Error("A proposal is already pending triage; the user must confirm or reject it first.");
  }

  const proposal: Proposal = {
    path,
    boxId: box.id,
    role,
    status: "pending",
    createdAt: clock.now(),
    body: text,
  };
  await ensureDir(fs, join("temp", role, "proposals"));
  await writeProposal(fs, proposal);
  return proposal;
}

export async function loadProposals(fs: FsAdapter): Promise<Proposal[]> {
  const proposals: Proposal[] = [];
  if (!(await fs.exists("temp"))) return proposals;
  for (const roleDir of await fs.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "proposals");
    if (!(await fs.exists(dir))) continue;
    for (const entry of await fs.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path = join(dir, entry.name);
      try {
        proposals.push(await loadProposal(fs, path));
      } catch {
        // Invalid temp documents stay inspectable on disk but do not enter UI state.
      }
    }
  }
  return proposals.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export async function loadProposal(fs: FsAdapter, inputPath: string): Promise<Proposal> {
  const path = normalizeProposalPath(inputPath);
  if (!(await fs.exists(path))) throw new Error(`Proposal not found: ${path}.`);
  const { data, body } = parseFrontmatter(await fs.readFile(path));
  if (
    data.type !== "proposal" ||
    typeof data.box !== "string" ||
    typeof data.role !== "string" ||
    (data.status !== "pending" && data.status !== "accepted" && data.status !== "rejected")
  ) {
    throw new Error(`Invalid proposal format: ${path}.`);
  }
  return {
    path,
    boxId: data.box,
    role: data.role,
    status: data.status,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : undefined,
    body: body.trim(),
  };
}

export async function acceptProposal(fs: FsAdapter, inputPath: string): Promise<void> {
  await withTentMutation(fs, async () => {
    const proposal = await loadProposal(fs, inputPath);
    if (proposal.status !== "pending") throw new Error("Only pending proposals can be accepted.");
    proposal.status = "accepted";
    await writeProposal(fs, proposal);
  });
}

export async function rejectProposal(fs: FsAdapter, inputPath: string): Promise<void> {
  await withTentMutation(fs, async () => {
    const proposal = await loadProposal(fs, inputPath);
    if (proposal.status !== "pending") throw new Error("Only pending proposals can be rejected.");
    proposal.status = "rejected";
    await writeProposal(fs, proposal);
  });
}

function proposalPath(role: string, boxId: string): string {
  return join("temp", role, "proposals", `${boxId}.md`);
}

function normalizeProposalPath(input: string): string {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/proposals\/bx-[^/]+\.md$/.test(path)) {
    throw new Error("Proposal must point to temp/<role>/proposals/<boxId>.md.");
  }
  return path;
}

async function writeProposal(fs: FsAdapter, proposal: Proposal): Promise<void> {
  const data: Record<string, unknown> = {
    type: "proposal",
    box: proposal.boxId,
    role: proposal.role,
    status: proposal.status,
    createdAt: proposal.createdAt,
  };
  await fs.writeFile(
    proposal.path,
    serializeFrontmatter(data, proposal.body + "\n", ["type", "box", "role", "status", "createdAt"])
  );
}

async function ensureDir(fs: FsAdapter, path: string): Promise<void> {
  if (!(await fs.exists(path))) await fs.mkdir(path);
}

function normalizeRole(role: string): string {
  const normalized = role.trim();
  if (!normalized) throw new Error("Proposal role cannot be empty; set TENT_ROLE before running tent propose.");
  if (normalized.includes("..") || /[\/\\\r\n]/.test(normalized)) throw new Error(`Invalid proposal role: ${role}`);
  return normalized;
}
