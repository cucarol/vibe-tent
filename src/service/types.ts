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
  /** Spawn authority; omitted means deny. Never includes secrets. */
  a2aPolicy?: "allow" | "ask" | "deny";
};

/**
 * Machine-local AgentProfile projection for clients / editors.
 * Non-secret fields only — never env maps, API keys, tokens, or secret values.
 * Env *key names* and machine-local paths/URLs are allowed (not secret values).
 */
export type AgentProfileProjection = {
  id: string;
  adapterId: string;
  /** Human label for pickers (displayName, else displayNameKey map, else id). */
  displayName: string;
  displayNameKey?: string;
  /** Model id when known (e.g. grok-4.5); never credentials. */
  model?: string;
  /** Absolute path to provider executable on this machine (optional). */
  executable?: string;
  /** Process env *name* for API token — never the value. */
  envKey?: string;
  /**
   * Machine-local CredentialStore id referenced by this profile (not a secret).
   * Presence of the vault entry may be reported via credentialExists.
   */
  credentialRef?: string;
  /** true when credentialRef resolves to an existing vault entry (no secret). */
  credentialExists?: boolean;
  /** Process env *name* for base URL — never the value. */
  baseUrlEnvKey?: string;
  /** Optional machine-local literal base URL (not a workspace secret). */
  baseUrl?: string;
  /**
   * true = harness/test profile (fake-cli). Product UI should not default to these.
   */
  testOnly: boolean;
  /** Non-secret permission policy name for real providers. */
  permissionPolicy?: string;
  promptTimeoutMs?: number;
  permissionTimeoutMs?: number;
};

/**
 * Methods clients may call. AgentRuntimePort.* is intentionally absent.
 * B5 adds full task lifecycle + session projections + a2a resolve.
 * Desktop P0-1 adds read-only registry.* for coordination type + role pickers.
 * Desktop ACP launch surface adds profile.list/get + machine-local grok-acp CRUD.
 * Credential vault: credential.list/set/delete (no get plaintext).
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
  "profile.list",
  "profile.get",
  "profile.create",
  "profile.update",
  "profile.delete",
  /** Machine-local credential vault (user-only; never returns secret plaintext). */
  "credential.list",
  "credential.set",
  "credential.delete",
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
  /** ACP tool permission approvals (permissionPolicy=ask) — distinct from a2a.* spawn gate. */
  "toolApproval.listPending",
  "toolApproval.get",
  "toolApproval.approveOnce",
  "toolApproval.deny",
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
