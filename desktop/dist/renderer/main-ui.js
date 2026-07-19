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

// src/desktop/workbench/collaboration-ui.ts
function pickDefaultCoordinationType(types) {
  const names = listCoordinationTypeNames(types);
  if (names.includes("goal")) return "goal";
  return names[0] ?? null;
}
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
function listRoleOptions(roles2) {
  return roles2.map((r) => ({ name: r.name, description: r.description })).sort((a, b) => a.name.localeCompare(b.name));
}
function listProfileOptions(profiles2, opts) {
  const includeTest = opts?.includeTest === true;
  return profiles2.filter((p) => includeTest || !p.testOnly).map((p) => {
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
function pickDefaultProfileId(profiles2) {
  const product = profiles2.filter((p) => !p.testOnly);
  if (product.length === 1) return product[0].id;
  const grok = product.find((p) => p.id === "grok-acp-default");
  if (grok) return grok.id;
  if (product.length > 0) return product[0].id;
  return profiles2[0]?.id ?? null;
}
function buildStartSessionPayload(taskPath, profileId) {
  const path = taskPath.trim();
  if (!path) {
    return { ok: false, reason: "\u7F3A\u5C11\u4EFB\u52A1\u8DEF\u5F84\u3002" };
  }
  const profile = profileId.trim();
  if (!profile) {
    return { ok: false, reason: "\u8BF7\u9009\u62E9 machine-local agent profile\u3002" };
  }
  return {
    ok: true,
    payload: {
      taskPath: path,
      profileId: profile,
      callerKind: "user"
    }
  };
}
function validateDispatchForm(form) {
  if (!form.boxId) {
    return { ok: false, reason: "\u8BF7\u5148\u9009\u4E2D\u4E00\u4E2A\u534F\u4F5C\u6846\u3002", payload: null };
  }
  if (!form.coordination) {
    return {
      ok: false,
      reason: "\u5F53\u524D\u6982\u5FF5\u4E0D\u53EF\u534F\u8C03\uFF08coordination=false\uFF09\uFF0C\u65E0\u6CD5\u6D3E\u6D3B\u3002",
      payload: null
    };
  }
  if (!form.roles.length) {
    return {
      ok: false,
      reason: "\u5E10\u5185\u5C1A\u65E0 role\uFF0C\u8BF7\u5148\u5728 roles \u6CE8\u518C\u8868\u6DFB\u52A0\u76EE\u6807\u89D2\u8272\u3002",
      payload: null
    };
  }
  const role = form.role.trim();
  if (!role) {
    return { ok: false, reason: "\u8BF7\u9009\u62E9\u76EE\u6807 role\u3002", payload: null };
  }
  if (!form.roles.some((r) => r.name === role)) {
    return { ok: false, reason: `\u76EE\u6807 role\u300C${role}\u300D\u4E0D\u5728\u6CE8\u518C\u8868\u4E2D\u3002`, payload: null };
  }
  const prompt = form.prompt.trim();
  if (!prompt) {
    return { ok: false, reason: "\u8BF7\u586B\u5199 user prompt\u3002", payload: null };
  }
  return {
    ok: true,
    reason: null,
    payload: {
      boxId: form.boxId,
      role,
      prompt,
      dispatchedBy: "user"
    }
  };
}
function buildAcceptPayload(taskPath, actor = "user") {
  return { taskPath, actor };
}
function buildRejectPayload(taskPath, reason, actor = "user") {
  const note = reason.trim();
  if (!note) {
    return { ok: false, reason: "\u9A73\u56DE\u9700\u8981\u586B\u5199\u7B80\u77ED\u539F\u56E0\u3002" };
  }
  return {
    ok: true,
    payload: {
      taskPath,
      actor,
      note,
      resume: true
    }
  };
}
function taskStateLabel(state2, legacyStatus) {
  const s = state2 || legacyStatus || "";
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
function sessionStateLabel(state2) {
  if (!state2) return "";
  switch (state2) {
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
      return state2;
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
function buildTaskReviewItems(tasks, deliveries2 = [], sessions2 = []) {
  const byId = /* @__PURE__ */ new Map();
  const byTaskId = /* @__PURE__ */ new Map();
  for (const d of deliveries2) {
    byId.set(d.id, d);
    const list = byTaskId.get(d.taskId) ?? [];
    list.push(d);
    byTaskId.set(d.taskId, list);
  }
  const sessionById = /* @__PURE__ */ new Map();
  const sessionByTaskId = /* @__PURE__ */ new Map();
  for (const s of sessions2) {
    sessionById.set(s.sessionId, s);
    if (s.lastTaskId) sessionByTaskId.set(s.lastTaskId, s);
  }
  return tasks.map((task) => {
    const state2 = task.state || task.status;
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
    const label = taskStateLabel(state2, task.status);
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
      state: state2,
      claims: task.claims ?? [],
      prompt: task.prompt,
      activeDeliveryId: task.activeDeliveryId,
      sessionId: task.sessionId ?? session?.sessionId,
      sessionState: session?.state,
      sessionAlive: session?.alive,
      sessionProfileId: session?.profileId,
      deliverySummary,
      commits,
      canAcceptOrReject: state2 === "delivered",
      canStartAgent: canStartAgentOnTask(state2, session),
      canInterrupt: canInterruptTask(state2, session, {
        hasSessionId: !!(task.sessionId || session?.sessionId)
      }),
      summaryLine
    };
  });
}
function truncate(text, max) {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "\u2026";
}
function suggestBoxName(typeName, now = Date.now()) {
  const safe = typeName.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "box";
  return `${safe}-${now.toString(36).slice(-4)}`;
}

// src/desktop/workbench/layout-prefs.ts
var LAYOUT_STORAGE_KEY = "tent.desktop.mainLayout.v1";
var LAYOUT_BOUNDS = {
  leftMin: 220,
  leftMax: 420,
  leftDefault: 280,
  rightMin: 280,
  rightMax: 520,
  rightDefault: 340,
  centerMin: 480,
  /** Visual + hit area for each splitter */
  splitterWidth: 8,
  /** Horizontal chrome around the three columns (layout padding) */
  layoutPadX: 20,
  resizeStep: 12
};
function defaultLayoutPrefs() {
  return {
    leftWidth: LAYOUT_BOUNDS.leftDefault,
    rightWidth: LAYOUT_BOUNDS.rightDefault,
    leftCollapsed: false,
    rightCollapsed: false
  };
}
function clampWidth(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
function normalizeLayoutPrefs(input) {
  const base = defaultLayoutPrefs();
  if (!input || typeof input !== "object") return base;
  return {
    leftWidth: clampWidth(
      typeof input.leftWidth === "number" ? input.leftWidth : base.leftWidth,
      LAYOUT_BOUNDS.leftMin,
      LAYOUT_BOUNDS.leftMax
    ),
    rightWidth: clampWidth(
      typeof input.rightWidth === "number" ? input.rightWidth : base.rightWidth,
      LAYOUT_BOUNDS.rightMin,
      LAYOUT_BOUNDS.rightMax
    ),
    leftCollapsed: input.leftCollapsed === true,
    rightCollapsed: input.rightCollapsed === true
  };
}
function loadLayoutPrefs(storage) {
  if (!storage) return defaultLayoutPrefs();
  try {
    const raw = storage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return defaultLayoutPrefs();
    return normalizeLayoutPrefs(JSON.parse(raw));
  } catch {
    return defaultLayoutPrefs();
  }
}
function saveLayoutPrefs(storage, prefs) {
  if (!storage) return;
  try {
    const normalized = normalizeLayoutPrefs(prefs);
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
  }
}
function fixedChromeWidth(leftCollapsed, rightCollapsed) {
  let w = LAYOUT_BOUNDS.layoutPadX;
  if (!leftCollapsed) w += LAYOUT_BOUNDS.splitterWidth;
  if (!rightCollapsed) w += LAYOUT_BOUNDS.splitterWidth;
  return w;
}
function centerWidthFor(available, leftCollapsed, rightCollapsed, leftWidth, rightWidth) {
  const chrome = fixedChromeWidth(leftCollapsed, rightCollapsed);
  const sides = (leftCollapsed ? 0 : leftWidth) + (rightCollapsed ? 0 : rightWidth);
  return available - chrome - sides;
}
function computeEffectiveLayout(prefs, viewportWidth) {
  const normalized = normalizeLayoutPrefs(prefs);
  let leftCollapsed = normalized.leftCollapsed;
  let rightCollapsed = normalized.rightCollapsed;
  let leftWidth = normalized.leftWidth;
  let rightWidth = normalized.rightWidth;
  let autoCollapsedRight = false;
  const available = Math.max(0, Math.round(viewportWidth));
  if (!leftCollapsed && !rightCollapsed && centerWidthFor(available, false, false, leftWidth, rightWidth) < LAYOUT_BOUNDS.centerMin) {
    rightCollapsed = true;
    autoCollapsedRight = true;
  }
  if (!leftCollapsed && rightCollapsed) {
    const roomForLeft = available - fixedChromeWidth(false, true) - LAYOUT_BOUNDS.centerMin;
    if (roomForLeft < leftWidth) {
      leftWidth = clampWidth(roomForLeft, LAYOUT_BOUNDS.leftMin, LAYOUT_BOUNDS.leftMax);
    }
  } else if (leftCollapsed && !rightCollapsed) {
    const roomForRight = available - fixedChromeWidth(true, false) - LAYOUT_BOUNDS.centerMin;
    if (roomForRight < rightWidth) {
      if (roomForRight < LAYOUT_BOUNDS.rightMin) {
        rightCollapsed = true;
        autoCollapsedRight = true;
      } else {
        rightWidth = clampWidth(roomForRight, LAYOUT_BOUNDS.rightMin, LAYOUT_BOUNDS.rightMax);
      }
    }
  } else if (!leftCollapsed && !rightCollapsed) {
    const roomForLeft = available - fixedChromeWidth(false, false) - rightWidth - LAYOUT_BOUNDS.centerMin;
    if (roomForLeft < leftWidth) {
      leftWidth = clampWidth(roomForLeft, LAYOUT_BOUNDS.leftMin, LAYOUT_BOUNDS.leftMax);
      if (centerWidthFor(available, false, false, leftWidth, rightWidth) < LAYOUT_BOUNDS.centerMin) {
        rightCollapsed = true;
        autoCollapsedRight = true;
        const roomLeftOnly = available - fixedChromeWidth(false, true) - LAYOUT_BOUNDS.centerMin;
        leftWidth = clampWidth(
          Math.min(normalized.leftWidth, roomLeftOnly),
          LAYOUT_BOUNDS.leftMin,
          LAYOUT_BOUNDS.leftMax
        );
      }
    }
  }
  const centerWidth = Math.max(
    0,
    centerWidthFor(available, leftCollapsed, rightCollapsed, leftWidth, rightWidth)
  );
  return {
    leftWidth,
    rightWidth,
    leftCollapsed,
    rightCollapsed,
    centerWidth,
    autoCollapsedRight
  };
}
function capSideForCenter(sideWidth, sideMin, sideMax, maxForCenter) {
  if (!Number.isFinite(maxForCenter)) {
    return clampWidth(sideWidth, sideMin, sideMax);
  }
  if (maxForCenter < sideMin) {
    return sideMin;
  }
  return clampWidth(Math.min(sideWidth, maxForCenter), sideMin, sideMax);
}
function resizeSide(prefs, side, nextWidth, viewportWidth) {
  const normalized = normalizeLayoutPrefs(prefs);
  if (side === "left") {
    let leftWidth = clampWidth(nextWidth, LAYOUT_BOUNDS.leftMin, LAYOUT_BOUNDS.leftMax);
    if (!normalized.rightCollapsed) {
      const maxLeft = viewportWidth - fixedChromeWidth(false, false) - normalized.rightWidth - LAYOUT_BOUNDS.centerMin;
      leftWidth = capSideForCenter(
        leftWidth,
        LAYOUT_BOUNDS.leftMin,
        LAYOUT_BOUNDS.leftMax,
        maxLeft
      );
    } else {
      const maxLeft = viewportWidth - fixedChromeWidth(false, true) - LAYOUT_BOUNDS.centerMin;
      leftWidth = capSideForCenter(
        leftWidth,
        LAYOUT_BOUNDS.leftMin,
        LAYOUT_BOUNDS.leftMax,
        maxLeft
      );
    }
    return { ...normalized, leftWidth, leftCollapsed: false };
  }
  let rightWidth = clampWidth(nextWidth, LAYOUT_BOUNDS.rightMin, LAYOUT_BOUNDS.rightMax);
  if (!normalized.leftCollapsed) {
    const maxRight = viewportWidth - fixedChromeWidth(false, false) - normalized.leftWidth - LAYOUT_BOUNDS.centerMin;
    rightWidth = capSideForCenter(
      rightWidth,
      LAYOUT_BOUNDS.rightMin,
      LAYOUT_BOUNDS.rightMax,
      maxRight
    );
  } else {
    const maxRight = viewportWidth - fixedChromeWidth(true, false) - LAYOUT_BOUNDS.centerMin;
    rightWidth = capSideForCenter(
      rightWidth,
      LAYOUT_BOUNDS.rightMin,
      LAYOUT_BOUNDS.rightMax,
      maxRight
    );
  }
  return { ...normalized, rightWidth, rightCollapsed: false };
}
function toggleCollapsed(prefs, side) {
  const normalized = normalizeLayoutPrefs(prefs);
  if (side === "left") {
    return { ...normalized, leftCollapsed: !normalized.leftCollapsed };
  }
  return { ...normalized, rightCollapsed: !normalized.rightCollapsed };
}
function stepResize(prefs, side, direction, viewportWidth, step = LAYOUT_BOUNDS.resizeStep) {
  const normalized = normalizeLayoutPrefs(prefs);
  const current = side === "left" ? normalized.leftWidth : normalized.rightWidth;
  return resizeSide(prefs, side, current + direction * step, viewportWidth);
}

// src/desktop/renderer/context-card-drag.ts
function applyContextCardDragStart(dataTransfer, text) {
  if (!dataTransfer) return;
  dataTransfer.clearData();
  dataTransfer.setData("text/plain", text);
  dataTransfer.effectAllowed = "copy";
}
function bindContextCardDrag(node, text, options = {}) {
  node.draggable = true;
  node.setAttribute("title", "\u62D6\u5230\u5916\u90E8\u8F93\u5165\u6846 \xB7 \u5355\u51FB\u590D\u5236");
  node.addEventListener("dragstart", (ev) => {
    applyContextCardDragStart(ev.dataTransfer, text);
    node.classList.add("is-dragging");
  });
  node.addEventListener("dragend", () => {
    node.classList.remove("is-dragging");
  });
  node.addEventListener("click", () => {
    void copyContextCardText(text, options);
  });
}
async function copyContextCardText(text, options = {}) {
  const write = options.writeClipboard ?? (async (value) => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    throw new Error("Clipboard API unavailable");
  });
  try {
    await write(text);
    options.onCopied?.(text);
  } catch (err) {
    options.onCopyError?.(err);
  }
}

// src/desktop/renderer/main-ui.ts
var localTabs = /* @__PURE__ */ new Map();
var activeCx = null;
var tree = [];
var state = null;
var workspaceId = null;
var coordinationTypes = [];
var roles = [];
var taskReview = [];
var deliveries = [];
var sessions = [];
var profiles = [];
var selectedProfileId = null;
var createTypePick = "";
var dispatchRole = "";
var dispatchPrompt = "";
var rejectDrafts = /* @__PURE__ */ new Map();
var layoutPrefs = loadLayoutPrefs(
  typeof localStorage !== "undefined" ? localStorage : null
);
var resizeSession = null;
var el = {
  health: document.getElementById("health-pill"),
  wsSelect: document.getElementById("workspace-select"),
  status: document.getElementById("status-line"),
  layout: document.getElementById("main-layout"),
  treePanel: document.getElementById("tree-panel"),
  sidePanel: document.getElementById("side-panel"),
  splitterLeft: document.getElementById("splitter-left"),
  splitterRight: document.getElementById("splitter-right"),
  btnCollapseLeft: document.getElementById("btn-collapse-left"),
  btnCollapseRight: document.getElementById("btn-collapse-right"),
  btnExpandLeft: document.getElementById("btn-expand-left"),
  btnExpandRight: document.getElementById("btn-expand-right"),
  taskCount: document.getElementById("task-count"),
  tree: document.getElementById("tree"),
  tabs: document.getElementById("tabs"),
  toolbar: document.getElementById("toolbar"),
  editor: document.getElementById("editor-host"),
  meta: document.getElementById("meta"),
  dispatch: document.getElementById("dispatch-panel"),
  tasks: document.getElementById("tasks"),
  cards: document.getElementById("cards"),
  searchInput: document.getElementById("search-input"),
  searchHits: document.getElementById("search-hits"),
  createType: document.getElementById("create-type"),
  btnNewBox: document.getElementById("btn-new-box"),
  searchDrawer: document.getElementById("search-drawer"),
  createDrawer: document.getElementById("create-drawer"),
  railOverflow: document.getElementById("rail-overflow"),
  btnToggleSearch: document.getElementById("btn-toggle-search"),
  btnToggleCreate: document.getElementById("btn-toggle-create"),
  btnRailMore: document.getElementById("btn-rail-more"),
  secPending: document.getElementById("sec-pending"),
  secDispatch: document.getElementById("sec-dispatch"),
  secCards: document.getElementById("sec-cards")
};
function layoutViewportWidth() {
  return el.layout?.clientWidth || window.innerWidth || 1200;
}
function persistLayout() {
  saveLayoutPrefs(typeof localStorage !== "undefined" ? localStorage : null, layoutPrefs);
}
function applyLayoutChrome() {
  if (!el.layout) return;
  const effective = computeEffectiveLayout(layoutPrefs, layoutViewportWidth());
  el.layout.style.setProperty("--layout-left-width", `${effective.leftWidth}px`);
  el.layout.style.setProperty("--layout-right-width", `${effective.rightWidth}px`);
  el.layout.classList.toggle("is-left-collapsed", effective.leftCollapsed);
  el.layout.classList.toggle("is-right-collapsed", effective.rightCollapsed);
  if (el.btnExpandLeft) {
    el.btnExpandLeft.hidden = !layoutPrefs.leftCollapsed;
  }
  if (el.btnExpandRight) {
    el.btnExpandRight.hidden = !layoutPrefs.rightCollapsed;
  }
  if (el.btnCollapseLeft) {
    el.btnCollapseLeft.hidden = layoutPrefs.leftCollapsed;
    el.btnCollapseLeft.setAttribute("aria-expanded", layoutPrefs.leftCollapsed ? "false" : "true");
  }
  if (el.btnCollapseRight) {
    el.btnCollapseRight.hidden = layoutPrefs.rightCollapsed;
    el.btnCollapseRight.setAttribute("aria-expanded", layoutPrefs.rightCollapsed ? "false" : "true");
  }
  if (el.splitterLeft) {
    el.splitterLeft.setAttribute("aria-valuemin", String(LAYOUT_BOUNDS.leftMin));
    el.splitterLeft.setAttribute("aria-valuemax", String(LAYOUT_BOUNDS.leftMax));
    el.splitterLeft.setAttribute("aria-valuenow", String(effective.leftWidth));
    el.splitterLeft.tabIndex = effective.leftCollapsed ? -1 : 0;
  }
  if (el.splitterRight) {
    el.splitterRight.setAttribute("aria-valuemin", String(LAYOUT_BOUNDS.rightMin));
    el.splitterRight.setAttribute("aria-valuemax", String(LAYOUT_BOUNDS.rightMax));
    el.splitterRight.setAttribute("aria-valuenow", String(effective.rightWidth));
    el.splitterRight.tabIndex = effective.rightCollapsed ? -1 : 0;
  }
}
function setLayoutPrefs(next, persist = true) {
  layoutPrefs = next;
  applyLayoutChrome();
  if (persist) persistLayout();
}
function onToggleSide(side) {
  setLayoutPrefs(toggleCollapsed(layoutPrefs, side));
}
function beginResize(side, clientX) {
  const width = side === "left" ? layoutPrefs.leftWidth : layoutPrefs.rightWidth;
  resizeSession = { side, startX: clientX, startWidth: width };
  document.body.classList.add("is-resizing");
  const splitter = side === "left" ? el.splitterLeft : el.splitterRight;
  splitter?.classList.add("is-active");
}
function onResizePointerMove(clientX) {
  if (!resizeSession) return;
  const delta = clientX - resizeSession.startX;
  const nextWidth = resizeSession.side === "left" ? resizeSession.startWidth + delta : resizeSession.startWidth - delta;
  setLayoutPrefs(resizeSide(layoutPrefs, resizeSession.side, nextWidth, layoutViewportWidth()), false);
}
function endResize() {
  if (!resizeSession) return;
  resizeSession = null;
  document.body.classList.remove("is-resizing");
  el.splitterLeft?.classList.remove("is-active");
  el.splitterRight?.classList.remove("is-active");
  persistLayout();
  applyLayoutChrome();
}
function bindSplitter(side, node) {
  if (!node) return;
  node.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    node.setPointerCapture?.(ev.pointerId);
    beginResize(side, ev.clientX);
  });
  node.addEventListener("pointermove", (ev) => {
    if (!resizeSession || resizeSession.side !== side) return;
    onResizePointerMove(ev.clientX);
  });
  node.addEventListener("pointerup", () => endResize());
  node.addEventListener("pointercancel", () => endResize());
  node.addEventListener("lostpointercapture", () => endResize());
  node.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      ev.preventDefault();
      const dir = side === "left" ? ev.key === "ArrowRight" ? 1 : -1 : ev.key === "ArrowLeft" ? 1 : -1;
      setLayoutPrefs(stepResize(layoutPrefs, side, dir, layoutViewportWidth()));
    } else if (ev.key === "Home") {
      ev.preventDefault();
      const min = side === "left" ? LAYOUT_BOUNDS.leftMin : LAYOUT_BOUNDS.rightMin;
      setLayoutPrefs(resizeSide(layoutPrefs, side, min, layoutViewportWidth()));
    } else if (ev.key === "End") {
      ev.preventDefault();
      const max = side === "left" ? LAYOUT_BOUNDS.leftMax : LAYOUT_BOUNDS.rightMax;
      setLayoutPrefs(resizeSide(layoutPrefs, side, max, layoutViewportWidth()));
    } else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      onToggleSide(side);
    }
  });
  node.addEventListener("dblclick", () => onToggleSide(side));
}
function setDrawerOpen(drawer, toggle, open) {
  if (!drawer) return;
  drawer.hidden = !open;
  if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
}
function setMenuOpen(open) {
  if (!el.railOverflow) return;
  el.railOverflow.hidden = !open;
  el.btnRailMore?.setAttribute("aria-expanded", open ? "true" : "false");
}
function closeChromePopovers() {
  setDrawerOpen(el.searchDrawer, el.btnToggleSearch, false);
  setDrawerOpen(el.createDrawer, el.btnToggleCreate, false);
  setMenuOpen(false);
}
function bindChromeMenus() {
  el.btnToggleSearch?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = !!el.searchDrawer?.hidden;
    setDrawerOpen(el.createDrawer, el.btnToggleCreate, false);
    setMenuOpen(false);
    setDrawerOpen(el.searchDrawer, el.btnToggleSearch, open);
    if (open) el.searchInput?.focus();
  });
  el.btnToggleCreate?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = !!el.createDrawer?.hidden;
    setDrawerOpen(el.searchDrawer, el.btnToggleSearch, false);
    setMenuOpen(false);
    setDrawerOpen(el.createDrawer, el.btnToggleCreate, open);
  });
  el.btnRailMore?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = !!el.railOverflow?.hidden;
    setDrawerOpen(el.searchDrawer, el.btnToggleSearch, false);
    setDrawerOpen(el.createDrawer, el.btnToggleCreate, false);
    setMenuOpen(open);
  });
  el.railOverflow?.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t?.closest(".menu-item")) setMenuOpen(false);
  });
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!t) return;
    if (el.railOverflow?.contains(t) || el.btnRailMore?.contains(t)) return;
    if (el.searchDrawer?.contains(t) || el.btnToggleSearch?.contains(t)) return;
    if (el.createDrawer?.contains(t) || el.btnToggleCreate?.contains(t)) return;
    closeChromePopovers();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeChromePopovers();
  });
}
function syncInspectorSections() {
  const hasTasks = taskReview.length > 0;
  const tab = activeCx ? localTabs.get(activeCx) : null;
  const canDispatch = !!(tab && tab.coordination);
  if (!el.secPending || !el.secDispatch || !el.secCards) return;
  const anyOpen = el.secPending.open || el.secDispatch.open || el.secCards.open;
  if (anyOpen) return;
  if (hasTasks) el.secPending.open = true;
  else if (canDispatch) el.secDispatch.open = true;
}
function bindLayoutChrome() {
  el.btnCollapseLeft?.addEventListener("click", () => onToggleSide("left"));
  el.btnCollapseRight?.addEventListener("click", () => onToggleSide("right"));
  el.btnExpandLeft?.addEventListener("click", () => {
    if (layoutPrefs.leftCollapsed) onToggleSide("left");
  });
  el.btnExpandRight?.addEventListener("click", () => {
    if (layoutPrefs.rightCollapsed) onToggleSide("right");
  });
  bindSplitter("left", el.splitterLeft);
  bindSplitter("right", el.splitterRight);
  window.addEventListener("resize", () => applyLayoutChrome());
  window.addEventListener("pointerup", () => endResize());
  applyLayoutChrome();
}
async function boot() {
  bindLayoutChrome();
  bindChromeMenus();
  document.getElementById("btn-open-ws").addEventListener("click", onOpenWorkspace);
  document.getElementById("btn-refresh").addEventListener("click", () => void refresh());
  document.getElementById("btn-new-note").addEventListener("click", () => void onCreateNote());
  el.btnNewBox.addEventListener("click", () => void onCreateCoordBox());
  el.createType.addEventListener("change", () => {
    createTypePick = el.createType.value;
  });
  document.getElementById("btn-search").addEventListener("click", () => void onSearch());
  document.getElementById("btn-card").addEventListener("click", () => void onEmitCard());
  document.getElementById("btn-float").addEventListener("click", () => void window.tentDesktop.showFloat());
  el.wsSelect.addEventListener("change", () => {
    const id = el.wsSelect.value;
    if (id) {
      void window.tentDesktop.setForeground(id).then((s) => applyShell(s));
    }
  });
  el.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void onSearch();
  });
  window.tentDesktop.onStateChanged((s) => applyShell(s));
  await refresh();
}
async function refresh() {
  const s = await window.tentDesktop.getState();
  applyShell(s);
  if (workspaceId) {
    await Promise.all([reloadTree(), reloadRegistry(), reloadTasks(), reloadProfiles()]);
  } else {
    await reloadProfiles();
  }
}
function applyShell(s) {
  state = s;
  const ok = s.health.status === "ok";
  el.health.className = `status-dot ${ok ? "ok" : "off"}`;
  el.health.textContent = "";
  el.health.setAttribute("aria-label", ok ? "\u670D\u52A1\u5728\u7EBF" : "\u670D\u52A1\u79BB\u7EBF");
  el.health.title = ok ? `Local Service \u6B63\u5E38 \xB7 pid ${s.health.pid ?? "?"} \xB7 ${s.health.version ?? ""}` : "Local Service \u79BB\u7EBF";
  el.wsSelect.innerHTML = "";
  for (const w of s.workspaces) {
    const opt = document.createElement("option");
    opt.value = w.workspaceId;
    const label = (w.tentName || "").trim() || "\u5DE5\u4F5C\u533A";
    opt.textContent = label;
    opt.title = w.workspaceRoot || w.workspaceId;
    if (w.foreground || w.workspaceId === s.foregroundWorkspaceId) opt.selected = true;
    el.wsSelect.appendChild(opt);
  }
  workspaceId = s.foregroundWorkspaceId;
  const live = s.statusMessage || s.workspace?.statusMessage || "";
  if (live) el.status.textContent = live;
  if (s.workspace?.tree?.length) {
    tree = s.workspace.tree;
    renderTree();
  }
  if (s.coordinationTypes?.length) {
    coordinationTypes = s.coordinationTypes;
    renderCreateTypeSelect();
  }
  if (s.roles) {
    roles = s.roles;
  }
  if (s.profiles?.length) {
    profiles = s.profiles;
  }
  if (s.selectedProfileId !== void 0) {
    selectedProfileId = s.selectedProfileId;
  }
  if (s.taskReview?.length) {
    taskReview = s.taskReview;
  } else if (s.tasks?.length) {
    taskReview = buildTaskReviewItems(
      s.tasks.map((t) => ({
        path: t.path,
        id: t.id,
        role: t.role,
        claims: t.claims || [],
        status: t.status === "taken" ? "taken" : "pending",
        state: t.state || t.status,
        prompt: t.prompt,
        activeDeliveryId: t.activeDeliveryId,
        sessionId: t.sessionId,
        manifest: ""
      })),
      deliveries,
      sessions
    );
  } else {
    taskReview = [];
  }
  renderTasks();
  renderDispatchPanel();
  void loadCards();
}
async function reloadTree() {
  if (!workspaceId) return;
  const result = await window.tentDesktop.rpc("docs.list", { workspaceId });
  tree = result.concepts || [];
  renderTree();
}
async function reloadRegistry() {
  if (!workspaceId) return;
  try {
    const [typesResult, rolesResult] = await Promise.all([
      window.tentDesktop.rpc("registry.types", { workspaceId }),
      window.tentDesktop.rpc("registry.roles", { workspaceId })
    ]);
    coordinationTypes = listCoordinationTypeOptions(typesResult.types || []);
    roles = listRoleOptions(rolesResult.roles || []);
    if (!createTypePick || !coordinationTypes.some((t) => t.name === createTypePick)) {
      createTypePick = pickDefaultCoordinationType(coordinationTypes) || "";
    }
    if (!dispatchRole || !roles.some((r) => r.name === dispatchRole)) {
      dispatchRole = roles[0]?.name || "";
    }
    renderCreateTypeSelect();
    renderDispatchPanel();
  } catch (err) {
    setError(err);
  }
}
async function reloadTasks() {
  if (!workspaceId) return;
  try {
    const [taskResult, deliveryResult, sessionResult] = await Promise.all([
      window.tentDesktop.rpc("task.list", { workspaceId }),
      window.tentDesktop.rpc("delivery.list", { workspaceId }),
      window.tentDesktop.rpc("session.list", { workspaceId })
    ]);
    deliveries = deliveryResult.deliveries || [];
    sessions = sessionResult.sessions || [];
    taskReview = buildTaskReviewItems(taskResult.tasks || [], deliveries, sessions);
    renderTasks();
  } catch (err) {
    setError(err);
  }
}
async function reloadProfiles() {
  try {
    const result = await window.tentDesktop.rpc("profile.list", {});
    profiles = listProfileOptions(result.profiles || []);
    if (!selectedProfileId || !profiles.some((p) => p.id === selectedProfileId)) {
      selectedProfileId = pickDefaultProfileId(profiles);
    }
    renderTasks();
  } catch (err) {
    profiles = [];
    selectedProfileId = null;
    setError(err);
  }
}
function renderCreateTypeSelect() {
  const prev = createTypePick || pickDefaultCoordinationType(coordinationTypes) || "";
  createTypePick = prev;
  if (!coordinationTypes.length) {
    el.createType.innerHTML = `<option value="">\u65E0\u53EF\u534F\u8C03\u7C7B\u578B</option>`;
    el.createType.disabled = true;
    el.btnNewBox.disabled = true;
    el.btnNewBox.title = "\u5F53\u524D types \u6CE8\u518C\u8868\u6CA1\u6709 coordination=true \u7684\u4E00\u7EA7\u7C7B\u578B";
    return;
  }
  el.createType.disabled = false;
  el.btnNewBox.disabled = false;
  el.btnNewBox.title = "\u4F7F\u7528\u6240\u9009\u53EF\u534F\u8C03\u7C7B\u578B\u65B0\u5EFA\u534F\u4F5C\u6846";
  el.createType.innerHTML = coordinationTypes.map(
    (t) => `<option value="${escapeHtml(t.name)}"${t.name === createTypePick ? " selected" : ""}>${escapeHtml(t.name)}</option>`
  ).join("");
}
function renderTree() {
  el.tree.innerHTML = tree.length ? renderNodes(tree) : `<li class="muted">\u6682\u65E0\u6982\u5FF5</li>`;
  el.tree.querySelectorAll("[data-open]").forEach((node) => {
    node.addEventListener("click", () => void openConcept(node.getAttribute("data-open")));
  });
}
function nodeStatusMark(status) {
  if (!status) return "";
  const s = status.toLowerCase();
  if (s === "done" || s === "completed" || s === "accepted" || s === "closed") return "";
  if (s === "doing" || s === "running" || s === "in_progress" || s === "active") {
    return `<span class="status-mark is-doing" title="${escapeHtml(status)}" aria-hidden="true"></span>`;
  }
  if (s === "todo" || s === "pending" || s === "queued" || s === "open") {
    return `<span class="status-mark is-todo" title="${escapeHtml(status)}" aria-hidden="true"></span>`;
  }
  return `<span class="status-mark" title="${escapeHtml(status)}" aria-hidden="true"></span>`;
}
function renderNodes(nodes) {
  return nodes.map((n) => {
    const mark = n.coordination ? nodeStatusMark(n.status) : "";
    const active = n.id === activeCx ? " active" : "";
    const kids = n.children?.length ? `<ul>${renderNodes(n.children)}</ul>` : "";
    return `<li>
        <div class="tree-node${active}" data-open="${escapeHtml(n.id)}" title="${escapeHtml(n.id)} \xB7 ${escapeHtml(n.type)}">
          <span class="tree-name">${escapeHtml(n.name)}</span>
          <span class="tree-meta">${mark}</span>
        </div>
        ${kids}
      </li>`;
  }).join("");
}
async function openConcept(cx) {
  if (!workspaceId) return;
  const edit = await window.tentDesktop.rpc("docs.readForEdit", {
    workspaceId,
    id: cx
  });
  const existing = localTabs.get(edit.id);
  if (existing?.dirty) {
    activeCx = edit.id;
    renderAll();
    el.status.textContent = "\u5F53\u524D\u6807\u7B7E\u6709\u672A\u4FDD\u5B58\u66F4\u6539\u3002";
    return;
  }
  const tab = {
    cx: edit.id,
    path: edit.path,
    name: edit.name || edit.path.split("/").pop() || edit.path,
    type: edit.type || String(edit.frontmatter?.type || "note"),
    coordination: !!edit.coordination,
    etag: edit.etag,
    buffer: edit.raw ?? reconstruct(edit.frontmatter, edit.body),
    dirty: false,
    mode: existing?.mode ?? "source",
    frontmatter: edit.frontmatter || {},
    artifactRefs: edit.artifactRefs
  };
  localTabs.set(tab.cx, tab);
  activeCx = tab.cx;
  renderAll();
}
function reconstruct(fm, body) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm || {})) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---");
  lines.push(body.endsWith("\n") || body === "" ? body : body + "\n");
  return lines.join("\n");
}
function renderAll() {
  renderTabs();
  renderToolbar();
  renderEditor();
  renderMeta();
  renderDispatchPanel();
  renderTree();
  syncInspectorSections();
}
function renderTabs() {
  const tabs = [...localTabs.values()];
  el.tabs.innerHTML = tabs.map((t) => {
    const active = t.cx === activeCx ? " active" : "";
    return `<button type="button" class="tab${active}" data-tab="${escapeHtml(t.cx)}">${escapeHtml(t.name)}${t.dirty ? " \xB7" : ""}</button>`;
  }).join("");
  el.tabs.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeCx = btn.getAttribute("data-tab");
      renderAll();
    });
  });
}
function renderToolbar() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.toolbar.innerHTML = "";
    return;
  }
  const promoteTarget = pickDefaultCoordinationType(coordinationTypes) || "goal";
  const modeLabel = tab.mode === "preview" ? "\u9884\u89C8" : "\u6E90\u7801";
  const modeTitle = tab.mode === "preview" ? "\u5207\u6362\u5230\u6E90\u7801" : "\u5207\u6362\u5230\u9884\u89C8";
  el.toolbar.innerHTML = `
    <button type="button" class="icon-btn mode-toggle" data-act="toggle-mode" title="${modeTitle}" aria-label="${modeTitle}\uFF08${modeLabel}\uFF09">${tab.mode === "preview" ? "\xB6" : "{ }"}</button>
    ${tab.dirty ? `<button type="button" data-act="save" class="btn btn-primary btn-quiet-save" title="\u4FDD\u5B58">\u4FDD\u5B58</button>` : ""}
    <div class="menu-wrap">
      <button type="button" class="icon-btn" data-doc-more title="\u66F4\u591A" aria-label="\u6587\u6863\u66F4\u591A\u64CD\u4F5C" aria-haspopup="menu">\u22EF</button>
      <div class="menu" data-doc-menu role="menu" hidden>
        <button type="button" class="menu-item" role="menuitem" data-act="source"${tab.mode === "source" ? ' aria-current="true"' : ""}>\u6E90\u7801</button>
        <button type="button" class="menu-item" role="menuitem" data-act="preview"${tab.mode === "preview" ? ' aria-current="true"' : ""}>\u9884\u89C8</button>
        <div class="menu-sep" role="separator"></div>
        <button type="button" class="menu-item" role="menuitem" data-act="card">\u53D1\u51FA\u4E0A\u4E0B\u6587\u5361</button>
        ${!tab.coordination ? `<button type="button" class="menu-item" role="menuitem" data-act="promote" title="\u63D0\u5347\u4E3A ${escapeHtml(promoteTarget)}">\u63D0\u5347\u4E3A\u534F\u4F5C\u6846</button>` : ""}
      </div>
    </div>
  `;
  const moreBtn = el.toolbar.querySelector("[data-doc-more]");
  const moreMenu = el.toolbar.querySelector("[data-doc-menu]");
  moreBtn?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!moreMenu) return;
    moreMenu.hidden = !moreMenu.hidden;
    moreBtn.setAttribute("aria-expanded", moreMenu.hidden ? "false" : "true");
  });
  el.toolbar.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (moreMenu) moreMenu.hidden = true;
      void onToolbar(btn.getAttribute("data-act"));
    });
  });
}
async function onToolbar(act) {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) return;
  if (act === "toggle-mode") {
    tab.mode = tab.mode === "source" ? "preview" : "source";
    renderAll();
    return;
  }
  if (act === "source" || act === "preview") {
    tab.mode = act;
    renderAll();
    return;
  }
  if (act === "save") {
    await saveTab(tab);
    return;
  }
  if (act === "promote") {
    if (tab.dirty) await saveTab(tab);
    const toType = pickDefaultCoordinationType(coordinationTypes) || "goal";
    try {
      await window.tentDesktop.rpc("docs.promote", {
        workspaceId,
        id: tab.cx,
        toType
      });
      el.status.textContent = `\u5DF2\u63D0\u5347\u4E3A ${toType}`;
      await openConcept(tab.cx);
      await reloadTree();
    } catch (err) {
      setError(err);
    }
    return;
  }
  if (act === "card") {
    await window.tentDesktop.pushContextCard({
      kind: "box",
      id: tab.cx,
      path: tab.path,
      label: tab.name
    });
    await loadCards();
  }
}
async function saveTab(tab) {
  try {
    const result = await window.tentDesktop.rpc("docs.write", {
      workspaceId,
      id: tab.cx,
      baseEtag: tab.etag,
      raw: tab.buffer
    });
    tab.etag = result.etag;
    tab.dirty = false;
    el.status.textContent = "";
    await reloadTree();
    renderAll();
  } catch (err) {
    setError(err);
  }
}
function renderEditor() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.editor.innerHTML = '<div class="empty empty-cta"><p class="empty-title">\u6253\u5F00\u5DE5\u4F5C\u533A</p></div>';
    return;
  }
  if (tab.mode === "preview") {
    const body = splitBody(tab.buffer);
    el.editor.innerHTML = `<div class="preview">${renderMarkdownToHtml(body, {
      resolveWikiHref: (raw) => `#open=${encodeURIComponent(raw)}`,
      artifactRefs: tab.artifactRefs
    })}</div>`;
    return;
  }
  el.editor.innerHTML = `<textarea class="editor" id="buffer" spellcheck="false"></textarea>`;
  const ta = document.getElementById("buffer");
  ta.value = tab.buffer;
  ta.addEventListener("input", () => {
    tab.buffer = ta.value;
    tab.dirty = true;
    renderTabs();
    renderToolbar();
  });
}
function splitBody(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return raw;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return raw;
  const after = text.indexOf("\n", end + 1);
  return after === -1 ? "" : text.slice(after + 1);
}
function renderMeta() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.meta.innerHTML = `<span class="muted">\u672A\u9009\u62E9</span>`;
    el.meta.classList.add("muted");
    return;
  }
  el.meta.classList.remove("muted");
  const oneLine = tab.coordination ? `${escapeHtml(tab.type)} \xB7 \u534F\u4F5C` : escapeHtml(tab.type);
  el.meta.innerHTML = `
    <div class="meta-name">${escapeHtml(tab.name)}</div>
    <div class="meta-line muted">${oneLine}</div>
    <details class="meta-details">
      <summary>\u8BE6\u60C5</summary>
      <dl>
        <dt>\u7C7B\u578B</dt><dd>${escapeHtml(tab.type)}${tab.coordination ? " \xB7 \u534F\u4F5C" : ""}</dd>
        <dt>\u8DEF\u5F84</dt><dd title="${escapeHtml(tab.path)}">${escapeHtml(tab.path)}</dd>
        <dt>\u6807\u8BC6</dt><dd><code>${escapeHtml(tab.cx)}</code></dd>
      </dl>
    </details>`;
}
function renderDispatchPanel() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.dispatch.innerHTML = `<div class="muted dispatch-empty">\u9009\u4E2D\u534F\u4F5C\u6846\u540E\u53EF\u6D3E\u6D3B</div>`;
    return;
  }
  if (!tab.coordination) {
    el.dispatch.innerHTML = `<div class="muted dispatch-empty">\u300C${escapeHtml(tab.name)}\u300D\u4E0D\u53EF\u534F\u8C03\uFF08\u666E\u901A\u7B14\u8BB0\uFF09\u3002\u8BF7\u65B0\u5EFA\u534F\u4F5C\u6846\u6216\u63D0\u5347\u7C7B\u578B\u3002</div>`;
    return;
  }
  const roleOpts = roles.length > 0 ? roles.map(
    (r) => `<option value="${escapeHtml(r.name)}"${r.name === dispatchRole ? " selected" : ""}>${escapeHtml(r.name)}</option>`
  ).join("") : `<option value="">\uFF08\u65E0 role\uFF09</option>`;
  const validation = validateDispatchForm({
    boxId: tab.cx,
    coordination: tab.coordination,
    role: dispatchRole,
    prompt: dispatchPrompt,
    roles
  });
  el.dispatch.innerHTML = `
    <div class="dispatch-form">
      <div class="field-row">
        <label for="dispatch-role">\u76EE\u6807 role</label>
        <select id="dispatch-role"${roles.length ? "" : " disabled"}>${roleOpts}</select>
      </div>
      <div class="field-row">
        <label for="dispatch-prompt">user prompt</label>
        <textarea id="dispatch-prompt" rows="3" placeholder="\u5199\u7ED9\u76EE\u6807 role \u7684\u4EFB\u52A1\u8BF4\u660E\u2026">${escapeHtml(dispatchPrompt)}</textarea>
      </div>
      <div class="row dispatch-actions">
        <button type="button" class="btn btn-primary" id="btn-dispatch"${validation.ok ? "" : " disabled"}>\u6D3E\u6D3B</button>
        ${validation.ok ? "" : `<span class="faint">${escapeHtml(validation.reason || "")}</span>`}
      </div>
    </div>
  `;
  const roleSel = document.getElementById("dispatch-role");
  const promptTa = document.getElementById("dispatch-prompt");
  const btn = document.getElementById("btn-dispatch");
  roleSel?.addEventListener("change", () => {
    dispatchRole = roleSel.value;
    renderDispatchPanel();
  });
  promptTa?.addEventListener("input", () => {
    dispatchPrompt = promptTa.value;
    if (btn) {
      const v = validateDispatchForm({
        boxId: tab.cx,
        coordination: tab.coordination,
        role: dispatchRole,
        prompt: dispatchPrompt,
        roles
      });
      btn.disabled = !v.ok;
      const hint = el.dispatch.querySelector(".dispatch-actions .faint");
      if (hint) hint.textContent = v.ok ? "" : v.reason || "";
      else if (!v.ok) {
        const span = document.createElement("span");
        span.className = "faint";
        span.textContent = v.reason || "";
        el.dispatch.querySelector(".dispatch-actions")?.appendChild(span);
      }
    }
  });
  btn?.addEventListener("click", () => void onDispatch());
}
async function onDispatch() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab || !workspaceId) return;
  const validation = validateDispatchForm({
    boxId: tab.cx,
    coordination: tab.coordination,
    role: dispatchRole,
    prompt: dispatchPrompt,
    roles
  });
  if (!validation.ok || !validation.payload) {
    el.status.textContent = validation.reason || "\u65E0\u6CD5\u6D3E\u6D3B";
    return;
  }
  try {
    const result = await window.tentDesktop.rpc("task.dispatch", {
      workspaceId,
      boxId: validation.payload.boxId,
      role: validation.payload.role,
      prompt: validation.payload.prompt,
      dispatchedBy: validation.payload.dispatchedBy,
      deliveryPolicy: "manual"
    });
    el.status.textContent = `\u5DF2\u6D3E\u6D3B \u2192 ${result.taskPath}\uFF08${result.state}\uFF09`;
    dispatchPrompt = "";
    await Promise.all([reloadTasks(), reloadTree()]);
    renderDispatchPanel();
  } catch (err) {
    setError(err);
  }
}
function renderTasks() {
  if (el.taskCount) {
    const n = taskReview.length;
    el.taskCount.hidden = n === 0;
    el.taskCount.textContent = String(n);
  }
  if (el.secPending) {
    if (taskReview.length > 0) {
      el.secPending.open = true;
      if (el.secDispatch) el.secDispatch.open = false;
      if (el.secCards) el.secCards.open = false;
    } else if (!el.secDispatch?.open && !el.secCards?.open) {
      el.secPending.open = false;
    }
  }
  if (!taskReview.length) {
    el.tasks.innerHTML = "";
    return;
  }
  const profileOpts = profiles.length > 0 ? profiles.map(
    (p) => `<option value="${escapeHtml(p.id)}"${p.id === selectedProfileId ? " selected" : ""}>${escapeHtml(p.label)}</option>`
  ).join("") : `<option value="">\uFF08\u65E0 profile\uFF09</option>`;
  const anyStartable = taskReview.some((t) => t.canStartAgent);
  const profileBar = anyStartable ? `<li class="task-profile-bar">
        <label class="sr-only" for="agent-profile">profile</label>
        <select id="agent-profile" title="profile"${profiles.length ? "" : " disabled"}>${profileOpts}</select>
      </li>` : "";
  el.tasks.innerHTML = profileBar + taskReview.map((t) => {
    const who = escapeHtml(t.role);
    const claims = (t.claims || []).filter(
      (c) => c !== "root" && !/^(cx|rl|tk|ss|dl|ti)-/i.test(c)
    );
    const claimBit = claims.length ? `<span class="task-claims muted">${claims.map((c) => escapeHtml(c)).join(" \xB7 ")}</span>` : "";
    const blurbRaw = t.deliverySummary || t.prompt || "";
    const blurb = blurbRaw ? `<div class="task-summary">${escapeHtml(blurbRaw.length > 120 ? blurbRaw.slice(0, 117) + "\u2026" : blurbRaw)}</div>` : "";
    const stateLabel = taskStateLabel(t.state, t.status);
    const sessLabel = t.sessionState ? sessionStateLabel(t.sessionState) : "";
    const rejectDraft = rejectDrafts.get(t.path) || "";
    const startBtn = t.canStartAgent ? `<button type="button" class="btn btn-primary" data-start="${escapeHtml(t.path)}"${profiles.length && selectedProfileId ? "" : " disabled"} title="\u542F\u52A8 agent">\u542F\u52A8</button>` : "";
    const interruptBtn = t.canInterrupt ? `<button type="button" class="btn btn-secondary" data-interrupt="${escapeHtml(t.path)}" title="\u4E2D\u65AD">\u4E2D\u65AD</button>` : "";
    const reviewActions = t.canAcceptOrReject ? `<button type="button" class="btn btn-primary" data-accept="${escapeHtml(t.path)}">\u786E\u8BA4</button>
            <div class="reject-inline">
              <input type="text" class="field" data-reject-reason="${escapeHtml(t.path)}" placeholder="\u9A73\u56DE\u539F\u56E0" value="${escapeHtml(rejectDraft)}" />
              <button type="button" class="btn btn-secondary" data-reject="${escapeHtml(t.path)}">\u9A73\u56DE</button>
            </div>` : "";
    const actions = startBtn || interruptBtn || reviewActions ? `<div class="task-actions row">${startBtn}${interruptBtn}${reviewActions}</div>` : "";
    return `<li class="task-item" data-task="${escapeHtml(t.path)}">
        <div class="task-head">
          <strong>${who}</strong>
          ${claimBit}
        </div>
        ${blurb}
        ${actions}
        <details class="task-details">
          <summary>\u8BE6\u60C5</summary>
          <div class="task-detail-body muted">
            <div>${escapeHtml(stateLabel)}${sessLabel ? ` \xB7 ${escapeHtml(sessLabel)}` : ""}</div>
            <div class="faint" title="${escapeHtml(t.path)}">${escapeHtml(t.path)}</div>
            ${t.commits.length > 0 ? `<div>${escapeHtml(t.commits.map((c) => c.slice(0, 8)).join(", "))}</div>` : ""}
          </div>
        </details>
      </li>`;
  }).join("");
  const profileSel = document.getElementById("agent-profile");
  profileSel?.addEventListener("change", () => {
    selectedProfileId = profileSel.value || null;
    renderTasks();
  });
  el.tasks.querySelectorAll("[data-start]").forEach((btn) => {
    btn.addEventListener("click", () => void onStartAgent(btn.getAttribute("data-start")));
  });
  el.tasks.querySelectorAll("[data-interrupt]").forEach((btn) => {
    btn.addEventListener("click", () => void onInterrupt(btn.getAttribute("data-interrupt")));
  });
  el.tasks.querySelectorAll("[data-accept]").forEach((btn) => {
    btn.addEventListener("click", () => void onAccept(btn.getAttribute("data-accept")));
  });
  el.tasks.querySelectorAll("[data-reject-reason]").forEach((input) => {
    input.addEventListener("input", () => {
      rejectDrafts.set(input.getAttribute("data-reject-reason"), input.value);
    });
  });
  el.tasks.querySelectorAll("[data-reject]").forEach((btn) => {
    btn.addEventListener("click", () => void onReject(btn.getAttribute("data-reject")));
  });
}
async function onStartAgent(taskPath) {
  if (!workspaceId) return;
  const built = buildStartSessionPayload(taskPath, selectedProfileId || "");
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    const result = await window.tentDesktop.rpc("task.startSession", {
      workspaceId,
      taskPath: built.payload.taskPath,
      profileId: built.payload.profileId,
      callerKind: built.payload.callerKind
    });
    const sid = result.session?.sessionId;
    const st = result.session?.state || result.task?.state || "";
    el.status.textContent = sid ? `\u5DF2\u542F\u52A8 agent \xB7 ${sid}${st ? `\uFF08${sessionStateLabel(st) || st}\uFF09` : ""}` : `\u5DF2\u542F\u52A8 agent \xB7 ${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
    await reloadTasks().catch(() => void 0);
  }
}
async function onInterrupt(taskPath) {
  if (!workspaceId) return;
  try {
    await window.tentDesktop.rpc("task.interrupt", {
      workspaceId,
      taskPath
    });
    el.status.textContent = `\u5DF2\u4E2D\u65AD\uFF1A${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}
async function onAccept(taskPath) {
  if (!workspaceId) return;
  const payload = buildAcceptPayload(taskPath, "user");
  try {
    await window.tentDesktop.rpc("task.accept", {
      workspaceId,
      taskPath: payload.taskPath,
      actor: payload.actor
    });
    el.status.textContent = `\u5DF2\u786E\u8BA4\u4EA4\u4ED8\uFF1A${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}
async function onReject(taskPath) {
  if (!workspaceId) return;
  const reason = rejectDrafts.get(taskPath) || "";
  const built = buildRejectPayload(taskPath, reason, "user");
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    await window.tentDesktop.rpc("task.reject", {
      workspaceId,
      taskPath: built.payload.taskPath,
      actor: built.payload.actor,
      note: built.payload.note,
      resume: built.payload.resume
    });
    el.status.textContent = `\u5DF2\u9A73\u56DE\uFF1A${taskPath}`;
    rejectDrafts.delete(taskPath);
    await Promise.all([reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}
async function loadCards() {
  const snap = await window.tentDesktop.getFloatingStatus();
  const cards = snap.recentCards || [];
  if (!cards.length) {
    el.cards.innerHTML = "";
    return;
  }
  el.cards.innerHTML = cards.map(
    (c, i) => `<li class="card-item" draggable="true" data-card-idx="${i}" title="${escapeHtml(c.kind)}/${escapeHtml(c.refId)}">
        <div><strong>${escapeHtml(c.label)}</strong></div>
      </li>`
  ).join("");
  el.cards.querySelectorAll("[data-card-idx]").forEach((node) => {
    const idx = Number(node.getAttribute("data-card-idx"));
    const card = cards[idx];
    if (!card?.text) return;
    bindContextCardDrag(node, card.text, {
      onCopied: () => {
        el.status.textContent = "\u5DF2\u590D\u5236";
      },
      onCopyError: (err) => setError(err)
    });
  });
}
async function onOpenWorkspace() {
  const folder = await window.tentDesktop.pickWorkspaceFolder();
  if (!folder) return;
  try {
    await window.tentDesktop.mountWorkspace(folder);
    await refresh();
  } catch (err) {
    setError(err);
  }
}
async function onCreateNote() {
  if (!workspaceId) {
    el.status.textContent = "\u8BF7\u5148\u6302\u8F7D\u5DE5\u4F5C\u533A\u3002";
    return;
  }
  const name = `note-${Date.now().toString(36).slice(-4)}`;
  try {
    const created = await window.tentDesktop.rpc("docs.createNote", {
      workspaceId,
      name,
      type: "note"
    });
    await reloadTree();
    await openConcept(created.id);
  } catch (err) {
    setError(err);
  }
}
async function onCreateCoordBox() {
  if (!workspaceId) {
    el.status.textContent = "\u8BF7\u5148\u6302\u8F7D\u5DE5\u4F5C\u533A\u3002";
    return;
  }
  const typeName = createTypePick || pickDefaultCoordinationType(coordinationTypes);
  if (!typeName) {
    el.status.textContent = "\u5F53\u524D types \u6CE8\u518C\u8868\u6CA1\u6709\u53EF\u534F\u8C03\u7684\u4E00\u7EA7\u7C7B\u578B\u3002";
    return;
  }
  const name = suggestBoxName(typeName);
  try {
    const created = await window.tentDesktop.rpc("docs.createNote", {
      workspaceId,
      name,
      type: typeName
    });
    el.status.textContent = `\u5DF2\u65B0\u5EFA\u534F\u4F5C\u6846\u300C${name}\u300D\uFF08${created.type || typeName}\uFF09`;
    await reloadTree();
    await openConcept(created.id);
  } catch (err) {
    setError(err);
  }
}
async function onSearch() {
  if (!workspaceId) return;
  const q = el.searchInput.value.trim();
  if (!q) {
    el.searchHits.innerHTML = "";
    return;
  }
  try {
    const result = await window.tentDesktop.rpc("docs.search", {
      workspaceId,
      query: q
    });
    const hits = result.hits || [];
    el.searchHits.innerHTML = hits.map(
      (h) => `<li class="card-item" data-open="${escapeHtml(h.cx)}"><strong>${escapeHtml(h.name)}</strong>
           <div class="muted">${escapeHtml(h.match)} \xB7 ${escapeHtml(h.snippet)}</div></li>`
    ).join("");
    el.searchHits.querySelectorAll("[data-open]").forEach((n) => {
      n.addEventListener("click", () => void openConcept(n.getAttribute("data-open")));
    });
  } catch (err) {
    setError(err);
  }
}
async function onEmitCard() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.status.textContent = "\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u6982\u5FF5\u3002";
    return;
  }
  await window.tentDesktop.pushContextCard({
    kind: "box",
    id: tab.cx,
    path: tab.path,
    label: tab.name
  });
  await loadCards();
  el.status.textContent = "\u4E0A\u4E0B\u6587\u5361\u5DF2\u5C31\u7EEA \u2014 \u5DE6\u952E\u62D6\u5230\u5916\u90E8\u8F93\u5165\u6846\uFF08text/plain\uFF09\u3002";
}
function setError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  el.status.textContent = msg;
  el.status.title = msg;
}
void boot();
//# sourceMappingURL=main-ui.js.map
