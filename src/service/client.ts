// Typed ServiceClient for Desktop / CLI attach (task.* + docs.* only).

import type {
  TaskResultProjection,
  EventEnvelope,
  GraphProjection,
  NodeProjection,
  OutputProvenance,
  PendingInteractionListResult,
  ProviderCatalogProjection,
  RelationDeleteResult,
  RelationListResult,
  RelationMutationResult,
  RelationTargetWire,
  SessionProjection,
  WorkspaceCollaborationProjection,
} from "./types.js";
import {
  AUTH_TOKEN_HEADER,
  CALLER_SESSION_ID_HEADER,
  CALLER_SESSION_TOKEN_HEADER,
  CALLER_EXTERNAL_KEY_HEADER,
} from "./auth.js";

export interface ServiceClientOptions {
  baseUrl: string;
  /** Loopback token from an authenticated machine-local endpoint record. */
  token: string;
  /** Host execution capability; sent as transport metadata, never RPC params. */
  currentSessionId?: string;
  currentSessionToken?: string;
  /** Verified host-native external Session key fallback for user-started Role Sessions. */
  currentExternalKey?: string;
  /** Optional fetch implementation (tests). */
  fetchImpl?: typeof fetch;
}

type RpcErrorBody = { code: number; message: string; data?: unknown };

export type RpcResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: RpcErrorBody };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRpcErrorBody(value: unknown): RpcErrorBody | null {
  if (!isPlainObject(value)) return null;
  if (!Number.isInteger(value.code) || typeof value.message !== "string") return null;
  const error: RpcErrorBody = { code: value.code as number, message: value.message };
  if (Object.prototype.hasOwnProperty.call(value, "data")) {
    error.data = value.data;
  }
  return error;
}

export class ServiceClient {
  readonly baseUrl: string;
  readonly token: string;
  readonly currentSessionId?: string;
  private readonly currentSessionToken?: string;
  private readonly currentExternalKey?: string;
  private readonly fetchImpl: typeof fetch;
  private idSeq = 1;

  constructor(options: ServiceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.currentSessionId = options.currentSessionId?.trim() || undefined;
    this.currentSessionToken = options.currentSessionToken?.trim() || undefined;
    this.currentExternalKey = options.currentExternalKey?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`health HTTP ${res.status}`);
    return res.json();
  }

  async call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    request?: { signal?: AbortSignal }
  ): Promise<T> {
    const rpc = await this.rpcRaw(method, params, request);
    if (rpc.error) {
      const err = new Error(rpc.error.message) as Error & {
        code: number;
        data?: unknown;
      };
      err.code = rpc.error.code;
      err.data = rpc.error.data;
      throw err;
    }
    return rpc.result as T;
  }

  async tryCall<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<RpcResult<T>> {
    const rpc = await this.rpcRaw(method, params);
    if (rpc.error) {
      return { ok: false, error: rpc.error };
    }
    return { ok: true, result: rpc.result as T };
  }

  async rpcRaw(
    method: string,
    params?: Record<string, unknown>,
    request?: { signal?: AbortSignal }
  ): Promise<{ result?: unknown; error?: RpcErrorBody }> {
    const id = this.idSeq++;
    const res = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AUTH_TOKEN_HEADER]: this.token,
        ...(this.currentSessionId && this.currentSessionToken
          ? {
              [CALLER_SESSION_ID_HEADER]: this.currentSessionId,
              [CALLER_SESSION_TOKEN_HEADER]: this.currentSessionToken,
            }
          : {}),
        ...(this.currentExternalKey
          ? { [CALLER_EXTERNAL_KEY_HEADER]: this.currentExternalKey }
          : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: request?.signal,
    });
    if (res.status === 401) {
      return { error: { code: -32001, message: "Unauthorized: invalid or missing service token" } };
    }

    let rawText: string;
    try {
      rawText = await res.text();
    } catch {
      throw new Error(`Service RPC: failed to read response (HTTP ${res.status})`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      if (res.ok) throw new Error("Service RPC: invalid JSON response");
      throw new Error(`Service RPC HTTP ${res.status}`);
    }

    if (!isPlainObject(parsed) || parsed.jsonrpc !== "2.0") {
      if (res.ok) {
        throw new Error(
          !isPlainObject(parsed)
            ? "Service RPC: response must be a plain object"
            : "Service RPC: invalid jsonrpc version"
        );
      }
      throw new Error(`Service RPC HTTP ${res.status}`);
    }

    const hasResult = Object.prototype.hasOwnProperty.call(parsed, "result");
    const hasError = Object.prototype.hasOwnProperty.call(parsed, "error");
    if (hasResult === hasError) {
      // both present or both absent
      if (res.ok) {
        throw new Error("Service RPC: response must include exactly one of result or error");
      }
      throw new Error(`Service RPC HTTP ${res.status}`);
    }

    if (res.ok) {
      if (parsed.id !== id) {
        throw new Error(`Service RPC: response id mismatch (expected ${id})`);
      }
      if (hasResult) {
        return { result: parsed.result };
      }
      const error = parseRpcErrorBody(parsed.error);
      if (!error) {
        throw new Error("Service RPC: invalid error object");
      }
      return { error };
    }

    // Non-2xx: only surface a well-formed JSON-RPC error (e.g. 413 + id null).
    // Never embed arbitrary response body text in the thrown message.
    if (!hasError) {
      throw new Error(`Service RPC HTTP ${res.status}`);
    }
    const error = parseRpcErrorBody(parsed.error);
    if (!error) {
      throw new Error(`Service RPC HTTP ${res.status}`);
    }
    return { error };
  }

  // ---- convenience: workspace ----
  mount(workspaceRoot: string, opts?: { workspaceId?: string; tentName?: string }) {
    return this.call("workspace.mount", { workspaceRoot, ...opts });
  }
  unmount(workspaceId: string) {
    return this.call("workspace.unmount", { workspaceId });
  }
  listWorkspaces() {
    return this.call("workspace.list", {});
  }
  setForeground(workspaceId: string) {
    return this.call("workspace.setForeground", { workspaceId });
  }
  /**
   * Read workspace collaboration settings projection (defaultAcceptMode, extensible).
   * Missing file/field resolves to defaultAcceptMode=review-required.
   */
  workspaceSettings(workspaceId: string) {
    return this.call("workspace.settings", { workspaceId });
  }
  /**
   * User-only settings mutation (MutationBus).
   * Emits exactly one workspace.settings.updated on successful actual change; no-op emits none.
   * `actor` defaults to "user"; non-user is rejected by the service.
   * Canonical writes accept review-required | auto-accept | agent-decide only.
   */
  workspaceSettingsUpdate(
    workspaceId: string,
    patch: {
      defaultAcceptMode?: "review-required" | "auto-accept" | "agent-decide";
    },
    actor = "user"
  ) {
    return this.call("workspace.settings.update", {
      workspaceId,
      ...patch,
      actor,
    });
  }

  /**
   * Read canonical workspace-root AGENTS.md projection.
   * Missing file → content "" and exists=false (not an error). Includes etag for edit.
   */
  workspaceAgents(workspaceId: string) {
    return this.call("workspace.agents", { workspaceId });
  }

  /**
   * User-only write of workspace-root AGENTS.md (MutationBus, atomic).
   * Optional baseEtag rejects stale writes with -32009. Emits workspace.agents.updated
   * only when content actually changes; no-op emits none.
   * `actor` defaults to "user"; non-user is rejected by the service.
   */
  workspaceAgentsWrite(
    workspaceId: string,
    args: { content: string; baseEtag?: string; actor?: string }
  ) {
    return this.call("workspace.agents.write", {
      workspaceId,
      content: args.content,
      ...(args.baseEtag !== undefined ? { baseEtag: args.baseEtag } : {}),
      actor: args.actor ?? "user",
    });
  }

  // ---- convenience: docs ----
  docsList(workspaceId: string, includeBody = false) {
    return this.call<{ workspaceId: string; nodes: NodeProjection[] }>("docs.list", {
      workspaceId,
      includeBody,
    });
  }
  docsGet(workspaceId: string, nodeId: string) {
    return this.call<{ workspaceId: string; node: NodeProjection }>("docs.get", {
      workspaceId,
      nodeId,
    });
  }
  docsReadForEdit(workspaceId: string, nodeId: string) {
    return this.call<{
      workspaceId: string;
      nodeId: string;
      path: string;
      name: string;
      type: string;
      body: string;
      raw: string;
      etag: string;
      frontmatter: Record<string, unknown>;
    }>("docs.readForEdit", { workspaceId, nodeId });
  }
  /**
   * Existing-node body/frontmatter write. baseEtag is required (from docs.readForEdit).
   * Missing → -32008; stale → -32009. Errors carry currentEtag only (no body).
   */
  docsWrite(
    workspaceId: string,
    args: {
      nodeId: string;
      body?: string;
      frontmatter?: Record<string, unknown>;
      raw?: string;
      baseEtag: string;
    }
  ) {
    return this.call("docs.write", { workspaceId, ...args });
  }
  docsCreateNote(
    workspaceId: string,
    args: { name: string; type?: string; parentPath?: string; body?: string }
  ) {
    return this.call<{ workspaceId: string; nodeId: string; path: string; type: string }>(
      "docs.createNote",
      { workspaceId, ...args }
    );
  }
  docsFork(workspaceId: string, nodeId: string) {
    return this.call("docs.fork", { workspaceId, nodeId });
  }
  /**
   * User-only atomic Node rename (MutationBus).
   * Success emits exactly one node.changed with oldPath/path.
   */
  docsRename(
    workspaceId: string,
    args: { nodeId: string; newName: string; actor?: string }
  ) {
    return this.call("docs.rename", { workspaceId, ...args });
  }
  /**
   * User-only structural move / reparent (MutationBus).
   * Resolve by stable cx- id; expectedPath required for stale-path conflict.
   * newParentId null = tent root. position: inside | before/after siblingId.
   * Success emits exactly one node.changed (reason docs.move) with oldPath/path/pathMap.
   */
  docsMove(
    workspaceId: string,
    args: {
      nodeId: string;
      expectedPath: string;
      newParentId: string | null;
      position:
        | { mode: "inside" }
        | { mode: "before"; siblingId: string }
        | { mode: "after"; siblingId: string };
      actor?: string;
    }
  ) {
    return this.call("docs.move", { workspaceId, ...args });
  }
  /**
   * Set Node mode (editable | archived). Sole mode mutation client surface.
   */
  docsSetMode(
    workspaceId: string,
    args: {
      nodeId: string;
      mode: "editable" | "archived";
    }
  ) {
    return this.call("docs.setMode", { workspaceId, ...args });
  }
  /**
   * Import attachment bytes for a Node. Wire payload is base64; disk stores original bytes.
   */
  docsImportAttachment(
    workspaceId: string,
    args: {
      nodeId: string;
      fileName: string;
      bytesBase64: string;
    }
  ) {
    return this.call("docs.importAttachment", { workspaceId, ...args });
  }
  /**
   * User-only set or omit the single optional Node type (MutationBus + baseEtag).
   * Missing baseEtag → -32008; stale → -32009. Emits node.changed reason docs.setType.
   */
  docsSetType(
    workspaceId: string,
    args: {
      nodeId: string;
      type: string | null;
      baseEtag: string;
      actor?: string;
    }
  ) {
    return this.call("docs.setType", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user",
    });
  }
  /**
   * User-only replace Node tags (MutationBus + baseEtag). Empty clears Node tags only.
   */
  docsTagsSet(
    workspaceId: string,
    args: {
      nodeId: string;
      tags: string[];
      baseEtag: string;
      actor?: string;
    }
  ) {
    return this.call("docs.tags.set", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user",
    });
  }
  /** User-only attach one tag (idempotent; MutationBus + baseEtag). */
  docsTagAdd(
    workspaceId: string,
    args: {
      nodeId: string;
      tag: string;
      baseEtag: string;
      actor?: string;
    }
  ) {
    return this.call("docs.tag.add", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user",
    });
  }
  /** User-only detach one tag from Node (does not prune registry). */
  docsTagRemove(
    workspaceId: string,
    args: {
      nodeId: string;
      tag: string;
      baseEtag: string;
      actor?: string;
    }
  ) {
    return this.call("docs.tag.remove", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user",
    });
  }

  /**
   * Read-only first-class semantic relations for a Node.
   * Outgoing from source frontmatter; incoming derived from other Nodes.
   * Does not include Markdown/wiki body links.
   */
  relationList(
    workspaceId: string,
    args: { nodeId: string }
  ) {
    return this.call<RelationListResult>("relation.list", { workspaceId, ...args });
  }

  /**
   * User-only create semantic relation on source Node (MutationBus + baseEtag).
   * Missing baseEtag → -32008; stale → -32009. Emits node.changed reason relation.create.
   */
  relationCreate(
    workspaceId: string,
    args: {
      nodeId: string;
      kind: string;
      direction: "directed" | "bidirectional";
      label?: string;
      target: RelationTargetWire;
      baseEtag: string;
      actor?: string;
    }
  ) {
    return this.call<RelationMutationResult>("relation.create", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user",
    });
  }

  /**
   * User-only update semantic relation (cannot change id/source).
   * label: null clears. Emits node.changed reason relation.update.
   */
  relationUpdate(
    workspaceId: string,
    args: {
      nodeId: string;
      relationId: string;
      kind?: string;
      direction?: "directed" | "bidirectional";
      label?: string | null;
      target?: RelationTargetWire;
      baseEtag: string;
      actor?: string;
    }
  ) {
    return this.call<RelationMutationResult>("relation.update", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user",
    });
  }

  /**
   * User-only delete semantic relation by id on source Node.
   * Missing id fails loudly. Emits node.changed reason relation.delete.
   */
  relationDelete(
    workspaceId: string,
    args: {
      nodeId: string;
      relationId: string;
      baseEtag: string;
      actor?: string;
    }
  ) {
    return this.call<RelationDeleteResult>("relation.delete", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user",
    });
  }

  // ---- convenience: registry ----
  /** Read-only global tag vocabulary. */
  registryTags(workspaceId: string) {
    return this.call("registry.tags", { workspaceId });
  }
  /** User-only ensure tag in global vocabulary. Emits registry.tags.updated. */
  registryTagCreate(
    workspaceId: string,
    args: { name: string; actor?: string }
  ) {
    return this.call("registry.tag.create", {
      workspaceId,
      name: args.name,
      actor: args.actor ?? "user",
    });
  }
  /** User-only global tag delete + cascade off Nodes. Emits registry.tags.updated. */
  registryTagDelete(
    workspaceId: string,
    args: { name: string; actor?: string }
  ) {
    return this.call("registry.tag.delete", {
      workspaceId,
      name: args.name,
      actor: args.actor ?? "user",
    });
  }
  /** Read-only durable Role registry projection (name-sorted). */
  registryRoles(workspaceId: string) {
    return this.call("registry.roles", { workspaceId });
  }
  /**
   * User-only role create (MutationBus). Pass fields at top level — never secrets.
   * Server assigns immutable roleId. `actor` defaults to "user"; non-user is rejected.
   */
  registryRoleCreate(
    workspaceId: string,
    role: {
      name: string;
      displayName?: string;
      prompt?: string;
      description?: string;
      color?: string;
      actor?: string;
    }
  ) {
    return this.call("registry.role.create", { workspaceId, ...role });
  }
  /**
   * User-only role update. Resolve by operational name (compat) or pass roleId in patch.
   * Operational name cannot be renamed in identity batch 1; change displayName instead.
   * Success emits exactly one registry.roles.updated.
   */
  registryRoleUpdate(
    workspaceId: string,
    name: string,
    patch: {
      /** Optional stable id ref (preferred when known). */
      roleId?: string;
      /** Mutable human label; null/empty resets to operational name. */
      displayName?: string | null;
      /** null or an empty string clears the field. */
      prompt?: string | null;
      /** null or an empty string clears the field. */
      description?: string | null;
      /** null or an empty string clears the field. */
      color?: string | null;
      actor?: string;
    }
  ) {
    return this.call("registry.role.update", { workspaceId, name, ...patch });
  }

  /**
   * User-only role delete. confirmation must equal operational name or roleId.
   * Refuses when the role has an active task or live managed session.
   */
  registryRoleDelete(
    workspaceId: string,
    name: string,
    confirmation: string,
    actor = "user"
  ) {
    return this.call("registry.role.delete", {
      workspaceId,
      name,
      confirmation,
      actor,
    });
  }

  // ---- convenience: machine-local Agent Connections (safe metadata / editor projection) ----
  connectionList(opts?: { includeTest?: boolean }) {
    return this.call("connection.list", opts ?? {});
  }
  connectionGet(connectionId: string) {
    return this.call("connection.get", { connectionId });
  }
  connectionCreate(connection: Record<string, unknown>) {
    return this.call("connection.create", connection);
  }
  /** Method connectionId always wins over patch data. */
  connectionUpdate(connectionId: string, patch: Record<string, unknown>) {
    return this.call("connection.update", { ...patch, connectionId });
  }
  connectionDelete(connectionId: string) {
    return this.call("connection.delete", { connectionId });
  }

  /**
   * Read-only product provider verification catalog.
   * Returns adapterId + verificationLevel (+ optional canResume/notes).
   * Distinct from connection.list (machine-local launch config). Never secrets.
   */
  providerCatalog() {
    return this.call<ProviderCatalogProjection>("provider.catalog", {});
  }

  // ---- privileged machine Settings launch secrets (never returns plaintext) ----
  settingsLaunchSecretList() {
    return this.call("settings.launchSecret.list", {});
  }
  /**
   * Store encrypted secret under id. Response is id/metadata only.
   * Callers must not log `secret`; RPC response never echoes it.
   */
  settingsLaunchSecretSet(id: string, secret: string, label?: string) {
    return this.call("settings.launchSecret.set", {
      id,
      secret,
      ...(label !== undefined ? { label } : {}),
    });
  }
  settingsLaunchSecretDelete(id: string) {
    return this.call("settings.launchSecret.delete", { id });
  }

  // ---- convenience: machine-local skills (bundled only; no workspaceId) ----
  skillList() {
    return this.call("skill.list", {});
  }
  /**
   * Install bundled skills into shared-agents and/or claude skill dirs.
   * Omitting skills installs all bundled; omitting targets installs both.
   * Does not accept arbitrary source/destination paths.
   */
  skillInstall(opts?: {
    skills?: string[];
    targets?: Array<"shared-agents" | "claude">;
    force?: boolean;
  }) {
    return this.call("skill.install", opts ?? {});
  }

  // ---- convenience: task ----
  taskDispatch(
    workspaceId: string,
    args: {
      /** Exact writable Nodes; each exact Node can have one active Task. */
      workNodeIds: string[];
      /** Shared read-only context Nodes; these never occupy a Node. */
      contextNodeIds: string[];
      prompt: string;
      /**
       * Explicit parent actor (V0.2). Required on every dispatch.
       * Role-dispatched Task Agent → { kind:"role", id:<role> }; user-direct → { kind:"user", id:"user" }.
       */
      requester: { kind: "user" | "role"; id: string };
      acceptMode?: "review-required" | "auto-accept" | "agent-decide";
    } & (
      | { assigneeRoleId: string; connectionId?: never }
      | { connectionId: string; assigneeRoleId?: never }
    )
  ) {
    return this.call("task.dispatch", { workspaceId, ...args });
  }
  taskClaim(workspaceId: string, taskPath: string) {
    return this.call("task.claim", { workspaceId, taskPath });
  }
  /**
   * Create and immediately claim a durable Role's own execution Task.
   * This is execution ownership, not downstream dispatch: there is no target,
   * caller-authored responsibility override or managed Session launch.
   */
  taskClaimDirect(
    workspaceId: string,
    args: {
      assigneeRoleId: string;
      workNodeIds: string[];
      contextNodeIds: string[];
      prompt: string;
      /** Optional exact current Task used only to inherit persisted responsibility. */
      sourceTaskPath?: string;
    }
  ) {
    return this.call("task.claimDirect", { workspaceId, ...args });
  }
  taskWait(
    workspaceId: string,
    taskPath: string,
    reason: string,
    summary: string
  ) {
    return this.call("task.wait", { workspaceId, taskPath, reason, summary });
  }
  taskResume(workspaceId: string, taskPath: string) {
    return this.call("task.resume", { workspaceId, taskPath });
  }
  /**
   * Exact executing Session requests a parent/user decision. Transport metadata
   * supplies requester identity; options are optional because custom/deny are universal.
   */
  taskRequestDecision(
    workspaceId: string,
    taskPath: string,
    args: {
      question: string;
      options?: Array<{ id: string; label: string }>;
    }
  ) {
    return this.call("task.requestDecision", { workspaceId, taskPath, ...args });
  }
  /**
   * U2A one-shot append to a running/waiting managed task (user-only).
   * Provide text and/or contextRefs (stable entity ids). Not chat; not a Decision response.
   */
  taskSendInput(
    workspaceId: string,
    taskPath: string,
    args: {
      text?: string;
      contextRefs?: string[];
      actor?: string;
    }
  ) {
    return this.call("task.sendInput", { workspaceId, taskPath, ...args });
  }
  taskSubmit(
    workspaceId: string,
    taskPath: string,
    args: {
      report: string;
      commits?: string[];
      checks?: unknown[];
      artifactRefs?: import("../core/artifact.js").ArtifactRef[];
      decision?: string;
    }
  ) {
    return this.call("task.submit", { workspaceId, taskPath, ...args });
  }
  taskAccept(
    workspaceId: string,
    resultId: string,
    actor: string
  ) {
    return this.call("task.accept", {
      workspaceId,
      resultId,
      actor,
    });
  }
  taskReject(
    workspaceId: string,
    resultId: string,
    actor: string,
    opts?: { note?: string; resume?: boolean }
  ) {
    return this.call("task.reject", { workspaceId, resultId, actor, ...opts });
  }
  taskInterrupt(workspaceId: string, taskPath: string) {
    return this.call("task.interrupt", { workspaceId, taskPath });
  }
  taskCancel(workspaceId: string, taskPath: string) {
    return this.call("task.cancel", { workspaceId, taskPath });
  }
  taskStartSession(
    workspaceId: string,
    args: {
      taskPath: string;
      callerKind?: "user" | "role";
      bootstrapPrompt?: string;
    }
  ) {
    return this.call("task.startSession", { workspaceId, ...args });
  }
  /**
   * Explicit fresh managed Session on the same Task when the bound provider
   * context is unusable. Not a silent fallback from taskStartSession.
   * Uses the Session's immutable Agent Connection snapshot; refuses isTurnActive with
   * TURN_BUSY (no force).
   * Shares the per-Task managed-session execution slot with startSession.
   */
  taskReplaceSession(
    workspaceId: string,
    args: {
      taskPath: string;
      callerKind?: "user" | "role";
    }
  ) {
    return this.call("task.replaceSession", { workspaceId, ...args });
  }
  taskList(workspaceId: string) {
    return this.call("task.list", { workspaceId });
  }
  taskGet(workspaceId: string, taskPath: string) {
    return this.call("task.get", { workspaceId, taskPath });
  }

  /** Optional selected Node collaboration + user-actionable Inbox in one authoritative read. */
  workspaceCollaboration(workspaceId: string, nodeId?: string) {
    return this.call<WorkspaceCollaborationProjection>("workspace.collaboration", {
      workspaceId,
      ...(nodeId ? { nodeId } : {}),
    });
  }

  /**
   * List Task Results for a workspace (optional Task / Node / responsibility filters).
   * Read projection only — review still uses task.accept / task.reject.
   */
  taskResultList(
    workspaceId: string,
    opts?: {
      taskId?: string;
      nodeId?: string;
      assigneeRoleId?: string;
      executionSessionId?: string;
    }
  ) {
    return this.call<{ workspaceId: string; results: TaskResultProjection[] }>(
      "taskResult.list",
      { workspaceId, ...opts }
    );
  }

  /** Get one Task Result by id within a workspace. */
  taskResultGet(workspaceId: string, id: string) {
    return this.call<{ workspaceId: string; result: TaskResultProjection }>(
      "taskResult.get",
      { workspaceId, id }
    );
  }

  /**
   * V0.2 Output provenance: Output → Task Result → Task → sourceNode by id.
   * Unbound type=output returns bound:false; never infers by path/name/time.
   */
  outputProvenance(
    workspaceId: string,
    nodeId: string
  ) {
    return this.call<OutputProvenance>("output.provenance", {
      workspaceId,
      nodeId,
    });
  }

  /**
   * Workspace-level graph projection for Working-set Canvas.
   * Node summaries include the raw document etag; no body or placement state.
   * Parent / markdown / wiki / relation edges remain separately partitioned.
   * Unresolved Node links are retained with an explicit unresolved payload.
   */
  graphProjection(workspaceId: string) {
    return this.call<GraphProjection>("graph.projection", { workspaceId });
  }

  // ---- convenience: proposal (triage; separate from Task Result review) ----
  proposalList(
    workspaceId: string,
    opts?: { nodeId?: string; status?: "pending" | "accepted" | "rejected" | "all" }
  ) {
    return this.call("proposal.list", { workspaceId, ...opts });
  }
  proposalSubmit(
    workspaceId: string,
    args: { nodeId: string; role: string; body: string }
  ) {
    return this.call("proposal.submit", { workspaceId, ...args });
  }
  /**
   * User-only resolve (accept|reject). actor defaults to "user";
   * non-user actors are rejected by the service.
   */
  proposalResolve(
    workspaceId: string,
    path: string,
    decision: "accept" | "reject",
    actor = "user"
  ) {
    return this.call("proposal.resolve", { workspaceId, path, decision, actor });
  }

  sessionList(workspaceId?: string): Promise<{ sessions: SessionProjection[] }> {
    return this.call<{ sessions: SessionProjection[] }>(
      "session.list",
      workspaceId ? { workspaceId } : {}
    );
  }
  sessionGet(sessionId: string): Promise<{ session: SessionProjection }> {
    return this.call<{ session: SessionProjection }>("session.get", { sessionId });
  }

  /**
   * Register or reuse a pull-host external session (no ACP spawn).
   * Machine-callable; idempotent for sessionId / externalKey.
   */
  sessionEnter(
    args: {
      workspaceId?: string;
      sessionId?: string;
      roleId?: string;
      externalKey?: string;
      currentTaskId?: string;
      cwd?: string;
    } = {}
  ) {
    return this.call("session.enter", { ...args });
  }

  /** Probe external/managed session + incomplete task bindings. */
  sessionStatus(
    args: {
      workspaceId?: string;
      sessionId?: string;
      externalKey?: string;
      key?: string;
    } = {}
  ) {
    return this.call("session.status", { ...args });
  }

  /**
   * End external Session binding only — never submit/review TaskResults.
   * Reports incompleteTasks still bound to the sessionId / externalKey.
   * Accepts either a sessionId string or an options object (hook closed-loop).
   */
  sessionLeave(
    sessionIdOrArgs:
      | string
      | {
          sessionId?: string;
          workspaceId?: string;
          externalKey?: string;
          key?: string;
        },
    workspaceId?: string
  ) {
    if (typeof sessionIdOrArgs === "string") {
      return this.call("session.leave", {
        sessionId: sessionIdOrArgs,
        ...(workspaceId ? { workspaceId } : {}),
      });
    }
    return this.call("session.leave", { ...sessionIdOrArgs });
  }

  /** ACP tool permission pending list (permissionPolicy=ask). */
  toolApprovalListPending(workspaceId?: string) {
    return this.call("toolApproval.listPending", workspaceId ? { workspaceId } : {});
  }
  toolApprovalGet(approvalId: string) {
    return this.call("toolApproval.get", { approvalId });
  }
  /** User-only: allow_once for one ACP tool request. */
  toolApprovalApproveOnce(approvalId: string, actor = "user") {
    return this.call("toolApproval.approveOnce", { approvalId, actor });
  }
  /** User-only: deny/cancel one ACP tool request. */
  toolApprovalDeny(approvalId: string, actor = "user") {
    return this.call("toolApproval.deny", { approvalId, actor });
  }

  /** Pending Decision Requests visible to the authenticated user/Role authority. */
  decisionRequestListPending(workspaceId: string) {
    return this.call("decisionRequest.listPending", { workspaceId });
  }
  decisionRequestGet(workspaceId: string, taskPath: string, requestId: string) {
    return this.call("decisionRequest.get", { workspaceId, taskPath, requestId });
  }
  /** Respond through authenticated transport authority; caller actor text is forbidden. */
  decisionRequestRespond(
    workspaceId: string,
    requestId: string,
    response:
      | { kind: "option"; optionId: string }
      | { kind: "custom"; text: string }
      | { kind: "deny" }
  ) {
    return this.call("decisionRequest.respond", {
      workspaceId,
      requestId,
      response,
    });
  }
  decisionRequestEscalate(workspaceId: string, taskPath: string, requestId: string) {
    return this.call("decisionRequest.escalate", { workspaceId, taskPath, requestId });
  }

  /**
   * Unified A2U pending read projection for one workspace.
   * Aggregates user-targeted Decision Requests / toolApproval / ready Task Results.
   * Resolve actions stay on domain RPCs — no interaction.resolve.
   */
  interactionListPending(workspaceId: string) {
    return this.call<PendingInteractionListResult>("interaction.listPending", {
      workspaceId,
    });
  }

  /**
   * U2A attention rows for external/parent review (pending|failed|uncertain).
   * This projection is never a provider inject source.
   * Always requires workspaceId + taskPath — no machine-global inbox.
   */
  taskInputListPending(workspaceId: string, taskPath: string) {
    return this.call("taskInput.listPending", { workspaceId, taskPath });
  }
  /**
   * Scoped get: workspaceId + taskPath + inputId (no id-only lookup).
   */
  taskInputGet(workspaceId: string, taskPath: string, inputId: string) {
    return this.call("taskInput.get", { workspaceId, taskPath, inputId });
  }
  /**
   * Formal ack after observing one-shot input. Omit actor for the user path;
   * Role/session callers pass their exact bound identity.
   */
  taskInputAck(
    workspaceId: string,
    taskPath: string,
    inputId: string,
    actor?: string
  ) {
    return this.call("taskInput.ack", {
      workspaceId,
      taskPath,
      inputId,
      ...(actor ? { actor } : {}),
    });
  }

  /**
   * User-only operational retention preview (task-api §6).
   * Read-only: returns candidates/skipped/warnings; never mutates.
   * `keepTerminalTasksDays` defaults to 30; `0` = immediately eligible.
   */
  operationalRetentionPreview(
    workspaceId: string,
    opts?: { keepTerminalTasksDays?: number; actor?: string }
  ) {
    return this.call("operationalRetention.preview", {
      workspaceId,
      ...opts,
    });
  }

  /**
   * User-only operational retention purge (task-api §6).
   * Mutates via MutationBus; emits exactly one retention.purged when files are deleted.
   */
  operationalRetentionPurge(
    workspaceId: string,
    opts?: { keepTerminalTasksDays?: number; actor?: string }
  ) {
    return this.call("operationalRetention.purge", {
      workspaceId,
      ...opts,
    });
  }

  /**
   * Read-only Task worktree reclaim diagnostic (task-api WorkspaceLane GC).
   * Does not remove anything; reclaim occurs only through explicit exact-Task reconciliation.
   */
  taskWorktreeReclaimPreview(workspaceId: string, taskPath: string) {
    return this.call("task.worktreeReclaim.preview", {
      workspaceId,
      taskPath,
    });
  }

  /**
   * Transport-bound local-user or parent-Role exact-task reclaim. Reloads one
   * Task and reuses ownership/dirty/exact-session/integration gates; never scans.
   */
  taskWorktreeReclaimReconcile(
    workspaceId: string,
    taskPath: string,
    actor: string
  ) {
    return this.call("task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor,
    });
  }

  /**
   * List Node Markdown underline annotations for a node (cx- identity).
   * Projection includes live relocate state; does not rewrite stored anchors.
   */
  annotationList(
    workspaceId: string,
    nodeId: string
  ) {
    return this.call("annotation.list", { workspaceId, nodeId });
  }

  /**
   * User-only create underline annotation (MutationBus).
   * Validates range/quote against authoritative body; documentEtag uses docs.readForEdit etag.
   * Events: annotation.changed (invalidation only). Never injects Agent / TaskInput.
   */
  annotationCreate(
    workspaceId: string,
    args: {
      nodeId: string;
      quote: string;
      start: number;
      end: number;
      body: string;
      documentEtag: string;
      actor?: string;
    }
  ) {
    return this.call("annotation.create", {
      workspaceId,
      nodeId: args.nodeId,
      quote: args.quote,
      start: args.start,
      end: args.end,
      body: args.body,
      documentEtag: args.documentEtag,
      actor: args.actor ?? "user",
    });
  }

  /** User-only resolve annotation (open → resolved). */
  annotationResolve(workspaceId: string, id: string, actor = "user") {
    return this.call("annotation.resolve", { workspaceId, id, actor });
  }

  /** User-only reopen annotation (resolved → open). */
  annotationReopen(workspaceId: string, id: string, actor = "user") {
    return this.call("annotation.reopen", { workspaceId, id, actor });
  }

  /** User-only delete annotation record. */
  annotationDelete(workspaceId: string, id: string, actor = "user") {
    return this.call("annotation.delete", { workspaceId, id, actor });
  }

  /**
   * Subscribe to SSE events. Returns an abort handle.
   * Requires a global EventSource-compatible environment; for Node tests prefer
   * fetch streaming or EventBus in-process.
   */
  subscribeEvents(
    onEvent: (ev: EventEnvelope) => void,
    onError?: (err: unknown) => void
  ): { close: () => void } {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/events`, {
          headers: { [AUTH_TOKEN_HEADER]: this.token, accept: "text/event-stream" },
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          onError?.(new Error(`SSE HTTP ${res.status}`));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(6)) as EventEnvelope;
              onEvent(payload);
            } catch {
              // ignore malformed
            }
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) onError?.(err);
      }
    })();
    return { close: () => ac.abort() };
  }
}

export function createServiceClient(options: ServiceClientOptions): ServiceClient {
  return new ServiceClient(options);
}
