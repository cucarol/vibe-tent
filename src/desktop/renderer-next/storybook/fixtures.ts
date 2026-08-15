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
      hasChildren: true,
      depth: 2,
      projectionState: state,
    },
    ...([
      ["cx-delegation", "产品方向/委托与接纳", "委托与接纳", "从 Node 到可接纳结果", "cx-product", 1, true],
      ["cx-inbox", "产品方向/行动收件箱", "行动收件箱", "只呈现需要用户处理的事项", "cx-product", 1, true],
      ["cx-sync", "产品方向/画布同步", "画布同步", "投影变化一次同步", "cx-product", 1, false],
      ["cx-shell", "产品方向/桌面工作台/三栏职责", "三栏职责", "结构、投影与详情各归其位", "cx-workbench", 2, true],
      ["cx-outline", "产品方向/桌面工作台/三栏职责/节点树", "节点树", "权威结构与收件箱入口", "cx-shell", 3, false],
      ["cx-canvas", "产品方向/桌面工作台/三栏职责/画布", "画布", "冻结投影与空间编排", "cx-shell", 3, true],
      ["cx-inspector", "产品方向/桌面工作台/三栏职责/详情", "详情", "正文、协作与接纳操作", "cx-shell", 3, false],
      ["cx-relations", "产品方向/桌面工作台/三栏职责/画布/结构线", "结构线", "安静且实时的父子关系", "cx-canvas", 4, false],
      ["cx-drag", "产品方向/桌面工作台/三栏职责/画布/拖放", "拖放", "从节点树创建本地投影", "cx-canvas", 4, false],
      ["cx-fold", "产品方向/桌面工作台/三栏职责/画布/折叠", "折叠", "按局部子树逐层展开", "cx-canvas", 4, false],
      ["cx-duplicate", "产品方向/桌面工作台/三栏职责/画布/副本", "重复投影", "同一节点的独立空间副本", "cx-canvas", 4, false],
      ["cx-role", "产品方向/委托与接纳/责任角色", "责任角色", "先选择由谁负责", "cx-delegation", 2, false],
      ["cx-connection", "产品方向/委托与接纳/执行连接", "执行连接", "机器执行配置保持次要", "cx-delegation", 2, false],
      ["cx-result-flow", "产品方向/委托与接纳/结果", "结果", "完整内容在 Tent 内可见", "cx-delegation", 2, false],
      ["cx-ready-results", "产品方向/行动收件箱/待接纳结果", "待接纳结果", "只显示可处理的返回内容", "cx-inbox", 2, false],
      ["cx-decisions", "产品方向/行动收件箱/待决定事项", "待决定事项", "需要用户选择时才出现", "cx-inbox", 2, false],
      ["cx-evidence", "产品方向/桌面工作台/视觉验收/交互证据", "交互证据", "真实拖放、折叠与持久化", "cx-result", 3, false],
      ["cx-accessibility", "产品方向/桌面工作台/视觉验收/可达性", "可达性", "键盘、焦点与减弱动效", "cx-result", 3, false],
    ] as const).map(([nodeId, path, name, title, parentNodeId, depth, hasChildren]) => ({
      nodeId,
      etag: `etag-${nodeId}-v1`,
      path,
      name,
      title,
      type: "node",
      tags: ["MVP"],
      mode: "editable",
      archived: false,
      invalid: false,
      parentNodeId,
      hasChildren,
      depth,
      projectionState: state,
    } satisfies WorkbenchNodeView)),
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
