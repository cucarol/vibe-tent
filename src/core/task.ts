import { Buffer } from "node:buffer";
import { Clock, FsAdapter } from "./adapter.js";
import { isRoleId, isSessionId } from "./id.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import {
  ROLES_TEMP_DIR,
  SESSIONS_TEMP_DIR,
  roleTasksDir,
  sessionTasksDir,
  TEMP_DIR,
} from "./paths.js";
import { join } from "./tree.js";
import type { RoleDefinition } from "./skillRoleRegistry.js";
import {
  DEFAULT_ACCEPT_MODE,
  isAcceptMode,
  isTaskResultId,
  isTaskId,
  makeTaskId,
  allowsNonReviewAcceptMode,
  parseTaskActorRef,
  type AcceptMode,
  type TaskActorRef,
  type TaskStatusDetail,
  type TaskState,
  type TaskWait,
  type WorkspaceLane,
} from "./task-model.js";
import {
  assertIntegrationAuthorityMatchesParent,
  buildTaskContextCard,
  formatTaskPackage,
  formatExecutionLanePrompt,
  deriveIntegrationAuthority,
  loadTaskContextCardFromFrontmatter,
  projectExecutionLaneFromTask,
  serializeTaskContextCardForFrontmatter,
  type IntegrationAuthority,
  type TaskContextCard,
} from "./task-context-card.js";
import { taskReferencedNodeIds } from "./task-node-refs.js";
import {
  normalizeTaskNodeContext,
  type TaskNodeContext,
} from "./task-node-context.js";
import type { TaskNodeSnapshot } from "./task-node-snapshot.js";

export interface RoleWorkspaceContract {
  workspace: string;
  worktree: string;
  branch: string;
  targetBranch: string;
  /**
   * Exact branch tip (full SHA) at ensure/create time.
   * Written as Task baseCommit + roleBranchBase when the execution lane is first bound
   * (first claim for Role responsibility or first execution binding).
   */
  baseCommit?: string;
}

/** How workspaceLane.baseCommit was first recorded (compact Task audit; no new entity). */
export type BaseCommitCaptureSource = "first-claim";

/**
 * Compact audit bag for capture-once baseCommit.
 * Written once on Role first claim.
 */
export type BaseCommitCapture = {
  source: BaseCommitCaptureSource;
  /** Exact full SHA captured (same as Task.baseCommit). */
  baseCommit: string;
  /** Authorizing requester for first-claim capture. */
  actor: TaskActorRef;
  /** ISO-8601 capture timestamp. */
  capturedAt: string;
};

export interface TaskRecordInput {
  /** Durable Role responsibility/handoff. Orthogonal to exact Session execution. */
  assigneeRoleId?: string;
  /** Exact executing Session. Connection identity is never stored on a Task. */
  executionSessionId?: string;
  /** Exact ordered root Node selection; may be empty for prompt-only Tasks. */
  nodeIds: string[];
  /** Frozen subtree snapshots rooted at nodeIds[], with overlap deduped once. */
  nodeSnapshots: TaskNodeSnapshot[];
  manifestPath: string;
  prompt: string;
  workspace?: RoleWorkspaceContract;
  /** Sole parent and review authority. Required on every canonical write. */
  requester: TaskActorRef;
  /** Full operational id (tk-…). Generated if omitted. */
  id?: string;
  acceptMode?: AcceptMode;
  /** Internal rollback hook: reports the exact path before the first Task write. */
  onPathAllocated?: (path: string) => void;
}

/** Operational task record. */
export interface TaskRecord extends TaskNodeContext {
  path: string;
  /** Durable Role responsibility/handoff, when this is a Role Task. */
  assigneeRoleId?: string;
  manifest: string;
  /** Canonical lifecycle state (task-api §2). */
  state: TaskState;
  /** Canonical persisted task id (tk-…). Synthetic in-memory fixtures may omit it. */
  id?: string;
  /**
   * Sole parent and review authority. Required on persisted Tasks.
   * Optional only on synthetic/partial fixtures before write.
   */
  requester?: TaskActorRef;
  workspace?: string;
  worktree?: string;
  branch?: string;
  targetBranch?: string;
  /**
   * Immutable full SHA of the role branch tip at first Git-lane bind for this task.
   * Optional; absent on non-Git records until captured once.
   * Kept in sync with baseCommit for managed collection (same capture-once baseline).
   */
  roleBranchBase?: string;
  /**
   * Exact full SHA of the Task worktree start (cx-5q6za6).
   * Authoritative for the pre-submit history gate; capture-once with roleBranchBase.
   */
  baseCommit?: string;
  /**
   * Compact audit for capture-once workspaceLane.baseCommit (no separate entity).
   * source records the Role first-claim capture.
   * Immutable once written: same-SHA backfill leaves this bag unchanged.
   */
  baseCommitCapture?: BaseCommitCapture;
  /**
   * Integration authority on the workspace lane (actor = requester, mutator = service).
   * Ordinary executors never mutate target; Service integrates after parent accept.
   */
  integrationAuthority?: IntegrationAuthority;
  /** Authoritative frozen Task Context Card. */
  contextCard: TaskContextCard;
  /** In-memory projection of contextCard.contextGeneration. */
  contextGeneration?: string;
  acceptMode: AcceptMode;
  /** Exact executing Session; required for Session-only Tasks. */
  executionSessionId?: string;
  wait?: TaskWait;
  currentResultId?: string;
  /** Latest formal blocked/failed status; one bounded last-write-wins slot. */
  statusDetail?: TaskStatusDetail;
  createdAt?: string;
  updatedAt?: string;
  /** Immutable user prompt body (after frontmatter). */
  prompt?: string;
}

/**
 * Discover canonical Task records under Role and Session namespaces.
 * - Role: temp/roles/<assigneeRoleId>/tasks/*.md
 * - Session-only: temp/sessions/<executionSessionId>/tasks/*.md
 */
export async function loadTaskRecords(fs: FsAdapter): Promise<TaskRecord[]> {
  const tasks: TaskRecord[] = [];
  if (!(await fs.exists(TEMP_DIR))) return tasks;

  for (const entry of await fs.listDir(TEMP_DIR)) {
    if (!entry.isDir) continue;
    if (entry.name !== ROLES_TEMP_DIR && entry.name !== SESSIONS_TEMP_DIR) continue;
    const ownerRoot = join(TEMP_DIR, entry.name);
    for (const ownerEntry of await fs.listDir(ownerRoot)) {
      if (!ownerEntry.isDir) continue;
      await collectTaskFiles(fs, join(ownerRoot, ownerEntry.name, "tasks"), tasks);
    }
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}

async function collectTaskFiles(
  fs: FsAdapter,
  taskDir: string,
  tasks: TaskRecord[]
): Promise<void> {
  if (!(await fs.exists(taskDir))) return;
  for (const entry of await fs.listDir(taskDir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path = join(taskDir, entry.name);
    tasks.push(await loadTaskRecord(fs, path));
  }
}

/** Compact diagnostic only; never parsed as an assignment wire. */
export function taskExecutionLabel(
  task: Pick<TaskRecord, "assigneeRoleId" | "executionSessionId">
): string {
  return [task.assigneeRoleId ? `assigneeRoleId=${task.assigneeRoleId}` : "", task.executionSessionId ? `executionSessionId=${task.executionSessionId}` : ""]
    .filter(Boolean)
    .join(" ");
}

/** Durable parent role id, or undefined when parent is user. */
export function taskParentRoleId(
  task: Pick<TaskRecord, "requester">
): string | undefined {
  return task.requester?.kind === "role" ? task.requester.id : undefined;
}

/**
 * Serialize actor ref for frontmatter (inline map).
 * Kept small and explicit.
 */
export function serializeTaskActorRef(actor: TaskActorRef): { kind: string; id: string } {
  return { kind: actor.kind, id: actor.id };
}

/** Serialize compact baseCommit capture audit for frontmatter. */
export function serializeBaseCommitCapture(
  capture: BaseCommitCapture
): { source: string; baseCommit: string; actor: { kind: string; id: string }; capturedAt: string } {
  return {
    source: capture.source,
    baseCommit: capture.baseCommit,
    actor: serializeTaskActorRef(capture.actor),
    capturedAt: capture.capturedAt,
  };
}

/**
 * Fail-loud ISO-8601 timestamp check for baseCommitCapture.capturedAt.
 * Requires a real parseable instant with explicit timezone (Z or ±HH:MM).
 */
export function assertIsoTimestamp(value: string, label: string): string {
  const raw = value.trim();
  if (!raw) {
    throw new Error(`${label} must be a non-empty ISO-8601 timestamp.`);
  }
  // Accept fractional seconds; require timezone designator (Z or offset).
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)
  ) {
    throw new Error(
      `${label} must be a real ISO-8601 timestamp with timezone; got ${raw}.`
    );
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`${label} is not a parseable ISO-8601 instant: ${raw}.`);
  }
  return raw;
}

export const TASK_STATUS_DETAIL_REPORT_MAX_BYTES = 64 * 1024;
export const TASK_STATUS_DETAIL_ERROR_MAX_BYTES = 8 * 1024;
export const TASK_STATUS_DETAIL_CODE_MAX_BYTES = 128;

/** Strict parser shared by disk load, lifecycle writes, and public projection. */
export function parseTaskStatusDetail(value: unknown): TaskStatusDetail | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Task statusDetail must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["kind", "report", "error", "code", "at", "executionSessionId"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new Error("Task statusDetail contains unknown fields.");
  }
  const kind = raw.kind;
  if (kind !== "blocked" && kind !== "failed") {
    throw new Error("Task statusDetail.kind must be blocked or failed.");
  }
  const report = parseBoundedTaskStatusDetailString(
    raw.report,
    "report",
    TASK_STATUS_DETAIL_REPORT_MAX_BYTES
  );
  const error = parseBoundedTaskStatusDetailString(
    raw.error,
    "error",
    TASK_STATUS_DETAIL_ERROR_MAX_BYTES
  );
  if (!report && !error) {
    throw new Error("Task statusDetail requires report or error.");
  }
  const code = parseBoundedTaskStatusDetailString(
    raw.code,
    "code",
    TASK_STATUS_DETAIL_CODE_MAX_BYTES
  );
  if (code && !/^[A-Za-z0-9_.:-]+$/.test(code)) {
    throw new Error("Task statusDetail.code must be a stable machine identifier.");
  }
  const at = raw.at === undefined
    ? undefined
    : assertIsoTimestamp(String(raw.at), "Task statusDetail.at");
  const executionSessionId = raw.executionSessionId === undefined
    ? undefined
    : String(raw.executionSessionId).trim();
  if (executionSessionId && !isSessionId(executionSessionId)) {
    throw new Error(`Invalid Task statusDetail.executionSessionId: ${executionSessionId}.`);
  }
  return {
    kind,
    ...(report ? { report } : {}),
    ...(error ? { error } : {}),
    ...(code ? { code } : {}),
    ...(at ? { at } : {}),
    ...(executionSessionId ? { executionSessionId } : {}),
  };
}

function parseBoundedTaskStatusDetailString(
  value: unknown,
  field: "report" | "error" | "code",
  maxBytes: number
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Task statusDetail.${field} must be a string.`);
  }
  const text = value.trim();
  if (!text) return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`Task statusDetail.${field} exceeds ${maxBytes} UTF-8 bytes.`);
  }
  return text;
}

/**
 * Parse compact baseCommit capture audit from frontmatter.
 * Missing/empty → undefined. Partial or invalid bags fail loud.
 * Caller must still enforce baseCommit presence/equality when capture is present.
 */
export function parseBaseCommitCapture(value: unknown): BaseCommitCapture | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "Task baseCommitCapture must be an object { source, baseCommit, actor, capturedAt }."
    );
  }
  const raw = value as Record<string, unknown>;
  const source = raw.source;
  if (source !== "first-claim") {
    throw new Error(
      `Task baseCommitCapture.source must be first-claim; got ${String(source)}.`
    );
  }
  const baseCommit =
    typeof raw.baseCommit === "string" ? raw.baseCommit.trim() : "";
  if (!baseCommit) {
    throw new Error("Task baseCommitCapture.baseCommit must be a non-empty SHA.");
  }
  const capturedAtRaw =
    typeof raw.capturedAt === "string" ? raw.capturedAt.trim() : "";
  const capturedAt = assertIsoTimestamp(
    capturedAtRaw,
    "Task baseCommitCapture.capturedAt"
  );
  // Reuse requester wire shape; re-label errors for capture audit.
  let actor: TaskActorRef;
  try {
    actor = parseTaskActorRef(raw.actor, "requester");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.replace(/Task requester/g, "Task baseCommitCapture.actor"));
  }
  return { source, baseCommit, actor, capturedAt };
}

/**
 * Resolve requester for a **new** dispatch write.
 * There is no independent reviewer input or persisted reviewer field.
 */
export function resolveDispatchRequester(input: {
  requester?: TaskActorRef;
}): TaskActorRef {
  if (!input.requester) {
    throw new Error(
      "task.dispatch requires explicit requester { kind, id }."
    );
  }
  return parseTaskActorRef(input.requester, "requester");
}

export async function loadTaskRecord(fs: FsAdapter, path: string): Promise<TaskRecord> {
  if (!(await fs.exists(path))) throw new Error(`Task record not found: ${path}.`);
  const { data, body } = parseFrontmatter(await fs.readFile(path));
  assertNoRetiredTaskAuthorityFields(data);
  if (data.type !== "task" || typeof data.manifest !== "string") {
    throw new Error(`Invalid task record format: ${path}.`);
  }
  const assigneeRoleId = typeof data.assigneeRoleId === "string" ? data.assigneeRoleId.trim() : "";
  const executionSessionId = typeof data.executionSessionId === "string" ? data.executionSessionId.trim() : "";
  if (!assigneeRoleId && !executionSessionId) {
    throw new Error(`Invalid Task record format: ${path} (assigneeRoleId or executionSessionId is required).`);
  }
  if (assigneeRoleId && !isRoleId(assigneeRoleId)) {
    throw new Error(`Invalid Task record format: ${path} (invalid assigneeRoleId).`);
  }
  if (executionSessionId && !isSessionId(executionSessionId)) {
    throw new Error(`Invalid Task record format: ${path} (invalid executionSessionId).`);
  }
  const normalizedTaskPath = path.replace(/\\/g, "/");
  const authoritativeOwnerDir = assigneeRoleId
    ? `temp/${ROLES_TEMP_DIR}/${assigneeRoleId}/tasks/`
    : undefined;
  const sessionOwnerMatch = normalizedTaskPath.match(
    new RegExp(`^temp/${SESSIONS_TEMP_DIR}/([^/]+)/tasks/`)
  );
  const ownerIsValid = assigneeRoleId
    ? normalizedTaskPath.startsWith(authoritativeOwnerDir!)
    : !!sessionOwnerMatch && isSessionId(sessionOwnerMatch[1]!);
  if (!ownerIsValid) {
    throw new Error(
      `Invalid Task record owner namespace: ${path}.`
    );
  }
  if (typeof data.id !== "string" || !isTaskId(data.id)) {
    throw new Error(`Invalid task record format: ${path} (canonical task id is required).`);
  }

  const state = parseTaskState(data.state);

  // Resolve actors before Context Card so actor mismatch errors are not masked
  // by missing-card errors.
  const requester = resolveRequesterFromDisk(data);

  // Complete Task Context Card is the sole frozen Node context. Incomplete → fail loud.
  const contextCard = loadTaskContextCardFromFrontmatter(data) ?? undefined;
  if (!contextCard) {
    throw new Error(
      `Invalid task record format: ${path} (missing Task Context Card).`
    );
  }
  if (!isAcceptMode(data.acceptMode)) {
    throw new Error(
      `Invalid task record format: ${path} (acceptMode must be review-required, auto-accept, or agent-decide).`
    );
  }

  const prompt = body.trim();
  if (!prompt) {
    throw new Error(`Invalid Task record format: ${path} (non-empty prompt is required).`);
  }
  const task: TaskRecord = {
    path,
    ...(assigneeRoleId ? { assigneeRoleId } : {}),
    ...(executionSessionId ? { executionSessionId } : {}),
    manifest: data.manifest,
    state,
    id: data.id,
    requester,
    prompt,
    contextCard,
    nodeIds: contextCard.nodeIds,
    nodeSnapshots: contextCard.nodeSnapshots,
    acceptMode: data.acceptMode,
  };
  if (typeof data.workspace === "string") task.workspace = data.workspace;
  if (typeof data.worktree === "string") task.worktree = data.worktree;
  if (typeof data.branch === "string") task.branch = data.branch;
  if (typeof data.targetBranch === "string") task.targetBranch = data.targetBranch;
  if (typeof data.roleBranchBase === "string" && data.roleBranchBase.trim()) {
    task.roleBranchBase = data.roleBranchBase.trim();
  }
  // Exact workspaceLane.baseCommit only — never silently substitute roleBranchBase.
  // Records without a Git lane legitimately have no base commit.
  if (typeof data.baseCommit === "string" && data.baseCommit.trim()) {
    task.baseCommit = data.baseCommit.trim();
  }
  // Compact first-claim baseCommit audit. Absence is fine before claim and for
  // non-Git Tasks; never invent from roleBranchBase.
  // When capture exists: baseCommit must exist and equal capture.baseCommit (fail loud).
  const baseCommitCapture = parseBaseCommitCapture(data.baseCommitCapture);
  if (baseCommitCapture) {
    const recordedBase = task.baseCommit?.trim() || "";
    if (!recordedBase) {
      throw new Error(
        `Invalid task record format: ${path} (baseCommitCapture present but baseCommit missing).`
      );
    }
    if (recordedBase !== baseCommitCapture.baseCommit) {
      throw new Error(
        `Invalid task record format: ${path} (baseCommit ${recordedBase} !== ` +
          `baseCommitCapture.baseCommit ${baseCommitCapture.baseCommit}).`
      );
    }
    task.baseCommitCapture = baseCommitCapture;
  }
  // Recorded lane truth: only set TaskRecord.integrationAuthority when the on-disk
  // bag exists and validates against requester + service mutator.
  // Absence stays absent so ensureTaskWorkspaceLane can detect and persist the
  // canonical derived bag (no in-memory phantom that skips the write).
  // Context / workspaceLane projections derive separately via deriveIntegrationAuthority.
  if (
    data.integrationAuthority !== undefined &&
    data.integrationAuthority !== null &&
    task.requester
  ) {
    task.integrationAuthority = assertIntegrationAuthorityMatchesParent(
      data.integrationAuthority,
      task.requester
    );
  }
  // Task Context Card already loaded above from its sole nested wire.
  task.contextGeneration = contextCard.contextGeneration;
  if (data.currentResultId !== undefined) {
    if (
      typeof data.currentResultId !== "string" ||
      data.currentResultId !== data.currentResultId.trim() ||
      !isTaskResultId(data.currentResultId)
    ) {
      throw new Error(`Invalid Task currentResultId: ${String(data.currentResultId)}.`);
    }
    task.currentResultId = data.currentResultId;
  }
  const statusDetail = parseTaskStatusDetail(data.statusDetail);
  if (statusDetail) task.statusDetail = statusDetail;
  if (typeof data.createdAt === "string") task.createdAt = data.createdAt;
  if (typeof data.updatedAt === "string") task.updatedAt = data.updatedAt;
  const wait = parseWaitFields(data);
  if (wait) task.wait = wait;
  return task;
}

/**
 * Resolve the sole parent/review authority from on-disk frontmatter.
 * Retired authority fields are rejected rather than migrated or aliased.
 */
function resolveRequesterFromDisk(data: Record<string, unknown>): TaskActorRef {
  if (data.requester === undefined || data.requester === null) {
    throw new Error("Invalid Task record: missing requester.");
  }
  return parseTaskActorRef(data.requester, "requester");
}

function assertNoRetiredTaskAuthorityFields(data: Record<string, unknown>): void {
  for (const field of ["reviewer", "dispatchedBy"] as const) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      throw new Error(`Invalid Task record: retired ${field} field; use requester.`);
    }
  }
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

/** Canonical Task-specific pointer block reused by relay and managed bootstrap. */
function formatTaskPackagePointers(task: TaskRecord): string {
  const lines = [
    `Task record: ${task.path}`,
    `Manifest: ${task.manifest}`,
  ];
  if (task.id) {
    lines.push(`Task id: ${task.id}`);
  }
  lines.push(`nodeIds: ${task.nodeIds.join(", ") || "(none)"}`);
  if (task.requester) {
    lines.push(
      `requester: ${task.requester.kind}:${task.requester.id}`
    );
  }
  lines.push(`acceptMode: ${task.acceptMode}`);
  if (task.assigneeRoleId) {
    lines.push(`assigneeRoleId: ${task.assigneeRoleId}`);
  }
  if (!task.assigneeRoleId) lines.push(`Session-only execution (no durable Role responsibility).`);
  return lines.join("\n");
}

export function taskPackageForTask(
  task: TaskRecord
): string {
  const prompt = extractTaskPrompt(task);
  if (!prompt) throw new Error(`Task Package requires a non-empty prompt: ${task.path}.`);
  const pointerSections = [formatTaskPackagePointers(task)];
  const executionLane = formatExecutionLanePrompt(projectExecutionLaneFromTask(task));
  if (executionLane) {
    pointerSections.push(executionLane);
  }
  pointerSections.push(
    "TaskResult contract: a non-empty final report is the normal success path.",
    "When applicable, include commits, checks, and artifact refs in the same TaskResult.",
    "Never self-accept."
  );
  return formatTaskPackage({
    contextCard: task.contextCard,
    taskPointers: pointerSections.join("\n"),
    prompt,
  });
}

/**
 * Path roots for external relay only (managed bootstrap uses Context Card once).
 */
function formatExternalPathBlock(task: TaskRecord, roots: TaskPromptRoots): string {
  const taskFile = join(".tent", task.path);
  const systemRoot = roots.systemRoot.replace(/[\\/]+$/, "");
  return [
    `workspaceRoot: ${roots.workspaceRoot}`,
    `systemRoot: ${roots.systemRoot}`,
    `CLI: run tent from workspaceRoot; taskPath is relative to systemRoot (.tent), e.g. ${task.path}.`,
    `File reads: use ${taskFile} (workspace-relative) or ${systemRoot}/${task.path} — never <workspaceRoot>/temp.`,
  ].join("\n");
}

/**
 * External / manual wake relay: Task is still queued — executor must claim + submit via CLI.
 * Used for clipboard relay and dispatch.relayPrompt, NOT for service startSession bootstrap.
 */
export function relayPromptForTask(
  task: TaskRecord,
  roots: string | TaskPromptRoots
): string {
  const resolved = resolveTaskPromptRoots(roots);
  const assigneeLine =
    task.assigneeRoleId
      ? `A Tent task has been handed to Role ${task.assigneeRoleId}.\n`
      : `A Tent task is bound to Session ${task.executionSessionId}.\n`;
  const initStep =
    task.assigneeRoleId
      ? `4. If this is a new session for this Role, complete Role init first (read the init file above).`
      : `4. Read the Task record and task-scoped manifest pointers above; no Role init applies.`;
  const roleInitBlock =
    task.assigneeRoleId
      ? `${join(".tent", "temp", ROLES_TEMP_DIR, task.assigneeRoleId, "init.md")}\n`
      : "";
  return (
    assigneeLine +
    `${formatExternalPathBlock(task, resolved)}\n` +
    roleInitBlock +
    `1. Run \`tent task claim ${task.path}\` to take this task (Local Service RPC).\n` +
    `2. Read the frozen Task Context Card (\`tent task get ${task.path}\` or the Task record). Resolve current Node state by id only when comparing drift.\n` +
    `3. When finished, run \`tent task submit ${task.path} --report <text>\` (optional: --commits sha,sha).\n` +
    `${initStep}\n\n` +
    taskPackageForTask(task)
  );
}

/**
 * Extract the near-field prompt from a Task record body.
 * Canonical envelope layout is Context Pointers + `## Prompt` — never the
 * node/manifest body. Unsectioned synthetic bodies are treated as prompt text.
 */
export function extractTaskPrompt(task: TaskRecord): string {
  const body = task.prompt?.trim() || "";
  if (!body) return "";
  const match = body.match(/##\s*Prompt\s*\r?\n+([\s\S]*?)\s*$/i);
  if (match) return match[1].trim();
  // Bodies without the section header are themselves the prompt.
  return body;
}

export async function ensureRoleInit(
  fs: FsAdapter,
  role: RoleDefinition,
  tentName: string
): Promise<string> {
  if (!role.id || !isRoleId(role.id)) {
    throw new Error(`Role init requires a canonical Role id for ${role.name}.`);
  }
  const path = join(TEMP_DIR, ROLES_TEMP_DIR, role.id, "init.md");
  const body =
    `# Role Init\n\n` +
    `- Tent: ${tentName}\n` +
    `- Agent rules (workspace file read): AGENTS.md at the workspace root\n` +
    `- Role registry (workspace file read): .tent/roles.json (or run \`tent roles\` from workspace root)\n\n` +
    `## Role Prompt\n\n${role.prompt?.trim() || "(no persistent role prompt)"}\n\n` +
    `## Operating Model\n\n` +
    `Manifest readable/writable entries are an honor-system contract, not a security sandbox. If prompts conflict or a boundary cannot be followed, stop and ask the user.\n` +
    `Task lifecycle uses \`tent task *\` (Local Service). Do not invent paths as <workspace>/temp — operational files live under .tent/temp.\n`;
  await fs.writeFile(path, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path;
}

export async function writeTaskRecord(
  fs: FsAdapter,
  clock: Clock,
  input: TaskRecordInput
): Promise<string> {
  const prompt = input.prompt?.trim() || "";
  if (!prompt) throw new Error("Dispatch requires a prompt.");

  const assigneeRoleId = input.assigneeRoleId?.trim() || "";
  const executionSessionId = input.executionSessionId?.trim() || "";
  if (!assigneeRoleId && !executionSessionId) {
    throw new Error("Task requires assigneeRoleId or executionSessionId at creation.");
  }
  if (assigneeRoleId && !isRoleId(assigneeRoleId)) throw new Error(`Invalid Task assigneeRoleId: ${assigneeRoleId}.`);
  if (executionSessionId && !isSessionId(executionSessionId)) {
    throw new Error(`Invalid Task executionSessionId: ${executionSessionId}.`);
  }
  const dir = assigneeRoleId ? roleTasksDir(assigneeRoleId) : sessionTasksDir(executionSessionId);
  await ensureDir(fs, dir);
  const requestedId = input.id?.trim() || "";
  if (requestedId && !isTaskId(requestedId)) {
    throw new Error(`Invalid Task id: ${requestedId}.`);
  }
  const id = requestedId || makeTaskId();

  const nodeContext = normalizeTaskNodeContext({
    nodeIds: input.nodeIds,
    nodeSnapshots: input.nodeSnapshots,
  });
  const primaryRef = nodeContext.nodeIds[0] ?? "prompt";
  const stem = taskStem(clock.now(), primaryRef);
  const path = await uniqueMarkdownPath(fs, dir, stem);
  input.onPathAllocated?.(path);
  const now = clock.now();
  const requester = resolveDispatchRequester({ requester: input.requester });
  const acceptMode = input.acceptMode ?? DEFAULT_ACCEPT_MODE;
  if (!isAcceptMode(acceptMode)) {
    throw new Error(`Invalid Task acceptMode: ${String(acceptMode)}.`);
  }
  // Downstream Task Agent → parent: always review. Elevated policies only for
  // Non-review modes are legal only at the user-facing responsibility boundary,
  // independent of whether execution is carried by a Role Session or Session-only Agent.
  if (
    acceptMode !== "review-required" &&
    !allowsNonReviewAcceptMode({
      requester,
    })
  ) {
    throw new Error(
      `acceptMode=${acceptMode} is only legal for a user-facing Task; ` +
        `downstream Task Agent → requester must use review-required (requester=${requester.kind}:${requester.id}).`
    );
  }

  // Full current Task Context Card on every new write — frozen Node snapshots are the sole context wire.
  // contextGeneration is absent until a managed Session computes and uses it.
  const contextCard = buildTaskContextCard({
    ...nodeContext,
  });

  const data: Record<string, unknown> = {
    type: "task",
    id,
    state: "queued",
    ...(assigneeRoleId ? { assigneeRoleId } : {}),
    ...(executionSessionId ? { executionSessionId } : {}),
    requester: serializeTaskActorRef(requester),
    contextCard: serializeTaskContextCardForFrontmatter(contextCard),
    manifest: input.manifestPath,
    acceptMode,
    createdAt: now,
    updatedAt: now,
  };
  // Persist only when true; missing means peer (false). Git-lane sub marker only.
  if (input.workspace) {
    data.workspace = input.workspace.workspace;
    data.worktree = input.workspace.worktree;
    data.branch = input.workspace.branch;
    data.targetBranch = input.workspace.targetBranch;
    // Lane exists: persist the exact Task-lane base once.
    // Role assignee dispatch omits workspace entirely (base captured at first claim).
    // Connection execution / non-Git also omit workspace (no fake base).
    // Connection execution may still bind a task lane + tip at dispatch.
    const tip =
      typeof input.workspace.baseCommit === "string"
        ? input.workspace.baseCommit.trim()
        : "";
    if (tip) {
      data.baseCommit = tip;
      data.roleBranchBase = tip;
    }
  }
  const pointers = nodeContext.nodeSnapshots
    .map((snapshot) => `- ${snapshot.id}: ${snapshot.path}`)
    .join("\n");
  const body =
    `# Task\n\n` +
    `## Context Pointers\n\n${pointers || "(none)"}\n\n` +
    `- Manifest: ${input.manifestPath}\n` +
    (input.id || id ? `- Task id: ${id}\n` : "") +
    `\n## Prompt\n\n${prompt}\n`;
  await fs.writeFile(path, serializeFrontmatter(data, body));
  return path;
}

export async function ackTaskRecord(fs: FsAdapter, path: string): Promise<void> {
  await patchTaskRecord(fs, path, {
    state: "running",
  });
}

export async function cancelTaskRecord(fs: FsAdapter, path: string): Promise<void> {
  const task = await loadTaskRecord(fs, path);
  if (task.state !== "queued") {
    throw new Error("Only queued Task records can be cancelled.");
  }
  await fs.remove(path);
}

export interface TaskRecordPatch {
  state?: TaskState;
  /** Exact Session rebind (replaceSession); clearing is forbidden. */
  executionSessionId?: string;
  wait?: TaskWait | null;
  currentResultId?: string | null;
  requester?: TaskActorRef;
  statusDetail?: TaskStatusDetail | null;
  updatedAt?: string;
  /** Role WorkspaceLane fields (real workspace Git only). */
  workspace?: string | null;
  worktree?: string | null;
  branch?: string | null;
  targetBranch?: string | null;
  /**
   * Capture-once baseline for managed collection. Prefer omit once set;
   * null clears (tests only). Never overwrite an existing non-empty value from
   * normal bind/resume paths.
   */
  roleBranchBase?: string | null;
  /**
   * Capture-once Task lane start (cx-5q6za6 history gate). Prefer omit once set.
   * When set, also mirrors roleBranchBase for collection compatibility unless
   * roleBranchBase is already present.
   */
  baseCommit?: string | null;
  /**
   * Compact capture audit. Prefer omit once set; null clears (tests only).
   * Same-SHA idempotent backfill must not rewrite an existing bag.
   */
  baseCommitCapture?: BaseCommitCapture | null;
  /** Persist integrationAuthority; null clears. */
  integrationAuthority?: IntegrationAuthority | null;
  /** Update only the managed stable-context generation; frozen Node context is immutable. */
  contextGeneration?: string;
}

/** Low-level patch of task operational frontmatter (body stays immutable). */
export async function patchTaskRecord(
  fs: FsAdapter,
  path: string,
  patch: TaskRecordPatch
): Promise<TaskRecord> {
  if ("acceptMode" in patch) {
    throw new Error("Task acceptMode is frozen at creation and cannot be patched.");
  }
  if ("contextCard" in patch) {
    throw new Error(
      "Task Context Card Node snapshots are frozen; patch contextGeneration only."
    );
  }
  if (!(await fs.exists(path))) throw new Error(`Task record not found: ${path}.`);
  const raw = await fs.readFile(path);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  assertNoRetiredTaskAuthorityFields(data);
  if (data.type !== "task") throw new Error(`Invalid Task record format: ${path}.`);

  if (patch.state) {
    data.state = patch.state;
  }
  if (typeof patch.executionSessionId === "string") {
    const executionSessionId = patch.executionSessionId.trim();
    if (!isSessionId(executionSessionId)) throw new Error(`Invalid Task executionSessionId: ${executionSessionId}.`);
    data.executionSessionId = executionSessionId;
  }

  if (patch.wait === null) {
    delete data.waitReason;
    delete data.waitSummary;
    delete data.waitCode;
  } else if (patch.wait) {
    data.waitReason = patch.wait.reason;
    data.waitSummary = patch.wait.summary;
    const code = patch.wait.code?.trim();
    if (code) data.waitCode = code;
    else delete data.waitCode;
  }

  if (patch.currentResultId === null) delete data.currentResultId;
  else if (typeof patch.currentResultId === "string") {
    if (
      patch.currentResultId !== patch.currentResultId.trim() ||
      !isTaskResultId(patch.currentResultId)
    ) {
      throw new Error(`Invalid Task currentResultId: ${patch.currentResultId}.`);
    }
    data.currentResultId = patch.currentResultId;
  }

  if (patch.requester) {
    const nextRequester = parseTaskActorRef(patch.requester, "requester");
    data.requester = serializeTaskActorRef(nextRequester);
    const derived = deriveIntegrationAuthority({ requester: nextRequester });
    data.integrationAuthority = {
      actor: { kind: derived.actor.kind, id: derived.actor.id },
      mutator: "service",
    };
  }
  if (patch.statusDetail === null) delete data.statusDetail;
  else if (patch.statusDetail !== undefined) {
    data.statusDetail = parseTaskStatusDetail(patch.statusDetail);
  }
  if (patch.updatedAt) data.updatedAt = patch.updatedAt;

  for (const key of ["workspace", "worktree", "branch", "targetBranch"] as const) {
    const value = patch[key];
    if (value === null) delete data[key];
    else if (typeof value === "string") data[key] = value;
  }

  if (patch.roleBranchBase === null) delete data.roleBranchBase;
  else if (typeof patch.roleBranchBase === "string" && patch.roleBranchBase.trim()) {
    data.roleBranchBase = patch.roleBranchBase.trim();
  }

  if (patch.baseCommit === null) delete data.baseCommit;
  else if (typeof patch.baseCommit === "string" && patch.baseCommit.trim()) {
    // Exact workspaceLane.baseCommit only — do not auto-mirror into roleBranchBase.
    data.baseCommit = patch.baseCommit.trim();
  }

  if (patch.baseCommitCapture === null) delete data.baseCommitCapture;
  else if (patch.baseCommitCapture) {
    data.baseCommitCapture = serializeBaseCommitCapture(patch.baseCommitCapture);
  }

  if (patch.integrationAuthority === null) delete data.integrationAuthority;
  else if (patch.integrationAuthority) {
    if (data.requester === undefined || data.requester === null) {
      throw new Error(
        "patchTaskRecord integrationAuthority requires requester on the Task record."
      );
    }
    const parentForAuth = parseTaskActorRef(data.requester, "requester");
    const validated = assertIntegrationAuthorityMatchesParent(
      patch.integrationAuthority,
      parentForAuth
    );
    data.integrationAuthority = {
      actor: { kind: validated.actor.kind, id: validated.actor.id },
      mutator: "service",
    };
  }

  if (patch.contextGeneration !== undefined) {
    if (!/^cg-v1-[a-f0-9]{64}$/.test(patch.contextGeneration)) {
      throw new Error("patchTaskRecord contextGeneration must be a canonical cg-v1 digest.");
    }
    const currentCard = loadTaskContextCardFromFrontmatter(data);
    if (!currentCard) {
      throw new Error(`Invalid Task record format: ${path} (missing Task Context Card).`);
    }
    data.contextCard = serializeTaskContextCardForFrontmatter({
      ...currentCard,
      contextGeneration: patch.contextGeneration,
    });
    delete data.contextGeneration;
  }

  const assigneeRoleId = typeof data.assigneeRoleId === "string" ? data.assigneeRoleId.trim() : "";
  const executionSessionId = typeof data.executionSessionId === "string" ? data.executionSessionId.trim() : "";
  if (!assigneeRoleId && !executionSessionId) {
    throw new Error("patchTaskRecord cannot remove the final assigneeRoleId/executionSessionId binding.");
  }
  if (assigneeRoleId && !isRoleId(assigneeRoleId)) throw new Error(`Invalid Task assigneeRoleId: ${assigneeRoleId}.`);
  if (executionSessionId && !isSessionId(executionSessionId)) throw new Error(`Invalid Task executionSessionId: ${executionSessionId}.`);

  await fs.writeFile(path, serializeFrontmatter(data, body, keyOrder));
  return loadTaskRecord(fs, path);
}

function parseTaskState(value: unknown): TaskState {
  if (
    value === "queued" ||
    value === "running" ||
    value === "waiting" ||
    value === "submitted" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "interrupted" ||
    value === "failed"
  ) {
    return value;
  }
  throw new Error(`Invalid task state: ${String(value)}.`);
}

function parseWaitFields(data: Record<string, unknown>): TaskWait | undefined {
  const reason = data.waitReason;
  const summary = data.waitSummary;
  if (
    (reason === "user-input" ||
      reason === "review" ||
      reason === "external") &&
    typeof summary === "string"
  ) {
    const code =
      typeof data.waitCode === "string" && data.waitCode.trim()
        ? data.waitCode.trim()
        : undefined;
    return { reason, summary, ...(code ? { code } : {}) };
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
