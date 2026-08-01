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

/**
 * Node lifecycle mode on the wire (document semantics; not Task state).
 * V0.2: editable | archived only. Service rejects setMode("read-only").
 */
export type NodeMode = "editable" | "archived";

export type ConceptProjection = {
  id: string;
  path: string;
  name: string;
  type: string;
  tags: string[];
  /** Effective mode after inheritance (archived cascades). */
  mode: NodeMode;
  /** Convenience: mode === "archived". */
  archived: boolean;
  invalid: boolean;
  bodyPreview?: string;
  children?: ConceptProjection[];
};

/**
 * @deprecated V0.2 truth is `node.collaboration` / `node.collaborations`.
 * Kept only for migration of older desktop consumers.
 * Stable box collaboration projection (legacy task-api §2.3 / `box.projection`).
 * Active task is authoritative; without one, only persisted `done` is preserved.
 */
export type BoxProjection = {
  workspaceId: string;
  boxId: string;
  status: "todo" | "doing" | "done";
  assignee?: string;
  activeTaskId?: string;
};

/**
 * Direct-ref Task pointer on a Node (V0.2 `node.collaboration`).
 * Raw lifecycle fields only — never maps to universal todo/doing/done.
 */
export type NodeCollaborationTaskSummary = {
  /** Operational task id (tk-…) when present; otherwise envelope path. */
  id: string;
  /** Raw Task lifecycle state (queued|running|waiting|delivered|…). */
  state: string;
  /** Role assignee label when assigneeKind is role (or missing). */
  role?: string;
  /** Profile assignee id when assigneeKind is agentProfile. */
  profileId?: string;
  assigneeKind?: "role" | "agentProfile";
  sessionId?: string;
  activeDeliveryId?: string;
  /** Optional createdAt for clients that re-sort (server already orders). */
  createdAt?: string;
  path?: string;
};

/** Session summary attached only via Task.sessionId (never inferred). */
export type NodeCollaborationSessionSummary = {
  id: string;
  state: string;
  alive: boolean;
  turnBusy: boolean;
};

/** Delivery summary attached only via Task.activeDeliveryId (never inferred). */
export type NodeCollaborationDeliverySummary = {
  id: string;
  status: string;
};

/**
 * One active Task entry on a Node (multi-Task wire, cx-tsw53f).
 * Joined only by explicit Task.sessionId / activeDeliveryId.
 */
export type NodeCollaborationActiveTask = {
  task: NodeCollaborationTaskSummary;
  session: NodeCollaborationSessionSummary | null;
  delivery: NodeCollaborationDeliverySummary | null;
};

/**
 * V0.2 Node-keyed collaboration projection (`node.collaboration` item).
 * Multiple active Tasks may directly reference the same Node.
 * No singular task/session/delivery or activeTaskId compatibility alias.
 * Idle Node → activeTasks: [] / activeTaskCount: 0.
 * No Node owner/status/coordination fields.
 *
 * `activeTaskCount` is **projection-only derived data** (judge addendum):
 * never persisted on Task/Node, never a second collaboration fact.
 * With the current unpaginated `activeTasks` array it **must always equal
 * `activeTasks.length`**. Do not invent totalCount / pagination / truncation.
 */
export type NodeCollaboration = {
  workspaceId: string;
  nodeId: string;
  /** Full unpaginated list of direct active Task entries (deterministic order). */
  activeTasks: NodeCollaborationActiveTask[];
  /**
   * Derived convenience: always `activeTasks.length` under current unpaginated wire.
   * Not durable; not independently authoritative.
   */
  activeTaskCount: number;
};

/**
 * Batch Node collaboration projection (`node.collaborations`).
 * `items` order matches the input `ids` order one-for-one.
 */
export type NodeCollaborationsResult = {
  workspaceId: string;
  items: NodeCollaboration[];
};

/**
 * V0.2 Output provenance read model (`output.provenance`).
 * Authority is Output frontmatter `deliveryId` only — no taskId/sourceNodeId denorm.
 * Live Delivery → Task → sourceNode joins by id; missing heat → incomplete, never inferred.
 */
export type OutputProvenanceIncompleteReason =
  | "delivery_missing"
  | "task_missing"
  | "source_missing"
  | "mismatch";

export type OutputProvenance = {
  workspaceId: string;
  outputId: string;
  path: string;
  bound: boolean;
  deliveryId: string | null;
  delivery: {
    id: string;
    status: string;
    taskId: string;
    boxId: string;
  } | null;
  task: {
    id: string;
    state: string;
    path?: string;
  } | null;
  sourceNode: {
    id: string;
    path?: string;
    type?: string;
    archived?: boolean;
  } | null;
  incomplete: OutputProvenanceIncompleteReason[];
};

/**
 * Workspace-level graph node summary for Working-set Canvas (`graph.projection`).
 * Stable identity + document meta only — never includes body / bodyPreview.
 */
export type GraphNodeSummary = {
  id: string;
  path: string;
  name: string;
  type: string;
  tags: string[];
  mode: NodeMode;
  archived: boolean;
  invalid: boolean;
  /** Optional frontmatter title when present. */
  title?: string;
};

/** Tree parent→child edge (roots use parentId = null). */
export type GraphParentEdge = {
  parentId: string | null;
  childId: string;
};

/**
 * Markdown or wiki concept link edge.
 * Resolved edges set `toId`; unresolved edges keep explicit `unresolved` and omit `toId`.
 * Never silently drop unresolvable concept-link candidates.
 */
export type GraphLinkEdge = {
  fromId: string;
  /** Present only when the link resolves to exactly one concept. */
  toId?: string;
  raw: string;
  label?: string;
  /**
   * Explicit unresolved payload when the outbound concept link cannot be resolved.
   * `raw` mirrors authoring form; `target` is the normalized resolution key when available.
   */
  unresolved?: {
    raw: string;
    target?: string;
  };
};

/**
 * First-class semantic relation edge for graph.projection.
 * Separate from parent / markdown / wiki — never merged with body links.
 * Source is the owning Node; target is either resolved `toId` or explicit unresolved.
 */
export type GraphRelationEdge = {
  id: string;
  fromId: string;
  kind: string;
  direction: "directed" | "bidirectional";
  label?: string;
  /** Present only when the relation target is a resolved concept handle. */
  toId?: string;
  /** Explicit unresolved target string when not resolved. */
  unresolved?: string;
};

/**
 * Read-only workspace graph projection for Canvas.
 * Edges are partitioned into parent / markdown / wiki / relation; no placement state.
 */
export type GraphProjection = {
  workspaceId: string;
  nodes: GraphNodeSummary[];
  edges: {
    parent: GraphParentEdge[];
    markdown: GraphLinkEdge[];
    wiki: GraphLinkEdge[];
    /** First-class semantic relations (source Node frontmatter); not body links. */
    relation: GraphRelationEdge[];
  };
};

/** Wire target for relation CRUD — exactly one form. */
export type RelationTargetWire = { nodeId: string } | { unresolved: string };

/** Outgoing relation record (source implied by listed Node). */
export type RelationRecordWire = {
  id: string;
  kind: string;
  direction: "directed" | "bidirectional";
  label?: string;
  target: RelationTargetWire;
};

/** Derived incoming view: stored on sourceId, points at the listed Node. */
export type RelationIncomingWire = RelationRecordWire & {
  sourceId: string;
  sourcePath: string;
};

/** relation.list result. */
export type RelationListResult = {
  workspaceId: string;
  nodeId: string;
  path: string;
  outgoing: RelationRecordWire[];
  incoming: RelationIncomingWire[];
};

/** relation.create / relation.update success payload. */
export type RelationMutationResult = {
  workspaceId: string;
  id: string;
  path: string;
  etag: string;
  relation: RelationRecordWire;
};

/** relation.delete success payload. */
export type RelationDeleteResult = {
  workspaceId: string;
  id: string;
  path: string;
  etag: string;
  deleted: string;
};

/**
 * @deprecated V0.2 truth is `NodeCollaborationsResult` / `node.collaborations`.
 * Batch box collaboration projection (`box.projections`).
 * `projections` order matches the input `ids` order one-for-one.
 */
export type BoxProjectionsResult = {
  workspaceId: string;
  projections: BoxProjection[];
};

export type TaskActorRefWire = {
  kind: "user" | "role";
  id: string;
};

export type TaskProjection = {
  path: string;
  id?: string;
  role: string;
  /**
   * Node ids from Task.contextCard.refs.nodes (via taskReferencedNodeIds).
   * Replaces the removed claims[] projection — occupation truth is Context Card only.
   */
  referencedNodeIds: string[];
  /** Legacy envelope status (pending|taken). */
  status: "pending" | "taken";
  /** Full lifecycle state (task-api §2). */
  state: string;
  manifest: string;
  /** Explicit parent actor (V0.2). */
  parentActor?: TaskActorRefWire;
  /** Explicit Delivery reviewer (V0.2). */
  reviewer?: TaskActorRefWire;
  /** Peer vs sub Git lane; missing/false = peer. */
  asSub?: boolean;
  deliveryPolicy?: string;
  assigneeKind?: string;
  /**
   * Logical AgentDefinition id when this Task was Role-agent dispatched.
   * Authoritative for startSession roster auth; omitted on user-direct profile Tasks.
   */
  agentId?: string;
  sessionId?: string;
  wait?: { reason: string; summary: string; code?: string };
  activeDeliveryId?: string;
  /** Last explicit managed Task outcome when recorded. */
  lastOutcome?: "delivered" | "blocked" | "needs-input";
  workspaceLane?: {
    workspace?: string;
    worktree?: string;
    branch?: string;
    targetBranch?: string;
    /** Exact Task lane start SHA (cx-5q6za6). */
    baseCommit?: string;
    /** actor = parent/reviewer; mutator = service. */
    integrationAuthority?: {
      actor: TaskActorRefWire;
      mutator: "service";
    };
  };
  /**
   * Compact audit for capture-once baseCommit (first-claim | explicit-backfill).
   * Omitted on legacy / non-Git Tasks. Never rewritten on same-SHA idempotent backfill.
   */
  baseCommitCapture?: {
    source: "first-claim" | "explicit-backfill";
    baseCommit: string;
    actor: TaskActorRefWire;
    capturedAt: string;
  };
  createdAt?: string;
  updatedAt?: string;
  prompt?: string;
  /**
   * Authoritative Task Context Card v1 when present on the envelope (cx-5q6za6).
   * Omitted on legacy tasks. Shape matches core TaskContextCardV1.
   */
  contextCard?: import("../core/task-context-card.js").TaskContextCardV1;
  /** `cg-v1-<sha256>` stable-prefix generation when projected. */
  contextGeneration?: string;
  /** Current task context + input delta digest when projected. */
  taskDeltaDigest?: string;
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
  /**
   * Full SHA of the integration target branch HEAD snapshotted when a
   * commit-bearing ready Delivery was created. Absent when commits are empty
   * or on legacy rows written before this field existed.
   */
  targetHead?: string;
  integrationMode: string | null;
  review?: { by: string; decision: string; note?: string };
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Unified A2U pending projection kinds (workspace inbox).
 * Facts remain in domain stores / task lifecycle — this is aggregation only.
 */
export type PendingInteractionKind =
  | "userAsk"
  | "a2a"
  | "toolApproval"
  | "delivery";

/** Shared entity pointers + stable identity for one pending A2U item. */
export type PendingInteractionBase = {
  kind: PendingInteractionKind;
  id: string;
  workspaceId: string;
  createdAt: string;
  taskPath?: string;
  taskId?: string;
  boxId?: string;
  role?: string;
  sessionId?: string;
};

/** A2U business UserAsk — question + choices only; no chat transcript. */
export type PendingUserAskInteraction = PendingInteractionBase & {
  kind: "userAsk";
  taskPath: string;
  question: string;
  choices?: Array<{ id: string; label: string }>;
};

/** A2A spawn approval — profile gate; not tool permission. */
export type PendingA2AInteraction = PendingInteractionBase & {
  kind: "a2a";
  taskPath: string;
  role: string;
  profileId: string;
  policy?: string;
  callerKind?: string;
};

/**
 * ACP tool permission — safe title/options only.
 * Never projects tool raw args, secrets, or stdout.
 */
export type PendingToolApprovalInteraction = PendingInteractionBase & {
  kind: "toolApproval";
  sessionId: string;
  toolTitle: string;
  options: Array<{ optionId: string; kind?: string; name?: string }>;
  expiresAt?: string;
};

/**
 * Ready Delivery awaiting review.
 * Entity pointers only — does not project delivery summary body.
 */
export type PendingDeliveryInteraction = PendingInteractionBase & {
  kind: "delivery";
  taskId: string;
  boxId: string;
  role: string;
  path: string;
  status: "ready";
};

export type PendingInteractionItem =
  | PendingUserAskInteraction
  | PendingA2AInteraction
  | PendingToolApprovalInteraction
  | PendingDeliveryInteraction;

export type PendingInteractionCounts = {
  userAsk: number;
  a2a: number;
  toolApproval: number;
  delivery: number;
  total: number;
};

/**
 * Workspace-scoped unified pending list (interaction.listPending).
 * Sorted by createdAt, then kind, then id. Single-source failure fails the RPC.
 */
export type PendingInteractionListResult = {
  workspaceId: string;
  items: PendingInteractionItem[];
  counts: PendingInteractionCounts;
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
  /**
   * Continuity honesty: true only for provider-native same-context restore;
   * false when Tent opened an independent Session after resume failure / no capability.
   * Omitted when the row makes no continuity claim (legacy / ordinary first start).
   */
  contextRestored?: boolean;
  /**
   * Stable restore / replace reason when the Session was rebound without native continuity
   * (e.g. task.reject.resume.* or task.replaceSession.fresh).
   */
  restoreReason?: string;
  /** Prior Tent session id when this Session replaced one (audit). */
  replacedSessionId?: string;
  /** Successor Tent session id when this Session was replaced (audit). */
  replacedBySessionId?: string;
  /**
   * Managed turn in flight (session/prompt settling). Distinct from `alive`:
   * a live role session may be turn-idle between prompts. Optional for wire
   * compatibility; omitted/false when no managed turn is busy.
   */
  turnBusy?: boolean;
  lastTaskId?: string;
  workspace?: string;
  /** Stable pull-host key when registered via externalKey (hooks / GUI). */
  externalKey?: string;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Project type registry row (read-only projection for clients).
 * V0.2 Core stores name + tier only.
 */
export type TypeRegistryEntryProjection = {
  name: string;
  tier: "base" | "modifier";
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
   * Presence means Tent will project metadata to ACP (`_meta.tent.skills`);
   * it does **not** mean the provider activated the skill.
   */
  skills?: import("../adapters/acp/mcp-skills.js").AgentProfileSkillProjection[];
  /**
   * How profile skills are applied at ACP session start.
   * Always metadata / provider-dependent when skills are present — never "activated".
   */
  skillsProjectionMode?: "metadata-provider-dependent";
  /**
   * Short non-secret honesty note for clients/UI (skills metadata only).
   */
  skillsNote?: string;
  /**
   * MCP server descriptions with envKey/credentialRef *names* only — never secret values.
   */
  mcpServers?: import("../adapters/acp/mcp-skills.js").AgentProfileMcpServerProjection[];
};

/**
 * Repository verification level for a product ACP adapter.
 * Authoritative values come only from service provider-catalog registry —
 * clients must not hardcode adapter → level maps.
 *
 * Honesty contract (do not upgrade in UI copy):
 * - adapter-implemented — launch contract coded; no mock/live suite claim
 * - mock-tested — offline mock ACP suite covers launch/protocol
 * - opt-in-live-probe — checked-in opt-in live probe/script exists; NOT CI
 *   certification and NOT "this machine is live-verified"
 * - live-verified — durable evidence that a live path was proven on the
 *   current operator machine (machine-local claim; static catalog rarely
 *   uses this — never treat "has a script" as live-verified)
 */
export const PROVIDER_VERIFICATION_LEVELS = [
  "adapter-implemented",
  "mock-tested",
  "opt-in-live-probe",
  "live-verified",
] as const;

export type ProviderVerificationLevel =
  (typeof PROVIDER_VERIFICATION_LEVELS)[number];

export const NATIVE_FOREGROUND_LEVELS = [
  "verified",
  "unverified",
  "unsupported",
] as const;

export type NativeForegroundLevel =
  (typeof NATIVE_FOREGROUND_LEVELS)[number];

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
  /**
   * Whether a provider-native CLI has been proven to resume the same ACP
   * session and hand it back to ACP. This is repository evidence, not a
   * machine-local installed/authenticated readiness check.
   */
  nativeForeground: NativeForegroundLevel;
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
 * Desktop P0-1 adds read-only registry.* for type + role pickers.
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
  /** Existing Node body/frontmatter write; requires baseEtag (-32008 missing / -32009 conflict). */
  "docs.write",
  "docs.createNote",
  "docs.fork",
  /**
   * User-only atomic concept rename (MutationBus).
   * Keeps cx- immutable; renames folder + identity note; rewrites path links.
   * Success emits exactly one concept.changed with oldPath/path.
   */
  "docs.rename",
  /**
   * User-only structural move / reparent (MutationBus).
   * Resolve moved node + destination by cx-; require expectedPath (stale → -32009 path_stale).
   * Reparent rewrites path links; same-parent reorder is order-only.
   * Success emits exactly one concept.changed (reason docs.move) with oldPath/path/pathMap.
   * Canonical name is docs.move — no docs.reparent alias.
   */
  "docs.move",
  /**
   * Set Node mode (editable | archived). Sole mode mutation RPC.
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
  /**
   * User-only Node type mutation (MutationBus + baseEtag).
   * Public semantic path for compound type strings; not via free-form docs.write.
   * Success emits exactly one concept.changed with reason docs.setType.
   */
  "docs.setType",
  /**
   * User-only Node tags replace (MutationBus + baseEtag).
   * Empty array clears Node tags without pruning the global registry.
   * Success emits exactly one concept.changed with reason docs.tags.set.
   */
  "docs.tags.set",
  /**
   * User-only attach one tag to a Node (MutationBus + baseEtag; idempotent).
   * Auto-registers new names into tags.json. Success emits concept.changed reason docs.tag.add.
   */
  "docs.tag.add",
  /**
   * User-only detach one tag from a Node (MutationBus + baseEtag).
   * Does not prune the global registry. Success emits concept.changed reason docs.tag.remove.
   */
  "docs.tag.remove",
  /**
   * First-class semantic Node relations (source frontmatter `relations` array).
   * list is read-only; create/update/delete are user-only MutationBus + source baseEtag.
   * Not Markdown/wiki body links; kind is an open identifier (no registry).
   */
  "relation.list",
  "relation.create",
  "relation.update",
  "relation.delete",
  "registry.types",
  /**
   * User-only custom secondary type create (MutationBus).
   * Primaries and built-in secondaries cannot be created. Success emits registry.types.updated.
   */
  "registry.type.create",
  /**
   * User-only custom secondary type delete (MutationBus).
   * Built-ins and in-use types fail loud. Success emits registry.types.updated.
   */
  "registry.type.delete",
  /** Read-only global tag vocabulary (tags.json). */
  "registry.tags",
  /**
   * User-only ensure a tag exists in the global vocabulary (MutationBus).
   * Success emits registry.tags.updated (even when already present — client may no-op on payload).
   */
  "registry.tag.create",
  /**
   * User-only global tag delete + cascade off all Nodes (MutationBus).
   * Success emits exactly one registry.tags.updated (no per-Node concept.changed).
   * Clients must treat that event as invalidating tag candidates and graph/node
   * projections whose tags may have been rewritten by the cascade.
   */
  "registry.tag.delete",
  "registry.roles",
  /**
   * User-only role registry mutations (MutationBus).
   * Persist id/name/displayName/prompt/description/color/cli —
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
  /**
   * Durable Role self-execution: atomically create + claim from exact nodeIds[].
   * Service derives parent/reviewer from persisted Task/Session responsibility;
   * callers cannot provide actor, target, asSub, or Delivery authority fields.
   */
  "task.claimDirect",
  /**
   * Explicit legacy backfill of workspaceLane.baseCommit for running/waiting Tasks
   * whose lane exists but base is missing. Authorized by exact parent/reviewer only.
   * Never infers from roleBranchBase/cwd/current tip. Same SHA is idempotent.
   */
  "task.backfillWorkspaceLaneBase",
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
  /**
   * Explicit fresh managed Session on the same Task (unusable provider context).
   * Never a silent fallback from task.startSession. Uses the same machine Settings
   * route availability gate as startSession.
   * Shares the per-Task managed-session execution slot with startSession.
   * Preserves nodeRefs/worktree/branch/lane/pending TaskInputs/deliveryPolicy;
   * stops the old Session first; new ss- has contextRestored=false + stable restoreReason.
   * turnBusy → fail-loud TURN_BUSY (retryable); no force flag in this contract.
   * waiting only when durable waitCode=session_unavailable (not user-input/a2a/tool).
   */
  "task.replaceSession",
  "task.list",
  "task.get",
  "delivery.list",
  "delivery.get",
  /**
   * @deprecated Prefer node.collaboration (V0.2). Migration-only.
   * Stable box collaboration projection (legacy task-api §2.3).
   * Params: workspaceId + id|path|boxId (same resolver as docs.get).
   * Result: { workspaceId, boxId, status, assignee?, activeTaskId? }.
   */
  "box.projection",
  /**
   * @deprecated Prefer node.collaborations (V0.2). Migration-only.
   * Batch box collaboration projection (same item semantics as box.projection).
   * Params: workspaceId + ids: string[] (stable cx- handles).
   * Result: { workspaceId, projections } with projections ordered as ids.
   */
  "box.projections",
  /**
   * V0.2 Node-keyed collaboration projection (task-api §2.3).
   * Params: workspaceId + id|path|boxId (same resolver as docs.get).
   * Result: { workspaceId, nodeId, task, session, delivery } with nulls when idle.
   * Direct-claim nonterminal Task only; Session/Delivery only via explicit ids.
   */
  "node.collaboration",
  /**
   * V0.2 Output provenance (Output → Delivery → Task → sourceNode).
   * Params: workspaceId + id|outputId|path (stable Node id preferred).
   * Unbound output → bound:false + nulls; corrupt refs → incomplete reasons.
   */
  "output.provenance",
  /**
   * V0.2 batch Node collaboration projection (same item semantics as node.collaboration).
   * Params: workspaceId + ids: string[] (stable cx- handles).
   * Result: { workspaceId, items } ordered as ids. Empty ids → empty items.
   * Loads tent/tasks/sessions/deliveries once per batch (no N+1).
   */
  "node.collaborations",
  /**
   * Workspace-level graph projection for Working-set Canvas.
   * Params: workspaceId.
   * Result: { workspaceId, nodes, edges: { parent, markdown, wiki, relation } }.
   * Node summaries only (no body); unresolved markdown/wiki links and relation targets kept explicitly.
   * Semantic relation edges are a separate collection — never merged with parent/markdown/wiki.
   * Placement / view state is never projected or persisted here.
   */
  "graph.projection",
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
  /**
   * Optional Role Checkpoint (cooperative Session replacement continuation note).
   * Operational under temp/<role>/checkpoint.md only — not a Core entity, Task state,
   * Delivery, or OS-temp artifact. set overwrites; get returns null when absent;
   * clear is idempotent. Dynamic tail context only.
   */
  "role.checkpoint.get",
  "role.checkpoint.set",
  "role.checkpoint.clear",
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
   * Unified A2U pending read projection (workspace-scoped).
   * Aggregates pending UserAsk, A2A spawn approval, ACP tool approval, and
   * status=ready Delivery. No new store / state machine; resolve stays on
   * domain RPCs (userAsk.* / a2a.resolve / toolApproval.* / task.accept|reject).
   * Fail-loud on any source failure — never a partial authoritative inbox.
   */
  "interaction.listPending",
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
  /**
   * Read-only diagnostic for one terminal Task's temporary Git worktree reclaim.
   * Params: workspaceId + taskPath. Does not mass-scan inventory; auto-reclaim still
   * runs without this RPC after terminal transitions / mount recovery.
   */
  "task.worktreeReclaim.preview",
  "task.worktreeReclaim.reconcile",
  /**
   * Node Markdown underline annotations (划线注释) — first-class workspace records.
   * Independent of body markers, Node attributes, and Task. User-only mutations via MutationBus.
   * Events are invalidation only (annotation.changed); never auto-inject Agent / TaskInput.
   * list projects live relocate (anchored|relocated|orphan) without rewriting stored anchors.
   */
  "annotation.list",
  "annotation.create",
  "annotation.resolve",
  "annotation.reopen",
  "annotation.delete",
] as const;

export type ClientMethod = (typeof CLIENT_METHODS)[number];

export function isClientMethod(method: string): method is ClientMethod {
  return (CLIENT_METHODS as readonly string[]).includes(method);
}

/** Collaboration projection fields protected while a box has an active task. */
export const PROTECTED_COLLAB_FIELDS = ["status", "owner", "assignee"] as const;

/** Fields that raw/docs.write may never set; use dedicated APIs (setMode / task.* / type-tag RPCs). */
export const RESERVED_DOCS_WRITE_FIELDS = [
  "id",
  "mode",
  "archived",
  /** Output provenance — only formal task.accept bind path may write. */
  "deliveryId",
  ...PROTECTED_COLLAB_FIELDS,
] as const;

/**
 * Semantic Node fields that must use dedicated Service commands, not free-form docs.write.
 * type → docs.setType; tags → docs.tags.set / docs.tag.add / docs.tag.remove;
 * relations → relation.create / relation.update / relation.delete.
 */
export const SEMANTIC_DOCS_WRITE_FIELDS = ["type", "tags", "relations"] as const;

/** JSON-RPC auth failure. */
export const RPC_UNAUTHORIZED = -32001;
export const RPC_A2A_DENIED = -32020;
export const RPC_A2A_ASK = -32021;
export const RPC_LIFECYCLE = -32022;
/**
 * @deprecated V0.2 cx-tsw53f: multiple active Tasks may directly reference one Node.
 * `node.collaboration(s)` returns activeTasks[] — no longer fails on multi-active.
 * Kept only so older clients that still special-case this code compile.
 */
export const RPC_COLLAB_AMBIGUOUS = -32023;
