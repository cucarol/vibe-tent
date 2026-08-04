import type {
  DesktopAcceptMode,
  DesktopCollaborationError,
  DesktopCollaborationRequest,
  DesktopCollaborationResponse,
  DesktopDecisionResponse,
  DesktopDispatchTarget,
} from "../../collaboration-ipc.js";

export type CollaborationRole = {
  roleId: string;
  name: string;
  displayName: string;
  description?: string;
  color?: string;
};

export type CollaborationConnection = {
  connectionId: string;
  displayName: string;
  provider: string;
  adapterId: string;
  launchSecretExists?: boolean;
};

export type CollaborationTask = {
  id?: string;
  path: string;
  state: string;
  roleId?: string;
  workNodeIds: string[];
  contextNodeIds: string[];
  acceptMode: DesktopAcceptMode;
  sessionId?: string;
  activeDeliveryId?: string;
  wait?: { reason: string; summary: string; code?: string };
  updatedAt?: string;
};

export type CollaborationSession = {
  sessionId: string;
  connectionId?: string;
  roleId?: string;
  state: string;
  alive: boolean;
  turnBusy: boolean;
};

export type CollaborationDecisionRequest = {
  id: string;
  taskId: string;
  taskPath: string;
  sessionId: string;
  createdAt: string;
  question: string;
  options: Array<{ id: string; label: string }>;
};

export type CollaborationDeliveryReview = {
  id: string;
  taskId: string;
  taskPath: string;
  sourceNodeId: string;
  createdAt: string;
  summary: string;
  status: "ready";
};

export type CollaborationSnapshot = {
  workspaceId: string;
  nodeId: string;
  roles: CollaborationRole[];
  connections: CollaborationConnection[];
  task: CollaborationTask | null;
  session: CollaborationSession | null;
  decisionRequests: CollaborationDecisionRequest[];
  deliveryReview: CollaborationDeliveryReview | null;
};

export type CollaborationMutation = {
  workspaceId: string;
  taskPath?: string;
  requestId?: string;
};

export type CollaborationIssue = DesktopCollaborationError | {
  kind: "timeout" | "corrupt" | "request";
  message: string;
  code?: number;
  data?: unknown;
};

export type CollaborationRead<T> =
  | { ok: true; workspaceId: string; value: T; fetchedAt: string }
  | { ok: false; workspaceId: string; issue: CollaborationIssue; failedAt: string };

export type CollaborationTransport = (
  request: DesktopCollaborationRequest
) => Promise<DesktopCollaborationResponse>;

export type DispatchTaskRequest = {
  workspaceId: string;
  workNodeIds: string[];
  contextNodeIds: string[];
  prompt: string;
  target: DesktopDispatchTarget;
  acceptMode: DesktopAcceptMode;
};

const TIMEOUT_MS = 15_000;
const ACCEPT_MODES = new Set<DesktopAcceptMode>([
  "review-required",
  "auto-accept",
  "agent-decide",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || nonEmpty(value);
}

function normalizeStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => !nonEmpty(item))) {
    throw new Error(`${label} is corrupt`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  return [...value] as string[];
}

function wrapper(raw: unknown, key: string, workspaceId?: string): Record<string, unknown> {
  if (!isRecord(raw) || !Object.prototype.hasOwnProperty.call(raw, key)) {
    throw new Error(`${key} response is corrupt`);
  }
  if (workspaceId !== undefined && raw.workspaceId !== workspaceId) {
    throw new Error(`${key} workspace mismatch`);
  }
  return raw;
}

function normalizeRole(raw: unknown): CollaborationRole {
  if (
    !isRecord(raw) ||
    !nonEmpty(raw.roleId) ||
    !nonEmpty(raw.name) ||
    !nonEmpty(raw.displayName) ||
    !optionalString(raw.description) ||
    !optionalString(raw.color)
  ) throw new Error("registry.roles item is corrupt");
  return {
    roleId: raw.roleId,
    name: raw.name,
    displayName: raw.displayName,
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.color ? { color: raw.color } : {}),
  };
}

function normalizeConnection(raw: unknown): CollaborationConnection {
  if (
    !isRecord(raw) ||
    !nonEmpty(raw.connectionId) ||
    !nonEmpty(raw.displayName) ||
    !nonEmpty(raw.provider) ||
    !nonEmpty(raw.adapterId) ||
    !(raw.launchSecretExists === undefined || typeof raw.launchSecretExists === "boolean")
  ) throw new Error("connection.list item is corrupt");
  return {
    connectionId: raw.connectionId,
    displayName: raw.displayName,
    provider: raw.provider,
    adapterId: raw.adapterId,
    ...(typeof raw.launchSecretExists === "boolean"
      ? { launchSecretExists: raw.launchSecretExists }
      : {}),
  };
}

function normalizeTask(raw: unknown): CollaborationTask {
  if (
    !isRecord(raw) ||
    !optionalString(raw.id) ||
    !nonEmpty(raw.path) ||
    !nonEmpty(raw.state) ||
    !optionalString(raw.roleId) ||
    !Array.isArray(raw.workNodeIds) ||
    !Array.isArray(raw.contextNodeIds) ||
    !ACCEPT_MODES.has(raw.acceptMode as DesktopAcceptMode) ||
    !optionalString(raw.sessionId) ||
    !optionalString(raw.activeDeliveryId) ||
    !optionalString(raw.updatedAt)
  ) throw new Error("task.get Task is corrupt");
  let wait: CollaborationTask["wait"];
  if (raw.wait !== undefined) {
    if (
      !isRecord(raw.wait) ||
      !nonEmpty(raw.wait.reason) ||
      typeof raw.wait.summary !== "string" ||
      !optionalString(raw.wait.code)
    ) throw new Error("task.get wait state is corrupt");
    wait = {
      reason: raw.wait.reason,
      summary: raw.wait.summary,
      ...(raw.wait.code ? { code: raw.wait.code } : {}),
    };
  }
  return {
    ...(raw.id ? { id: raw.id } : {}),
    path: raw.path,
    state: raw.state,
    ...(raw.roleId ? { roleId: raw.roleId } : {}),
    workNodeIds: normalizeStringArray(raw.workNodeIds, "task.workNodeIds"),
    contextNodeIds: normalizeStringArray(raw.contextNodeIds, "task.contextNodeIds"),
    acceptMode: raw.acceptMode as DesktopAcceptMode,
    ...(raw.sessionId ? { sessionId: raw.sessionId } : {}),
    ...(raw.activeDeliveryId ? { activeDeliveryId: raw.activeDeliveryId } : {}),
    ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
    ...(wait ? { wait } : {}),
  };
}

function normalizeSession(raw: unknown): CollaborationSession {
  if (
    !isRecord(raw) ||
    !nonEmpty(raw.sessionId) ||
    !optionalString(raw.connectionId) ||
    !optionalString(raw.roleId) ||
    !nonEmpty(raw.state) ||
    typeof raw.alive !== "boolean" ||
    !(raw.turnBusy === undefined || typeof raw.turnBusy === "boolean")
  ) throw new Error("session.get Session is corrupt");
  return {
    sessionId: raw.sessionId,
    ...(raw.connectionId ? { connectionId: raw.connectionId } : {}),
    ...(raw.roleId ? { roleId: raw.roleId } : {}),
    state: raw.state,
    alive: raw.alive,
    turnBusy: raw.turnBusy === true,
  };
}

function normalizeDecision(raw: Record<string, unknown>, workspaceId: string): CollaborationDecisionRequest {
  if (
    raw.workspaceId !== workspaceId ||
    !nonEmpty(raw.id) ||
    !nonEmpty(raw.taskId) ||
    !nonEmpty(raw.taskPath) ||
    !nonEmpty(raw.sessionId) ||
    !nonEmpty(raw.createdAt) ||
    !nonEmpty(raw.question) ||
    !Array.isArray(raw.options)
  ) throw new Error("pending decisionRequest is corrupt");
  const options = raw.options.map((option) => {
    if (!isRecord(option) || !nonEmpty(option.id) || !nonEmpty(option.label)) {
      throw new Error("pending decisionRequest option is corrupt");
    }
    return { id: option.id, label: option.label };
  });
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new Error("pending decisionRequest option ids are duplicated");
  }
  return {
    id: raw.id,
    taskId: raw.taskId,
    taskPath: raw.taskPath,
    sessionId: raw.sessionId,
    createdAt: raw.createdAt,
    question: raw.question,
    options,
  };
}

function normalizeDeliveryDetail(
  raw: unknown,
  workspaceId: string,
  id: string,
  pending: Record<string, unknown>
): CollaborationDeliveryReview {
  const outer = wrapper(raw, "delivery", workspaceId);
  const delivery = outer.delivery;
  if (
    !isRecord(delivery) ||
    delivery.id !== id ||
    delivery.status !== "ready" ||
    !nonEmpty(delivery.taskId) ||
    !nonEmpty(delivery.sourceNodeId) ||
    typeof delivery.summary !== "string" ||
    pending.taskId !== delivery.taskId ||
    pending.sourceNodeId !== delivery.sourceNodeId ||
    !nonEmpty(pending.taskPath) ||
    !nonEmpty(pending.createdAt)
  ) throw new Error("delivery.get response is corrupt");
  return {
    id,
    taskId: delivery.taskId,
    taskPath: pending.taskPath,
    sourceNodeId: delivery.sourceNodeId,
    createdAt: pending.createdAt,
    summary: delivery.summary,
    status: "ready",
  };
}

export function normalizeCollaborationSnapshot(
  raw: unknown,
  workspaceId: string
): CollaborationSnapshot {
  if (!isRecord(raw) || raw.workspaceId !== workspaceId) {
    throw new Error("collaboration snapshot workspace mismatch");
  }
  const rolesRaw = wrapper(raw.roles, "roles", workspaceId).roles;
  const connectionsRaw = wrapper(raw.connections, "connections").connections;
  const pendingRaw = wrapper(raw.pending, "items", workspaceId);
  if (
    !nonEmpty(raw.nodeId) ||
    !isRecord(raw.collaboration) ||
    raw.collaboration.workspaceId !== workspaceId ||
    raw.collaboration.nodeId !== raw.nodeId ||
    !(raw.collaboration.activeTask === null || isRecord(raw.collaboration.activeTask)) ||
    !Array.isArray(rolesRaw) ||
    !Array.isArray(connectionsRaw) ||
    !Array.isArray(pendingRaw.items) ||
    !isRecord(pendingRaw.counts) ||
    !(raw.task === null || isRecord(raw.task)) ||
    !(raw.session === null || isRecord(raw.session)) ||
    !(raw.deliveryDetail === null || isRecord(raw.deliveryDetail))
  ) throw new Error("collaboration snapshot payload is corrupt");

  const roles = rolesRaw.map(normalizeRole);
  const connections = connectionsRaw.map(normalizeConnection);
  let activeTask: CollaborationTask | null = null;
  if (raw.task) {
    const taskWrapper = wrapper(raw.task, "task", workspaceId);
    activeTask = normalizeTask(taskWrapper.task);
  }
  let activeSession: CollaborationSession | null = null;
  if (raw.session) {
    activeSession = normalizeSession(wrapper(raw.session, "session").session);
  }
  const collaborationActive = raw.collaboration.activeTask;
  if (collaborationActive === null) {
    if (activeTask || activeSession) {
      throw new Error("inactive collaboration unexpectedly contains Task or Session");
    }
  } else {
    if (
      !isRecord(collaborationActive.task) ||
      !(collaborationActive.session === null || isRecord(collaborationActive.session)) ||
      !(collaborationActive.delivery === null || isRecord(collaborationActive.delivery))
    ) {
      throw new Error("node.collaboration active Task is corrupt");
    }
    const summary = collaborationActive.task;
    const joinedSession = collaborationActive.session;
    const joinedDelivery = collaborationActive.delivery;
    if (
      !activeTask ||
      summary.id !== activeTask.id ||
      summary.path !== activeTask.path ||
      summary.sessionId !== activeTask.sessionId ||
      summary.activeDeliveryId !== activeTask.activeDeliveryId ||
      (joinedSession !== null &&
        (!nonEmpty(joinedSession.id) || joinedSession.id !== summary.sessionId)) ||
      (joinedDelivery !== null &&
        (!nonEmpty(joinedDelivery.id) || joinedDelivery.id !== summary.activeDeliveryId)) ||
      (activeSession !== null &&
        (activeSession.sessionId !== summary.sessionId ||
          activeSession.sessionId !== activeTask.sessionId))
    ) throw new Error("node.collaboration Task joins are corrupt");
  }
  const decisions: CollaborationDecisionRequest[] = [];
  const pendingDeliveries = new Map<string, Record<string, unknown>>();
  for (const item of pendingRaw.items) {
    if (!isRecord(item) || item.workspaceId !== workspaceId || !nonEmpty(item.kind)) {
      throw new Error("pending interaction item is corrupt");
    }
    if (item.kind === "decisionRequest") decisions.push(normalizeDecision(item, workspaceId));
    else if (item.kind === "delivery") {
      if (!nonEmpty(item.id) || item.status !== "ready") {
        throw new Error("pending delivery is corrupt");
      }
      pendingDeliveries.set(item.id, item);
    } else {
      throw new Error("pending interaction kind is corrupt");
    }
  }
  const count = pendingRaw.counts.toolApproval;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count !== 0
  ) {
    throw new Error("pending toolApproval count is corrupt");
  }
  if (
    pendingRaw.counts.decisionRequest !== decisions.length ||
    pendingRaw.counts.delivery !== pendingDeliveries.size ||
    pendingRaw.counts.total !== pendingRaw.items.length
  ) throw new Error("pending interaction counts are corrupt");

  if ((raw.deliveryDetail === null) !== (pendingDeliveries.size === 0)) {
    throw new Error("delivery detail does not match pending delivery");
  }
  if (pendingDeliveries.size > 1) throw new Error("multiple active deliveries are corrupt");
  const deliveryReviews = raw.deliveryDetail
    ? [...pendingDeliveries].map(([id, pending]) =>
        normalizeDeliveryDetail(raw.deliveryDetail, workspaceId, id, pending)
      )
    : [];
  if (
    decisions.some((request) =>
      !activeTask ||
      request.taskId !== activeTask.id ||
      request.taskPath !== activeTask.path ||
      request.sessionId !== activeTask.sessionId
    )
  ) {
    throw new Error("Decision Request does not match the active Task");
  }
  if (
    deliveryReviews.some((delivery) =>
      !activeTask ||
      delivery.id !== activeTask.activeDeliveryId ||
      delivery.taskId !== activeTask.id ||
      delivery.taskPath !== activeTask.path ||
      !activeTask.workNodeIds.includes(delivery.sourceNodeId)
    )
  ) {
    throw new Error("ready Delivery does not match the active Task and Node");
  }
  return {
    workspaceId,
    nodeId: raw.nodeId,
    roles,
    connections,
    task: activeTask,
    session: activeSession,
    decisionRequests: decisions,
    deliveryReview: deliveryReviews[0] ?? null,
  };
}

class CollaborationTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new CollaborationTimeoutError(`Collaboration request timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function request<T>(args: {
  transport: CollaborationTransport;
  request: DesktopCollaborationRequest;
  normalize: (raw: unknown) => T;
  timeoutMs?: number;
}): Promise<CollaborationRead<T>> {
  const workspaceId = args.request.workspaceId;
  if (!workspaceId.trim()) {
    return {
      ok: false,
      workspaceId,
      issue: { kind: "request", message: "workspaceId is required" },
      failedAt: new Date().toISOString(),
    };
  }
  let envelope: unknown;
  try {
    envelope = await withTimeout(args.transport(args.request), args.timeoutMs ?? TIMEOUT_MS);
  } catch (cause) {
    return {
      ok: false,
      workspaceId,
      issue: cause instanceof CollaborationTimeoutError
        ? { kind: "timeout", message: cause.message }
        : { kind: "transport", message: cause instanceof Error ? cause.message : "Collaboration transport failed" },
      failedAt: new Date().toISOString(),
    };
  }
  if (!isRecord(envelope) || typeof envelope.ok !== "boolean") {
    return { ok: false, workspaceId, issue: { kind: "corrupt", message: "Collaboration IPC envelope is corrupt" }, failedAt: new Date().toISOString() };
  }
  if (!envelope.ok) {
    const error = envelope.error;
    if (
      !isRecord(error) ||
      !["rpc", "transport", "invalid-request", "invalid-response"].includes(String(error.kind)) ||
      typeof error.message !== "string" ||
      !(error.code === undefined || typeof error.code === "number")
    ) {
      return { ok: false, workspaceId, issue: { kind: "corrupt", message: "Collaboration IPC error is corrupt" }, failedAt: new Date().toISOString() };
    }
    return {
      ok: false,
      workspaceId,
      issue: {
        kind: error.kind as DesktopCollaborationError["kind"],
        message: error.message,
        ...(typeof error.code === "number" ? { code: error.code } : {}),
        ...(Object.prototype.hasOwnProperty.call(error, "data") ? { data: error.data } : {}),
      },
      failedAt: new Date().toISOString(),
    };
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, "value")) {
    return { ok: false, workspaceId, issue: { kind: "corrupt", message: "Collaboration IPC success is corrupt" }, failedAt: new Date().toISOString() };
  }
  try {
    return { ok: true, workspaceId, value: args.normalize(envelope.value), fetchedAt: new Date().toISOString() };
  } catch (cause) {
    return { ok: false, workspaceId, issue: { kind: "corrupt", message: cause instanceof Error ? cause.message : "Collaboration payload is corrupt" }, failedAt: new Date().toISOString() };
  }
}

function normalizeMutation(raw: unknown, workspaceId: string): CollaborationMutation {
  if (!isRecord(raw) || raw.workspaceId !== workspaceId) {
    throw new Error("collaboration mutation workspace mismatch");
  }
  if (!optionalString(raw.taskPath) || !optionalString(raw.requestId)) {
    throw new Error("collaboration mutation identity is corrupt");
  }
  return {
    workspaceId,
    ...(raw.taskPath ? { taskPath: raw.taskPath } : {}),
    ...(raw.requestId ? { requestId: raw.requestId } : {}),
  };
}

export function readCollaborationSnapshot(
  transport: CollaborationTransport,
  workspaceId: string,
  nodeId: string
): Promise<CollaborationRead<CollaborationSnapshot>> {
  return request({
    transport,
    request: { operation: "snapshot", workspaceId, nodeId },
    normalize: (raw) => {
      const snapshot = normalizeCollaborationSnapshot(raw, workspaceId);
      if (snapshot.nodeId !== nodeId) throw new Error("collaboration snapshot node mismatch");
      return snapshot;
    },
  });
}

export function dispatchTask(
  transport: CollaborationTransport,
  input: DispatchTaskRequest
): Promise<CollaborationRead<CollaborationMutation>> {
  return request({
    transport,
    request: { operation: "dispatch", ...input },
    normalize: (raw) => normalizeMutation(raw, input.workspaceId),
  });
}

export function acceptDelivery(
  transport: CollaborationTransport,
  workspaceId: string,
  taskPath: string,
  deliveryId: string
): Promise<CollaborationRead<CollaborationMutation>> {
  return request({
    transport,
    request: { operation: "acceptDelivery", workspaceId, taskPath, deliveryId },
    normalize: (raw) => normalizeMutation(raw, workspaceId),
  });
}

export function rejectDelivery(
  transport: CollaborationTransport,
  workspaceId: string,
  taskPath: string,
  deliveryId: string,
  note: string
): Promise<CollaborationRead<CollaborationMutation>> {
  return request({
    transport,
    request: { operation: "rejectDelivery", workspaceId, taskPath, deliveryId, note },
    normalize: (raw) => normalizeMutation(raw, workspaceId),
  });
}

export function respondDecision(
  transport: CollaborationTransport,
  workspaceId: string,
  taskPath: string,
  requestId: string,
  response: DesktopDecisionResponse
): Promise<CollaborationRead<CollaborationMutation>> {
  return request({
    transport,
    request: { operation: "respondDecision", workspaceId, taskPath, requestId, response },
    normalize: (raw) => normalizeMutation(raw, workspaceId),
  });
}
