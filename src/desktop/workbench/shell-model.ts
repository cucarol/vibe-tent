// UI-framework-free desktop shell model (workbench-model layer).

import type { ServiceRpcClient } from "../client/rpc-client.js";
import { ServiceDocsClient } from "../client/service-docs-client.js";
import { WorkspaceController, type WorkspaceSnapshot } from "../../markdown/workspace-controller.js";
import type {
  DeliveryProjection,
  RoleRegistryEntryProjection,
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
  buildTaskReviewItems,
  listCoordinationTypeOptions,
  listRoleOptions,
  type CoordinationTypeOption,
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
  statusMessage: string | null;
};

export class DesktopShellModel {
  private health: ServiceHealthView = { status: "offline" };
  private workspaces: WorkspaceSummary[] = [];
  private foregroundWorkspaceId: string | null = null;
  private docs: ServiceDocsClient | null = null;
  private controller: WorkspaceController | null = null;
  private tasks: ShellTaskRow[] = [];
  private deliveries: DeliveryProjection[] = [];
  private roles: RoleOption[] = [];
  private coordinationTypes: CoordinationTypeOption[] = [];
  private statusMessage: string | null = null;
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
    return {
      health: this.health,
      workspaces: this.workspaces,
      foregroundWorkspaceId: this.foregroundWorkspaceId,
      workspace: this.controller?.getSnapshot() ?? null,
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
          manifest: "",
        })),
        this.deliveries
      ),
      roles: this.roles,
      coordinationTypes: this.coordinationTypes,
      statusMessage: this.statusMessage,
    };
  }

  getController(): WorkspaceController | null {
    return this.controller;
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
    this.docs = new ServiceDocsClient({ rpc: this.rpc, workspaceId });
    this.controller = new WorkspaceController(this.docs);
    this.controller.subscribe(() => this.emit());
    await this.controller.refreshTree();
    await Promise.all([this.refreshTasks(), this.refreshRegistry()]);
    this.emit();
  }

  async refreshTasks(): Promise<void> {
    if (!this.rpc || !this.foregroundWorkspaceId) {
      this.tasks = [];
      this.deliveries = [];
      this.emit();
      return;
    }
    try {
      const [taskResult, deliveryResult] = await Promise.all([
        this.rpc.call<{ tasks: TaskProjection[] }>("task.list", {
          workspaceId: this.foregroundWorkspaceId,
        }),
        this.rpc.call<{ deliveries: DeliveryProjection[] }>("delivery.list", {
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
      }));
      this.deliveries = deliveryResult.deliveries ?? [];
    } catch {
      this.tasks = [];
      this.deliveries = [];
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
