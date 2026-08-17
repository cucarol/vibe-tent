import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../shell/AppShell.js";
import { focusWorkbenchNode } from "../shell/workbench-selection.js";
import type { ProjectionState, WorkbenchNodeView } from "../shell/workbench-types.js";
import { fixtureCanvasDocument, fixtureNodes, FIXTURE_WORKSPACE_ID } from "./fixtures.js";
import type {
  FocusDocumentActions,
  FocusDocumentStatus,
  FocusDocumentView,
} from "../model/focus-document-controller.js";
import type {
  CollaborationSurfaceActions,
  CollaborationSurfaceView,
} from "../model/collaboration-surface-controller.js";
import type { CollaborationActiveTask } from "../model/workspace-collaboration-view.js";
import {
  emptyTaskPackageDraft,
  updateTransientNodeSelection,
} from "../../task-package-draft.js";

type MainWindowPreviewProps = {
  state: ProjectionState;
  connection?: "online" | "offline" | "reconnecting";
  selectedNodeId?: string | null;
  selectedPlacement?: "placed" | "unplaced";
  documentStatus?: FocusDocumentStatus;
  expanded?: boolean;
  collaborationState?: "none" | "empty" | "active" | "result" | "decision" | "loading" | "stale" | "error";
  outlineMode?: "nodes" | "inbox";
  snapshotSourceState?: "current" | "changed" | "deleted" | "revision-unknown" | "authority-unknown";
};

const collaborationActions: CollaborationSurfaceActions = {
  async retry() {},
  async dispatch() { return true; },
  async acceptTaskResult() { return true; },
  async rejectTaskResult() { return true; },
  async respondDecision() { return true; },
};

function fixtureCollaboration(state: NonNullable<MainWindowPreviewProps["collaborationState"]>): CollaborationSurfaceView | undefined {
  if (state === "none") return undefined;
  const task: CollaborationActiveTask | null = state === "empty" || state === "loading" || state === "error" ? null : {
    taskId: "tk-ui",
    state: state === "result" ? "submitted" : state === "decision" ? "waiting" : "running",
    responsibility: { kind: "role" as const, roleId: "rl-ui", label: "界面" },
    execution: { kind: "connection" as const, connectionId: "cn-grok", label: "Grok UI" },
    readyResult: state === "result" ? { resultId: "rs-ui", summary: "已完成右侧协作闭环，并补齐状态与键盘验证。", createdAt: "2026-08-04T12:20:00.000Z" } : null,
    pendingDecision: state === "decision" ? { requestId: "dr-ui", question: "审阅区在窄侧栏中应优先展示摘要还是验证证据？", options: [{ id: "summary", label: "优先摘要" }, { id: "evidence", label: "优先验证证据" }] } : null,
  };
  const snapshot = {
    workspaceId: FIXTURE_WORKSPACE_ID,
    selectedNode: { nodeId: "cx-workbench", activeTasks: task ? [task] : [], statusDetail: null },
    inbox: { items: [], counts: { result: 0, decision: 0, total: 0 } },
  };
  return {
    workspaceId: FIXTURE_WORKSPACE_ID,
    nodeId: "cx-workbench",
    status: state === "loading" ? "loading" : state === "stale" ? "stale" : state === "error" ? "error" : "ready",
    snapshot: state === "loading" || state === "error" ? null : snapshot,
    targets: [{ kind: "role", id: "rl-ui", label: "界面" }, { kind: "connection", id: "cn-grok", label: "Grok UI" }],
    targetsReady: true,
    ...(state === "stale" || state === "error" ? { issue: { kind: "transport" as const, message: "本地服务暂时不可用" } } : {}),
    busyKey: null,
    canMutate: !["loading", "stale", "error"].includes(state),
  };
}

function fixtureNodesForCollaboration(
  projectionState: ProjectionState,
  collaborationState: NonNullable<MainWindowPreviewProps["collaborationState"]>
): WorkbenchNodeView[] {
  const nodes = fixtureNodes(projectionState);
  if (collaborationState === "none") return nodes;
  return nodes;
}

function fixtureDocument(status: FocusDocumentStatus): FocusDocumentView {
  const withoutSnapshot = status === "loading" || status === "error";
  const editing = ["edit", "dirty", "saving", "conflict"].includes(status);
  return {
    workspaceId: FIXTURE_WORKSPACE_ID,
    nodeId: "cx-workbench",
    status,
    mode: editing ? "edit" : "read",
    body: withoutSnapshot ? "" : "# Storybook workbench\n\n这是 **Focus Markdown** 的真实阅读与编辑区域。\n\n- Canvas 保持可见\n- 草稿不会因切换节点丢失\n- etag 冲突必须显式处理\n\n| 状态 | 处理 |\n| --- | --- |\n| 已连接 | 权威读取 |\n| 断线 | 保留草稿 |",
    ...(withoutSnapshot ? {} : { etag: "fixture-etag", path: "产品工作区/Storybook workbench" }),
    ...(status === "conflict" ? { diskBody: "# 磁盘上的新版本" } : {}),
    dirty: status === "dirty" || status === "saving" || status === "conflict",
    canSave: status === "dirty",
    archived: status === "archived",
    ...(status === "error" ? { message: "正文查询失败，请重试。" } : {}),
    backlinks: [{ fromNodeId: "cx-product", fromPath: "目标/Desktop UI", fromName: "Desktop UI", raw: "[[Storybook workbench]]", kind: "wiki" }],
    backlinksState: withoutSnapshot ? (status === "loading" ? "loading" : "error") : "ready",
  };
}

function previewDocument(
  selectedNodeId: string | null,
  selectedPlacement: "placed" | "unplaced",
  snapshotSourceState: NonNullable<MainWindowPreviewProps["snapshotSourceState"]>
) {
  let document = fixtureCanvasDocument();
  if (snapshotSourceState === "revision-unknown" && selectedNodeId) {
    document = {
      ...document,
      placements: document.placements.map((placement) => {
        if (placement.entityRef !== selectedNodeId) return placement;
        const snapshot = placement.meta?.tentNodeSnapshot;
        if (!snapshot || typeof snapshot !== "object") return placement;
        const { etag: _etag, ...legacy } = snapshot as Record<string, unknown>;
        return {
          ...placement,
          meta: { ...(placement.meta ?? {}), tentNodeSnapshot: legacy },
        };
      }),
    };
  }
  if (selectedPlacement === "placed" || !selectedNodeId) {
    return focusWorkbenchNode(document, selectedNodeId);
  }
  return focusWorkbenchNode({
    ...document,
    placements: document.placements.filter(
      (placement) => placement.entityRef !== selectedNodeId
    ),
  }, selectedNodeId);
}

function MainWindowPreview({ state, connection = "online", selectedNodeId = "cx-workbench", selectedPlacement = "placed", documentStatus = "read", expanded = false, collaborationState = "none", outlineMode = "nodes", snapshotSourceState = "current" }: MainWindowPreviewProps) {
  const [presentation, setPresentation] = useState(() => ({
    document: previewDocument(selectedNodeId, selectedPlacement, snapshotSourceState),
    focusedNodeId: selectedNodeId,
  }));
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(() =>
    selectedNodeId ? [selectedNodeId] : []
  );
  const [taskPackageDraft, setTaskPackageDraft] = useState(() =>
    emptyTaskPackageDraft()
  );
  useEffect(() => {
    setPresentation({
      document: previewDocument(selectedNodeId, selectedPlacement, snapshotSourceState),
      focusedNodeId: selectedNodeId,
    });
    setSelectedNodeIds(selectedNodeId ? [selectedNodeId] : []);
  }, [selectedNodeId, selectedPlacement, snapshotSourceState, state]);
  const previewNodes = useMemo(() => {
    const nodes = fixtureNodesForCollaboration(state, collaborationState);
    if (snapshotSourceState === "deleted") {
      return nodes.filter((node) => node.nodeId !== selectedNodeId);
    }
    if (snapshotSourceState === "changed") {
      return nodes.map((node) => node.nodeId === selectedNodeId
        ? { ...node, etag: `${node.etag}-changed` }
        : node);
    }
    return nodes;
  }, [collaborationState, selectedNodeId, snapshotSourceState, state]);
  const [focusDocument, setFocusDocument] = useState(() => fixtureDocument(documentStatus));
  const [canvasPreviewDocument, setCanvasPreviewDocument] = useState<{
    nodeId: string;
    status: "ready";
    body: string;
  } | null>(null);
  useEffect(() => {
    setFocusDocument(fixtureDocument(documentStatus));
  }, [documentStatus]);
  const documentActions = useMemo<FocusDocumentActions>(() => ({
    beginEdit: () => setFocusDocument((current) => ({
      ...current,
      mode: "edit",
      status: "edit",
      canSave: false,
    })),
    updateBody: (body) => setFocusDocument((current) => ({
      ...current,
      body,
      mode: "edit",
      status: "dirty",
      dirty: true,
      canSave: true,
    })),
    save: async () => {
      setFocusDocument((current) => ({
        ...current,
        status: "saving",
        canSave: false,
      }));
      await new Promise((resolve) => setTimeout(resolve, 240));
      setFocusDocument((current) => ({
        ...current,
        status: "saved",
        dirty: false,
        canSave: false,
      }));
    },
    discard: () => setFocusDocument(fixtureDocument("read")),
    loadDisk: () => setFocusDocument((current) => ({
      ...current,
      body: current.diskBody ?? current.body,
      mode: "read",
      status: "read",
      dirty: false,
      canSave: false,
      diskBody: undefined,
    })),
    overwriteWithLocal: async () => {
      setFocusDocument((current) => ({
        ...current,
        status: "saving",
        canSave: false,
      }));
      await new Promise((resolve) => setTimeout(resolve, 240));
      setFocusDocument((current) => ({
        ...current,
        status: "saved",
        dirty: false,
        canSave: false,
        diskBody: undefined,
      }));
    },
    retry: async () => setFocusDocument(fixtureDocument("read")),
  }), []);
  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden" }} data-testid="storybook-main-window" data-fixture-state={state}>
      <AppShell
        key={`${documentStatus}:${expanded}:${collaborationState}:${outlineMode}`}
        workspaceId={FIXTURE_WORKSPACE_ID}
        workspaceLabel="产品工作区"
        initialNodes={previewNodes}
        document={presentation.document}
        focusedNodeId={presentation.focusedNodeId}
        selectedNodeIds={selectedNodeIds}
        onNodeSelectionChange={(nodeId, toggle) => setSelectedNodeIds((current) =>
          updateTransientNodeSelection(current, nodeId, toggle)
        )}
        onPresentationChange={(update) => setPresentation((current) => update(current))}
        connection={connection}
        onRetryConnection={connection === "online" ? undefined : () => {}}
        focusDocument={focusDocument}
        canvasPreviewDocument={canvasPreviewDocument}
        onCanvasPreviewNode={(nodeId) => setCanvasPreviewDocument(nodeId
          ? {
            nodeId,
            status: "ready",
            body: `这是 ${nodeId} 的权威只读正文预览。`,
          }
          : null)}
        focusDocumentActions={documentActions}
        collaboration={fixtureCollaboration(collaborationState)}
        collaborationActions={collaborationState === "none" ? undefined : collaborationActions}
        taskPackageDraft={taskPackageDraft}
        onTaskPackageDraftChange={setTaskPackageDraft}
        initialInspectorTab={collaborationState === "none" ? "content" : "collaboration"}
        initialFocusExpanded={expanded}
        initialOutlineMode={outlineMode}
      />
    </div>
  );
}

const meta = {
  title: "主界面/完整工作台",
  component: MainWindowPreview,
  parameters: { layout: "fullscreen" },
  args: { state: "ready", connection: "online", selectedNodeId: "cx-workbench", selectedPlacement: "placed", documentStatus: "read", expanded: false },
} satisfies Meta<typeof MainWindowPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 正常选中: Story = { name: "正常 · 已选中节点" };
export const 工作台1440: Story = {
  name: "布局 · 工作台 1440×900",
  parameters: { viewport: { defaultViewport: "desktop" } },
};
export const 工作台1280: Story = {
  name: "布局 · 工作台 1280×840",
  parameters: { viewport: { defaultViewport: "compactDesktop" } },
};
export const 收件箱模式1440: Story = {
  name: "左栏 · 收件箱 1440×900",
  args: { outlineMode: "inbox" },
  parameters: { viewport: { defaultViewport: "desktop" } },
};
export const 尚未放入画布: Story = {
  name: "正常 · 尚未放入画布",
  args: { selectedNodeId: "cx-result", selectedPlacement: "unplaced" },
};
export const 数据过期: Story = { name: "过期 · 保留本地位置", args: { state: "stale" } };
export const 数据过期不可放入: Story = {
  name: "过期 · 禁止创建本地位置",
  args: {
    state: "stale",
    connection: "reconnecting",
    selectedNodeId: "cx-result",
    selectedPlacement: "unplaced",
  },
};
export const 节点未解析: Story = { name: "未解析 · 不伪装权威节点", args: { state: "unresolved" } };
export const 投影失败: Story = { name: "错误 · 查询失败", args: { state: "error", connection: "offline" } };
export const 快照来源一致: Story = { name: "快照 · 来源一致", args: { snapshotSourceState: "current" } };
export const 快照来源变化: Story = { name: "快照 · 来源有更新", args: { snapshotSourceState: "changed" } };
export const 子树投影待同步: Story = {
  name: "画布 · 子树投影待同步",
  args: { selectedNodeId: "cx-product", snapshotSourceState: "changed" },
};
export const 快照源节点删除: Story = { name: "快照 · 源节点已删除", args: { snapshotSourceState: "deleted" } };
export const 快照版本未知: Story = { name: "快照 · 旧版本未知", args: { snapshotSourceState: "revision-unknown" } };
export const 快照来源未知: Story = { name: "快照 · 来源状态未知", args: { snapshotSourceState: "authority-unknown", state: "stale", connection: "reconnecting" } };
export const 正文阅读: Story = { name: "Focus · 阅读" };
export const 正文编辑: Story = { name: "Focus · 编辑", args: { documentStatus: "edit", expanded: true } };
export const 正文未保存: Story = { name: "Focus · 未保存", args: { documentStatus: "dirty", expanded: true } };
export const 正文保存中: Story = { name: "Focus · 保存中", args: { documentStatus: "saving", expanded: true } };
export const 正文冲突: Story = { name: "Focus · 版本冲突", args: { documentStatus: "conflict", expanded: true } };
export const 正文已过期: Story = { name: "Focus · 断线保留", args: { documentStatus: "stale", connection: "reconnecting", expanded: true } };
export const 正文错误: Story = { name: "Focus · 读取失败", args: { documentStatus: "error", expanded: true } };
export const 正文已归档: Story = { name: "Focus · 已归档", args: { documentStatus: "archived" } };
export const 协作空闲: Story = { name: "协作 · 空闲与派活入口", args: { collaborationState: "empty" } };
export const 协作活动任务: Story = { name: "协作 · 活动任务", args: { collaborationState: "active" } };
export const 协作待审交付: Story = { name: "协作 · 待审交付", args: { collaborationState: "result" } };
export const 协作决策请求: Story = { name: "协作 · 决策请求", args: { collaborationState: "decision" } };
export const 协作加载中: Story = { name: "协作 · 首次加载", args: { collaborationState: "loading" } };
export const 协作已过期: Story = { name: "协作 · 断线保留", args: { collaborationState: "stale", connection: "reconnecting" } };
export const 协作读取失败: Story = { name: "协作 · 读取失败", args: { collaborationState: "error" } };
