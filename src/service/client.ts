// Typed ServiceClient for Desktop / CLI attach (task.* + docs.* only).

import type {
  BoxProjection,
  BoxProjectionsResult,
  DeliveryProjection,
  EventEnvelope,
  GraphProjection,
  NodeCollaboration,
  NodeCollaborationsResult,
  OutputProvenance,
  PendingInteractionListResult,
  ProviderCatalogProjection,
  RelationDeleteResult,
  RelationListResult,
  RelationMutationResult,
  RelationTargetWire,
} from "./types.js";
import { AUTH_TOKEN_HEADER } from "./auth.js";

export interface ServiceClientOptions {
  baseUrl: string;
  /** Loopback token from machine-local service.json (required for RPC/SSE). */
  token: string;
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
  private readonly fetchImpl: typeof fetch;
  private idSeq = 1;

  constructor(options: ServiceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`health HTTP ${res.status}`);
    return res.json();
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const rpc = await this.rpcRaw(method, params);
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
    params?: Record<string, unknown>
  ): Promise<{ result?: unknown; error?: RpcErrorBody }> {
    const id = this.idSeq++;
    const res = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AUTH_TOKEN_HEADER]: this.token,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
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
   * Read workspace collaboration settings projection (defaultDeliveryPolicy, extensible).
   * Missing file/field resolves to defaultDeliveryPolicy=review.
   * Historical on-disk `manual` is normalized to `review` at the settings read boundary.
   */
  workspaceSettings(workspaceId: string) {
    return this.call("workspace.settings", { workspaceId });
  }
  /**
   * User-only settings mutation (MutationBus).
   * Emits exactly one workspace.settings.updated on successful actual change; no-op emits none.
   * `actor` defaults to "user"; non-user is rejected by the service.
   * New writes accept review | bypass | agent-decide only (not historical manual).
   */
  workspaceSettingsUpdate(
    workspaceId: string,
    patch: {
      defaultDeliveryPolicy?: "review" | "bypass" | "agent-decide";
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
    return this.call("docs.list", { workspaceId, includeBody });
  }
  docsGet(workspaceId: string, idOrPath: { id?: string; path?: string }) {
    return this.call("docs.get", { workspaceId, ...idOrPath });
  }
  /**
   * Existing-node body/frontmatter write. baseEtag is required (from docs.readForEdit).
   * Missing → -32008; stale → -32009. Errors carry currentEtag only (no body).
   */
  docsWrite(
    workspaceId: string,
    args: {
      id?: string;
      path?: string;
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
    args: { name: string; type?: string; parentPath?: string }
  ) {
    return this.call("docs.createNote", { workspaceId, ...args });
  }
  docsFork(workspaceId: string, idOrPath: { id?: string; path?: string; boxId?: string }) {
    return this.call("docs.fork", { workspaceId, ...idOrPath });
  }
  /**
   * User-only atomic concept rename (MutationBus).
   * Resolve by id/path/boxId; pass newName only — cx- is immutable.
   * Success emits exactly one concept.changed with oldPath/path.
   */
  docsRename(
    workspaceId: string,
    args: { id?: string; path?: string; boxId?: string; newName: string; actor?: string }
  ) {
    return this.call("docs.rename", { workspaceId, ...args });
  }
  /**
   * User-only structural move / reparent (MutationBus).
   * Resolve by stable cx- id; expectedPath required for stale-path conflict.
   * newParentId null = tent root. position: inside | before/after siblingId.
   * Success emits exactly one concept.changed (reason docs.move) with oldPath/path/pathMap.
   */
  docsMove(
    workspaceId: string,
    args: {
      id: string;
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
      id?: string;
      path?: string;
      boxId?: string;
      mode: "editable" | "archived";
    }
  ) {
    return this.call("docs.setMode", { workspaceId, ...args });
  }
  /**
   * Import attachment bytes for a concept. Wire payload is base64; disk stores original bytes.
   */
  docsImportAttachment(
    workspaceId: string,
    args: {
      id?: string;
      path?: string;
      boxId?: string;
      fileName: string;
      bytesBase64: string;
    }
  ) {
    return this.call("docs.importAttachment", { workspaceId, ...args });
  }
  /**
   * User-only set compound Node type (MutationBus + baseEtag).
   * Missing baseEtag → -32008; stale → -32009. Emits concept.changed reason docs.setType.
   */
  docsSetType(
    workspaceId: string,
    args: {
      id?: string;
      path?: string;
      boxId?: string;
      type: string;
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
      id?: string;
      path?: string;
      boxId?: string;
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
      id?: string;
      path?: string;
      boxId?: string;
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
      id?: string;
      path?: string;
      boxId?: string;
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
    args: { id?: string; path?: string; boxId?: string }
  ) {
    return this.call<RelationListResult>("relation.list", { workspaceId, ...args });
  }

  /**
   * User-only create semantic relation on source Node (MutationBus + baseEtag).
   * Missing baseEtag → -32008; stale → -32009. Emits concept.changed reason relation.create.
   */
  relationCreate(
    workspaceId: string,
    args: {
      id?: string;
      path?: string;
      boxId?: string;
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
   * label: null clears. Emits concept.changed reason relation.update.
   */
  relationUpdate(
    workspaceId: string,
    args: {
      id?: string;
      path?: string;
      boxId?: string;
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
   * Missing id fails loudly. Emits concept.changed reason relation.delete.
   */
  relationDelete(
    workspaceId: string,
    args: {
      id?: string;
      path?: string;
      boxId?: string;
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
  registryTypes(workspaceId: string) {
    return this.call("registry.types", { workspaceId });
  }
  /**
   * User-only custom secondary type create. Primaries / built-ins fail loud.
   * Emits registry.types.updated.
   */
  registryTypeCreate(
    workspaceId: string,
    args: { name: string; actor?: string }
  ) {
    return this.call("registry.type.create", {
      workspaceId,
      name: args.name,
      actor: args.actor ?? "user",
    });
  }
  /**
   * User-only custom secondary type delete. confirmation must equal name.
   * In-use and built-in fail loud. Emits registry.types.updated.
   */
  registryTypeDelete(
    workspaceId: string,
    args: { name: string; confirmation: string; actor?: string }
  ) {
    return this.call("registry.type.delete", {
      workspaceId,
      name: args.name,
      confirmation: args.confirmation,
      actor: args.actor ?? "user",
    });
  }
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
      a2aPolicy?: "allow" | "ask" | "deny";
      allowedProfiles?: string[];
      cli?: { command: string; resume?: string };
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
      /** null or an empty string clears the field (effective deny). */
      a2aPolicy?: "allow" | "ask" | "deny" | null;
      /** null or an empty array clears the whitelist. */
      allowedProfiles?: string[] | null;
      /** null clears the host CLI hint. */
      cli?: { command: string; resume?: string } | null;
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

  // ---- convenience: machine-local profiles (safe metadata / editor projection) ----
  profileList(opts?: { includeTest?: boolean }) {
    return this.call("profile.list", opts ?? {});
  }
  profileGet(id: string) {
    return this.call("profile.get", { id });
  }
  profileCreate(profile: Record<string, unknown>) {
    return this.call("profile.create", profile);
  }
  /** Method `id` always wins over any `id` inside patch (spread cannot override). */
  profileUpdate(id: string, patch: Record<string, unknown>) {
    return this.call("profile.update", { ...patch, id });
  }
  profileDelete(id: string) {
    return this.call("profile.delete", { id });
  }

  /**
   * Read-only product provider verification catalog.
   * Returns adapterId + verificationLevel (+ optional canResume/notes).
   * Distinct from profile.list (machine-local launch config). Never secrets.
   */
  providerCatalog() {
    return this.call<ProviderCatalogProjection>("provider.catalog", {});
  }

  // ---- convenience: machine-local credentials (never returns secret) ----
  credentialList() {
    return this.call("credential.list", {});
  }
  /**
   * Store encrypted secret under id. Response is id/metadata only.
   * Callers must not log `secret`; RPC response never echoes it.
   */
  credentialSet(id: string, secret: string, metadata?: { label?: string }) {
    return this.call("credential.set", {
      id,
      secret,
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }
  credentialDelete(id: string) {
    return this.call("credential.delete", { id });
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
      boxId?: string;
      id?: string;
      /**
       * Required for assigneeKind=role (default). Optional/ignored for agentProfile
       * when equal to profileId; must not differ from profileId.
       */
      role?: string;
      /** Defaults to role. agentProfile requires profileId and does not register a role. */
      assigneeKind?: "role" | "agentProfile";
      prompt: string;
      /**
       * Explicit parent actor (V0.2). Required on every dispatch.
       * Role-dispatched Task Agent → { kind:"role", id:<role> }; user-direct → { kind:"user", id:"user" }.
       * Do not send legacy `dispatchedBy` (Service rejects it fail-loud).
       */
      parentActor: { kind: "user" | "role"; id: string };
      /**
       * Explicit reviewer (V0.2). Required; typically equals parentActor.
       * Ordinary accept/reject authority equals this actor only.
       */
      reviewer: { kind: "user" | "role"; id: string };
      /**
       * Sub-dispatch Git lane. When true, requires durable parent Role
       * and a real Git workspace lane; targetBranch becomes tent-role/<parent>.
       * asSub is lane-only — not review authority.
       */
      asSub?: boolean;
      deliveryPolicy?: string;
      startSession?: boolean;
      /**
       * Required for assigneeKind=agentProfile and whenever startSession is true.
       * For profile tasks this is also the stable assignee / delivery label.
       */
      profileId?: string;
      callerKind?: "user" | "role";
    }
  ) {
    return this.call("task.dispatch", { workspaceId, ...args });
  }
  taskClaim(workspaceId: string, taskPath: string, sessionId?: string) {
    return this.call("task.claim", { workspaceId, taskPath, sessionId });
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
   * A2U business ask: running task → pending UserAsk + waiting(user-input).
   * Not multi-turn chat. choices optional.
   */
  taskAskUser(
    workspaceId: string,
    taskPath: string,
    args: {
      question: string;
      choices?: Array<{ id: string; label: string }>;
    }
  ) {
    return this.call("task.askUser", { workspaceId, taskPath, ...args });
  }
  /**
   * U2A one-shot append to a running/waiting managed task (user-only).
   * Provide text and/or contextRefs (stable entity ids). Not chat; not UserAsk reply.
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
  taskDeliver(
    workspaceId: string,
    taskPath: string,
    args: {
      summary: string;
      commits?: string[];
      checks?: unknown[];
      artifactRefs?: unknown[];
      decision?: string;
    }
  ) {
    return this.call("task.deliver", { workspaceId, taskPath, ...args });
  }
  taskAccept(
    workspaceId: string,
    taskPath: string,
    actor: string,
    commits?: string[],
    opts?: { outputNodeIds?: string[] }
  ) {
    return this.call("task.accept", {
      workspaceId,
      taskPath,
      actor,
      commits,
      ...(opts?.outputNodeIds ? { outputNodeIds: opts.outputNodeIds } : {}),
    });
  }
  taskReject(
    workspaceId: string,
    taskPath: string,
    actor: string,
    opts?: { note?: string; resume?: boolean }
  ) {
    return this.call("task.reject", { workspaceId, taskPath, actor, ...opts });
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
      /** Required — no fake-default or product-profile fallback. */
      profileId: string;
      callerKind?: "user" | "role";
      bootstrapPrompt?: string;
      approvalId?: string;
    }
  ) {
    return this.call("task.startSession", { workspaceId, ...args });
  }
  /**
   * Explicit fresh managed Session on the same Task when the bound provider
   * context is unusable. Not a silent fallback from taskStartSession.
   * Same A2A params as startSession; refuses turnBusy with TURN_BUSY (no force).
   * Shares the per-Task managed-session execution slot with startSession.
   */
  taskReplaceSession(
    workspaceId: string,
    args: {
      taskPath: string;
      /** Required — must match agentProfile assignee when applicable. */
      profileId: string;
      callerKind?: "user" | "role";
      approvalId?: string;
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

  /**
   * List deliveries for a workspace (optional taskId / boxId / role filters).
   * Read projection only — review still uses task.accept / task.reject.
   */
  deliveryList(
    workspaceId: string,
    opts?: { taskId?: string; boxId?: string; role?: string }
  ) {
    return this.call<{ workspaceId: string; deliveries: DeliveryProjection[] }>(
      "delivery.list",
      { workspaceId, ...opts }
    );
  }

  /** Get one delivery by id within a workspace. */
  deliveryGet(workspaceId: string, id: string) {
    return this.call<{ workspaceId: string; delivery: DeliveryProjection }>(
      "delivery.get",
      { workspaceId, id }
    );
  }

  /**
   * @deprecated Prefer nodeCollaboration (V0.2). Migration-only.
   * Stable box collaboration projection (legacy task-api §2.3).
   * Resolve by id, boxId, or path (same conventions as docs.get).
   * Active task is authoritative; without one, only persisted done is preserved.
   */
  boxProjection(
    workspaceId: string,
    idOrPath: { id?: string; path?: string; boxId?: string }
  ) {
    return this.call<BoxProjection>("box.projection", { workspaceId, ...idOrPath });
  }

  /**
   * @deprecated Prefer nodeCollaborations (V0.2). Migration-only.
   * Batch box collaboration projection — same item semantics as box.projection.
   * `ids` order is preserved in the returned `projections` array.
   */
  boxProjections(workspaceId: string, ids: string[]) {
    return this.call<BoxProjectionsResult>("box.projections", { workspaceId, ids });
  }

  /**
   * V0.2 Node-keyed collaboration projection (task-api §2.3).
   * Resolve by id, boxId, or path (same conventions as docs.get).
   * At most one directly-claiming nonterminal Task; Session/Delivery only via explicit ids.
   * Idle Node returns null task/session/delivery.
   */
  nodeCollaboration(
    workspaceId: string,
    idOrPath: { id?: string; path?: string; boxId?: string }
  ) {
    return this.call<NodeCollaboration>("node.collaboration", {
      workspaceId,
      ...idOrPath,
    });
  }

  /**
   * V0.2 batch Node collaboration projection — same item semantics as node.collaboration.
   * `ids` order is preserved in the returned `items` array. Empty ids → empty items.
   * Loads workspace tasks/sessions/deliveries once per batch (no N+1).
   */
  nodeCollaborations(workspaceId: string, ids: string[]) {
    return this.call<NodeCollaborationsResult>("node.collaborations", {
      workspaceId,
      ids,
    });
  }

  /**
   * V0.2 Output provenance: Output → Delivery → Task → sourceNode by id.
   * Unbound type=output returns bound:false; never infers by path/name/time.
   */
  outputProvenance(
    workspaceId: string,
    idOrPath: { id?: string; path?: string; outputId?: string }
  ) {
    return this.call<OutputProvenance>("output.provenance", {
      workspaceId,
      ...idOrPath,
    });
  }

  /**
   * Workspace-level graph projection for Working-set Canvas.
   * Node summaries + parent / markdown / wiki edges; no body, no placement.
   * Unresolved concept links are retained with explicit unresolved payload.
   */
  graphProjection(workspaceId: string) {
    return this.call<GraphProjection>("graph.projection", { workspaceId });
  }

  // ---- convenience: proposal (triage; separate from delivery review) ----
  proposalList(
    workspaceId: string,
    opts?: { boxId?: string; status?: "pending" | "accepted" | "rejected" | "all" }
  ) {
    return this.call("proposal.list", { workspaceId, ...opts });
  }
  proposalSubmit(
    workspaceId: string,
    args: { boxId: string; role: string; body: string }
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

  sessionList(workspaceId?: string) {
    return this.call("session.list", workspaceId ? { workspaceId } : {});
  }
  sessionGet(sessionId: string) {
    return this.call("session.get", { sessionId });
  }

  /**
   * Register or reuse a pull-host external session (no ACP spawn).
   * Machine-callable; idempotent for sessionId / externalKey.
   */
  sessionEnter(
    args: {
      workspaceId?: string;
      sessionId?: string;
      profileId?: string;
      roleName?: string;
      role?: string;
      externalKey?: string;
      lastTaskId?: string;
      cwd?: string;
      assigneeKind?: "role" | "agentProfile";
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
   * End external session binding only — never deliver/accept tasks.
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

  a2aListPending(workspaceId?: string) {
    return this.call("a2a.listPending", workspaceId ? { workspaceId } : {});
  }
  a2aResolve(approvalId: string, decision: "approve" | "deny", actor = "user") {
    return this.call("a2a.resolve", { approvalId, decision, actor });
  }

  /** ACP tool permission pending list (permissionPolicy=ask). Not A2A spawn. */
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

  /** A2U UserAsk pending list (business questions). Not tool permission / not chat. */
  userAskListPending(workspaceId?: string) {
    return this.call("userAsk.listPending", workspaceId ? { workspaceId } : {});
  }
  userAskGet(askId: string) {
    return this.call("userAsk.get", { askId });
  }
  /** User-only: answer a business ask; resumes task + optional managed continue. */
  userAskReply(
    askId: string,
    args: { answer?: string; choiceId?: string; actor?: string } = {}
  ) {
    return this.call("userAsk.reply", {
      askId,
      actor: args.actor ?? "user",
      answer: args.answer,
      choiceId: args.choiceId,
    });
  }
  /** User-only: deny a business ask; resumes task for rework/observe. */
  userAskDeny(askId: string, actor = "user") {
    return this.call("userAsk.deny", { askId, actor });
  }

  /**
   * Unified A2U pending read projection for one workspace.
   * Aggregates UserAsk / A2A / toolApproval / ready Delivery.
   * Resolve actions stay on domain RPCs — no interaction.resolve.
   */
  interactionListPending(workspaceId: string) {
    return this.call<PendingInteractionListResult>("interaction.listPending", {
      workspaceId,
    });
  }

  /**
   * U2A pending one-shot inputs for external poll.
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
   * External agent formal ack after observing one-shot input (poll+ack).
   * Actor must match stored task role / session binding; scope is workspaceId+taskPath.
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
