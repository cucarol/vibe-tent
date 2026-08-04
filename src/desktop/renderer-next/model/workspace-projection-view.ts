import type { GraphProjection } from "../../../service/types.js";
import type { ProjectionResource } from "../gateway/protocol4-projections.js";
import type { WorkbenchNodeView } from "../shell/workbench-types.js";

export function projectionForConnection<T>(
  resource: ProjectionResource<T>,
  workspaceId: string,
  connection: "online" | "offline" | "reconnecting"
): ProjectionResource<T> {
  if (connection === "online" || resource.state === "stale" || resource.state === "error") {
    return resource;
  }
  const issue = {
    kind: "transport" as const,
    message:
      connection === "reconnecting"
        ? "正在恢复本地服务连接"
        : "本地服务连接已断开",
  };
  const failedAt = new Date().toISOString();
  if (resource.state === "ready") {
    return {
      state: "stale",
      workspaceId,
      previous: resource.value,
      issue,
      failedAt,
    };
  }
  if (resource.state === "loading" && resource.previous) return resource;
  if (connection === "reconnecting") return resource;
  return { state: "error", workspaceId, issue, failedAt };
}

export function graphPresentationState(
  graph: ProjectionResource<GraphProjection>
): "loading" | "ready" | "stale" | "error" {
  if (graph.state === "ready") return "ready";
  if (graph.state === "stale" || (graph.state === "loading" && graph.previous)) {
    return "stale";
  }
  if (graph.state === "idle" || graph.state === "loading") return "loading";
  return "error";
}

export function workspaceProjectionStatus(
  graph: ProjectionResource<GraphProjection>,
  nodes: readonly WorkbenchNodeView[]
): "loading" | "fresh" | "stale" | "unresolved" | "error" {
  const state = graphPresentationState(graph);
  if (state === "loading") return "loading";
  if (state === "error") return "error";
  if (state === "stale") return "stale";
  if (nodes.some((node) => node.projectionState === "unresolved")) {
    return "unresolved";
  }
  return "fresh";
}
