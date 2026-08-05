import type { ReactNode } from "react";
import { Button } from "../../ui/index.js";

export type TentEmbeddableNodeState =
  | "snapshot"
  | "active"
  | "waiting"
  | "delivered"
  | "idle"
  | "unknown"
  | "stale"
  | "unresolved"
  | "error";

export type TentEmbeddableNodeData = {
  nodeId: string;
  title: string;
  type: string;
  state: TentEmbeddableNodeState;
  stateLabel?: string;
  rawTaskState?: string | null;
  detail: string;
};

export type TentEmbeddableNodeProps = {
  data: TentEmbeddableNodeData;
  selected: boolean;
  interactive?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  children?: ReactNode;
};

const STATE_LABELS: Record<TentEmbeddableNodeState, string> = {
  snapshot: "本地快照",
  active: "任务进行中",
  waiting: "等待确认",
  delivered: "已交付",
  idle: "就绪",
  unknown: "协作状态未加载",
  stale: "投影已过期",
  unresolved: "节点未解析",
  error: "加载失败",
};

/**
 * React content rendered through Excalidraw's public renderEmbeddable prop.
 * The card intentionally contains no product commands: selection drives the
 * real Focus pane, while animation communicates collaboration state.
 */
export function TentEmbeddableNode(props: TentEmbeddableNodeProps) {
  const {
    data,
    selected,
    interactive = false,
    expanded = false,
    onToggleExpanded,
    children,
  } = props;
  const stateLabel = data.stateLabel ?? STATE_LABELS[data.state];
  return (
    <article
      className="tn-excal-node"
      data-node-state={data.state}
      data-selected={selected ? "true" : "false"}
      data-expanded={expanded ? "true" : "false"}
      data-task-state={data.rawTaskState ?? undefined}
      data-testid={`tent-embeddable-node-${data.nodeId}`}
      aria-label={`${data.title}，${stateLabel}`}
      title={data.nodeId}
    >
      <div className="tn-excal-node__signal" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <header className="tn-excal-node__header">
        <span className="tn-excal-node__type">{data.type}</span>
        <span className="tn-excal-node__state">
          <span className="tn-excal-node__state-mark" aria-hidden="true" />
          {stateLabel}
        </span>
      </header>
      <h3>{data.title}</h3>
      <p>{data.detail}</p>
      {expanded ? (
        <dl
          className="tn-excal-node__peek"
          data-testid={`tent-embeddable-node-peek-${data.nodeId}`}
        >
          <div>
            <dt>位置</dt>
            <dd>Canvas 本机保存</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{stateLabel}</dd>
          </div>
          <div>
            <dt>节点 ID</dt>
            <dd>{data.nodeId}</dd>
          </div>
          <div>
            <dt>操作</dt>
            <dd>右侧栏继续处理</dd>
          </div>
        </dl>
      ) : null}
      {children}
      {selected && interactive && onToggleExpanded ? (
        <footer>
          <Button
            variant="quiet"
            size="compact"
            className="tn-excal-node__peek-toggle"
            data-testid={`tent-embeddable-node-toggle-${data.nodeId}`}
            aria-expanded={expanded}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleExpanded();
            }}
          >
            {expanded ? "收起状态" : "查看状态"}
          </Button>
        </footer>
      ) : null}
    </article>
  );
}
