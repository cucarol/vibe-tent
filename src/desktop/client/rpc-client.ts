// Typed JSON-RPC client for Local Tent Service (loopback HTTP).
// B5: endpoint token required on /rpc and /events; /health stays open.

import type { EventEnvelope } from "../../service/types.js";
import { AUTH_TOKEN_HEADER } from "../../service/auth.js";

export type RpcErrorBody = {
  code: number;
  message: string;
  data?: unknown;
};

export class ServiceRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(error: RpcErrorBody) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

export type RpcClientOptions = {
  baseUrl: string;
  /** Loopback token from machine-local service.json (required for RPC/SSE). */
  token: string;
  fetchImpl?: typeof fetch;
  /** Optional client id prefix for JSON-RPC id generation. */
  idPrefix?: string;
};

export class ServiceRpcClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly idPrefix: string;
  private seq = 0;
  readonly token: string;

  constructor(options: RpcClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.idPrefix = options.idPrefix ?? "desk";
  }

  get url(): string {
    return this.baseUrl;
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = `${this.idPrefix}-${++this.seq}`;
    const res = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AUTH_TOKEN_HEADER]: this.token,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (res.status === 401) {
      throw new ServiceRpcError({
        code: -32001,
        message: "Unauthorized: invalid or missing service token",
      });
    }
    if (!res.ok) {
      throw new Error(`Service RPC HTTP ${res.status} for ${method}`);
    }
    const json = (await res.json()) as {
      result?: T;
      error?: RpcErrorBody;
    };
    if (json.error) throw new ServiceRpcError(json.error);
    return json.result as T;
  }

  /**
   * Subscribe to SSE events with endpoint token.
   * Health remains unauthenticated; this path always sends X-Tent-Token.
   */
  subscribeEvents(
    onEvent: (ev: EventEnvelope) => void,
    onError?: (err: unknown) => void
  ): { close: () => void } {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/events`, {
          headers: {
            [AUTH_TOKEN_HEADER]: this.token,
            accept: "text/event-stream",
          },
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
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(6)) as EventEnvelope;
              onEvent(payload);
            } catch {
              // ignore malformed chunks
            }
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) onError?.(err);
      }
    })();
    return { close: () => ac.abort() };
  }

  async health(): Promise<{
    status: string;
    pid: number;
    version: string;
    /** Wire protocol; independent of package version. */
    protocolVersion?: number;
    startedAt: string;
    workspaceCount: number;
    foregroundWorkspaceId: string | null;
  }> {
    // Intentionally no token — /health is open for discovery probes.
    const res = await this.fetchImpl(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`Health check failed: HTTP ${res.status}`);
    return (await res.json()) as {
      status: string;
      pid: number;
      version: string;
      protocolVersion?: number;
      startedAt: string;
      workspaceCount: number;
      foregroundWorkspaceId: string | null;
    };
  }
}
