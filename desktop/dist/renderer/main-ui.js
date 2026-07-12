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

// src/desktop/renderer/main-ui.ts
var localTabs = /* @__PURE__ */ new Map();
var activeCx = null;
var tree = [];
var state = null;
var workspaceId = null;
var el = {
  health: document.getElementById("health-pill"),
  wsSelect: document.getElementById("workspace-select"),
  status: document.getElementById("status-line"),
  tree: document.getElementById("tree"),
  tabs: document.getElementById("tabs"),
  toolbar: document.getElementById("toolbar"),
  editor: document.getElementById("editor-host"),
  meta: document.getElementById("meta"),
  tasks: document.getElementById("tasks"),
  cards: document.getElementById("cards"),
  searchInput: document.getElementById("search-input"),
  searchHits: document.getElementById("search-hits")
};
async function boot() {
  document.getElementById("btn-open-ws").addEventListener("click", onOpenWorkspace);
  document.getElementById("btn-refresh").addEventListener("click", () => void refresh());
  document.getElementById("btn-new-note").addEventListener("click", () => void onCreateNote());
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
    await reloadTree();
  }
}
function applyShell(s) {
  state = s;
  const ok = s.health.status === "ok";
  el.health.className = `pill ${ok ? "ok" : "off"}`;
  el.health.textContent = ok ? `service ok \xB7 pid ${s.health.pid ?? "?"} \xB7 ${s.health.version ?? ""}` : "service offline";
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
  renderTasks(s.tasks || []);
  void loadCards();
}
async function reloadTree() {
  if (!workspaceId) return;
  const result = await window.tentDesktop.rpc("docs.list", { workspaceId });
  tree = result.concepts || [];
  renderTree();
}
function renderTree() {
  el.tree.innerHTML = tree.length ? renderNodes(tree) : `<li class="muted">No concepts</li>`;
  el.tree.querySelectorAll("[data-open]").forEach((node) => {
    node.addEventListener("click", () => void openConcept(node.getAttribute("data-open")));
  });
}
function renderNodes(nodes) {
  return nodes.map((n) => {
    const badge = n.coordination ? `<span class="badge box">${escapeHtml(n.status || "box")}</span>` : `<span class="badge note">note</span>`;
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
    el.status.textContent = "Tab has unsaved changes.";
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
  el.toolbar.innerHTML = `
    <button type="button" data-act="source" class="${tab.mode === "source" ? "active" : ""}">Source</button>
    <button type="button" data-act="preview" class="${tab.mode === "preview" ? "active" : ""}">Preview</button>
    <button type="button" data-act="save" class="primary">Save</button>
    ${!tab.coordination ? `<button type="button" data-act="promote">Promote \u2192 goal</button>` : ""}
    <button type="button" data-act="card">Context Card</button>
    <span class="muted">${tab.dirty ? "dirty" : "clean"} \xB7 ${escapeHtml(tab.cx)}</span>
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
    await window.tentDesktop.rpc("docs.promote", {
      workspaceId,
      id: tab.cx,
      toType: "goal"
    });
    el.status.textContent = "Promoted to goal";
    await openConcept(tab.cx);
    await reloadTree();
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
    el.status.textContent = "Saved.";
    await reloadTree();
    renderAll();
  } catch (err) {
    el.status.textContent = err instanceof Error ? err.message : String(err);
  }
}
function renderEditor() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.editor.innerHTML = '<div class="empty">Open a workspace with an in-workspace Tent (.tent), then select a concept.</div>';
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
    el.meta.innerHTML = `<span class="muted">No selection</span>`;
    return;
  }
  el.meta.innerHTML = `<dl>
    <dt>cx</dt><dd><code>${escapeHtml(tab.cx)}</code></dd>
    <dt>path</dt><dd>${escapeHtml(tab.path)}</dd>
    <dt>type</dt><dd>${escapeHtml(tab.type)}</dd>
    <dt>coordination</dt><dd>${tab.coordination ? "true" : "false"}</dd>
  </dl>`;
}
function renderTasks(tasks) {
  if (!tasks.length) {
    el.tasks.innerHTML = `<li class="muted">No tasks</li>`;
    return;
  }
  el.tasks.innerHTML = tasks.map(
    (t) => `<li class="task-item">
        <div><strong>${escapeHtml(t.status)}</strong> \xB7 ${escapeHtml(t.role)}</div>
        <div class="muted">${escapeHtml(t.path)}</div>
        <div class="muted">claims: ${escapeHtml((t.claims || []).join(", "))}</div>
      </li>`
  ).join("");
}
async function loadCards() {
  const snap = await window.tentDesktop.getFloatingStatus();
  const cards = snap.recentCards || [];
  if (!cards.length) {
    el.cards.innerHTML = `<li class="muted">None yet \u2014 select a box and emit</li>`;
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
    el.status.textContent = err instanceof Error ? err.message : String(err);
  }
}
async function onCreateNote() {
  if (!workspaceId) {
    el.status.textContent = "Mount a workspace first.";
    return;
  }
  const name = `note-${Date.now().toString(36).slice(-4)}`;
  const created = await window.tentDesktop.rpc("docs.createNote", {
    workspaceId,
    name,
    type: "note"
  });
  await reloadTree();
  await openConcept(created.id);
}
async function onSearch() {
  if (!workspaceId) return;
  const q = el.searchInput.value.trim();
  if (!q) {
    el.searchHits.innerHTML = "";
    return;
  }
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
}
async function onEmitCard() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.status.textContent = "Open a concept first.";
    return;
  }
  await window.tentDesktop.pushContextCard({
    kind: "box",
    id: tab.cx,
    path: tab.path,
    label: tab.name
  });
  await loadCards();
  el.status.textContent = "Context Card ready \u2014 drag from the list.";
}
void boot();
//# sourceMappingURL=main-ui.js.map
