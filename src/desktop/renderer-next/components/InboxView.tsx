import {
  collaborationInboxIdentity,
  type CollaborationInboxIdentity,
  type CollaborationInboxItem,
} from "../model/workspace-collaboration-view.js";
import type { CollaborationSurfaceView } from "../model/collaboration-surface-controller.js";
import type { WorkbenchNodeView } from "../shell/workbench-types.js";

export type InboxViewProps = { view: CollaborationSurfaceView; nodes: readonly WorkbenchNodeView[]; projection: "loading" | "fresh" | "stale" | "unresolved" | "error" | "unmounted"; selectedItem?: CollaborationInboxIdentity | null; onOpenItem?: (item: CollaborationInboxIdentity, nodeId: string | null) => void };
export function inboxModelCount(view: CollaborationSurfaceView): number | null { return view.snapshot?.inbox.counts.total ?? null; }
const limit = (text: string) => { const value = text.replace(/\s+/g, " ").trim(); return value.length > 120 ? `${value.slice(0, 119)}…` : value; };
export function resolveInboxItemNode(item: CollaborationInboxItem, nodes: readonly WorkbenchNodeView[], projection: InboxViewProps["projection"]): WorkbenchNodeView | null {
  if (projection !== "fresh") return null;
  // Results never mutate a Node. Only Decisions have a navigable Node join.
  const ids = item.kind === "result" ? [] : item.nodeIds;
  for (const id of ids) { const node = nodes.find((candidate) => candidate.nodeId === id && candidate.projectionState === "ready"); if (node) return node; }
  return null;
}
export function InboxView({ view, nodes, projection, selectedItem = null, onOpenItem }: InboxViewProps) {
  const items = view.snapshot?.inbox.items ?? [];
  return <div className="tn-inbox-view" data-state={view.status} aria-busy={view.status === "loading" || view.status === "refreshing" || undefined}>
    {view.status !== "ready" ? <div className="tn-inbox-state" role={view.status === "error" ? "alert" : "status"}><strong>{view.snapshot ? "收件箱正在刷新" : view.status === "error" ? "收件箱不可用" : "正在读取收件箱"}</strong><span>{view.issue?.message ?? "当前不会提交任何操作。"}</span></div> : null}
    {view.snapshot && items.length === 0 ? <div className="tn-inbox-empty"><strong>暂时没有待处理事项</strong><span>需要你接纳的返回内容和待回复决定会出现在这里。</span></div> : null}
    {view.snapshot && items.length ? <ul className="tn-inbox-list" aria-label="待处理事项">{items.map((item) => {
      const node = resolveInboxItemNode(item, nodes, projection);
      const identity = collaborationInboxIdentity(item);
      const selected = identity.kind === "result"
        ? selectedItem?.kind === "result" && identity.resultId === selectedItem.resultId
        : selectedItem?.kind === "decision" && identity.requestId === selectedItem.requestId;
      const summary = item.kind === "result" ? item.summary || "返回内容等待接纳" : item.question;
      const label = item.kind === "result" ? "返回内容" : "需要决定";
      const source = item.kind === "result" ? "查看完整返回" : node ? "查看决定 · 对应节点可用" : "查看决定";
      const content = <><span className="tn-inbox-row-heading"><strong>{label}</strong></span><span className="tn-inbox-row-summary">{limit(summary)}</span><span className="tn-inbox-row-source">{source}</span></>;
      return <li key={item.kind === "result" ? item.resultId : item.requestId} className="tn-inbox-row-wrap"><button type="button" className="tn-inbox-row" data-actionable={Boolean(onOpenItem)} data-result-id={item.kind === "result" ? item.resultId : undefined} data-request-id={item.kind === "decision" ? item.requestId : undefined} aria-current={selected || undefined} disabled={!onOpenItem} onClick={() => onOpenItem?.(identity, node?.nodeId ?? null)}>{content}</button></li>;
    })}</ul> : null}
  </div>;
}
