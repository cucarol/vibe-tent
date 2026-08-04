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
import type {
  FocusDocumentActions,
  FocusDocumentView,
} from "../model/focus-document-controller.js";

export type InspectorPanelProps = {
  node: WorkbenchNodeView | null;
  placementState?: "placed" | "unplaced";
  canCreatePlacement?: boolean;
  onPlaceNode?: () => void;
  onRemoveNode?: () => void;
  placementActionRef?: Ref<HTMLButtonElement>;
  document?: FocusDocumentView;
  documentActions?: FocusDocumentActions;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onCollapse: () => void;
};

export function InspectorPanel({
  node,
  placementState = "unplaced",
  canCreatePlacement = false,
  onPlaceNode,
  onRemoveNode,
  placementActionRef,
  document,
  documentActions,
  expanded = false,
  onExpandedChange,
  onCollapse,
}: InspectorPanelProps) {
  const [tab, setTab] = useState("content");
  const projectionReady = !node?.projectionState || node.projectionState === "ready";
  const collaborationRunning =
    node?.collaborationState === "ready" &&
    typeof node.activeTaskState === "string";
  const documentPanel = document && documentActions && onExpandedChange ? (
    <FocusDocumentPanel
      document={document}
      actions={documentActions}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    />
  ) : null;
  return (
    <aside className="tn-pane tn-inspector-pane" aria-label="焦点面板" data-region="focus">
      <PaneHeader
        title="焦点"
        actions={<IconButton aria-label="收起焦点面板" variant="ghost" onClick={onCollapse}><ShellIcon name="chevron-right" /></IconButton>}
      />
      {!node ? (
        <div className="tn-pane-empty" role="status">
          <strong>选择一个节点</strong>
          <p>正文、属性、派活与审阅会在这里打开。</p>
        </div>
      ) : (
        <div className="tn-inspector-content">
          <header className="tn-focus-identity">
            <div className="tn-focus-kicker">
              <span>{projectionReady ? nodeTypeLabel(node.type) : "本地画布位置"}</span>
              {projectionReady ? (
                <StatusBadge
                  tone={collaborationRunning ? "running" : "neutral"}
                  data-task-state={node.activeTaskState ?? undefined}
                  data-collaboration-state={node.collaborationState ?? "unknown"}
                >
                  {collaborationBadgeLabel(node)}
                </StatusBadge>
              ) : <StatusBadge tone="neutral">状态未知</StatusBadge>}
            </div>
            <h1>{nodeTitle(node)}</h1>
            <p>{projectionReady ? node.path : "非权威缓存，仅用于找回画布位置"}</p>
          </header>

          {projectionLabel(node.projectionState) ? (
            <div className="tn-projection-notice" data-state={node.projectionState} role={node.projectionState === "error" ? "alert" : "status"}>
              <strong>{projectionLabel(node.projectionState)}</strong>
              <span>{node.projectionMessage ?? "保留本地画布位置，等待权威投影恢复。"}</span>
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
            </div>
            {placementState === "placed" ? (
              <Button
                ref={placementActionRef}
                variant="quiet"
                size="compact"
                aria-describedby="tn-focus-placement-description"
                onClick={onRemoveNode}
              >
                从画布移除
              </Button>
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

          {projectionReady ? <Tabs
            aria-label="焦点内容"
            value={tab}
            onValueChange={setTab}
            items={[{ id: "content", label: "内容" }, { id: "collaboration", label: "协作" }]}
          /> : null}

          {!projectionReady ? (
            <div className="tn-focus-sections">
              {documentPanel}
              <section>
                <h2>等待权威投影</h2>
                <p>节点属性、协作与交付来源暂不展示；恢复后会重新查询。</p>
              </section>
            </div>
          ) : tab === "content" ? (
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
                  <div><dt>类型</dt><dd>{nodeTypeLabel(node.type)}</dd></div>
                  <div><dt>模式</dt><dd>{node.archived ? "已归档" : "可编辑"}</dd></div>
                  <div><dt>标签</dt><dd>{node.tags.length ? node.tags.join(" · ") : "无"}</dd></div>
                </dl>
              </section>
              {node.type === "output" ? (
                <section>
                  <h2>交付来源</h2>
                  <p data-provenance-state={node.outputProvenance?.state ?? "error"}>
                    {node.outputProvenance?.label ?? "来源状态未知"}
                  </p>
                </section>
              ) : null}
            </div>
          ) : (
            <div className="tn-focus-sections">
              <section>
                <h2>当前协作</h2>
                <p>{collaborationSummary(node)}</p>
              </section>
              <section>
                <h2>交付与审阅</h2>
                <p>准备好的交付会在这里显示；不会从画布外观推断状态。</p>
              </section>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
