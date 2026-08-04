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
import {
  PROJECTION_TIMEOUT_MS,
  readGraphProjection,
  readNodeCollaboration,
  readNodeCollaborations,
  readOutputProvenance,
  type ProjectionRead,
  type Protocol4ProjectionRpc,
} from "./protocol4-projections.js";
import type {
  GraphProjection,
  NodeCollaboration,
  NodeCollaborationsResult,
  OutputProvenance,
} from "../../../service/types.js";
import {
  readFocusBacklinks,
  readFocusDocument,
  writeFocusDocumentBody,
  type DocumentRead,
  type DocumentTransport,
  type FocusBacklinks,
  type FocusDocumentSnapshot,
  type FocusDocumentWrite,
} from "./document-protocol.js";

export type ProjectionKey = string;

export type InvalidationHint = {
  /** Logical projection keys that should be re-fetched. */
  keys: readonly ProjectionKey[];
  /** Service event that caused invalidation, if any. */
  event?: EventEnvelope;
  reason?: string;
};

export type ServiceGatewayHandlers = {
  /** Closed protocol-4 read transport for the main Canvas surface. */
  projectionRpc?: Protocol4ProjectionRpc;
  /** Bounded renderer wait; the underlying IPC may continue after UI timeout. */
  projectionTimeoutMs?: number;
  /** Structured document transport preserves JSON-RPC code/data across Electron. */
  documentTransport?: DocumentTransport;
  documentTimeoutMs?: number;
  /** Execute a domain-facing intent via Service RPC (never local FS mutation). */
  dispatchIntent?: (intent: UiIntent) => Promise<unknown>;
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
  if (type.startsWith("node.") || type.startsWith("docs.")) {
    return {
      keys: [
        "docs.tree",
        "docs.get",
        "docs.focus",
        "graph.projection",
        "node.collaboration",
        "node.collaborations",
        "output.provenance",
      ],
      event,
      reason: type,
    };
  }
  if (type.startsWith("task.") || type.startsWith("delivery.") || type.startsWith("session.")) {
    return {
      keys: [
        "task.list",
        "node.collaboration",
        "node.collaborations",
        "output.provenance",
        "session.list",
      ],
      event,
      reason: type,
    };
  }
  if (
    type.startsWith("toolApproval.") ||
    type.startsWith("decisionRequest.") ||
    type.startsWith("taskInput.")
  ) {
    return { keys: ["pending.interactions"], event, reason: type };
  }
  if (
    type.startsWith("workspace.") ||
    type === "service.health" ||
    type === "service.disconnected"
  ) {
    return { keys: ["workspace.list", "service.health"], event, reason: type };
  }
  return { keys: ["*"], event, reason: type };
}

/**
 * Client-side gateway for named protocol-4 reads and invalidation listeners.
 * It deliberately owns no second projection cache or opaque bags.
 */
export class ServiceGateway {
  private unsub: (() => void) | null = null;
  private readonly listeners = new Set<(hint: InvalidationHint) => void>();

  constructor(private readonly handlers: ServiceGatewayHandlers = {}) {}

  onInvalidation(listener: (hint: InvalidationHint) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply an event as invalidation only — never merge payload into UI state. */
  handleServiceEvent(event: EventEnvelope): InvalidationHint {
    const hint = invalidationFromEvent(event);
    this.applyInvalidation(hint);
    return hint;
  }

  applyInvalidation(hint: InvalidationHint): void {
    for (const listener of this.listeners) listener(hint);
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

  graphProjection(workspaceId: string): Promise<ProjectionRead<GraphProjection>> {
    if (!this.handlers.projectionRpc) {
      return Promise.resolve(this.missingProjectionTransport(workspaceId));
    }
    return readGraphProjection(
      this.handlers.projectionRpc,
      workspaceId,
      this.handlers.projectionTimeoutMs ?? PROJECTION_TIMEOUT_MS
    );
  }

  nodeCollaborations(
    workspaceId: string,
    nodeIds: readonly string[]
  ): Promise<ProjectionRead<NodeCollaborationsResult>> {
    if (!this.handlers.projectionRpc) {
      return Promise.resolve(this.missingProjectionTransport(workspaceId));
    }
    return readNodeCollaborations(
      this.handlers.projectionRpc,
      workspaceId,
      nodeIds,
      this.handlers.projectionTimeoutMs ?? PROJECTION_TIMEOUT_MS
    );
  }

  nodeCollaboration(
    workspaceId: string,
    nodeId: string
  ): Promise<ProjectionRead<NodeCollaboration>> {
    if (!this.handlers.projectionRpc) {
      return Promise.resolve(this.missingProjectionTransport(workspaceId));
    }
    return readNodeCollaboration(
      this.handlers.projectionRpc,
      workspaceId,
      nodeId,
      this.handlers.projectionTimeoutMs ?? PROJECTION_TIMEOUT_MS
    );
  }

  outputProvenance(
    workspaceId: string,
    outputId: string
  ): Promise<ProjectionRead<OutputProvenance>> {
    if (!this.handlers.projectionRpc) {
      return Promise.resolve(this.missingProjectionTransport(workspaceId));
    }
    return readOutputProvenance(
      this.handlers.projectionRpc,
      workspaceId,
      outputId,
      this.handlers.projectionTimeoutMs ?? PROJECTION_TIMEOUT_MS
    );
  }

  focusDocument(
    workspaceId: string,
    nodeId: string
  ): Promise<DocumentRead<FocusDocumentSnapshot>> {
    if (!this.handlers.documentTransport) {
      return Promise.resolve(this.missingDocumentTransport(workspaceId, nodeId));
    }
    return readFocusDocument(
      this.handlers.documentTransport,
      workspaceId,
      nodeId,
      this.handlers.documentTimeoutMs
    );
  }

  focusBacklinks(
    workspaceId: string,
    nodeId: string
  ): Promise<DocumentRead<FocusBacklinks>> {
    if (!this.handlers.documentTransport) {
      return Promise.resolve(this.missingDocumentTransport(workspaceId, nodeId));
    }
    return readFocusBacklinks(
      this.handlers.documentTransport,
      workspaceId,
      nodeId,
      this.handlers.documentTimeoutMs
    );
  }

  writeFocusDocumentBody(
    workspaceId: string,
    nodeId: string,
    body: string,
    baseEtag: string
  ): Promise<DocumentRead<FocusDocumentWrite>> {
    if (!this.handlers.documentTransport) {
      return Promise.resolve(this.missingDocumentTransport(workspaceId, nodeId));
    }
    return writeFocusDocumentBody(
      this.handlers.documentTransport,
      workspaceId,
      nodeId,
      body,
      baseEtag,
      this.handlers.documentTimeoutMs
    );
  }

  private missingProjectionTransport<T>(workspaceId: string): ProjectionRead<T> {
    return {
      ok: false,
      workspaceId,
      issue: {
        kind: "transport",
        message: "ServiceGateway: protocol-4 projection transport is unavailable",
      },
      failedAt: new Date().toISOString(),
    };
  }

  private missingDocumentTransport<T>(workspaceId: string, nodeId: string): DocumentRead<T> {
    return {
      ok: false,
      workspaceId,
      nodeId,
      issue: {
        kind: "transport",
        message: "ServiceGateway: document transport is unavailable",
      },
      failedAt: new Date().toISOString(),
    };
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
