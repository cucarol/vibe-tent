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

/** Node lifecycle mode on the wire (document semantics; not Task state). */
export type NodeMode = "editable" | "read-only" | "archived";

export type ConceptProjection = {
  id: string;
  path: string;
  name: string;
  type: string;
  tags: string[];
  coordination: boolean;
  status?: string;
  assignee?: string;
  /** Effective mode after inheritance (archived cascades). */
  mode: NodeMode;
  /** Convenience: mode === "archived". */
  archived: boolean;
  invalid: boolean;
  bodyPreview?: string;
  children?: ConceptProjection[];
};

/**
 * Stable box collaboration projection (task-api §2.3 / `box.projection`).
 * Active task is authoritative; without one, only persisted `done` is preserved.
 */
export type BoxProjection = {
  workspaceId: string;
  boxId: string;
  status: "todo" | "doing" | "done";
  assignee?: string;
  activeTaskId?: string;
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
  /** Peer vs sub; missing/false = peer. */
  asSub?: boolean;
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

/**
 * Proposal projection for triage — separate from task delivery review.
 * Maps core Proposal; status is pending | accepted | rejected.
 */
export type ProposalProjection = {
  path: string;
  boxId: string;
  role: string;
  status: "pending" | "accepted" | "rejected";
  createdAt?: string;
  body: string;
};

export type SessionProjection = {
  sessionId: string;
  profileId: string;
  adapterId: string;
  state: string;
  roleName?: string;
  /** Missing/undefined reads as role for older session rows. */
  assigneeKind?: "role" | "agentProfile";
  /** PID is machine-local diagnostic; clients may show status only. */
  alive: boolean;
  resumeCapable: boolean;
  lastTaskId?: string;
  workspace?: string;
  /** Stable pull-host key when registered via externalKey (hooks / GUI). */
  externalKey?: string;
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
  /** Stable immutable role handle (`rl-…`). */
  roleId: string;
  /**
   * Operational key (temp/<name>/, task.role). Immutable in identity batch 1;
   * kept for path/compat. Prefer roleId for new internal refs.
   */
  name: string;
  /** Mutable human label for UI. */
  displayName: string;
  description?: string;
  color?: string;
  prompt?: string;
  /** Spawn authority; omitted means deny. Never includes secrets. */
  a2aPolicy?: "allow" | "ask" | "deny";
  /**
   * Profile ids authorized for role-caller startSession when a2aPolicy=allow.
   * Ids only — never credentials. Omitted / empty = none for autonomous allow.
   */
  allowedProfiles?: string[];
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
  /**
   * Skill name/path refs only — never SKILL.md bodies or secret values.
   */
  skills?: import("../adapters/acp/mcp-skills.js").AgentProfileSkillProjection[];
  /**
   * MCP server descriptions with envKey/credentialRef *names* only — never secret values.
   */
  mcpServers?: import("../adapters/acp/mcp-skills.js").AgentProfileMcpServerProjection[];
};

/**
 * Repository verification level for a product ACP adapter.
 * Authoritative values come only from service provider-catalog registry —
 * clients must not hardcode adapter → level maps.
 */
export const PROVIDER_VERIFICATION_LEVELS = [
  "adapter-implemented",
  "mock-tested",
  "live-e2e",
] as const;

export type ProviderVerificationLevel =
  (typeof PROVIDER_VERIFICATION_LEVELS)[number];

/**
 * One product provider verification fact (provider.catalog).
 * Never includes secrets, env values, credentials, or profile config.
 */
export type ProviderCatalogEntry = {
  adapterId: string;
  verificationLevel: ProviderVerificationLevel;
  /**
   * Provider-native session resume claim when adapter capabilities agree.
   * Derived from adapter.capabilities().canResume on the product registry.
   */
  canResume?: boolean;
  /** Optional short non-secret note for UI; only when authoritative and useful. */
  notes?: string;
};

/** Result of provider.catalog — static product facts, not machine-local profiles. */
export type ProviderCatalogProjection = {
  providers: ProviderCatalogEntry[];
};

/**
 * Methods clients may call. AgentRuntimePort.* is intentionally absent.
 * B5 adds full task lifecycle + session projections + a2a resolve.
 * Desktop P0-1 adds read-only registry.* for coordination type + role pickers.
 * Desktop ACP launch surface adds profile.list/get + machine-local grok-acp CRUD.
 * Provider verification: provider.catalog (read-only product facts; no secrets).
 * Credential vault: credential.list/set/delete (no get plaintext).
 * Machine-local skills: skill.list/install (bundled only; no workspaceId).
 */
export const CLIENT_METHODS = [
  "service.health",
  "service.subscribe",
  "workspace.mount",
  "workspace.unmount",
  "workspace.list",
  "workspace.setForeground",
  /**
   * Workspace collaboration settings (system-root settings.json).
   * settings is a read projection; settings.update is user-only MutationBus.
   * Successful actual mutation emits exactly one workspace.settings.updated; no-op emits none.
   */
  "workspace.settings",
  "workspace.settings.update",
  /**
   * Canonical workspace-root AGENTS.md (not under .tent).
   * Fixed filename only — no arbitrary path. Missing file projects empty content + exists=false.
   * write is user-only MutationBus with optional baseEtag conflict protection (docs style).
   * Successful actual mutation emits exactly one workspace.agents.updated; no-op emits none.
   */
  "workspace.agents",
  "workspace.agents.write",
  "docs.list",
  "docs.get",
  "docs.readForEdit",
  "docs.write",
  "docs.createNote",
  "docs.promote",
  "docs.fork",
  /**
   * User-only atomic concept rename (MutationBus).
   * Keeps cx- immutable; renames folder + identity note; rewrites path links.
   * Success emits exactly one concept.changed with oldPath/path.
   */
  "docs.rename",
  /**
   * Set Node mode (editable | read-only | archived). Sole mode mutation RPC.
   * Ordinary docs.write cannot set mode/id/collaboration reserved fields.
   */
  "docs.setMode",
  "docs.search",
  "docs.backlinks",
  /**
   * Import binary attachment for a concept.
   * Wire: base64 string in `bytesBase64` (or legacy `contentBase64`).
   * Disk: original bytes under attachments/<cx>/… — never a .b64 text companion.
   */
  "docs.importAttachment",
  "registry.types",
  "registry.roles",
  /**
   * User-only role registry mutations (MutationBus).
   * Persist id/name/displayName/prompt/description/color/a2aPolicy/allowedProfiles/cli —
   * never provider secrets. id is server-assigned and immutable; displayName is
   * mutable; operational name is not renamed in identity batch 1.
   * Success emits exactly one registry.roles.updated.
   */
  "registry.role.create",
  "registry.role.update",
  "registry.role.delete",
  "profile.list",
  "profile.get",
  "profile.create",
  "profile.update",
  "profile.delete",
  /**
   * Read-only product provider verification catalog.
   * Params: none (machine-global product facts; not workspace-scoped).
   * Result: { providers: ProviderCatalogEntry[] } — adapterId + verificationLevel
   * (+ optional canResume/notes). Never secrets, env values, or credentials.
   * Distinct from profile.* (machine-local launch config).
   */
  "provider.catalog",
  /** Machine-local credential vault (user-only; never returns secret plaintext). */
  "credential.list",
  "credential.set",
  "credential.delete",
  /** Machine-local bundled skill list/install (user surface; no workspaceId). */
  "skill.list",
  "skill.install",
  "task.dispatch",
  "task.claim",
  "task.wait",
  "task.resume",
  /**
   * A2U business ask: running task → create pending UserAsk + waiting(user-input).
   * Not tool permission; not multi-turn chat.
   */
  "task.askUser",
  /**
   * U2A one-shot append: user-only text and/or contextRefs to a running/waiting task.
   * Not chat; does not answer a pending UserAsk; does not mutate profiles.
   */
  "task.sendInput",
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
  /**
   * Stable box collaboration projection (task-api §2.3).
   * Params: workspaceId + id|path|boxId (same resolver as docs.get).
   * Result: { workspaceId, boxId, status, assignee?, activeTaskId? }.
   */
  "box.projection",
  /** Proposal triage — separate from task delivery review (task-api §3). */
  "proposal.list",
  "proposal.submit",
  "proposal.resolve",
  "session.list",
  "session.get",
  /**
   * External / pull-host session lifecycle (no ACP spawn).
   * enter: register or reuse state=external SessionRegistry row.
   * status: probe + incomplete task bindings for that session.
   * leave: stop/unbind external session only — never deliver/accept.
   */
  "session.enter",
  "session.status",
  "session.leave",
  "a2a.listPending",
  "a2a.resolve",
  /** ACP tool permission approvals (permissionPolicy=ask) — distinct from a2a.* spawn gate. */
  "toolApproval.listPending",
  "toolApproval.get",
  "toolApproval.approveOnce",
  "toolApproval.deny",
  /**
   * A2U UserAsk (business question) — machine-local; not chat.
   * reply/deny are user-only; resolve atomically resumes the task.
   */
  "userAsk.listPending",
  "userAsk.get",
  "userAsk.reply",
  "userAsk.deny",
  /**
   * U2A task input (one-shot append) — machine-local; not chat.
   * send is user-only; listPending/get/ack require workspaceId+taskPath (no global inbox).
   * ack actor must match stored task role or service-verified session binding.
   */
  "taskInput.listPending",
  "taskInput.get",
  "taskInput.ack",
  /**
   * Operational retention (task-api §6) — user-only.
   * preview is read-only; purge mutates via MutationBus and emits retention.purged only when files deleted.
   */
  "operationalRetention.preview",
  "operationalRetention.purge",
] as const;

export type ClientMethod = (typeof CLIENT_METHODS)[number];

export function isClientMethod(method: string): method is ClientMethod {
  return (CLIENT_METHODS as readonly string[]).includes(method);
}

/** Collaboration projection fields protected while a box has an active task. */
export const PROTECTED_COLLAB_FIELDS = ["status", "owner", "assignee"] as const;

/** Fields that raw/docs.write may never set; use dedicated APIs (setMode / task.*). */
export const RESERVED_DOCS_WRITE_FIELDS = [
  "id",
  "mode",
  "archived",
  ...PROTECTED_COLLAB_FIELDS,
] as const;

/** JSON-RPC auth failure. */
export const RPC_UNAUTHORIZED = -32001;
export const RPC_A2A_DENIED = -32020;
export const RPC_A2A_ASK = -32021;
export const RPC_LIFECYCLE = -32022;
