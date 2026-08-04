import type {
  GraphProjection,
  NodeCollaborationsResult,
} from "../../../service/types.js";
import type { ProjectionResource } from "../gateway/workspace-projections.js";
import {
  activeTaskState,
  collaborationByNodeId,
} from "./node-collaboration-view.js";
import { graphPresentationState } from "./workspace-projection-view.js";
import { collaborationProjectionState, type WorkbenchNodeView } from "../shell/workbench-types.js";
import type { CanvasDocument } from "../types/identity.js";

export type ProvenanceView = { state: "ready" | "error"; label: string };

export function depthByNodeId(graph: GraphProjection): ReadonlyMap<string, number> {
  const parent = new Map<string, string>();
  for (const edge of graph.edges.parent) {
    if (edge.parentNodeId) parent.set(edge.childNodeId, edge.parentNodeId);
  }
  const depths = new Map<string, number>();
  const visit = (nodeId: string, seen = new Set<string>()): number => {
    if (depths.has(nodeId)) return depths.get(nodeId)!;
    if (seen.has(nodeId)) return 0;
    seen.add(nodeId);
    const parentId = parent.get(nodeId);
    const depth = parentId ? Math.min(8, visit(parentId, seen) + 1) : 0;
    depths.set(nodeId, depth);
    return depth;
  };
  for (const node of graph.nodes) visit(node.nodeId);
  return depths;
}

export function workbenchNodesFromResources(
  graphResource: ProjectionResource<GraphProjection>,
  collaborationResource: ProjectionResource<NodeCollaborationsResult>,
  document: CanvasDocument,
  provenance: ReadonlyMap<string, ProvenanceView> = new Map()
): WorkbenchNodeView[] {
  const graph =
    graphResource.state === "ready"
      ? graphResource.value
      : graphResource.state === "stale"
        ? graphResource.previous
        : graphResource.state === "loading"
          ? graphResource.previous ?? null
          : null;
  const graphState = graphPresentationState(graphResource);
  const collabs =
    collaborationResource.state === "ready"
      ? collaborationByNodeId(collaborationResource.value)
      : null;
  const collaborationState = collaborationProjectionState(
    collaborationResource.state
  );
  const result: WorkbenchNodeView[] = [];
  const known = new Set<string>();
  if (graph) {
    const depths = depthByNodeId(graph);
    for (const node of graph.nodes) {
      known.add(node.nodeId);
      result.push({
        nodeId: node.nodeId,
        path: node.path,
        name: node.name,
        title: node.title,
        type: node.type,
        tags: node.tags,
        mode: node.mode,
        archived: node.archived,
        invalid: node.invalid,
        depth: depths.get(node.nodeId) ?? 0,
        activeTaskState:
          graphState === "ready" && collaborationState === "ready" && collabs
            ? activeTaskState(collabs.get(node.nodeId))
            : undefined,
        collaborationState,
        projectionState: graphState,
        projectionMessage:
          graphState === "stale"
            ? "权威图投影需要重新查询；当前只保留本地位置。"
            : graphState === "error"
              ? "权威图投影不可用；没有把缓存当作最新事实。"
              : undefined,
        outputProvenance:
          node.type === "output" ? provenance.get(node.nodeId) : undefined,
      });
    }
  }
  for (const placement of document.placements) {
    if (!placement.entityRef || known.has(placement.entityRef)) continue;
    result.push({
      nodeId: placement.entityRef,
      path: "本地画布位置",
      name: "本地画布位置",
      type: "未知类型",
      tags: [],
      mode: "editable",
      archived: false,
      invalid: false,
      collaborationState: "unknown",
      projectionState:
        graphState === "error"
          ? "error"
          : graphState === "loading"
            ? "loading"
            : "unresolved",
      projectionMessage:
        graphState === "error"
          ? "图投影查询失败；本地位置已保留。"
          : graphState === "loading"
            ? "正在读取权威图投影；本地位置已保留。"
            : "权威投影中没有解析到这个 Node；本地位置已保留。",
    });
  }
  return result;
}
