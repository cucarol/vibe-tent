export type TentEmbeddableNodeState =
  | "snapshot"
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
  sourceState?: "current" | "changed" | "deleted" | "unknown";
  rawTaskState?: string | null;
  detail: string;
};

export type TentEmbeddableNodeProps = {
  data: TentEmbeddableNodeData;
  placementId: string;
  selected: boolean;
  projectionSyncState?: "current" | "pending-sync" | "unknown";
};

const STATE_LABELS: Record<TentEmbeddableNodeState, string> = {
  snapshot: "本地快照",
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
  const { data, placementId, selected, projectionSyncState = "current" } = props;
  const stateLabel = data.stateLabel ?? STATE_LABELS[data.state];
  const detailLabel =
    data.type === "目标" ? "范围" : data.type === "输出" ? "产物" : "上下文";
  return (
    <article
      className="tn-excal-node"
      data-node-state={data.state}
      data-source-state={data.sourceState}
      data-selected={selected ? "true" : "false"}
      data-task-state={data.rawTaskState ?? undefined}
      data-projection-sync={projectionSyncState}
      data-tent-placement-id={placementId}
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
      <div className="tn-excal-node__fact">
        <span>{detailLabel}</span>
        <p>{data.detail}</p>
      </div>
    </article>
  );
}
