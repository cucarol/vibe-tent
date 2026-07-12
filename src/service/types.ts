// Local Service wire types — B0 architecture §5.2 + attach protocol.

/** Structured association to a real deliverable outside concept identity. */
export type ArtifactRef = {
  kind: "path" | "dir" | "commit" | "url" | "other";
  /** Workspace-relative path, commit SHA, absolute URL, or other stable locator. */
  target: string;
  label?: string;
};

/** Common wire wrapper for all service fan-out events. */
export type EventEnvelope<TType extends string = string, TPayload = unknown> = {
  id: string;
  type: TType;
  workspaceId: string;
  ts: string;
  source: "service" | "self";
  payload: TPayload;
};

/** Role / orchestration spawn authority (evaluated only in service; B8 hardens). */
export type A2APolicy = "allow" | "ask" | "deny";

/**
 * Machine-local launch profile — binary paths, argv templates, auth refs.
 * Lives only in service data area; never in workspace git / concept bodies.
 */
export type AgentProfile = {
  id: string;
  adapterId: string;
  displayNameKey?: string;
};

export type ServiceHealth = {
  status: "ok" | "stopping";
  pid: number;
  version: string;
  startedAt: string;
  workspaceCount: number;
  foregroundWorkspaceId: string | null;
};

export type MountedWorkspaceInfo = {
  workspaceId: string;
  workspaceRoot: string;
  systemRoot: string;
  tentName: string;
  foreground: boolean;
};

export type ConceptProjection = {
  id: string;
  path: string;
  name: string;
  type: string;
  tags: string[];
  coordination: boolean;
  status?: string;
  assignee?: string;
  archived: boolean;
  invalid: boolean;
  bodyPreview?: string;
  children?: ConceptProjection[];
};

export type TaskProjection = {
  path: string;
  role: string;
  claims: string[];
  status: "pending" | "taken";
  manifest: string;
  dispatchedBy?: string;
  workspaceLane?: {
    workspace?: string;
    worktree?: string;
    branch?: string;
    targetBranch?: string;
  };
};

/** Methods clients may call. AgentRuntimePort.* is intentionally absent. */
export const CLIENT_METHODS = [
  "service.health",
  "service.subscribe",
  "workspace.mount",
  "workspace.unmount",
  "workspace.list",
  "workspace.setForeground",
  "docs.list",
  "docs.get",
  "docs.readForEdit",
  "docs.write",
  "docs.createNote",
  "docs.promote",
  "docs.fork",
  "task.dispatch",
  "task.claim",
  "task.list",
  "task.get",
] as const;

export type ClientMethod = (typeof CLIENT_METHODS)[number];

export function isClientMethod(method: string): method is ClientMethod {
  return (CLIENT_METHODS as readonly string[]).includes(method);
}

/** Collaboration projection fields protected while a box has an active task. */
export const PROTECTED_COLLAB_FIELDS = ["status", "owner", "assignee"] as const;
