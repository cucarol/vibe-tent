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
    default:
      return s || "\u672A\u77E5";
  }
}
function buildTaskReviewItems(tasks, deliveries2 = []) {
  const byId = /* @__PURE__ */ new Map();
  const byTaskId = /* @__PURE__ */ new Map();
  for (const d of deliveries2) {
    byId.set(d.id, d);
    const list = byTaskId.get(d.taskId) ?? [];
    list.push(d);
    byTaskId.set(d.taskId, list);
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
    const commits = delivery?.commits ?? [];
    const deliverySummary = delivery?.summary;
    const label = taskStateLabel(state2, task.status);
    const promptBit = task.prompt ? truncate(task.prompt, 48) : "";
    const summaryLine = [
      label,
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
      deliverySummary,
      commits,
      canAcceptOrReject: state2 === "delivered",
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
var createTypePick = "";
var dispatchRole = "";
var dispatchPrompt = "";
var rejectDrafts = /* @__PURE__ */ new Map();
var el = {
  health: document.getElementById("health-pill"),
  wsSelect: document.getElementById("workspace-select"),
  status: document.getElementById("status-line"),
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
  btnNewBox: document.getElementById("btn-new-box")
};
async function boot() {
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
    await Promise.all([reloadTree(), reloadRegistry(), reloadTasks()]);
  }
}
function applyShell(s) {
  state = s;
  const ok = s.health.status === "ok";
  el.health.className = `pill ${ok ? "ok" : "off"}`;
  el.health.textContent = ok ? `\u670D\u52A1\u6B63\u5E38 \xB7 pid ${s.health.pid ?? "?"} \xB7 ${s.health.version ?? ""}` : "\u670D\u52A1\u79BB\u7EBF";
  el.wsSelect.innerHTML = "";
  for (const w of s.workspaces) {
    const opt = document.createElement("option");
    opt.value = w.workspaceId;
    opt.textContent = `${w.tentName} \u2014 ${w.workspaceRoot}`;
    if (w.foreground || w.workspaceId === s.foregroundWorkspaceId) opt.selected = true;
    el.wsSelect.appendChild(opt);
  }
  workspaceId = s.foregroundWorkspaceId;
  el.status.textContent = s.statusMessage || s.workspace?.statusMessage || "";
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
        manifest: ""
      })),
      deliveries
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
    const [taskResult, deliveryResult] = await Promise.all([
      window.tentDesktop.rpc("task.list", { workspaceId }),
      window.tentDesktop.rpc("delivery.list", { workspaceId })
    ]);
    deliveries = deliveryResult.deliveries || [];
    taskReview = buildTaskReviewItems(taskResult.tasks || [], deliveries);
    renderTasks();
  } catch (err) {
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
function renderNodes(nodes) {
  return nodes.map((n) => {
    const badge = n.coordination ? `<span class="badge box">${escapeHtml(n.status || "\u6846")}</span>` : `<span class="badge note">\u7B14\u8BB0</span>`;
    const active = n.id === activeCx ? " active" : "";
    const kids = n.children?.length ? `<ul>${renderNodes(n.children)}</ul>` : "";
    return `<li>
        <div class="tree-node${active}" data-open="${escapeHtml(n.id)}">
          <span>${escapeHtml(n.name)}</span>
          <span class="type">${escapeHtml(n.type)}</span>
          ${badge}
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
  el.toolbar.innerHTML = `
    <button type="button" data-act="source" class="${tab.mode === "source" ? "active" : ""}">\u6E90\u7801</button>
    <button type="button" data-act="preview" class="${tab.mode === "preview" ? "active" : ""}">\u9884\u89C8</button>
    <button type="button" data-act="save" class="primary">\u4FDD\u5B58</button>
    ${!tab.coordination ? `<button type="button" data-act="promote">\u63D0\u5347\u4E3A ${escapeHtml(promoteTarget)}</button>` : ""}
    <button type="button" data-act="card">\u4E0A\u4E0B\u6587\u5361</button>
    <span class="muted">${tab.dirty ? "\u672A\u4FDD\u5B58" : "\u5DF2\u4FDD\u5B58"} \xB7 ${escapeHtml(tab.cx)}</span>
  `;
  el.toolbar.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => void onToolbar(btn.getAttribute("data-act")));
  });
}
async function onToolbar(act) {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) return;
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
    el.status.textContent = "\u5DF2\u4FDD\u5B58\u3002";
    await reloadTree();
    renderAll();
  } catch (err) {
    setError(err);
  }
}
function renderEditor() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.editor.innerHTML = '<div class="empty">\u6253\u5F00\u5E26\u6709\u5E10\uFF08.tent\uFF09\u7684\u5DE5\u4F5C\u533A\uFF0C\u518D\u9009\u4E00\u4E2A\u6982\u5FF5\u3002</div>';
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
    return;
  }
  el.meta.innerHTML = `<dl>
    <dt>\u6807\u8BC6</dt><dd><code>${escapeHtml(tab.cx)}</code></dd>
    <dt>\u8DEF\u5F84</dt><dd>${escapeHtml(tab.path)}</dd>
    <dt>\u7C7B\u578B</dt><dd>${escapeHtml(tab.type)}</dd>
    <dt>\u534F\u4F5C\u6846</dt><dd>${tab.coordination ? "\u662F" : "\u5426"}</dd>
  </dl>`;
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
        <button type="button" class="primary" id="btn-dispatch"${validation.ok ? "" : " disabled"}>\u6D3E\u6D3B</button>
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
  if (!taskReview.length) {
    el.tasks.innerHTML = `<li class="muted">\u6682\u65E0\u4EFB\u52A1</li>`;
    return;
  }
  el.tasks.innerHTML = taskReview.map((t) => {
    const commits = t.commits.length > 0 ? `<div class="muted">commits\uFF1A${escapeHtml(t.commits.map((c) => c.slice(0, 8)).join(", "))}</div>` : "";
    const summary = t.deliverySummary ? `<div class="task-summary">${escapeHtml(t.deliverySummary)}</div>` : t.prompt ? `<div class="muted">prompt\uFF1A${escapeHtml(t.prompt)}</div>` : "";
    const rejectDraft = rejectDrafts.get(t.path) || "";
    const actions = t.canAcceptOrReject ? `<div class="task-actions">
            <button type="button" class="primary" data-accept="${escapeHtml(t.path)}">\u786E\u8BA4\u4EA4\u4ED8</button>
            <div class="reject-inline">
              <input type="text" data-reject-reason="${escapeHtml(t.path)}" placeholder="\u9A73\u56DE\u539F\u56E0" value="${escapeHtml(rejectDraft)}" />
              <button type="button" data-reject="${escapeHtml(t.path)}">\u9A73\u56DE</button>
            </div>
          </div>` : "";
    return `<li class="task-item" data-task="${escapeHtml(t.path)}">
        <div><strong>${escapeHtml(t.summaryLine.split(" \xB7 ")[0] || t.state)}</strong> \xB7 ${escapeHtml(t.role)}</div>
        <div class="muted">${escapeHtml(t.path)}</div>
        <div class="muted">\u8BA4\u9886\uFF1A${escapeHtml((t.claims || []).filter((c) => c !== "root").join(", ") || "\u2014")}</div>
        ${summary}
        ${commits}
        ${actions}
      </li>`;
  }).join("");
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
    el.cards.innerHTML = `<li class="muted">\u6682\u65E0 \u2014 \u9009\u4E2D\u6846\u540E\u53D1\u51FA</li>`;
    return;
  }
  el.cards.innerHTML = cards.map(
    (c, i) => `<li class="card-item" draggable="true" data-card-idx="${i}">
        <div><strong>${escapeHtml(c.label)}</strong></div>
        <div class="muted">${escapeHtml(c.kind)}/${escapeHtml(c.refId)}</div>
      </li>`
  ).join("");
  el.cards.querySelectorAll("[data-card-idx]").forEach((node) => {
    const idx = Number(node.getAttribute("data-card-idx"));
    const card = cards[idx];
    node.addEventListener("dragstart", (ev) => {
      ev.dataTransfer?.setData("text/plain", card.text);
      void window.tentDesktop.startDrag(card.text);
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
  el.status.textContent = "\u4E0A\u4E0B\u6587\u5361\u5DF2\u5C31\u7EEA \u2014 \u53EF\u4ECE\u5217\u8868\u62D6\u51FA\u3002";
}
function setError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  el.status.textContent = msg;
  el.status.title = msg;
}
void boot();
//# sourceMappingURL=main-ui.js.map
