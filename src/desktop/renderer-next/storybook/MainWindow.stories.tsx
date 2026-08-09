import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../shell/AppShell.js";
import { focusWorkbenchNode } from "../shell/workbench-selection.js";
import type {
  CollaborationProjectionState,
  ProjectionState,
  WorkbenchNodeView,
} from "../shell/workbench-types.js";
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

type MainWindowPreviewProps = {
  state: ProjectionState;
  connection?: "online" | "offline" | "reconnecting";
  selectedNodeId?: string | null;
  selectedPlacement?: "placed" | "unplaced";
  documentStatus?: FocusDocumentStatus;
  expanded?: boolean;
  collaborationState?: "none" | "empty" | "active" | "delivery" | "decision" | "loading" | "stale" | "error";
  outlineMode?: "nodes" | "inbox";
  snapshotSourceState?: "current" | "changed" | "deleted" | "revision-unknown" | "authority-unknown";
};

const collaborationActions: CollaborationSurfaceActions = {
  async retry() {},
  async dispatch() { return true; },
  async acceptDelivery() { return true; },
  async rejectDelivery() { return true; },
  async respondDecision() { return true; },
};

function fixtureCollaboration(state: NonNullable<MainWindowPreviewProps["collaborationState"]>): CollaborationSurfaceView | undefined {
  if (state === "none") return undefined;
  const task = state === "empty" || state === "loading" || state === "error" ? null : {
    id: "tk-ui",
    path: "temp/UI/tasks/ui.md",
    state: state === "delivery" ? "delivered" : state === "decision" ? "waiting" : "running",
    workNodeIds: ["cx-workbench"],
    contextNodeIds: ["cx-product"],
    acceptMode: state === "delivery" ? "agent-decide" as const : "review-required" as const,
    assignee: { kind: "connection" as const, label: "Grok UI" },
    sessionId: "ss-ui",
    session: { id: "ss-ui", state: "live", alive: true, turnBusy: state === "active", connectionLabel: "Grok UI" },
    updatedAt: "2026-08-04T12:20:00.000Z",
  };
  const snapshot = {
    workspaceId: FIXTURE_WORKSPACE_ID,
    nodeId: "cx-workbench",
    targets: [
      { kind: "role" as const, id: "rl-ui", label: "界面" },
      { kind: "connection" as const, id: "cn-grok", label: "Grok UI" },
    ],
    task,
    delivery: state === "delivery" ? {
      id: "dl-ui",
      taskId: "tk-ui",
      taskPath: "temp/UI/tasks/ui.md",
      sourceNodeId: "cx-workbench",
      summary: "已完成右侧协作闭环，并补齐状态与键盘验证。",
      status: "ready" as const,
      createdAt: "2026-08-04T12:20:00.000Z",
    } : null,
    decisions: state === "decision" ? [{
      id: "dr-ui",
      taskId: "tk-ui",
      taskPath: "temp/UI/tasks/ui.md",
      question: "审阅区在窄侧栏中应优先展示摘要还是验证证据？",
      options: [{ id: "summary", label: "优先摘要" }, { id: "evidence", label: "优先验证证据" }],
      createdAt: "2026-08-04T12:20:00.000Z",
    }] : [],
  };
  return {
    workspaceId: FIXTURE_WORKSPACE_ID,
    nodeId: "cx-workbench",
    status: state === "loading" ? "loading" : state === "stale" ? "stale" : state === "error" ? "error" : "ready",
    snapshot: state === "loading" || state === "error" ? null : snapshot,
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
  const selectedCollaborationState: CollaborationProjectionState = collaborationState === "loading"
    ? "refreshing"
    : collaborationState === "stale"
      ? "stale"
      : collaborationState === "error"
        ? "error"
        : "ready";
  const activeTaskState = collaborationState === "active"
    ? "running"
    : collaborationState === "delivery"
      ? "delivered"
      : collaborationState === "decision"
        ? "waiting"
        : collaborationState === "empty"
          ? null
          : undefined;
  return nodes.map((node) => node.nodeId === "cx-workbench"
    ? {
        ...node,
        collaborationState: selectedCollaborationState,
        activeTaskState,
      }
    : node);
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
    artifactRefs: [],
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
    selectedNodeId,
  }));
  useEffect(() => {
    setPresentation({
      document: previewDocument(selectedNodeId, selectedPlacement, snapshotSourceState),
      selectedNodeId,
    });
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
        selectedNodeId={presentation.selectedNodeId}
        onPresentationChange={(update) => setPresentation((current) => update(current))}
        connection={connection}
        onRetryConnection={connection === "online" ? undefined : () => {}}
        focusDocument={focusDocument}
        focusDocumentActions={documentActions}
        collaboration={fixtureCollaboration(collaborationState)}
        collaborationActions={collaborationState === "none" ? undefined : collaborationActions}
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
  args: { selectedNodeId: "cx-delivery", selectedPlacement: "unplaced" },
};
export const 数据过期: Story = { name: "过期 · 保留本地位置", args: { state: "stale" } };
export const 数据过期不可放入: Story = {
  name: "过期 · 禁止创建本地位置",
  args: {
    state: "stale",
    connection: "reconnecting",
    selectedNodeId: "cx-delivery",
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
export const 协作待审交付: Story = { name: "协作 · 待审交付", args: { collaborationState: "delivery" } };
export const 协作决策请求: Story = { name: "协作 · 决策请求", args: { collaborationState: "decision" } };
export const 协作加载中: Story = { name: "协作 · 首次加载", args: { collaborationState: "loading" } };
export const 协作已过期: Story = { name: "协作 · 断线保留", args: { collaborationState: "stale", connection: "reconnecting" } };
export const 协作读取失败: Story = { name: "协作 · 读取失败", args: { collaborationState: "error" } };
