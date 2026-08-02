import { withTentMutation, type Clock, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { isNodeId } from "./id.js";
import { loadTent, join } from "./tree.js";

export type ProposalStatus = "pending" | "accepted" | "rejected";

export interface Proposal {
  path: string;
  nodeId: string;
  role: string;
  status: ProposalStatus;
  createdAt?: string;
  body: string;
}

export async function submitProposal(
  fs: FsAdapter,
  clock: Clock,
  role: string,
  nodeId: string,
  body: string
): Promise<Proposal> {
  return withTentMutation(fs, async () => submitProposalUnlocked(fs, clock, role, nodeId, body));
}

async function submitProposalUnlocked(
  fs: FsAdapter,
  clock: Clock,
  roleInput: string,
  nodeId: string,
  body: string
): Promise<Proposal> {
  const text = body.trim();
  if (!text) throw new Error("Proposal body cannot be empty.");
  const role = normalizeRole(roleInput);
  const tent = await loadTent(fs);
  if (tent.duplicateIds.has(nodeId)) {
    throw new Error(`Duplicate Node id '${nodeId}' found; repair the duplicate Nodes before using this id.`);
  }
  const node = tent.byId.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}.`);

  const path = proposalPath(role, node.id);
  if (await fs.exists(path)) {
    const current = await loadProposal(fs, path);
    if (current.status === "pending") throw new Error("A proposal is already pending triage; the user must confirm or reject it first.");
  }

  const proposal: Proposal = {
    path,
    nodeId: node.id,
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
    typeof data.nodeId !== "string" ||
    !isNodeId(data.nodeId) ||
    typeof data.role !== "string" ||
    (data.status !== "pending" && data.status !== "accepted" && data.status !== "rejected")
  ) {
    throw new Error(`Invalid proposal format: ${path}.`);
  }
  return {
    path,
    nodeId: data.nodeId,
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

function proposalPath(role: string, nodeId: string): string {
  return join("temp", role, "proposals", `${nodeId}.md`);
}

function normalizeProposalPath(input: string): string {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  const match = /^temp\/[^/]+\/proposals\/([^/]+)\.md$/.exec(path);
  if (!match || !isNodeId(match[1]!)) {
    throw new Error("Proposal must point to temp/<role>/proposals/<nodeId>.md.");
  }
  return path;
}

async function writeProposal(fs: FsAdapter, proposal: Proposal): Promise<void> {
  const data: Record<string, unknown> = {
    type: "proposal",
    nodeId: proposal.nodeId,
    role: proposal.role,
    status: proposal.status,
    createdAt: proposal.createdAt,
  };
  await fs.writeFile(
    proposal.path,
    serializeFrontmatter(data, proposal.body + "\n", ["type", "nodeId", "role", "status", "createdAt"])
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
