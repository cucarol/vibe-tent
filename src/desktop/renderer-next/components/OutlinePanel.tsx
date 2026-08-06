import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { IconButton, PaneHeader, StatusBadge } from "../ui/index.js";
import { ShellIcon } from "../shell/icons.js";
import { nodeTitle, nodeTypeLabel, projectionLabel, taskStateLabel, type WorkbenchNodeView } from "../shell/workbench-types.js";
import { OUTLINE_NODE_DRAG_TYPE } from "../model/canvas-node-snapshot.js";
import {
  firstOutlineChild,
  updateOutlineExpansion,
  visibleOutlineNodes,
} from "../model/outline-tree.js";

export type OutlinePanelProps = {
  id?: string;
  mode?: "compact" | "detail";
  onModeChange?: (mode: "compact" | "detail") => void;
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

export function OutlinePanel({ id, mode = "compact", onModeChange, nodes, projection, selectedNodeId, onSelectNode, onOpenNodeActions, onCollapse }: OutlinePanelProps) {
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const knownExpandableIds = useRef(new Set<string>());
  const [expandedNodeIds, setExpandedNodeIds] = useState<ReadonlySet<string>>(
    () => new Set(nodes.filter((node) => node.hasChildren).map((node) => node.nodeId))
  );
  const emptyCopy = EMPTY_COPY[projection];
  useEffect(() => {
    setExpandedNodeIds((current) => {
      const next = new Set(
        [...current].filter((nodeId) => nodes.some((node) => node.nodeId === nodeId && node.hasChildren))
      );
      for (const node of nodes) {
        if (node.hasChildren && !knownExpandableIds.current.has(node.nodeId)) {
          next.add(node.nodeId);
        }
      }
      knownExpandableIds.current = new Set(
        nodes.filter((node) => node.hasChildren).map((node) => node.nodeId)
      );
      return next;
    });
  }, [nodes]);
  const visibleNodes = useMemo(
    () => visibleOutlineNodes(nodes, expandedNodeIds),
    [expandedNodeIds, nodes]
  );
  const siblingInfo = useMemo(() => {
    const siblings = new Map<string | null, WorkbenchNodeView[]>();
    for (const node of nodes) {
      const group = siblings.get(node.parentNodeId) ?? [];
      group.push(node);
      siblings.set(node.parentNodeId, group);
    }
    return new Map(nodes.map((node) => {
      const group = siblings.get(node.parentNodeId) ?? [node];
      return [node.nodeId, { position: group.indexOf(node) + 1, size: group.length }] as const;
    }));
  }, [nodes]);

  const focusItem = (node: WorkbenchNodeView | undefined | null) => {
    if (!node) return;
    onSelectNode(node.nodeId);
    itemRefs.current.get(node.nodeId)?.focus();
  };

  const setExpanded = (node: WorkbenchNodeView, expanded: boolean) => {
    if (!node.hasChildren) return;
    const next = updateOutlineExpansion({
      nodes,
      expandedNodeIds,
      nodeId: node.nodeId,
      expanded,
      selectedNodeId,
    });
    setExpandedNodeIds(next.expandedNodeIds);
    if (next.selectedNodeId !== selectedNodeId && next.selectedNodeId) {
      onSelectNode(next.selectedNodeId);
      requestAnimationFrame(() => itemRefs.current.get(node.nodeId)?.focus());
    }
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const node = visibleNodes[index];
    if (!node) return;
    if ((event.key === "Enter" || event.key === " ") && onOpenNodeActions) {
      event.preventDefault();
      onSelectNode(node.nodeId);
      onOpenNodeActions(node.nodeId);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (node.hasChildren && !expandedNodeIds.has(node.nodeId)) {
        setExpanded(node, true);
      } else {
        focusItem(firstOutlineChild(visibleNodes, node.nodeId));
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node.hasChildren && expandedNodeIds.has(node.nodeId)) {
        setExpanded(node, false);
      } else {
        focusItem(nodes.find((candidate) => candidate.nodeId === node.parentNodeId));
      }
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = Math.min(index + 1, visibleNodes.length - 1);
    if (event.key === "ArrowUp") nextIndex = Math.max(index - 1, 0);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = visibleNodes.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    focusItem(visibleNodes[nextIndex]);
  };

  return (
    <aside id={id} className="tn-pane tn-outline-pane" aria-label="节点大纲" data-region="outline" data-outline-mode={mode}>
      <PaneHeader
        title="节点"
        meta={`${nodes.length}`}
        actions={<>
          {onModeChange ? (
            <IconButton
              size="compact"
              aria-label={mode === "detail" ? "恢复紧凑工作台" : "打开节点详细模式"}
              tooltip={mode === "detail" ? "恢复紧凑工作台" : "打开节点详细模式"}
              variant="ghost"
              aria-pressed={mode === "detail"}
              onClick={() => onModeChange(mode === "detail" ? "compact" : "detail")}
            >
              <ShellIcon name={mode === "detail" ? "canvas" : "outline"} />
            </IconButton>
          ) : null}
          <IconButton size="compact" aria-label="收起节点面板" tooltip="收起节点面板" variant="ghost" onClick={onCollapse}><ShellIcon name="chevron-left" /></IconButton>
        </>}
      />
      {nodes.length === 0 ? (
        <div className="tn-pane-empty" role="status">
          <strong>{emptyCopy.title}</strong>
          <p>{emptyCopy.body}</p>
        </div>
      ) : (
        <div className="tn-outline-tree" role="tree" aria-label="工作区节点">
          {visibleNodes.map((node, index) => {
            const selected = node.nodeId === selectedNodeId;
            const projectionCopy = projectionLabel(node.projectionState);
            const projectionReady = !node.projectionState || node.projectionState === "ready";
            const expanded = node.hasChildren ? expandedNodeIds.has(node.nodeId) : undefined;
            const position = siblingInfo.get(node.nodeId);
            return (
              <div
                key={node.nodeId}
                role="treeitem"
                aria-level={(node.depth ?? 0) + 1}
                aria-selected={selected}
                aria-expanded={expanded}
                aria-posinset={position?.position}
                aria-setsize={position?.size}
                tabIndex={selected || (!selectedNodeId && node === visibleNodes[0]) ? 0 : -1}
                ref={(element) => {
                  if (element) itemRefs.current.set(node.nodeId, element);
                  else itemRefs.current.delete(node.nodeId);
                }}
                className="tn-outline-node"
                style={{ "--tn-tree-depth": node.depth ?? 0 } as CSSProperties}
                data-selected={selected || undefined}
                data-projection={node.projectionState ?? "ready"}
                onClick={() => onSelectNode(node.nodeId)}
                onKeyDown={(event) => onTreeKeyDown(event, index)}
                draggable={projection === "fresh" && projectionReady}
                onDragStart={(event) => {
                  if (projection !== "fresh" || !projectionReady) {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.effectAllowed = "copy";
                  event.dataTransfer.setData(OUTLINE_NODE_DRAG_TYPE, node.nodeId);
                  event.dataTransfer.setData("text/plain", nodeTitle(node));
                }}
              >
                <span
                  className="tn-outline-disclosure"
                  data-visible={node.hasChildren || undefined}
                  data-expanded={expanded}
                  onClick={(event: MouseEvent<HTMLSpanElement>) => {
                    if (!node.hasChildren) return;
                    event.stopPropagation();
                    setExpanded(node, !expanded);
                  }}
                >
                  {node.hasChildren ? <ShellIcon name="chevron-right" /> : null}
                </span>
                <span className="tn-outline-spine" data-type={node.type} aria-hidden="true" />
                <span className="tn-outline-copy">
                  <span className="tn-outline-title">{nodeTitle(node)}</span>
                  <span className="tn-outline-meta">{projectionReady ? nodeTypeLabel(node.type) : projectionCopy}</span>
                  {mode === "detail" && projectionReady ? (
                    <span className="tn-outline-detail">
                      <span>{node.path}</span>
                      {node.tags.length ? <span>{node.tags.join(" · ")}</span> : null}
                    </span>
                  ) : null}
                </span>
                {projectionReady && node.activeTaskState ? <StatusBadge tone="running" data-task-state={node.activeTaskState}>{taskStateLabel(node.activeTaskState)}</StatusBadge> : null}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
