// Local Service wire types — B0 architecture §5.2 + attach protocol + B5 task surface.

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

/** Role / orchestration spawn authority (evaluated only in service). */
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
  id?: string;
  role: string;
  claims: string[];
  /** Legacy envelope status (pending|taken). */
  status: "pending" | "taken";
  /** Full lifecycle state (task-api §2). */
  state: string;
  manifest: string;
  dispatchedBy?: string;
  deliveryPolicy?: string;
  assigneeKind?: string;
  sessionId?: string;
  wait?: { reason: string; summary: string };
  activeDeliveryId?: string;
  workspaceLane?: {
    workspace?: string;
    worktree?: string;
    branch?: string;
    targetBranch?: string;
  };
  createdAt?: string;
  updatedAt?: string;
  prompt?: string;
};

export type DeliveryProjection = {
  path: string;
  id: string;
  taskId: string;
  boxId: string;
  role: string;
  status: string;
  summary: string;
  commits: string[];
  integrationMode: string | null;
  review?: { by: string; decision: string; note?: string };
  createdAt?: string;
  updatedAt?: string;
};

export type SessionProjection = {
  sessionId: string;
  profileId: string;
  adapterId: string;
  state: string;
  roleName?: string;
  /** PID is machine-local diagnostic; clients may show status only. */
  alive: boolean;
  resumeCapable: boolean;
  lastTaskId?: string;
  workspace?: string;
  createdAt?: string;
  updatedAt?: string;
};

/** Project type registry row (read-only projection for clients). */
export type TypeRegistryEntryProjection = {
  name: string;
  tier: "base" | "modifier";
  readable?: boolean;
  writable?: boolean;
  /** Only meaningful for base types; modifiers omit / false. */
  coordination: boolean;
  color?: string;
  description?: string;
};

/** Project role registry row (read-only projection for clients). */
export type RoleRegistryEntryProjection = {
  name: string;
  description?: string;
  color?: string;
  prompt?: string;
};

/**
 * Methods clients may call. AgentRuntimePort.* is intentionally absent.
 * B5 adds full task lifecycle + session projections + a2a resolve.
 * Desktop P0-1 adds read-only registry.* for coordination type + role pickers.
 */
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
  "docs.search",
  "docs.backlinks",
  "registry.types",
  "registry.roles",
  "task.dispatch",
  "task.claim",
  "task.wait",
  "task.resume",
  "task.deliver",
  "task.requestReview",
  "task.accept",
  "task.reject",
  "task.interrupt",
  "task.cancel",
  "task.startSession",
  "task.list",
  "task.get",
  "delivery.list",
  "delivery.get",
  "session.list",
  "session.get",
  "a2a.listPending",
  "a2a.resolve",
] as const;

export type ClientMethod = (typeof CLIENT_METHODS)[number];

export function isClientMethod(method: string): method is ClientMethod {
  return (CLIENT_METHODS as readonly string[]).includes(method);
}

/** Collaboration projection fields protected while a box has an active task. */
export const PROTECTED_COLLAB_FIELDS = ["status", "owner", "assignee"] as const;

/** JSON-RPC auth failure. */
export const RPC_UNAUTHORIZED = -32001;
export const RPC_A2A_DENIED = -32020;
export const RPC_A2A_ASK = -32021;
export const RPC_LIFECYCLE = -32022;
