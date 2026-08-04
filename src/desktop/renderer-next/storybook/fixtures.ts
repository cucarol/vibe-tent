import type { CanvasDocument } from "../types/identity.js";
import type { ProjectionState, WorkbenchNodeView } from "../shell/workbench-types.js";

export const FIXTURE_WORKSPACE_ID = "ws-storybook-ui";

export function fixtureNodes(state: ProjectionState = "ready"): WorkbenchNodeView[] {
  const collaborationState =
    state === "ready" ? "ready" : state === "stale" ? "stale" : state === "error" ? "error" : "unknown";
  return [
    {
      nodeId: "cx-product",
      path: "产品方向",
      name: "产品方向",
      title: "把复杂协作变成可见的工作",
      type: "goal",
      tags: ["产品", "方向"],
      mode: "editable",
      archived: false,
      invalid: false,
      depth: 0,
      activeTaskState: state === "ready" ? null : undefined,
      collaborationState,
      projectionState: state,
      projectionMessage: state === "stale" ? "服务仍在线，但图投影已超过可用时限。" : state === "unresolved" ? "本地位置仍在，权威节点暂时无法解析。" : state === "error" ? "图投影查询失败；没有把缓存内容当作最新事实。" : undefined,
    },
    {
      nodeId: "cx-workbench",
      path: "产品方向/桌面工作台",
      name: "桌面工作台",
      title: "主界面：Canvas、节点与焦点",
      type: "prompt",
      tags: ["桌面", "UI"],
      mode: "editable",
      archived: false,
      invalid: false,
      depth: 1,
      activeTaskState: state === "ready" ? "running" : undefined,
      collaborationState,
      projectionState: state,
      projectionMessage: state === "stale" ? "协作状态未知，等待重新查询。" : undefined,
    },
    {
      nodeId: "cx-delivery",
      path: "产品方向/桌面工作台/视觉验收",
      name: "视觉验收",
      title: "主界面视觉与交互证据",
      type: "output",
      tags: ["交付"],
      mode: "editable",
      archived: false,
      invalid: false,
      depth: 2,
      activeTaskState: state === "ready" ? null : undefined,
      collaborationState,
      projectionState: state,
    },
  ];
}

export function fixtureCanvasDocument(): CanvasDocument {
  return {
    version: 1,
    backgroundMode: "grid",
    focusedPlacementId: "pl-workbench",
    viewport: { x: 0, y: 0, zoom: 1 },
    placements: [
      { placementId: "pl-product", entityRef: "cx-product", kind: "node", x: 110, y: 130, width: 260, height: 138 },
      { placementId: "pl-workbench", entityRef: "cx-workbench", kind: "node", x: 480, y: 170, width: 282, height: 152 },
      { placementId: "pl-delivery", entityRef: "cx-delivery", kind: "node", x: 500, y: 430, width: 260, height: 138 },
    ],
  };
}
