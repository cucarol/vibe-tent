// Central RPC adapters for Desktop A2U / tool / U2A pending closed-loop.
// Pure: normalizes service projections into view models + builds resolve payloads.
// Renderer templates must not re-implement field compatibility here.

/**
 * Event types that invalidate pending-interaction projections.
 * On any of these, Desktop re-fetches listPending / task.list — never invents state.
 */
export const PENDING_INTERACTION_EVENT_TYPES = [
  "toolApproval.pending",
  "toolApproval.resolved",
  "userAsk.pending",
  "userAsk.resolved",
  "taskInput.pending",
  "taskInput.delivered",
  "taskInput.consumed",
  "taskInput.cancelled",
  "delivery.updated",
  "task.state",
  "proposal.updated",
] as const;

export type PendingInteractionEventType = (typeof PENDING_INTERACTION_EVENT_TYPES)[number];

export function isPendingInteractionEventType(type: string): boolean {
  return (PENDING_INTERACTION_EVENT_TYPES as readonly string[]).includes(type);
}

/** Events that also require task/delivery/session re-projection. */
export const TASK_PROJECTION_EVENT_TYPES = [
  "task.state",
  "delivery.updated",
  "userAsk.pending",
  "userAsk.resolved",
  "toolApproval.pending",
  "toolApproval.resolved",
  "taskInput.pending",
  "taskInput.delivered",
  "taskInput.consumed",
  "taskInput.cancelled",
] as const;

export function isTaskProjectionEventType(type: string): boolean {
  return (TASK_PROJECTION_EVENT_TYPES as readonly string[]).includes(type);
}

// ---- Normalized view models (safe UI fields only) ----

export type UserAskItem = {
  kind: "userAsk";
  id: string;
  taskPath: string;
  taskId?: string;
  sessionId?: string;
  /** Source role when projected. */
  role?: string;
  question: string;
  choices: Array<{ id: string; label: string }>;
  createdAt: string;
};

export type ToolApprovalItem = {
  kind: "toolApproval";
  id: string;
  sessionId: string;
  taskPath?: string;
  taskId?: string;
  role?: string;
  toolTitle: string;
  /**
   * Compact summary from projected options only.
   * Service does not currently project tool call arguments/params.
   */
  paramsSummary: string;
  options: Array<{ optionId: string; kind?: string; name?: string }>;
  createdAt: string;
  expiresAt: string;
};

export type TaskInputItem = {
  kind: "taskInput";
  id: string;
  taskPath: string;
  taskId?: string;
  sessionId?: string;
  role?: string;
  /** user-input | review-feedback — never folded into UserAsk. */
  inputKind: "user-input" | "review-feedback" | string;
  text?: string;
  contextRefs: string[];
  status: string;
  createdAt: string;
};

export type ProposalItem = {
  kind: "proposal";
  path: string;
  nodeId: string;
  role: string;
  status: string;
  body: string;
  createdAt?: string;
};

// ---- Normalize raw RPC rows (tolerant; never invents domain facts) ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Build tool params summary from projected options only — no guessed args. */
export function summarizeToolApprovalOptions(
  options: Array<{ optionId?: string; kind?: string; name?: string }> | undefined | null
): string {
  if (!options?.length) return "";
  return options
    .map((o) => o.name || o.kind || o.optionId || "")
    .filter(Boolean)
    .join(" · ");
}

export function normalizeUserAsk(raw: unknown): UserAskItem | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const taskPath = str(raw.taskPath);
  const question = str(raw.question);
  if (!id || !taskPath || !question) return null;
  const choicesRaw = Array.isArray(raw.choices) ? raw.choices : [];
  const choices: Array<{ id: string; label: string }> = [];
  for (const c of choicesRaw) {
    if (!isRecord(c)) continue;
    const cid = str(c.id);
    const label = str(c.label);
    if (cid && label) choices.push({ id: cid, label });
  }
  return {
    kind: "userAsk",
    id,
    taskPath,
    taskId: str(raw.taskId),
    sessionId: str(raw.sessionId),
    role: str(raw.role),
    question,
    choices,
    createdAt: strOrEmpty(raw.createdAt),
  };
}

export function normalizeToolApproval(raw: unknown): ToolApprovalItem | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const sessionId = str(raw.sessionId);
  const toolTitle = str(raw.toolTitle);
  if (!id || !sessionId || !toolTitle) return null;
  const optionsRaw = Array.isArray(raw.options) ? raw.options : [];
  const options: Array<{ optionId: string; kind?: string; name?: string }> = [];
  for (const o of optionsRaw) {
    if (!isRecord(o)) continue;
    const optionId = str(o.optionId);
    if (!optionId) continue;
    options.push({
      optionId,
      kind: str(o.kind),
      name: str(o.name),
    });
  }
  return {
    kind: "toolApproval",
    id,
    sessionId,
    taskPath: str(raw.taskPath),
    taskId: str(raw.taskId),
    role: str(raw.role),
    toolTitle,
    paramsSummary: summarizeToolApprovalOptions(options),
    options,
    createdAt: strOrEmpty(raw.createdAt),
    expiresAt: strOrEmpty(raw.expiresAt),
  };
}

export function normalizeTaskInput(raw: unknown): TaskInputItem | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const taskPath = str(raw.taskPath);
  if (!id || !taskPath) return null;
  const status = str(raw.status) || "pending";
  // Only surface still-pending rows in the A2U inbox (delivered/consumed are history).
  if (status !== "pending") return null;
  const kindRaw = str(raw.kind) || "user-input";
  const refs = Array.isArray(raw.contextRefs)
    ? raw.contextRefs.filter((r): r is string => typeof r === "string" && r.length > 0)
    : [];
  return {
    kind: "taskInput",
    id,
    taskPath,
    taskId: str(raw.taskId),
    sessionId: str(raw.sessionId),
    role: str(raw.role),
    inputKind: kindRaw,
    text: str(raw.text),
    contextRefs: refs,
    status,
    createdAt: strOrEmpty(raw.createdAt),
  };
}

export function normalizeProposal(raw: unknown): ProposalItem | null {
  if (!isRecord(raw)) return null;
  const path = str(raw.path);
  if (!path) return null;
  const status = str(raw.status) || "pending";
  if (status !== "pending") return null;
  return {
    kind: "proposal",
    path,
    nodeId: strOrEmpty(raw.nodeId),
    role: strOrEmpty(raw.role),
    status,
    body: strOrEmpty(raw.body),
    createdAt: str(raw.createdAt),
  };
}

export function normalizeUserAskList(result: unknown): UserAskItem[] {
  const list = isRecord(result) && Array.isArray(result.asks) ? result.asks : [];
  return list.map(normalizeUserAsk).filter((x): x is UserAskItem => !!x);
}

export function normalizeToolApprovalList(result: unknown): ToolApprovalItem[] {
  const list = isRecord(result) && Array.isArray(result.approvals) ? result.approvals : [];
  return list.map(normalizeToolApproval).filter((x): x is ToolApprovalItem => !!x);
}

export function normalizeTaskInputList(result: unknown): TaskInputItem[] {
  const list = isRecord(result) && Array.isArray(result.inputs) ? result.inputs : [];
  return list.map(normalizeTaskInput).filter((x): x is TaskInputItem => !!x);
}

export function normalizeProposalList(result: unknown): ProposalItem[] {
  const list = isRecord(result) && Array.isArray(result.proposals) ? result.proposals : [];
  return list.map(normalizeProposal).filter((x): x is ProposalItem => !!x);
}

/**
 * Count items in the shared pending region (each type independent).
 * Delivery review rows are counted separately by callers (from task projection).
 */
export function pendingInteractionCount(parts: {
  userAsks?: unknown[] | null;
  toolApprovals?: unknown[] | null;
  taskInputs?: unknown[] | null;
  proposals?: unknown[] | null;
}): number {
  return (
    (parts.userAsks?.length ?? 0) +
    (parts.toolApprovals?.length ?? 0) +
    (parts.taskInputs?.length ?? 0) +
    (parts.proposals?.length ?? 0)
  );
}

// ---- Resolve / reply payloads (user actor; real RPC shapes) ----

export function buildUserAskReplyPayload(
  askId: string,
  args: { answer?: string; choiceId?: string; actor?: string }
):
  | { ok: true; payload: { askId: string; actor: string; answer?: string; choiceId?: string } }
  | { ok: false; reason: string } {
  const id = askId.trim();
  if (!id) return { ok: false, reason: "缺少提问 id。" };
  const answer = args.answer?.trim() || "";
  const choiceId = args.choiceId?.trim() || "";
  if (!answer && !choiceId) {
    return { ok: false, reason: "请选择一个选项或填写回复。" };
  }
  return {
    ok: true,
    payload: {
      askId: id,
      actor: args.actor ?? "user",
      ...(answer ? { answer } : {}),
      ...(choiceId ? { choiceId } : {}),
    },
  };
}

export function buildUserAskDenyPayload(askId: string, actor = "user") {
  return { askId, actor };
}

export function buildToolApprovalResolvePayload(
  approvalId: string,
  allow: boolean,
  actor = "user"
): { method: "toolApproval.approveOnce" | "toolApproval.deny"; params: { approvalId: string; actor: string } } {
  return {
    method: allow ? "toolApproval.approveOnce" : "toolApproval.deny",
    params: { approvalId, actor },
  };
}

export function buildTaskSendInputPayload(
  workspaceId: string,
  taskPath: string,
  text: string,
  actor = "user"
):
  | { ok: true; payload: { workspaceId: string; taskPath: string; text: string; actor: string } }
  | { ok: false; reason: string } {
  const t = text.trim();
  if (!workspaceId) return { ok: false, reason: "缺少工作区。" };
  if (!taskPath.trim()) return { ok: false, reason: "缺少任务路径。" };
  if (!t) return { ok: false, reason: "请填写补充指令。" };
  return {
    ok: true,
    payload: { workspaceId, taskPath: taskPath.trim(), text: t, actor },
  };
}

/**
 * taskInput.ack is agent-side (role/session binding). Desktop user surface does not
 * call it; documented for completeness / future external agent UIs.
 */
export function buildTaskInputAckPayload(
  workspaceId: string,
  taskPath: string,
  inputId: string,
  actor?: string
) {
  return {
    workspaceId,
    taskPath,
    inputId,
    ...(actor ? { actor } : {}),
  };
}

/** Compact label for taskInput kind (UI kicker only). */
export function taskInputKindLabel(inputKind: string): string {
  if (inputKind === "review-feedback") return "REVIEW FEEDBACK";
  return "TASK INPUT";
}

/**
 * Known contract gaps for this batch — record only; do not invent fields.
 * Pure data for tests / diagnostics.
 */
export const PENDING_INTERACTION_GAPS = [
  {
    id: "toolApproval.params",
    need: "Tool call argument / params summary on toolApproval projection",
    have: "options[] (optionId/kind/name) + toolTitle only; UI summarizes options, never invents args",
  },
  {
    id: "taskInput.globalList",
    need: "Workspace-scoped taskInput.listPending without taskPath fan-out",
    have: "listPending requires workspaceId+taskPath; Desktop fans out over known task paths",
  },
  {
    id: "taskInput.userAck",
    need: "User-facing consume of pending TaskInput (if product wants)",
    have: "taskInput.ack is agent/role-bound; user path is task.sendInput + interrupt/cancel",
  },
] as const;
