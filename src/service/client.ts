// Typed ServiceClient for Desktop / CLI attach (task.* + docs.* only).

import type { EventEnvelope } from "./types.js";
import { AUTH_TOKEN_HEADER } from "./auth.js";

export interface ServiceClientOptions {
  baseUrl: string;
  /** Loopback token from machine-local service.json (required for RPC/SSE). */
  token: string;
  /** Optional fetch implementation (tests). */
  fetchImpl?: typeof fetch;
}

export type RpcResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: { code: number; message: string; data?: unknown } };

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
  ): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
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
    return (await res.json()) as {
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
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

  // ---- convenience: docs ----
  docsList(workspaceId: string, includeBody = false) {
    return this.call("docs.list", { workspaceId, includeBody });
  }
  docsGet(workspaceId: string, idOrPath: { id?: string; path?: string }) {
    return this.call("docs.get", { workspaceId, ...idOrPath });
  }
  docsWrite(
    workspaceId: string,
    args: { id?: string; path?: string; body?: string; frontmatter?: Record<string, unknown>; baseEtag?: string }
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
  docsPromote(workspaceId: string, idOrPath: { id?: string; path?: string }, toType: string) {
    return this.call("docs.promote", { workspaceId, ...idOrPath, toType });
  }

  // ---- convenience: registry (read-only) ----
  registryTypes(workspaceId: string) {
    return this.call("registry.types", { workspaceId });
  }
  registryRoles(workspaceId: string) {
    return this.call("registry.roles", { workspaceId });
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

  // ---- convenience: task ----
  taskDispatch(
    workspaceId: string,
    args: {
      boxId?: string;
      id?: string;
      role: string;
      prompt: string;
      dispatchedBy?: string;
      deliveryPolicy?: string;
      startSession?: boolean;
      /** Required when startSession is true — no fake-default fallback. */
      profileId?: string;
      /**
       * Trusted harness/internal only. Role callers' policy is loaded from
       * role registry; ordinary clients cannot raise A2A via this field.
       */
      a2aPolicyOverride?: string;
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
  taskAccept(workspaceId: string, taskPath: string, actor: string, commits?: string[]) {
    return this.call("task.accept", { workspaceId, taskPath, actor, commits });
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
      /**
       * Trusted harness/internal only. Role policy comes from roles.json;
       * ordinary clients cannot override via RPC.
       */
      a2aPolicyOverride?: string;
      bootstrapPrompt?: string;
      approvalId?: string;
    }
  ) {
    return this.call("task.startSession", { workspaceId, ...args });
  }
  taskList(workspaceId: string) {
    return this.call("task.list", { workspaceId });
  }
  taskGet(workspaceId: string, taskPath: string) {
    return this.call("task.get", { workspaceId, taskPath });
  }

  sessionList(workspaceId?: string) {
    return this.call("session.list", workspaceId ? { workspaceId } : {});
  }
  sessionGet(sessionId: string) {
    return this.call("session.get", { sessionId });
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
