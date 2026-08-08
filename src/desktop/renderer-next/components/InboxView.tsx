import { StatusBadge } from "../ui/index.js";
import type { DesktopInboxItem } from "../../inbox-ipc.js";
import type { InboxModel } from "../model/inbox.js";
import type { WorkbenchNodeView } from "../shell/workbench-types.js";

export type InboxViewProps = {
  model: InboxModel;
  nodes: readonly WorkbenchNodeView[];
  projection: "loading" | "fresh" | "stale" | "unresolved" | "error" | "unmounted";
  onSelectNode: (nodeId: string) => void;
};

const INBOX_KIND_LABEL: Record<DesktopInboxItem["kind"], string> = {
  decisionRequest: "决策请求",
  toolApproval: "工具许可",
  delivery: "交付审阅",
};

const INBOX_SUMMARY_LIMIT = 120;

export function boundedInboxSummary(summary: string): string {
  const compact = summary.replace(/\s+/g, " ").trim();
  return compact.length > INBOX_SUMMARY_LIMIT
    ? `${compact.slice(0, INBOX_SUMMARY_LIMIT - 1)}…`
    : compact;
}

export function formatInboxCreatedAt(createdAt: string): string | null {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function resolveInboxItemNode(
  item: DesktopInboxItem,
  nodes: readonly WorkbenchNodeView[],
  projection: InboxViewProps["projection"]
): WorkbenchNodeView | null {
  if (!item.sourceNodeId || projection !== "fresh") return null;
  const node = nodes.find((candidate) => candidate.nodeId === item.sourceNodeId);
  if (!node || (node.projectionState !== undefined && node.projectionState !== "ready")) {
    return null;
  }
  return node;
}

export function activateInboxItem(
  item: DesktopInboxItem,
  nodes: readonly WorkbenchNodeView[],
  projection: InboxViewProps["projection"],
  onSelectNode: (nodeId: string) => void
): boolean {
  const node = resolveInboxItemNode(item, nodes, projection);
  if (!node) return false;
  onSelectNode(node.nodeId);
  return true;
}

function modelItems(model: InboxModel): readonly DesktopInboxItem[] {
  if (model.state === "ready" || model.state === "stale") return model.snapshot.items;
  if (model.state === "loading") return model.previous?.items ?? [];
  return [];
}

export function inboxModelCount(model: InboxModel): number | null {
  if (model.state === "ready" || model.state === "stale") return model.snapshot.count;
  if (model.state === "loading" && model.previous) return model.previous.count;
  return null;
}

function InboxStatus({ model }: { model: InboxModel }) {
  if (model.state === "idle") {
    return <div className="tn-pane-empty" role="status" data-testid="inbox-idle"><strong>收件箱未挂载</strong><p>挂载工作区后，待处理事项会显示在这里。</p></div>;
  }
  if (model.state === "loading") {
    return <div className="tn-inbox-status" role="status" data-testid={model.previous ? "inbox-refreshing" : "inbox-loading"}><StatusBadge tone="pending">{model.previous ? "正在刷新" : "正在加载"}</StatusBadge></div>;
  }
  if (model.state === "stale") {
    return <div className="tn-inbox-status" role="status" data-testid="inbox-stale"><StatusBadge tone="warning">内容已过期</StatusBadge></div>;
  }
  if (model.state === "error") {
    return <div className="tn-pane-empty" role="status" data-testid="inbox-error"><strong>收件箱读取失败</strong><p>没有把失败的读取伪装成空收件箱。</p></div>;
  }
  if (model.snapshot.count === 0) {
    return <div className="tn-pane-empty" role="status" data-testid="inbox-ready-empty"><strong>暂时没有待处理事项</strong><p>当前工作区没有需要处理的交互。</p></div>;
  }
  return null;
}

export function InboxView({ model, nodes, projection, onSelectNode }: InboxViewProps) {
  const items = modelItems(model);
  const count = inboxModelCount(model);
  const showRows = items.length > 0;
  return (
    <div className="tn-inbox-view" data-testid="workspace-inbox" data-inbox-state={model.state} aria-busy={model.state === "loading" || undefined}>
      <InboxStatus model={model} />
      {showRows ? (
        <ul className="tn-inbox-list" aria-label="待处理事项">
          {items.map((item) => {
            const node = resolveInboxItemNode(item, nodes, projection);
            const time = formatInboxCreatedAt(item.createdAt);
            const content = (
              <>
                <span className="tn-inbox-row-heading"><strong>{INBOX_KIND_LABEL[item.kind]}</strong>{time ? <time dateTime={item.createdAt}>{time}</time> : null}</span>
                <span className="tn-inbox-row-summary">{boundedInboxSummary(item.summary)}</span>
                <span className="tn-inbox-row-source">{node ? "查看对应节点详情" : "来源节点不可解析"}</span>
              </>
            );
            return (
              <li key={`${item.kind}:${item.id}`} className="tn-inbox-row-wrap">
                {node ? (
                  <button
                    type="button"
                    className="tn-inbox-row"
                    data-actionable="true"
                    aria-label={`${INBOX_KIND_LABEL[item.kind]}：${boundedInboxSummary(item.summary)}`}
                    onClick={() => activateInboxItem(item, nodes, projection, onSelectNode)}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="tn-inbox-row" data-actionable="false" aria-disabled="true">
                    {content}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {count !== null && model.state === "loading" ? <span className="tn-sr-only">已知事项 {count} 条，正在刷新。</span> : null}
    </div>
  );
}
