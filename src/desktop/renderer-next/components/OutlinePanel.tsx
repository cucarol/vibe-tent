import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { IconButton, PaneHeader, StatusBadge } from "../ui/index.js";
import { ShellIcon } from "../shell/icons.js";
import { nodeTitle, nodeTypeLabel, projectionLabel, type WorkbenchNodeView } from "../shell/workbench-types.js";

export type OutlinePanelProps = {
  nodes: readonly WorkbenchNodeView[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onCollapse: () => void;
};

export function OutlinePanel({ nodes, selectedNodeId, onSelectNode, onCollapse }: OutlinePanelProps) {
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());

  const focusItem = (index: number) => {
    const node = nodes[index];
    if (!node) return;
    onSelectNode(node.nodeId);
    itemRefs.current.get(node.nodeId)?.focus();
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
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
          <strong>还没有节点</strong>
          <p>挂载工作区后，节点会按结构显示在这里。</p>
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
                {projectionReady && node.activeTaskState ? <StatusBadge tone="running">协作中</StatusBadge> : null}
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}
