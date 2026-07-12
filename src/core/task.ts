import { Clock, FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { join } from "./tree.js";
import type { RoleDefinition } from "./skillRoleRegistry.js";
import {
  isTaskId,
  legacyStatusToState,
  makeTaskId,
  stateToLegacyStatus,
  type AssigneeKind,
  type DeliveryPolicy,
  type TaskState,
  type TaskWait,
  type WorkspaceLane,
} from "./task-model.js";

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
  /** Full operational id (tk-…). Generated if omitted. */
  id?: string;
  deliveryPolicy?: DeliveryPolicy;
  assigneeKind?: AssigneeKind;
  sessionId?: string;
}

/** Legacy two-state for B2 / dogfood CLI. */
export type TaskEnvelopeStatus = "pending" | "taken";

/**
 * Operational task record.
 * - `status` is the legacy envelope field (pending|taken) kept for B2 projections.
 * - `state` is the full lifecycle state (task-api §2).
 */
export interface TaskEnvelope {
  path: string;
  role: string;
  claims: string[];
  manifest: string;
  status: TaskEnvelopeStatus;
  /** Full lifecycle state; always derived for legacy files. */
  state: TaskState;
  /** Operational task id (tk-…). May be absent on pre-B4 envelopes. */
  id?: string;
  dispatchedBy?: string;
  workspace?: string;
  worktree?: string;
  branch?: string;
  targetBranch?: string;
  deliveryPolicy?: DeliveryPolicy;
  assigneeKind?: AssigneeKind;
  sessionId?: string;
  wait?: TaskWait;
  activeDeliveryId?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Immutable user prompt body (after frontmatter). */
  prompt?: string;
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
        tasks.push(await loadTaskEnvelope(fs, path));
      } catch {
        // Invalid temp documents stay inspectable on disk but do not enter UI state.
      }
    }
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}

export async function loadTaskEnvelope(fs: FsAdapter, path: string): Promise<TaskEnvelope> {
  if (!(await fs.exists(path))) throw new Error(`Task envelope not found: ${path}.`);
  const { data, body } = parseFrontmatter(await fs.readFile(path));
  if (
    data.type !== "task" ||
    typeof data.role !== "string" ||
    typeof data.manifest !== "string" ||
    !Array.isArray(data.claims) ||
    !data.claims.every((claim) => typeof claim === "string")
  ) {
    throw new Error(`Invalid task envelope format: ${path}.`);
  }

  const legacyStatus: TaskEnvelopeStatus = data.status === "taken" ? "taken" : "pending";
  const state = parseTaskState(data.state, legacyStatus);

  const task: TaskEnvelope = {
    path,
    role: data.role,
    claims: data.claims,
    manifest: data.manifest,
    status: stateToLegacyStatus(state),
    state,
    prompt: body.trim() || undefined,
  };
  if (typeof data.id === "string" && isTaskId(data.id)) task.id = data.id;
  if (typeof data.dispatchedBy === "string") task.dispatchedBy = data.dispatchedBy;
  if (typeof data.workspace === "string") task.workspace = data.workspace;
  if (typeof data.worktree === "string") task.worktree = data.worktree;
  if (typeof data.branch === "string") task.branch = data.branch;
  if (typeof data.targetBranch === "string") task.targetBranch = data.targetBranch;
  if (isDeliveryPolicy(data.deliveryPolicy)) task.deliveryPolicy = data.deliveryPolicy;
  if (data.assigneeKind === "role" || data.assigneeKind === "agentProfile") {
    task.assigneeKind = data.assigneeKind;
  }
  if (typeof data.sessionId === "string") task.sessionId = data.sessionId;
  if (typeof data.activeDeliveryId === "string") task.activeDeliveryId = data.activeDeliveryId;
  if (typeof data.createdAt === "string") task.createdAt = data.createdAt;
  if (typeof data.updatedAt === "string") task.updatedAt = data.updatedAt;
  const wait = parseWaitFields(data);
  if (wait) task.wait = wait;
  return task;
}

/**
 * Roots for agent-facing task prompts.
 * - workspaceRoot: real project; run `tent` CLI here.
 * - systemRoot: tent system root (`<workspace>/.tent`); taskPath base.
 */
export type TaskPromptRoots = {
  workspaceRoot: string;
  systemRoot: string;
};

/**
 * Normalize legacy string root (system root / tentRoot) or explicit dual roots.
 * When only systemRoot is known, workspaceRoot is its parent if the leaf is `.tent`.
 */
export function resolveTaskPromptRoots(
  roots: string | TaskPromptRoots
): TaskPromptRoots {
  if (typeof roots !== "string") {
    return {
      workspaceRoot: roots.workspaceRoot,
      systemRoot: roots.systemRoot,
    };
  }
  const systemRoot = roots;
  const normalized = systemRoot.replace(/[\\/]+$/, "");
  const base = normalized.split(/[\\/]/).pop() ?? "";
  const workspaceRoot =
    base === ".tent"
      ? normalized.replace(/[\\/]+[^\\/]+$/, "") || systemRoot
      : systemRoot;
  return { workspaceRoot, systemRoot };
}

function formatTaskPathHints(task: TaskEnvelope, roots: TaskPromptRoots): string {
  const initCli = join("temp", task.role, "init.md");
  const initFile = join(".tent", "temp", task.role, "init.md");
  const taskFile = join(".tent", task.path);
  return (
    `workspaceRoot: ${roots.workspaceRoot}\n` +
    `systemRoot: ${roots.systemRoot}\n` +
    `CLI: run tent from workspaceRoot; taskPath is relative to systemRoot (.tent), e.g. ${task.path}.\n` +
    `File reads: use ${taskFile} (workspace-relative) or ${roots.systemRoot.replace(/[\\/]+$/, "")}/${task.path} — never <workspaceRoot>/temp.\n` +
    `Role init file: ${initFile} (CLI path remains ${initCli}).`
  );
}

/**
 * External / manual wake relay: task is still queued — agent must claim + deliver via CLI.
 * Used for clipboard relay and dispatch.relayPrompt, NOT for service startSession bootstrap.
 */
export function relayPromptForTask(
  task: TaskEnvelope,
  roots: string | TaskPromptRoots
): string {
  const resolved = resolveTaskPromptRoots(roots);
  return (
    `A Tent task has been dispatched to role ${task.role}.\n` +
    `${formatTaskPathHints(task, resolved)}\n` +
    `1. Run \`tent task claim ${task.path}\` to take this task (Local Service RPC).\n` +
    `2. Inspect with \`tent task get ${task.path}\` (or read the envelope file), then open the claimed boxes; the box notes contain the task definition.\n` +
    `3. When finished, run \`tent task deliver ${task.path} --summary <text>\` (optional: --commits sha,sha).\n` +
    `4. If this is a new session for this role, complete role init first (read the init file above).`
  );
}

/**
 * Extract the near-field user prompt from a task envelope body.
 * Envelope layout: Context Pointers + `## User Prompt` — never the box/manifest body.
 */
export function extractTaskUserPrompt(task: TaskEnvelope): string {
  const body = task.prompt?.trim() || "";
  if (!body) return "";
  const match = body.match(/##\s*User Prompt\s*\r?\n+([\s\S]*?)\s*$/i);
  if (match) return match[1].trim();
  // Legacy / override bodies without the section header: treat whole body as the prompt.
  return body;
}

/**
 * Managed ACP startSession bootstrap (service already claimed).
 * Pointers + near-field user prompt only — no claim/get/deliver CLI steps.
 * Final assistant response is captured by Local Service and auto-delivered.
 */
export function sessionBootstrapPromptForTask(
  task: TaskEnvelope,
  roots: string | TaskPromptRoots
): string {
  const resolved = resolveTaskPromptRoots(roots);
  const userPrompt = extractTaskUserPrompt(task);
  return (
    `A Tent managed ACP session is ready for role ${task.role}.\n` +
    `${formatTaskPathHints(task, resolved)}\n` +
    `Service status: this task is already claimed (state=${task.state || "running"}).\n` +
    `Managed path: skip Local Service claim/get/deliver CLI steps (tool permissions may deny them).\n` +
    `Your final assistant reply is the report: Local Service will capture it and submit delivery automatically (manual review stays pending; no auto-accept).\n` +
    `Context Card / path pointers above identify the task; optional deeper reads only if tools are allowed.\n` +
    (userPrompt
      ? `\n## User Prompt\n\n${userPrompt}\n`
      : `\n## User Prompt\n\n(no user prompt on envelope)\n`)
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
    `- Rules (CLI / system-root relative): RULES.md\n` +
    `- Rules (workspace file read): .tent/RULES.md\n` +
    `- Role registry (workspace file read): .tent/roles.json (or run \`tent roles\` from workspace root)\n\n` +
    `## Role Prompt\n\n${role.prompt?.trim() || "(no persistent role prompt)"}\n\n` +
    `## Operating Model\n\n` +
    `Manifest readable/writable entries are an honor-system contract, not a security sandbox. If prompts conflict or a boundary cannot be followed, stop and ask the user.\n` +
    `Task lifecycle uses \`tent task *\` (Local Service). Do not invent paths as <workspace>/temp — operational files live under .tent/temp.\n`;
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
  const id = input.id && isTaskId(input.id) ? input.id : makeTaskId();
  const stem = taskStem(clock.now(), input.claims[0]?.id || "root");
  const path = await uniqueMarkdownPath(fs, dir, stem);
  const now = clock.now();
  const data: Record<string, unknown> = {
    type: "task",
    id,
    status: "pending",
    state: "queued",
    role: input.role,
    assigneeKind: input.assigneeKind ?? "role",
    dispatchedBy: input.dispatchedBy?.trim() || "user",
    claims: input.claims.map((claim) => claim.id),
    manifest: input.manifestPath,
    deliveryPolicy: input.deliveryPolicy ?? "manual",
    createdAt: now,
    updatedAt: now,
  };
  if (input.sessionId) data.sessionId = input.sessionId;
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
    (input.id || id ? `- Task id: ${id}\n` : "") +
    `\n## User Prompt\n\n${userPrompt}\n`;
  await fs.writeFile(path, serializeFrontmatter(data, body));
  return path;
}

export async function ackTaskEnvelope(fs: FsAdapter, path: string): Promise<void> {
  await patchTaskEnvelope(fs, path, {
    status: "taken",
    state: "running",
  });
}

export async function cancelTaskEnvelope(fs: FsAdapter, path: string): Promise<void> {
  const task = await loadTaskEnvelope(fs, path);
  if (task.state !== "queued" && task.status !== "pending") {
    throw new Error("Only queued (pending) task envelopes can be cancelled.");
  }
  await fs.remove(path);
}

export interface TaskEnvelopePatch {
  status?: TaskEnvelopeStatus;
  state?: TaskState;
  sessionId?: string | null;
  wait?: TaskWait | null;
  activeDeliveryId?: string | null;
  deliveryPolicy?: DeliveryPolicy;
  updatedAt?: string;
}

/** Low-level patch of task operational frontmatter (body stays immutable). */
export async function patchTaskEnvelope(
  fs: FsAdapter,
  path: string,
  patch: TaskEnvelopePatch
): Promise<TaskEnvelope> {
  if (!(await fs.exists(path))) throw new Error(`Task envelope not found: ${path}.`);
  const raw = await fs.readFile(path);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") throw new Error(`Invalid task envelope format: ${path}.`);

  if (patch.state) {
    data.state = patch.state;
    data.status = stateToLegacyStatus(patch.state);
  } else if (patch.status) {
    data.status = patch.status;
    if (!data.state) data.state = legacyStatusToState(patch.status);
  }
  if (patch.sessionId === null) delete data.sessionId;
  else if (typeof patch.sessionId === "string") data.sessionId = patch.sessionId;

  if (patch.wait === null) {
    delete data.waitReason;
    delete data.waitSummary;
  } else if (patch.wait) {
    data.waitReason = patch.wait.reason;
    data.waitSummary = patch.wait.summary;
  }

  if (patch.activeDeliveryId === null) delete data.activeDeliveryId;
  else if (typeof patch.activeDeliveryId === "string") data.activeDeliveryId = patch.activeDeliveryId;

  if (patch.deliveryPolicy) data.deliveryPolicy = patch.deliveryPolicy;
  if (patch.updatedAt) data.updatedAt = patch.updatedAt;

  await fs.writeFile(path, serializeFrontmatter(data, body, keyOrder));
  return loadTaskEnvelope(fs, path);
}

export function workspaceLaneOf(task: TaskEnvelope): WorkspaceLane | undefined {
  if (!task.workspace && !task.worktree && !task.branch && !task.targetBranch) return undefined;
  return {
    workspace: task.workspace,
    worktree: task.worktree,
    branch: task.branch,
    targetBranch: task.targetBranch,
  };
}

export function primaryBoxId(task: TaskEnvelope): string | undefined {
  return task.claims.find((c) => c !== "root");
}

function parseTaskState(value: unknown, legacy: TaskEnvelopeStatus): TaskState {
  if (
    value === "queued" ||
    value === "running" ||
    value === "waiting" ||
    value === "delivered" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "interrupted" ||
    value === "failed"
  ) {
    return value;
  }
  return legacyStatusToState(legacy);
}

function isDeliveryPolicy(value: unknown): value is DeliveryPolicy {
  return value === "manual" || value === "bypass" || value === "agent-decide";
}

function parseWaitFields(data: Record<string, unknown>): TaskWait | undefined {
  const reason = data.waitReason;
  const summary = data.waitSummary;
  if (
    (reason === "user-input" ||
      reason === "a2a-approval" ||
      reason === "review" ||
      reason === "external") &&
    typeof summary === "string"
  ) {
    return { reason, summary };
  }
  return undefined;
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
