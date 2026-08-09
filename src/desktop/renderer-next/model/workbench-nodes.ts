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
import { captureCanvasNodeSnapshot } from "./canvas-node-snapshot.js";
import type { CanvasSubtreeNodeSource } from "./canvas-subtree-projection.js";

export type ProvenanceView = { state: "ready" | "error"; label: string };

export function canvasSubtreeSourcesFromGraph(
  graph: GraphProjection
): CanvasSubtreeNodeSource[] {
  const parents = parentByNodeId(graph);
  return graph.nodes.map((node) => ({
    nodeId: node.nodeId,
    parentNodeId: parents.get(node.nodeId) ?? null,
    snapshot: {
      ...captureCanvasNodeSnapshot(node),
      etag: node.etag,
    },
  }));
}

export function readFreshCanvasSubtreeAuthority(
  resource: ProjectionResource<GraphProjection>,
  workspaceId: string,
  online: boolean
): CanvasSubtreeNodeSource[] | null {
  if (
    !online ||
    resource.state !== "ready" ||
    resource.workspaceId !== workspaceId ||
    resource.value.workspaceId !== workspaceId
  ) return null;
  return canvasSubtreeSourcesFromGraph(resource.value);
}

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

export function parentByNodeId(
  graph: GraphProjection
): ReadonlyMap<string, string | null> {
  const parents = new Map<string, string | null>();
  for (const edge of graph.edges.parent) {
    if (!parents.has(edge.childNodeId)) {
      parents.set(edge.childNodeId, edge.parentNodeId);
    }
  }
  for (const node of graph.nodes) {
    if (!parents.has(node.nodeId)) parents.set(node.nodeId, null);
  }
  return parents;
}

export function workbenchNodesFromResources(
  graphResource: ProjectionResource<GraphProjection>,
  collaborationResource: ProjectionResource<NodeCollaborationsResult>,
  _document: CanvasDocument,
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
  if (graph) {
    const depths = depthByNodeId(graph);
    const parents = parentByNodeId(graph);
    const parentsWithChildren = new Set(
      graph.edges.parent
        .map((edge) => edge.parentNodeId)
        .filter((nodeId): nodeId is string => Boolean(nodeId))
    );
    for (const node of graph.nodes) {
      result.push({
        nodeId: node.nodeId,
        etag: node.etag,
        path: node.path,
        name: node.name,
        title: node.title,
        type: node.type,
        tags: node.tags,
        mode: node.mode,
        archived: node.archived,
        invalid: node.invalid,
        parentNodeId: parents.get(node.nodeId) ?? null,
        hasChildren: parentsWithChildren.has(node.nodeId),
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
  return result;
}
