import type {
  CollaborationMutation as ProtocolCollaborationMutation,
  CollaborationRead as ProtocolCollaborationRead,
  CollaborationSnapshot as ProtocolCollaborationSnapshot,
} from "../gateway/collaboration-protocol.js";

export type AcceptMode = "review-required" | "auto-accept" | "agent-decide";

export type CollaborationIssue = {
  kind: "timeout" | "transport" | "rpc" | "corrupt" | "invalid-request" | "invalid-response" | "request";
  message: string;
  code?: number;
  data?: unknown;
};

export type DispatchTarget = {
  kind: "role" | "connection";
  id: string;
  label: string;
  description?: string;
};

export type CollaborationTask = {
  id: string;
  path: string;
  state: string;
  workNodeIds: readonly string[];
  contextNodeIds: readonly string[];
  acceptMode: AcceptMode;
  assignee?: { kind: "role" | "connection"; label: string };
  roleId?: string;
  sessionId?: string;
  activeDeliveryId?: string;
  updatedAt?: string;
  session?: {
    id: string;
    state: string;
    alive: boolean;
    turnBusy: boolean;
    connectionLabel?: string;
  } | null;
};

export type ReadyDelivery = {
  id: string;
  taskId: string;
  taskPath: string;
  sourceNodeId: string;
  summary: string;
  status: "ready";
  createdAt: string;
};

export type DecisionRequest = {
  id: string;
  taskId: string;
  taskPath: string;
  question: string;
  options: readonly { id: string; label: string }[];
  createdAt: string;
};

export type CollaborationSnapshot = {
  workspaceId: string;
  nodeId: string;
  targets: readonly DispatchTarget[];
  task: CollaborationTask | null;
  delivery: ReadyDelivery | null;
  decisions: readonly DecisionRequest[];
};

export type CollaborationRead<T> =
  | { ok: true; workspaceId: string; value: T; fetchedAt: string }
  | { ok: false; workspaceId: string; issue: CollaborationIssue; failedAt: string };

export type CollaborationCommand =
  | { ok: true; workspaceId: string; completedAt: string }
  | { ok: false; workspaceId: string; issue: CollaborationIssue; failedAt: string };

export type DispatchTaskInput = {
  workspaceId: string;
  workNodeIds: string[];
  contextNodeIds: string[];
  prompt: string;
  acceptMode: AcceptMode;
  target: { kind: "role" | "connection"; id: string };
};

export type DecisionResponse =
  | { kind: "option"; optionId: string }
  | { kind: "custom"; text: string }
  | { kind: "deny" };

export type CollaborationSurfaceGateway = {
  collaborationSnapshot(workspaceId: string, nodeId: string): Promise<ProtocolCollaborationRead<ProtocolCollaborationSnapshot>>;
  dispatchTask(input: DispatchTaskInput): Promise<ProtocolCollaborationRead<ProtocolCollaborationMutation>>;
  acceptDelivery(workspaceId: string, taskPath: string, deliveryId: string): Promise<ProtocolCollaborationRead<ProtocolCollaborationMutation>>;
  rejectDelivery(workspaceId: string, taskPath: string, deliveryId: string, note: string): Promise<ProtocolCollaborationRead<ProtocolCollaborationMutation>>;
  respondDecision(
    workspaceId: string,
    taskPath: string,
    requestId: string,
    response: DecisionResponse
  ): Promise<ProtocolCollaborationRead<ProtocolCollaborationMutation>>;
};

export type CollaborationSurfaceStatus =
  | "idle"
  | "loading"
  | "ready"
  | "refreshing"
  | "stale"
  | "error";

export type CollaborationSurfaceView = {
  workspaceId: string | null;
  nodeId: string | null;
  status: CollaborationSurfaceStatus;
  snapshot: CollaborationSnapshot | null;
  issue?: CollaborationIssue;
  actionIssue?: CollaborationIssue;
  busyKey: string | null;
  canMutate: boolean;
};

export type CollaborationSurfaceActions = {
  retry: () => Promise<void>;
  dispatch: (input: Omit<DispatchTaskInput, "workspaceId">) => Promise<boolean>;
  acceptDelivery: (taskPath: string, deliveryId: string) => Promise<boolean>;
  rejectDelivery: (taskPath: string, deliveryId: string, note: string) => Promise<boolean>;
  respondDecision: (
    taskPath: string,
    requestId: string,
    response: DecisionResponse
  ) => Promise<boolean>;
};

function emptyView(): CollaborationSurfaceView {
  return {
    workspaceId: null,
    nodeId: null,
    status: "idle",
    snapshot: null,
    busyKey: null,
    canMutate: false,
  };
}

function surfaceSnapshot(raw: ProtocolCollaborationSnapshot): CollaborationSnapshot {
  const roleById = new Map(raw.roles.map((role) => [role.roleId, role]));
  const connectionById = new Map(raw.connections.map((connection) => [connection.connectionId, connection]));
  return {
    workspaceId: raw.workspaceId,
    nodeId: raw.nodeId,
    targets: [
      ...raw.roles.map((role) => ({
        kind: "role" as const,
        id: role.roleId,
        label: role.displayName,
        ...(role.description ? { description: role.description } : {}),
      })),
      ...raw.connections.map((connection) => ({
        kind: "connection" as const,
        id: connection.connectionId,
        label: connection.displayName,
        description: connection.provider,
      })),
    ],
    task: raw.task ? (() => {
      const task = raw.task;
      const role = task.roleId ? roleById.get(task.roleId) : undefined;
      const connection = raw.session?.connectionId
        ? connectionById.get(raw.session.connectionId)
        : undefined;
      return {
        id: task.id ?? task.path,
        path: task.path,
        state: task.state,
        workNodeIds: task.workNodeIds,
        contextNodeIds: task.contextNodeIds,
        acceptMode: task.acceptMode,
        ...(task.roleId ? { roleId: task.roleId } : {}),
        ...(task.sessionId ? { sessionId: task.sessionId } : {}),
        ...(task.activeDeliveryId ? { activeDeliveryId: task.activeDeliveryId } : {}),
        ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
        ...(role
          ? { assignee: { kind: "role" as const, label: role.displayName } }
          : connection
            ? { assignee: { kind: "connection" as const, label: connection.displayName } }
            : {}),
        session: raw.session
          ? {
              id: raw.session.sessionId,
              state: raw.session.state,
              alive: raw.session.alive,
              turnBusy: raw.session.turnBusy,
              ...(connection ? { connectionLabel: connection.displayName } : {}),
            }
          : null,
      };
    })() : null,
    delivery: raw.deliveryReview ? ((delivery) => ({
      id: delivery.id,
      taskId: delivery.taskId,
      taskPath: delivery.taskPath,
      sourceNodeId: delivery.sourceNodeId,
      summary: delivery.summary,
      status: delivery.status,
      createdAt: delivery.createdAt,
    }))(raw.deliveryReview) : null,
    decisions: raw.decisionRequests.map((request) => ({
      id: request.id,
      taskId: request.taskId,
      taskPath: request.taskPath,
      question: request.question,
      options: request.options,
      createdAt: request.createdAt,
    })),
  };
}

/**
 * Workspace collaboration resource owner. Commands never fabricate lifecycle
 * state: every successful or uncertain mutation converges through a named read.
 */
export class CollaborationSurfaceController {
  private readonly listeners = new Set<() => void>();
  private workspaceId: string | null = null;
  private nodeId: string | null = null;
  private online = true;
  private status: CollaborationSurfaceStatus = "idle";
  private snapshot: CollaborationSnapshot | null = null;
  private issue: CollaborationIssue | undefined;
  private actionIssue: CollaborationIssue | undefined;
  private busyKey: string | null = null;
  private queuedInvalidation = false;
  private readGeneration = 0;
  private commandGeneration = 0;
  private reloadInFlight: Promise<void> | null = null;
  private viewCache = emptyView();

  constructor(private readonly gateway: CollaborationSurfaceGateway) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): CollaborationSurfaceView => this.viewCache;

  actions = (): CollaborationSurfaceActions => ({
    retry: () => this.reload(),
    dispatch: (input) => this.runCommand("dispatch", (workspaceId) =>
      this.gateway.dispatchTask({ workspaceId, ...input })
    ),
    acceptDelivery: (taskPath, deliveryId) => this.runCommand(`delivery:${deliveryId}`, (workspaceId) =>
      this.gateway.acceptDelivery(workspaceId, taskPath, deliveryId)
    ),
    rejectDelivery: (taskPath, deliveryId, note) => this.runCommand(`delivery:${deliveryId}`, (workspaceId) =>
      this.gateway.rejectDelivery(workspaceId, taskPath, deliveryId, note)
    ),
    respondDecision: (taskPath, requestId, response) =>
      this.runCommand(`decision:${requestId}`, (workspaceId) =>
        this.gateway.respondDecision(workspaceId, taskPath, requestId, response)
      ),
  });

  select(workspaceId: string | null, nodeId: string | null): void {
    if (this.workspaceId === workspaceId && this.nodeId === nodeId) return;
    this.workspaceId = workspaceId;
    this.nodeId = nodeId;
    this.readGeneration += 1;
    this.commandGeneration += 1;
    this.snapshot = null;
    this.issue = undefined;
    this.actionIssue = undefined;
    this.busyKey = null;
    this.queuedInvalidation = false;
    this.status = workspaceId && nodeId ? (this.online ? "loading" : "error") : "idle";
    if (!this.online && workspaceId && nodeId) {
      this.issue = { kind: "transport", message: "本地服务连接已中断" };
    }
    this.emit();
    if (workspaceId && nodeId && this.online) void this.reload();
  }

  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (!online) {
      this.readGeneration += 1;
      this.commandGeneration += 1;
      this.busyKey = null;
      this.status = this.snapshot ? "stale" : "error";
      this.issue = { kind: "transport", message: "本地服务连接已中断" };
      this.emit();
      return;
    }
    if (this.workspaceId && this.nodeId) void this.reload();
  }

  async invalidate(): Promise<void> {
    if (!this.workspaceId || !this.nodeId) return;
    if (this.busyKey || this.reloadInFlight) {
      this.queuedInvalidation = true;
      return;
    }
    if (!this.online) {
      this.status = this.snapshot ? "stale" : "error";
      this.emit();
      return;
    }
    await this.reload();
  }

  async reload(): Promise<void> {
    if (this.reloadInFlight) {
      this.queuedInvalidation = true;
      return this.reloadInFlight;
    }
    const workspaceId = this.workspaceId;
    const nodeId = this.nodeId;
    if (!workspaceId || !nodeId || !this.online) return;
    const generation = ++this.readGeneration;
    this.status = this.snapshot ? "refreshing" : "loading";
    this.issue = undefined;
    this.emit();
    const run = (async () => {
      const read = await this.gateway.collaborationSnapshot(workspaceId, nodeId);
      if (
        generation !== this.readGeneration ||
        workspaceId !== this.workspaceId ||
        nodeId !== this.nodeId ||
        !this.online
      ) return;
      if (read.ok) {
        this.snapshot = surfaceSnapshot(read.value);
        this.status = "ready";
        this.issue = undefined;
      } else {
        this.status = this.snapshot ? "stale" : "error";
        this.issue = read.issue;
      }
      this.emit();
    })().finally(() => {
      if (this.reloadInFlight === run) this.reloadInFlight = null;
      if (this.queuedInvalidation && this.online && this.workspaceId && this.nodeId) {
        this.queuedInvalidation = false;
        void this.reload();
      }
    });
    this.reloadInFlight = run;
    return run;
  }

  private async runCommand(
    busyKey: string,
    command: (workspaceId: string) => Promise<ProtocolCollaborationRead<ProtocolCollaborationMutation>>
  ): Promise<boolean> {
    const workspaceId = this.workspaceId;
    const nodeId = this.nodeId;
    if (
      !workspaceId ||
      !nodeId ||
      !this.online ||
      this.status !== "ready" ||
      this.busyKey
    ) return false;
    const commandGeneration = ++this.commandGeneration;
    this.busyKey = busyKey;
    this.actionIssue = undefined;
    this.emit();
    let success = false;
    try {
      const result = await command(workspaceId);
      if (
        workspaceId !== this.workspaceId ||
        nodeId !== this.nodeId ||
        commandGeneration !== this.commandGeneration
      ) return false;
      success = result.ok;
      if (!result.ok) this.actionIssue = result.issue;
    } finally {
      if (
        workspaceId === this.workspaceId &&
        nodeId === this.nodeId &&
        commandGeneration === this.commandGeneration
      ) {
        this.busyKey = null;
        this.emit();
        if (this.online) await this.reload();
        else {
          this.status = this.snapshot ? "stale" : "error";
          this.emit();
        }
      }
    }
    return success;
  }

  private emit(): void {
    this.viewCache = {
      workspaceId: this.workspaceId,
      nodeId: this.nodeId,
      status: this.status,
      snapshot: this.snapshot,
      ...(this.issue ? { issue: this.issue } : {}),
      ...(this.actionIssue ? { actionIssue: this.actionIssue } : {}),
      busyKey: this.busyKey,
      canMutate: this.online && this.status === "ready" && this.busyKey === null,
    };
    for (const listener of this.listeners) listener();
  }
}
