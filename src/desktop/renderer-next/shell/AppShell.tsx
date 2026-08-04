import { useMemo, useRef, useState } from "react";
import type { GraphEdgeSource } from "../model/canvas-edges.js";
import { createEmptyCanvasDocument, type CanvasDocument } from "../types/identity.js";
import {
  findPlacementsByEntity,
} from "../model/canvas-document.js";
import { IconButton } from "../ui/index.js";
import { CanvasWorkbench } from "../components/CanvasWorkbench.js";
import { InspectorPanel } from "../components/InspectorPanel.js";
import { OutlinePanel } from "../components/OutlinePanel.js";
import { StatusBar } from "../components/StatusBar.js";
import { ConnectionBanner } from "../components/ConnectionBanner.js";
import { ShellIcon } from "./icons.js";
import type { WorkbenchNodeView } from "./workbench-types.js";
import {
  canCreateNodePlacement,
  placePresentationNode,
  removeFocusedPresentationPlacement,
  selectPresentationNode,
  withPresentationDocument,
  type WorkbenchPresentationUpdate,
} from "./workbench-presentation.js";
import type { DrawingPersistenceStatus } from "../model/drawing-persistence-status.js";
import type { ExcalidrawSceneSnapshot } from "../canvas/excalidraw/excalidrawSceneTypes.js";
import type {
  FocusDocumentActions,
  FocusDocumentView,
} from "../model/focus-document-controller.js";
import type {
  CollaborationSurfaceActions,
  CollaborationSurfaceView,
} from "../model/collaboration-surface-controller.js";

export type AppShellProps = {
  workspaceId?: string | null;
  workspaceLabel?: string;
  initialNodes?: readonly WorkbenchNodeView[];
  document?: CanvasDocument;
  selectedNodeId?: string | null;
  graph?: GraphEdgeSource;
  connection?: "connecting" | "online" | "offline" | "reconnecting";
  projectionState?: "loading" | "fresh" | "stale" | "unresolved" | "error" | "unmounted";
  onRetryConnection?: () => void;
  initialScene?: ExcalidrawSceneSnapshot | null;
  persistenceStatus?: DrawingPersistenceStatus;
  onRetryPersistence?: () => void;
  onPresentationChange?: (update: WorkbenchPresentationUpdate) => void;
  onScenePersist?: (scene: ExcalidrawSceneSnapshot) => void;
  focusDocument?: FocusDocumentView;
  focusDocumentActions?: FocusDocumentActions;
  collaboration?: CollaborationSurfaceView;
  collaborationActions?: CollaborationSurfaceActions;
  initialFocusExpanded?: boolean;
  initialInspectorTab?: "content" | "collaboration";
};

/**
 * Protocol-4 desktop composition. Canvas is the only stage; Outline and Focus
 * are local presentation trays. Domain reads arrive as validated view models.
 */
export function AppShell({
  workspaceId = null,
  workspaceLabel = "未挂载工作区",
  initialNodes = [],
  document = createEmptyCanvasDocument(),
  selectedNodeId = null,
  graph = null,
  connection = "offline",
  projectionState,
  onRetryConnection,
  initialScene = null,
  persistenceStatus = { kind: "ok" },
  onRetryPersistence,
  onPresentationChange,
  onScenePersist,
  focusDocument,
  focusDocumentActions,
  collaboration,
  collaborationActions,
  initialFocusExpanded = false,
  initialInspectorTab = "content",
}: AppShellProps = {}) {
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [focusOpen, setFocusOpen] = useState(true);
  const [focusExpanded, setFocusExpanded] = useState(initialFocusExpanded);
  const [immersive, setImmersive] = useState(false);
  const placementActionRef = useRef<HTMLButtonElement>(null);
  const nodes = useMemo(() => [...initialNodes], [initialNodes]);
  const selectedNode = useMemo(() => nodes.find((node) => node.nodeId === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const projection = projectionState ?? (!workspaceId
    ? "unmounted"
    : nodes.some((node) => node.projectionState === "error")
    ? "error"
    : nodes.some((node) => node.projectionState === "unresolved")
      ? "unresolved"
      : nodes.some((node) => node.projectionState === "stale")
      ? "stale"
      : nodes.some((node) => node.projectionState === "loading")
        ? "loading"
        : "fresh");

  const selectNode = (nodeId: string | null, placementId?: string | null) => {
    onPresentationChange?.((current) =>
      selectPresentationNode(current, nodeId, placementId)
    );
    if (nodeId) setFocusOpen(true);
  };

  const updateDocument = (next: CanvasDocument) => {
    onPresentationChange?.((current) => withPresentationDocument(current, next));
  };

  const selectedPlacements = selectedNode
    ? findPlacementsByEntity(document, selectedNode.nodeId)
    : [];
  const canCreatePlacement =
    Boolean(selectedNode) &&
    canCreateNodePlacement(projection, selectedNode?.projectionState);

  const placeSelectedNode = () => {
    if (!selectedNode || !canCreatePlacement) return;
    onPresentationChange?.((current) =>
      placePresentationNode(current, selectedNode.nodeId)
    );
  };

  const removeSelectedNode = () => {
    if (!selectedNode || selectedPlacements.length === 0) return;
    onPresentationChange?.((current) =>
      removeFocusedPresentationPlacement(current, selectedNode.nodeId)
    );
  };

  const openNodeActions = () => {
    setFocusOpen(true);
    requestAnimationFrame(() => placementActionRef.current?.focus());
  };

  return (
    <div className="tn-app" data-shell="renderer-next" data-connection={connection}>
      <header className="tn-global-chrome" data-region="chrome">
        <div className="tn-brand-group">
          <div className="tn-brand"><span>帷幄</span><small>Tent</small></div>
          <span className="tn-workspace-select" title={workspaceLabel}>{workspaceLabel}</span>
        </div>
        <div className="tn-surface-nav" aria-label="当前界面">
          <span className="tn-surface-tab"><ShellIcon name="canvas" />画布</span>
        </div>
        <div className="tn-global-actions">
          <IconButton aria-label={outlineOpen ? "收起节点面板" : "展开节点面板"} variant="ghost" aria-pressed={outlineOpen} onClick={() => setOutlineOpen((value) => !value)}><ShellIcon name="panel-left" /></IconButton>
          <IconButton aria-label={focusOpen ? "收起焦点面板" : "展开焦点面板"} variant="ghost" aria-pressed={focusOpen} onClick={() => setFocusOpen((value) => !value)}><ShellIcon name="panel-right" /></IconButton>
        </div>
      </header>

      {connection !== "online" ? (
        <ConnectionBanner connection={connection} onRetry={onRetryConnection} />
      ) : null}

      <div className="tn-workbench" data-outline-open={outlineOpen ? "true" : "false"} data-focus-open={focusOpen ? "true" : "false"} data-focus-expanded={focusExpanded ? "true" : "false"} data-immersive={immersive ? "true" : "false"}>
        <OutlinePanel nodes={nodes} projection={projection} selectedNodeId={selectedNodeId} onSelectNode={selectNode} onOpenNodeActions={openNodeActions} onCollapse={() => setOutlineOpen(false)} />
        <CanvasWorkbench document={document} nodes={nodes} graph={graph} immersive={immersive} onImmersiveChange={setImmersive} onDocumentChange={updateDocument} onSelectNode={selectNode} initialScene={initialScene} persistenceStatus={persistenceStatus} onRetryPersistence={onRetryPersistence} onScenePersist={onScenePersist} />
        <InspectorPanel
          node={selectedNode}
          placementState={selectedPlacements.length > 0 ? "placed" : "unplaced"}
          canCreatePlacement={canCreatePlacement}
          onPlaceNode={placeSelectedNode}
          onRemoveNode={removeSelectedNode}
          placementActionRef={placementActionRef}
          document={focusDocument}
          documentActions={focusDocumentActions}
          allNodes={nodes}
          collaboration={collaboration}
          collaborationActions={collaborationActions}
          expanded={focusExpanded}
          onExpandedChange={(expanded) => {
            setFocusOpen(true);
            setFocusExpanded(expanded);
          }}
          initialTab={initialInspectorTab}
          onCollapse={() => setFocusOpen(false)}
        />
      </div>

      <StatusBar connection={connection} projection={projection} nodeCount={nodes.length} />
      <span className="tn-sr-only">工作区 {workspaceId ?? "未挂载"}；画布本地布局不等于节点事实。</span>
    </div>
  );
}
