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
  userPrompt?: string;
  handoffPath?: string;
  workspace?: RoleWorkspaceContract;
}

export interface TaskEnvelope {
  path: string;
  role: string;
  claims: string[];
  manifest: string;
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
        tasks.push({
          path,
          role: data.role,
          claims: data.claims,
          manifest: data.manifest,
        });
      } catch {
        // Invalid temp documents stay inspectable on disk but do not enter UI state.
      }
    }
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}

export function relayPromptForTask(task: TaskEnvelope): string {
  const initPath = join("temp", task.role, "init.md");
  return (
    `读取 ${task.path} 并执行。若这是该 role 的新会话,先按 ${initPath} 完成 role init；` +
    `是否复用旧会话由 user 决定。`
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
    `## Role Prompt\n\n${role.prompt?.trim() || "(无长期 role prompt)"}\n\n` +
    `## Operating Model\n\n` +
    `Manifest 的 readable/writable 是 honor contract，不是安全沙箱。遇到 prompt 冲突或无法遵守的边界时，停止并询问 user。\n`;
  await fs.writeFile(path, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path;
}

export async function writeTaskEnvelope(
  fs: FsAdapter,
  clock: Clock,
  input: TaskEnvelopeInput
): Promise<string> {
  const userPrompt = input.userPrompt?.trim() || "";
  const handoffPath = input.handoffPath?.trim() || "";
  if (!userPrompt && !handoffPath) throw new Error("派活至少需要 user prompt 或 handoff prompt");

  const dir = join("temp", input.role, "tasks");
  await ensureDir(fs, dir);
  const stem = taskStem(clock.now(), input.claims[0]?.id || "root");
  const path = await uniqueMarkdownPath(fs, dir, stem);
  const data: Record<string, unknown> = {
    type: "task",
    role: input.role,
    claims: input.claims.map((claim) => claim.id),
    manifest: input.manifestPath,
  };
  if (handoffPath) data.handoff = handoffPath;
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
    (handoffPath ? `- Handoff: ${handoffPath}\n` : "") +
    (userPrompt ? `\n## User Prompt\n\n${userPrompt}\n` : "");
  await fs.writeFile(path, serializeFrontmatter(data, body));
  return path;
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
