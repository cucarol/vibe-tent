// Pure UI model for desktop collaboration closed loop (P0-1).
// No Electron, no FS — builds RPC payloads and view models from projections.

import type {
  DeliveryProjection,
  RoleRegistryEntryProjection,
  TaskProjection,
  TypeRegistryEntryProjection,
} from "../../service/types.js";

export type CoordinationTypeOption = {
  name: string;
  description?: string;
  color?: string;
};

export type RoleOption = {
  name: string;
  description?: string;
};

export type TaskReviewItem = {
  path: string;
  id?: string;
  role: string;
  status: string;
  state: string;
  claims: string[];
  prompt?: string;
  activeDeliveryId?: string;
  deliverySummary?: string;
  commits: string[];
  canAcceptOrReject: boolean;
  summaryLine: string;
};

export type DispatchFormState = {
  boxId: string | null;
  coordination: boolean;
  role: string;
  prompt: string;
  roles: RoleOption[];
};

export type DispatchValidation = {
  ok: boolean;
  reason: string | null;
  payload: {
    boxId: string;
    role: string;
    prompt: string;
    dispatchedBy: string;
  } | null;
};

export type AcceptPayload = {
  taskPath: string;
  actor: string;
};

export type RejectPayload = {
  taskPath: string;
  actor: string;
  note: string;
  resume: boolean;
};

/** Prefer goal among coordination-enabled base types; otherwise first sorted name. */
export function pickDefaultCoordinationType(
  types: TypeRegistryEntryProjection[] | CoordinationTypeOption[]
): string | null {
  const names = listCoordinationTypeNames(types);
  if (names.includes("goal")) return "goal";
  return names[0] ?? null;
}

/** Base types with coordination=true — never hardcode type names for eligibility. */
export function listCoordinationTypeNames(
  types: Array<{ name: string; tier?: string; coordination?: boolean } | TypeRegistryEntryProjection>
): string[] {
  return types
    .filter((t) => {
      const tier = "tier" in t ? t.tier : "base";
      return (tier === undefined || tier === "base") && t.coordination === true;
    })
    .map((t) => t.name)
    .sort((a, b) => a.localeCompare(b));
}

export function listCoordinationTypeOptions(
  types: TypeRegistryEntryProjection[]
): CoordinationTypeOption[] {
  return listCoordinationTypeNames(types).map((name) => {
    const row = types.find((t) => t.name === name);
    return {
      name,
      description: row?.description,
      color: row?.color,
    };
  });
}

export function listRoleOptions(roles: RoleRegistryEntryProjection[]): RoleOption[] {
  return roles
    .map((r) => ({ name: r.name, description: r.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Validate dispatch form before calling task.dispatch.
 * UI must not invent domain rules beyond empty-field / coordination gate.
 */
export function validateDispatchForm(form: DispatchFormState): DispatchValidation {
  if (!form.boxId) {
    return { ok: false, reason: "请先选中一个协作框。", payload: null };
  }
  if (!form.coordination) {
    return {
      ok: false,
      reason: "当前概念不可协调（coordination=false），无法派活。",
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
  if (!form.roles.some((r) => r.name === role)) {
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
      boxId: form.boxId,
      role,
      prompt,
      dispatchedBy: "user",
    },
  };
}

export function buildAcceptPayload(taskPath: string, actor = "user"): AcceptPayload {
  return { taskPath, actor };
}

export function buildRejectPayload(
  taskPath: string,
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
      actor,
      note,
      resume: true,
    },
  };
}

/** Map lifecycle state to short Chinese label for list display. */
export function taskStateLabel(state: string, legacyStatus?: string): string {
  const s = state || legacyStatus || "";
  switch (s) {
    case "queued":
    case "pending":
      return "排队中";
    case "running":
    case "taken":
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
    default:
      return s || "未知";
  }
}

/**
 * Enrich task list with delivery summary/commits for triage display.
 * Prefer matching activeDeliveryId; fall back to newest delivery for task id.
 */
export function buildTaskReviewItems(
  tasks: TaskProjection[],
  deliveries: DeliveryProjection[] = []
): TaskReviewItem[] {
  const byId = new Map<string, DeliveryProjection>();
  const byTaskId = new Map<string, DeliveryProjection[]>();
  for (const d of deliveries) {
    byId.set(d.id, d);
    const list = byTaskId.get(d.taskId) ?? [];
    list.push(d);
    byTaskId.set(d.taskId, list);
  }

  return tasks.map((task) => {
    const state = task.state || task.status;
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

    const commits = delivery?.commits ?? [];
    const deliverySummary = delivery?.summary;
    const label = taskStateLabel(state, task.status);
    const promptBit = task.prompt ? truncate(task.prompt, 48) : "";
    const summaryLine = [
      label,
      task.role,
      deliverySummary ? truncate(deliverySummary, 64) : promptBit || null,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      path: task.path,
      id: task.id,
      role: task.role,
      status: task.status,
      state,
      claims: task.claims ?? [],
      prompt: task.prompt,
      activeDeliveryId: task.activeDeliveryId,
      deliverySummary,
      commits,
      canAcceptOrReject: state === "delivered",
      summaryLine,
    };
  });
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

/** Suggest create-note name for a coordination box of the given type. */
export function suggestBoxName(typeName: string, now = Date.now()): string {
  const safe = typeName.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "box";
  return `${safe}-${now.toString(36).slice(-4)}`;
}
