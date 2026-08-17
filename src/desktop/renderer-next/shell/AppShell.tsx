import { useMemo, useRef, useState, type CSSProperties } from "react";
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
import { useMainLayout } from "../model/use-main-layout.js";
import type { WorkbenchNodeView } from "./workbench-types.js";
import {
  canCreateNodePlacement,
  canDropNodeIntoPresentation,
  canvasSnapshotSourceFromWorkbenchNode as snapshotSource,
  canvasPlacementSourceAuthority,
  collectReadyPresentationSubtreeSources,
  dropPresentationSubtreeOrLeaf,
  placePresentationSubtreeOrLeaf,
  selectPresentationNode,
  selectPresentationNodeFromOutline,
  withPresentationDocument,
  type WorkbenchPresentationUpdate,
} from "./workbench-presentation.js";
import {
  captureCanvasNodeSnapshot,
  deriveCanvasPlacementSourceState,
  readCanvasNodeSnapshot,
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
import {
  deriveCanvasSubtreeProjection,
  reconcileCanvasDocumentSyncFromLatestAuthority,
  type CanvasProjectionAuthorityReader,
  type CanvasSubtreeNodeSource,
} from "../model/canvas-subtree-projection.js";
import { canvasAttentionPlacementIds } from "../model/canvas-attention.js";

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
  canvasPreviewDocument?: {
    nodeId: string;
    status?: "loading" | "ready" | "error";
    body?: string;
  } | null;
  onCanvasPreviewNode?: (nodeId: string | null) => void;
  focusDocumentActions?: FocusDocumentActions;
  collaboration?: CollaborationSurfaceView;
  collaborationActions?: CollaborationSurfaceActions;
  initialFocusExpanded?: boolean;
  initialInspectorTab?: "content" | "collaboration";
  initialOutlineMode?: "nodes" | "inbox";
  /** Story fixtures may supply an injected synchronous authority reader. */
  readCurrentCanvasAuthority?: CanvasProjectionAuthorityReader;
  /** Production persists the exact global sync transaction before publish. */
  onCanvasSync?: (
    authorityDigest: string
  ) => CanvasDocument | null | Promise<CanvasDocument | null>;
};

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
  canvasPreviewDocument,
  onCanvasPreviewNode,
  focusDocumentActions,
  collaboration,
  collaborationActions,
  initialFocusExpanded = false,
  initialInspectorTab = "content",
  initialOutlineMode = "nodes",
  readCurrentCanvasAuthority,
  onCanvasSync,
}: AppShellProps = {}) {
  const layout = useMainLayout();
  const outlineOpen = !layout.effective.leftCollapsed;
  const focusOpen = !layout.effective.rightCollapsed;
  const layoutStyle = {
    "--tn-layout-left-width": `${layout.effective.leftWidth}px`,
    "--tn-layout-right-width": `${layout.effective.rightWidth}px`,
  } as CSSProperties;
  const [focusExpanded, setFocusExpanded] = useState(initialFocusExpanded);
  const [immersive, setImmersive] = useState(false);
  const [outlineMode, setOutlineMode] = useState<"nodes" | "inbox">(
    initialOutlineMode
  );
  const [outlineReveal, setOutlineReveal] = useState({ nodeId: "", revision: 0 });
  const placementActionRef = useRef<HTMLButtonElement>(null);
  const nodes = useMemo(() => [...initialNodes], [initialNodes]);
  const selectedNode = useMemo(() => nodes.find((node) => node.nodeId === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const attentionNodeIds = useMemo(() => {
    if (collaboration?.status !== "ready" || !collaboration.snapshot) return new Set<string>();
    const ids = new Set<string>();
    for (const item of collaboration.snapshot.inbox.items) {
      if (item.kind !== "result") {
        for (const nodeId of item.nodeIds) ids.add(nodeId);
      }
    }
    return ids;
  }, [collaboration]);
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
  const canvasSubtreeSources = useMemo<CanvasSubtreeNodeSource[] | null>(() => {
    return projection === "fresh" &&
      nodes.every((node) => node.projectionState === undefined || node.projectionState === "ready")
      ? nodes.map((node) => {
        const source = snapshotSource(node)!;
        return {
          nodeId: node.nodeId,
          parentNodeId: node.parentNodeId,
          snapshot: { ...captureCanvasNodeSnapshot(source), etag: source.etag },
        };
      })
      : null;
  }, [nodes, projection]);
  const canvasSubtreeProjection = useMemo(
    () => deriveCanvasSubtreeProjection(document, canvasSubtreeSources),
    [canvasSubtreeSources, document]
  );
  const attentionPlacementIds = useMemo(
    () => canvasAttentionPlacementIds(
      document,
      canvasSubtreeProjection.visiblePlacementIds,
      attentionNodeIds
    ),
    [attentionNodeIds, canvasSubtreeProjection.visiblePlacementIds, document]
  );
  const canvasProjectionPresence = useMemo(() => {
    const stateByPlacementId = new Map(
      canvasSubtreeProjection.placementStates.map((state) => [state.placementId, state.state] as const)
    );
    const presence = new Map<string, { count: number; pendingSync: boolean }>();
    for (const placement of document.placements) {
      if (placement.kind !== "node" || !placement.entityRef) continue;
      const current = presence.get(placement.entityRef) ?? { count: 0, pendingSync: false };
      current.count += 1;
      current.pendingSync ||= stateByPlacementId.get(placement.placementId) === "pending-sync";
      presence.set(placement.entityRef, current);
    }
    return presence;
  }, [canvasSubtreeProjection.placementStates, document]);
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
        projectionState: projection === "fresh" ? "unresolved" as const :
          projection === "loading" ? "loading" as const :
          projection === "error" ? "error" as const : "stale" as const,
        projectionMessage:
          placementSourceState?.state === "deleted"
            ? "权威图投影中已不存在该节点；本地快照仍保留。"
            : "本地快照仍保留，等待权威来源恢复。",
      }
    : null;

  const selectNodeFromCanvas = (nodeId: string | null, placementId?: string | null) => {
    onPresentationChange?.((current) =>
      selectPresentationNode(current, nodeId, placementId)
    );
    if (nodeId) {
      setOutlineReveal((current) => ({ nodeId, revision: current.revision + 1 }));
    }
  };

  const selectNodeFromOutline = (nodeId: string) => {
    onPresentationChange?.((current) =>
      selectPresentationNodeFromOutline(current, nodeId)
    );
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
    const subtreeSources = collectReadyPresentationSubtreeSources(nodes, selectedNode.nodeId);
    if (!subtreeSources) return;
    onPresentationChange?.((current) =>
      placePresentationSubtreeOrLeaf(current, selectedNode.nodeId, subtreeSources)
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
    const subtreeSources = collectReadyPresentationSubtreeSources(nodes, nodeId);
    if (!subtreeSources) return false;
    onPresentationChange((current) => {
      return dropPresentationSubtreeOrLeaf(
        current,
        nodeId,
        subtreeSources,
        point
      );
    });
    return true;
  };

  const syncCanvas = (authorityDigest: string) => {
    if (onCanvasSync) return onCanvasSync(authorityDigest);
    return reconcileCanvasDocumentSyncFromLatestAuthority(
      document,
      authorityDigest,
      readCurrentCanvasAuthority ?? (() => canvasSubtreeSources)
    );
  };

  const openNodeActions = () => {
    layout.restore("right");
    requestAnimationFrame(() => placementActionRef.current?.focus());
  };

  const toggleOutline = () => {
    setImmersive(false);
    layout.toggle("left");
  };

  const toggleFocus = () => {
    setImmersive(false);
    layout.toggle("right");
  };

  const openOutline = () => {
    setImmersive(false);
    layout.restore("left");
  };

  const openFocus = () => {
    setImmersive(false);
    layout.restore("right");
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
            <ShellIcon name="canvas" />
            画布
          </span>
        </div>
        <div className="tn-global-actions">
          <IconButton size="compact" id="tn-outline-toggle" aria-label={outlineOpen ? "收起节点面板" : "展开节点面板"} tooltip={outlineOpen ? "收起节点面板" : "展开节点面板"} variant="ghost" aria-expanded={outlineOpen} aria-controls="tn-outline-panel" onClick={toggleOutline}><ShellIcon name="panel-left" /></IconButton>
          <IconButton size="compact" id="tn-focus-toggle" aria-label={focusOpen ? "收起详情面板" : "展开详情面板"} tooltip={focusOpen ? "收起详情面板" : "展开详情面板"} variant="ghost" aria-expanded={focusOpen} aria-controls="tn-focus-panel" onClick={toggleFocus}><ShellIcon name="panel-right" /></IconButton>
        </div>
      </header>

      {connection !== "online" ? (
        <ConnectionBanner connection={connection} onRetry={onRetryConnection} />
      ) : null}

      <div className="tn-workbench" style={layoutStyle} data-outline-open={outlineOpen ? "true" : "false"} data-focus-open={focusOpen ? "true" : "false"} data-focus-expanded={focusExpanded ? "true" : "false"} data-immersive={immersive ? "true" : "false"}>
        <OutlinePanel id="tn-outline-panel" mode={outlineMode} onModeChange={setOutlineMode} nodes={nodes} projection={projection} selectedNodeId={selectedNodeId} reveal={outlineReveal} visible={outlineOpen} onSelectNode={selectNodeFromOutline} onOpenNodeActions={openNodeActions} canDragToCanvas={Boolean(onPresentationChange)} canvasPresence={canvasProjectionPresence} onCollapse={() => layout.collapse("left")} collaboration={collaboration ?? { workspaceId, nodeId: null, status: "idle", snapshot: null, targets: [], targetsReady: false, busyKey: null, canMutate: false }} />
        <CanvasWorkbench document={document} nodes={nodes} projection={projection} immersive={immersive} onImmersiveChange={setImmersive} onDocumentChange={updateDocument} onSelectNode={selectNodeFromCanvas} onDropNode={onPresentationChange ? dropNode : undefined} previewDocument={canvasPreviewDocument ?? (focusDocument?.nodeId && typeof focusDocument.body === "string" ? { nodeId: focusDocument.nodeId, status: "ready", body: focusDocument.body } : null)} onPreviewNode={onCanvasPreviewNode} attentionPlacementIds={attentionPlacementIds} onCanvasSync={syncCanvas} initialScene={initialScene} persistenceStatus={persistenceStatus} onRetryPersistence={onRetryPersistence} onScenePersist={onScenePersist} />
        <InspectorPanel
          id="tn-focus-panel"
          node={selectedNode}
          localNode={localInspectorNode}
          placementState={selectedPlacements.length > 0 ? "placed" : "unplaced"}
          placementSourceState={placementSourceState}
          canCreatePlacement={canCreatePlacement}
          onPlaceNode={placeSelectedNode}
          placementActionRef={placementActionRef}
          document={focusDocument}
          documentActions={focusDocumentActions}
          allNodes={nodes}
          collaboration={collaboration}
          collaborationActions={collaborationActions}
          expanded={focusExpanded}
          onExpandedChange={(expanded) => {
            if (expanded) layout.restore("right");
            setFocusExpanded(expanded);
          }}
          initialTab={initialInspectorTab}
          onCollapse={() => {
            layout.collapse("right");
          }}
        />
        {!outlineOpen ? (
          <IconButton
            id="tn-outline-restore"
            className="tn-pane-restore tn-pane-restore--outline"
            aria-label="展开节点面板"
            tooltip="展开节点面板"
            aria-expanded="false"
            aria-controls="tn-outline-panel"
            onClick={openOutline}
          >
            <ShellIcon name="panel-left" />
          </IconButton>
        ) : null}
        {!focusOpen ? (
          <IconButton
            id="tn-focus-restore"
            className="tn-pane-restore tn-pane-restore--focus"
            aria-label="展开详情面板"
            tooltip="展开详情面板"
            aria-expanded="false"
            aria-controls="tn-focus-panel"
            onClick={openFocus}
          >
            <ShellIcon name="panel-right" />
          </IconButton>
        ) : null}
      </div>

      <StatusBar connection={connection} projection={projection} nodeCount={nodes.length} />
      <span className="tn-sr-only">工作区 {workspaceId ?? "未挂载"}；画布本地布局不等于节点事实。</span>
    </div>
  );
}
