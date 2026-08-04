import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { IconButton, PaneHeader, StatusBadge } from "../ui/index.js";
import { ShellIcon } from "../shell/icons.js";
import { nodeTitle, nodeTypeLabel, projectionLabel, taskStateLabel, type WorkbenchNodeView } from "../shell/workbench-types.js";

export type OutlinePanelProps = {
  nodes: readonly WorkbenchNodeView[];
  projection: "loading" | "fresh" | "stale" | "unresolved" | "error" | "unmounted";
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onOpenNodeActions?: (nodeId: string) => void;
  onCollapse: () => void;
};

const EMPTY_COPY: Record<
  OutlinePanelProps["projection"],
  { title: string; body: string }
> = {
  loading: {
    title: "正在加载节点",
    body: "正在读取权威图投影，请稍候。",
  },
  error: {
    title: "节点加载失败",
    body: "未把失败的读取伪装成空工作区；请恢复连接后重试。",
  },
  unmounted: {
    title: "尚未挂载工作区",
    body: "挂载工作区后，节点会按结构显示在这里。",
  },
  stale: {
    title: "节点状态已过期",
    body: "本地画布仍会保留，等待权威投影恢复。",
  },
  unresolved: {
    title: "节点尚未解析",
    body: "本地位置仍在，但权威 Node 尚未解析。",
  },
  fresh: {
    title: "还没有节点",
    body: "权威图投影已就绪，这个工作区目前没有节点。",
  },
};

export function OutlinePanel({ nodes, projection, selectedNodeId, onSelectNode, onOpenNodeActions, onCollapse }: OutlinePanelProps) {
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const emptyCopy = EMPTY_COPY[projection];

  const focusItem = (index: number) => {
    const node = nodes[index];
    if (!node) return;
    onSelectNode(node.nodeId);
    itemRefs.current.get(node.nodeId)?.focus();
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if ((event.key === "Enter" || event.key === " ") && onOpenNodeActions) {
      event.preventDefault();
      const node = nodes[index];
      if (!node) return;
      onSelectNode(node.nodeId);
      onOpenNodeActions(node.nodeId);
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = Math.min(index + 1, nodes.length - 1);
    if (event.key === "ArrowUp") nextIndex = Math.max(index - 1, 0);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = nodes.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    focusItem(nextIndex);
  };

  return (
    <aside className="tn-pane tn-outline-pane" aria-label="节点大纲" data-region="outline">
      <PaneHeader
        title="节点"
        meta={`${nodes.length}`}
        actions={<IconButton aria-label="收起节点面板" variant="ghost" onClick={onCollapse}><ShellIcon name="chevron-left" /></IconButton>}
      />
      {nodes.length === 0 ? (
        <div className="tn-pane-empty" role="status">
          <strong>{emptyCopy.title}</strong>
          <p>{emptyCopy.body}</p>
        </div>
      ) : (
        <div className="tn-outline-tree" role="tree" aria-label="工作区节点">
          {nodes.map((node) => {
            const selected = node.nodeId === selectedNodeId;
            const projection = projectionLabel(node.projectionState);
            const projectionReady = !node.projectionState || node.projectionState === "ready";
            return (
              <button
                key={node.nodeId}
                type="button"
                role="treeitem"
                aria-level={(node.depth ?? 0) + 1}
                aria-selected={selected}
                tabIndex={selected || (!selectedNodeId && node === nodes[0]) ? 0 : -1}
                ref={(element) => {
                  if (element) itemRefs.current.set(node.nodeId, element);
                  else itemRefs.current.delete(node.nodeId);
                }}
                className="tn-outline-node"
                style={{ "--tn-tree-depth": node.depth ?? 0 } as CSSProperties}
                data-selected={selected || undefined}
                data-projection={node.projectionState ?? "ready"}
                onClick={() => onSelectNode(node.nodeId)}
                onKeyDown={(event) => onTreeKeyDown(event, nodes.indexOf(node))}
              >
                <span className="tn-outline-spine" data-type={node.type} aria-hidden="true" />
                <span className="tn-outline-copy">
                  <span className="tn-outline-title">{nodeTitle(node)}</span>
                  <span className="tn-outline-meta">{projectionReady ? nodeTypeLabel(node.type) : projection}</span>
                </span>
                {projectionReady && node.activeTaskState ? <StatusBadge tone="running" data-task-state={node.activeTaskState}>{taskStateLabel(node.activeTaskState)}</StatusBadge> : null}
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}
