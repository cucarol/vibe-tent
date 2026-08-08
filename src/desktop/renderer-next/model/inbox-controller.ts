import type { DesktopInboxSnapshot } from "../../inbox-ipc.js";
import type {
  InvalidationHint,
  ServiceGateway,
} from "../gateway/service-gateway.js";
import type { ProjectionRead } from "../gateway/workspace-projections.js";
import { settleInboxModel, type InboxModel } from "./inbox.js";

export type InboxControllerGateway = Pick<
  ServiceGateway,
  "onInvalidation" | "pendingInteractions"
>;

export class InboxController {
  private model: InboxModel = { state: "idle" };
  private workspaceId = "";
  private flight: Promise<void> | null = null;
  private rereadQueued = false;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;

  constructor(private readonly gateway: InboxControllerGateway) {
    // Install invalidation before select() can issue the first authoritative read.
    this.unsubscribe = gateway.onInvalidation((hint) => this.handleInvalidation(hint));
  }

  getView = (): InboxModel => this.model;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  select(workspaceId: string): void {
    const ws = workspaceId.trim();
    if (ws === this.workspaceId && this.model.state !== "idle") return;
    this.workspaceId = ws;
    this.model = ws ? this.loadingModel(ws) : { state: "idle" };
    this.notify();
    if (ws) void this.refresh();
  }

  invalidate(): Promise<void> {
    if (!this.workspaceId) return Promise.resolve();
    if (this.flight) {
      this.rereadQueued = true;
      return this.flight;
    }
    return this.refresh();
  }

  private handleInvalidation(hint: InvalidationHint): void {
    const eventWorkspaceId = hint.event?.workspaceId;
    if (eventWorkspaceId && eventWorkspaceId !== this.workspaceId) return;
    if (
      hint.keys.includes("*") ||
      hint.keys.includes("pending.interactions") ||
      hint.keys.includes("service.health")
    ) {
      void this.invalidate();
    }
  }

  private async refresh(): Promise<void> {
    const ws = this.workspaceId;
    if (!ws) return;
    if (this.flight) {
      this.rereadQueued = true;
      await this.flight;
      return;
    }

    this.model = this.loadingModel(ws);
    this.notify();
    // Establish the flight before invoking the transport. A hostile/mock
    // transport may synchronously publish an invalidation during first read.
    const flight = Promise.resolve().then(() => this.read(ws));
    this.flight = flight;
    try {
      await flight;
    } finally {
      if (this.flight === flight) this.flight = null;
      if (this.rereadQueued && this.workspaceId === ws) {
        this.rereadQueued = false;
        void this.refresh();
      } else if (this.workspaceId !== ws) {
        this.rereadQueued = false;
      }
    }
  }

  private async read(ws: string): Promise<void> {
    let result: ProjectionRead<DesktopInboxSnapshot>;
    try {
      result = await this.gateway.pendingInteractions(ws);
    } catch (error) {
      result = {
        ok: false,
        workspaceId: ws,
        issue: { kind: "rpc", message: error instanceof Error ? error.message : String(error) },
        failedAt: new Date().toISOString(),
      };
    }
    if (this.workspaceId !== ws) return;
    this.model = settleInboxModel(this.model, result);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private loadingModel(ws: string): InboxModel {
    const previous =
      this.model.state === "ready" && this.model.workspaceId === ws
        ? this.model.snapshot
        : this.model.state === "stale" && this.model.workspaceId === ws
          ? this.model.snapshot
          : this.model.state === "loading" && this.model.workspaceId === ws
            ? this.model.previous
            : undefined;
    return { state: "loading", workspaceId: ws, ...(previous ? { previous } : {}) };
  }
}
