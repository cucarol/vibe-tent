// UI-framework-free desktop shell model (workbench-model layer).

import type { ServiceRpcClient } from "../client/rpc-client.js";
import { ServiceDocsClient } from "../client/service-docs-client.js";
import { WorkspaceController, type WorkspaceSnapshot } from "../../markdown/workspace-controller.js";
import type {
  NodeCollaboration,
  NodeCollaborationsResult,
  DeliveryProjection,
  RoleRegistryEntryProjection,
  SessionProjection,
  AgentConnectionProjection,
  TaskProjection,
  TypeRegistryEntryProjection,
} from "../../service/types.js";
import type {
  FloatingStatusSnapshot,
  ServiceHealthView,
  WorkspaceSummary,
} from "../types.js";
import { ContextCardStore } from "./context-card-store.js";
import {
  applyNodeCollaborationsToTree,
  collectUsableNodeIds,
  normalizeNodeCollaboration,
  type NodeCollaborationView,
} from "./node-collaboration.js";
import {
  buildStartSessionPayload,
  buildTaskReviewItems,
  listCoordinationTypeOptions,
  listConnectionOptions,
  listRoleOptions,
  pickDefaultConnectionId,
  type CoordinationTypeOption,
  type ConnectionOption,
  type RoleOption,
  type TaskReviewItem,
} from "./collaboration-ui.js";

export type ShellTaskRow = {
  path: string;
  roleId?: string;
  /** Node ids from TaskProjection.referencedNodeIds (Context Card refs). */
  referencedNodeIds: string[];
  /** Canonical lifecycle state (task-api). */
  state: string;
  id?: string;
  prompt?: string;
  activeDeliveryId?: string;
  sessionId?: string;
  contextCard: TaskProjection["contextCard"];
};

export type ShellSnapshot = {
  health: ServiceHealthView;
  workspaces: WorkspaceSummary[];
  foregroundWorkspaceId: string | null;
  workspace: WorkspaceSnapshot | null;
  tasks: ShellTaskRow[];
  /** Enriched review rows (delivery summary/commits when loaded). */
  taskReview: TaskReviewItem[];
  roles: RoleOption[];
  coordinationTypes: CoordinationTypeOption[];
  /** Machine-local Agent Connection picker options. */
  connections: ConnectionOption[];
  /** Selected machine-local Agent Connection id in the shell snapshot. */
  selectedConnectionId: string | null;
  statusMessage: string | null;
  /** Canonical Node collaboration projections keyed by nodeId. */
  nodeCollaborations: NodeCollaborationView[];
};

export class DesktopShellModel {
  private health: ServiceHealthView = { status: "offline" };
  private workspaces: WorkspaceSummary[] = [];
  private foregroundWorkspaceId: string | null = null;
  private docs: ServiceDocsClient | null = null;
  private controller: WorkspaceController | null = null;
  private tasks: ShellTaskRow[] = [];
  private deliveries: DeliveryProjection[] = [];
  private sessions: SessionProjection[] = [];
  private roles: RoleOption[] = [];
  private coordinationTypes: CoordinationTypeOption[] = [];
  private connections: ConnectionOption[] = [];
  private selectedConnectionId: string | null = null;
  private statusMessage: string | null = null;
  private nodeCollaborations = new Map<string, NodeCollaborationView>();
  private listeners = new Set<() => void>();
  readonly cards = new ContextCardStore();

  constructor(private rpc: ServiceRpcClient | null = null) {}

  setRpc(rpc: ServiceRpcClient | null): void {
    this.rpc = rpc;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ShellSnapshot {
    const raw = this.controller?.getSnapshot() ?? null;
    let workspace = raw;
    if (raw) {
      const stripped = stripTreeCollab(raw.tree as unknown as TreeNodeShape[]);
      const overlaid = applyNodeCollaborationsToTree(stripped, this.nodeCollaborations);
      workspace = {
        ...raw,
        tree: overlaid as unknown as typeof raw.tree,
      };
    }
    return {
      health: this.health,
      workspaces: this.workspaces,
      foregroundWorkspaceId: this.foregroundWorkspaceId,
      workspace,
      tasks: this.tasks,
      taskReview: buildTaskReviewItems(
        this.tasks.map((t) => ({
          path: t.path,
          id: t.id,
          roleId: t.roleId,
          referencedNodeIds: t.referencedNodeIds,
          state: t.state,
          prompt: t.prompt,
          activeDeliveryId: t.activeDeliveryId,
          sessionId: t.sessionId,
          manifest: "",
          contextCard: t.contextCard,
        })),
        this.deliveries,
        this.sessions
      ),
      roles: this.roles,
      coordinationTypes: this.coordinationTypes,
      connections: this.connections,
      selectedConnectionId: this.selectedConnectionId,
      statusMessage: this.statusMessage,
      nodeCollaborations: [...this.nodeCollaborations.values()],
    };
  }

  getController(): WorkspaceController | null {
    return this.controller;
  }

  setSelectedConnectionId(connectionId: string | null): void {
    this.selectedConnectionId = connectionId;
    this.emit();
  }

  async refreshHealth(): Promise<ServiceHealthView> {
    if (!this.rpc) {
      this.health = { status: "offline" };
      this.emit();
      return this.health;
    }
    try {
      const h = await this.rpc.health();
      this.health = {
        status: h.status === "ok" ? "ok" : "stopping",
        pid: h.pid,
        version: h.version,
        startedAt: h.startedAt,
        workspaceCount: h.workspaceCount,
        foregroundWorkspaceId: h.foregroundWorkspaceId,
        url: this.rpc.url,
      };
    } catch {
      this.health = { status: "offline", url: this.rpc.url };
    }
    this.emit();
    return this.health;
  }

  async refreshWorkspaces(): Promise<WorkspaceSummary[]> {
    if (!this.rpc) {
      this.workspaces = [];
      this.emit();
      return this.workspaces;
    }
    const result = await this.rpc.call<{
      workspaces: Array<{
        workspaceId: string;
        workspaceRoot: string;
        tentName: string;
        foreground: boolean;
      }>;
    }>("workspace.list", {});
    this.workspaces = (result.workspaces ?? []).map((w) => ({
      workspaceId: w.workspaceId,
      workspaceRoot: w.workspaceRoot,
      tentName: w.tentName,
      foreground: w.foreground,
    }));
    const fg = this.workspaces.find((w) => w.foreground);
    this.foregroundWorkspaceId = fg?.workspaceId ?? this.health.foregroundWorkspaceId ?? null;
    this.emit();
    return this.workspaces;
  }

  async mountWorkspace(workspaceRoot: string): Promise<WorkspaceSummary> {
    if (!this.rpc) throw new Error("Service not attached");
    const info = await this.rpc.call<{
      workspaceId: string;
      workspaceRoot: string;
      tentName: string;
      foreground: boolean;
    }>("workspace.mount", { workspaceRoot });
    await this.refreshWorkspaces();
    await this.bindForeground(info.workspaceId);
    this.statusMessage = `Mounted ${info.workspaceRoot}`;
    this.emit();
    return {
      workspaceId: info.workspaceId,
      workspaceRoot: info.workspaceRoot,
      tentName: info.tentName,
      foreground: true,
    };
  }

  async setForeground(workspaceId: string): Promise<void> {
    if (!this.rpc) throw new Error("Service not attached");
    await this.rpc.call("workspace.setForeground", { workspaceId });
    await this.refreshWorkspaces();
    await this.bindForeground(workspaceId);
  }

  async bindForeground(workspaceId: string): Promise<void> {
    if (!this.rpc) return;
    this.foregroundWorkspaceId = workspaceId;
    this.nodeCollaborations.clear();
    this.docs = new ServiceDocsClient({ rpc: this.rpc, workspaceId });
    this.controller = new WorkspaceController(this.docs);
    this.controller.subscribe(() => this.emit());
    await this.controller.refreshTree();
    // Task/delivery/session changes invalidate Node collaboration projections.
    await Promise.all([this.refreshTasks(), this.refreshRegistry(), this.refreshConnections()]);
    this.emit();
  }

  /** Refresh canonical Node collaboration in one batch. */
  async refreshNodeCollaborations(): Promise<void> {
    if (!this.rpc || !this.foregroundWorkspaceId || !this.controller) {
      this.nodeCollaborations.clear();
      this.emit();
      return;
    }
    const snap = this.controller.getSnapshot();
    const ids = collectUsableNodeIds((snap.tree ?? []) as TreeNodeShape[]);
    if (ids.length === 0) {
      this.nodeCollaborations.clear();
      this.emit();
      return;
    }
    const ws = this.foregroundWorkspaceId;
    const batch = await this.rpc.call<NodeCollaborationsResult>("node.collaborations", {
      workspaceId: ws,
      nodeIds: ids,
    });
    const results = batch.items.map((item) => normalizeNodeCollaboration(item));
    this.nodeCollaborations.clear();
    for (const p of results) {
      if (p) this.nodeCollaborations.set(p.nodeId, p);
    }
    this.emit();
  }

  async refreshTasks(): Promise<void> {
    if (!this.rpc || !this.foregroundWorkspaceId) {
      this.tasks = [];
      this.deliveries = [];
      this.sessions = [];
      this.emit();
      return;
    }
    try {
      const [taskResult, deliveryResult, sessionResult] = await Promise.all([
        this.rpc.call<{ tasks: TaskProjection[] }>("task.list", {
          workspaceId: this.foregroundWorkspaceId,
        }),
        this.rpc.call<{ deliveries: DeliveryProjection[] }>("delivery.list", {
          workspaceId: this.foregroundWorkspaceId,
        }),
        this.rpc.call<{ sessions: SessionProjection[] }>("session.list", {
          workspaceId: this.foregroundWorkspaceId,
        }),
      ]);
      this.tasks = (taskResult.tasks ?? []).map((t) => ({
        path: t.path,
        roleId: t.roleId,
        referencedNodeIds: t.referencedNodeIds ?? [],
        state: t.state,
        id: t.id,
        prompt: t.prompt,
        activeDeliveryId: t.activeDeliveryId,
        sessionId: t.sessionId,
        contextCard: t.contextCard,
      }));
      this.deliveries = deliveryResult.deliveries ?? [];
      this.sessions = sessionResult.sessions ?? [];
      // Task/Delivery/Session changes invalidate node.collaboration.
      await this.refreshNodeCollaborations();
    } catch {
      this.tasks = [];
      this.deliveries = [];
      this.sessions = [];
    }
    this.emit();
  }

  async refreshRegistry(): Promise<void> {
    if (!this.rpc || !this.foregroundWorkspaceId) {
      this.roles = [];
      this.coordinationTypes = [];
      this.emit();
      return;
    }
    try {
      const [typesResult, rolesResult] = await Promise.all([
        this.rpc.call<{ types: TypeRegistryEntryProjection[] }>("registry.types", {
          workspaceId: this.foregroundWorkspaceId,
        }),
        this.rpc.call<{ roles: RoleRegistryEntryProjection[] }>("registry.roles", {
          workspaceId: this.foregroundWorkspaceId,
        }),
      ]);
      this.coordinationTypes = listCoordinationTypeOptions(typesResult.types ?? []);
      this.roles = listRoleOptions(rolesResult.roles ?? []);
    } catch {
      this.roles = [];
      this.coordinationTypes = [];
    }
    this.emit();
  }

  /**
   * Load machine-local Agent Connections.
   * Does not start sessions; selection only.
   */
  async refreshConnections(): Promise<ConnectionOption[]> {
    if (!this.rpc) {
      this.connections = [];
      this.selectedConnectionId = null;
      this.emit();
      return this.connections;
    }
    try {
      const result = await this.rpc.call<{ connections: AgentConnectionProjection[] }>("connection.list", {});
      this.connections = listConnectionOptions(result.connections ?? []);
      if (
        !this.selectedConnectionId ||
        !this.connections.some((connection) => connection.connectionId === this.selectedConnectionId)
      ) {
        this.selectedConnectionId = pickDefaultConnectionId(this.connections);
      }
    } catch {
      this.connections = [];
      // Keep previous selection only if still meaningful; otherwise clear.
      if (!this.connections.length) this.selectedConnectionId = null;
    }
    this.emit();
    return this.connections;
  }

  /**
   * User-clicked start agent. Builds task.startSession with callerKind=user.
   * Does not auto-run; service may claim queued tasks for user callers.
   */
  async startAgentSession(taskPath: string): Promise<unknown> {
    if (!this.rpc || !this.foregroundWorkspaceId) {
      throw new Error("服务未连接或未选择工作区。");
    }
    const built = buildStartSessionPayload(taskPath);
    if (!built.ok) {
      throw new Error(built.reason);
    }
    const result = await this.rpc.call("task.startSession", {
      workspaceId: this.foregroundWorkspaceId,
      taskPath: built.payload.taskPath,
      callerKind: built.payload.callerKind,
    });
    await this.refreshTasks();
    return result;
  }

  async interruptTask(taskPath: string): Promise<unknown> {
    if (!this.rpc || !this.foregroundWorkspaceId) {
      throw new Error("服务未连接或未选择工作区。");
    }
    const result = await this.rpc.call("task.interrupt", {
      workspaceId: this.foregroundWorkspaceId,
      taskPath,
    });
    await this.refreshTasks();
    return result;
  }

  emitContextCardForActive(): void {
    const tab = this.controller?.getActiveTab();
    if (!tab) return;
    const fg = this.workspaces.find((w) => w.workspaceId === this.foregroundWorkspaceId);
    this.cards.pushNode(tab.nodeId, tab.path, tab.name, fg?.workspaceRoot);
  }

  floatingStatus(): FloatingStatusSnapshot {
    const fg = this.workspaces.find((w) => w.workspaceId === this.foregroundWorkspaceId);
    return {
      health: this.health,
      pendingTasks: this.tasks.filter(
        (t) => t.state === "queued"
      ).length,
      takenTasks: this.tasks.filter(
        (t) =>
          t.state === "running" ||
          t.state === "waiting" ||
          t.state === "delivered"
      ).length,
      recentCards: this.cards.list(),
      foregroundRoot: fg?.workspaceRoot ?? null,
    };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

type TreeNodeShape = {
  nodeId: string;
  coordination?: boolean;
  invalid?: boolean;
  archived?: boolean;
  mode?: string;
  status?: string;
  assignee?: string;
  children?: TreeNodeShape[];
  [key: string]: unknown;
};

/** Drop list-side collaboration fields before applying live Node occupation. */
function stripTreeCollab(nodes: TreeNodeShape[]): TreeNodeShape[] {
  return nodes.map((n) => {
    const { status: _s, assignee: _a, children, ...rest } = n;
    return {
      ...rest,
      children: children ? stripTreeCollab(children) : children,
    } as TreeNodeShape;
  });
}
