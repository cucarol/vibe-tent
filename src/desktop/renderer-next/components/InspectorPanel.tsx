import { useState } from "react";
import { IconButton, PaneHeader, StatusBadge, Tabs } from "../ui/index.js";
import { ShellIcon } from "../shell/icons.js";
import { nodeTitle, nodeTypeLabel, projectionLabel, type WorkbenchNodeView } from "../shell/workbench-types.js";

export type InspectorPanelProps = {
  node: WorkbenchNodeView | null;
  onCollapse: () => void;
};

export function InspectorPanel({ node, onCollapse }: InspectorPanelProps) {
  const [tab, setTab] = useState("content");
  const projectionReady = !node?.projectionState || node.projectionState === "ready";
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
                node.activeTaskState ? <StatusBadge tone="running">正在协作</StatusBadge> : <StatusBadge tone="neutral">空闲</StatusBadge>
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

          {projectionReady ? <Tabs
            aria-label="焦点内容"
            value={tab}
            onValueChange={setTab}
            items={[{ id: "content", label: "内容" }, { id: "collaboration", label: "协作" }]}
          /> : null}

          {!projectionReady ? (
            <div className="tn-focus-sections">
              <section>
                <h2>等待权威投影</h2>
                <p>类型、标签、正文与协作状态暂不展示；恢复后会重新查询。</p>
              </section>
            </div>
          ) : tab === "content" ? (
            <div className="tn-focus-sections">
              <section>
                <h2>摘要</h2>
                <p>{node.projectionState && node.projectionState !== "ready" ? "当前内容不可作为最新事实。" : "选择正文后可在这里阅读与编辑；画布节点保持轻量。"}</p>
              </section>
              <section>
                <h2>属性</h2>
                <dl>
                  <div><dt>类型</dt><dd>{nodeTypeLabel(node.type)}</dd></div>
                  <div><dt>模式</dt><dd>{node.archived ? "已归档" : "可编辑"}</dd></div>
                  <div><dt>标签</dt><dd>{node.tags.length ? node.tags.join(" · ") : "无"}</dd></div>
                </dl>
              </section>
            </div>
          ) : (
            <div className="tn-focus-sections">
              <section>
                <h2>当前协作</h2>
                <p>{node.activeTaskState ? `任务状态：${node.activeTaskState}` : "这个节点当前没有进行中的任务。"}</p>
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
