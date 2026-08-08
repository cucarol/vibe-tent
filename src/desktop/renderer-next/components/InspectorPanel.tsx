import { useState, type Ref } from "react";
import { Button, IconButton, PaneHeader, StatusBadge, Tabs } from "../ui/index.js";
import { ShellIcon } from "../shell/icons.js";
import {
  collaborationBadgeLabel,
  collaborationSummary,
  nodeTitle,
  nodeTypeLabel,
  projectionLabel,
  type WorkbenchNodeView,
} from "../shell/workbench-types.js";
import { FocusDocumentPanel } from "./FocusDocumentPanel.js";
import {
  CollaborationPanel,
  collaborationPanelIdentity,
} from "./CollaborationPanel.js";
import type {
  FocusDocumentActions,
  FocusDocumentView,
} from "../model/focus-document-controller.js";
import type {
  CollaborationSurfaceActions,
  CollaborationSurfaceView,
} from "../model/collaboration-surface-controller.js";
import type { CanvasPlacementSourceState } from "../model/canvas-node-snapshot.js";

export type InspectorLocalNodeView = Omit<
  WorkbenchNodeView,
  "etag" | "parentNodeId" | "hasChildren"
> & {
  etag?: string;
};

export type InspectorPanelProps = {
  id?: string;
  node: WorkbenchNodeView | null;
  localNode?: InspectorLocalNodeView | null;
  placementState?: "placed" | "unplaced";
  placementSourceState?: CanvasPlacementSourceState | null;
  canCreatePlacement?: boolean;
  onPlaceNode?: () => void;
  onRemoveNode?: () => void;
  onSyncSnapshot?: () => void;
  placementActionRef?: Ref<HTMLButtonElement>;
  document?: FocusDocumentView;
  documentActions?: FocusDocumentActions;
  allNodes?: readonly WorkbenchNodeView[];
  collaboration?: CollaborationSurfaceView;
  collaborationActions?: CollaborationSurfaceActions;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  initialTab?: "content" | "collaboration";
  onCollapse: () => void;
};

export function InspectorPanel({
  id,
  node,
  localNode = null,
  placementState = "unplaced",
  placementSourceState = null,
  canCreatePlacement = false,
  onPlaceNode,
  onRemoveNode,
  onSyncSnapshot,
  placementActionRef,
  document,
  documentActions,
  allNodes = [],
  collaboration,
  collaborationActions,
  expanded = false,
  onExpandedChange,
  initialTab = "content",
  onCollapse,
}: InspectorPanelProps) {
  const displayNode = node ?? localNode;
  const [tab, setTab] = useState(initialTab);
  const authoritativeNode =
    node && (!node.projectionState || node.projectionState === "ready")
      ? node
      : null;
  const projectionReady = Boolean(authoritativeNode);
  const collaborationRunning =
    authoritativeNode?.collaborationState === "ready" &&
    typeof authoritativeNode.activeTaskState === "string";
  const documentPanel = document && documentActions && onExpandedChange ? (
    <FocusDocumentPanel
      document={document}
      actions={documentActions}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    />
  ) : null;
  const sourceLabel = placementSourceState?.state === "current"
    ? "来源一致"
    : placementSourceState?.state === "changed"
      ? "来源有更新"
      : placementSourceState?.state === "deleted"
        ? "源节点已删除"
        : placementSourceState?.reason === "revision-unavailable"
          ? "来源版本未知"
          : "来源状态未知";
  return (
    <aside id={id} className="tn-pane tn-inspector-pane" aria-label="详情面板" data-region="focus">
      <PaneHeader
        title="详情"
        actions={<IconButton size="compact" aria-label="收起详情面板" tooltip="收起详情面板" variant="ghost" onClick={onCollapse}><ShellIcon name="chevron-right" /></IconButton>}
      />
      {!displayNode ? (
        <div className="tn-pane-empty" role="status">
          <strong>选择一个节点</strong>
          <p>正文、属性、派活与审阅会在这里打开。</p>
        </div>
      ) : (
        <div className="tn-inspector-content">
          <header className="tn-focus-identity">
            <div className="tn-focus-kicker">
              <span>{projectionReady ? nodeTypeLabel(displayNode.type) : "本地画布位置"}</span>
              {authoritativeNode ? (
                <StatusBadge
                  tone={collaborationRunning ? "running" : "neutral"}
                  data-task-state={authoritativeNode.activeTaskState ?? undefined}
                  data-collaboration-state={authoritativeNode.collaborationState ?? "unknown"}
                >
                  {collaborationBadgeLabel(authoritativeNode)}
                </StatusBadge>
              ) : <StatusBadge tone="neutral">状态未知</StatusBadge>}
            </div>
            <h1>{nodeTitle(displayNode)}</h1>
            <p>{projectionReady ? displayNode.path : "非权威缓存，仅用于找回画布位置"}</p>
          </header>

          {projectionLabel(displayNode.projectionState) ? (
            <div className="tn-projection-notice" data-state={displayNode.projectionState} role={displayNode.projectionState === "error" ? "alert" : "status"}>
              <strong>{projectionLabel(displayNode.projectionState)}</strong>
              <span>{displayNode.projectionMessage ?? "保留本地画布位置，等待权威投影恢复。"}</span>
            </div>
          ) : null}

          <section
            className="tn-focus-placement"
            aria-labelledby="tn-focus-placement-title"
            data-placement-state={placementState}
          >
            <div>
              <h2 id="tn-focus-placement-title">画布位置</h2>
              <p id="tn-focus-placement-description">
                {placementState === "placed"
                  ? "已放入当前画布。移动与移除只影响本机布局。"
                  : canCreatePlacement
                    ? "尚未放入画布。节点事实仍保留在工作区中。"
                    : "尚未放入画布；权威节点恢复后才能创建本地位置。"}
              </p>
              {placementState === "placed" && placementSourceState ? (
                <span
                  className="tn-focus-placement__source"
                  data-source-state={placementSourceState.state}
                  data-source-reason={placementSourceState.reason}
                >
                  {sourceLabel}
                </span>
              ) : null}
            </div>
            {placementState === "placed" ? (
              <div className="tn-focus-placement__actions">
                {placementSourceState?.canSync ? (
                  <IconButton
                    size="compact"
                    aria-label="同步快照"
                    tooltip="同步快照"
                    variant="ghost"
                    onClick={onSyncSnapshot}
                  >
                    <ShellIcon name="refresh" />
                  </IconButton>
                ) : null}
                <Button
                  ref={placementActionRef}
                  variant="quiet"
                  size="compact"
                  aria-describedby="tn-focus-placement-description"
                  onClick={onRemoveNode}
                >
                  从画布移除
                </Button>
              </div>
            ) : (
              <Button
                ref={placementActionRef}
                variant="primary"
                size="compact"
                disabled={!canCreatePlacement}
                aria-describedby="tn-focus-placement-description"
                onClick={onPlaceNode}
              >
                放入画布
              </Button>
            )}
          </section>

          {projectionReady ? (
            <Tabs
              aria-label="详情内容"
              value={tab}
              onValueChange={(value) => setTab(value as "content" | "collaboration")}
              items={[{ id: "content", label: "内容" }, { id: "collaboration", label: "协作" }]}
            />
          ) : null}

          {tab === "collaboration" && authoritativeNode && collaboration && collaborationActions ? (
            <CollaborationPanel
              key={collaborationPanelIdentity(collaboration)}
              node={authoritativeNode}
              allNodes={allNodes}
              view={collaboration}
              actions={collaborationActions}
            />
          ) : !projectionReady ? (
            <div className="tn-focus-sections">
              {documentPanel}
              <section>
                <h2>等待权威投影</h2>
                <p>节点属性、协作与交付来源暂不展示；恢复后会重新查询。</p>
              </section>
            </div>
          ) : tab === "content" && authoritativeNode ? (
            <div className="tn-focus-sections">
              {documentPanel ?? (
                <section>
                  <h2>正文</h2>
                  <p>正文读取尚未接入当前预览。</p>
                </section>
              )}
              <section>
                <h2>属性</h2>
                <dl>
                  <div><dt>类型</dt><dd>{nodeTypeLabel(displayNode.type)}</dd></div>
                  <div><dt>模式</dt><dd>{displayNode.archived ? "已归档" : "可编辑"}</dd></div>
                  <div><dt>标签</dt><dd>{displayNode.tags.length ? displayNode.tags.join(" · ") : "无"}</dd></div>
                </dl>
              </section>
              {displayNode.type === "output" ? (
                <section>
                  <h2>交付来源</h2>
                  <p data-provenance-state={authoritativeNode.outputProvenance?.state ?? "error"}>
                    {authoritativeNode.outputProvenance?.label ?? "来源状态未知"}
                  </p>
                </section>
              ) : null}
            </div>
          ) : authoritativeNode ? (
            <div className="tn-focus-sections">
              <section>
                <h2>当前协作</h2>
                <p>{collaborationSummary(authoritativeNode)}</p>
              </section>
              <section><h2>协作尚未接入</h2><p>等待权威任务与收件箱投影。</p></section>
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}
