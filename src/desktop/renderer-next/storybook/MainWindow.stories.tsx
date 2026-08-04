import type { Meta, StoryObj } from "@storybook/react";
import { AppShell } from "../shell/AppShell.js";
import type { ProjectionState } from "../shell/workbench-types.js";
import { fixtureCanvasDocument, fixtureNodes, FIXTURE_WORKSPACE_ID } from "./fixtures.js";

type MainWindowPreviewProps = {
  state: ProjectionState;
  connection?: "online" | "offline" | "reconnecting";
  selectedNodeId?: string | null;
};

function MainWindowPreview({ state, connection = "online", selectedNodeId = "cx-workbench" }: MainWindowPreviewProps) {
  return (
    <div style={{ width: 1440, height: 900, overflow: "hidden" }} data-testid="storybook-main-window" data-fixture-state={state}>
      <AppShell
        workspaceId={FIXTURE_WORKSPACE_ID}
        workspaceLabel="产品工作区"
        initialNodes={fixtureNodes(state)}
        initialDocument={fixtureCanvasDocument()}
        initialSelectedNodeId={selectedNodeId}
        connection={connection}
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
  args: { state: "ready", connection: "online", selectedNodeId: "cx-workbench" },
} satisfies Meta<typeof MainWindowPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 正常选中: Story = { name: "正常 · 已选中节点" };
export const 数据过期: Story = { name: "过期 · 保留本地位置", args: { state: "stale" } };
export const 节点未解析: Story = { name: "未解析 · 不伪装权威节点", args: { state: "unresolved" } };
export const 投影失败: Story = { name: "错误 · 查询失败", args: { state: "error", connection: "offline" } };
