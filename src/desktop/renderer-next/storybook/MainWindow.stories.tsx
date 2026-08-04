import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../shell/AppShell.js";
import { focusWorkbenchNode } from "../shell/workbench-selection.js";
import type { ProjectionState } from "../shell/workbench-types.js";
import { fixtureCanvasDocument, fixtureNodes, FIXTURE_WORKSPACE_ID } from "./fixtures.js";
import type {
  FocusDocumentActions,
  FocusDocumentStatus,
  FocusDocumentView,
} from "../model/focus-document-controller.js";

type MainWindowPreviewProps = {
  state: ProjectionState;
  connection?: "online" | "offline" | "reconnecting";
  selectedNodeId?: string | null;
  selectedPlacement?: "placed" | "unplaced";
  documentStatus?: FocusDocumentStatus;
  expanded?: boolean;
};

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
  selectedPlacement: "placed" | "unplaced"
) {
  const document = fixtureCanvasDocument();
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

function MainWindowPreview({ state, connection = "online", selectedNodeId = "cx-workbench", selectedPlacement = "placed", documentStatus = "read", expanded = false }: MainWindowPreviewProps) {
  const [presentation, setPresentation] = useState(() => ({
    document: previewDocument(selectedNodeId, selectedPlacement),
    selectedNodeId,
  }));
  useEffect(() => {
    setPresentation({
      document: previewDocument(selectedNodeId, selectedPlacement),
      selectedNodeId,
    });
  }, [selectedNodeId, selectedPlacement, state]);
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
        key={`${documentStatus}:${expanded}`}
        workspaceId={FIXTURE_WORKSPACE_ID}
        workspaceLabel="产品工作区"
        initialNodes={fixtureNodes(state)}
        document={presentation.document}
        selectedNodeId={presentation.selectedNodeId}
        onPresentationChange={(update) => setPresentation((current) => update(current))}
        connection={connection}
        onRetryConnection={connection === "online" ? undefined : () => {}}
        focusDocument={focusDocument}
        focusDocumentActions={documentActions}
        initialFocusExpanded={expanded}
        graph={{ edges: { parent: [
          { parentNodeId: "cx-product", childNodeId: "cx-workbench" },
          { parentNodeId: "cx-workbench", childNodeId: "cx-delivery" },
        ] } }}
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
export const 正文阅读: Story = { name: "Focus · 阅读" };
export const 正文编辑: Story = { name: "Focus · 编辑", args: { documentStatus: "edit", expanded: true } };
export const 正文未保存: Story = { name: "Focus · 未保存", args: { documentStatus: "dirty", expanded: true } };
export const 正文保存中: Story = { name: "Focus · 保存中", args: { documentStatus: "saving", expanded: true } };
export const 正文冲突: Story = { name: "Focus · 版本冲突", args: { documentStatus: "conflict", expanded: true } };
export const 正文已过期: Story = { name: "Focus · 断线保留", args: { documentStatus: "stale", connection: "reconnecting", expanded: true } };
export const 正文错误: Story = { name: "Focus · 读取失败", args: { documentStatus: "error", expanded: true } };
export const 正文已归档: Story = { name: "Focus · 已归档", args: { documentStatus: "archived" } };
