// Pure UI model for desktop collaboration closed loop (P0-1).
// No Electron, no FS — builds RPC payloads and view models from projections.

import type {
  DeliveryProjection,
  RoleRegistryEntryProjection,
  SessionProjection,
  AgentConnectionProjection,
  TaskProjection,
  TypeRegistryEntryProjection,
} from "../../service/types.js";

/** Task states still shown in Activity / Inspector action lists (includes failed for retry/cancel). */
export const ACTIONABLE_TASK_STATES = [
  "queued",
  "running",
  "waiting",
  "delivered",
  "failed",
] as const;

export function isActionableTaskState(state: string): boolean {
  return (ACTIONABLE_TASK_STATES as readonly string[]).includes(state);
}

export type CoordinationTypeOption = {
  name: string;
  description?: string;
  color?: string;
};

export type RoleOption = {
  roleId: string;
  name: string;
  description?: string;
};

/** Product-facing machine Agent Connection metadata (safe fields only). */
export type ConnectionOption = {
  connectionId: string;
  adapterId: string;
  displayName: string;
  model?: string;
  /** Compact label: displayName · adapter · model */
  label: string;
};

export type TaskReviewItem = {
  path: string;
  id?: string;
  roleId?: string;
  state: string;
  workNodeIds: string[];
  contextNodeIds: string[];
  prompt?: string;
  activeDeliveryId?: string;
  sessionId?: string;
  /** Bound runtime session projection when known (not chat). */
  sessionState?: string;
  sessionAlive?: boolean;
  sessionConnectionId?: string;
  deliverySummary?: string;
  commits: string[];
  canAcceptOrReject: boolean;
  /** User may start an agent session on this task (queued/running without live session). */
  canStartAgent: boolean;
  /** User may interrupt a live/waiting agent session. */
  canInterrupt: boolean;
  /** User may cancel a non-terminal task that is not mid-delivery review. */
  canCancel: boolean;
  summaryLine: string;
};

export type DispatchFormState = {
  nodeId: string | null;
  /**
   * Whether the selected node may enter the task lifecycle.
   * Legacy field name kept for UI call sites; means usable (!invalid && !archived).
   */
  coordination: boolean;
  role: string;
  prompt: string;
  roles: RoleOption[];
};

export type DispatchValidation = {
  ok: boolean;
  reason: string | null;
  payload: {
    workNodeIds: string[];
    contextNodeIds: string[];
    roleId: string;
    prompt: string;
    parentActor: { kind: "user" | "role"; id: string };
  } | null;
};

export type AcceptPayload = {
  taskPath: string;
  deliveryId: string;
  actor: string;
};

export type RejectPayload = {
  taskPath: string;
  deliveryId: string;
  actor: string;
  note: string;
  resume: boolean;
};

/** Prefer goal among base-tier types; otherwise first sorted name. */
export function pickDefaultCoordinationType(
  types: TypeRegistryEntryProjection[] | CoordinationTypeOption[]
): string | null {
  const names = listCoordinationTypeNames(types);
  if (names.includes("goal")) return "goal";
  return names[0] ?? null;
}

/**
 * Base-tier type names for create/dispatch pickers.
 * Legacy name kept; eligibility is tier === base (coordination chrome retired).
 */
export function listCoordinationTypeNames(
  types: Array<{ name: string; tier?: string; coordination?: boolean } | TypeRegistryEntryProjection>
): string[] {
  return types
    .filter((t) => {
      const tier = "tier" in t ? t.tier : "base";
      // Prefer tier; if transitional wire still sends coordination, require base + true.
      if (tier !== undefined && tier !== "base") return false;
      if ("coordination" in t && typeof t.coordination === "boolean") {
        return t.coordination === true;
      }
      return true;
    })
    .map((t) => t.name)
    .sort((a, b) => a.localeCompare(b));
}

export function listCoordinationTypeOptions(
  types: TypeRegistryEntryProjection[]
): CoordinationTypeOption[] {
  return listCoordinationTypeNames(types).map((name) => ({ name }));
}

export function listRoleOptions(roles: RoleRegistryEntryProjection[]): RoleOption[] {
  return roles
    .map((r) => ({ roleId: r.roleId, name: r.name, description: r.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build Connection picker options from safe connection.list projections.
 */
export function listConnectionOptions(connections: AgentConnectionProjection[]): ConnectionOption[] {
  return connections
    .map((connection) => {
      const parts = [connection.displayName || connection.connectionId, connection.adapterId, connection.model].filter(Boolean);
      return {
        connectionId: connection.connectionId,
        adapterId: connection.adapterId,
        displayName: connection.displayName || connection.connectionId,
        model: connection.model,
        label: parts.join(" · "),
      };
    })
    .sort((a, b) => a.connectionId.localeCompare(b.connectionId));
}

/** Default machine Connection: first sorted Connection. */
export function pickDefaultConnectionId(connections: ConnectionOption[]): string | null {
  return connections[0]?.connectionId ?? null;
}

export type StartSessionPayload = {
  taskPath: string;
  callerKind: "user";
};

/**
 * Build task.startSession payload for the user launch button.
 * Does not claim or start automatically — caller must invoke RPC on click.
 * The Task's exact sessionId is the sole execution binding.
 */
export function buildStartSessionPayload(
  taskPath: string
): { ok: true; payload: StartSessionPayload } | { ok: false; reason: string } {
  const path = taskPath.trim();
  if (!path) {
    return { ok: false, reason: "缺少任务路径。" };
  }
  return {
    ok: true,
    payload: {
      taskPath: path,
      callerKind: "user",
    },
  };
}

/**
 * Validate dispatch form before calling task.dispatch.
 * UI must not invent domain rules beyond empty-field / usable-node gate.
 */
export function validateDispatchForm(form: DispatchFormState): DispatchValidation {
  if (!form.nodeId) {
    return { ok: false, reason: "请先选中一个节点。", payload: null };
  }
  if (!form.coordination) {
    return {
      ok: false,
      reason: "当前概念不可用（无效或已封存），无法派活。",
      payload: null,
    };
  }
  if (!form.roles.length) {
    return {
      ok: false,
      reason: "帐内尚无 role，请先在 roles 注册表添加目标角色。",
      payload: null,
    };
  }
  const role = form.role.trim();
  if (!role) {
    return { ok: false, reason: "请选择目标 role。", payload: null };
  }
  const selectedRole = form.roles.find((r) => r.roleId === role || r.name === role);
  if (!selectedRole) {
    return { ok: false, reason: `目标 role「${role}」不在注册表中。`, payload: null };
  }
  const prompt = form.prompt.trim();
  if (!prompt) {
    return { ok: false, reason: "请填写 user prompt。", payload: null };
  }
  return {
    ok: true,
    reason: null,
    payload: {
      workNodeIds: [form.nodeId],
      contextNodeIds: [],
      roleId: selectedRole.roleId,
      prompt,
      // Desktop form is user-direct; Role-dispatched child uses CLI/Service explicit actors.
      parentActor: { kind: "user", id: "user" },
    },
  };
}

export function buildAcceptPayload(
  taskPath: string,
  deliveryId: string,
  actor = "user"
): AcceptPayload {
  return { taskPath, deliveryId, actor };
}

export function buildRejectPayload(
  taskPath: string,
  deliveryId: string,
  reason: string,
  actor = "user"
): { ok: true; payload: RejectPayload } | { ok: false; reason: string } {
  const note = reason.trim();
  if (!note) {
    return { ok: false, reason: "驳回需要填写简短原因。" };
  }
  return {
    ok: true,
    payload: {
      taskPath,
      deliveryId,
      actor,
      note,
      resume: true,
    },
  };
}

/** Map lifecycle state to short Chinese label for list display. */
export function taskStateLabel(state: string): string {
  const s = state;
  switch (s) {
    case "queued":
      return "排队中";
    case "running":
      return "执行中";
    case "waiting":
      return "等待中";
    case "delivered":
      return "待确认交付";
    case "accepted":
      return "已接受";
    case "rejected":
      return "已驳回";
    case "interrupted":
      return "已中断";
    case "failed":
      return "失败";
    default:
      return s || "未知";
  }
}

/**
 * Map runtime SessionState / session projection to short Chinese label.
 * Status only — never chat, thought, or terminal text.
 */
export function sessionStateLabel(state: string | undefined | null): string {
  if (!state) return "";
  switch (state) {
    case "starting":
      return "启动中";
    case "live":
    case "running":
      return "运行中";
    case "waiting-user":
    case "waiting_user":
      return "等待用户";
    case "stopped":
      return "已停止";
    case "failed":
      return "会话失败";
    case "external":
      return "外部会话";
    default:
      return state;
  }
}

/** Task states where user may start (or re-start) an agent session. */
export function canStartAgentOnTask(
  taskState: string,
  session?: Pick<SessionProjection, "state" | "alive"> | null,
  opts?: { hasSessionId?: boolean }
): boolean {
  const s = taskState || "";
  // Terminal collaboration outcomes: no start.
  if (
    s === "delivered" ||
    s === "accepted" ||
    s === "rejected" ||
    s === "interrupted"
  ) {
    return false;
  }
  // Active live session: use interrupt instead.
  if (session && session.alive && (session.state === "live" || session.state === "starting" || session.state === "waiting-user")) {
    return false;
  }
  // Managed start/recovery is defined only for an exact Session-bound Task.
  if (!opts?.hasSessionId) return false;
  // queued (service auto-claims for user), running, waiting, failed (retry after fix).
  return (
    s === "queued" ||
    s === "pending" ||
    s === "running" ||
    s === "taken" ||
    s === "waiting" ||
    s === "failed"
  );
}

export function canInterruptTask(
  taskState: string,
  session?: Pick<SessionProjection, "state" | "alive"> | null,
  opts?: { hasSessionId?: boolean }
): boolean {
  if (session) {
    return (
      !!session.alive &&
      (session.state === "live" ||
        session.state === "starting" ||
        session.state === "waiting-user")
    );
  }
  // Fallback when session projection not loaded but task is mid-flight with sessionId.
  if (!opts?.hasSessionId) return false;
  const s = taskState || "";
  return s === "running" || s === "waiting" || s === "taken";
}

/**
 * User may cancel a task that is not already terminal and not awaiting delivery review.
 * Prefer interrupt when a live session is bound; cancel is for queued / abandoned work.
 */
export function canCancelTask(
  taskState: string,
  session?: Pick<SessionProjection, "state" | "alive"> | null
): boolean {
  const s = taskState || "";
  if (
    s === "delivered" ||
    s === "accepted" ||
    s === "rejected" ||
    s === "interrupted" ||
    s === "cancelled" ||
    s === "canceled"
  ) {
    return false;
  }
  if (session && session.alive) return false;
  return (
    s === "queued" ||
    s === "pending" ||
    s === "running" ||
    s === "taken" ||
    s === "waiting" ||
    s === "failed"
  );
}

/**
 * Enrich task list with delivery summary/commits + optional session projection.
 * Prefer matching activeDeliveryId; fall back to newest delivery for task id.
 * Prefer sessionId match for runtime status.
 */
export function buildTaskReviewItems(
  tasks: TaskProjection[],
  deliveries: DeliveryProjection[] = [],
  sessions: SessionProjection[] = []
): TaskReviewItem[] {
  const byId = new Map<string, DeliveryProjection>();
  const byTaskId = new Map<string, DeliveryProjection[]>();
  for (const d of deliveries) {
    byId.set(d.id, d);
    const list = byTaskId.get(d.taskId) ?? [];
    list.push(d);
    byTaskId.set(d.taskId, list);
  }

  const sessionById = new Map<string, SessionProjection>();
  const sessionByTaskId = new Map<string, SessionProjection>();
  for (const s of sessions) {
    sessionById.set(s.sessionId, s);
    if (s.lastTaskId) sessionByTaskId.set(s.lastTaskId, s);
  }

  return tasks.map((task) => {
    const state = task.state;
    let delivery: DeliveryProjection | undefined;
    if (task.activeDeliveryId) {
      delivery = byId.get(task.activeDeliveryId);
    }
    if (!delivery && task.id) {
      const list = byTaskId.get(task.id) ?? [];
      delivery = list
        .slice()
        .sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""))[0];
    }

    let session: SessionProjection | undefined;
    if (task.sessionId) {
      session = sessionById.get(task.sessionId);
    }
    if (!session && task.id) {
      session = sessionByTaskId.get(task.id);
    }

    const commits = delivery?.commits ?? [];
    const deliverySummary = delivery?.summary;
    const label = taskStateLabel(state);
    const sessLabel = sessionStateLabel(session?.state);
    const promptBit = task.prompt ? truncate(task.prompt, 48) : "";
    const summaryLine = [
      label,
      sessLabel ? `会话${sessLabel}` : null,
      task.roleId ? `role:${task.roleId}` : task.sessionId ? `session:${task.sessionId}` : null,
      deliverySummary ? truncate(deliverySummary, 64) : promptBit || null,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      path: task.path,
      id: task.id,
      roleId: task.roleId,
      state,
      workNodeIds: task.workNodeIds ?? [],
      contextNodeIds: task.contextNodeIds ?? [],
      prompt: task.prompt,
      activeDeliveryId: task.activeDeliveryId,
      sessionId: task.sessionId ?? session?.sessionId,
      sessionState: session?.state,
      sessionAlive: session?.alive,
      sessionConnectionId: session?.connectionId,
      deliverySummary,
      commits,
      canAcceptOrReject: state === "delivered",
      canStartAgent: canStartAgentOnTask(state, session, {
        hasSessionId: !!(task.sessionId || session?.sessionId),
      }),
      canInterrupt: canInterruptTask(state, session, {
        hasSessionId: !!(task.sessionId || session?.sessionId),
      }),
      canCancel: canCancelTask(state, session),
      summaryLine,
    };
  });
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

/** Suggest a create-note name for a Node of the given type. */
export function suggestNodeName(typeName: string, now = Date.now()): string {
  const safe = typeName.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "node";
  return `${safe}-${now.toString(36).slice(-4)}`;
}
