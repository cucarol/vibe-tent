import { useMemo, useRef, useState } from "react";
import type { GraphEdgeSource } from "../model/canvas-edges.js";
import { createEmptyCanvasDocument, type CanvasDocument } from "../types/identity.js";
import { Button, IconButton } from "../ui/index.js";
import { CanvasWorkbench } from "../components/CanvasWorkbench.js";
import { InspectorPanel } from "../components/InspectorPanel.js";
import { OutlinePanel } from "../components/OutlinePanel.js";
import { StatusBar } from "../components/StatusBar.js";
import { ShellIcon } from "./icons.js";
import type { WorkbenchNodeView } from "./workbench-types.js";
import { focusWorkbenchNode, initializeWorkbenchSelection } from "./workbench-selection.js";
import type { DrawingPersistenceStatus } from "../model/drawing-persistence-status.js";
import type { ExcalidrawSceneSnapshot } from "../canvas/excalidraw/excalidrawSceneTypes.js";

export type AppShellProps = {
  workspaceId?: string | null;
  workspaceLabel?: string;
  initialNodes?: readonly WorkbenchNodeView[];
  initialDocument?: CanvasDocument;
  initialSelectedNodeId?: string | null;
  graph?: GraphEdgeSource;
  connection?: "connecting" | "online" | "offline" | "reconnecting";
  projectionState?: "loading" | "fresh" | "stale" | "unresolved" | "error" | "unmounted";
  onRetryConnection?: () => void;
  initialScene?: ExcalidrawSceneSnapshot | null;
  persistenceStatus?: DrawingPersistenceStatus;
  onRetryPersistence?: () => void;
  onCanvasDocumentChange?: (document: CanvasDocument) => void;
  onSelectedNodeChange?: (nodeId: string | null) => void;
  onScenePersist?: (scene: ExcalidrawSceneSnapshot) => void;
};

/**
 * Protocol-4 desktop composition. Canvas is the only stage; Outline and Focus
 * are local presentation trays. Domain reads arrive as validated view models.
 */
export function AppShell({
  workspaceId = null,
  workspaceLabel = "未挂载工作区",
  initialNodes = [],
  initialDocument,
  initialSelectedNodeId = null,
  graph = null,
  connection = "offline",
  projectionState,
  onRetryConnection,
  initialScene = null,
  persistenceStatus = { kind: "ok" },
  onRetryPersistence,
  onCanvasDocumentChange,
  onSelectedNodeChange,
  onScenePersist,
}: AppShellProps = {}) {
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [focusOpen, setFocusOpen] = useState(true);
  const [immersive, setImmersive] = useState(false);
  const initialSelection = useRef<ReturnType<typeof initializeWorkbenchSelection> | null>(null);
  if (!initialSelection.current) {
    initialSelection.current = initializeWorkbenchSelection(
      initialDocument ?? createEmptyCanvasDocument(),
      initialSelectedNodeId
    );
  }
  const [document, setDocument] = useState<CanvasDocument>(() => initialSelection.current!.document);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => initialSelection.current!.selectedNodeId);
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
    setSelectedNodeId(nodeId);
    onSelectedNodeChange?.(nodeId);
    setDocument((current) => {
      const next = focusWorkbenchNode(current, nodeId, placementId);
      onCanvasDocumentChange?.(next);
      return next;
    });
    if (nodeId) setFocusOpen(true);
  };

  const updateDocument = (next: CanvasDocument) => {
    setDocument(next);
    onCanvasDocumentChange?.(next);
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
        <div className="tn-connection-banner" role="alert">
          <span>{connection === "connecting" ? "正在连接本地服务；节点事实尚未加载。" : connection === "reconnecting" ? "正在重新连接本地服务。画布位置会保留，节点事实暂不视为最新。" : "本地服务连接已断开。画布位置会保留，节点事实暂不视为最新。"}</span>
          {onRetryConnection ? <Button size="compact" onClick={onRetryConnection} loading={connection === "reconnecting"}>重试连接</Button> : null}
        </div>
      ) : null}

      <div className="tn-workbench" data-outline-open={outlineOpen ? "true" : "false"} data-focus-open={focusOpen ? "true" : "false"} data-immersive={immersive ? "true" : "false"}>
        <OutlinePanel nodes={nodes} projection={projection} selectedNodeId={selectedNodeId} onSelectNode={selectNode} onCollapse={() => setOutlineOpen(false)} />
        <CanvasWorkbench document={document} nodes={nodes} graph={graph} immersive={immersive} onImmersiveChange={setImmersive} onDocumentChange={updateDocument} onSelectNode={selectNode} initialScene={initialScene} persistenceStatus={persistenceStatus} onRetryPersistence={onRetryPersistence} onScenePersist={onScenePersist} />
        <InspectorPanel node={selectedNode} onCollapse={() => setFocusOpen(false)} />
      </div>

      <StatusBar connection={connection} projection={projection} nodeCount={nodes.length} />
      <span className="tn-sr-only">工作区 {workspaceId ?? "未挂载"}；画布本地布局不等于节点事实。</span>
    </div>
  );
}
