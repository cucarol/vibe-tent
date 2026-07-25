/**
 * ServiceGateway + projection boundary for the next renderer.
 *
 * Frozen rules:
 * - Service is the only fact and mutation authority.
 * - Events only invalidate projections; they are never a second truth source.
 * - UI never re-implements claim / delivery / lifecycle state machines.
 */

import type { EventEnvelope } from "../../../service/types.js";
import type { UiIntent } from "../types/intent.js";

/** Opaque projection snapshot — concrete shapes come from Service RPCs later. */
export type ProjectionSnapshot = {
  /** Workspace id the snapshot was fetched for, when known. */
  workspaceId?: string | null;
  /** Wall-clock ISO when the client applied this snapshot. */
  fetchedAt: string;
  /** Free-form projection bags keyed by logical name (docs.tree, node.collaboration, …). */
  bags: Readonly<Record<string, unknown>>;
};

export type ProjectionKey = string;

export type InvalidationHint = {
  /** Logical projection keys that should be re-fetched. */
  keys: readonly ProjectionKey[];
  /** Service event that caused invalidation, if any. */
  event?: EventEnvelope;
  reason?: string;
};

export type ServiceGatewayHandlers = {
  /** Execute a domain-facing intent via Service RPC (never local FS mutation). */
  dispatchIntent?: (intent: UiIntent) => Promise<unknown>;
  /** Fetch one or more projection keys. */
  fetchProjections?: (keys: readonly ProjectionKey[]) => Promise<ProjectionSnapshot>;
  /** Subscribe to Service events; return unsubscribe. */
  subscribeEvents?: (
    onEvent: (event: EventEnvelope) => void
  ) => () => void;
};

/**
 * Maps Service events → invalidation only.
 * Does not interpret payload as authoritative domain state for UI models.
 */
export function invalidationFromEvent(event: EventEnvelope): InvalidationHint {
  const type = event.type;
  // Coarse default mapping — keep open; do not hard-code draft field lists.
  if (type.startsWith("concept.") || type.startsWith("docs.")) {
    return { keys: ["docs.tree", "docs.get"], event, reason: type };
  }
  if (type.startsWith("task.") || type.startsWith("delivery.") || type.startsWith("session.")) {
    // V0.2 collab truth is node.collaboration(s); box.projection remains only as a migration key.
    return {
      keys: ["task.list", "node.collaboration", "node.collaborations", "session.list"],
      event,
      reason: type,
    };
  }
  if (
    type.startsWith("a2a.") ||
    type.startsWith("toolApproval.") ||
    type.startsWith("userAsk.") ||
    type.startsWith("taskInput.")
  ) {
    return { keys: ["pending.interactions"], event, reason: type };
  }
  if (type.startsWith("workspace.") || type === "service.health") {
    return { keys: ["workspace.list", "service.health"], event, reason: type };
  }
  return { keys: ["*"], event, reason: type };
}

/**
 * Client-side gateway: holds the last projection snapshot and applies
 * invalidation. Domain mutation always goes through `dispatchIntent`.
 */
export class ServiceGateway {
  private snapshot: ProjectionSnapshot = {
    fetchedAt: new Date(0).toISOString(),
    bags: {},
  };
  private dirty = new Set<ProjectionKey>(["*"]);
  private unsub: (() => void) | null = null;
  private readonly listeners = new Set<(hint: InvalidationHint) => void>();

  constructor(private readonly handlers: ServiceGatewayHandlers = {}) {}

  getProjectionSnapshot(): ProjectionSnapshot {
    return this.snapshot;
  }

  isDirty(key?: ProjectionKey): boolean {
    if (this.dirty.has("*")) return true;
    if (key === undefined) return this.dirty.size > 0;
    return this.dirty.has(key);
  }

  onInvalidation(listener: (hint: InvalidationHint) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply an event as invalidation only — never merge payload into bags. */
  handleServiceEvent(event: EventEnvelope): InvalidationHint {
    const hint = invalidationFromEvent(event);
    this.applyInvalidation(hint);
    return hint;
  }

  applyInvalidation(hint: InvalidationHint): void {
    for (const key of hint.keys) this.dirty.add(key);
    for (const listener of this.listeners) listener(hint);
  }

  async refresh(keys?: readonly ProjectionKey[]): Promise<ProjectionSnapshot> {
    const target =
      keys ??
      (this.dirty.has("*") ? (["*"] as const) : ([...this.dirty] as ProjectionKey[]));
    if (!this.handlers.fetchProjections) {
      // No transport yet — foundation placeholder keeps empty bags.
      this.snapshot = {
        ...this.snapshot,
        fetchedAt: new Date().toISOString(),
      };
      this.dirty.clear();
      return this.snapshot;
    }
    const next = await this.handlers.fetchProjections(target);
    this.snapshot = next;
    if (target.includes("*")) {
      this.dirty.clear();
    } else {
      for (const key of target) this.dirty.delete(key);
    }
    return this.snapshot;
  }

  async dispatch(intent: UiIntent): Promise<unknown> {
    if (intent.undoPolicy === "layout") {
      // Layout intents never hit Service.
      return undefined;
    }
    if (!this.handlers.dispatchIntent) {
      throw new Error(
        `ServiceGateway: no dispatchIntent handler for ${intent.type} (${intent.undoPolicy})`
      );
    }
    return this.handlers.dispatchIntent(intent);
  }

  startEventBridge(): void {
    this.stopEventBridge();
    if (!this.handlers.subscribeEvents) return;
    this.unsub = this.handlers.subscribeEvents((event) => {
      this.handleServiceEvent(event);
    });
  }

  stopEventBridge(): void {
    this.unsub?.();
    this.unsub = null;
  }
}
