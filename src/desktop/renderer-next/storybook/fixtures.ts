import type { CanvasDocument } from "../types/identity.js";
import type { ProjectionState, WorkbenchNodeView } from "../shell/workbench-types.js";
import {
  captureCanvasNodeSnapshot,
  withCanvasNodeSnapshot,
} from "../model/canvas-node-snapshot.js";
import { NODE_CARD } from "../model/canvas-document.js";
import {
  type SubtreeDirection,
  withCanvasSubtreePlacementMeta,
} from "../model/canvas-subtree-projection.js";

export const FIXTURE_WORKSPACE_ID = "ws-storybook-ui";

export function fixtureNodes(state: ProjectionState = "ready"): WorkbenchNodeView[] {
  return [
    {
      nodeId: "cx-product",
      etag: "etag-product-v1",
      path: "产品方向",
      name: "产品方向",
      title: "把复杂协作变成可见的工作",
      type: "goal",
      tags: ["产品", "方向"],
      mode: "editable",
      archived: false,
      invalid: false,
      parentNodeId: null,
      hasChildren: true,
      depth: 0,
      projectionState: state,
      projectionMessage: state === "stale" ? "服务仍在线，但图投影已超过可用时限。" : state === "unresolved" ? "本地位置仍在，权威节点暂时无法解析。" : state === "error" ? "图投影查询失败；没有把缓存内容当作最新事实。" : undefined,
    },
    {
      nodeId: "cx-workbench",
      etag: "etag-workbench-v1",
      path: "产品方向/桌面工作台",
      name: "桌面工作台",
      title: "主界面：Canvas、节点与焦点",
      type: "prompt",
      tags: ["桌面", "UI"],
      mode: "editable",
      archived: false,
      invalid: false,
      parentNodeId: "cx-product",
      hasChildren: true,
      depth: 1,
      projectionState: state,
      projectionMessage: state === "stale" ? "协作状态未知，等待重新查询。" : undefined,
    },
    {
      nodeId: "cx-research",
      etag: "etag-research-v1",
      path: "产品方向/交互原则",
      name: "交互原则",
      title: "稳定、克制的空间交互",
      type: "prompt",
      tags: ["体验", "原则"],
      mode: "editable",
      archived: false,
      invalid: false,
      parentNodeId: "cx-product",
      hasChildren: false,
      depth: 1,
      projectionState: state,
    },
    {
      nodeId: "cx-result",
      etag: "etag-result-v1",
      path: "产品方向/桌面工作台/视觉验收",
      name: "视觉验收",
      title: "主界面视觉与交互证据",
      type: "output",
      tags: ["交付"],
      mode: "editable",
      archived: false,
      invalid: false,
      parentNodeId: "cx-workbench",
      hasChildren: false,
      depth: 2,
      projectionState: state,
    },
  ];
}

export function fixtureCanvasDocument(): CanvasDocument {
  const byId = new Map(fixtureNodes().map((node) => [node.nodeId, node] as const));
  const instanceId = "subtree-storybook-product";
  const placement = (
    value: CanvasDocument["placements"][number],
    subtree: {
      parentPlacementId: string | null;
      depth: number;
      siblingOrder: number;
      expandedDirection: SubtreeDirection | null;
    }
  ) => {
    const node = value.entityRef ? byId.get(value.entityRef) : undefined;
    const frozen = node
      ? withCanvasNodeSnapshot(value, captureCanvasNodeSnapshot(node))
      : value;
    return withCanvasSubtreePlacementMeta(frozen, {
      version: 1,
      instanceId,
      rootPlacementId: "pl-product",
      parentPlacementId: subtree.parentPlacementId,
      depth: subtree.depth,
      siblingOrder: subtree.siblingOrder,
      expandedDirection: subtree.expandedDirection,
      lastDirection: "down",
    });
  };
  return {
    version: 1,
    backgroundMode: "blank",
    focusedPlacementId: "pl-workbench",
    viewport: { x: 0, y: 0, zoom: 1 },
    placements: [
      placement(
        { placementId: "pl-product", entityRef: "cx-product", kind: "node", x: 224, y: 80, width: NODE_CARD.width, height: NODE_CARD.height },
        { parentPlacementId: null, depth: 0, siblingOrder: 0, expandedDirection: "down" }
      ),
      placement(
        { placementId: "pl-workbench", entityRef: "cx-workbench", kind: "node", x: 76, y: 260, width: NODE_CARD.width, height: NODE_CARD.height },
        { parentPlacementId: "pl-product", depth: 1, siblingOrder: 0, expandedDirection: "down" }
      ),
      placement(
        { placementId: "pl-research", entityRef: "cx-research", kind: "node", x: 372, y: 260, width: NODE_CARD.width, height: NODE_CARD.height },
        { parentPlacementId: "pl-product", depth: 1, siblingOrder: 1, expandedDirection: null }
      ),
      placement(
        { placementId: "pl-result", entityRef: "cx-result", kind: "node", x: 76, y: 440, width: NODE_CARD.width, height: NODE_CARD.height },
        { parentPlacementId: "pl-workbench", depth: 2, siblingOrder: 0, expandedDirection: null }
      ),
    ],
  };
}
