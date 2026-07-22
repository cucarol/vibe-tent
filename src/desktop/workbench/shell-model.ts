// UI-framework-free desktop shell model (workbench-model layer).

import type { ServiceRpcClient } from "../client/rpc-client.js";
import { ServiceDocsClient } from "../client/service-docs-client.js";
import { WorkspaceController, type WorkspaceSnapshot } from "../../markdown/workspace-controller.js";
import type {
  AgentProfileProjection,
  BoxProjection,
  DeliveryProjection,
  RoleRegistryEntryProjection,
  SessionProjection,
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
  applyBoxProjectionsToTree,
  collectCoordinationBoxIds,
  normalizeBoxProjection,
  type BoxProjectionView,
} from "./box-projection.js";
import {
  buildStartSessionPayload,
  buildTaskReviewItems,
  listCoordinationTypeOptions,
  listProfileOptions,
  listRoleOptions,
  pickDefaultProfileId,
  type CoordinationTypeOption,
  type ProfileOption,
  type RoleOption,
  type TaskReviewItem,
} from "./collaboration-ui.js";

export type ShellTaskRow = {
  path: string;
  role: string;
  status: string;
  claims: string[];
  /** Full lifecycle state when available (task-api). */
  state?: string;
  id?: string;
  prompt?: string;
  activeDeliveryId?: string;
  sessionId?: string;
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
  /** Product profile picker options (testOnly hidden unless includeTest). */
  profiles: ProfileOption[];
  /** Selected machine-local profile id for start agent. */
  selectedProfileId: string | null;
  statusMessage: string | null;
  /** box.projection by boxId — collab status truth for workbench consumers. */
  boxProjections: BoxProjectionView[];
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
  private profiles: ProfileOption[] = [];
  private selectedProfileId: string | null = null;
  private statusMessage: string | null = null;
  private boxProjections = new Map<string, BoxProjectionView>();
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
      const overlaid = applyBoxProjectionsToTree(stripped, this.boxProjections);
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
          role: t.role,
          claims: t.claims,
          status: (t.status === "taken" ? "taken" : "pending") as "pending" | "taken",
          state: t.state || t.status,
          prompt: t.prompt,
          activeDeliveryId: t.activeDeliveryId,
          sessionId: t.sessionId,
          manifest: "",
        })),
        this.deliveries,
        this.sessions
      ),
      roles: this.roles,
      coordinationTypes: this.coordinationTypes,
      profiles: this.profiles,
      selectedProfileId: this.selectedProfileId,
      statusMessage: this.statusMessage,
      boxProjections: [...this.boxProjections.values()],
    };
  }

  getController(): WorkspaceController | null {
    return this.controller;
  }

  setSelectedProfileId(profileId: string | null): void {
    this.selectedProfileId = profileId;
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
    this.boxProjections.clear();
    this.docs = new ServiceDocsClient({ rpc: this.rpc, workspaceId });
    this.controller = new WorkspaceController(this.docs);
    this.controller.subscribe(() => this.emit());
    await this.controller.refreshTree();
    // refreshTasks also refreshes box.projection (task/delivery/session invalidation).
    await Promise.all([this.refreshTasks(), this.refreshRegistry(), this.refreshProfiles()]);
    this.emit();
  }

  /**
   * box.projection fan-out for coordination nodes in the current tree.
   * Sole authority for status/assignee/activeTaskId on the shell snapshot tree.
   */
  async refreshBoxProjections(): Promise<void> {
    if (!this.rpc || !this.foregroundWorkspaceId || !this.controller) {
      this.boxProjections.clear();
      this.emit();
      return;
    }
    const snap = this.controller.getSnapshot();
    const ids = collectCoordinationBoxIds((snap.tree ?? []) as TreeNodeShape[]);
    if (ids.length === 0) {
      this.boxProjections.clear();
      this.emit();
      return;
    }
    const ws = this.foregroundWorkspaceId;
    const results = await Promise.all(
      ids.map((id) =>
        this.rpc!
          .call<BoxProjection>("box.projection", { workspaceId: ws, id })
          .then((raw) => normalizeBoxProjection(raw))
          .catch(() => null)
      )
    );
    this.boxProjections.clear();
    for (const p of results) {
      if (p) this.boxProjections.set(p.boxId, p);
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
        role: t.role,
        status: t.status,
        claims: t.claims ?? [],
        state: t.state,
        id: t.id,
        prompt: t.prompt,
        activeDeliveryId: t.activeDeliveryId,
        sessionId: t.sessionId,
      }));
      this.deliveries = deliveryResult.deliveries ?? [];
      this.sessions = sessionResult.sessions ?? [];
      // Task/delivery/session changes invalidate box collab projection.
      await this.refreshBoxProjections();
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
   * Load machine-local profiles (product list: testOnly hidden).
   * Does not start sessions; selection only.
   */
  async refreshProfiles(): Promise<ProfileOption[]> {
    if (!this.rpc) {
      this.profiles = [];
      this.selectedProfileId = null;
      this.emit();
      return this.profiles;
    }
    try {
      const result = await this.rpc.call<{ profiles: AgentProfileProjection[] }>("profile.list", {});
      this.profiles = listProfileOptions(result.profiles ?? []);
      if (
        !this.selectedProfileId ||
        !this.profiles.some((p) => p.id === this.selectedProfileId)
      ) {
        this.selectedProfileId = pickDefaultProfileId(this.profiles);
      }
    } catch {
      this.profiles = [];
      // Keep previous selection only if still meaningful; otherwise clear.
      if (!this.profiles.length) this.selectedProfileId = null;
    }
    this.emit();
    return this.profiles;
  }

  /**
   * User-clicked start agent. Builds task.startSession with callerKind=user.
   * Does not auto-run; service may claim queued tasks for user callers.
   */
  async startAgentSession(taskPath: string, profileId?: string): Promise<unknown> {
    if (!this.rpc || !this.foregroundWorkspaceId) {
      throw new Error("服务未连接或未选择工作区。");
    }
    const pid = (profileId ?? this.selectedProfileId ?? "").trim();
    const built = buildStartSessionPayload(taskPath, pid);
    if (!built.ok) {
      throw new Error(built.reason);
    }
    const result = await this.rpc.call("task.startSession", {
      workspaceId: this.foregroundWorkspaceId,
      taskPath: built.payload.taskPath,
      profileId: built.payload.profileId,
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
    this.cards.pushBox(tab.cx, tab.path, tab.name, fg?.workspaceRoot);
  }

  floatingStatus(): FloatingStatusSnapshot {
    const fg = this.workspaces.find((w) => w.workspaceId === this.foregroundWorkspaceId);
    return {
      health: this.health,
      pendingTasks: this.tasks.filter(
        (t) => t.status === "pending" || t.state === "queued" || t.state === "pending"
      ).length,
      takenTasks: this.tasks.filter(
        (t) =>
          t.status === "taken" ||
          t.state === "running" ||
          t.state === "taken" ||
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
  id: string;
  coordination: boolean;
  status?: string;
  assignee?: string;
  children?: TreeNodeShape[];
  [key: string]: unknown;
};

/** Drop list-side collab fields before box.projection overlay. */
function stripTreeCollab(nodes: TreeNodeShape[]): TreeNodeShape[] {
  return nodes.map((n) => {
    const { status: _s, assignee: _a, children, ...rest } = n;
    return {
      ...rest,
      children: children ? stripTreeCollab(children) : children,
    } as TreeNodeShape;
  });
}
