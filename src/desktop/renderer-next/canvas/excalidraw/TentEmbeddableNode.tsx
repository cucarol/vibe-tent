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
  relationFocus?: "neutral" | "neighbor" | "background";
  projectionSyncState?: "current" | "pending-sync" | "unknown" | "tombstone";
  needsAttention?: boolean;
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
  const {
    data,
    placementId,
    selected,
    relationFocus = "neutral",
    projectionSyncState = "current",
    needsAttention = false,
  } = props;
  const stateLabel = data.stateLabel ?? STATE_LABELS[data.state];
  const titleLines = Array.from(data.title.trim()).length <= 16 ? 1 : 2;
  return (
    <article
      className="tn-excal-node"
      data-node-state={data.state}
      data-source-state={data.sourceState}
      data-selected={selected ? "true" : "false"}
      data-relation-focus={selected ? "selected" : relationFocus}
      data-task-state={data.rawTaskState ?? undefined}
      data-projection-sync={projectionSyncState}
      data-needs-attention={needsAttention ? "true" : "false"}
      data-title-lines={titleLines}
      data-tent-placement-id={placementId}
      data-testid={`tent-embeddable-node-${data.nodeId}`}
      aria-label={`${data.title}，${stateLabel}`}
      title={data.title}
    >
      <h3>{data.title}</h3>
    </article>
  );
}
