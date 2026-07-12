// Typed JSON-RPC client for Local Tent Service (loopback HTTP).

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
  fetchImpl?: typeof fetch;
  /** Optional client id prefix for JSON-RPC id generation. */
  idPrefix?: string;
};

export class ServiceRpcClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly idPrefix: string;
  private seq = 0;

  constructor(options: RpcClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
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

  async health(): Promise<{
    status: string;
    pid: number;
    version: string;
    startedAt: string;
    workspaceCount: number;
    foregroundWorkspaceId: string | null;
  }> {
    const res = await this.fetchImpl(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`Health check failed: HTTP ${res.status}`);
    return (await res.json()) as {
      status: string;
      pid: number;
      version: string;
      startedAt: string;
      workspaceCount: number;
      foregroundWorkspaceId: string | null;
    };
  }
}
