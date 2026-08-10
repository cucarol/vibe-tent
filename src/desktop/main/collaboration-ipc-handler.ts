import type {
  DesktopCollaborationRequest,
  DesktopCollaborationResponse,
} from "../collaboration-ipc.js";
import { ServiceRpcError, type ServiceRpcClient } from "../client/rpc-client.js";

class InvalidCollaborationResponseError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown, allowEmpty: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(nonEmptyString) &&
    new Set(value).size === value.length
  );
}

function optionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || nonEmptyString(value);
}

function minimalRoles(raw: unknown, workspaceId: string): Record<string, unknown> {
  if (!isRecord(raw) || raw.workspaceId !== workspaceId || !Array.isArray(raw.roles)) {
    throw new InvalidCollaborationResponseError("registry.roles response is corrupt");
  }
  return {
    workspaceId,
    roles: raw.roles.map((item) => {
      if (
        !isRecord(item) ||
        !nonEmptyString(item.roleId) ||
        !nonEmptyString(item.name) ||
        !nonEmptyString(item.displayName) ||
        !optionalNonEmptyString(item.description) ||
        !optionalNonEmptyString(item.color)
      ) throw new InvalidCollaborationResponseError("registry.roles item is corrupt");
      return {
        roleId: item.roleId,
        name: item.name,
        displayName: item.displayName,
        ...(item.description ? { description: item.description } : {}),
        ...(item.color ? { color: item.color } : {}),
      };
    }),
  };
}

function minimalConnections(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw) || !Array.isArray(raw.connections)) {
    throw new InvalidCollaborationResponseError("connection.list response is corrupt");
  }
  return {
    connections: raw.connections.map((item) => {
      if (
        !isRecord(item) ||
        !nonEmptyString(item.connectionId) ||
        !nonEmptyString(item.displayName) ||
        !nonEmptyString(item.provider) ||
        !nonEmptyString(item.adapterId)
      ) throw new InvalidCollaborationResponseError("connection.list item is corrupt");
      return {
        connectionId: item.connectionId,
        displayName: item.displayName,
        provider: item.provider,
        adapterId: item.adapterId,
      };
    }),
  };
}

function normalizeRequest(raw: unknown): DesktopCollaborationRequest | null {
  if (!isRecord(raw) || !nonEmptyString(raw.workspaceId) || !nonEmptyString(raw.operation)) {
    return null;
  }
  if (
    raw.operation === "snapshot" &&
    exactKeys(raw, ["operation", "workspaceId", "nodeId"]) &&
    nonEmptyString(raw.nodeId)
  ) {
    return raw as DesktopCollaborationRequest;
  }
  if (
    raw.operation === "dispatch" &&
    exactKeys(raw, [
      "operation",
      "workspaceId",
      "workNodeIds",
      "contextNodeIds",
      "prompt",
      "target",
      "acceptMode",
    ]) &&
    stringArray(raw.workNodeIds, false) &&
    stringArray(raw.contextNodeIds, true) &&
    (raw.workNodeIds as string[]).every(
      (id) => !(raw.contextNodeIds as string[]).includes(id)
    ) &&
    nonEmptyString(raw.prompt) &&
    isRecord(raw.target) &&
    exactKeys(raw.target, ["kind", "id"]) &&
    (raw.target.kind === "role" || raw.target.kind === "connection") &&
    nonEmptyString(raw.target.id) &&
    (raw.acceptMode === "review-required" ||
      raw.acceptMode === "auto-accept" ||
      raw.acceptMode === "agent-decide")
  ) {
    return raw as DesktopCollaborationRequest;
  }
  if (
    raw.operation === "acceptDelivery" &&
    exactKeys(raw, ["operation", "workspaceId", "taskPath", "deliveryId"]) &&
    nonEmptyString(raw.taskPath) &&
    nonEmptyString(raw.deliveryId)
  ) {
    return raw as DesktopCollaborationRequest;
  }
  if (
    raw.operation === "rejectDelivery" &&
    exactKeys(raw, ["operation", "workspaceId", "taskPath", "deliveryId", "note"]) &&
    nonEmptyString(raw.taskPath) &&
    nonEmptyString(raw.deliveryId) &&
    nonEmptyString(raw.note)
  ) {
    return raw as DesktopCollaborationRequest;
  }
  if (
    raw.operation === "respondDecision" &&
    exactKeys(raw, ["operation", "workspaceId", "taskPath", "requestId", "response"]) &&
    nonEmptyString(raw.taskPath) &&
    nonEmptyString(raw.requestId) &&
    isRecord(raw.response)
  ) {
    const response = raw.response;
    if (
      (response.kind === "option" &&
        exactKeys(response, ["kind", "optionId"]) &&
        nonEmptyString(response.optionId)) ||
      (response.kind === "custom" &&
        exactKeys(response, ["kind", "text"]) &&
        nonEmptyString(response.text)) ||
      (response.kind === "deny" && exactKeys(response, ["kind"]))
    ) {
      return raw as DesktopCollaborationRequest;
    }
  }
  return null;
}

function pendingDeliveryIds(raw: unknown, workspaceId: string): string[] {
  if (!isRecord(raw) || raw.workspaceId !== workspaceId || !Array.isArray(raw.items)) {
    throw new InvalidCollaborationResponseError("interaction.listPending response is corrupt");
  }
  const ids: string[] = [];
  for (const item of raw.items) {
    if (!isRecord(item) || !nonEmptyString(item.kind) || !nonEmptyString(item.id)) {
      throw new InvalidCollaborationResponseError("interaction.listPending item is corrupt");
    }
    if (item.workspaceId !== workspaceId) {
      throw new InvalidCollaborationResponseError("interaction.listPending item workspace mismatch");
    }
    if (item.kind === "delivery") ids.push(item.id);
  }
  return [...new Set(ids)];
}

function activeTaskPointers(raw: unknown, workspaceId: string, nodeId: string): {
  taskId: string;
  taskPath?: string;
  sessionId?: string;
  activeDeliveryId?: string;
} | null {
  if (
    !isRecord(raw) ||
    raw.workspaceId !== workspaceId ||
    raw.nodeId !== nodeId ||
    !(raw.activeTask === null || isRecord(raw.activeTask))
  ) throw new InvalidCollaborationResponseError("node.collaboration response is corrupt");
  if (raw.activeTask === null) return null;
  const task = raw.activeTask.task;
  if (
    !isRecord(task) ||
    !nonEmptyString(task.id) ||
    !nonEmptyString(task.state) ||
    !(task.path === undefined || nonEmptyString(task.path)) ||
    !(task.roleId === undefined || nonEmptyString(task.roleId)) ||
    !(task.sessionId === undefined || nonEmptyString(task.sessionId)) ||
    !(task.activeDeliveryId === undefined || nonEmptyString(task.activeDeliveryId)) ||
    !(task.createdAt === undefined || nonEmptyString(task.createdAt))
  ) throw new InvalidCollaborationResponseError("node.collaboration active Task is corrupt");
  return {
    taskId: task.id,
    ...(task.path ? { taskPath: task.path } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.activeDeliveryId ? { activeDeliveryId: task.activeDeliveryId } : {}),
  };
}

function minimalCollaboration(
  raw: unknown,
  workspaceId: string,
  nodeId: string
): Record<string, unknown> {
  const pointers = activeTaskPointers(raw, workspaceId, nodeId);
  if (!pointers) return { workspaceId, nodeId, activeTask: null };
  const activeTask = (raw as Record<string, unknown>).activeTask as Record<string, unknown>;
  const task = activeTask.task as Record<string, unknown>;
  const session = activeTask.session;
  const delivery = activeTask.delivery;
  if (
    !(session === null || isRecord(session)) ||
    !(delivery === null || isRecord(delivery)) ||
    (isRecord(session) &&
      (!nonEmptyString(session.id) ||
        session.id !== pointers.sessionId ||
        !nonEmptyString(session.state) ||
        typeof session.alive !== "boolean" ||
        typeof session.turnBusy !== "boolean")) ||
    (isRecord(delivery) &&
      (!nonEmptyString(delivery.id) ||
        delivery.id !== pointers.activeDeliveryId ||
        !nonEmptyString(delivery.status)))
  ) {
    throw new InvalidCollaborationResponseError("node.collaboration joins are corrupt");
  }
  return {
    workspaceId,
    nodeId,
    activeTask: {
      task: {
        id: pointers.taskId,
        state: task.state,
        ...(task.roleId ? { roleId: task.roleId } : {}),
        ...(pointers.sessionId ? { sessionId: pointers.sessionId } : {}),
        ...(pointers.activeDeliveryId
          ? { activeDeliveryId: pointers.activeDeliveryId }
          : {}),
        ...(task.createdAt ? { createdAt: task.createdAt } : {}),
        ...(pointers.taskPath ? { path: pointers.taskPath } : {}),
      },
      session: session === null
        ? null
        : {
            id: session.id,
            state: session.state,
            alive: session.alive,
            turnBusy: session.turnBusy,
          },
      delivery: delivery === null
        ? null
        : { id: delivery.id, status: delivery.status },
    },
  };
}

function joinedReadyDeliveryId(
  raw: unknown,
  pointers: ReturnType<typeof activeTaskPointers>
): string | undefined {
  if (!pointers || !isRecord(raw) || !isRecord(raw.activeTask)) return undefined;
  const delivery = raw.activeTask.delivery;
  if (!isRecord(delivery) || delivery.status !== "ready") return undefined;
  if (delivery.id !== pointers.activeDeliveryId) {
    throw new InvalidCollaborationResponseError(
      "node.collaboration ready Delivery pointer is corrupt"
    );
  }
  return delivery.id as string;
}

function minimalTask(
  raw: unknown,
  workspaceId: string,
  nodeId: string,
  pointers: NonNullable<ReturnType<typeof activeTaskPointers>>
): Record<string, unknown> {
  if (!isRecord(raw) || raw.workspaceId !== workspaceId || !isRecord(raw.task)) {
    throw new InvalidCollaborationResponseError("task.get response is corrupt");
  }
  const task = raw.task;
  if (
    task.id !== pointers.taskId ||
    task.path !== pointers.taskPath ||
    !nonEmptyString(task.state) ||
    !stringArray(task.workNodeIds, false) ||
    !task.workNodeIds.includes(nodeId) ||
    !stringArray(task.contextNodeIds, true) ||
    !["review-required", "auto-accept", "agent-decide"].includes(String(task.acceptMode)) ||
    !optionalNonEmptyString(task.roleId) ||
    !optionalNonEmptyString(task.sessionId) ||
    !optionalNonEmptyString(task.activeDeliveryId) ||
    !optionalNonEmptyString(task.updatedAt) ||
    task.sessionId !== pointers.sessionId ||
    task.activeDeliveryId !== pointers.activeDeliveryId
  ) {
    throw new InvalidCollaborationResponseError("task.get exact Task join is corrupt");
  }
  return {
    workspaceId,
    task: {
      id: task.id,
      path: task.path,
      state: task.state,
      workNodeIds: [...task.workNodeIds],
      contextNodeIds: [...task.contextNodeIds],
      acceptMode: task.acceptMode,
      ...(task.roleId ? { roleId: task.roleId } : {}),
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      ...(task.activeDeliveryId ? { activeDeliveryId: task.activeDeliveryId } : {}),
      ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
    },
  };
}

function minimalSession(
  raw: unknown,
  workspaceId: string,
  pointers: NonNullable<ReturnType<typeof activeTaskPointers>>
): Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw.session)) {
    throw new InvalidCollaborationResponseError("session.get response is corrupt");
  }
  const session = raw.session;
  if (
    session.sessionId !== pointers.sessionId ||
    session.workspace !== workspaceId ||
    session.lastTaskId !== pointers.taskId ||
    !nonEmptyString(session.state) ||
    typeof session.alive !== "boolean" ||
    !(session.turnBusy === undefined || typeof session.turnBusy === "boolean") ||
    !optionalNonEmptyString(session.connectionId) ||
    !optionalNonEmptyString(session.roleId)
  ) {
    throw new InvalidCollaborationResponseError("session.get exact Task join is corrupt");
  }
  return {
    session: {
      sessionId: session.sessionId,
      ...(session.connectionId ? { connectionId: session.connectionId } : {}),
      ...(session.roleId ? { roleId: session.roleId } : {}),
      state: session.state,
      alive: session.alive,
      turnBusy: session.turnBusy === true,
    },
  };
}

function minimalDelivery(
  raw: unknown,
  workspaceId: string,
  pointers: NonNullable<ReturnType<typeof activeTaskPointers>>,
  taskWorkNodeIds: readonly string[]
): Record<string, unknown> {
  if (!isRecord(raw) || raw.workspaceId !== workspaceId || !isRecord(raw.delivery)) {
    throw new InvalidCollaborationResponseError("delivery.get response is corrupt");
  }
  const delivery = raw.delivery;
  if (
    delivery.id !== pointers.activeDeliveryId ||
    delivery.taskId !== pointers.taskId ||
    !nonEmptyString(delivery.sourceNodeId) ||
    !taskWorkNodeIds.includes(delivery.sourceNodeId) ||
    delivery.status !== "ready" ||
    typeof delivery.summary !== "string"
  ) {
    throw new InvalidCollaborationResponseError("delivery.get exact Task join is corrupt");
  }
  return {
    workspaceId,
    delivery: {
      id: delivery.id,
      taskId: delivery.taskId,
      sourceNodeId: delivery.sourceNodeId,
      status: delivery.status,
      summary: delivery.summary,
    },
  };
}

function minimalPendingDecision(
  item: Record<string, unknown>,
  workspaceId: string,
  pointers: NonNullable<ReturnType<typeof activeTaskPointers>>
): Record<string, unknown> {
  if (
    item.kind !== "decisionRequest" ||
    !nonEmptyString(item.id) ||
    item.workspaceId !== workspaceId ||
    item.taskId !== pointers.taskId ||
    item.taskPath !== pointers.taskPath ||
    item.sessionId !== pointers.sessionId ||
    !nonEmptyString(item.createdAt) ||
    !isRecord(item.target) ||
    item.target.kind !== "user" ||
    item.target.id !== "user" ||
    !nonEmptyString(item.question) ||
    !Array.isArray(item.options)
  ) {
    throw new InvalidCollaborationResponseError(
      "pending Decision Request exact Task join is corrupt"
    );
  }
  const options = item.options.map((option) => {
    if (!isRecord(option) || !nonEmptyString(option.id) || !nonEmptyString(option.label)) {
      throw new InvalidCollaborationResponseError(
        "pending Decision Request option is corrupt"
      );
    }
    return { id: option.id, label: option.label };
  });
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new InvalidCollaborationResponseError(
      "pending Decision Request option ids are duplicated"
    );
  }
  return {
    kind: "decisionRequest",
    id: item.id,
    workspaceId,
    createdAt: item.createdAt,
    taskPath: item.taskPath,
    taskId: item.taskId,
    sessionId: item.sessionId,
    question: item.question,
    options,
  };
}

function minimalPendingDelivery(
  item: Record<string, unknown>,
  workspaceId: string,
  pointers: NonNullable<ReturnType<typeof activeTaskPointers>>
): Record<string, unknown> {
  if (
    item.kind !== "delivery" ||
    item.id !== pointers.activeDeliveryId ||
    item.workspaceId !== workspaceId ||
    item.taskId !== pointers.taskId ||
    item.taskPath !== pointers.taskPath ||
    !nonEmptyString(item.sourceNodeId) ||
    !nonEmptyString(item.createdAt) ||
    item.status !== "ready"
  ) {
    throw new InvalidCollaborationResponseError(
      "pending Delivery exact Task join is corrupt"
    );
  }
  return {
    kind: "delivery",
    id: item.id,
    workspaceId,
    createdAt: item.createdAt,
    taskPath: item.taskPath,
    taskId: item.taskId,
    sourceNodeId: item.sourceNodeId,
    status: "ready",
  };
}

function filterPendingForActiveTask(
  raw: unknown,
  workspaceId: string,
  pointers: ReturnType<typeof activeTaskPointers>
): Record<string, unknown> {
  if (!isRecord(raw) || raw.workspaceId !== workspaceId || !Array.isArray(raw.items)) {
    throw new InvalidCollaborationResponseError("interaction.listPending response is corrupt");
  }
  const items: Record<string, unknown>[] = [];
  for (const item of raw.items) {
    if (!isRecord(item) || item.workspaceId !== workspaceId || !nonEmptyString(item.kind)) {
      throw new InvalidCollaborationResponseError("interaction.listPending item is corrupt");
    }
    if (!pointers || item.taskId !== pointers.taskId) continue;
    if (!pointers.taskPath || item.taskPath !== pointers.taskPath) {
      throw new InvalidCollaborationResponseError(
        "interaction.listPending exact Task path mismatch"
      );
    }
    if (item.kind === "delivery") {
      if (item.id === pointers.activeDeliveryId) {
        items.push(minimalPendingDelivery(item, workspaceId, pointers));
      }
      continue;
    }
    if (item.kind === "decisionRequest") {
      items.push(minimalPendingDecision(item, workspaceId, pointers));
    }
  }
  const counts = { decisionRequest: 0, toolApproval: 0, delivery: 0, total: items.length };
  for (const item of items) {
    if (item.kind === "decisionRequest") counts.decisionRequest += 1;
    else if (item.kind === "delivery") counts.delivery += 1;
  }
  return { workspaceId, items, counts };
}

/** Pure handler behind the narrow Electron collaboration IPC channel. */
export async function handleDesktopCollaborationRequest(
  client: Pick<ServiceRpcClient, "call"> | null,
  rawRequest: unknown
): Promise<DesktopCollaborationResponse> {
  if (!client) {
    return { ok: false, error: { kind: "transport", message: "Service not attached" } };
  }
  const request = normalizeRequest(rawRequest);
  if (!request) {
    return {
      ok: false,
      error: { kind: "invalid-request", message: "Invalid collaboration request" },
    };
  }
  try {
    if (request.operation === "snapshot") {
      const [roles, connections, collaboration, pendingAll] = await Promise.all([
        client.call("registry.roles", { workspaceId: request.workspaceId }),
        client.call("connection.list", {}),
        client.call("node.collaboration", {
          workspaceId: request.workspaceId,
          nodeId: request.nodeId,
        }),
        client.call("interaction.listPending", { workspaceId: request.workspaceId }),
      ]);
      const pointers = activeTaskPointers(
        collaboration,
        request.workspaceId,
        request.nodeId
      );
      const pending = filterPendingForActiveTask(
        pendingAll,
        request.workspaceId,
        pointers
      );
      const collaborationValue = minimalCollaboration(
        collaboration,
        request.workspaceId,
        request.nodeId
      );
      const readyDeliveryId = joinedReadyDeliveryId(collaboration, pointers);
      const pendingReadyDeliveryIds = pendingDeliveryIds(
        pending,
        request.workspaceId
      );
      if (readyDeliveryId && !pendingReadyDeliveryIds.includes(readyDeliveryId)) {
        throw new InvalidCollaborationResponseError(
          "ready Delivery is missing from interaction.listPending"
        );
      }
      const [taskRaw, sessionRaw, deliveryRaw] = await Promise.all([
        pointers?.taskPath
          ? client.call("task.get", {
              workspaceId: request.workspaceId,
              taskPath: pointers.taskPath,
            })
          : null,
        pointers?.sessionId
          ? client.call("session.get", {
              sessionId: pointers.sessionId,
            })
          : null,
        readyDeliveryId
          ? client.call("delivery.get", {
            workspaceId: request.workspaceId,
              id: readyDeliveryId,
            })
          : null,
      ]);
      const minimalTaskValue = taskRaw && pointers
        ? minimalTask(taskRaw, request.workspaceId, request.nodeId, pointers)
        : null;
      const minimalSessionValue = sessionRaw && pointers
        ? minimalSession(sessionRaw, request.workspaceId, pointers)
        : null;
      const minimalDeliveryValue = deliveryRaw && pointers
        ? minimalDelivery(
            deliveryRaw,
            request.workspaceId,
            pointers,
            ((minimalTaskValue as { task: { workNodeIds: string[] } } | null)?.task
              .workNodeIds ?? [])
          )
        : null;
      return {
        ok: true,
        value: {
          workspaceId: request.workspaceId,
          nodeId: request.nodeId,
          roles: minimalRoles(roles, request.workspaceId),
          connections: minimalConnections(connections),
          collaboration: collaborationValue,
          task: minimalTaskValue,
          session: minimalSessionValue,
          pending,
          deliveryDetail: minimalDeliveryValue,
        },
      };
    }
    if (request.operation === "dispatch") {
      const target = request.target.kind === "role"
        ? { roleId: request.target.id }
        : { connectionId: request.target.id };
      const dispatched = await client.call("task.dispatch", {
          workspaceId: request.workspaceId,
          workNodeIds: request.workNodeIds,
          contextNodeIds: request.contextNodeIds,
          prompt: request.prompt,
          parentActor: { kind: "user", id: "user" },
          asSub: false,
          acceptMode: request.acceptMode,
          ...target,
        });
      if (
        !isRecord(dispatched) ||
        dispatched.workspaceId !== request.workspaceId ||
        !nonEmptyString(dispatched.taskPath)
      ) throw new InvalidCollaborationResponseError("task.dispatch response is corrupt");
      return {
        ok: true,
        value: { workspaceId: request.workspaceId, taskPath: dispatched.taskPath },
      };
    }
    if (request.operation === "acceptDelivery") {
      const accepted = await client.call("task.accept", {
          workspaceId: request.workspaceId,
          taskPath: request.taskPath,
          deliveryId: request.deliveryId,
          actor: "user",
        });
      if (!isRecord(accepted) || accepted.workspaceId !== request.workspaceId) {
        throw new InvalidCollaborationResponseError("task.accept response is corrupt");
      }
      return { ok: true, value: { workspaceId: request.workspaceId, taskPath: request.taskPath } };
    }
    if (request.operation === "rejectDelivery") {
      const rejected = await client.call("task.reject", {
          workspaceId: request.workspaceId,
          taskPath: request.taskPath,
          deliveryId: request.deliveryId,
          actor: "user",
          note: request.note,
          resume: true,
        });
      if (!isRecord(rejected) || rejected.workspaceId !== request.workspaceId) {
        throw new InvalidCollaborationResponseError("task.reject response is corrupt");
      }
      return { ok: true, value: { workspaceId: request.workspaceId, taskPath: request.taskPath } };
    }
    if (request.operation === "respondDecision") {
      const answered = await client.call("decisionRequest.respond", {
          workspaceId: request.workspaceId,
          taskPath: request.taskPath,
          requestId: request.requestId,
          response: request.response,
        });
      if (!isRecord(answered) || answered.accepted !== true) {
        throw new InvalidCollaborationResponseError("decisionRequest.respond response is corrupt");
      }
      return {
        ok: true,
        value: {
          workspaceId: request.workspaceId,
          taskPath: request.taskPath,
          requestId: request.requestId,
        },
      };
    }

    return {
      ok: false,
      error: { kind: "invalid-request", message: "Unsupported collaboration request" },
    };
  } catch (cause) {
    if (cause instanceof ServiceRpcError) {
      return {
        ok: false,
        error: {
          kind: "rpc",
          code: cause.code,
          message: cause.message,
          data: cause.data,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: cause instanceof InvalidCollaborationResponseError
          ? "invalid-response"
          : "transport",
        message: cause instanceof Error ? cause.message : "Collaboration request failed",
      },
    };
  }
}
