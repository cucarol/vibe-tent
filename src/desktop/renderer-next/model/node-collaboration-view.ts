import type {
  NodeCollaboration,
  NodeCollaborationActiveTask,
  NodeCollaborationsResult,
} from "../../../service/types.js";

export type NodeCollaborationNormalization =
  | { ok: true; value: NodeCollaboration }
  | { ok: false; message: string };

export type NodeCollaborationsNormalization =
  | { ok: true; value: NodeCollaborationsResult }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function normalizeActiveTask(raw: unknown): NodeCollaborationActiveTask {
  if (!isRecord(raw) || !isRecord(raw.task)) {
    throw new Error("node.collaboration activeTask is corrupt");
  }
  const task = raw.task;
  if (
    typeof task.id !== "string" ||
    !task.id ||
    typeof task.state !== "string" ||
    !task.state ||
    !optionalString(task.roleId) ||
    !optionalString(task.sessionId) ||
    !optionalString(task.activeDeliveryId) ||
    !optionalString(task.createdAt) ||
    !optionalString(task.path)
  ) {
    throw new Error("node.collaboration activeTask.task is corrupt");
  }

  let session: NodeCollaborationActiveTask["session"] = null;
  if (raw.session !== null) {
    if (
      !isRecord(raw.session) ||
      typeof raw.session.id !== "string" ||
      !raw.session.id ||
      typeof raw.session.state !== "string" ||
      !raw.session.state ||
      typeof raw.session.alive !== "boolean" ||
      typeof raw.session.turnBusy !== "boolean" ||
      raw.session.id !== task.sessionId
    ) {
      throw new Error("node.collaboration session join is corrupt");
    }
    session = {
      id: raw.session.id,
      state: raw.session.state,
      alive: raw.session.alive,
      turnBusy: raw.session.turnBusy,
    };
  }

  let delivery: NodeCollaborationActiveTask["delivery"] = null;
  if (raw.delivery !== null) {
    if (
      !isRecord(raw.delivery) ||
      typeof raw.delivery.id !== "string" ||
      !raw.delivery.id ||
      typeof raw.delivery.status !== "string" ||
      !raw.delivery.status ||
      raw.delivery.id !== task.activeDeliveryId
    ) {
      throw new Error("node.collaboration delivery join is corrupt");
    }
    delivery = { id: raw.delivery.id, status: raw.delivery.status };
  }

  return {
    task: {
      id: task.id,
      state: task.state,
      ...(typeof task.roleId === "string" ? { roleId: task.roleId } : {}),
      ...(typeof task.sessionId === "string" ? { sessionId: task.sessionId } : {}),
      ...(typeof task.activeDeliveryId === "string"
        ? { activeDeliveryId: task.activeDeliveryId }
        : {}),
      ...(typeof task.createdAt === "string" ? { createdAt: task.createdAt } : {}),
      ...(typeof task.path === "string" ? { path: task.path } : {}),
    },
    session,
    delivery,
  };
}

export function normalizeNodeCollaboration(
  raw: unknown,
  expectedWorkspaceId: string,
  expectedNodeId: string
): NodeCollaborationNormalization {
  try {
    if (
      !isRecord(raw) ||
      raw.workspaceId !== expectedWorkspaceId ||
      raw.nodeId !== expectedNodeId ||
      !(raw.activeTask === null || isRecord(raw.activeTask))
    ) {
      throw new Error("node.collaboration identity or payload is corrupt");
    }
    return {
      ok: true,
      value: {
        workspaceId: expectedWorkspaceId,
        nodeId: expectedNodeId,
        activeTask:
          raw.activeTask === null ? null : normalizeActiveTask(raw.activeTask),
      },
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "node.collaboration payload is corrupt",
    };
  }
}

export function normalizeNodeCollaborations(
  raw: unknown,
  expectedWorkspaceId: string,
  expectedNodeIds: readonly string[]
): NodeCollaborationsNormalization {
  if (
    !isRecord(raw) ||
    raw.workspaceId !== expectedWorkspaceId ||
    !Array.isArray(raw.items) ||
    raw.items.length !== expectedNodeIds.length
  ) {
    return {
      ok: false,
      message: "node.collaborations workspace, order, or length is corrupt",
    };
  }
  const items: NodeCollaboration[] = [];
  for (let index = 0; index < raw.items.length; index += 1) {
    const normalized = normalizeNodeCollaboration(
      raw.items[index],
      expectedWorkspaceId,
      expectedNodeIds[index]!
    );
    if (!normalized.ok) {
      return { ok: false, message: `items[${index}]: ${normalized.message}` };
    }
    items.push(normalized.value);
  }
  return {
    ok: true,
    value: { workspaceId: expectedWorkspaceId, items },
  };
}

export function collaborationByNodeId(
  value: NodeCollaborationsResult
): ReadonlyMap<string, NodeCollaboration> {
  return new Map(value.items.map((item) => [item.nodeId, item]));
}

/** undefined=unknown/stale, null=authoritative idle, string=raw Task state. */
export function activeTaskState(
  item: NodeCollaboration | null | undefined
): string | null | undefined {
  if (item === undefined || item === null) return undefined;
  return item.activeTask?.task.state ?? null;
}
