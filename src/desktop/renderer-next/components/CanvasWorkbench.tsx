import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { CanvasV5Host } from "../canvas/excalidraw/CanvasV5Host.js";
import type { CanvasNodeResolvers } from "../canvas/excalidraw/documentToExcalidraw.js";
import type { CanvasDocument } from "../types/identity.js";
import type { WorkbenchNodeView } from "../shell/workbench-types.js";
import type { DrawingPersistenceStatus } from "../model/drawing-persistence-status.js";
import type { ExcalidrawSceneSnapshot } from "../canvas/excalidraw/excalidrawSceneTypes.js";
import { clientPointToCanvasNodeOrigin } from "../model/canvas-session-store.js";
import { captureCanvasNodeSnapshot } from "../model/canvas-node-snapshot.js";
import {
  TENT_NODE_IDS_DRAG_TYPE,
  decodeNodeIdsDrag,
} from "../../task-package-draft.js";
import {
  deriveCanvasSubtreeProjection,
  reconcileCanvasDocumentSync,
  toggleCanvasSubtreeBranch,
  type CanvasSubtreeNodeSource,
  type SubtreeDirection,
} from "../model/canvas-subtree-projection.js";
import {
  completeCanvasDrop,
  enterCanvasDropTarget,
  IDLE_CANVAS_DROP_FEEDBACK,
  leaveCanvasDropTarget,
} from "../model/canvas-drop-feedback.js";
import { NODE_CARD } from "../model/canvas-document.js";

export type CanvasWorkbenchProps = {
  document: CanvasDocument;
  nodes: readonly WorkbenchNodeView[];
  projection: "loading" | "fresh" | "stale" | "unresolved" | "error" | "unmounted";
  immersive: boolean;
  onImmersiveChange: (immersive: boolean) => void;
  onDocumentChange: (document: CanvasDocument) => void;
  onSelectNode: (nodeId: string | null, placementId?: string | null, toggle?: boolean) => void;
  initialScene?: ExcalidrawSceneSnapshot | null;
  persistenceStatus?: DrawingPersistenceStatus;
  onRetryPersistence?: () => void;
  onScenePersist?: (scene: ExcalidrawSceneSnapshot) => void;
  onDropNodes?: (nodeIds: readonly string[], point: { x: number; y: number }) => boolean;
  previewDocument?: {
    nodeId: string;
    status?: "loading" | "ready" | "error";
    body?: string;
  } | null;
  onPreviewNode?: (nodeId: string | null) => void;
  attentionPlacementIds?: ReadonlySet<string>;
  onCanvasSync?: (
    authorityDigest: string
  ) => CanvasDocument | null | Promise<CanvasDocument | null>;
  hidden?: boolean;
};

export function CanvasWorkbench({ document, nodes, projection, immersive, onImmersiveChange, onDocumentChange, onSelectNode, initialScene = null, persistenceStatus = { kind: "ok" }, onRetryPersistence, onScenePersist, onDropNodes, previewDocument = null, onPreviewNode, attentionPlacementIds = new Set(), onCanvasSync, hidden = false }: CanvasWorkbenchProps) {
  const [drawingVisible, setDrawingVisible] = useState(
    () => initialScene?.layerVisible ?? true
  );
  const [dropFeedback, setDropFeedback] = useState(IDLE_CANVAS_DROP_FEEDBACK);
  const successTimerRef = useRef<number | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const dropPreviewRef = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.nodeId, node] as const)), [nodes]);
  const resolvers = useMemo<CanvasNodeResolvers>(() => ({
    resolveGhost: (entityRef) => {
      const state = byId.get(entityRef)?.projectionState;
      return projection === "fresh" && (!byId.has(entityRef) || state === "unresolved");
    },
    resolveError: (entityRef) =>
      projection === "error" || byId.get(entityRef)?.projectionState === "error",
    resolvePendingRecovery: (entityRef) => {
      const state = byId.get(entityRef)?.projectionState;
      return projection === "loading" || projection === "stale" ||
        projection === "unmounted" || state === "loading" || state === "stale";
    },
    resolveCurrent: (entityRef) => {
      const node = byId.get(entityRef);
      return node && (!node.projectionState || node.projectionState === "ready")
          ? {
            nodeId: node.nodeId,
            etag: node.etag,
            name: node.name,
            ...(node.title ? { title: node.title } : {}),
            path: node.path,
            type: node.type,
            tags: node.tags,
            mode: node.mode,
            archived: node.archived,
            invalid: node.invalid,
          }
        : undefined;
    },
  }), [byId, projection]);
  const subtreeSources = useMemo<readonly CanvasSubtreeNodeSource[] | null>(() => {
    if (
      projection !== "fresh" ||
      nodes.some((node) => node.projectionState !== undefined && node.projectionState !== "ready")
    ) return null;
    return nodes.map((node) => ({
      nodeId: node.nodeId,
      parentNodeId: node.parentNodeId,
      snapshot: {
        ...captureCanvasNodeSnapshot({
          nodeId: node.nodeId,
          etag: node.etag,
          name: node.name,
          ...(node.title?.trim() ? { title: node.title } : {}),
          path: node.path,
          type: node.type,
          tags: node.tags,
          mode: node.mode,
          archived: node.archived,
          invalid: node.invalid,
        }),
        etag: node.etag,
      },
    }));
  }, [nodes, projection]);
  const subtreeProjection = useMemo(
    () => deriveCanvasSubtreeProjection(document, subtreeSources),
    [document, subtreeSources]
  );

  const handleSubtreeDirection = (placementId: string, direction: SubtreeDirection) => {
    const control = subtreeProjection.controls.find((candidate) => candidate.placementId === placementId);
    if (!control?.canMutate) return;
    onDocumentChange(toggleCanvasSubtreeBranch(document, placementId, direction));
  };

  const handleProjectionSync = (authorityDigest: string) => {
    if (!subtreeProjection.documentSync?.canSync) return null;
    return onCanvasSync?.(authorityDigest) ?? reconcileCanvasDocumentSync(
      document,
      subtreeSources,
      { authorityDigest }
    );
  };

  const hasNodeDrag = (event: DragEvent) =>
    Array.from(event.dataTransfer.types).includes(TENT_NODE_IDS_DRAG_TYPE);

  const cancelSuccessTimer = () => {
    if (successTimerRef.current !== null) {
      window.clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
  };

  useEffect(() => () => cancelSuccessTimer(), []);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!onDropNodes || !hasNodeDrag(event)) return;
    const nodeIds = decodeNodeIdsDrag(event.dataTransfer.getData(TENT_NODE_IDS_DRAG_TYPE));
    const rect = hostRef.current?.getBoundingClientRect();
    if (!nodeIds.length || !rect) return;
    event.preventDefault();
    const point = clientPointToCanvasNodeOrigin(
      { x: event.clientX, y: event.clientY },
      rect,
      document.viewport
    );
    const accepted = onDropNodes(nodeIds, point);
    setDropFeedback(completeCanvasDrop(accepted));
    cancelSuccessTimer();
    if (accepted) {
      successTimerRef.current = window.setTimeout(() => {
        successTimerRef.current = null;
        setDropFeedback(IDLE_CANVAS_DROP_FEEDBACK);
      }, 1400);
    }
  };

  return (
    <section className="tn-canvas-pane" aria-label="画布" data-region="canvas" hidden={hidden}>
      <div
        ref={hostRef}
        className="tn-canvas-host"
        data-drop-state={dropFeedback.phase}
        onDragEnter={(event) => {
          if (!onDropNodes || !hasNodeDrag(event)) return;
          event.preventDefault();
          cancelSuccessTimer();
          setDropFeedback(enterCanvasDropTarget);
        }}
        onDragOver={(event) => {
          if (!onDropNodes || !hasNodeDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          const rect = hostRef.current?.getBoundingClientRect();
          const preview = dropPreviewRef.current;
          if (rect && preview) {
            preview.style.left = `${event.clientX - rect.left - NODE_CARD.width / 2}px`;
            preview.style.top = `${event.clientY - rect.top - NODE_CARD.height / 2}px`;
          }
        }}
        onDragLeave={(event) => {
          if (!onDropNodes || !hasNodeDrag(event)) return;
          setDropFeedback(leaveCanvasDropTarget);
        }}
        onDrop={handleDrop}
      >
        {hidden ? null : (
          <CanvasV5Host
            document={document}
            onDocumentChange={onDocumentChange}
            onSelectPlacement={(placementId, entityRef, toggle) => onSelectNode(entityRef, placementId, toggle)}
            resolvers={resolvers}
            graph={null}
            subtreeProjection={subtreeProjection}
            onSubtreeDirection={handleSubtreeDirection}
            onProjectionSync={handleProjectionSync}
            edgeLayers={{ parent: true, markdown: false, wiki: false, relation: false }}
            layerVisible={drawingVisible}
            onLayerVisibleChange={setDrawingVisible}
            initialScene={initialScene}
            persistenceStatus={persistenceStatus}
            onRetryPersistence={onRetryPersistence}
            onScenePersist={onScenePersist ? (scene) => onScenePersist(scene) : undefined}
            immersive={immersive}
            onImmersiveChange={onImmersiveChange}
            previewDocument={previewDocument}
            onPreviewNode={onPreviewNode}
            attentionPlacementIds={attentionPlacementIds}
          />
        )}
        <div
          ref={dropPreviewRef}
          className="tn-canvas-drop-preview"
          style={{ width: NODE_CARD.width, height: NODE_CARD.height }}
          aria-hidden="true"
        />
        <div
          className="tn-canvas-drop-feedback"
          data-state={dropFeedback.phase}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {dropFeedback.phase === "target"
            ? "松开以创建本地画布快照"
            : dropFeedback.phase === "success"
              ? "已放入画布"
              : ""}
        </div>
      </div>
    </section>
  );
}
