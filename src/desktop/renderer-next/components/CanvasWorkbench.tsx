import { useMemo, useState } from "react";
import { CanvasV5Host } from "../canvas/excalidraw/CanvasV5Host.js";
import type { CanvasNodeResolvers } from "../canvas/excalidraw/documentToExcalidraw.js";
import { defaultEdgeLayers, toggleEdgeLayer, type CanvasEdgeLayerVisibility, type GraphEdgeSource } from "../model/canvas-edges.js";
import type { CanvasDocument } from "../types/identity.js";
import { IconButton } from "../ui/index.js";
import { ShellIcon } from "../shell/icons.js";
import { nodeTitle, nodeTypeLabel, type WorkbenchNodeView } from "../shell/workbench-types.js";

export type CanvasWorkbenchProps = {
  document: CanvasDocument;
  nodes: readonly WorkbenchNodeView[];
  graph?: GraphEdgeSource;
  immersive: boolean;
  onImmersiveChange: (immersive: boolean) => void;
  onDocumentChange: (document: CanvasDocument) => void;
  onSelectNode: (nodeId: string | null, placementId?: string | null) => void;
};

export function CanvasWorkbench({ document, nodes, graph = null, immersive, onImmersiveChange, onDocumentChange, onSelectNode }: CanvasWorkbenchProps) {
  const [drawingVisible, setDrawingVisible] = useState(true);
  const [edgeLayers, setEdgeLayers] = useState<CanvasEdgeLayerVisibility>(() => defaultEdgeLayers());
  const byId = useMemo(() => new Map(nodes.map((node) => [node.nodeId, node] as const)), [nodes]);
  const resolvers = useMemo<CanvasNodeResolvers>(() => ({
    resolveLabel: (entityRef) => {
      const node = byId.get(entityRef);
      return node ? nodeTitle(node) : undefined;
    },
    resolveType: (entityRef) => {
      const node = byId.get(entityRef);
      return node && (!node.projectionState || node.projectionState === "ready")
        ? nodeTypeLabel(node.type)
        : "节点";
    },
    resolveGhost: (entityRef) => {
      const state = byId.get(entityRef)?.projectionState;
      return !byId.has(entityRef) || state === "unresolved";
    },
    resolveError: (entityRef) => byId.get(entityRef)?.projectionState === "error",
    resolvePendingRecovery: (entityRef) => byId.get(entityRef)?.projectionState === "stale",
    resolveActiveTaskState: (entityRef) => {
      const node = byId.get(entityRef);
      if (!node || (node.projectionState && node.projectionState !== "ready")) return undefined;
      return node.activeTaskState ?? null;
    },
    resolveSummary: (entityRef) => {
      const node = byId.get(entityRef);
      return node && (!node.projectionState || node.projectionState === "ready")
        ? { type: node.type, tags: node.tags, path: node.path }
        : undefined;
    },
  }), [byId]);

  return (
    <section className="tn-canvas-pane" aria-label="画布" data-region="canvas">
      {!immersive ? (
        <div className="tn-canvas-tabbar">
          <div className="tn-canvas-tabs" role="tablist" aria-label="画布标签">
            <button type="button" role="tab" aria-selected="true" className="tn-canvas-tab"><ShellIcon name="canvas" /><span>工作集</span></button>
          </div>
          <div className="tn-canvas-tools">
            <IconButton aria-label="进入沉浸画布" variant="ghost" onClick={() => onImmersiveChange(true)}><ShellIcon name="focus" /></IconButton>
          </div>
        </div>
      ) : null}
      <div className="tn-canvas-host">
        <CanvasV5Host
          document={document}
          onDocumentChange={onDocumentChange}
          onSelectPlacement={(placementId, entityRef) => onSelectNode(entityRef, placementId)}
          resolvers={resolvers}
          graph={graph}
          edgeLayers={edgeLayers}
          onToggleEdgeLayer={(layer) => setEdgeLayers((current) => toggleEdgeLayer(current, layer))}
          layerVisible={drawingVisible}
          onLayerVisibleChange={setDrawingVisible}
          persistenceStatus={{ kind: "ok" }}
          immersive={immersive}
          onImmersiveChange={onImmersiveChange}
        />
      </div>
    </section>
  );
}
