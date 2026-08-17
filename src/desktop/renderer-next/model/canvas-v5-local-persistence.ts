/**
 * Machine-local persistence boundary for the single-scene V5 Canvas.
 *
 * Canvas placement, camera and freehand scene data are presentation state,
 * keyed strictly by the mounted workspace.  None of this is a Service fact.
 * A corrupt payload never becomes a partly-trusted Canvas: callers receive an
 * empty local snapshot plus an explicit error state instead.
 */

import type { ExcalidrawSceneSnapshot } from "../canvas/excalidraw/excalidrawSceneTypes.js";
import {
  DRAWING_PERSISTENCE_MESSAGES,
  classifyStorageError,
  type DrawingPersistenceStatus,
} from "./drawing-persistence-status.js";
import { NODE_CARD } from "./canvas-document.js";
import { createEmptyCanvasDocument, type CanvasDocument } from "../types/identity.js";
import type { StorageLike } from "./canvas-session-store.js";
import {
  reconcileCanvasDocumentSync,
  type CanvasSubtreeNodeSource,
} from "./canvas-subtree-projection.js";

export const CANVAS_V5_LOCAL_PERSISTENCE_PREFIX = "tent.desktop.canvasV5Local.v1";

export type CanvasV5LocalSnapshot = {
  version: 1;
  workspaceId: string;
  document: CanvasDocument;
  scene: ExcalidrawSceneSnapshot | null;
};

export type CanvasV5PersistenceStatus = DrawingPersistenceStatus;

export type CanvasV5LoadResult =
  | {
      kind: "loaded" | "empty";
      snapshot: CanvasV5LocalSnapshot;
      status: Extract<CanvasV5PersistenceStatus, { kind: "ok" }>;
    }
  | {
      kind: "error" | "unavailable";
      snapshot: CanvasV5LocalSnapshot;
      status: Exclude<CanvasV5PersistenceStatus, { kind: "ok" | "pending" }>;
      retry: () => CanvasV5LoadResult;
    };

export type CanvasV5SaveResult =
  | {
      kind: "saved";
      status: Extract<CanvasV5PersistenceStatus, { kind: "ok" }>;
    }
  | {
      kind: "error" | "unavailable";
      status: Exclude<CanvasV5PersistenceStatus, { kind: "ok" | "pending" }>;
      retry: () => CanvasV5SaveResult;
    };

export type CanvasV5PendingSave = {
  kind: "pending";
  status: Extract<CanvasV5PersistenceStatus, { kind: "pending" }>;
  commit: () => CanvasV5SaveResult;
};

export type CanvasV5DocumentSyncTransaction = {
  document: CanvasDocument;
  status: CanvasV5PersistenceStatus | null;
  committed: boolean;
};

/**
 * Pure fail-closed current-Canvas sync transaction. Production supplies the
 * newly read authority; the reconciled document is returned as committed only
 * after its complete local snapshot is durably written.
 */
export function commitCanvasV5DocumentSync(
  persistence: Pick<CanvasV5LocalPersistence, "beginSave">,
  snapshot: CanvasV5LocalSnapshot,
  expectedDigest: string,
  authority: readonly CanvasSubtreeNodeSource[] | null
): CanvasV5DocumentSyncTransaction {
  const nextDocument = reconcileCanvasDocumentSync(
    snapshot.document,
    authority,
    { authorityDigest: expectedDigest }
  );
  if (nextDocument === snapshot.document) {
    return { document: snapshot.document, status: null, committed: false };
  }
  const result = persistence.beginSave({ ...snapshot, document: nextDocument }).commit();
  return result.kind === "saved"
    ? { document: nextDocument, status: result.status, committed: true }
    : { document: snapshot.document, status: result.status, committed: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validDocument(value: unknown): value is CanvasDocument {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.placements)) {
    return false;
  }
  if (value.backgroundMode !== undefined && value.backgroundMode !== "grid" && value.backgroundMode !== "blank") {
    return false;
  }
  if (
    value.focusedPlacementId !== undefined &&
    value.focusedPlacementId !== null &&
    (typeof value.focusedPlacementId !== "string" || !value.focusedPlacementId)
  ) {
    return false;
  }
  if (value.viewport !== undefined) {
    if (!isRecord(value.viewport) || !isFiniteNumber(value.viewport.x) || !isFiniteNumber(value.viewport.y) || !isFiniteNumber(value.viewport.zoom) || value.viewport.zoom <= 0) {
      return false;
    }
  }
  return value.placements.every((placement) => {
    if (!isRecord(placement) || typeof placement.placementId !== "string" || !placement.placementId || typeof placement.kind !== "string" || !placement.kind) {
      return false;
    }
    for (const field of ["x", "y", "width", "height", "zIndex"] as const) {
      if (placement[field] !== undefined && !isFiniteNumber(placement[field])) return false;
    }
    return placement.entityRef === undefined || typeof placement.entityRef === "string";
  });
}

function validScene(value: unknown): value is ExcalidrawSceneSnapshot {
  if (!isRecord(value) || !Array.isArray(value.elements)) return false;
  return (
    (value.appState === undefined || isRecord(value.appState)) &&
    (value.files === undefined || isRecord(value.files)) &&
    (value.layerVisible === undefined || typeof value.layerVisible === "boolean")
  );
}

function normalizePersistedCanvasDocument(document: CanvasDocument): CanvasDocument {
  let changed = document.backgroundMode !== "blank";
  const placements = document.placements.map((placement) => {
    if (
      placement.kind !== "node" ||
      (placement.width === NODE_CARD.width && placement.height === NODE_CARD.height)
    ) {
      return placement;
    }
    changed = true;
    return {
      ...placement,
      width: NODE_CARD.width,
      height: NODE_CARD.height,
    };
  });
  return changed
    ? { ...document, backgroundMode: "blank", placements }
    : document;
}

function emptySnapshot(workspaceId: string): CanvasV5LocalSnapshot {
  return {
    version: 1,
    workspaceId,
    document: createEmptyCanvasDocument(),
    scene: null,
  };
}

function invalidPayloadStatus(): Exclude<CanvasV5PersistenceStatus, { kind: "ok" | "pending" }> {
  return {
    kind: "error",
    message: DRAWING_PERSISTENCE_MESSAGES.corruptMetadata,
    retryable: true,
    code: "CANVAS_V5_LOCAL_CORRUPT",
  };
}

function storageFailureStatus(
  error: unknown
): Exclude<CanvasV5PersistenceStatus, { kind: "ok" | "pending" }> {
  const status = classifyStorageError(error);
  // classifyStorageError currently cannot produce ok, but keep this adapter
  // fail-closed if that shared helper ever grows another branch.
  return status.kind === "ok" || status.kind === "pending"
    ? invalidPayloadStatus()
    : status;
}

export function canvasV5LocalPersistenceKey(workspaceId: string): string {
  return `${CANVAS_V5_LOCAL_PERSISTENCE_PREFIX}:${workspaceId}`;
}

/**
 * Storage adapter deliberately owns no React state.  Its pending result lets a
 * surface render an honest saving state before committing the synchronous
 * localStorage write, while error results carry an exact retry closure.
 */
export class CanvasV5LocalPersistence {
  constructor(
    private readonly storage: StorageLike | null | undefined,
    readonly workspaceId: string
  ) {}

  load(): CanvasV5LoadResult {
    const fallback = emptySnapshot(this.workspaceId);
    if (!this.storage || !this.workspaceId) {
      const status: Exclude<CanvasV5PersistenceStatus, { kind: "ok" | "pending" }> = {
        kind: "unavailable",
        message: DRAWING_PERSISTENCE_MESSAGES.storageUnavailable,
        retryable: true,
      };
      return { kind: "unavailable", snapshot: fallback, status, retry: () => this.load() };
    }
    try {
      const raw = this.storage.getItem(canvasV5LocalPersistenceKey(this.workspaceId));
      if (!raw) return { kind: "empty", snapshot: fallback, status: { kind: "ok" } };
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.version !== 1 || parsed.workspaceId !== this.workspaceId || !validDocument(parsed.document) || (parsed.scene !== null && !validScene(parsed.scene))) {
        const status = invalidPayloadStatus();
        return { kind: "error", snapshot: fallback, status, retry: () => this.load() };
      }
      return {
        kind: "loaded",
        snapshot: {
          version: 1,
          workspaceId: this.workspaceId,
          document: normalizePersistedCanvasDocument(parsed.document),
          scene: parsed.scene,
        },
        status: { kind: "ok" },
      };
    } catch (error) {
      const status = storageFailureStatus(error);
      return { kind: "error", snapshot: fallback, status, retry: () => this.load() };
    }
  }

  beginSave(snapshot: CanvasV5LocalSnapshot): CanvasV5PendingSave {
    return {
      kind: "pending",
      status: { kind: "pending", message: "正在保存本地画布…", retryable: false },
      commit: () => this.save(snapshot),
    };
  }

  save(snapshot: CanvasV5LocalSnapshot): CanvasV5SaveResult {
    if (!this.storage || !this.workspaceId) {
      const status: Exclude<CanvasV5PersistenceStatus, { kind: "ok" | "pending" }> = {
        kind: "unavailable",
        message: DRAWING_PERSISTENCE_MESSAGES.storageUnavailable,
        retryable: true,
      };
      return { kind: "unavailable", status, retry: () => this.save(snapshot) };
    }
    if (
      snapshot.version !== 1 ||
      snapshot.workspaceId !== this.workspaceId ||
      !validDocument(snapshot.document) ||
      (snapshot.scene !== null && !validScene(snapshot.scene))
    ) {
      const status = invalidPayloadStatus();
      return { kind: "error", status, retry: () => this.save(snapshot) };
    }
    try {
      this.storage.setItem(
        canvasV5LocalPersistenceKey(this.workspaceId),
        JSON.stringify({
          ...snapshot,
          document: normalizePersistedCanvasDocument(snapshot.document),
        })
      );
      return { kind: "saved", status: { kind: "ok" } };
    } catch (error) {
      const status = storageFailureStatus(error);
      return { kind: "error", status, retry: () => this.save(snapshot) };
    }
  }
}
