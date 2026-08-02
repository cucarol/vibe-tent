// Loopback HTTP + JSON-RPC 2.0 attach transport for Local Tent Service.
// B5: loopback token required for /rpc and /events; /health stays open for discovery.

import * as http from "node:http";
import type { EventEnvelope } from "./types.js";
import type { EventBus } from "./events.js";
import { dispatchMethod, RpcError, type HandlerContext } from "./handlers.js";
import {
  deriveSessionToken,
  extractCallerSessionContext,
  extractRequestToken,
  tokensEqual,
} from "./auth.js";
import { RPC_LIFECYCLE, RPC_UNAUTHORIZED } from "./types.js";
import { isLoopbackServiceHost, serviceBaseUrl } from "./data-dir.js";

/**
 * RpcError may cross tsx dual-module boundaries where `instanceof` fails.
 * Accept class identity, name, or numeric application code shape.
 */
function isServiceRpcError(
  error: unknown
): error is { code: number; message: string; data?: unknown } {
  if (error instanceof RpcError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "RpcError" || error.constructor?.name === "RpcError") {
    const code = (error as { code?: unknown }).code;
    return typeof code === "number";
  }
  return false;
}

/**
 * TaskLifecycleError may surface as a plain Error when class identity splits.
 * Narrow by name or stable INVALID_TRANSITION message; optional `code` is read
 * after the guard without an Error→{code:string} cast (strict TS).
 */
function isTaskLifecycleErrorHttp(
  error: unknown
): error is Error & { code?: unknown } {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TaskLifecycleError" ||
    /^Invalid task transition:/.test(error.message)
  );
}

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

// WHATWG Fetch blocked ports relevant to HTTP clients (Chromium/undici).
// Windows may allocate one of these even for listen(0), notably 6000.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530,
  531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6697, 10080,
]);

// A 25 MiB binary attachment expands to ~33.4 MiB as base64. Keep bounded
// transport headroom for JSON fields without allowing unbounded buffering.
export const MAX_RPC_BODY_BYTES = 36 * 1024 * 1024;
export const MAX_SSE_QUEUE_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`RPC request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port);
}

/** Local Service is never a LAN/WAN server; accept literal loopback IPs only. */
export async function createServiceHttpServer(options: CreateHttpServerOptions): Promise<ServiceHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const preferredPort = options.port ?? 0;
  if (!isLoopbackServiceHost(host)) {
    throw new Error(
      `Local Tent Service host must be a literal loopback address (127.0.0.0/8 or ::1), got: ${host}`
    );
  }

  const closeSseConnections = new Set<() => void>();
  const activeResponses = new Set<http.ServerResponse>();
  const server = http.createServer(async (req, res) => {
    activeResponses.add(res);
    const releaseResponse = () => activeResponses.delete(res);
    res.once("finish", releaseResponse);
    res.once("close", releaseResponse);
    try {
      await handleRequest(req, res, options, closeSseConnections);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      } else {
        res.destroy();
      }
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  let port = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    await listen(server, preferredPort, host);
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      await closeServer(server);
      throw new Error("Failed to bind Local Tent Service HTTP server");
    }
    port = addr.port;
    if (!isFetchBlockedPort(port)) break;
    await closeServer(server);
    if (preferredPort !== 0) {
      throw new Error(`Local Tent Service port ${port} is blocked by Fetch clients`);
    }
    port = 0;
  }
  if (!port) {
    throw new Error("Failed to allocate a Fetch-compatible Local Tent Service port");
  }
  let closePromise: Promise<void> | null = null;
  return {
    server,
    host,
    port,
    url: serviceBaseUrl(host, port),
    close: () => {
      if (closePromise) return closePromise;
      // Stop accepting first, then tear down long-lived streams. Finite RPCs
      // are allowed to drain before the close promise resolves.
      closePromise = closeServer(server);
      for (const response of activeResponses) {
        if (!response.headersSent) response.setHeader("connection", "close");
      }
      for (const closeSse of [...closeSseConnections]) closeSse();
      server.closeIdleConnections?.();
      return closePromise;
    },
  };
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: CreateHttpServerOptions,
  closeSseConnections: Set<() => void>
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
    handleSse(req, res, events, closeSseConnections);
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

    let raw: string;
    try {
      raw = await readBody(req, MAX_RPC_BODY_BYTES);
    } catch (error) {
      res.setHeader("connection", "close");
      if (error instanceof RequestBodyTooLargeError) {
        writeJson(res, 413, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32013,
            message: "RPC request body too large",
            data: { maxBytes: error.maxBytes },
          },
        });
      } else {
        writeJson(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Request body read failed" },
        });
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      writeJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      writeJson(res, 200, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }
    const message = parsed as JsonRpcRequest;

    const id = isRpcId(message.id) ? (message.id ?? null) : null;
    if (
      message.jsonrpc !== "2.0" ||
      !message.method ||
      typeof message.method !== "string" ||
      !isRpcId(message.id)
    ) {
      writeJson(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request: method required" },
      });
      return;
    }

    if (
      message.params !== undefined &&
      (!message.params || typeof message.params !== "object")
    ) {
      writeJson(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Invalid params: expected object or array" },
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
      const suppliedCaller = extractCallerSessionContext(req.headers);
      const callerSessionId =
        suppliedCaller.sessionId &&
        tokensEqual(
          deriveSessionToken(token, suppliedCaller.sessionId),
          suppliedCaller.sessionToken
        )
          ? suppliedCaller.sessionId
          : undefined;
      const result = await dispatchMethod(ctx, message.method, params, {
        callerSessionId,
        callerExternalKey: suppliedCaller.externalKey,
      });
      writeJson(res, 200, { jsonrpc: "2.0", id, result });
    } catch (error) {
      // Prefer instanceof; also accept dual-module RpcError (tsx path splits).
      if (isServiceRpcError(error)) {
        writeJson(res, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: error.code, message: error.message, data: error.data },
        });
        return;
      }
      // TaskLifecycleError may surface as a plain Error when class identity splits.
      if (isTaskLifecycleErrorHttp(error)) {
        const dataCode =
          typeof error.code === "string" ? error.code : "INVALID_TRANSITION";
        writeJson(res, 200, {
          jsonrpc: "2.0",
          id,
          error: {
            code: RPC_LIFECYCLE,
            message: error.message,
            data: { code: dataCode },
          },
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

function handleSse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  events: EventBus,
  closeSseConnections: Set<() => void>
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let closed = false;
  let blocked = false;
  let queuedBytes = 0;
  const queue: Array<{ payload: string; bytes: number }> = [];
  let unsubscribe = () => {};

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    queue.length = 0;
    queuedBytes = 0;
    closeSseConnections.delete(close);
    req.off("close", cleanup);
    res.off("close", cleanup);
    res.off("drain", flush);
  };

  const close = () => {
    if (closed) return;
    cleanup();
    // A graceful end can remain buffered forever behind a stalled SSE client.
    // Destroying only this long-lived stream lets finite RPCs drain normally.
    res.destroy();
  };

  const send = (payload: string) => {
    if (closed) return;
    const bytes = Buffer.byteLength(payload);
    if (bytes > MAX_SSE_QUEUE_BYTES || (blocked && queuedBytes + bytes > MAX_SSE_QUEUE_BYTES)) {
      close();
      return;
    }
    if (blocked) {
      queue.push({ payload, bytes });
      queuedBytes += bytes;
      return;
    }
    try {
      blocked = !res.write(payload);
    } catch {
      close();
    }
  };

  function flush(): void {
    if (closed) return;
    blocked = false;
    while (queue.length > 0) {
      const next = queue.shift()!;
      queuedBytes -= next.bytes;
      try {
        if (!res.write(next.payload)) {
          blocked = true;
          return;
        }
      } catch {
        close();
        return;
      }
    }
  }

  const onEvent = (event: EventEnvelope) => {
    send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  unsubscribe = events.subscribe(onEvent);

  const heartbeat = setInterval(() => send(": ping\n\n"), 15000);

  closeSseConnections.add(close);
  req.once("close", cleanup);
  res.once("close", cleanup);
  res.on("drain", flush);
  send(": ok\n\n");
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      reject(new RequestBodyTooLargeError(maxBytes));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      action();
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        finish(() => reject(new RequestBodyTooLargeError(maxBytes)));
        req.resume();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish(() => resolve(Buffer.concat(chunks, total).toString("utf8")));
    const onError = (error: Error) => finish(() => reject(error));
    const onAborted = () => finish(() => reject(new Error("request aborted")));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function isRpcId(id: JsonRpcRequest["id"]): boolean {
  return id === undefined || id === null || typeof id === "string" || typeof id === "number";
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
