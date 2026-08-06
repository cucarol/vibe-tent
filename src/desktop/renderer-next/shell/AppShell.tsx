import { useMemo, useRef, useState } from "react";
import { createEmptyCanvasDocument, type CanvasDocument } from "../types/identity.js";
import {
  findPlacementsByEntity,
} from "../model/canvas-document.js";
import { IconButton } from "../ui/index.js";
import { CanvasWorkbench } from "../components/CanvasWorkbench.js";
import {
  InspectorPanel,
  type InspectorLocalNodeView,
} from "../components/InspectorPanel.js";
import { OutlinePanel } from "../components/OutlinePanel.js";
import { StatusBar } from "../components/StatusBar.js";
import { ConnectionBanner } from "../components/ConnectionBanner.js";
import { ShellIcon } from "./icons.js";
import type { WorkbenchNodeView } from "./workbench-types.js";
import {
  canCreateNodePlacement,
  canDropNodeIntoPresentation,
  canvasPlacementSourceAuthority,
  dropPresentationNode,
  placePresentationNode,
  removeFocusedPresentationPlacement,
  selectPresentationNode,
  syncFocusedPresentationSnapshot,
  withPresentationDocument,
  type WorkbenchPresentationUpdate,
} from "./workbench-presentation.js";
import {
  captureCanvasNodeSnapshot,
  deriveCanvasPlacementSourceState,
  readCanvasNodeSnapshot,
  type CanvasSnapshotSource,
} from "../model/canvas-node-snapshot.js";
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
  initialLayoutMode?: "compact" | "detail";
};

function snapshotSource(node: WorkbenchNodeView | null | undefined): CanvasSnapshotSource | null {
  if (!node) return null;
  return {
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
  };
}

/**
 * Production desktop composition. Canvas is the only stage; Outline and Focus
 * are local presentation trays. Domain reads arrive as validated view models.
 */
export function AppShell({
  workspaceId = null,
  workspaceLabel = "未挂载工作区",
  initialNodes = [],
  document = createEmptyCanvasDocument(),
  selectedNodeId = null,
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
  initialLayoutMode = "compact",
}: AppShellProps = {}) {
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [focusOpen, setFocusOpen] = useState(true);
  const [focusExpanded, setFocusExpanded] = useState(initialFocusExpanded);
  const [immersive, setImmersive] = useState(false);
  const [layoutMode, setLayoutMode] = useState<"compact" | "detail">(
    initialLayoutMode
  );
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
  const focusedPlacement = useMemo(
    () =>
      selectedNodeId
        ? document.placements.find(
            (placement) =>
              placement.placementId === document.focusedPlacementId &&
              placement.entityRef === selectedNodeId
          ) ?? null
        : null,
    [document, selectedNodeId]
  );
  const focusedSnapshot = focusedPlacement
    ? readCanvasNodeSnapshot(focusedPlacement)
    : null;
  const currentSource = snapshotSource(selectedNode);
  const sourceAuthority = canvasPlacementSourceAuthority(
    projection,
    selectedNode ? selectedNode.projectionState : null
  );
  const placementSourceState = focusedPlacement
    ? deriveCanvasPlacementSourceState({
        placement: focusedPlacement,
        authority: sourceAuthority,
        source: sourceAuthority === "fresh" ? currentSource : null,
      })
    : null;
  const localInspectorNode: InspectorLocalNodeView | null = !selectedNode && focusedPlacement
    ? {
        nodeId: selectedNodeId ?? focusedPlacement.entityRef ?? focusedPlacement.placementId,
        etag: focusedSnapshot?.etag,
        path: focusedSnapshot?.path ?? "本地画布位置",
        name: focusedSnapshot?.name ?? "未解析的本地快照",
        title: focusedSnapshot?.title,
        type: focusedSnapshot?.type ?? "",
        tags: focusedSnapshot?.tags ?? [],
        mode: focusedSnapshot?.mode ?? "editable",
        archived: focusedSnapshot?.archived ?? false,
        invalid: focusedSnapshot?.invalid ?? true,
        collaborationState: "unknown" as const,
        projectionState: projection === "fresh" ? "unresolved" as const :
          projection === "loading" ? "loading" as const :
          projection === "error" ? "error" as const : "stale" as const,
        projectionMessage:
          placementSourceState?.state === "deleted"
            ? "权威图投影中已不存在该节点；本地快照仍保留。"
            : "本地快照仍保留，等待权威来源恢复。",
      }
    : null;

  const selectNode = (nodeId: string | null, placementId?: string | null) => {
    onPresentationChange?.((current) =>
      selectPresentationNode(current, nodeId, placementId)
    );
    if (nodeId) setFocusOpen(true);
  };

  const updateDocument = (next: CanvasDocument) => {
    onPresentationChange?.((current) => withPresentationDocument(current, next));
  };

  const selectedPlacements = selectedNodeId
    ? findPlacementsByEntity(document, selectedNodeId)
    : [];
  const canCreatePlacement =
    Boolean(currentSource) &&
    canCreateNodePlacement(projection, selectedNode?.projectionState);

  const placeSelectedNode = () => {
    if (!selectedNode || !currentSource || !canCreatePlacement) return;
    const snapshot = captureCanvasNodeSnapshot(currentSource);
    onPresentationChange?.((current) =>
      placePresentationNode(current, selectedNode.nodeId, snapshot)
    );
  };

  const dropNode = (nodeId: string, point: { x: number; y: number }) => {
    if (!onPresentationChange) return false;
    const node = nodes.find((candidate) => candidate.nodeId === nodeId);
    const source = snapshotSource(node);
    if (
      !node ||
      !source ||
      !canDropNodeIntoPresentation(
        Boolean(onPresentationChange),
        projection,
        node.projectionState
      )
    ) return false;
    const snapshot = captureCanvasNodeSnapshot(source);
    onPresentationChange((current) =>
      dropPresentationNode(current, nodeId, snapshot, point)
    );
    return true;
  };

  const removeSelectedNode = () => {
    if (!selectedNodeId || selectedPlacements.length === 0) return;
    onPresentationChange?.((current) =>
      removeFocusedPresentationPlacement(current, selectedNodeId)
    );
  };

  const syncSelectedSnapshot = () => {
    if (
      !selectedNodeId ||
      !focusedPlacement ||
      !currentSource ||
      !placementSourceState?.canSync
    ) return;
    const placementId = focusedPlacement.placementId;
    const snapshot = captureCanvasNodeSnapshot(currentSource);
    onPresentationChange?.((current) =>
      syncFocusedPresentationSnapshot(
        current,
        placementId,
        selectedNodeId,
        snapshot
      )
    );
  };

  const openNodeActions = () => {
    setFocusOpen(true);
    requestAnimationFrame(() => placementActionRef.current?.focus());
  };

  const toggleOutline = () => {
    if (layoutMode === "detail") setLayoutMode("compact");
    setOutlineOpen((value) => !value);
  };

  const toggleFocus = () => {
    if (layoutMode === "detail") setLayoutMode("compact");
    setFocusOpen((value) => !value);
  };

  const setOutlineMode = (mode: "compact" | "detail") => {
    setLayoutMode(mode);
    setOutlineOpen(true);
    if (mode === "detail") {
      setFocusOpen(true);
      setImmersive(false);
    }
  };

  return (
    <div className="tn-app" data-shell="renderer-next" data-connection={connection}>
      <header className="tn-global-chrome" data-region="chrome">
        <div className="tn-brand-group">
          <div className="tn-brand"><span>帷幄</span><small>Tent</small></div>
          <span className="tn-workspace-select" title={workspaceLabel}>{workspaceLabel}</span>
        </div>
        <div className="tn-surface-nav" aria-label="当前界面">
          <span className="tn-surface-tab">
            <ShellIcon name={layoutMode === "detail" ? "outline" : "canvas"} />
            {layoutMode === "detail" ? "节点详情" : "画布"}
          </span>
        </div>
        <div className="tn-global-actions">
          <IconButton size="compact" id="tn-outline-toggle" aria-label={outlineOpen ? "收起节点面板" : "展开节点面板"} tooltip={outlineOpen ? "收起节点面板" : "展开节点面板"} variant="ghost" aria-expanded={outlineOpen} aria-controls="tn-outline-panel" onClick={toggleOutline}><ShellIcon name="panel-left" /></IconButton>
          <IconButton size="compact" id="tn-focus-toggle" aria-label={focusOpen ? "收起焦点面板" : "展开焦点面板"} tooltip={focusOpen ? "收起焦点面板" : "展开焦点面板"} variant="ghost" aria-expanded={focusOpen} aria-controls="tn-focus-panel" onClick={toggleFocus}><ShellIcon name="panel-right" /></IconButton>
        </div>
      </header>

      {connection !== "online" ? (
        <ConnectionBanner connection={connection} onRetry={onRetryConnection} />
      ) : null}

      <div className="tn-workbench" data-outline-open={outlineOpen ? "true" : "false"} data-focus-open={focusOpen ? "true" : "false"} data-focus-expanded={focusExpanded ? "true" : "false"} data-layout-mode={layoutMode} data-immersive={immersive ? "true" : "false"}>
        <OutlinePanel id="tn-outline-panel" mode={layoutMode} onModeChange={setOutlineMode} nodes={nodes} projection={projection} selectedNodeId={selectedNodeId} onSelectNode={selectNode} onOpenNodeActions={openNodeActions} canDragToCanvas={Boolean(onPresentationChange)} onCollapse={() => { setLayoutMode("compact"); setOutlineOpen(false); }} />
        <CanvasWorkbench hidden={layoutMode === "detail"} document={document} nodes={nodes} projection={projection} immersive={immersive} onImmersiveChange={setImmersive} onDocumentChange={updateDocument} onSelectNode={selectNode} onDropNode={onPresentationChange ? dropNode : undefined} initialScene={initialScene} persistenceStatus={persistenceStatus} onRetryPersistence={onRetryPersistence} onScenePersist={onScenePersist} />
        <InspectorPanel
          id="tn-focus-panel"
          node={selectedNode}
          localNode={localInspectorNode}
          placementState={selectedPlacements.length > 0 ? "placed" : "unplaced"}
          placementSourceState={placementSourceState}
          canCreatePlacement={canCreatePlacement}
          onPlaceNode={placeSelectedNode}
          onRemoveNode={removeSelectedNode}
          onSyncSnapshot={syncSelectedSnapshot}
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
          onCollapse={() => {
            if (layoutMode === "detail") setLayoutMode("compact");
            setFocusOpen(false);
          }}
        />
      </div>

      <StatusBar connection={connection} projection={projection} nodeCount={nodes.length} />
      <span className="tn-sr-only">工作区 {workspaceId ?? "未挂载"}；画布本地布局不等于节点事实。</span>
    </div>
  );
}
