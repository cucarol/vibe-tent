import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { Button, IconButton, PaneHeader } from "../ui/index.js";
import { ShellIcon } from "../shell/icons.js";
import { nodeTitle, nodeTypeLabel, projectionLabel, type WorkbenchNodeView } from "../shell/workbench-types.js";
import {
  TENT_NODE_IDS_DRAG_TYPE,
  encodeNodeIdsDrag,
} from "../../task-package-draft.js";
import {
  firstOutlineChild,
  updateOutlineExpansion,
  visibleOutlineNodes,
} from "../model/outline-tree.js";
import {
  resolveOutlineReveal,
  type OutlineRevealRequest,
} from "../model/outline-reveal.js";
import { InboxView, inboxModelCount } from "./InboxView.js";
import type { CollaborationInboxIdentity } from "../model/workspace-collaboration-view.js";
import type { CollaborationSurfaceView } from "../model/collaboration-surface-controller.js";

export type OutlinePanelProps = {
  id?: string;
  mode?: "nodes" | "inbox";
  onModeChange?: (mode: "nodes" | "inbox") => void;
  nodes: readonly WorkbenchNodeView[];
  projection: "loading" | "fresh" | "stale" | "unresolved" | "error" | "unmounted";
  focusedNodeId: string | null;
  selectedNodeIds?: readonly string[];
  onSelectNode: (nodeId: string, toggle?: boolean) => void;
  onOpenNodeActions?: (nodeId: string) => void;
  selectedInboxItem?: CollaborationInboxIdentity | null;
  onOpenInboxItem?: (item: CollaborationInboxIdentity, nodeId: string | null) => void;
  canDragToCanvas?: boolean;
  canvasPresence?: ReadonlyMap<string, { count: number; pendingSync: boolean }>;
  reveal?: { nodeId: string; revision: number };
  visible?: boolean;
  onCollapse: () => void;
  collaboration?: CollaborationSurfaceView;
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

export function OutlinePanel({ id, mode = "nodes", onModeChange, nodes, projection, focusedNodeId, selectedNodeIds = focusedNodeId ? [focusedNodeId] : [], onSelectNode, onOpenNodeActions, selectedInboxItem = null, onOpenInboxItem, canDragToCanvas = false, canvasPresence = new Map(), reveal, visible = true, onCollapse, collaboration = { workspaceId: null, nodeId: null, status: "idle", snapshot: null, targets: [], targetsReady: false, busyKey: null, canMutate: false } }: OutlinePanelProps) {
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const knownExpandableIds = useRef(new Set<string>());
  const handledRevealRevision = useRef(0);
  const pendingRevealFocus = useRef<OutlineRevealRequest | null>(null);
  const revealFocusCancel = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  const latestRevealRef = useRef(reveal);
  visibleRef.current = visible;
  latestRevealRef.current = reveal;
  const [expandedNodeIds, setExpandedNodeIds] = useState<ReadonlySet<string>>(
    () => new Set(nodes.filter((node) => node.hasChildren).map((node) => node.nodeId))
  );
  const emptyCopy = EMPTY_COPY[projection];
  const cancelRevealFocus = () => {
    revealFocusCancel.current?.();
    revealFocusCancel.current = null;
  };
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
  useEffect(() => {
    const resolution = resolveOutlineReveal({
      nodes,
      expandedNodeIds,
      reveal,
      visible,
      handledRevision: handledRevealRevision.current,
      pendingFocus: pendingRevealFocus.current,
    });
    const previousPending = pendingRevealFocus.current;
    handledRevealRevision.current = resolution.handledRevision;
    pendingRevealFocus.current = resolution.pendingFocus;
    if (
      previousPending !== resolution.pendingFocus &&
      (!resolution.pendingFocus ||
        previousPending?.revision !== resolution.pendingFocus.revision ||
        previousPending.nodeId !== resolution.pendingFocus.nodeId)
    ) {
      cancelRevealFocus();
    }
    if (resolution.shouldShowNodes) {
      setExpandedNodeIds(resolution.expandedNodeIds);
      onModeChange?.("nodes");
    }
  }, [nodes, onModeChange, reveal?.nodeId, reveal?.revision, visible]);
  useEffect(() => {
    cancelRevealFocus();
    if (!visible) return;

    const pending = pendingRevealFocus.current;
    const latestReveal = latestRevealRef.current;
    if (
      !pending ||
      pending.nodeId !== latestReveal?.nodeId ||
      pending.revision !== latestReveal?.revision
    ) {
      pendingRevealFocus.current = null;
      return;
    }
    if (
      !nodes.some((node) => node.nodeId === pending.nodeId) ||
      !visibleNodes.some((node) => node.nodeId === pending.nodeId)
    ) return;

    let cancelled = false;
    const focus = () => {
      revealFocusCancel.current = null;
      if (cancelled || !visibleRef.current) return;
      const current = pendingRevealFocus.current;
      const currentReveal = latestRevealRef.current;
      if (
        !current ||
        current.nodeId !== currentReveal?.nodeId ||
        current.revision !== currentReveal?.revision
      ) return;
      const item = itemRefs.current.get(current.nodeId);
      if (!item) return;
      pendingRevealFocus.current = null;
      item.focus();
    };
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(focus);
      revealFocusCancel.current = () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    } else {
      const timeout = globalThis.setTimeout(focus, 0);
      revealFocusCancel.current = () => {
        cancelled = true;
        globalThis.clearTimeout(timeout);
      };
    }
    return () => {
      cancelled = true;
      cancelRevealFocus();
    };
  }, [mode, nodes, reveal?.nodeId, reveal?.revision, visible, visibleNodes]);
  useEffect(() => () => {
    pendingRevealFocus.current = null;
    cancelRevealFocus();
  }, []);
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
  const rovingNodeId = visibleNodes.some((node) => node.nodeId === focusedNodeId)
    ? focusedNodeId
    : visibleNodes[0]?.nodeId ?? null;

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
      selectedNodeId: focusedNodeId,
    });
    setExpandedNodeIds(next.expandedNodeIds);
    if (next.selectedNodeId !== focusedNodeId && next.selectedNodeId) {
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
    <aside id={id} className="tn-pane tn-outline-pane" aria-label="工作区导航" data-region="outline" data-outline-mode={mode}>
      <PaneHeader
        title={mode === "nodes" ? "节点" : "收件箱"}
        meta={mode === "nodes" ? `${nodes.length}` : inboxModelCount(collaboration) ?? undefined}
        actions={<>
          {onModeChange ? (
            <div className="tn-outline-modes" role="group" aria-label="左栏内容">
              <Button size="compact" variant="ghost" aria-pressed={mode === "nodes"} onClick={() => onModeChange("nodes")}>节点</Button>
              <Button size="compact" variant="ghost" aria-pressed={mode === "inbox"} onClick={() => onModeChange("inbox")}>收件箱</Button>
            </div>
          ) : null}
          <IconButton size="compact" aria-label="收起节点面板" tooltip="收起节点面板" variant="ghost" onClick={onCollapse}><ShellIcon name="chevron-left" /></IconButton>
        </>}
      />
      {mode === "inbox" ? (
        <InboxView view={collaboration} nodes={nodes} projection={projection} selectedItem={selectedInboxItem} onOpenItem={onOpenInboxItem} />
      ) : nodes.length === 0 ? (
        <div className="tn-pane-empty" role="status">
          <strong>{emptyCopy.title}</strong>
          <p>{emptyCopy.body}</p>
        </div>
      ) : (
        <div className="tn-outline-tree" role="tree" aria-label="工作区节点" aria-describedby="tn-outline-drag-instructions">
          <span id="tn-outline-drag-instructions" className="tn-sr-only">
            可将权威状态正常的节点拖到画布，创建独立的本地快照位置。
          </span>
          {visibleNodes.map((node, index) => {
            const selected = selectedNodeIds.includes(node.nodeId);
            const focused = node.nodeId === focusedNodeId;
            const projectionCopy = projectionLabel(node.projectionState);
            const projectionReady = !node.projectionState || node.projectionState === "ready";
            const expanded = node.hasChildren ? expandedNodeIds.has(node.nodeId) : undefined;
            const position = siblingInfo.get(node.nodeId);
            const presence = canvasPresence.get(node.nodeId);
            return (
              <div
                key={node.nodeId}
                role="treeitem"
                title={nodeTitle(node)}
                aria-level={(node.depth ?? 0) + 1}
                aria-selected={selected}
                aria-expanded={expanded}
                aria-posinset={position?.position}
                aria-setsize={position?.size}
                tabIndex={node.nodeId === rovingNodeId ? 0 : -1}
                ref={(element) => {
                  if (element) itemRefs.current.set(node.nodeId, element);
                  else itemRefs.current.delete(node.nodeId);
                }}
                className="tn-outline-node"
                style={{ "--tn-tree-depth": node.depth ?? 0 } as CSSProperties}
                data-selected={selected || undefined}
                data-focused={focused || undefined}
                data-drag-active={draggingNodeId === node.nodeId || undefined}
                data-projection={node.projectionState ?? "ready"}
                onClick={(event) => onSelectNode(node.nodeId, event.ctrlKey || event.metaKey)}
                onKeyDown={(event) => onTreeKeyDown(event, index)}
                draggable={canDragToCanvas && projection === "fresh" && projectionReady}
                onDragStart={(event) => {
                  if (!canDragToCanvas || projection !== "fresh" || !projectionReady) {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.effectAllowed = "copy";
                  const carried = selectedNodeIds.includes(node.nodeId)
                    ? selectedNodeIds
                    : [node.nodeId];
                  if (!selectedNodeIds.includes(node.nodeId)) onSelectNode(node.nodeId, false);
                  event.dataTransfer.setData(TENT_NODE_IDS_DRAG_TYPE, encodeNodeIdsDrag(carried));
                  event.dataTransfer.setData("text/plain", nodeTitle(node));
                  setDraggingNodeId(node.nodeId);
                }}
                onDragEnd={() => setDraggingNodeId(null)}
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
                  {selected ? <span className="tn-outline-meta">{projectionReady ? nodeTypeLabel(node.type) : projectionCopy}</span> : null}
                </span>
                {presence && presence.count > 0 ? (
                  <span
                    className="tn-outline-presence"
                    data-pending-sync={presence.pendingSync || undefined}
                    title={`当前画布中有 ${presence.count} 份投影${presence.pendingSync ? "，等待同步" : ""}`}
                    aria-label={`当前画布中有 ${presence.count} 份投影${presence.pendingSync ? "，等待同步" : ""}`}
                  >
                    {presence.count > 1 ? presence.count : <span aria-hidden="true">•</span>}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
