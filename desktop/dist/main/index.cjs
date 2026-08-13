"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/desktop/main/index.ts
var path6 = __toESM(require("node:path"), 1);
var import_electron3 = require("electron");

// src/desktop/client/service-attach.ts
var fs2 = __toESM(require("node:fs/promises"), 1);
var path2 = __toESM(require("node:path"), 1);
var import_node_child_process = require("node:child_process");

// src/service/data-dir.ts
var fs = __toESM(require("node:fs/promises"), 1);
var import_node_net = require("node:net");
var os = __toESM(require("node:os"), 1);
var path = __toESM(require("node:path"), 1);

// src/machine-state.ts
function isNotFoundError(err) {
  return !!err && typeof err === "object" && "code" in err && err.code === "ENOENT";
}

// src/service/data-dir.ts
var MAX_SERVICE_ENDPOINT_CANDIDATES = 32;
var MAX_SERVICE_ENDPOINT_FILE_BYTES = 16 * 1024;
var SERVICE_ENDPOINT_PREFIX = "service.endpoint.";
var SERVICE_ENDPOINT_SUFFIX = ".json";
var INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function defaultServiceDataDir(env = process.env) {
  if (env.TENT_SERVICE_DATA_DIR) return path.resolve(env.TENT_SERVICE_DATA_DIR);
  if (process.platform === "win32") {
    const base = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "Tent");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Tent");
  }
  const xdg = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdg, "tent");
}
function serviceBaseUrl(host2, port) {
  const authorityHost = (0, import_node_net.isIP)(host2) === 6 ? `[${host2}]` : host2;
  return `http://${authorityHost}:${port}`;
}
function isLoopbackServiceHost(host2) {
  const normalized = host2.trim().toLowerCase();
  const family = (0, import_node_net.isIP)(normalized);
  if (family === 4) return normalized.startsWith("127.");
  if (family === 6) {
    return normalized === "::1" || /^::ffff:127\./.test(normalized);
  }
  return false;
}
async function readServiceEndpointCandidates(dataDir2) {
  const names = await newestEndpointGenerationNames(dataDir2);
  const records = [];
  for (const name of names) {
    const file = path.join(dataDir2, name);
    try {
      const raw = await readBoundedEndpointFile(file);
      if (raw === null) continue;
      const value = parseServiceEndpointRecord(JSON.parse(raw));
      if (!value || endpointGenerationName(value.instanceId, value.startedAt) !== name) {
        continue;
      }
      records.push(value);
    } catch (error) {
      if (isNotFoundError(error) || error instanceof SyntaxError) continue;
      continue;
    }
  }
  return records;
}
function parseServiceEndpointRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value;
  if (typeof data.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(data.instanceId) || !Number.isInteger(data.pid) || (data.pid ?? 0) <= 0 || !Number.isInteger(data.port) || (data.port ?? 0) <= 0 || (data.port ?? 0) > 65535 || typeof data.host !== "string" || !isLoopbackServiceHost(data.host) || typeof data.startedAt !== "string" || !isCanonicalServiceStartedAt(data.startedAt) || typeof data.version !== "string" || data.token !== void 0 && typeof data.token !== "string") {
    return null;
  }
  return data;
}
function endpointGenerationName(instanceId, startedAt) {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error("Invalid Local Tent Service instance id");
  }
  if (!isCanonicalServiceStartedAt(startedAt)) {
    throw new Error("Invalid Local Tent Service startedAt");
  }
  const startedMs = Date.parse(startedAt);
  return `${SERVICE_ENDPOINT_PREFIX}${Math.trunc(startedMs).toString().padStart(16, "0")}.${instanceId}${SERVICE_ENDPOINT_SUFFIX}`;
}
function isCanonicalServiceStartedAt(value) {
  const startedMs = Date.parse(value);
  return Number.isFinite(startedMs) && startedMs >= 0 && new Date(startedMs).toISOString() === value;
}
async function newestEndpointGenerationNames(dataDir2) {
  const newest = [];
  let directory;
  try {
    directory = await fs.opendir(dataDir2);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  for await (const entry of directory) {
    if (!entry.isFile() || !isEndpointGenerationName(entry.name)) continue;
    const insertAt = newest.findIndex((name) => entry.name > name);
    if (insertAt < 0) newest.push(entry.name);
    else newest.splice(insertAt, 0, entry.name);
    if (newest.length > MAX_SERVICE_ENDPOINT_CANDIDATES) newest.pop();
  }
  return newest;
}
function isEndpointGenerationName(name) {
  if (!name.startsWith(SERVICE_ENDPOINT_PREFIX) || !name.endsWith(SERVICE_ENDPOINT_SUFFIX)) {
    return false;
  }
  const middle = name.slice(SERVICE_ENDPOINT_PREFIX.length, -SERVICE_ENDPOINT_SUFFIX.length);
  const separator = middle.indexOf(".");
  if (separator <= 0) return false;
  const timestamp = middle.slice(0, separator);
  const instanceId = middle.slice(separator + 1);
  return /^\d{16}$/.test(timestamp) && INSTANCE_ID_PATTERN.test(instanceId);
}
async function readBoundedEndpointFile(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.allocUnsafe(MAX_SERVICE_ENDPOINT_FILE_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        used,
        buffer.length - used,
        null
      );
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used === 0 || used > MAX_SERVICE_ENDPOINT_FILE_BYTES) return null;
    return buffer.subarray(0, used).toString("utf8");
  } finally {
    await handle?.close().catch(() => void 0);
  }
}

// src/service/protocol.ts
var TENT_SERVICE_PROTOCOL_VERSION = 9;
var ServiceProtocolIncompatibleError = class extends Error {
  constructor(kind, options = {}) {
    const servicePackageVersion = typeof options.servicePackageVersion === "string" && options.servicePackageVersion.trim() ? options.servicePackageVersion.trim() : "unknown";
    const serviceProtocolVersion = options.serviceProtocolVersion;
    const message = options.message ?? (kind === "missing" ? `Local Tent Service protocol is missing (legacy endpoint). This CLI requires protocol ${TENT_SERVICE_PROTOCOL_VERSION} (package version is 0.2.0; protocol is a separate contract). Service package version=${servicePackageVersion}. Restart or upgrade tent-service, then retry. Refusing to attach or spawn a competing service against an incompatible process.` : `Local Tent Service protocol mismatch: service=${String(serviceProtocolVersion)}, client=${TENT_SERVICE_PROTOCOL_VERSION} (package 0.2.0; protocol is separate). Service package version=${servicePackageVersion}. Restart or upgrade tent-service to a compatible build before any business RPC. Refusing attach success and refusing to spawn a competing service.`);
    super(message);
    this.code = "TENT_SERVICE_PROTOCOL_INCOMPATIBLE";
    this.name = "ServiceProtocolIncompatibleError";
    this.kind = kind;
    this.clientProtocolVersion = TENT_SERVICE_PROTOCOL_VERSION;
    this.serviceProtocolVersion = serviceProtocolVersion;
    this.servicePackageVersion = servicePackageVersion;
  }
};
function isServiceProtocolIncompatibleError(err) {
  return err instanceof ServiceProtocolIncompatibleError || typeof err === "object" && err !== null && err.code === "TENT_SERVICE_PROTOCOL_INCOMPATIBLE";
}
function assertServiceProtocolCompatible(health) {
  const servicePackageVersion = health && typeof health.version === "string" && health.version.trim() ? health.version.trim() : "unknown";
  const raw = health?.protocolVersion;
  if (raw === void 0 || raw === null) {
    throw new ServiceProtocolIncompatibleError("missing", {
      servicePackageVersion,
      serviceProtocolVersion: raw
    });
  }
  if (raw !== TENT_SERVICE_PROTOCOL_VERSION) {
    throw new ServiceProtocolIncompatibleError("mismatch", {
      servicePackageVersion,
      serviceProtocolVersion: raw
    });
  }
}

// src/service/endpoint-discovery.ts
var SERVICE_ENDPOINT_PROBE_TIMEOUT_MS = 1e3;
var OWNED_SERVICE_CHILD_STOP_TIMEOUT_MS = 2e3;
var MultipleHealthyServiceEndpointsError = class extends Error {
  constructor(endpoints) {
    super(
      `Multiple authenticated Local Tent Services are healthy: ${endpoints.map((endpoint) => `${endpoint.instanceId}@${serviceBaseUrl(endpoint.host, endpoint.port)}`).join(", ")}`
    );
    this.endpoints = endpoints;
    this.code = "MULTIPLE_HEALTHY_SERVICE_ENDPOINTS";
    this.name = "MultipleHealthyServiceEndpointsError";
  }
};
async function discoverAuthenticatedServiceEndpoint(dataDir2, probe) {
  const candidates = await readServiceEndpointCandidates(dataDir2);
  const results = await Promise.all(
    candidates.map(async (endpoint) => {
      if (!endpoint.token?.trim()) return { kind: "unhealthy", endpoint };
      let probed;
      try {
        probed = await runBoundedProbe(endpoint, probe);
      } catch {
        return { kind: "unhealthy", endpoint };
      }
      if (!probed || probed.health.status !== "ok") {
        return { kind: "unhealthy", endpoint };
      }
      try {
        assertServiceProtocolCompatible(probed.health);
      } catch (error) {
        if (isServiceProtocolIncompatibleError(error)) {
          return { kind: "incompatible", endpoint, error };
        }
        throw error;
      }
      if (probed.health.instanceId !== endpoint.instanceId || probed.health.pid !== endpoint.pid || probed.health.startedAt !== endpoint.startedAt) {
        return { kind: "unhealthy", endpoint };
      }
      return { kind: "compatible", endpoint, value: probed.value };
    })
  );
  const incompatible = results.find((result) => result.kind === "incompatible");
  if (incompatible?.kind === "incompatible") throw incompatible.error;
  const compatible = results.filter(
    (result) => result.kind === "compatible"
  );
  if (compatible.length > 1) {
    throw new MultipleHealthyServiceEndpointsError(
      compatible.map((result) => result.endpoint)
    );
  }
  return compatible[0]?.value ?? null;
}
async function runBoundedProbe(endpoint, probe) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      probe(endpoint, controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Local Tent Service authenticated probe timed out"));
        }, SERVICE_ENDPOINT_PROBE_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function stopOwnedServiceChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
  }
  if (await waitForChildExit(child, OWNED_SERVICE_CHILD_STOP_TIMEOUT_MS)) return;
  try {
    child.kill("SIGKILL");
  } catch {
  }
  if (await waitForChildExit(child, OWNED_SERVICE_CHILD_STOP_TIMEOUT_MS)) return;
  throw new Error(`Owned Local Tent Service child ${child.pid} did not exit`);
}
async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve5) => {
    let timer;
    const finish = (exited) => {
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve5(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(child.exitCode !== null || child.signalCode !== null);
    child.once("exit", onExit);
    child.once("error", onError);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// src/service/auth.ts
var AUTH_TOKEN_HEADER = "x-tent-token";

// src/desktop/client/rpc-client.ts
var ServiceRpcError = class extends Error {
  constructor(error) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
};
var ServiceRpcClient = class {
  constructor(options) {
    this.seq = 0;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.idPrefix = options.idPrefix ?? "desk";
  }
  get url() {
    return this.baseUrl;
  }
  async call(method, params, request) {
    const id = `${this.idPrefix}-${++this.seq}`;
    const res = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AUTH_TOKEN_HEADER]: this.token
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: request?.signal
    });
    if (res.status === 401) {
      throw new ServiceRpcError({
        code: -32001,
        message: "Unauthorized: invalid or missing service token"
      });
    }
    if (!res.ok) {
      throw new Error(`Service RPC HTTP ${res.status} for ${method}`);
    }
    const json = await res.json();
    if (json.error) throw new ServiceRpcError(json.error);
    return json.result;
  }
  /**
   * Subscribe to SSE events with endpoint token.
   * Health remains unauthenticated; this path always sends X-Tent-Token.
   */
  subscribeEvents(onEvent, onError) {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/events`, {
          headers: {
            [AUTH_TOKEN_HEADER]: this.token,
            accept: "text/event-stream"
          },
          signal: ac.signal
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
          if (done) {
            if (!ac.signal.aborted) {
              onError?.(new Error("SSE stream closed"));
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(6));
              onEvent(payload);
            } catch {
            }
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) onError?.(err);
      }
    })();
    return { close: () => ac.abort() };
  }
  async health() {
    const res = await this.fetchImpl(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`Health check failed: HTTP ${res.status}`);
    return await res.json();
  }
};

// src/desktop/client/service-attach.ts
async function attachOrStartService(options = {}) {
  const dataDir2 = options.dataDir ?? defaultServiceDataDir(options.env);
  const readyTimeoutMs = options.readyTimeoutMs ?? 15e3;
  const pollMs = options.pollMs ?? 200;
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnFn = options.spawnFn ?? import_node_child_process.spawn;
  const existing = await tryAttach(dataDir2, fetchImpl);
  if (existing) {
    return { ...existing, started: false, child: null };
  }
  if (options.attachOnly) {
    throw new Error(`No healthy Local Tent Service endpoint in ${dataDir2}`);
  }
  const entry = options.serviceEntry ?? await resolveDefaultServiceEntry();
  const entryAbs = path2.resolve(entry);
  const child = spawnFn(process.execPath, [entryAbs, "start", "--data-dir", dataDir2], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: serviceChildEnv(options.env, dataDir2),
    windowsHide: true,
    cwd: path2.dirname(entryAbs)
  });
  let spawnLog = "";
  child.stdout?.on("data", (c) => {
    spawnLog += c.toString("utf8");
  });
  child.stderr?.on("data", (c) => {
    spawnLog += c.toString("utf8");
  });
  child.on("error", (err) => {
    spawnLog += String(err);
  });
  child.unref();
  let attachSucceeded = false;
  try {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      const attached = await tryAttach(dataDir2, fetchImpl);
      if (attached) {
        attachSucceeded = true;
        return { ...attached, started: true, child };
      }
      await sleep(pollMs);
    }
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(
        `Local Tent Service exited before an endpoint became healthy (code=${child.exitCode}). entry=${entryAbs}
${spawnLog}`
      );
    }
    throw new Error(
      `Timed out waiting for Local Tent Service after spawn (entry=${entryAbs}, dataDir=${dataDir2})
${spawnLog}`
    );
  } finally {
    try {
      if (!attachSucceeded) await stopOwnedServiceChild(child);
    } finally {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }
}
function serviceChildEnv(overrides, dataDir2) {
  return {
    ...process.env,
    ...overrides,
    TENT_SERVICE_DATA_DIR: dataDir2,
    // The packaged runtime is Tent.exe (Electron), so opt into its Node mode
    // when spawning the standalone service entry.
    ELECTRON_RUN_AS_NODE: "1"
  };
}
async function tryAttach(dataDir2, fetchImpl = fetch) {
  return discoverAuthenticatedServiceEndpoint(dataDir2, async (endpoint, signal) => {
    const url = serviceBaseUrl(endpoint.host, endpoint.port);
    const client = new ServiceRpcClient({
      baseUrl: url,
      token: endpoint.token,
      fetchImpl
    });
    const health = await client.call(
      "service.health",
      {},
      { signal }
    );
    return { health, value: { url, endpoint, client } };
  });
}
function sameServiceEndpointIdentity(left, right) {
  return left.instanceId === right.instanceId && left.pid === right.pid && left.host === right.host && left.port === right.port && left.startedAt === right.startedAt && left.version === right.version && left.token === right.token;
}
async function resolveDefaultServiceEntry(cwd = process.cwd()) {
  const candidates = [
    path2.join(cwd, "service.mjs"),
    path2.join(cwd, "dist", "service.mjs"),
    path2.join(cwd, "desktop", "service.mjs")
  ];
  for (const c of candidates) {
    try {
      await fs2.access(c);
      return c;
    } catch {
    }
  }
  const src = path2.join(cwd, "src", "service", "cli.ts");
  try {
    await fs2.access(src);
    return src;
  } catch {
    return path2.join(cwd, "service.mjs");
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// src/desktop/main/service-host.ts
function isDesktopProjectionEventType(type) {
  return type === "node.changed" || type === "workspace.switched" || type === "service.health" || type === "registry.roles.updated" || type === "connection.changed" || type === "task.state" || type === "taskResult.updated" || type === "decisionRequest.pending" || type === "decisionRequest.resolved";
}
var DesktopServiceHost = class {
  constructor(attachService = attachOrStartService) {
    this.attachService = attachService;
    this.attach = null;
    this.child = null;
    this.eventsSub = null;
    this.eventListeners = /* @__PURE__ */ new Set();
    /** Coalesce bursty SSE by exact event type + workspace pair. */
    this.pendingPairs = /* @__PURE__ */ new Map();
    this.flushTimer = null;
    this.attachOptions = {};
    this.attachFlight = null;
  }
  get client() {
    return this.attach?.client ?? null;
  }
  get url() {
    return this.attach?.url ?? null;
  }
  get startedByUs() {
    return !!this.attach?.started;
  }
  /** Subscribe to filtered Service invalidations; payload is never merged as state. */
  onServiceEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  ensureAttached(options) {
    this.attachOptions = { ...this.attachOptions, ...options };
    if (this.attachFlight) return this.attachFlight;
    const frozenOptions = { ...this.attachOptions };
    const flight = this.ensureAttachedOnce(frozenOptions);
    const tracked = flight.finally(() => {
      if (this.attachFlight === tracked) this.attachFlight = null;
    });
    this.attachFlight = tracked;
    return tracked;
  }
  async ensureAttachedOnce(options) {
    const cached = this.attach;
    if (cached) {
      try {
        const dataDir2 = options.dataDir ?? defaultServiceDataDir(process.env);
        const discovered = await tryAttach(dataDir2);
        if (!discovered || !sameServiceEndpointIdentity(cached.endpoint, discovered.endpoint)) {
          throw new Error("Local Tent Service endpoint identity changed");
        }
        if (cached.client.token !== discovered.client.token || this.attach !== cached) {
          throw new Error("Local Tent Service authenticated attach is no longer current");
        }
        this.ensureEventSubscription();
        return cached;
      } catch (error) {
        this.invalidateCachedAttach(cached);
        if (isServiceProtocolIncompatibleError(error)) throw error;
      }
    }
    const result = await this.attachService({
      dataDir: options.dataDir,
      serviceEntry: options.serviceEntry,
      env: process.env
    });
    this.attach = result;
    this.child = result.child;
    this.ensureEventSubscription();
    return result;
  }
  ensureEventSubscription() {
    const attached = this.attach;
    if (!attached?.client || this.eventsSub) return;
    const subscription = attached.client.subscribeEvents(
      (ev) => this.handleEnvelope(ev),
      () => {
        this.handleEventStreamClosed(attached);
      }
    );
    if (this.attach !== attached) {
      subscription.close();
      return;
    }
    this.eventsSub = subscription;
  }
  handleEventStreamClosed(expectedAttach) {
    if (!this.invalidateCachedAttach(expectedAttach)) return;
    const event = { type: "service.disconnected", workspaceId: "" };
    for (const listener of this.eventListeners) listener(event);
  }
  invalidateCachedAttach(expectedAttach) {
    if (this.attach !== expectedAttach) return false;
    this.teardownEvents();
    this.attach = null;
    this.child = null;
    return true;
  }
  handleEnvelope(ev) {
    const type = ev?.type;
    if (typeof type !== "string" || !type) return;
    if (!isDesktopProjectionEventType(type)) return;
    const workspaceId = typeof ev.workspaceId === "string" ? ev.workspaceId : "";
    this.enqueueDesktopEvent({ type, workspaceId });
  }
  enqueueDesktopEvent(event) {
    const { type, workspaceId } = event;
    const pairKey = `${type}\0${workspaceId}`;
    this.pendingPairs.set(pairKey, event);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = [...this.pendingPairs.values()];
      this.pendingPairs.clear();
      for (const event2 of batch) {
        for (const listener of this.eventListeners) {
          listener(event2);
        }
      }
    }, 50);
  }
  teardownEvents() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingPairs.clear();
    const eventsSub = this.eventsSub;
    this.eventsSub = null;
    eventsSub?.close();
  }
  /**
   * Intentionally empty of service kill: closing the desktop shell must not stop
   * Local Service or in-flight tasks (architecture §2).
   */
  async disposeShellOnly() {
    this.teardownEvents();
    this.attach = null;
    this.child = null;
  }
};

// src/desktop/main/windows.ts
var path4 = __toESM(require("node:path"), 1);
var import_electron = require("electron");

// src/desktop/main/navigation-policy.ts
var path3 = __toESM(require("node:path"), 1);
var import_node_url = require("node:url");
function decideDesktopNavigation(requestedUrl, localHtmlPath) {
  let requested;
  try {
    requested = new URL(requestedUrl);
  } catch {
    return { kind: "deny" };
  }
  if (requested.protocol === "http:" || requested.protocol === "https:") {
    return { kind: "open-external", url: requested.href };
  }
  if (requested.protocol !== "file:") return { kind: "deny" };
  const expected = new URL((0, import_node_url.pathToFileURL)(path3.resolve(localHtmlPath)).href);
  requested.hash = "";
  if (requested.href === expected.href) return { kind: "allow-local" };
  return { kind: "deny" };
}
function installDesktopNavigationPolicy(webContents, localHtmlPath, openExternal) {
  const openInSystemBrowser = (url) => {
    void openExternal(url).catch((error) => {
      console.warn("Failed to open external URL:", error);
    });
  };
  webContents.on("will-navigate", (event, url) => {
    const decision = decideDesktopNavigation(url, localHtmlPath);
    if (decision.kind === "allow-local") return;
    event.preventDefault();
    if (decision.kind === "open-external") {
      openInSystemBrowser(decision.url);
    }
  });
  webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideDesktopNavigation(url, localHtmlPath);
    if (decision.kind === "open-external") {
      openInSystemBrowser(decision.url);
    }
    return { action: "deny" };
  });
}

// src/desktop/main/float-window-layout.ts
var FLOAT_WINDOW_BOUNDS = {
  defaultWidth: 328,
  defaultHeight: 280,
  minWidth: 300,
  maxWidth: 360,
  minHeight: 240,
  maxHeight: 360,
  edgeMargin: 24
};
function clampFinite(value, fallback, min, max) {
  const finite = Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(Math.max(finite, min), max);
}
function normalizeFloatWindowBounds(saved, workArea) {
  const width = clampFinite(
    saved?.width,
    FLOAT_WINDOW_BOUNDS.defaultWidth,
    FLOAT_WINDOW_BOUNDS.minWidth,
    Math.min(FLOAT_WINDOW_BOUNDS.maxWidth, workArea.width)
  );
  const height = clampFinite(
    saved?.height,
    FLOAT_WINDOW_BOUNDS.defaultHeight,
    FLOAT_WINDOW_BOUNDS.minHeight,
    Math.min(FLOAT_WINDOW_BOUNDS.maxHeight, workArea.height)
  );
  const fallbackX = workArea.x + workArea.width - width - FLOAT_WINDOW_BOUNDS.edgeMargin;
  const fallbackY = workArea.y + FLOAT_WINDOW_BOUNDS.edgeMargin;
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  return {
    width,
    height,
    x: clampFinite(saved?.x, fallbackX, workArea.x, Math.max(workArea.x, maxX)),
    y: clampFinite(saved?.y, fallbackY, workArea.y, Math.max(workArea.y, maxY))
  };
}

// src/desktop/main/windows.ts
function createMainWindow(paths, prefs, isDev2) {
  const bounds = prefs.mainWindowBounds;
  const opts = {
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 840,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: "\u5E37\u5E44 \xB7 Tent",
    backgroundColor: "#f4f1ea",
    ...process.platform === "win32" ? {
      // Let the renderer's pane headers double as the draggable title bar.
      // Native window controls remain available in the top-right overlay;
      // the application menu can still be revealed temporarily with Alt.
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#f4f1ea",
        symbolColor: "#1c1914",
        height: 56
      },
      autoHideMenuBar: true
    } : {},
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  };
  const win = new import_electron.BrowserWindow(opts);
  installDesktopNavigationPolicy(
    win.webContents,
    paths.mainHtml,
    (url) => import_electron.shell.openExternal(url)
  );
  void win.loadFile(paths.mainHtml);
  if (isDev2) {
    if (process.env.TENT_DESKTOP_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
  }
  win.once("ready-to-show", () => win.show());
  return win;
}
function createFloatWindow(paths, prefs) {
  const savedBounds = prefs.floatWindowBounds;
  const display = savedBounds ? import_electron.screen.getDisplayMatching(savedBounds).workArea : import_electron.screen.getPrimaryDisplay().workArea;
  const bounds = normalizeFloatWindowBounds(savedBounds, display);
  const win = new import_electron.BrowserWindow({
    ...bounds,
    minWidth: FLOAT_WINDOW_BOUNDS.minWidth,
    maxWidth: FLOAT_WINDOW_BOUNDS.maxWidth,
    minHeight: FLOAT_WINDOW_BOUNDS.minHeight,
    maxHeight: FLOAT_WINDOW_BOUNDS.maxHeight,
    show: false,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: "\u5E37\u5E44 \xB7 \u6D6E\u52A8\u63A7\u4EF6",
    backgroundColor: "#f7f7f8",
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  installDesktopNavigationPolicy(
    win.webContents,
    paths.floatHtml,
    (url) => import_electron.shell.openExternal(url)
  );
  void win.loadFile(paths.floatHtml);
  return win;
}
function resolveDesktopAssetPaths(appRoot2) {
  return {
    preload: path4.join(appRoot2, "desktop", "dist", "preload", "preload.cjs"),
    mainHtml: path4.join(appRoot2, "desktop", "dist", "renderer-next", "index.html"),
    floatHtml: path4.join(appRoot2, "desktop", "dist", "renderer", "float.html")
  };
}

// src/desktop/main/ipc.ts
var import_electron2 = require("electron");

// src/desktop/prefs.ts
var fs3 = __toESM(require("node:fs/promises"), 1);
var path5 = __toESM(require("node:path"), 1);

// src/desktop/types.ts
var DEFAULT_DESKTOP_PREFS = {
  recentWorkspaces: [],
  showFloatOnClose: true
};
var DESKTOP_IPC = {
  getState: "tent:get-state",
  mountWorkspace: "tent:mount-workspace",
  setForeground: "tent:set-foreground",
  listWorkspaces: "tent:list-workspaces",
  health: "tent:health",
  rpc: "tent:rpc",
  document: "tent:document",
  collaboration: "tent:collaboration",
  openMain: "tent:open-main",
  hideMain: "tent:hide-main",
  showFloat: "tent:show-float",
  hideFloat: "tent:hide-float",
  pushContextCard: "tent:push-context-card",
  getFloatingStatus: "tent:get-floating-status",
  pickWorkspaceFolder: "tent:pick-workspace-folder",
  getPrefs: "tent:get-prefs",
  setPrefs: "tent:set-prefs",
  onStateChanged: "tent:state-changed",
  /** Fan-out of Local Service SSE envelope type (renderer re-fetches projections). */
  onServiceEvent: "tent:service-event"
};

// src/desktop/prefs.ts
function desktopPrefsPath(dataDir2) {
  return path5.join(dataDir2 ?? defaultServiceDataDir(), "desktop.json");
}
async function loadDesktopPrefs(dataDir2) {
  try {
    const raw = await fs3.readFile(desktopPrefsPath(dataDir2), "utf8");
    const data = JSON.parse(raw);
    return {
      ...DEFAULT_DESKTOP_PREFS,
      ...data,
      recentWorkspaces: Array.isArray(data.recentWorkspaces) ? data.recentWorkspaces.filter((x) => typeof x === "string") : [],
      showFloatOnClose: data.showFloatOnClose !== false
    };
  } catch {
    return { ...DEFAULT_DESKTOP_PREFS, recentWorkspaces: [] };
  }
}
async function saveDesktopPrefs(prefs, dataDir2) {
  const file = desktopPrefsPath(dataDir2);
  await fs3.mkdir(path5.dirname(file), { recursive: true });
  await fs3.writeFile(file, JSON.stringify(prefs, null, 2) + "\n", "utf8");
}
function rememberWorkspace(prefs, root) {
  const resolved = root;
  const recent = [resolved, ...prefs.recentWorkspaces.filter((p) => p !== resolved)].slice(0, 12);
  return {
    ...prefs,
    recentWorkspaces: recent,
    lastWorkspaceRoot: resolved
  };
}

// src/core/context-card.ts
var CONTEXT_CARD_TEMPLATE_VERSION = "v1";
function buildContextCard(ref, options) {
  const kind = ref.kind;
  const id = ref.id.trim();
  if (!id) throw new Error("ContextRef.id cannot be empty.");
  if (!kind) throw new Error("ContextRef.kind is required.");
  const label = options?.label?.trim() || (ref.path ? `${kind}:${ref.path}` : `${kind}:${id}`);
  const prompt = formatContextCardPrompt(ref, options);
  return {
    contextRef: {
      kind,
      id,
      path: ref.path,
      fragment: ref.fragment
    },
    prompt,
    label,
    templateVersion: CONTEXT_CARD_TEMPLATE_VERSION
  };
}
function formatContextCardPrompt(ref, hints) {
  const opts = typeof hints === "string" ? { tentRootHint: hints } : hints ?? {};
  const systemRoot = opts.systemRoot?.trim() || opts.tentRootHint?.trim() || "";
  const workspaceRoot = opts.workspaceRoot?.trim() || "";
  const lines = [
    "Tent contextCard v1",
    `contextRef: ${ref.kind}/${ref.id}`
  ];
  if (ref.path) lines.push(`path: ${ref.path}`);
  if (ref.fragment) lines.push(`fragment: ${ref.fragment}`);
  if (workspaceRoot) lines.push(`workspaceRoot: ${workspaceRoot}`);
  if (systemRoot) {
    lines.push(`systemRoot: ${systemRoot}`);
    lines.push(`tentRoot: ${systemRoot}`);
  }
  if (ref.path) {
    const rel = ref.path.replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (rel && !rel.startsWith(".tent/")) {
      lines.push(`fileRead: .tent/${rel} (relative to workspaceRoot) or \${systemRoot}/${rel}`);
    }
  }
  lines.push(
    "CLI: run tent from workspaceRoot; taskPath is relative to systemRoot (.tent)."
  );
  lines.push("Do not invent missing content; fetch by id before answering.");
  lines.push("Do not resolve operational files as <workspaceRoot>/temp \u2014 use .tent/temp.");
  return lines.join("\n");
}
function nodeContextCard(nodeId, path7, opts) {
  return buildContextCard({ kind: "node", id: nodeId, path: path7 }, opts);
}
function taskContextCard(taskId, opts) {
  return buildContextCard({ kind: "task", id: taskId, path: opts?.path }, opts);
}
function contextCardToDragText(card) {
  return card.prompt;
}

// src/desktop/main/document-ipc-handler.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function handleDesktopDocumentRequest(client, request) {
  if (!client) {
    return {
      ok: false,
      error: { kind: "transport", message: "Service not attached" }
    };
  }
  if (!isRecord(request) || typeof request.workspaceId !== "string" || !request.workspaceId || typeof request.nodeId !== "string" || !request.nodeId) {
    return {
      ok: false,
      error: { kind: "invalid-request", message: "Invalid document request" }
    };
  }
  try {
    if (request.operation === "readForEdit") {
      return {
        ok: true,
        value: await client.call("docs.readForEdit", {
          workspaceId: request.workspaceId,
          nodeId: request.nodeId
        })
      };
    }
    if (request.operation === "backlinks") {
      return {
        ok: true,
        value: await client.call("docs.backlinks", {
          workspaceId: request.workspaceId,
          nodeId: request.nodeId
        })
      };
    }
    if (request.operation === "writeBody" && typeof request.body === "string") {
      return {
        ok: true,
        value: await client.call("docs.write", {
          workspaceId: request.workspaceId,
          nodeId: request.nodeId,
          body: request.body,
          ...typeof request.baseEtag === "string" && request.baseEtag ? { baseEtag: request.baseEtag } : {}
        })
      };
    }
    return {
      ok: false,
      error: { kind: "invalid-request", message: "Unsupported document request" }
    };
  } catch (cause) {
    if (cause instanceof ServiceRpcError) {
      return {
        ok: false,
        error: {
          kind: "rpc",
          code: cause.code,
          message: cause.message,
          data: cause.data
        }
      };
    }
    return {
      ok: false,
      error: {
        kind: "transport",
        message: cause instanceof Error ? cause.message : "Document request failed"
      }
    };
  }
}

// src/desktop/main/collaboration-ipc-handler.ts
var InvalidCollaborationResponseError = class extends Error {
};
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, keys) {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function uniqueStrings(value, allowEmpty) {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(nonEmpty) && new Set(value).size === value.length;
}
function normalizeRequest(raw) {
  if (!isRecord2(raw) || !nonEmpty(raw.operation) || !nonEmpty(raw.workspaceId)) return null;
  if (raw.operation === "targets" && exactKeys(raw, ["operation", "workspaceId"])) {
    return raw;
  }
  if (raw.operation === "dispatch" && exactKeys(raw, [
    "operation",
    "workspaceId",
    "workNodeIds",
    "contextNodeIds",
    "prompt",
    "target",
    "acceptMode"
  ]) && uniqueStrings(raw.workNodeIds, false) && uniqueStrings(raw.contextNodeIds, true) && raw.workNodeIds.every((id) => !raw.contextNodeIds.includes(id)) && nonEmpty(raw.prompt) && isRecord2(raw.target) && exactKeys(raw.target, ["kind", "id"]) && (raw.target.kind === "role" || raw.target.kind === "connection") && nonEmpty(raw.target.id) && (raw.acceptMode === "review-required" || raw.acceptMode === "auto-accept" || raw.acceptMode === "agent-decide")) return raw;
  if (raw.operation === "acceptTaskResult" && exactKeys(raw, ["operation", "workspaceId", "resultId"]) && nonEmpty(raw.resultId)) return raw;
  if (raw.operation === "rejectTaskResult" && exactKeys(raw, ["operation", "workspaceId", "resultId", "note", "resume"]) && nonEmpty(raw.resultId) && nonEmpty(raw.note) && raw.resume === true) return raw;
  if (raw.operation === "respondDecision" && exactKeys(raw, ["operation", "workspaceId", "requestId", "response"]) && nonEmpty(raw.requestId) && isRecord2(raw.response)) {
    const response = raw.response;
    if (response.kind === "option" && exactKeys(response, ["kind", "optionId"]) && nonEmpty(response.optionId) || response.kind === "custom" && exactKeys(response, ["kind", "text"]) && nonEmpty(response.text) || response.kind === "deny" && exactKeys(response, ["kind"])) return raw;
  }
  return null;
}
function dispatchTargets(rolesRaw, connectionsRaw, workspaceId) {
  if (!isRecord2(rolesRaw) || rolesRaw.workspaceId !== workspaceId || !Array.isArray(rolesRaw.roles) || !isRecord2(connectionsRaw) || !Array.isArray(connectionsRaw.connections)) throw new InvalidCollaborationResponseError("dispatch targets response is corrupt");
  const roles = rolesRaw.roles.map((item) => {
    if (!isRecord2(item) || !nonEmpty(item.roleId) || !nonEmpty(item.displayName) || !(item.description === void 0 || nonEmpty(item.description))) throw new InvalidCollaborationResponseError("Role target is corrupt");
    return {
      kind: "role",
      id: item.roleId,
      label: item.displayName,
      ...item.description ? { description: item.description } : {}
    };
  });
  const connections = connectionsRaw.connections.map((item) => {
    if (!isRecord2(item) || !nonEmpty(item.connectionId) || !nonEmpty(item.displayName)) {
      throw new InvalidCollaborationResponseError("Connection target is corrupt");
    }
    return { kind: "connection", id: item.connectionId, label: item.displayName };
  });
  return { workspaceId, targets: [...roles, ...connections] };
}
async function handleDesktopCollaborationRequest(client, rawRequest) {
  const request = normalizeRequest(rawRequest);
  if (!request) {
    return {
      ok: false,
      error: { kind: "invalid-request", message: "Invalid collaboration request" }
    };
  }
  if (!client) {
    return { ok: false, error: { kind: "transport", message: "Service not attached" } };
  }
  try {
    if (request.operation === "targets") {
      const [roles, connections] = await Promise.all([
        client.call("registry.roles", { workspaceId: request.workspaceId }),
        client.call("connection.list", {})
      ]);
      return { ok: true, value: dispatchTargets(roles, connections, request.workspaceId) };
    }
    if (request.operation === "dispatch") {
      const target = request.target.kind === "role" ? { assigneeRoleId: request.target.id } : { connectionId: request.target.id };
      const result = await client.call("task.dispatch", {
        workspaceId: request.workspaceId,
        workNodeIds: request.workNodeIds,
        contextNodeIds: request.contextNodeIds,
        prompt: request.prompt,
        requester: { kind: "user", id: "user" },
        acceptMode: request.acceptMode,
        ...target
      });
      if (!isRecord2(result) || result.workspaceId !== request.workspaceId) {
        throw new InvalidCollaborationResponseError("task.dispatch response is corrupt");
      }
      return { ok: true, value: { workspaceId: request.workspaceId } };
    }
    if (request.operation === "acceptTaskResult") {
      const result = await client.call("task.accept", {
        workspaceId: request.workspaceId,
        resultId: request.resultId,
        actor: "user"
      });
      if (!isRecord2(result) || result.workspaceId !== request.workspaceId) {
        throw new InvalidCollaborationResponseError("task.accept response is corrupt");
      }
      return { ok: true, value: { workspaceId: request.workspaceId } };
    }
    if (request.operation === "rejectTaskResult") {
      const result = await client.call("task.reject", {
        workspaceId: request.workspaceId,
        resultId: request.resultId,
        actor: "user",
        note: request.note,
        resume: request.resume
      });
      if (!isRecord2(result) || result.workspaceId !== request.workspaceId) {
        throw new InvalidCollaborationResponseError("task.reject response is corrupt");
      }
      return { ok: true, value: { workspaceId: request.workspaceId } };
    }
    if (request.operation === "respondDecision") {
      const result = await client.call("decisionRequest.respond", {
        workspaceId: request.workspaceId,
        requestId: request.requestId,
        response: request.response
      });
      if (!isRecord2(result) || result.accepted !== true) {
        throw new InvalidCollaborationResponseError("decisionRequest.respond response is corrupt");
      }
      return { ok: true, value: { workspaceId: request.workspaceId } };
    }
    return {
      ok: false,
      error: { kind: "invalid-request", message: "Unsupported collaboration request" }
    };
  } catch (cause) {
    if (cause instanceof ServiceRpcError) {
      return {
        ok: false,
        error: {
          kind: "rpc",
          code: cause.code,
          message: cause.message,
          data: cause.data
        }
      };
    }
    return {
      ok: false,
      error: {
        kind: cause instanceof InvalidCollaborationResponseError ? "invalid-response" : "transport",
        message: cause instanceof Error ? cause.message : "Collaboration request failed"
      }
    };
  }
}

// src/desktop/projection-ipc.ts
var DESKTOP_PROJECTION_METHODS = [
  "graph.projection",
  "workspace.collaboration",
  "output.provenance"
];
var DESKTOP_PROJECTION_METHOD_SET = new Set(
  DESKTOP_PROJECTION_METHODS
);
function isDesktopProjectionMethod(value) {
  return typeof value === "string" && DESKTOP_PROJECTION_METHOD_SET.has(value);
}
async function invokeDesktopProjectionRpc(getClient, method, params) {
  if (!isDesktopProjectionMethod(method)) {
    throw new Error(`Unsupported desktop projection method: ${String(method)}`);
  }
  const client = getClient();
  if (!client) throw new Error("Service not attached");
  return client.call(method, params);
}

// src/desktop/main/workspace-recovery.ts
var recoveryFlights = /* @__PURE__ */ new WeakMap();
function recoverDesktopState(args) {
  const existing = recoveryFlights.get(args.model);
  if (existing) return existing;
  const flight = recoverDesktopStateOnce(args);
  const tracked = flight.finally(() => {
    if (recoveryFlights.get(args.model) === tracked) {
      recoveryFlights.delete(args.model);
    }
  });
  recoveryFlights.set(args.model, tracked);
  return tracked;
}
async function recoverDesktopStateOnce(args) {
  const attach = await args.host.ensureAttached();
  args.model.setRpc(attach.client);
  await args.model.refreshHealth();
  await args.model.refreshWorkspaces();
  if (!args.model.getSnapshot().foregroundWorkspaceId) {
    const prefs = await (args.loadPrefs ?? loadDesktopPrefs)(args.dataDir);
    if (prefs.lastWorkspaceRoot) {
      await args.model.mountWorkspace(prefs.lastWorkspaceRoot);
    }
  }
  return args.model.getSnapshot();
}

// src/desktop/main/ipc.ts
function registerDesktopIpc(ctx) {
  import_electron2.ipcMain.handle(DESKTOP_IPC.getState, async () => {
    return recoverDesktopState({
      host: ctx.host,
      model: ctx.model,
      dataDir: ctx.dataDir
    });
  });
  import_electron2.ipcMain.handle(DESKTOP_IPC.health, async () => {
    return ctx.model.refreshHealth();
  });
  import_electron2.ipcMain.handle(DESKTOP_IPC.listWorkspaces, async () => {
    return ctx.model.refreshWorkspaces();
  });
  import_electron2.ipcMain.handle(DESKTOP_IPC.mountWorkspace, async (_e, workspaceRoot) => {
    const summary = await ctx.model.mountWorkspace(workspaceRoot);
    let prefs = await loadDesktopPrefs(ctx.dataDir);
    prefs = rememberWorkspace(prefs, workspaceRoot);
    await saveDesktopPrefs(prefs, ctx.dataDir);
    ctx.broadcastState();
    return summary;
  });
  import_electron2.ipcMain.handle(DESKTOP_IPC.setForeground, async (_e, workspaceId) => {
    await ctx.model.setForeground(workspaceId);
    ctx.broadcastState();
    return ctx.model.getSnapshot();
  });
  import_electron2.ipcMain.handle(
    DESKTOP_IPC.rpc,
    async (_e, method, params) => {
      return invokeDesktopProjectionRpc(() => ctx.host.client, method, params);
    }
  );
  import_electron2.ipcMain.handle(
    DESKTOP_IPC.document,
    async (_e, request) => handleDesktopDocumentRequest(ctx.host.client, request)
  );
  import_electron2.ipcMain.handle(
    DESKTOP_IPC.collaboration,
    async (_e, request) => handleDesktopCollaborationRequest(ctx.host.client, request)
  );
  import_electron2.ipcMain.handle(DESKTOP_IPC.pickWorkspaceFolder, async (event) => {
    const win = import_electron2.BrowserWindow.fromWebContents(event.sender);
    const result = await import_electron2.dialog.showOpenDialog(win ?? void 0, {
      properties: ["openDirectory"],
      title: "\u6253\u5F00\u5E26\u6709\u5E10\uFF08.tent\uFF09\u7684\u5DE5\u4F5C\u533A"
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });
  import_electron2.ipcMain.handle(DESKTOP_IPC.getPrefs, async () => {
    return loadDesktopPrefs(ctx.dataDir);
  });
  import_electron2.ipcMain.handle(
    DESKTOP_IPC.setPrefs,
    async (_e, patch) => {
      const prefs = { ...await loadDesktopPrefs(ctx.dataDir), ...patch };
      await saveDesktopPrefs(prefs, ctx.dataDir);
      return prefs;
    }
  );
  import_electron2.ipcMain.handle(DESKTOP_IPC.openMain, async () => {
    await ctx.openMain();
  });
  import_electron2.ipcMain.handle(DESKTOP_IPC.hideMain, async () => {
    ctx.hideMain();
  });
  import_electron2.ipcMain.handle(DESKTOP_IPC.showFloat, async () => {
    ctx.showFloat();
  });
  import_electron2.ipcMain.handle(DESKTOP_IPC.hideFloat, async () => {
    ctx.hideFloat();
  });
  import_electron2.ipcMain.handle(
    DESKTOP_IPC.pushContextCard,
    async (_e, payload) => {
      const entry = ctx.model.cards.pushRef(
        {
          kind: payload.kind,
          id: payload.id,
          path: payload.path
        },
        { label: payload.label }
      );
      ctx.broadcastState();
      return entry;
    }
  );
  import_electron2.ipcMain.handle(DESKTOP_IPC.getFloatingStatus, async () => {
    await ctx.model.refreshHealth();
    await ctx.model.refreshFloatingTasks();
    return ctx.model.floatingStatus();
  });
}

// src/desktop/workbench/context-card-store.ts
var ContextCardStore = class {
  constructor(max = 12) {
    this.cards = [];
    this.listeners = /* @__PURE__ */ new Set();
    this.max = max;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  list() {
    return [...this.cards];
  }
  clear() {
    this.cards = [];
    this.emit();
  }
  pushFromCard(card) {
    const entry = {
      id: `${card.contextRef.kind}:${card.contextRef.id}:${Date.now()}`,
      label: card.label,
      kind: card.contextRef.kind,
      refId: card.contextRef.id,
      path: card.contextRef.path,
      text: contextCardToDragText(card),
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.cards = [entry, ...this.cards.filter((c) => !(c.kind === entry.kind && c.refId === entry.refId))].slice(
      0,
      this.max
    );
    this.emit();
    return entry;
  }
  pushNode(nodeId, path7, label, tentRootHint) {
    return this.pushFromCard(nodeContextCard(nodeId, path7, { label, tentRootHint }));
  }
  pushTask(taskId, path7, label) {
    return this.pushFromCard(taskContextCard(taskId, { path: path7, label }));
  }
  pushRef(ref, opts) {
    return this.pushFromCard(buildContextCard(ref, opts));
  }
  emit() {
    for (const l of this.listeners) l();
  }
};

// src/desktop/workbench/shell-model.ts
var DesktopShellModel = class {
  constructor(rpc = null) {
    this.rpc = rpc;
    this.health = { status: "offline" };
    this.workspaces = [];
    this.foregroundWorkspaceId = null;
    this.floatingTasks = [];
    this.listeners = /* @__PURE__ */ new Set();
    this.cards = new ContextCardStore();
  }
  setRpc(rpc) {
    this.rpc = rpc;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getSnapshot() {
    return {
      health: this.health,
      workspaces: this.workspaces,
      foregroundWorkspaceId: this.foregroundWorkspaceId
    };
  }
  async refreshHealth() {
    if (!this.rpc) {
      this.health = { status: "offline" };
      this.emit();
      return this.health;
    }
    try {
      const h = await this.rpc.health();
      this.health = {
        status: h.status === "ok" ? "ok" : "stopping",
        pid: h.pid,
        version: h.version,
        protocolVersion: h.protocolVersion,
        startedAt: h.startedAt,
        workspaceCount: h.workspaceCount,
        foregroundWorkspaceId: h.foregroundWorkspaceId,
        url: this.rpc.url
      };
    } catch {
      this.health = { status: "offline", url: this.rpc.url };
    }
    this.emit();
    return this.health;
  }
  async refreshWorkspaces() {
    if (!this.rpc) {
      this.workspaces = [];
      this.foregroundWorkspaceId = null;
      this.emit();
      return this.workspaces;
    }
    const result = await this.rpc.call("workspace.list", {});
    this.workspaces = (result.workspaces ?? []).map((workspace) => ({
      workspaceId: workspace.workspaceId,
      workspaceRoot: workspace.workspaceRoot,
      tentName: workspace.tentName,
      foreground: workspace.foreground
    }));
    const foreground = this.workspaces.find((workspace) => workspace.foreground);
    this.foregroundWorkspaceId = foreground?.workspaceId ?? this.health.foregroundWorkspaceId ?? null;
    this.emit();
    return this.workspaces;
  }
  async mountWorkspace(workspaceRoot) {
    if (!this.rpc) throw new Error("Service not attached");
    const info = await this.rpc.call("workspace.mount", { workspaceRoot });
    await this.rpc.call("workspace.setForeground", { workspaceId: info.workspaceId });
    await this.refreshWorkspaces();
    this.bindForeground(info.workspaceId);
    return {
      workspaceId: info.workspaceId,
      workspaceRoot: info.workspaceRoot,
      tentName: info.tentName,
      foreground: true
    };
  }
  async setForeground(workspaceId) {
    if (!this.rpc) throw new Error("Service not attached");
    await this.rpc.call("workspace.setForeground", { workspaceId });
    await this.refreshWorkspaces();
    this.bindForeground(workspaceId);
  }
  /** Bind only bootstrap identity; renderer-next owns graph/document/collaboration. */
  bindForeground(workspaceId) {
    this.foregroundWorkspaceId = workspaceId;
    this.floatingTasks = [];
    this.emit();
  }
  /** Float-only task counts, loaded only when the floating window asks for them. */
  async refreshFloatingTasks() {
    if (!this.rpc || !this.foregroundWorkspaceId) {
      this.floatingTasks = [];
      this.emit();
      return;
    }
    try {
      const result = await this.rpc.call("task.list", {
        workspaceId: this.foregroundWorkspaceId
      });
      this.floatingTasks = (result.tasks ?? []).map((task) => ({ state: task.state }));
    } catch {
      this.floatingTasks = [];
    }
    this.emit();
  }
  floatingStatus() {
    const foreground = this.workspaces.find(
      (workspace) => workspace.workspaceId === this.foregroundWorkspaceId
    );
    return {
      health: this.health,
      pendingTasks: this.floatingTasks.filter((task) => task.state === "queued").length,
      takenTasks: this.floatingTasks.filter(
        (task) => task.state === "running" || task.state === "waiting" || task.state === "submitted"
      ).length,
      recentCards: this.cards.list(),
      foregroundRoot: foreground?.workspaceRoot ?? null
    };
  }
  emit() {
    for (const listener of this.listeners) listener();
  }
};

// src/desktop/main/service-event-refresh.ts
async function refreshDesktopShellForEvent(model2, type) {
  if (type === "workspace.switched" || type === "service.health" || type === "service.disconnected") {
    const health = await model2.refreshHealth();
    if (health.status === "ok") await model2.refreshWorkspaces();
    return true;
  }
  return false;
}

// src/desktop/main/float-window-persistence.ts
var FloatWindowBoundsPersistence = class {
  #delayMs;
  #loadPrefs;
  #savePrefs;
  #onError;
  #timer = null;
  #pendingBounds = null;
  #writeChain = Promise.resolve();
  constructor(options) {
    this.#delayMs = options.delayMs ?? 240;
    this.#loadPrefs = options.loadPrefs;
    this.#savePrefs = options.savePrefs;
    this.#onError = options.onError ?? (() => void 0);
  }
  schedule(bounds) {
    this.#pendingBounds = { ...bounds };
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#enqueuePending().catch(() => void 0);
    }, this.#delayMs);
  }
  async flush() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#enqueuePending();
  }
  #enqueuePending() {
    const bounds = this.#pendingBounds;
    this.#pendingBounds = null;
    if (!bounds) return this.#writeChain;
    const write = this.#writeChain.then(async () => {
      const current = await this.#loadPrefs();
      await this.#savePrefs({ ...current, floatWindowBounds: bounds });
    });
    this.#writeChain = write.catch((error) => {
      this.#onError(error);
    });
    return write;
  }
};

// src/desktop/main/index.ts
var isDev = !import_electron3.app.isPackaged;
var appRoot = isDev ? process.cwd() : import_electron3.app.getAppPath();
var serviceRoot = isDev ? process.cwd() : process.resourcesPath;
var dataDir = process.env.TENT_SERVICE_DATA_DIR || defaultServiceDataDir();
var mainWindow = null;
var floatWindow = null;
var tray = null;
var quitting = false;
var floatBoundsPersistence = null;
var quitAfterFloatBoundsFlush = false;
var readyMainWindows = /* @__PURE__ */ new WeakSet();
var host = new DesktopServiceHost();
var model = new DesktopShellModel();
function captureCurrentFloatBounds() {
  if (!floatWindow || floatWindow.isDestroyed()) return;
  const currentBounds = floatWindow.getBounds();
  const workArea = import_electron3.screen.getDisplayMatching(currentBounds).workArea;
  return normalizeFloatWindowBounds(currentBounds, workArea);
}
async function waitUntilMainWindowReady(win) {
  if (readyMainWindows.has(win)) return;
  if (!win.webContents.isLoadingMainFrame()) {
    throw new Error("Main window finished loading without becoming ready");
  }
  await new Promise((resolve5, reject) => {
    const cleanup = () => {
      win.removeListener("ready-to-show", onReady);
      win.removeListener("closed", onClosed);
      win.webContents.removeListener("did-fail-load", onFailed);
    };
    const onReady = () => {
      readyMainWindows.add(win);
      cleanup();
      resolve5();
    };
    const onClosed = () => {
      cleanup();
      reject(new Error("Main window closed before it was ready"));
    };
    const onFailed = (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      cleanup();
      reject(new Error(`Main window failed to load (${errorCode}): ${errorDescription}`));
    };
    win.once("ready-to-show", onReady);
    win.once("closed", onClosed);
    win.webContents.on("did-fail-load", onFailed);
  });
}
async function bootstrap() {
  const serviceEntry = process.env.TENT_SERVICE_ENTRY || path6.join(serviceRoot, "service.mjs");
  const attach = await host.ensureAttached({
    dataDir,
    serviceEntry,
    cwd: serviceRoot
  });
  model.setRpc(attach.client);
  await model.refreshHealth();
  const prefs = await loadDesktopPrefs(dataDir);
  if (prefs.lastWorkspaceRoot) {
    try {
      await model.mountWorkspace(prefs.lastWorkspaceRoot);
    } catch (err) {
      console.warn("Failed to remount last workspace:", err);
    }
  }
  const paths = resolveDesktopAssetPaths(appRoot);
  const makeMainWindow = () => {
    const win = createMainWindow(paths, prefs, isDev);
    win.once("ready-to-show", () => {
      readyMainWindows.add(win);
    });
    win.webContents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) readyMainWindows.delete(win);
    });
    return win;
  };
  mainWindow = makeMainWindow();
  floatWindow = createFloatWindow(paths, prefs);
  const boundsPersistence = new FloatWindowBoundsPersistence({
    loadPrefs: () => loadDesktopPrefs(dataDir),
    savePrefs: (next) => saveDesktopPrefs(next, dataDir),
    onError: (error) => {
      console.warn("Failed to persist floating control bounds:", error);
    }
  });
  floatBoundsPersistence = boundsPersistence;
  const showMainWindow = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = makeMainWindow();
    }
    await waitUntilMainWindowReady(mainWindow);
    if (mainWindow.isDestroyed()) {
      throw new Error("Main window is unavailable");
    }
    mainWindow.show();
    mainWindow.focus();
    floatWindow?.hide();
  };
  const scheduleFloatBoundsSave = () => {
    const bounds = captureCurrentFloatBounds();
    if (bounds) boundsPersistence.schedule(bounds);
  };
  floatWindow.on("move", scheduleFloatBoundsSave);
  floatWindow.on("resize", scheduleFloatBoundsSave);
  floatWindow.on("closed", () => {
    floatWindow = null;
    void boundsPersistence.flush().catch(() => void 0).finally(() => {
      if (floatBoundsPersistence === boundsPersistence) {
        floatBoundsPersistence = null;
      }
    });
  });
  mainWindow.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow?.hide();
    if (prefs.showFloatOnClose !== false) {
      floatWindow?.show();
    }
  });
  mainWindow.on("minimize", () => {
  });
  registerDesktopIpc({
    host,
    model,
    dataDir,
    getMainWindow: () => mainWindow,
    getFloatWindow: () => floatWindow,
    openMain: showMainWindow,
    showFloat: () => {
      floatWindow?.show();
    },
    hideFloat: () => {
      floatWindow?.hide();
    },
    hideMain: () => {
      mainWindow?.hide();
      if (prefs.showFloatOnClose !== false) floatWindow?.show();
    },
    broadcastState: () => {
      const snap = model.getSnapshot();
      for (const win of import_electron3.BrowserWindow.getAllWindows()) {
        win.webContents.send(DESKTOP_IPC.onStateChanged, snap);
      }
    }
  });
  host.onServiceEvent((ev) => {
    for (const win of import_electron3.BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(DESKTOP_IPC.onServiceEvent, {
        type: ev.type,
        workspaceId: ev.workspaceId
      });
    }
    void refreshDesktopShellForEvent(model, ev.type).then((changed) => {
      const snap = model.getSnapshot();
      const windows = changed ? import_electron3.BrowserWindow.getAllWindows() : floatWindow && !floatWindow.isDestroyed() ? [floatWindow] : [];
      for (const win of windows) {
        if (win.isDestroyed()) continue;
        win.webContents.send(DESKTOP_IPC.onStateChanged, snap);
      }
    }).catch((error) => {
      console.warn("Desktop shell snapshot refresh failed after Service event:", error);
    });
  });
  createTray(paths, () => {
    void showMainWindow().catch((error) => {
      console.warn("Failed to open main window:", error);
    });
  });
  const mountIdx = process.argv.indexOf("--mount");
  if (mountIdx >= 0 && process.argv[mountIdx + 1]) {
    const root = path6.resolve(process.argv[mountIdx + 1]);
    try {
      await model.mountWorkspace(root);
      const next = rememberWorkspace(await loadDesktopPrefs(dataDir), root);
      await saveDesktopPrefs(next, dataDir);
    } catch (err) {
      console.error("Mount failed:", err);
    }
  }
}
function createTray(_paths, showMainWindow) {
  const img = import_electron3.nativeImage.createEmpty();
  tray = new import_electron3.Tray(img.isEmpty() ? import_electron3.nativeImage.createFromDataURL(TINY_PNG) : img);
  tray.setToolTip("\u5E37\u5E44 \xB7 Tent");
  const menu = import_electron3.Menu.buildFromTemplate([
    {
      label: "\u6253\u5F00\u4E3B\u754C\u9762",
      click: showMainWindow
    },
    {
      label: "\u663E\u793A\u6D6E\u52A8\u63A7\u4EF6",
      click: () => floatWindow?.show()
    },
    { type: "separator" },
    {
      label: "\u9000\u51FA\u754C\u9762\uFF08\u670D\u52A1\u7EE7\u7EED\u8FD0\u884C\uFF09",
      click: () => {
        quitting = true;
        void host.disposeShellOnly().then(() => import_electron3.app.quit());
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on("click", showMainWindow);
}
var TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
import_electron3.app.whenReady().then(() => {
  void bootstrap().catch((err) => {
    console.error(err);
    import_electron3.app.quit();
  });
});
import_electron3.app.on("window-all-closed", () => {
});
import_electron3.app.on("before-quit", (event) => {
  quitting = true;
  if (quitAfterFloatBoundsFlush || !floatBoundsPersistence) return;
  event.preventDefault();
  quitAfterFloatBoundsFlush = true;
  void floatBoundsPersistence.flush().catch((error) => {
    console.warn("Failed to flush floating control bounds before quit:", error);
  }).finally(() => import_electron3.app.quit());
});
var gotLock = import_electron3.app.requestSingleInstanceLock();
if (!gotLock) {
  import_electron3.app.quit();
} else {
  import_electron3.app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      floatWindow?.hide();
    }
  });
}
//# sourceMappingURL=index.cjs.map
