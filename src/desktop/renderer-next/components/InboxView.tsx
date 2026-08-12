import type { CollaborationInboxItem } from "../model/workspace-collaboration-view.js";
import type { CollaborationSurfaceView } from "../model/collaboration-surface-controller.js";
import type { WorkbenchNodeView } from "../shell/workbench-types.js";

export type InboxViewProps = { view: CollaborationSurfaceView; nodes: readonly WorkbenchNodeView[]; projection: "loading" | "fresh" | "stale" | "unresolved" | "error" | "unmounted"; onSelectNode: (nodeId: string) => void };
export function inboxModelCount(view: CollaborationSurfaceView): number | null { return view.snapshot?.inbox.counts.total ?? null; }
const limit = (text: string) => { const value = text.replace(/\s+/g, " ").trim(); return value.length > 120 ? `${value.slice(0, 119)}…` : value; };
export function resolveInboxItemNode(item: CollaborationInboxItem, nodes: readonly WorkbenchNodeView[], projection: InboxViewProps["projection"]): WorkbenchNodeView | null {
  if (projection !== "fresh") return null;
  const ids = item.kind === "delivery" ? [item.sourceNodeId] : item.nodeIds;
  for (const id of ids) { const node = nodes.find((candidate) => candidate.nodeId === id && candidate.projectionState === "ready"); if (node) return node; }
  return null;
}
export function InboxView({ view, nodes, projection, onSelectNode }: InboxViewProps) {
  const items = view.snapshot?.inbox.items ?? [];
  return <div className="tn-inbox-view" data-state={view.status} aria-busy={view.status === "loading" || view.status === "refreshing" || undefined}>
    {view.status !== "ready" ? <div className="tn-inbox-state" role={view.status === "error" ? "alert" : "status"}><strong>{view.snapshot ? "收件箱正在刷新" : view.status === "error" ? "收件箱不可用" : "正在读取收件箱"}</strong><span>{view.issue?.message ?? "当前不会提交任何操作。"}</span></div> : null}
    {view.snapshot && items.length === 0 ? <div className="tn-inbox-empty"><strong>暂时没有待处理事项</strong><span>需要你接纳的返回内容和待回复决定会出现在这里。</span></div> : null}
    {view.snapshot && items.length ? <ul className="tn-inbox-list" aria-label="待处理事项">{items.map((item) => {
      const node = resolveInboxItemNode(item, nodes, projection);
      const summary = item.kind === "delivery" ? item.summary || "返回内容等待接纳" : item.question;
      const label = item.kind === "delivery" ? "返回内容" : "需要决定";
      const content = <><span className="tn-inbox-row-heading"><strong>{label}</strong></span><span className="tn-inbox-row-summary">{limit(summary)}</span><span className="tn-inbox-row-source">{node ? "查看对应节点" : "对应节点暂不可用"}</span></>;
      return <li key={item.kind === "delivery" ? item.deliveryId : item.requestId} className="tn-inbox-row-wrap">{node ? <button type="button" className="tn-inbox-row" data-actionable="true" onClick={() => onSelectNode(node.nodeId)}>{content}</button> : <div className="tn-inbox-row" data-actionable="false" aria-disabled="true">{content}</div>}</li>;
    })}</ul> : null}
  </div>;
}
