import type { GraphProjection } from "../../../service/types.js";
import type { ProjectionRead } from "./workspace-projections.js";
import {
  commitCanvasV5DocumentSync,
  type CanvasV5DocumentSyncTransaction,
  type CanvasV5LocalPersistence,
  type CanvasV5LocalSnapshot,
} from "../model/canvas-v5-local-persistence.js";
import { canvasSubtreeSourcesFromGraph } from "../model/workbench-nodes.js";

export type CanvasSyncCommandDependencies = {
  workspaceId: string;
  currentWorkspaceId: () => string | null;
  online: () => boolean;
  readGraphProjection: (
    workspaceId: string
  ) => Promise<ProjectionRead<GraphProjection>>;
  currentSnapshot: () => CanvasV5LocalSnapshot;
  persistence: Pick<CanvasV5LocalPersistence, "beginSave">;
};

export type CanvasSyncCommand = {
  execute: (expectedAuthorityDigest: string) => Promise<CanvasV5DocumentSyncTransaction>;
};

function unchanged(
  snapshot: CanvasV5LocalSnapshot
): CanvasV5DocumentSyncTransaction {
  return { document: snapshot.document, status: null, committed: false };
}

/**
 * Production mutation boundary for global Canvas sync. The command performs
 * one authoritative graph read, rechecks exact workspace/connection identity,
 * then lets the pure reconciliation+persistence helper commit atomically.
 */
export function createCanvasSyncCommand(
  dependencies: CanvasSyncCommandDependencies
): CanvasSyncCommand {
  let inFlight: Promise<CanvasV5DocumentSyncTransaction> | null = null;

  const run = async (
    expectedAuthorityDigest: string
  ): Promise<CanvasV5DocumentSyncTransaction> => {
    const workspaceId = dependencies.workspaceId;
    const startingSnapshot = dependencies.currentSnapshot();
    if (
      startingSnapshot.workspaceId !== workspaceId ||
      !dependencies.online() ||
      dependencies.currentWorkspaceId() !== workspaceId
    ) {
      return unchanged(startingSnapshot);
    }

    let read: ProjectionRead<GraphProjection>;
    try {
      read = await dependencies.readGraphProjection(workspaceId);
    } catch {
      return unchanged(dependencies.currentSnapshot());
    }
    const latestSnapshot = dependencies.currentSnapshot();
    if (
      !read.ok ||
      read.workspaceId !== workspaceId ||
      read.value.workspaceId !== workspaceId ||
      latestSnapshot.workspaceId !== workspaceId ||
      latestSnapshot.document !== startingSnapshot.document ||
      !dependencies.online() ||
      dependencies.currentWorkspaceId() !== workspaceId
    ) {
      return unchanged(latestSnapshot);
    }

    return commitCanvasV5DocumentSync(
      dependencies.persistence,
      latestSnapshot,
      expectedAuthorityDigest,
      canvasSubtreeSourcesFromGraph(read.value)
    );
  };

  return {
    execute(expectedAuthorityDigest) {
      if (inFlight) return inFlight;
      const current = run(expectedAuthorityDigest);
      inFlight = current;
      const clear = () => {
        if (inFlight === current) inFlight = null;
      };
      void current.then(clear, clear);
      return current;
    },
  };
}
