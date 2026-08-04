// Main-process service attach host. Does not stop service when windows close.

import type { ChildProcess } from "node:child_process";
import { attachOrStartService, type AttachResult } from "../client/service-attach.js";
import type { ServiceRpcClient } from "../client/rpc-client.js";
import type { EventEnvelope } from "../../service/types.js";
import {
  isPendingInteractionEventType,
  isTaskProjectionEventType,
} from "../workbench/pending-interactions.js";

export type DesktopServiceEvent = {
  type: string;
  workspaceId: string;
};

export type ServiceEventListener = (ev: DesktopServiceEvent) => void;

/** Events that invalidate desktop-owned snapshots or renderer projections. */
export function isDesktopProjectionEventType(type: string): boolean {
  return (
    type === "node.changed" ||
    type === "workspace.switched" ||
    type === "service.health" ||
    isPendingInteractionEventType(type) ||
    isTaskProjectionEventType(type)
  );
}

export class DesktopServiceHost {
  private attach: AttachResult | null = null;
  private child: ChildProcess | null = null;
  private eventsSub: { close: () => void } | null = null;
  private eventListeners = new Set<ServiceEventListener>();
  /** Coalesce bursty SSE by exact event type + workspace pair. */
  private pendingPairs = new Map<string, DesktopServiceEvent>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  get client(): ServiceRpcClient | null {
    return this.attach?.client ?? null;
  }

  get url(): string | null {
    return this.attach?.url ?? null;
  }

  get startedByUs(): boolean {
    return !!this.attach?.started;
  }

  /** Subscribe to filtered Service invalidations; payload is never merged as state. */
  onServiceEvent(listener: ServiceEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async ensureAttached(options?: {
    dataDir?: string;
    serviceEntry?: string;
    cwd?: string;
  }): Promise<AttachResult> {
    if (this.attach) {
      try {
        await this.attach.client.health();
        this.ensureEventSubscription();
        return this.attach;
      } catch {
        this.teardownEvents();
        this.attach = null;
      }
    }
    const result = await attachOrStartService({
      dataDir: options?.dataDir,
      serviceEntry: options?.serviceEntry,
      env: process.env,
    });
    this.attach = result;
    this.child = result.child;
    this.ensureEventSubscription();
    return result;
  }

  private ensureEventSubscription(): void {
    if (!this.attach?.client || this.eventsSub) return;
    this.eventsSub = this.attach.client.subscribeEvents(
      (ev) => this.handleEnvelope(ev),
      () => {
        // Drop dead stream; next ensureAttached / health path re-subscribes.
        this.teardownEvents();
      }
    );
  }

  private handleEnvelope(ev: EventEnvelope): void {
    const type = ev?.type;
    if (typeof type !== "string" || !type) return;
    if (!isDesktopProjectionEventType(type)) return;
    const workspaceId = typeof ev.workspaceId === "string" ? ev.workspaceId : "";
    const pairKey = `${type}\u0000${workspaceId}`;
    this.pendingPairs.set(pairKey, { type, workspaceId });
    if (this.flushTimer) return;
    // Short debounce so a resolve burst becomes one renderer reload per type set.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = [...this.pendingPairs.values()];
      this.pendingPairs.clear();
      for (const event of batch) {
        for (const listener of this.eventListeners) {
          listener(event);
        }
      }
    }, 50);
  }

  private teardownEvents(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingPairs.clear();
    this.eventsSub?.close();
    this.eventsSub = null;
  }

  /**
   * Intentionally empty of service kill: closing the desktop shell must not stop
   * Local Service or in-flight tasks (architecture §2).
   */
  async disposeShellOnly(): Promise<void> {
    this.teardownEvents();
    this.attach = null;
    // Do not kill this.child — service outlives the UI session.
    this.child = null;
  }
}
