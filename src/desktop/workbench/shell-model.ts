// UI-framework-free desktop bootstrap and floating-control model.

import type { ServiceRpcClient } from "../client/rpc-client.js";
import type { TaskProjection } from "../../service/types.js";
import type {
  DesktopBootstrapSnapshot,
  FloatingStatusSnapshot,
  ServiceHealthView,
  WorkspaceSummary,
} from "../types.js";
import { ContextCardStore } from "./context-card-store.js";

type FloatingTaskState = Pick<TaskProjection, "state">;

/**
 * Main-window state is deliberately only the bootstrap identity needed before
 * renderer-next starts its named authoritative projections. Task, Session,
 * Delivery and Connection facts never cross getState/onStateChanged.
 */
export class DesktopShellModel {
  private health: ServiceHealthView = { status: "offline" };
  private workspaces: WorkspaceSummary[] = [];
  private foregroundWorkspaceId: string | null = null;
  private floatingTasks: FloatingTaskState[] = [];
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

  getSnapshot(): DesktopBootstrapSnapshot {
    return {
      health: this.health,
      workspaces: this.workspaces,
      foregroundWorkspaceId: this.foregroundWorkspaceId,
    };
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
        protocolVersion: h.protocolVersion,
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
      this.foregroundWorkspaceId = null;
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
    this.workspaces = (result.workspaces ?? []).map((workspace) => ({
      workspaceId: workspace.workspaceId,
      workspaceRoot: workspace.workspaceRoot,
      tentName: workspace.tentName,
      foreground: workspace.foreground,
    }));
    const foreground = this.workspaces.find((workspace) => workspace.foreground);
    this.foregroundWorkspaceId = foreground?.workspaceId ?? this.health.foregroundWorkspaceId ?? null;
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
    await this.rpc.call("workspace.setForeground", { workspaceId: info.workspaceId });
    await this.refreshWorkspaces();
    this.bindForeground(info.workspaceId);
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
    this.bindForeground(workspaceId);
  }

  /** Bind only bootstrap identity; renderer-next owns graph/document/collaboration. */
  bindForeground(workspaceId: string): void {
    this.foregroundWorkspaceId = workspaceId;
    this.floatingTasks = [];
    this.emit();
  }

  /** Float-only task counts, loaded only when the floating window asks for them. */
  async refreshFloatingTasks(): Promise<void> {
    if (!this.rpc || !this.foregroundWorkspaceId) {
      this.floatingTasks = [];
      this.emit();
      return;
    }
    try {
      const result = await this.rpc.call<{ tasks: TaskProjection[] }>("task.list", {
        workspaceId: this.foregroundWorkspaceId,
      });
      this.floatingTasks = (result.tasks ?? []).map((task) => ({ state: task.state }));
    } catch {
      this.floatingTasks = [];
    }
    this.emit();
  }

  floatingStatus(): FloatingStatusSnapshot {
    const foreground = this.workspaces.find(
      (workspace) => workspace.workspaceId === this.foregroundWorkspaceId
    );
    return {
      health: this.health,
      pendingTasks: this.floatingTasks.filter((task) => task.state === "queued").length,
      takenTasks: this.floatingTasks.filter((task) =>
        task.state === "running" || task.state === "waiting" || task.state === "delivered"
      ).length,
      recentCards: this.cards.list(),
      foregroundRoot: foreground?.workspaceRoot ?? null,
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
