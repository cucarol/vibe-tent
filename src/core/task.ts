import { Clock, FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { join } from "./tree.js";
import type { RoleDefinition } from "./skillRoleRegistry.js";

export interface RoleWorkspaceContract {
  workspace: string;
  worktree: string;
  branch: string;
  targetBranch: string;
}

export interface TaskEnvelopeInput {
  role: string;
  claims: { id: string; path: string }[];
  manifestPath: string;
  userPrompt: string;
  workspace?: RoleWorkspaceContract;
  dispatchedBy?: string;
}

export type TaskEnvelopeStatus = "pending" | "taken";

export interface TaskEnvelope {
  path: string;
  role: string;
  claims: string[];
  manifest: string;
  status: TaskEnvelopeStatus;
  dispatchedBy?: string;
  workspace?: string;
  worktree?: string;
  branch?: string;
  targetBranch?: string;
}

export async function loadTaskEnvelopes(fs: FsAdapter): Promise<TaskEnvelope[]> {
  const tasks: TaskEnvelope[] = [];
  if (!(await fs.exists("temp"))) return tasks;
  for (const roleEntry of await fs.listDir("temp")) {
    if (!roleEntry.isDir) continue;
    const taskDir = join("temp", roleEntry.name, "tasks");
    if (!(await fs.exists(taskDir))) continue;
    for (const entry of await fs.listDir(taskDir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path = join(taskDir, entry.name);
      try {
        const { data } = parseFrontmatter(await fs.readFile(path));
        if (
          data.type !== "task" ||
          typeof data.role !== "string" ||
          typeof data.manifest !== "string" ||
          !Array.isArray(data.claims) ||
          !data.claims.every((claim) => typeof claim === "string")
        ) {
          continue;
        }
        const task: TaskEnvelope = {
          path,
          role: data.role,
          claims: data.claims,
          manifest: data.manifest,
          status: data.status === "taken" ? "taken" : "pending",
        };
        if (typeof data.dispatchedBy === "string") task.dispatchedBy = data.dispatchedBy;
        if (typeof data.workspace === "string") task.workspace = data.workspace;
        if (typeof data.worktree === "string") task.worktree = data.worktree;
        if (typeof data.branch === "string") task.branch = data.branch;
        if (typeof data.targetBranch === "string") task.targetBranch = data.targetBranch;
        tasks.push(task);
      } catch {
        // Invalid temp documents stay inspectable on disk but do not enter UI state.
      }
    }
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}

export function relayPromptForTask(task: TaskEnvelope, tentRoot: string): string {
  const initPath = join("temp", task.role, "init.md");
  return (
    `A Tent task has been dispatched to role ${task.role}.\n` +
    `Tent root: ${tentRoot}\n` +
    `1. Run \`tent task-ack ${task.path}\` to take this task.\n` +
    `2. Read the envelope, then open the claimed boxes; the box notes contain the task definition.\n` +
    `3. If this is a new session for this role, complete role init first: ${initPath}.`
  );
}

export async function ensureRoleInit(
  fs: FsAdapter,
  role: RoleDefinition,
  tentName: string
): Promise<string> {
  const path = join("temp", role.name, "init.md");
  const body =
    `# Role Init\n\n` +
    `- Tent: ${tentName}\n` +
    `- Rules: RULES.md\n` +
    `- Role registry: .tent/roles.json (or run \`tent roles\`)\n\n` +
    `## Role Prompt\n\n${role.prompt?.trim() || "(no persistent role prompt)"}\n\n` +
    `## Operating Model\n\n` +
    `Manifest readable/writable entries are an honor-system contract, not a security sandbox. If prompts conflict or a boundary cannot be followed, stop and ask the user.\n`;
  await fs.writeFile(path, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path;
}

export async function writeTaskEnvelope(
  fs: FsAdapter,
  clock: Clock,
  input: TaskEnvelopeInput
): Promise<string> {
  const userPrompt = input.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");

  const dir = join("temp", input.role, "tasks");
  await ensureDir(fs, dir);
  const stem = taskStem(clock.now(), input.claims[0]?.id || "root");
  const path = await uniqueMarkdownPath(fs, dir, stem);
  const data: Record<string, unknown> = {
    type: "task",
    status: "pending",
    role: input.role,
    dispatchedBy: input.dispatchedBy?.trim() || "user",
    claims: input.claims.map((claim) => claim.id),
    manifest: input.manifestPath,
  };
  if (input.workspace) {
    data.workspace = input.workspace.workspace;
    data.worktree = input.workspace.worktree;
    data.branch = input.workspace.branch;
    data.targetBranch = input.workspace.targetBranch;
  }

  const pointers = input.claims.map((claim) => `- ${claim.id}: ${claim.path}`).join("\n");
  const body =
    `# Task\n\n` +
    `## Context Pointers\n\n${pointers}\n\n` +
    `- Manifest: ${input.manifestPath}\n` +
    `\n## User Prompt\n\n${userPrompt}\n`;
  await fs.writeFile(path, serializeFrontmatter(data, body));
  return path;
}

export async function ackTaskEnvelope(fs: FsAdapter, path: string): Promise<void> {
  if (!(await fs.exists(path))) throw new Error(`Task envelope not found: ${path}.`);
  const raw = await fs.readFile(path);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") throw new Error(`Invalid task envelope format: ${path}.`);
  data.status = "taken";
  await fs.writeFile(path, serializeFrontmatter(data, body, keyOrder));
}

function taskStem(now: string, claimId: string): string {
  const stamp = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 14) || "task";
  return `task-${stamp}-${claimId.replace(/[^0-9A-Za-z_-]+/g, "-")}`;
}

async function uniqueMarkdownPath(fs: FsAdapter, dir: string, stem: string): Promise<string> {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path = join(dir, `${stem}${suffix}.md`);
    if (!(await fs.exists(path))) return path;
  }
}

async function ensureDir(fs: FsAdapter, path: string): Promise<void> {
  if (!(await fs.exists(path))) await fs.mkdir(path);
}
