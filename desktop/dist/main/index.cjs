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
var path5 = __toESM(require("node:path"), 1);
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
function serviceEndpointPath(dataDir2) {
  return path.join(dataDir2, "service.json");
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
async function readServiceEndpoint(dataDir2) {
  const file = serviceEndpointPath(dataDir2);
  try {
    const raw = await fs.readFile(file, "utf8");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!Number.isInteger(data.pid) || data.pid <= 0 || !Number.isInteger(data.port) || data.port <= 0 || data.port > 65535 || typeof data.host !== "string" || !isLoopbackServiceHost(data.host) || typeof data.startedAt !== "string" || typeof data.version !== "string" || data.token !== void 0 && typeof data.token !== "string" || data.instanceId !== void 0 && (typeof data.instanceId !== "string" || !data.instanceId)) {
      return null;
    }
    return data;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
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
  async call(method, params) {
    const id = `${this.idPrefix}-${++this.seq}`;
    const res = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AUTH_TOKEN_HEADER]: this.token
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
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
          if (done) break;
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
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    const attached = await tryAttach(dataDir2, fetchImpl);
    if (attached) {
      child.stdout?.destroy();
      child.stderr?.destroy();
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
  const endpoint = await readServiceEndpoint(dataDir2);
  if (!endpoint) return null;
  if (!endpoint.token || typeof endpoint.token !== "string" || !endpoint.token.trim()) {
    return null;
  }
  const url = serviceBaseUrl(endpoint.host, endpoint.port);
  const client = new ServiceRpcClient({ baseUrl: url, token: endpoint.token, fetchImpl });
  try {
    const health = await client.health();
    if (health.status !== "ok") return null;
    return { url, endpoint, client };
  } catch {
    return null;
  }
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

// src/desktop/workbench/pending-interactions.ts
var PENDING_INTERACTION_EVENT_TYPES = [
  "a2a.ask",
  "a2a.resolved",
  "toolApproval.pending",
  "toolApproval.resolved",
  "userAsk.pending",
  "userAsk.resolved",
  "taskInput.pending",
  "taskInput.delivered",
  "taskInput.consumed",
  "taskInput.cancelled",
  "delivery.updated",
  "task.state",
  "proposal.updated"
];
function isPendingInteractionEventType(type) {
  return PENDING_INTERACTION_EVENT_TYPES.includes(type);
}
var TASK_PROJECTION_EVENT_TYPES = [
  "task.state",
  "delivery.updated",
  "a2a.ask",
  "a2a.resolved",
  "userAsk.pending",
  "userAsk.resolved",
  "toolApproval.pending",
  "toolApproval.resolved",
  "taskInput.pending",
  "taskInput.delivered",
  "taskInput.consumed",
  "taskInput.cancelled"
];
function isTaskProjectionEventType(type) {
  return TASK_PROJECTION_EVENT_TYPES.includes(type);
}

// src/desktop/main/service-host.ts
var DesktopServiceHost = class {
  constructor() {
    this.attach = null;
    this.child = null;
    this.eventsSub = null;
    this.eventListeners = /* @__PURE__ */ new Set();
    /** Coalesce bursty SSE: type → last workspaceId in window. */
    this.pendingByType = /* @__PURE__ */ new Map();
    this.flushTimer = null;
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
  /** Subscribe to filtered service events (pending / task projection invalidation). */
  onServiceEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  async ensureAttached(options) {
    if (this.attach) {
      try {
        await this.attach.client.health();
        this.ensureEventSubscription();
        return this.attach;
      } catch {
        this.teardownEvents();
        this.attach = null;
      }
    }
    const result = await attachOrStartService({
      dataDir: options?.dataDir,
      serviceEntry: options?.serviceEntry,
      env: process.env
    });
    this.attach = result;
    this.child = result.child;
    this.ensureEventSubscription();
    return result;
  }
  ensureEventSubscription() {
    if (!this.attach?.client || this.eventsSub) return;
    this.eventsSub = this.attach.client.subscribeEvents(
      (ev) => this.handleEnvelope(ev),
      () => {
        this.teardownEvents();
      }
    );
  }
  handleEnvelope(ev) {
    const type = ev?.type;
    if (typeof type !== "string" || !type) return;
    if (!isPendingInteractionEventType(type) && !isTaskProjectionEventType(type)) {
      return;
    }
    const workspaceId = typeof ev.workspaceId === "string" ? ev.workspaceId : "";
    this.pendingByType.set(type, workspaceId);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = [...this.pendingByType.entries()];
      this.pendingByType.clear();
      for (const [t, ws] of batch) {
        for (const listener of this.eventListeners) {
          listener({ type: t, workspaceId: ws });
        }
      }
    }, 50);
  }
  teardownEvents() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingByType.clear();
    this.eventsSub?.close();
    this.eventsSub = null;
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
var path3 = __toESM(require("node:path"), 1);
var import_electron = require("electron");
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
  void win.loadFile(paths.mainHtml);
  if (isDev2) {
    if (process.env.TENT_DESKTOP_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
  }
  win.once("ready-to-show", () => win.show());
  return win;
}
function createFloatWindow(paths, prefs) {
  const display = import_electron.screen.getPrimaryDisplay().workArea;
  const width = prefs.floatWindowBounds?.width ?? 320;
  const height = prefs.floatWindowBounds?.height ?? 280;
  const x = prefs.floatWindowBounds?.x ?? display.x + display.width - width - 24;
  const y = prefs.floatWindowBounds?.y ?? display.y + 24;
  const win = new import_electron.BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: "\u5E37\u5E44 \xB7 \u6D6E\u52A8\u63A7\u4EF6",
    backgroundColor: "#e8e4d7",
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  void win.loadFile(paths.floatHtml);
  return win;
}
function resolveDesktopAssetPaths(appRoot2) {
  return {
    preload: path3.join(appRoot2, "desktop", "dist", "preload", "preload.cjs"),
    mainHtml: path3.join(appRoot2, "desktop", "dist", "renderer", "index.html"),
    floatHtml: path3.join(appRoot2, "desktop", "dist", "renderer", "float.html")
  };
}

// src/desktop/main/ipc.ts
var import_electron2 = require("electron");

// src/desktop/prefs.ts
var fs3 = __toESM(require("node:fs/promises"), 1);
var path4 = __toESM(require("node:path"), 1);

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
  return path4.join(dataDir2 ?? defaultServiceDataDir(), "desktop.json");
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
  await fs3.mkdir(path4.dirname(file), { recursive: true });
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
function boxContextCard(boxId, path6, opts) {
  return buildContextCard({ kind: "box", id: boxId, path: path6 }, opts);
}
function taskContextCard(taskId, opts) {
  return buildContextCard({ kind: "task", id: taskId, path: opts?.path }, opts);
}
function contextCardToDragText(card) {
  return card.prompt;
}

// src/desktop/main/ipc.ts
function registerDesktopIpc(ctx) {
  import_electron2.ipcMain.handle(DESKTOP_IPC.getState, async () => {
    await ctx.model.refreshHealth();
    await ctx.model.refreshWorkspaces();
    if (ctx.model.getSnapshot().foregroundWorkspaceId) {
      await ctx.model.refreshTasks();
    }
    return ctx.model.getSnapshot();
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
      const client = ctx.host.client;
      if (!client) throw new Error("Service not attached");
      return client.call(method, params);
    }
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
    ctx.openMain();
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
    await ctx.model.refreshTasks();
    return ctx.model.floatingStatus();
  });
}

// src/desktop/client/service-docs-client.ts
var ServiceDocsClient = class {
  constructor(options) {
    this.rpc = options.rpc;
    this.workspaceId = options.workspaceId;
  }
  getWorkspaceId() {
    return this.workspaceId;
  }
  setWorkspaceId(workspaceId) {
    this.workspaceId = workspaceId;
  }
  async list(parentPath) {
    const result = await this.rpc.call("docs.list", {
      workspaceId: this.workspaceId,
      parentPath
    });
    const roots = (result.concepts ?? []).map(normalizeProjection);
    if (!parentPath) return roots;
    const parent = findByPath(roots, parentPath.replace(/\\/g, "/"));
    return parent?.children ?? [];
  }
  async get(cxOrPath) {
    try {
      const result = await this.rpc.call("docs.get", {
        workspaceId: this.workspaceId,
        ...idOrPathParams(cxOrPath)
      });
      return result.concept ? normalizeProjection(result.concept) : null;
    } catch (err) {
      if (err instanceof ServiceRpcError && err.code === -32004) return null;
      throw err;
    }
  }
  async readForEdit(cxOrPath) {
    const result = await this.rpc.call("docs.readForEdit", {
      workspaceId: this.workspaceId,
      ...idOrPathParams(cxOrPath)
    });
    const cx = result.cx ?? result.id;
    const raw = result.raw ?? reconstructRaw(result.frontmatter ?? {}, result.body ?? "");
    const name = result.name ?? (typeof result.frontmatter?.name === "string" ? result.frontmatter.name : result.path.split("/").pop() || result.path);
    const type = result.type ?? (typeof result.frontmatter?.type === "string" ? result.frontmatter.type : "note");
    const coordination = result.coordination ?? (type === "goal" || type.startsWith("goal-") || type === "prompt" || type.startsWith("prompt-") || type === "output" || type.startsWith("output-"));
    return {
      cx,
      path: result.path,
      name,
      type,
      coordination,
      body: result.body,
      frontmatter: result.frontmatter ?? {},
      raw,
      etag: result.etag,
      artifactRefs: result.artifactRefs ?? parseArtifactRefs(result.frontmatter ?? {})
    };
  }
  async write(input) {
    try {
      const params = {
        workspaceId: this.workspaceId,
        id: input.cx,
        baseEtag: input.baseEtag
      };
      if (input.raw !== void 0) params.raw = input.raw;
      if (input.body !== void 0) params.body = input.body;
      if (input.frontmatter !== void 0) params.frontmatter = input.frontmatter;
      const result = await this.rpc.call("docs.write", params);
      return {
        ok: true,
        etag: result.etag,
        cx: result.cx ?? result.id,
        path: result.path
      };
    } catch (err) {
      if (err instanceof ServiceRpcError) {
        if (err.code === -32009) {
          let disk;
          try {
            disk = await this.readForEdit(input.cx);
          } catch {
          }
          return {
            ok: false,
            code: "etag_conflict",
            message: err.message || "etag conflict",
            disk
          };
        }
        if (err.code === -32010) {
          return {
            ok: false,
            code: "collab_field_protected",
            message: err.message
          };
        }
        if (err.code === -32004) {
          return { ok: false, code: "not_found", message: err.message };
        }
        return { ok: false, code: "invalid", message: err.message };
      }
      throw err;
    }
  }
  async createNote(input) {
    const result = await this.rpc.call("docs.createNote", {
      workspaceId: this.workspaceId,
      name: input.name,
      type: input.type ?? "note",
      parentPath: input.parentPath ?? "",
      body: input.body
    });
    return { cx: result.id, path: result.path };
  }
  async promote(cxOrPath, toType) {
    const result = await this.rpc.call("docs.promote", {
      workspaceId: this.workspaceId,
      ...idOrPathParams(cxOrPath),
      toType
    });
    return {
      cx: result.id,
      path: result.path,
      fromType: result.fromType,
      toType: result.toType
    };
  }
  async fork(cxOrPath) {
    const result = await this.rpc.call("docs.fork", {
      workspaceId: this.workspaceId,
      ...idOrPathParams(cxOrPath)
    });
    return { cx: result.id };
  }
  async search(query) {
    const result = await this.rpc.call("docs.search", {
      workspaceId: this.workspaceId,
      query
    });
    return result.hits ?? [];
  }
  async backlinks(cxOrPath) {
    const result = await this.rpc.call("docs.backlinks", {
      workspaceId: this.workspaceId,
      ...idOrPathParams(cxOrPath)
    });
    return result.backlinks ?? [];
  }
  async resolveLink(_fromCxOrPath, raw) {
    const hits = await this.search(raw);
    const exact = hits.find((h) => h.name === raw || h.path.endsWith(raw));
    if (exact) {
      return { raw, kind: "wiki", targetCx: exact.cx, targetPath: exact.path, label: exact.name };
    }
    return { raw, kind: "unresolved" };
  }
  async importAttachment(cx, fileName, bytes) {
    const payload = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const bytesBase64 = typeof Buffer !== "undefined" ? Buffer.from(payload).toString("base64") : uint8ToBase64(payload);
    const result = await this.rpc.call("docs.importAttachment", {
      workspaceId: this.workspaceId,
      ...idOrPathParams(cx),
      fileName,
      bytesBase64
    });
    return {
      relativePath: result.relativePath,
      markdown: result.markdown,
      artifactRef: result.artifactRef
    };
  }
};
function uint8ToBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function idOrPathParams(cxOrPath) {
  const key = cxOrPath.trim().replace(/\\/g, "/");
  if (key.startsWith("cx-") || key.startsWith("bx-")) return { id: key };
  return { path: key };
}
function normalizeProjection(c) {
  const mode = c.mode === "read-only" || c.mode === "archived" || c.mode === "editable" ? c.mode : c.archived ? "archived" : "editable";
  return {
    ...c,
    children: (c.children ?? []).map(normalizeProjection),
    tags: c.tags ?? [],
    mode,
    archived: mode === "archived" || !!c.archived,
    invalid: !!c.invalid
  };
}
function findByPath(nodes, path6) {
  for (const n of nodes) {
    if (n.path === path6) return n;
    const child = findByPath(n.children ?? [], path6);
    if (child) return child;
  }
  return null;
}
function reconstructRaw(frontmatter, body) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v === void 0) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---");
  lines.push(body.endsWith("\n") || body === "" ? body : body + "\n");
  return lines.join("\n");
}
function parseArtifactRefs(data) {
  const raw = data.artifactRefs;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item;
    const kind = rec.kind;
    const target = rec.target;
    if ((kind === "path" || kind === "dir" || kind === "commit" || kind === "url" || kind === "other") && typeof target === "string") {
      out.push({
        kind,
        target,
        label: typeof rec.label === "string" ? rec.label : void 0
      });
    }
  }
  return out;
}

// src/markdown/render.ts
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderMarkdownToHtml(body, options) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listType = null;
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (!inCode) {
        closeList();
        inCode = true;
        codeLang = line.slice(3).trim();
        codeBuf = [];
      } else {
        html.push(
          `<pre class="md-code"${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ""}><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`
        );
        inCode = false;
        codeLang = "";
        codeBuf = [];
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }
    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2], options)}</h${level}>`);
      i++;
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${inline(ul[1], options)}</li>`);
      i++;
      continue;
    }
    const ol = /^(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${inline(ol[2], options)}</li>`);
      i++;
      continue;
    }
    closeList();
    html.push(`<p>${inline(line, options)}</p>`);
    i++;
  }
  closeList();
  if (inCode) {
    html.push(`<pre class="md-code"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  if (options?.artifactRefs?.length) {
    html.push(`<aside class="artifact-chips" aria-label="Artifact references">`);
    for (const ref of options.artifactRefs) {
      const label = escapeHtml(ref.label || ref.target);
      html.push(
        `<span class="artifact-chip" data-kind="${escapeHtml(ref.kind)}" data-target="${escapeHtml(ref.target)}" title="Open externally">${label}</span>`
      );
    }
    html.push(`</aside>`);
  }
  return html.join("\n");
}
function inline(text, options) {
  let s = escapeHtml(text);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
  });
  s = applyLinksFromOriginal(text, options);
  return s;
}
function applyLinksFromOriginal(text, options) {
  const parts = [];
  let cursor = 0;
  const re = /(!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\])|(!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))/g;
  let m;
  while (m = re.exec(text)) {
    if (m.index > cursor) {
      parts.push({ kind: "text", value: text.slice(cursor, m.index) });
    }
    const full = m[0];
    if (full.startsWith("![[") || full.startsWith("![") && !full.startsWith("![[")) {
      if (full.startsWith("![")) {
        const alt = m[5] ?? "";
        const src = m[6] ?? "";
        parts.push({
          kind: "html",
          value: `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`
        });
      } else {
        parts.push({ kind: "text", value: full });
      }
    } else if (full.startsWith("[[")) {
      const raw = (m[2] ?? "").trim();
      const label = (m[3] ?? raw).trim();
      const href = options?.resolveWikiHref?.(raw) ?? `#cx:${encodeURIComponent(raw)}`;
      parts.push({
        kind: "html",
        value: `<a class="wiki-link" href="${escapeHtml(href)}" data-wiki="${escapeHtml(raw)}">${escapeHtml(label)}</a>`
      });
    } else {
      const label = m[5] ?? "";
      const href = m[6] ?? "";
      parts.push({
        kind: "html",
        value: `<a href="${escapeHtml(href)}">${escapeHtml(label || href)}</a>`
      });
    }
    cursor = m.index + full.length;
  }
  if (cursor < text.length) parts.push({ kind: "text", value: text.slice(cursor) });
  return parts.map((p) => {
    if (p.kind === "html") return p.value;
    let t = escapeHtml(p.value);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    return t;
  }).join("");
}

// src/markdown/workspace-controller.ts
var WorkspaceController = class {
  constructor(docs) {
    this.docs = docs;
    this.tree = [];
    this.tabs = /* @__PURE__ */ new Map();
    this.tabOrder = [];
    this.activeCx = null;
    this.searchQuery = "";
    this.searchHits = [];
    this.backlinks = [];
    this.statusMessage = null;
    this.listeners = /* @__PURE__ */ new Set();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getSnapshot() {
    return {
      tree: this.tree,
      tabs: this.tabOrder.map((cx) => this.tabs.get(cx)).filter(Boolean),
      activeCx: this.activeCx,
      searchQuery: this.searchQuery,
      searchHits: this.searchHits,
      backlinks: this.backlinks,
      statusMessage: this.statusMessage
    };
  }
  getActiveTab() {
    return this.activeCx ? this.tabs.get(this.activeCx) ?? null : null;
  }
  async refreshTree() {
    this.tree = await this.docs.list();
    this.emit();
  }
  async openConcept(cxOrPath) {
    const snap = await this.docs.readForEdit(cxOrPath);
    const existing = this.tabs.get(snap.cx);
    if (existing && existing.dirty) {
      this.activeCx = snap.cx;
      this.statusMessage = "Tab already open with unsaved changes.";
      this.emit();
      return existing;
    }
    const tab = {
      cx: snap.cx,
      path: snap.path,
      name: snap.name,
      type: snap.type,
      coordination: snap.coordination,
      etag: snap.etag,
      buffer: snap.raw,
      savedRaw: snap.raw,
      dirty: false,
      mode: existing?.mode ?? "source",
      conflict: null,
      artifactRefs: snap.artifactRefs,
      frontmatter: snap.frontmatter
    };
    if (!this.tabs.has(snap.cx)) this.tabOrder.push(snap.cx);
    this.tabs.set(snap.cx, tab);
    this.activeCx = snap.cx;
    this.backlinks = await this.docs.backlinks(snap.cx);
    this.statusMessage = null;
    this.emit();
    return tab;
  }
  setActive(cx) {
    if (!this.tabs.has(cx)) return;
    this.activeCx = cx;
    void this.docs.backlinks(cx).then((hits) => {
      this.backlinks = hits;
      this.emit();
    });
    this.emit();
  }
  closeTab(cx) {
    const tab = this.tabs.get(cx);
    if (!tab) return;
    if (tab.dirty) {
      this.statusMessage = "Cannot close dirty tab; save or discard first.";
      this.emit();
      return;
    }
    this.tabs.delete(cx);
    this.tabOrder = this.tabOrder.filter((id) => id !== cx);
    if (this.activeCx === cx) {
      this.activeCx = this.tabOrder[this.tabOrder.length - 1] ?? null;
    }
    this.emit();
  }
  updateBuffer(cx, raw) {
    const tab = this.tabs.get(cx);
    if (!tab) return;
    tab.buffer = raw;
    tab.dirty = raw !== tab.savedRaw;
    if (tab.dirty && tab.conflict) {
    }
    this.emit();
  }
  setMode(cx, mode) {
    const tab = this.tabs.get(cx);
    if (!tab) return;
    tab.mode = mode;
    this.emit();
  }
  previewHtml(cx) {
    const tab = this.tabs.get(cx);
    if (!tab) return "";
    const body = splitBody(tab.buffer);
    return renderMarkdownToHtml(body, {
      resolveWikiHref: (raw) => `#open=${encodeURIComponent(raw)}`,
      artifactRefs: tab.artifactRefs
    });
  }
  async save(cx) {
    const tab = this.tabs.get(cx);
    if (!tab) return false;
    const result = await this.docs.write({
      cx: tab.cx,
      baseEtag: tab.etag,
      raw: tab.buffer
    });
    if (!result.ok) {
      if (result.code === "etag_conflict" && result.disk) {
        tab.conflict = {
          message: result.message,
          disk: result.disk
        };
        this.statusMessage = result.message;
        this.emit();
        return false;
      }
      this.statusMessage = result.message;
      this.emit();
      return false;
    }
    tab.etag = result.etag;
    tab.savedRaw = tab.buffer;
    tab.dirty = false;
    tab.conflict = null;
    this.statusMessage = "Saved.";
    await this.refreshTree();
    this.emit();
    return true;
  }
  /** Conflict UI: load disk version into buffer. */
  loadDiskVersion(cx) {
    const tab = this.tabs.get(cx);
    if (!tab?.conflict) return;
    const disk = tab.conflict.disk;
    tab.buffer = disk.raw;
    tab.etag = disk.etag;
    tab.savedRaw = disk.raw;
    tab.dirty = false;
    tab.artifactRefs = disk.artifactRefs;
    tab.frontmatter = disk.frontmatter;
    tab.conflict = null;
    this.statusMessage = "Loaded disk version.";
    this.emit();
  }
  /** Conflict UI: keep mine and overwrite disk (re-base etag then write). */
  async overwriteWithMine(cx) {
    const tab = this.tabs.get(cx);
    if (!tab?.conflict) return false;
    tab.etag = tab.conflict.disk.etag;
    tab.conflict = null;
    return this.save(cx);
  }
  discard(cx) {
    const tab = this.tabs.get(cx);
    if (!tab) return;
    tab.buffer = tab.savedRaw;
    tab.dirty = false;
    tab.conflict = null;
    this.statusMessage = "Discarded local edits.";
    this.emit();
  }
  async search(query) {
    this.searchQuery = query;
    this.searchHits = query.trim() ? await this.docs.search(query) : [];
    this.emit();
  }
  async createNote(name, parentPath) {
    const created = await this.docs.createNote({ name, parentPath, type: "note" });
    await this.refreshTree();
    await this.openConcept(created.cx);
    this.statusMessage = `Created note ${created.path}`;
    this.emit();
    return created.cx;
  }
  async promoteActive(toType = "goal") {
    const tab = this.getActiveTab();
    if (!tab) return;
    if (tab.dirty) {
      const ok = await this.save(tab.cx);
      if (!ok) return;
    }
    const result = await this.docs.promote(tab.cx, toType);
    await this.refreshTree();
    await this.openConcept(result.cx);
    this.statusMessage = `Promoted to ${result.toType}`;
    this.emit();
  }
  /** Apply external concept.changed: reload clean tabs only. */
  async onConceptChanged(cx) {
    const tab = this.tabs.get(cx);
    if (!tab) {
      await this.refreshTree();
      return;
    }
    if (tab.dirty) {
      try {
        const disk = await this.docs.readForEdit(cx);
        if (disk.etag !== tab.etag) {
          tab.conflict = {
            message: "Disk content changed externally while tab is dirty.",
            disk
          };
          this.statusMessage = tab.conflict.message;
          this.emit();
        }
      } catch {
      }
      return;
    }
    await this.openConcept(cx);
  }
  emit() {
    for (const listener of this.listeners) listener();
  }
};
function splitBody(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return raw;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return raw;
  const after = text.indexOf("\n", end + 1);
  return after === -1 ? "" : text.slice(after + 1);
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
  pushBox(boxId, path6, label, tentRootHint) {
    return this.pushFromCard(boxContextCard(boxId, path6, { label, tentRootHint }));
  }
  pushTask(taskId, path6, label) {
    return this.pushFromCard(taskContextCard(taskId, { path: path6, label }));
  }
  pushRef(ref, opts) {
    return this.pushFromCard(buildContextCard(ref, opts));
  }
  emit() {
    for (const l of this.listeners) l();
  }
};

// src/desktop/workbench/collaboration-ui.ts
function listCoordinationTypeNames(types) {
  return types.filter((t) => {
    const tier = "tier" in t ? t.tier : "base";
    return (tier === void 0 || tier === "base") && t.coordination === true;
  }).map((t) => t.name).sort((a, b) => a.localeCompare(b));
}
function listCoordinationTypeOptions(types) {
  return listCoordinationTypeNames(types).map((name) => {
    const row = types.find((t) => t.name === name);
    return {
      name,
      description: row?.description,
      color: row?.color
    };
  });
}
function listRoleOptions(roles) {
  return roles.map((r) => ({ name: r.name, description: r.description })).sort((a, b) => a.name.localeCompare(b.name));
}
function listProfileOptions(profiles, opts) {
  const includeTest = opts?.includeTest === true;
  return profiles.filter((p) => includeTest || !p.testOnly).map((p) => {
    const parts = [p.displayName || p.id, p.adapterId, p.model].filter(Boolean);
    return {
      id: p.id,
      adapterId: p.adapterId,
      displayName: p.displayName || p.id,
      model: p.model,
      testOnly: p.testOnly,
      label: parts.join(" \xB7 ")
    };
  }).sort((a, b) => {
    if (a.testOnly !== b.testOnly) return a.testOnly ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}
function pickDefaultProfileId(profiles) {
  const product = profiles.filter((p) => !p.testOnly);
  if (product.length === 1) return product[0].id;
  const grok = product.find((p) => p.id === "grok-acp-default");
  if (grok) return grok.id;
  if (product.length > 0) return product[0].id;
  return profiles[0]?.id ?? null;
}
function buildStartSessionPayload(taskPath, profileId) {
  const path6 = taskPath.trim();
  if (!path6) {
    return { ok: false, reason: "\u7F3A\u5C11\u4EFB\u52A1\u8DEF\u5F84\u3002" };
  }
  const profile = profileId.trim();
  if (!profile) {
    return { ok: false, reason: "\u8BF7\u9009\u62E9 machine-local agent profile\u3002" };
  }
  return {
    ok: true,
    payload: {
      taskPath: path6,
      profileId: profile,
      callerKind: "user"
    }
  };
}
function taskStateLabel(state, legacyStatus) {
  const s = state || legacyStatus || "";
  switch (s) {
    case "queued":
    case "pending":
      return "\u6392\u961F\u4E2D";
    case "running":
    case "taken":
      return "\u6267\u884C\u4E2D";
    case "waiting":
      return "\u7B49\u5F85\u4E2D";
    case "delivered":
      return "\u5F85\u786E\u8BA4\u4EA4\u4ED8";
    case "accepted":
      return "\u5DF2\u63A5\u53D7";
    case "rejected":
      return "\u5DF2\u9A73\u56DE";
    case "interrupted":
      return "\u5DF2\u4E2D\u65AD";
    case "failed":
      return "\u5931\u8D25";
    default:
      return s || "\u672A\u77E5";
  }
}
function sessionStateLabel(state) {
  if (!state) return "";
  switch (state) {
    case "starting":
      return "\u542F\u52A8\u4E2D";
    case "live":
    case "running":
      return "\u8FD0\u884C\u4E2D";
    case "waiting-user":
    case "waiting_user":
      return "\u7B49\u5F85\u7528\u6237";
    case "stopped":
      return "\u5DF2\u505C\u6B62";
    case "failed":
      return "\u4F1A\u8BDD\u5931\u8D25";
    case "external":
      return "\u5916\u90E8\u4F1A\u8BDD";
    default:
      return state;
  }
}
function canStartAgentOnTask(taskState, session) {
  const s = taskState || "";
  if (s === "delivered" || s === "accepted" || s === "rejected" || s === "interrupted") {
    return false;
  }
  if (session && session.alive && (session.state === "live" || session.state === "starting" || session.state === "waiting-user")) {
    return false;
  }
  return s === "queued" || s === "pending" || s === "running" || s === "taken" || s === "waiting" || s === "failed";
}
function canInterruptTask(taskState, session, opts) {
  if (session) {
    return !!session.alive && (session.state === "live" || session.state === "starting" || session.state === "waiting-user");
  }
  if (!opts?.hasSessionId) return false;
  const s = taskState || "";
  return s === "running" || s === "waiting" || s === "taken";
}
function canCancelTask(taskState, session) {
  const s = taskState || "";
  if (s === "delivered" || s === "accepted" || s === "rejected" || s === "interrupted" || s === "cancelled" || s === "canceled") {
    return false;
  }
  if (session && session.alive) return false;
  return s === "queued" || s === "pending" || s === "running" || s === "taken" || s === "waiting" || s === "failed";
}
function buildTaskReviewItems(tasks, deliveries = [], sessions = []) {
  const byId = /* @__PURE__ */ new Map();
  const byTaskId = /* @__PURE__ */ new Map();
  for (const d of deliveries) {
    byId.set(d.id, d);
    const list = byTaskId.get(d.taskId) ?? [];
    list.push(d);
    byTaskId.set(d.taskId, list);
  }
  const sessionById = /* @__PURE__ */ new Map();
  const sessionByTaskId = /* @__PURE__ */ new Map();
  for (const s of sessions) {
    sessionById.set(s.sessionId, s);
    if (s.lastTaskId) sessionByTaskId.set(s.lastTaskId, s);
  }
  return tasks.map((task) => {
    const state = task.state || task.status;
    let delivery;
    if (task.activeDeliveryId) {
      delivery = byId.get(task.activeDeliveryId);
    }
    if (!delivery && task.id) {
      const list = byTaskId.get(task.id) ?? [];
      delivery = list.slice().sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""))[0];
    }
    let session;
    if (task.sessionId) {
      session = sessionById.get(task.sessionId);
    }
    if (!session && task.id) {
      session = sessionByTaskId.get(task.id);
    }
    const commits = delivery?.commits ?? [];
    const deliverySummary = delivery?.summary;
    const label = taskStateLabel(state, task.status);
    const sessLabel = sessionStateLabel(session?.state);
    const promptBit = task.prompt ? truncate(task.prompt, 48) : "";
    const summaryLine = [
      label,
      sessLabel ? `\u4F1A\u8BDD${sessLabel}` : null,
      task.role,
      deliverySummary ? truncate(deliverySummary, 64) : promptBit || null
    ].filter(Boolean).join(" \xB7 ");
    return {
      path: task.path,
      id: task.id,
      role: task.role,
      status: task.status,
      state,
      claims: task.claims ?? [],
      prompt: task.prompt,
      activeDeliveryId: task.activeDeliveryId,
      sessionId: task.sessionId ?? session?.sessionId,
      sessionState: session?.state,
      sessionAlive: session?.alive,
      sessionProfileId: session?.profileId,
      deliverySummary,
      commits,
      canAcceptOrReject: state === "delivered",
      canStartAgent: canStartAgentOnTask(state, session),
      canInterrupt: canInterruptTask(state, session, {
        hasSessionId: !!(task.sessionId || session?.sessionId)
      }),
      canCancel: canCancelTask(state, session),
      summaryLine
    };
  });
}
function truncate(text, max) {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "\u2026";
}

// src/desktop/workbench/shell-model.ts
var DesktopShellModel = class {
  constructor(rpc = null) {
    this.rpc = rpc;
    this.health = { status: "offline" };
    this.workspaces = [];
    this.foregroundWorkspaceId = null;
    this.docs = null;
    this.controller = null;
    this.tasks = [];
    this.deliveries = [];
    this.sessions = [];
    this.roles = [];
    this.coordinationTypes = [];
    this.profiles = [];
    this.selectedProfileId = null;
    this.statusMessage = null;
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
      foregroundWorkspaceId: this.foregroundWorkspaceId,
      workspace: this.controller?.getSnapshot() ?? null,
      tasks: this.tasks,
      taskReview: buildTaskReviewItems(
        this.tasks.map((t) => ({
          path: t.path,
          id: t.id,
          role: t.role,
          claims: t.claims,
          status: t.status === "taken" ? "taken" : "pending",
          state: t.state || t.status,
          prompt: t.prompt,
          activeDeliveryId: t.activeDeliveryId,
          sessionId: t.sessionId,
          manifest: ""
        })),
        this.deliveries,
        this.sessions
      ),
      roles: this.roles,
      coordinationTypes: this.coordinationTypes,
      profiles: this.profiles,
      selectedProfileId: this.selectedProfileId,
      statusMessage: this.statusMessage
    };
  }
  getController() {
    return this.controller;
  }
  setSelectedProfileId(profileId) {
    this.selectedProfileId = profileId;
    this.emit();
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
      this.emit();
      return this.workspaces;
    }
    const result = await this.rpc.call("workspace.list", {});
    this.workspaces = (result.workspaces ?? []).map((w) => ({
      workspaceId: w.workspaceId,
      workspaceRoot: w.workspaceRoot,
      tentName: w.tentName,
      foreground: w.foreground
    }));
    const fg = this.workspaces.find((w) => w.foreground);
    this.foregroundWorkspaceId = fg?.workspaceId ?? this.health.foregroundWorkspaceId ?? null;
    this.emit();
    return this.workspaces;
  }
  async mountWorkspace(workspaceRoot) {
    if (!this.rpc) throw new Error("Service not attached");
    const info = await this.rpc.call("workspace.mount", { workspaceRoot });
    await this.refreshWorkspaces();
    await this.bindForeground(info.workspaceId);
    this.statusMessage = `Mounted ${info.workspaceRoot}`;
    this.emit();
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
    await this.bindForeground(workspaceId);
  }
  async bindForeground(workspaceId) {
    if (!this.rpc) return;
    this.foregroundWorkspaceId = workspaceId;
    this.docs = new ServiceDocsClient({ rpc: this.rpc, workspaceId });
    this.controller = new WorkspaceController(this.docs);
    this.controller.subscribe(() => this.emit());
    await this.controller.refreshTree();
    await Promise.all([this.refreshTasks(), this.refreshRegistry(), this.refreshProfiles()]);
    this.emit();
  }
  async refreshTasks() {
    if (!this.rpc || !this.foregroundWorkspaceId) {
      this.tasks = [];
      this.deliveries = [];
      this.sessions = [];
      this.emit();
      return;
    }
    try {
      const [taskResult, deliveryResult, sessionResult] = await Promise.all([
        this.rpc.call("task.list", {
          workspaceId: this.foregroundWorkspaceId
        }),
        this.rpc.call("delivery.list", {
          workspaceId: this.foregroundWorkspaceId
        }),
        this.rpc.call("session.list", {
          workspaceId: this.foregroundWorkspaceId
        })
      ]);
      this.tasks = (taskResult.tasks ?? []).map((t) => ({
        path: t.path,
        role: t.role,
        status: t.status,
        claims: t.claims ?? [],
        state: t.state,
        id: t.id,
        prompt: t.prompt,
        activeDeliveryId: t.activeDeliveryId,
        sessionId: t.sessionId
      }));
      this.deliveries = deliveryResult.deliveries ?? [];
      this.sessions = sessionResult.sessions ?? [];
    } catch {
      this.tasks = [];
      this.deliveries = [];
      this.sessions = [];
    }
    this.emit();
  }
  async refreshRegistry() {
    if (!this.rpc || !this.foregroundWorkspaceId) {
      this.roles = [];
      this.coordinationTypes = [];
      this.emit();
      return;
    }
    try {
      const [typesResult, rolesResult] = await Promise.all([
        this.rpc.call("registry.types", {
          workspaceId: this.foregroundWorkspaceId
        }),
        this.rpc.call("registry.roles", {
          workspaceId: this.foregroundWorkspaceId
        })
      ]);
      this.coordinationTypes = listCoordinationTypeOptions(typesResult.types ?? []);
      this.roles = listRoleOptions(rolesResult.roles ?? []);
    } catch {
      this.roles = [];
      this.coordinationTypes = [];
    }
    this.emit();
  }
  /**
   * Load machine-local profiles (product list: testOnly hidden).
   * Does not start sessions; selection only.
   */
  async refreshProfiles() {
    if (!this.rpc) {
      this.profiles = [];
      this.selectedProfileId = null;
      this.emit();
      return this.profiles;
    }
    try {
      const result = await this.rpc.call("profile.list", {});
      this.profiles = listProfileOptions(result.profiles ?? []);
      if (!this.selectedProfileId || !this.profiles.some((p) => p.id === this.selectedProfileId)) {
        this.selectedProfileId = pickDefaultProfileId(this.profiles);
      }
    } catch {
      this.profiles = [];
      if (!this.profiles.length) this.selectedProfileId = null;
    }
    this.emit();
    return this.profiles;
  }
  /**
   * User-clicked start agent. Builds task.startSession with callerKind=user.
   * Does not auto-run; service may claim queued tasks for user callers.
   */
  async startAgentSession(taskPath, profileId) {
    if (!this.rpc || !this.foregroundWorkspaceId) {
      throw new Error("\u670D\u52A1\u672A\u8FDE\u63A5\u6216\u672A\u9009\u62E9\u5DE5\u4F5C\u533A\u3002");
    }
    const pid = (profileId ?? this.selectedProfileId ?? "").trim();
    const built = buildStartSessionPayload(taskPath, pid);
    if (!built.ok) {
      throw new Error(built.reason);
    }
    const result = await this.rpc.call("task.startSession", {
      workspaceId: this.foregroundWorkspaceId,
      taskPath: built.payload.taskPath,
      profileId: built.payload.profileId,
      callerKind: built.payload.callerKind
    });
    await this.refreshTasks();
    return result;
  }
  async interruptTask(taskPath) {
    if (!this.rpc || !this.foregroundWorkspaceId) {
      throw new Error("\u670D\u52A1\u672A\u8FDE\u63A5\u6216\u672A\u9009\u62E9\u5DE5\u4F5C\u533A\u3002");
    }
    const result = await this.rpc.call("task.interrupt", {
      workspaceId: this.foregroundWorkspaceId,
      taskPath
    });
    await this.refreshTasks();
    return result;
  }
  emitContextCardForActive() {
    const tab = this.controller?.getActiveTab();
    if (!tab) return;
    const fg = this.workspaces.find((w) => w.workspaceId === this.foregroundWorkspaceId);
    this.cards.pushBox(tab.cx, tab.path, tab.name, fg?.workspaceRoot);
  }
  floatingStatus() {
    const fg = this.workspaces.find((w) => w.workspaceId === this.foregroundWorkspaceId);
    return {
      health: this.health,
      pendingTasks: this.tasks.filter(
        (t) => t.status === "pending" || t.state === "queued" || t.state === "pending"
      ).length,
      takenTasks: this.tasks.filter(
        (t) => t.status === "taken" || t.state === "running" || t.state === "taken" || t.state === "waiting" || t.state === "delivered"
      ).length,
      recentCards: this.cards.list(),
      foregroundRoot: fg?.workspaceRoot ?? null
    };
  }
  emit() {
    for (const l of this.listeners) l();
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
var host = new DesktopServiceHost();
var model = new DesktopShellModel();
async function bootstrap() {
  const serviceEntry = process.env.TENT_SERVICE_ENTRY || path5.join(serviceRoot, "service.mjs");
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
  mainWindow = createMainWindow(paths, prefs, isDev);
  floatWindow = createFloatWindow(paths, prefs);
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
    openMain: () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createMainWindow(paths, prefs, isDev);
      }
      mainWindow.show();
      mainWindow.focus();
    },
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
    void model.refreshTasks().then(() => {
      const snap = model.getSnapshot();
      for (const win of import_electron3.BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send(DESKTOP_IPC.onStateChanged, snap);
        win.webContents.send(DESKTOP_IPC.onServiceEvent, {
          type: ev.type,
          workspaceId: ev.workspaceId
        });
      }
    });
  });
  createTray(paths);
  const mountIdx = process.argv.indexOf("--mount");
  if (mountIdx >= 0 && process.argv[mountIdx + 1]) {
    const root = path5.resolve(process.argv[mountIdx + 1]);
    try {
      await model.mountWorkspace(root);
      const next = rememberWorkspace(await loadDesktopPrefs(dataDir), root);
      await saveDesktopPrefs(next, dataDir);
    } catch (err) {
      console.error("Mount failed:", err);
    }
  }
}
function createTray(_paths) {
  const img = import_electron3.nativeImage.createEmpty();
  tray = new import_electron3.Tray(img.isEmpty() ? import_electron3.nativeImage.createFromDataURL(TINY_PNG) : img);
  tray.setToolTip("\u5E37\u5E44 \xB7 Tent");
  const menu = import_electron3.Menu.buildFromTemplate([
    {
      label: "\u6253\u5F00\u4E3B\u754C\u9762",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
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
  tray.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
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
import_electron3.app.on("before-quit", () => {
  quitting = true;
});
var gotLock = import_electron3.app.requestSingleInstanceLock();
if (!gotLock) {
  import_electron3.app.quit();
} else {
  import_electron3.app.on("second-instance", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}
//# sourceMappingURL=index.cjs.map
