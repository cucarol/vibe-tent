import type {
  CollaborationMutation,
  CollaborationRead,
  CollaborationTarget,
  DispatchTaskRequest,
  DispatchTargets,
} from "../gateway/collaboration-protocol.js";
import type { ProjectionRead } from "../gateway/workspace-projections.js";
import type { WorkspaceCollaborationView } from "./workspace-collaboration-view.js";

export type AcceptMode = "review-required" | "auto-accept" | "agent-decide";
export type CollaborationIssue = {
  kind: "timeout" | "transport" | "rpc" | "corrupt" | "unsupported" | "invalid-request" | "invalid-response" | "request";
  message: string;
  code?: number;
  data?: unknown;
};

export type DispatchTaskInput = Omit<DispatchTaskRequest, "workspaceId">;
export type DecisionResponse =
  | { kind: "option"; optionId: string }
  | { kind: "custom"; text: string }
  | { kind: "deny" };

export type CollaborationSurfaceGateway = {
  workspaceCollaboration(
    workspaceId: string,
    nodeId: string | null
  ): Promise<ProjectionRead<WorkspaceCollaborationView>>;
  dispatchTargets(workspaceId: string): Promise<CollaborationRead<DispatchTargets>>;
  dispatchTask(input: DispatchTaskRequest): Promise<CollaborationRead<CollaborationMutation>>;
  acceptTaskResult(
    workspaceId: string,
    resultId: string
  ): Promise<CollaborationRead<CollaborationMutation>>;
  rejectTaskResult(
    workspaceId: string,
    resultId: string,
    note: string
  ): Promise<CollaborationRead<CollaborationMutation>>;
  respondDecision(
    workspaceId: string,
    requestId: string,
    response: DecisionResponse
  ): Promise<CollaborationRead<CollaborationMutation>>;
};

export type CollaborationSurfaceStatus = "idle" | "loading" | "ready" | "refreshing" | "stale" | "error";
export type CollaborationSurfaceView = {
  workspaceId: string | null;
  nodeId: string | null;
  status: CollaborationSurfaceStatus;
  snapshot: WorkspaceCollaborationView | null;
  targets: readonly CollaborationTarget[];
  targetsReady: boolean;
  issue?: CollaborationIssue;
  targetIssue?: CollaborationIssue;
  actionIssue?: CollaborationIssue;
  busyKey: string | null;
  canMutate: boolean;
};
export type CollaborationSurfaceActions = {
  retry: () => Promise<void>;
  dispatch: (input: DispatchTaskInput) => Promise<boolean>;
  acceptTaskResult: (resultId: string) => Promise<boolean>;
  rejectTaskResult: (resultId: string, note: string) => Promise<boolean>;
  respondDecision: (requestId: string, response: DecisionResponse) => Promise<boolean>;
};

function emptyView(): CollaborationSurfaceView {
  return { workspaceId: null, nodeId: null, status: "idle", snapshot: null, targets: [], targetsReady: false, busyKey: null, canMutate: false };
}

/** One workspace resource owns selected collaboration and the user-actionable Inbox. */
export class CollaborationSurfaceController {
  private readonly listeners = new Set<() => void>();
  private workspaceId: string | null = null;
  private nodeId: string | null = null;
  private online = true;
  private status: CollaborationSurfaceStatus = "idle";
  private snapshot: WorkspaceCollaborationView | null = null;
  private targets: readonly CollaborationTarget[] = [];
  private targetsReady = false;
  private issue: CollaborationIssue | undefined;
  private targetIssue: CollaborationIssue | undefined;
  private actionIssue: CollaborationIssue | undefined;
  private busyKey: string | null = null;
  private queuedInvalidation = false;
  private readGeneration = 0;
  private commandGeneration = 0;
  private reloadInFlight: Promise<void> | null = null;
  private viewCache = emptyView();

  constructor(private readonly gateway: CollaborationSurfaceGateway) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getView = (): CollaborationSurfaceView => this.viewCache;
  actions = (): CollaborationSurfaceActions => ({
    retry: () => this.reload(),
    dispatch: (input) => this.runCommand("dispatch", (workspaceId) => this.gateway.dispatchTask({ workspaceId, ...input })),
    acceptTaskResult: (resultId) => this.runCommand(`result:${resultId}`, (workspaceId) => this.gateway.acceptTaskResult(workspaceId, resultId)),
    rejectTaskResult: (resultId, note) => this.runCommand(`result:${resultId}`, (workspaceId) => this.gateway.rejectTaskResult(workspaceId, resultId, note)),
    respondDecision: (requestId, response) => this.runCommand(`decision:${requestId}`, (workspaceId) => this.gateway.respondDecision(workspaceId, requestId, response)),
  });

  select(workspaceId: string | null, nodeId: string | null): void {
    if (this.workspaceId === workspaceId && this.nodeId === nodeId) return;
    const sameWorkspaceInbox = workspaceId && this.workspaceId === workspaceId && this.snapshot
      ? { ...this.snapshot, selectedNode: null }
      : null;
    this.workspaceId = workspaceId;
    this.nodeId = nodeId;
    this.readGeneration += 1;
    this.commandGeneration += 1;
    this.snapshot = sameWorkspaceInbox;
    this.issue = undefined;
    this.actionIssue = undefined;
    this.busyKey = null;
    this.queuedInvalidation = false;
    this.status = workspaceId
      ? (this.online ? (sameWorkspaceInbox ? "refreshing" : "loading") : (sameWorkspaceInbox ? "stale" : "error"))
      : "idle";
    if (!this.online && workspaceId) this.issue = { kind: "transport", message: "本地服务连接已中断" };
    this.emit();
    if (workspaceId && this.online) void this.reload();
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
    if (this.workspaceId) void this.reload();
  }

  async invalidate(): Promise<void> {
    if (!this.workspaceId) return;
    if (this.busyKey || this.reloadInFlight) { this.queuedInvalidation = true; return; }
    if (!this.online) { this.status = this.snapshot ? "stale" : "error"; this.emit(); return; }
    await this.reload();
  }

  async reload(): Promise<void> {
    if (this.reloadInFlight) { this.queuedInvalidation = true; return this.reloadInFlight; }
    const workspaceId = this.workspaceId;
    const nodeId = this.nodeId;
    if (!workspaceId || !this.online) return;
    const generation = ++this.readGeneration;
    this.status = this.snapshot ? "refreshing" : "loading";
    this.issue = undefined;
    this.emit();
    const run = (async () => {
      const [read, targets] = await Promise.all([
        this.gateway.workspaceCollaboration(workspaceId, nodeId),
        this.gateway.dispatchTargets(workspaceId),
      ]);
      if (generation !== this.readGeneration || workspaceId !== this.workspaceId || nodeId !== this.nodeId || !this.online) return;
      if (read.ok) { this.snapshot = read.value; this.status = "ready"; this.issue = undefined; }
      else { this.status = this.snapshot ? "stale" : "error"; this.issue = read.issue; }
      if (targets.ok) { this.targets = targets.value.targets; this.targetsReady = true; this.targetIssue = undefined; }
      else { this.targetsReady = false; this.targetIssue = targets.issue; }
      this.emit();
    })().finally(() => {
      if (this.reloadInFlight === run) this.reloadInFlight = null;
      if (this.queuedInvalidation && this.online && this.workspaceId) { this.queuedInvalidation = false; void this.reload(); }
    });
    this.reloadInFlight = run;
    return run;
  }

  private async runCommand(busyKey: string, command: (workspaceId: string) => Promise<CollaborationRead<CollaborationMutation>>): Promise<boolean> {
    const workspaceId = this.workspaceId;
    const nodeId = this.nodeId;
    if (!workspaceId || !this.online || this.status !== "ready" || this.busyKey) return false;
    const generation = ++this.commandGeneration;
    this.busyKey = busyKey;
    this.actionIssue = undefined;
    this.emit();
    let success = false;
    try {
      const result = await command(workspaceId);
      if (workspaceId !== this.workspaceId || nodeId !== this.nodeId || generation !== this.commandGeneration) return false;
      success = result.ok;
      if (!result.ok) this.actionIssue = result.issue;
    } finally {
      if (workspaceId === this.workspaceId && nodeId === this.nodeId && generation === this.commandGeneration) {
        this.busyKey = null;
        this.emit();
        if (this.online) await this.reload();
      }
    }
    return success;
  }

  private emit(): void {
    this.viewCache = {
      workspaceId: this.workspaceId, nodeId: this.nodeId, status: this.status, snapshot: this.snapshot,
      targets: this.targets, targetsReady: this.targetsReady,
      ...(this.issue ? { issue: this.issue } : {}), ...(this.targetIssue ? { targetIssue: this.targetIssue } : {}),
      ...(this.actionIssue ? { actionIssue: this.actionIssue } : {}), busyKey: this.busyKey,
      canMutate: this.online && this.status === "ready" && this.busyKey === null,
    };
    for (const listener of this.listeners) listener();
  }
}
