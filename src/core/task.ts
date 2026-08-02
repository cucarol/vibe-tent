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
  assertParentReviewerEqual,
  DEFAULT_DELIVERY_POLICY,
  isTaskId,
  makeTaskId,
  mayElevateDeliveryPolicy,
  normalizeDeliveryPolicyRead,
  parseTaskActorRef,
  resolveParentReviewerPair,
  roleTaskActors,
  userTaskActors,
  type DeliveryPolicy,
  type TaskActorRef,
  type TaskOutcome,
  type TaskState,
  type TaskWait,
  type WorkspaceLane,
} from "./task-model.js";
import {
  assertIntegrationAuthorityMatchesParent,
  buildTaskContextCard,
  deriveIntegrationAuthority,
  loadTaskContextCardFromFrontmatter,
  serializeTaskContextCardForFrontmatter,
  type IntegrationAuthority,
  type TaskContextCardRef,
  type TaskContextCardV1,
} from "./task-context-card.js";
import {
  normalizeContextCardNodeRef,
  parseContextCardNodeRefs,
  taskReferencedNodeIds,
} from "./task-node-refs.js";

export interface RoleWorkspaceContract {
  workspace: string;
  worktree: string;
  branch: string;
  targetBranch: string;
  /**
   * Exact branch tip (full SHA) at ensure/create time.
   * Written as Task baseCommit + roleBranchBase when the execution lane is first bound
   * (first claim for Role responsibility; startSession/asSub for a Connection Session).
   */
  baseCommit?: string;
}

/** How workspaceLane.baseCommit was first recorded (compact Task audit; no new entity). */
export type BaseCommitCaptureSource = "first-claim" | "explicit-backfill";

/**
 * Compact audit bag for capture-once baseCommit.
 * Written on Role first-claim or explicit legacy backfill; never rewritten on same-SHA idempotent repeat.
 */
export type BaseCommitCapture = {
  source: BaseCommitCaptureSource;
  /** Exact full SHA captured (same as Task.baseCommit). */
  baseCommit: string;
  /** Authorizing actor (parent/reviewer for backfill; parentActor for first-claim). */
  actor: TaskActorRef;
  /** ISO-8601 capture timestamp. */
  capturedAt: string;
};

export interface TaskEnvelopeInput {
  /** Durable Role responsibility/handoff. Orthogonal to exact Session execution. */
  roleId?: string;
  /** Exact executing Session. Connection identity is never stored on a Task. */
  sessionId?: string;
  /**
   * Node refs for this Task (durable id + optional path hint).
   * Persisted only as Task.contextCard.refs.nodes[]. Formal Tasks require at
   * least one real Node; fake root identities are never accepted.
   */
  nodeRefs: { id: string; path: string }[];
  manifestPath: string;
  userPrompt: string;
  workspace?: RoleWorkspaceContract;
  /** Explicit parent actor. Required on every canonical write. */
  parentActor: TaskActorRef;
  /**
   * Explicit Delivery reviewer (V0.2). Optional: when omitted, derived equal to
   * parentActor once. When present, must match parentActor exactly (both
   * fields are still persisted).
   */
  reviewer?: TaskActorRef;
  /**
   * Sub-dispatch Git lane flag. Missing on disk reads as false (peer).
   * When true, targetBranch is the parent role branch. Review authority uses
   * parentActor/reviewer, not this flag. asSub is lane-only.
   */
  asSub?: boolean;
  /** Full operational id (tk-…). Generated if omitted. */
  id?: string;
  deliveryPolicy?: DeliveryPolicy;
  /**
   * Optional explicit objective/acceptance for contextCard.
   * Defaults: objective = userPrompt; acceptance = [objective] when omitted.
   */
  objective?: string;
  acceptance?: string[];
  /** Internal rollback hook: reports the exact path before the first Task write. */
  onPathAllocated?: (path: string) => void;
}

/** Operational task record. */
export interface TaskEnvelope {
  path: string;
  /** Durable Role responsibility/handoff, when this is a Role Task. */
  roleId?: string;
  /**
   * Node refs are sole-sourced from `contextCard.refs.nodes` via
   * `taskReferencedNodeIds(task)` / `primaryNodeId(task)`.
   * No parallel legacy Node-reference projection.
   */
  manifest: string;
  /** Canonical lifecycle state (task-api §2). */
  state: TaskState;
  /** Operational task id (tk-…). May be absent on pre-B4 envelopes. */
  id?: string;
  /**
   * Explicit parent actor (V0.2). Required after disk migration / on new writes.
   * Optional only on synthetic/partial fixtures before write.
   */
  parentActor?: TaskActorRef;
  /**
   * Explicit Delivery reviewer (V0.2). Required with parentActor; ordinary
   * accept/reject authority equals this actor exactly.
   */
  reviewer?: TaskActorRef;
  /**
   * Peer vs sub Git lane. Missing field reads as false.
   * Persisted only when true; see taskAsSub(). Not used for review authority.
   */
  asSub?: boolean;
  workspace?: string;
  worktree?: string;
  branch?: string;
  targetBranch?: string;
  /**
   * Immutable full SHA of the role branch tip at first Git-lane bind for this task.
   * Optional; absent on non-Git / pre-baseline envelopes until backfilled once.
   * Kept in sync with baseCommit for managed collection (same capture-once baseline).
   */
  roleBranchBase?: string;
  /**
   * Exact full SHA of the Task worktree start (cx-5q6za6).
   * Authoritative for pre-ready Delivery history gate; capture-once with roleBranchBase.
   */
  baseCommit?: string;
  /**
   * Compact audit for capture-once workspaceLane.baseCommit (no separate entity).
   * source distinguishes Role first-claim vs explicit legacy backfill.
   * Immutable once written: same-SHA backfill leaves this bag unchanged.
   */
  baseCommitCapture?: BaseCommitCapture;
  /**
   * Integration authority on the workspace lane (actor = parent/reviewer, mutator = service).
   * Ordinary executors never mutate target; Service integrates after parent accept.
   */
  integrationAuthority?: IntegrationAuthority;
  /**
   * Authoritative Task Context Card v1 (cx-5q6za6).
   * Projected only from envelope frontmatter `contextCard`.
   */
  contextCard: TaskContextCardV1;
  /** In-memory projection of contextCard.contextGeneration. */
  contextGeneration?: string;
  /** Convenience projection of contextCard.taskDeltaDigest when present. */
  taskDeltaDigest?: string;
  deliveryPolicy?: DeliveryPolicy;
  /** Exact executing Session; required for Session-only Tasks. */
  sessionId?: string;
  wait?: TaskWait;
  activeDeliveryId?: string;
  /**
   * Last explicit Task execution outcome when recorded (managed final report).
   * Optional; absence does not block public task.deliver.
   */
  lastOutcome?: TaskOutcome;
  createdAt?: string;
  updatedAt?: string;
  /** Immutable user prompt body (after frontmatter). */
  prompt?: string;
}

/**
 * Discover canonical Task envelopes under Role and Session namespaces.
 * - Role: temp/roles/<roleId>/tasks/*.md
 * - Session-only: temp/sessions/<sessionId>/tasks/*.md
 */
export async function loadTaskEnvelopes(fs: FsAdapter): Promise<TaskEnvelope[]> {
  const tasks: TaskEnvelope[] = [];
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
  tasks: TaskEnvelope[]
): Promise<void> {
  if (!(await fs.exists(taskDir))) return;
  for (const entry of await fs.listDir(taskDir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path = join(taskDir, entry.name);
    tasks.push(await loadTaskEnvelope(fs, path));
  }
}

/** True when the Task carries durable Role responsibility. */
export function taskHasRole(task: Pick<TaskEnvelope, "roleId">): boolean {
  return typeof task.roleId === "string";
}

/** Compact diagnostic only; never parsed as an assignment wire. */
export function taskExecutionLabel(
  task: Pick<TaskEnvelope, "roleId" | "sessionId">
): string {
  return [task.roleId ? `roleId=${task.roleId}` : "", task.sessionId ? `sessionId=${task.sessionId}` : ""]
    .filter(Boolean)
    .join(" ");
}

/** Effective sub-dispatch Git-lane flag; missing field reads as false (peer). */
export function taskAsSub(task: Pick<TaskEnvelope, "asSub">): boolean {
  return task.asSub === true;
}

/** Parent is a durable Role (Role-dispatched Task). */
export function taskParentIsRole(
  task: Pick<TaskEnvelope, "parentActor">
): boolean {
  return task.parentActor?.kind === "role";
}

/** Durable parent role id, or undefined when parent is user. */
export function taskParentRoleId(
  task: Pick<TaskEnvelope, "parentActor">
): string | undefined {
  return task.parentActor?.kind === "role" ? task.parentActor.id : undefined;
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
  if (source !== "first-claim" && source !== "explicit-backfill") {
    throw new Error(
      `Task baseCommitCapture.source must be first-claim|explicit-backfill; got ${String(source)}.`
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
  // Reuse parent/reviewer wire shape; re-label errors for capture audit.
  let actor: TaskActorRef;
  try {
    actor = parseTaskActorRef(raw.actor, "parentActor");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.replace(/Task parentActor/g, "Task baseCommitCapture.actor"));
  }
  return { source, baseCommit, actor, capturedAt };
}

/**
 * Resolve parentActor + reviewer for a **new** dispatch write.
 * Requires explicit parentActor. Reviewer may be omitted and is then derived
 * equal to parentActor; when present it must match exactly (no Role A → Role B).
 * Equality is enforced only via resolveParentReviewerPair (shared with load/RPC).
 */
export function resolveDispatchActors(input: {
  parentActor?: TaskActorRef;
  reviewer?: TaskActorRef;
}): { parentActor: TaskActorRef; reviewer: TaskActorRef } {
  if (!input.parentActor) {
    throw new Error(
      "task.dispatch requires explicit parentActor { kind, id }."
    );
  }
  return resolveParentReviewerPair({
    parentActor: input.parentActor,
    reviewer: input.reviewer,
  });
}

export async function loadTaskEnvelope(fs: FsAdapter, path: string): Promise<TaskEnvelope> {
  if (!(await fs.exists(path))) throw new Error(`Task envelope not found: ${path}.`);
  const { data, body } = parseFrontmatter(await fs.readFile(path));
  if (data.type !== "task" || typeof data.manifest !== "string") {
    throw new Error(`Invalid task envelope format: ${path}.`);
  }
  const roleId = typeof data.roleId === "string" ? data.roleId.trim() : "";
  const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
  if (!roleId && !sessionId) {
    throw new Error(`Invalid task envelope format: ${path} (roleId or sessionId is required).`);
  }
  if (roleId && !isRoleId(roleId)) {
    throw new Error(`Invalid task envelope format: ${path} (invalid roleId).`);
  }
  if (sessionId && !isSessionId(sessionId)) {
    throw new Error(`Invalid task envelope format: ${path} (invalid sessionId).`);
  }

  const state = parseTaskState(data.state);

  // Resolve actors before Context Card so actor mismatch errors are not masked
  // by missing-card errors.
  const actors = resolveActorsFromDisk(data);

  // Complete Context Card v1 is the sole Node-ref source. Incomplete/partial → fail loud.
  const contextCard = loadTaskContextCardFromFrontmatter(data) ?? undefined;
  if (!contextCard) {
    throw new Error(
      `Invalid task envelope format: ${path} (missing Task.contextCard.refs.nodes).`
    );
  }
  if (parseContextCardNodeRefs(contextCard.refs.nodes).length === 0) {
    throw new Error(
      `Invalid task envelope format: ${path} (Task.contextCard.refs.nodes requires at least one Node).`
    );
  }

  const task: TaskEnvelope = {
    path,
    ...(roleId ? { roleId } : {}),
    ...(sessionId ? { sessionId } : {}),
    manifest: data.manifest,
    state,
    parentActor: actors.parentActor,
    reviewer: actors.reviewer,
    prompt: body.trim() || undefined,
    contextCard,
  };
  if (typeof data.id === "string" && isTaskId(data.id)) task.id = data.id;
  if (data.asSub === true) task.asSub = true;
  if (typeof data.workspace === "string") task.workspace = data.workspace;
  if (typeof data.worktree === "string") task.worktree = data.worktree;
  if (typeof data.branch === "string") task.branch = data.branch;
  if (typeof data.targetBranch === "string") task.targetBranch = data.targetBranch;
  if (typeof data.roleBranchBase === "string" && data.roleBranchBase.trim()) {
    task.roleBranchBase = data.roleBranchBase.trim();
  }
  // Exact workspaceLane.baseCommit only — never silently substitute roleBranchBase.
  // Legacy envelopes without baseCommit stay without it until explicit migration / new bind.
  if (typeof data.baseCommit === "string" && data.baseCommit.trim()) {
    task.baseCommit = data.baseCommit.trim();
  }
  // Compact baseCommit audit (first-claim | explicit-backfill). Absence is fine for
  // pre-audit envelopes and non-Git Tasks; never invent from roleBranchBase.
  // When capture exists: baseCommit must exist and equal capture.baseCommit (fail loud).
  const baseCommitCapture = parseBaseCommitCapture(data.baseCommitCapture);
  if (baseCommitCapture) {
    const recordedBase = task.baseCommit?.trim() || "";
    if (!recordedBase) {
      throw new Error(
        `Invalid task envelope format: ${path} (baseCommitCapture present but baseCommit missing).`
      );
    }
    if (recordedBase !== baseCommitCapture.baseCommit) {
      throw new Error(
        `Invalid task envelope format: ${path} (baseCommit ${recordedBase} !== ` +
          `baseCommitCapture.baseCommit ${baseCommitCapture.baseCommit}).`
      );
    }
    task.baseCommitCapture = baseCommitCapture;
  }
  // Recorded lane truth: only set TaskEnvelope.integrationAuthority when the on-disk
  // bag exists and validates against parent/reviewer + service mutator.
  // Absence stays absent so ensureTaskWorkspaceLane can detect and persist the
  // canonical derived bag (no in-memory phantom that skips the write).
  // Context / workspaceLane projections derive separately via deriveIntegrationAuthority.
  if (
    data.integrationAuthority !== undefined &&
    data.integrationAuthority !== null &&
    task.parentActor &&
    task.reviewer
  ) {
    task.integrationAuthority = assertIntegrationAuthorityMatchesParent(
      data.integrationAuthority,
      task.parentActor,
      task.reviewer
    );
  }
  // Context Card v1 already loaded above from its sole nested wire.
  task.contextGeneration = contextCard.contextGeneration;
  task.taskDeltaDigest = contextCard.taskDeltaDigest;
  // Narrow read boundary: historical on-disk `manual` projects as `review`.
  const deliveryPolicy = normalizeDeliveryPolicyRead(data.deliveryPolicy);
  if (deliveryPolicy) task.deliveryPolicy = deliveryPolicy;
  if (typeof data.activeDeliveryId === "string") task.activeDeliveryId = data.activeDeliveryId;
  if (data.lastOutcome === "delivered" || data.lastOutcome === "blocked" || data.lastOutcome === "needs-input") {
    task.lastOutcome = data.lastOutcome;
  }
  if (typeof data.createdAt === "string") task.createdAt = data.createdAt;
  if (typeof data.updatedAt === "string") task.updatedAt = data.updatedAt;
  const wait = parseWaitFields(data);
  if (wait) task.wait = wait;
  return task;
}

/**
 * Resolve parentActor/reviewer from on-disk frontmatter.
 * Explicit fields are required.
 */
function resolveActorsFromDisk(data: Record<string, unknown>): {
  parentActor: TaskActorRef;
  reviewer: TaskActorRef;
} {
  const hasParent = data.parentActor !== undefined && data.parentActor !== null;
  const hasReviewer = data.reviewer !== undefined && data.reviewer !== null;
  if (hasParent || hasReviewer) {
    if (!hasParent || !hasReviewer) {
      throw new Error(
        "Invalid task envelope: parentActor and reviewer must both be present when either is set."
      );
    }
    // Shared pair resolver — equality enforced; never return unchecked pair.
    return resolveParentReviewerPair({
      parentActor: parseTaskActorRef(data.parentActor, "parentActor"),
      reviewer: parseTaskActorRef(data.reviewer, "reviewer"),
    });
  }
  throw new Error("Invalid task envelope: missing parentActor/reviewer.");
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

/**
 * Dynamic task pointers only — no workspaceRoot/CLI/file-read tutorial.
 * Path contract lives once on Context Card (managed) or in external relay path block.
 */
function formatTaskPointers(task: TaskEnvelope): string {
  const lines = [
    `Task envelope: ${task.path}`,
    `Manifest: ${task.manifest}`,
  ];
  if (task.contextCard) {
    const nodeIds = taskReferencedNodeIds(task);
    lines.push(`contextCard.refs.nodes: ${nodeIds.join(", ")}`);
  }
  if (task.parentActor) {
    lines.push(
      `parentActor: ${task.parentActor.kind}:${task.parentActor.id}`
    );
  }
  if (task.reviewer) {
    lines.push(`reviewer: ${task.reviewer.kind}:${task.reviewer.id}`);
  }
  if (task.deliveryPolicy) {
    lines.push(`deliveryPolicy: ${task.deliveryPolicy}`);
  }
  if (task.roleId) {
    const initCli = join("temp", ROLES_TEMP_DIR, task.roleId, "init.md");
    const initFile = join(".tent", initCli);
    lines.push(`roleId: ${task.roleId}`);
    lines.push(`Role init file: ${initFile} (CLI path remains ${initCli}).`);
  }
  if (task.sessionId) lines.push(`sessionId: ${task.sessionId}`);
  if (!task.roleId) lines.push(`Session-only execution (no durable Role responsibility).`);
  return lines.join("\n");
}

/**
 * Path roots for external relay only (managed bootstrap uses Context Card once).
 */
function formatExternalPathBlock(task: TaskEnvelope, roots: TaskPromptRoots): string {
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
 * External / manual wake relay: task is still queued — agent must claim + deliver via CLI.
 * Used for clipboard relay and dispatch.relayPrompt, NOT for service startSession bootstrap.
 */
export function relayPromptForTask(
  task: TaskEnvelope,
  roots: string | TaskPromptRoots
): string {
  const resolved = resolveTaskPromptRoots(roots);
  const assigneeLine =
    task.roleId
      ? `A Tent task has been handed to Role ${task.roleId}.\n`
      : `A Tent task is bound to Session ${task.sessionId}.\n`;
  const initStep =
    task.roleId
      ? `4. If this is a new session for this Role, complete Role init first (read the init file above).`
      : `4. Read the task envelope and task-scoped manifest pointers above; no Role init applies.`;
  return (
    assigneeLine +
    `${formatExternalPathBlock(task, resolved)}\n` +
    `${formatTaskPointers(task)}\n` +
    `1. Run \`tent task claim ${task.path}\` to take this task (Local Service RPC).\n` +
    `2. Read the Task Context Card (\`tent task get ${task.path}\` or the envelope file), then resolve each id in \`contextCard.refs.nodes\` with \`tent node get <nodeId>\`.\n` +
    `3. When finished, run \`tent task deliver ${task.path} --summary <text>\` (optional: --commits sha,sha).\n` +
    initStep
  );
}

/**
 * Extract the near-field user prompt from a task envelope body.
 * Envelope layout: Context Pointers + `## User Prompt` — never the node/manifest body.
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
 * Managed ACP startSession bootstrap body (service already claimed).
 * Dynamic task pointers + near-field user prompt only.
 * Path tutorial is owned by Context Card; no claim/get/deliver CLI steps.
 * Final assistant response is captured by Local Service and auto-delivered.
 *
 * `roots` is accepted for call-site compatibility but not repeated here —
 * managed bootstrap prefixes Context Card (which carries workspaceRoot/systemRoot).
 */
export function sessionBootstrapPromptForTask(
  task: TaskEnvelope,
  _roots?: string | TaskPromptRoots
): string {
  const userPrompt = extractTaskUserPrompt(task);
  const readyLine =
    task.roleId
      ? `A Tent Session is executing a Task for Role ${task.roleId}.\n`
      : `A Tent managed ACP Session is executing this Task.\n`;
  return (
    readyLine +
    `${formatTaskPointers(task)}\n` +
    `Service status: this task is already claimed (state=${task.state || "running"}).\n` +
    `Managed path: Local Service already claimed this task. A non-empty final report is delivered by default after turn settle. ` +
    `Use \`outcome: blocked\` or \`outcome: needs-input\` only as an explicit control signal when work cannot complete; never self-accept.\n` +
    (!task.roleId
      ? `Session-only Task: rely on Task/Node pointers only — no Role init or Role identity.\n`
      : "") +
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

export async function writeTaskEnvelope(
  fs: FsAdapter,
  clock: Clock,
  input: TaskEnvelopeInput
): Promise<string> {
  const userPrompt = input.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");

  const roleId = input.roleId?.trim() || "";
  const sessionId = input.sessionId?.trim() || "";
  if (!roleId && !sessionId) {
    throw new Error("Task requires roleId or sessionId at creation.");
  }
  if (roleId && !isRoleId(roleId)) throw new Error(`Invalid Task roleId: ${roleId}.`);
  if (sessionId && !isSessionId(sessionId)) {
    throw new Error(`Invalid Task sessionId: ${sessionId}.`);
  }
  const dir = roleId ? roleTasksDir(roleId) : sessionTasksDir(sessionId);
  await ensureDir(fs, dir);
  const requestedId = input.id?.trim() || "";
  if (requestedId && !isTaskId(requestedId)) {
    throw new Error(`Invalid Task id: ${requestedId}.`);
  }
  const id = requestedId || makeTaskId();

  if (!Array.isArray(input.nodeRefs) || input.nodeRefs.length === 0) {
    throw new Error("Task requires at least one canonical Node ref.");
  }
  const nodeRefs: TaskContextCardRef[] = parseContextCardNodeRefs(
    input.nodeRefs.map((node) => ({ id: node.id, path: node.path }))
  );
  const primaryRef = nodeRefs[0]!.id;
  const stem = taskStem(clock.now(), primaryRef);
  const path = await uniqueMarkdownPath(fs, dir, stem);
  input.onPathAllocated?.(path);
  const now = clock.now();
  const actors = resolveDispatchActors({
    parentActor: input.parentActor,
    reviewer: input.reviewer,
  });
  const deliveryPolicy = input.deliveryPolicy ?? DEFAULT_DELIVERY_POLICY;
  // Downstream Task Agent → parent: always review. Elevated policies only for
  // durable Role user-facing deliveries (parent=user + roleId).
  if (
    deliveryPolicy !== "review" &&
    !mayElevateDeliveryPolicy({
      parentActor: actors.parentActor,
      roleId: roleId || undefined,
    })
  ) {
    throw new Error(
      `deliveryPolicy=${deliveryPolicy} is only legal for a durable Role's user-facing delivery; ` +
        `downstream Task Agent → parent must use review (parent=${actors.parentActor.kind}:${actors.parentActor.id}).`
    );
  }

  const objective = input.objective?.trim() || "";
  const acceptance =
    input.acceptance && input.acceptance.length > 0
      ? input.acceptance.map((s) => s.trim()).filter(Boolean)
      : [];

  // Full Context Card v1 on every new write — sole Node-ref wire is refs.nodes[].
  // contextGeneration is absent until a managed Session computes and uses it.
  const contextCard = buildTaskContextCard({
    objective,
    acceptance,
    refs: {
      nodes: nodeRefs,
      tasks: [],
      deliveries: [],
      git: [],
    },
    userPrompt,
  });

  const data: Record<string, unknown> = {
    type: "task",
    id,
    state: "queued",
    ...(roleId ? { roleId } : {}),
    ...(sessionId ? { sessionId } : {}),
    parentActor: serializeTaskActorRef(actors.parentActor),
    reviewer: serializeTaskActorRef(actors.reviewer),
    // Sole persisted Node-ref wire.
    contextCard: serializeTaskContextCardForFrontmatter(contextCard),
    manifest: input.manifestPath,
    deliveryPolicy,
    createdAt: now,
    updatedAt: now,
  };
  // Persist only when true; missing means peer (false). Git-lane sub marker only.
  if (input.asSub === true) data.asSub = true;
  if (input.workspace) {
    data.workspace = input.workspace.workspace;
    data.worktree = input.workspace.worktree;
    data.branch = input.workspace.branch;
    data.targetBranch = input.workspace.targetBranch;
    // Lane exists: persist exact tip as Delivery baseCommit + legacy collection baseline.
    // Role assignee dispatch omits workspace entirely (base captured at first claim).
    // Connection execution / non-Git also omit workspace (no fake base).
    // Connection-asSub may still bind tent-task lane + tip at dispatch.
    const tip =
      typeof input.workspace.baseCommit === "string"
        ? input.workspace.baseCommit.trim()
        : "";
    if (tip) {
      data.baseCommit = tip;
      data.roleBranchBase = tip;
    }
  }
  const pointers = nodeRefs
    .map((ref) => `- ${ref.id}: ${ref.path || "(path hint pending)"}`)
    .join("\n");
  const body =
    `# Task\n\n` +
    `## Context Pointers\n\n${pointers || "(none)"}\n\n` +
    `- Manifest: ${input.manifestPath}\n` +
    (input.id || id ? `- Task id: ${id}\n` : "") +
    `\n## User Prompt\n\n${userPrompt}\n`;
  await fs.writeFile(path, serializeFrontmatter(data, body));
  return path;
}

export async function ackTaskEnvelope(fs: FsAdapter, path: string): Promise<void> {
  await patchTaskEnvelope(fs, path, {
    state: "running",
  });
}

export async function cancelTaskEnvelope(fs: FsAdapter, path: string): Promise<void> {
  const task = await loadTaskEnvelope(fs, path);
  if (task.state !== "queued") {
    throw new Error("Only queued task envelopes can be cancelled.");
  }
  await fs.remove(path);
}

export interface TaskEnvelopePatch {
  state?: TaskState;
  /** Exact Session rebind (replaceSession); clearing is forbidden. */
  sessionId?: string;
  wait?: TaskWait | null;
  activeDeliveryId?: string | null;
  deliveryPolicy?: DeliveryPolicy;
  parentActor?: TaskActorRef;
  reviewer?: TaskActorRef;
  lastOutcome?: TaskOutcome | null;
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
  /**
   * Persist authoritative Context Card v1 under frontmatter `contextCard`.
   */
  contextCard?: TaskContextCardV1;
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
  }
  if (typeof patch.sessionId === "string") {
    const sessionId = patch.sessionId.trim();
    if (!isSessionId(sessionId)) throw new Error(`Invalid Task sessionId: ${sessionId}.`);
    data.sessionId = sessionId;
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

  if (patch.activeDeliveryId === null) delete data.activeDeliveryId;
  else if (typeof patch.activeDeliveryId === "string") data.activeDeliveryId = patch.activeDeliveryId;

  if (patch.deliveryPolicy) data.deliveryPolicy = patch.deliveryPolicy;
  if (patch.parentActor || patch.reviewer) {
    // Keep parent/reviewer equal on every write via shared pair resolver.
    const nextParent = patch.parentActor
      ? parseTaskActorRef(patch.parentActor, "parentActor")
      : data.parentActor !== undefined && data.parentActor !== null
        ? parseTaskActorRef(data.parentActor, "parentActor")
        : undefined;
    if (!nextParent) {
      throw new Error(
        "patchTaskEnvelope parentActor/reviewer requires an existing or explicit parentActor."
      );
    }
    const nextReviewer = patch.reviewer
      ? parseTaskActorRef(patch.reviewer, "reviewer")
      : patch.parentActor
        ? undefined // derive equal to parent
        : data.reviewer !== undefined && data.reviewer !== null
          ? parseTaskActorRef(data.reviewer, "reviewer")
          : undefined;
    const pair = resolveParentReviewerPair({
      parentActor: nextParent,
      reviewer: nextReviewer,
    });
    data.parentActor = serializeTaskActorRef(pair.parentActor);
    data.reviewer = serializeTaskActorRef(pair.reviewer);
    // Authority is a projection of parent/reviewer + service — re-derive on actor write.
    const derived = deriveIntegrationAuthority({
      parentActor: pair.parentActor,
      reviewer: pair.reviewer,
    });
    data.integrationAuthority = {
      actor: { kind: derived.actor.kind, id: derived.actor.id },
      mutator: "service",
    };
  }
  if (patch.lastOutcome === null) delete data.lastOutcome;
  else if (
    patch.lastOutcome === "delivered" ||
    patch.lastOutcome === "blocked" ||
    patch.lastOutcome === "needs-input"
  ) {
    data.lastOutcome = patch.lastOutcome;
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
    // Persist only after validating against envelope parent/reviewer (already
    // equal-resolved above when actors were patched). Reject forged bags.
    if (data.parentActor === undefined || data.parentActor === null) {
      throw new Error(
        "patchTaskEnvelope integrationAuthority requires parentActor/reviewer on the envelope."
      );
    }
    const parentForAuth = parseTaskActorRef(data.parentActor, "parentActor");
    const reviewerForAuth =
      data.reviewer !== undefined && data.reviewer !== null
        ? parseTaskActorRef(data.reviewer, "reviewer")
        : parentForAuth;
    const validated = assertIntegrationAuthorityMatchesParent(
      patch.integrationAuthority,
      parentForAuth,
      reviewerForAuth
    );
    data.integrationAuthority = {
      actor: { kind: validated.actor.kind, id: validated.actor.id },
      mutator: "service",
    };
  }

  if (patch.contextCard) {
    if (parseContextCardNodeRefs(patch.contextCard.refs.nodes).length === 0) {
      throw new Error("patchTaskEnvelope contextCard requires at least one canonical Node ref.");
    }
    data.contextCard = serializeTaskContextCardForFrontmatter(patch.contextCard);
    delete data.contextGeneration;
    delete data.taskDeltaDigest;
  }

  const roleId = typeof data.roleId === "string" ? data.roleId.trim() : "";
  const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
  if (!roleId && !sessionId) {
    throw new Error("patchTaskEnvelope cannot remove the final Task roleId/sessionId binding.");
  }
  if (roleId && !isRoleId(roleId)) throw new Error(`Invalid Task roleId: ${roleId}.`);
  if (sessionId && !isSessionId(sessionId)) throw new Error(`Invalid Task sessionId: ${sessionId}.`);

  await fs.writeFile(path, serializeFrontmatter(data, body, keyOrder));
  return loadTaskEnvelope(fs, path);
}

export function workspaceLaneOf(task: TaskEnvelope): WorkspaceLane | undefined {
  if (
    !task.workspace &&
    !task.worktree &&
    !task.branch &&
    !task.targetBranch &&
    !task.baseCommit &&
    !task.integrationAuthority
  ) {
    return undefined;
  }
  // baseCommit is exact only — never substitute roleBranchBase in the projection.
  // integrationAuthority on the lane projection: prefer recorded envelope field;
  // otherwise derive for Context projection only (does not invent envelope truth).
  const integrationAuthority = task.integrationAuthority
    ? task.integrationAuthority
    : task.parentActor && task.reviewer
      ? deriveIntegrationAuthority({
          parentActor: task.parentActor,
          reviewer: task.reviewer,
        })
      : undefined;
  return {
    workspace: task.workspace,
    worktree: task.worktree,
    branch: task.branch,
    targetBranch: task.targetBranch,
    ...(task.baseCommit ? { baseCommit: task.baseCommit } : {}),
    ...(integrationAuthority ? { integrationAuthority } : {}),
  };
}

export function primaryNodeId(task: TaskEnvelope): string | undefined {
  return taskReferencedNodeIds(task)[0];
}

function parseTaskState(value: unknown): TaskState {
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
