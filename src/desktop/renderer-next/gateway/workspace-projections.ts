import type {
  GraphLinkEdge,
  GraphProjection,
  GraphRelationEdge,
  OutputProvenance,
} from "../../../service/types.js";
import { normalizeOutputProvenance } from "../model/output-provenance-view.js";
import {
  normalizeWorkspaceCollaboration,
  type WorkspaceCollaborationView,
} from "../model/workspace-collaboration-view.js";

export const PROJECTION_TIMEOUT_MS = 12_000;

export type WorkspaceProjectionMap = {
  "graph.projection": {
    params: { workspaceId: string };
    result: GraphProjection;
  };
  "workspace.collaboration": {
    params: { workspaceId: string; nodeId?: string };
    result: WorkspaceCollaborationView;
  };
  "output.provenance": {
    params: { workspaceId: string; nodeId: string };
    result: OutputProvenance;
  };
};

export type WorkspaceProjectionMethod = keyof WorkspaceProjectionMap;
export type WorkspaceProjectionParams<M extends WorkspaceProjectionMethod> =
  WorkspaceProjectionMap[M]["params"];
export type WorkspaceProjectionResult<M extends WorkspaceProjectionMethod> =
  WorkspaceProjectionMap[M]["result"];

/** Raw IPC stays behind this closed map; components use named gateway methods. */
export type WorkspaceProjectionRpc = <M extends WorkspaceProjectionMethod>(
  method: M,
  params: WorkspaceProjectionParams<M>
) => Promise<unknown>;

export type ProjectionIssueKind =
  | "timeout"
  | "transport"
  | "unsupported"
  | "rpc"
  | "corrupt"
  | "request";

export type ProjectionIssue = {
  kind: ProjectionIssueKind;
  message: string;
  code?: number;
};

export type ProjectionRead<T> =
  | {
      ok: true;
      workspaceId: string;
      value: T;
      fetchedAt: string;
    }
  | {
      ok: false;
      workspaceId: string;
      issue: ProjectionIssue;
      failedAt: string;
    };

/**
 * UI resource state. Previous values are retained for diagnosis only; only a
 * `ready` resource is authoritative for Node/domain rendering.
 */
export type ProjectionResource<T> =
  | { state: "idle" }
  | { state: "loading"; workspaceId: string; previous?: T }
  | { state: "ready"; workspaceId: string; value: T; fetchedAt: string }
  | {
      state: "stale";
      workspaceId: string;
      previous: T;
      issue: ProjectionIssue;
      failedAt: string;
    }
  | {
      state: "error";
      workspaceId: string;
      issue: ProjectionIssue;
      failedAt: string;
    };

export function beginProjectionLoad<T>(
  current: ProjectionResource<T>,
  workspaceId: string
): ProjectionResource<T> {
  const previous =
    current.state === "ready" && current.workspaceId === workspaceId
      ? current.value
      : current.state === "stale" && current.workspaceId === workspaceId
        ? current.previous
        : undefined;
  return {
    state: "loading",
    workspaceId,
    ...(previous === undefined ? {} : { previous }),
  };
}

export function settleProjection<T>(
  current: ProjectionResource<T>,
  read: ProjectionRead<T>
): ProjectionResource<T> {
  if (read.ok) {
    return {
      state: "ready",
      workspaceId: read.workspaceId,
      value: read.value,
      fetchedAt: read.fetchedAt,
    };
  }
  const previous =
    current.state === "loading" && current.workspaceId === read.workspaceId
      ? current.previous
      : current.state === "ready" && current.workspaceId === read.workspaceId
        ? current.value
        : current.state === "stale" && current.workspaceId === read.workspaceId
          ? current.previous
          : undefined;
  return previous === undefined
    ? {
        state: "error",
        workspaceId: read.workspaceId,
        issue: read.issue,
        failedAt: read.failedAt,
      }
    : {
        state: "stale",
        workspaceId: read.workspaceId,
        previous,
        issue: read.issue,
        failedAt: read.failedAt,
      };
}

/** Never expose stale/loading cached data as current Service truth. */
export function authoritativeProjection<T>(
  resource: ProjectionResource<T>
): T | null {
  return resource.state === "ready" ? resource.value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeMode(value: unknown): value is "editable" | "archived" {
  return value === "editable" || value === "archived";
}

function parseLinkEdge(
  raw: unknown,
  knownNodeIds: ReadonlySet<string>,
  partition: "markdown" | "wiki",
  index: number
): GraphLinkEdge {
  if (!isRecord(raw)) {
    throw new Error(`graph.projection ${partition}[${index}] is not an object`);
  }
  const unresolved = raw.unresolved;
  const hasTarget = typeof raw.toNodeId === "string" && raw.toNodeId.length > 0;
  const hasUnresolved = isRecord(unresolved) && typeof unresolved.raw === "string";
  if (
    typeof raw.fromNodeId !== "string" ||
    !knownNodeIds.has(raw.fromNodeId) ||
    typeof raw.raw !== "string" ||
    !(raw.label === undefined || typeof raw.label === "string") ||
    hasTarget === hasUnresolved ||
    (hasTarget && !knownNodeIds.has(raw.toNodeId as string)) ||
    (hasUnresolved &&
      !(unresolved.target === undefined || typeof unresolved.target === "string"))
  ) {
    throw new Error(`graph.projection ${partition}[${index}] is corrupt`);
  }
  return {
    fromNodeId: raw.fromNodeId,
    raw: raw.raw,
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    ...(hasTarget ? { toNodeId: raw.toNodeId as string } : {}),
    ...(hasUnresolved
      ? {
          unresolved: {
            raw: unresolved.raw as string,
            ...(typeof unresolved.target === "string"
              ? { target: unresolved.target }
              : {}),
          },
        }
      : {}),
  };
}

function parseRelationEdge(
  raw: unknown,
  knownNodeIds: ReadonlySet<string>,
  index: number
): GraphRelationEdge {
  if (!isRecord(raw)) {
    throw new Error(`graph.projection relation[${index}] is not an object`);
  }
  const hasTarget = typeof raw.toNodeId === "string" && raw.toNodeId.length > 0;
  const hasUnresolved = typeof raw.unresolved === "string" && raw.unresolved.length > 0;
  if (
    typeof raw.id !== "string" ||
    !raw.id ||
    typeof raw.fromNodeId !== "string" ||
    !knownNodeIds.has(raw.fromNodeId) ||
    typeof raw.kind !== "string" ||
    !raw.kind ||
    (raw.direction !== "directed" && raw.direction !== "bidirectional") ||
    !(raw.label === undefined || typeof raw.label === "string") ||
    hasTarget === hasUnresolved
  ) {
    throw new Error(`graph.projection relation[${index}] is corrupt`);
  }
  const targetExists = hasTarget && knownNodeIds.has(raw.toNodeId as string);
  // A stored relation may point at a missing Node. Keep that absence explicit;
  // never expose its stale id as a resolved target or infer a Canvas endpoint.
  return {
    id: raw.id,
    fromNodeId: raw.fromNodeId,
    kind: raw.kind,
    direction: raw.direction,
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    ...(targetExists ? { toNodeId: raw.toNodeId as string } : {}),
    ...(hasUnresolved
      ? { unresolved: raw.unresolved as string }
      : hasTarget
        ? { unresolved: raw.toNodeId as string }
        : {}),
  };
}

export function normalizeGraphProjection(
  raw: unknown,
  expectedWorkspaceId: string
): { ok: true; value: GraphProjection } | { ok: false; message: string } {
  try {
    if (!isRecord(raw) || raw.workspaceId !== expectedWorkspaceId) {
      throw new Error("graph.projection workspaceId mismatch or payload is not an object");
    }
    if (!Array.isArray(raw.nodes) || !isRecord(raw.edges)) {
      throw new Error("graph.projection is missing nodes or edge partitions");
    }
    const edgeBags = raw.edges;
    if (
      !Array.isArray(edgeBags.parent) ||
      !Array.isArray(edgeBags.markdown) ||
      !Array.isArray(edgeBags.wiki) ||
      !Array.isArray(edgeBags.relation)
    ) {
      throw new Error("graph.projection edge partitions are corrupt");
    }

    const nodeIds = new Set<string>();
    const nodes: GraphProjection["nodes"] = raw.nodes.map((item, index) => {
      if (
        !isRecord(item) ||
        typeof item.nodeId !== "string" ||
        !item.nodeId ||
        typeof item.etag !== "string" ||
        !item.etag ||
        typeof item.path !== "string" ||
        typeof item.name !== "string" ||
        typeof item.type !== "string" ||
        !Array.isArray(item.tags) ||
        item.tags.some((tag) => typeof tag !== "string") ||
        !isNodeMode(item.mode) ||
        typeof item.archived !== "boolean" ||
        typeof item.invalid !== "boolean" ||
        !(item.title === undefined || typeof item.title === "string") ||
        nodeIds.has(item.nodeId)
      ) {
        throw new Error(`graph.projection nodes[${index}] is corrupt`);
      }
      nodeIds.add(item.nodeId);
      return {
        nodeId: item.nodeId,
        etag: item.etag,
        path: item.path,
        name: item.name,
        type: item.type,
        tags: [...item.tags] as string[],
        mode: item.mode,
        archived: item.archived,
        invalid: item.invalid,
        ...(typeof item.title === "string" ? { title: item.title } : {}),
      };
    });

    const parent: GraphProjection["edges"]["parent"] = edgeBags.parent.map(
      (item, index) => {
        if (
          !isRecord(item) ||
          !(item.parentNodeId === null ||
            (typeof item.parentNodeId === "string" && nodeIds.has(item.parentNodeId))) ||
          typeof item.childNodeId !== "string" ||
          !nodeIds.has(item.childNodeId)
        ) {
          throw new Error(`graph.projection parent[${index}] is corrupt`);
        }
        return {
          parentNodeId: item.parentNodeId,
          childNodeId: item.childNodeId,
        };
      }
    );
    const markdown = edgeBags.markdown.map((edge, index) =>
      parseLinkEdge(edge, nodeIds, "markdown", index)
    );
    const wiki = edgeBags.wiki.map((edge, index) =>
      parseLinkEdge(edge, nodeIds, "wiki", index)
    );
    const relation = edgeBags.relation.map((edge, index) =>
      parseRelationEdge(edge, nodeIds, index)
    );

    return {
      ok: true,
      value: {
        workspaceId: expectedWorkspaceId,
        nodes,
        edges: { parent, markdown, wiki, relation },
      },
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "graph.projection payload is corrupt",
    };
  }
}

class ProjectionTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`${method} timed out after ${timeoutMs}ms`);
    this.name = "ProjectionTimeoutError";
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  method: string,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ProjectionTimeoutError(method, timeoutMs)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function issueFromError(error: unknown): ProjectionIssue {
  if (error instanceof ProjectionTimeoutError) {
    return { kind: "timeout", message: error.message };
  }
  const record = isRecord(error) ? error : null;
  const code = record && typeof record.code === "number" ? record.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (code === -32601 || /method not found|unknown method/i.test(message)) {
    return { kind: "unsupported", message, ...(code === undefined ? {} : { code }) };
  }
  if (/offline|connection|econn|failed to fetch|network/i.test(message)) {
    return { kind: "transport", message, ...(code === undefined ? {} : { code }) };
  }
  return { kind: "rpc", message, ...(code === undefined ? {} : { code }) };
}

function invalidRequest(workspaceId: string, message: string): ProjectionRead<never> {
  return {
    ok: false,
    workspaceId,
    issue: { kind: "request", message },
    failedAt: new Date().toISOString(),
  };
}

async function readProjection<T>(args: {
  workspaceId: string;
  method: WorkspaceProjectionMethod;
  params: Record<string, unknown>;
  rpc: WorkspaceProjectionRpc;
  timeoutMs: number;
  normalize: (raw: unknown) => { ok: true; value: T } | { ok: false; message: string };
}): Promise<ProjectionRead<T>> {
  try {
    const raw = await withTimeout(
      args.rpc(
        args.method,
        args.params as WorkspaceProjectionParams<typeof args.method>
      ),
      args.method,
      args.timeoutMs
    );
    const normalized = args.normalize(raw);
    if (!normalized.ok) {
      return {
        ok: false,
        workspaceId: args.workspaceId,
        issue: { kind: "corrupt", message: normalized.message },
        failedAt: new Date().toISOString(),
      };
    }
    return {
      ok: true,
      workspaceId: args.workspaceId,
      value: normalized.value,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      workspaceId: args.workspaceId,
      issue: issueFromError(error),
      failedAt: new Date().toISOString(),
    };
  }
}

export function readGraphProjection(
  rpc: WorkspaceProjectionRpc,
  workspaceId: string,
  timeoutMs = PROJECTION_TIMEOUT_MS
): Promise<ProjectionRead<GraphProjection>> {
  const ws = workspaceId.trim();
  if (!ws) return Promise.resolve(invalidRequest(ws, "workspaceId is required"));
  return readProjection({
    workspaceId: ws,
    method: "graph.projection",
    params: { workspaceId: ws },
    rpc,
    timeoutMs,
    normalize: (raw) => normalizeGraphProjection(raw, ws),
  });
}

export function readWorkspaceCollaboration(
  rpc: WorkspaceProjectionRpc,
  workspaceId: string,
  nodeId: string | null,
  timeoutMs = PROJECTION_TIMEOUT_MS
): Promise<ProjectionRead<WorkspaceCollaborationView>> {
  const ws = workspaceId.trim();
  const id = nodeId?.trim() || null;
  if (!ws) return Promise.resolve(invalidRequest(ws, "workspaceId is required"));
  return readProjection({
    workspaceId: ws,
    method: "workspace.collaboration",
    params: { workspaceId: ws, ...(id ? { nodeId: id } : {}) },
    rpc,
    timeoutMs,
    normalize: (raw) => normalizeWorkspaceCollaboration(raw, ws, id),
  });
}

export function readOutputProvenance(
  rpc: WorkspaceProjectionRpc,
  workspaceId: string,
  outputId: string,
  timeoutMs = PROJECTION_TIMEOUT_MS
): Promise<ProjectionRead<OutputProvenance>> {
  const ws = workspaceId.trim();
  const id = outputId.trim();
  if (!ws) return Promise.resolve(invalidRequest(ws, "workspaceId is required"));
  if (!id) return Promise.resolve(invalidRequest(ws, "outputId is required"));
  return readProjection({
    workspaceId: ws,
    method: "output.provenance",
    params: { workspaceId: ws, nodeId: id },
    rpc,
    timeoutMs,
    normalize: (raw) => {
      const view = normalizeOutputProvenance(raw, ws, id);
      return view.state === "ready"
        ? { ok: true, value: view.value }
        : {
            ok: false,
            message:
              "message" in view
                ? view.message
                : "output.provenance did not return a ready projection",
          };
    },
  });
}
