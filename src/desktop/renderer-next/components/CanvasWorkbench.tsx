import { useMemo, useRef, useState, type DragEvent } from "react";
import { CanvasV5Host } from "../canvas/excalidraw/CanvasV5Host.js";
import type { CanvasNodeResolvers } from "../canvas/excalidraw/documentToExcalidraw.js";
import { defaultEdgeLayers } from "../model/canvas-edges.js";
import type { CanvasDocument } from "../types/identity.js";
import { IconButton } from "../ui/index.js";
import { ShellIcon } from "../shell/icons.js";
import type { WorkbenchNodeView } from "../shell/workbench-types.js";
import type { DrawingPersistenceStatus } from "../model/drawing-persistence-status.js";
import type { ExcalidrawSceneSnapshot } from "../canvas/excalidraw/excalidrawSceneTypes.js";
import { clientPointToCanvasOrigin } from "../model/canvas-session-store.js";
import { OUTLINE_NODE_DRAG_TYPE } from "../model/canvas-node-snapshot.js";

export type CanvasWorkbenchProps = {
  document: CanvasDocument;
  nodes: readonly WorkbenchNodeView[];
  projection: "loading" | "fresh" | "stale" | "unresolved" | "error" | "unmounted";
  immersive: boolean;
  onImmersiveChange: (immersive: boolean) => void;
  onDocumentChange: (document: CanvasDocument) => void;
  onSelectNode: (nodeId: string | null, placementId?: string | null) => void;
  initialScene?: ExcalidrawSceneSnapshot | null;
  persistenceStatus?: DrawingPersistenceStatus;
  onRetryPersistence?: () => void;
  onScenePersist?: (scene: ExcalidrawSceneSnapshot) => void;
  onDropNode?: (nodeId: string, point: { x: number; y: number }) => void;
  hidden?: boolean;
};

export function CanvasWorkbench({ document, nodes, projection, immersive, onImmersiveChange, onDocumentChange, onSelectNode, initialScene = null, persistenceStatus = { kind: "ok" }, onRetryPersistence, onScenePersist, onDropNode, hidden = false }: CanvasWorkbenchProps) {
  const [drawingVisible, setDrawingVisible] = useState(
    () => initialScene?.layerVisible ?? true
  );
  const hostRef = useRef<HTMLDivElement>(null);
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

  const hasNodeDrag = (event: DragEvent) =>
    Array.from(event.dataTransfer.types).includes(OUTLINE_NODE_DRAG_TYPE);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!onDropNode || !hasNodeDrag(event)) return;
    const nodeId = event.dataTransfer.getData(OUTLINE_NODE_DRAG_TYPE);
    const rect = hostRef.current?.getBoundingClientRect();
    if (!nodeId || !rect) return;
    event.preventDefault();
    const point = clientPointToCanvasOrigin(
      { x: event.clientX, y: event.clientY },
      rect,
      document.viewport
    );
    onDropNode(nodeId, point);
  };

  return (
    <section className="tn-canvas-pane" aria-label="画布" data-region="canvas" hidden={hidden}>
      {!immersive ? (
        <div className="tn-canvas-tabbar">
          <div className="tn-canvas-tabs" aria-label="当前画布">
            <span className="tn-canvas-tab" aria-current="page"><ShellIcon name="canvas" /><span>工作集</span></span>
          </div>
          <div className="tn-canvas-tools">
            <IconButton size="compact" aria-label="进入沉浸画布" tooltip="进入沉浸画布" variant="ghost" onClick={() => onImmersiveChange(true)}><ShellIcon name="focus" /></IconButton>
          </div>
        </div>
      ) : null}
      <div
        ref={hostRef}
        className="tn-canvas-host"
        onDragOver={(event) => {
          if (!onDropNode || !hasNodeDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={handleDrop}
      >
        {hidden ? null : (
          <CanvasV5Host
            document={document}
            onDocumentChange={onDocumentChange}
            onSelectPlacement={(placementId, entityRef) => onSelectNode(entityRef, placementId)}
            resolvers={resolvers}
            graph={null}
            edgeLayers={defaultEdgeLayers()}
            layerVisible={drawingVisible}
            onLayerVisibleChange={setDrawingVisible}
            initialScene={initialScene}
            persistenceStatus={persistenceStatus}
            onRetryPersistence={onRetryPersistence}
            onScenePersist={onScenePersist ? (scene) => onScenePersist(scene) : undefined}
            immersive={immersive}
            onImmersiveChange={onImmersiveChange}
          />
        )}
      </div>
    </section>
  );
}
