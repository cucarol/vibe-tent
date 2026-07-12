// Loopback HTTP + JSON-RPC 2.0 attach transport for Local Tent Service.
// B5: loopback token required for /rpc and /events; /health stays open for discovery.

import * as http from "node:http";
import type { EventEnvelope } from "./types.js";
import type { EventBus } from "./events.js";
import { dispatchMethod, RpcError, type HandlerContext } from "./handlers.js";
import { extractRequestToken, tokensEqual } from "./auth.js";
import { RPC_UNAUTHORIZED } from "./types.js";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface ServiceHttpServer {
  server: http.Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export interface CreateHttpServerOptions {
  host?: string;
  port?: number;
  ctx: HandlerContext;
  events: EventBus;
  /** Required bearer token for mutations and event streams. */
  token: string;
}

export async function createServiceHttpServer(options: CreateHttpServerOptions): Promise<ServiceHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const preferredPort = options.port ?? 0;

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, options);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, host, () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Failed to bind Local Tent Service HTTP server");
  }

  const port = addr.port;
  return {
    server,
    host,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: CreateHttpServerOptions
): Promise<void> {
  const { ctx, events, token } = options;
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  // Health is open so attach discovery can probe without token (no mutation).
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    const body = await dispatchMethod(ctx, "service.health", {});
    writeJson(res, 200, body);
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    if (!authorize(req, token)) {
      writeJson(res, 401, { error: "Unauthorized: invalid or missing service token" });
      return;
    }
    handleSse(req, res, events);
    return;
  }

  if (req.method === "POST" && (url.pathname === "/rpc" || url.pathname === "/")) {
    if (!authorize(req, token)) {
      writeJson(res, 401, {
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_UNAUTHORIZED, message: "Unauthorized: invalid or missing service token" },
      });
      return;
    }

    const raw = await readBody(req);
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(raw || "{}") as JsonRpcRequest;
    } catch {
      writeJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    const id = message.id ?? null;
    if (!message.method || typeof message.method !== "string") {
      writeJson(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request: method required" },
      });
      return;
    }

    const params =
      message.params === undefined
        ? undefined
        : Array.isArray(message.params)
          ? Object.fromEntries(
              (message.params as unknown[]).map((v, i) => [String(i), v])
            )
          : typeof message.params === "object" && message.params
            ? (message.params as Record<string, unknown>)
            : undefined;

    try {
      const result = await dispatchMethod(ctx, message.method, params);
      writeJson(res, 200, { jsonrpc: "2.0", id, result });
    } catch (error) {
      if (error instanceof RpcError) {
        writeJson(res, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: error.code, message: error.message, data: error.data },
        });
        return;
      }
      const messageText = error instanceof Error ? error.message : String(error);
      writeJson(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: messageText },
      });
    }
    return;
  }

  writeJson(res, 404, { error: "not found" });
}

function authorize(req: http.IncomingMessage, expectedToken: string): boolean {
  const provided = extractRequestToken(req.headers as Record<string, string | string[] | undefined>);
  return tokensEqual(expectedToken, provided);
}

function handleSse(req: http.IncomingMessage, res: http.ServerResponse, events: EventBus): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": ok\n\n");

  const onEvent = (event: EventEnvelope) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = events.subscribe(onEvent);

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Thin client helper for tests and future CLI attach. */
export async function rpcCall(
  baseUrl: string,
  method: string,
  params?: Record<string, unknown>,
  options?: { id?: string | number; token?: string }
): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
  const id = options?.id ?? 1;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options?.token) {
    headers["x-tent-token"] = options.token;
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (res.status === 401) {
    return {
      error: { code: RPC_UNAUTHORIZED, message: "Unauthorized: invalid or missing service token" },
    };
  }
  const json = (await res.json()) as {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };
  return json;
}
