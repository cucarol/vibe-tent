// Main workbench renderer — talks only to preload bridge → service.

import "./api-types.js";
import { renderMarkdownToHtml, escapeHtml } from "../../markdown/render.js";

type ConceptNode = {
  id: string;
  path: string;
  name: string;
  type: string;
  coordination: boolean;
  status?: string;
  assignee?: string;
  children?: ConceptNode[];
};

type TabView = {
  cx: string;
  path: string;
  name: string;
  type: string;
  coordination: boolean;
  etag: string;
  buffer: string;
  dirty: boolean;
  mode: "source" | "preview";
  frontmatter: Record<string, unknown>;
  artifactRefs?: Array<{ kind: string; target: string; label?: string }>;
};

type ShellState = {
  health: {
    status: string;
    pid?: number;
    version?: string;
    url?: string;
    workspaceCount?: number;
  };
  workspaces: Array<{
    workspaceId: string;
    workspaceRoot: string;
    tentName: string;
    foreground: boolean;
  }>;
  foregroundWorkspaceId: string | null;
  workspace: {
    tree: ConceptNode[];
    tabs: TabView[];
    activeCx: string | null;
    searchHits: Array<{ cx: string; name: string; snippet: string; match: string }>;
    statusMessage: string | null;
  } | null;
  tasks: Array<{ path: string; role: string; status: string; claims: string[] }>;
  statusMessage: string | null;
};

/** Local editor state mirrors WorkspaceController via service RPC (not core FS). */
const localTabs = new Map<string, TabView>();
let activeCx: string | null = null;
let tree: ConceptNode[] = [];
let state: ShellState | null = null;
let workspaceId: string | null = null;

const el = {
  health: document.getElementById("health-pill")!,
  wsSelect: document.getElementById("workspace-select") as HTMLSelectElement,
  status: document.getElementById("status-line")!,
  tree: document.getElementById("tree")!,
  tabs: document.getElementById("tabs")!,
  toolbar: document.getElementById("toolbar")!,
  editor: document.getElementById("editor-host")!,
  meta: document.getElementById("meta")!,
  tasks: document.getElementById("tasks")!,
  cards: document.getElementById("cards")!,
  searchInput: document.getElementById("search-input") as HTMLInputElement,
  searchHits: document.getElementById("search-hits")!,
};

async function boot(): Promise<void> {
  document.getElementById("btn-open-ws")!.addEventListener("click", onOpenWorkspace);
  document.getElementById("btn-refresh")!.addEventListener("click", () => void refresh());
  document.getElementById("btn-new-note")!.addEventListener("click", () => void onCreateNote());
  document.getElementById("btn-search")!.addEventListener("click", () => void onSearch());
  document.getElementById("btn-card")!.addEventListener("click", () => void onEmitCard());
  document.getElementById("btn-float")!.addEventListener("click", () => void window.tentDesktop.showFloat());
  el.wsSelect.addEventListener("change", () => {
    const id = el.wsSelect.value;
    if (id) {
      void window.tentDesktop.setForeground(id).then((s) => applyShell(s as ShellState));
    }
  });
  el.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void onSearch();
  });

  window.tentDesktop.onStateChanged((s) => applyShell(s as ShellState));
  await refresh();
}

async function refresh(): Promise<void> {
  const s = (await window.tentDesktop.getState()) as ShellState;
  applyShell(s);
  if (workspaceId) {
    await reloadTree();
  }
}

function applyShell(s: ShellState): void {
  state = s;
  const ok = s.health.status === "ok";
  el.health.className = `pill ${ok ? "ok" : "off"}`;
  el.health.textContent = ok
    ? `service ok · pid ${s.health.pid ?? "?"} · ${s.health.version ?? ""}`
    : "service offline";

  el.wsSelect.innerHTML = "";
  for (const w of s.workspaces) {
    const opt = document.createElement("option");
    opt.value = w.workspaceId;
    opt.textContent = `${w.tentName} — ${w.workspaceRoot}`;
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

async function reloadTree(): Promise<void> {
  if (!workspaceId) return;
  const result = (await window.tentDesktop.rpc("docs.list", { workspaceId })) as {
    concepts: ConceptNode[];
  };
  tree = result.concepts || [];
  renderTree();
}

function renderTree(): void {
  el.tree.innerHTML = tree.length ? renderNodes(tree) : `<li class="muted">No concepts</li>`;
  el.tree.querySelectorAll<HTMLElement>("[data-open]").forEach((node) => {
    node.addEventListener("click", () => void openConcept(node.getAttribute("data-open")!));
  });
}

function renderNodes(nodes: ConceptNode[]): string {
  return nodes
    .map((n) => {
      const badge = n.coordination
        ? `<span class="badge box">${escapeHtml(n.status || "box")}</span>`
        : `<span class="badge note">note</span>`;
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
    })
    .join("");
}

async function openConcept(cx: string): Promise<void> {
  if (!workspaceId) return;
  const edit = (await window.tentDesktop.rpc("docs.readForEdit", {
    workspaceId,
    id: cx,
  })) as {
    id: string;
    path: string;
    name?: string;
    type?: string;
    coordination?: boolean;
    body: string;
    raw?: string;
    etag: string;
    frontmatter: Record<string, unknown>;
    artifactRefs?: TabView["artifactRefs"];
  };

  const existing = localTabs.get(edit.id);
  if (existing?.dirty) {
    activeCx = edit.id;
    renderAll();
    el.status.textContent = "Tab has unsaved changes.";
    return;
  }

  const tab: TabView = {
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
    artifactRefs: edit.artifactRefs,
  };
  localTabs.set(tab.cx, tab);
  activeCx = tab.cx;
  renderAll();
}

function reconstruct(fm: Record<string, unknown>, body: string): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm || {})) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---");
  lines.push(body.endsWith("\n") || body === "" ? body : body + "\n");
  return lines.join("\n");
}

function renderAll(): void {
  renderTabs();
  renderToolbar();
  renderEditor();
  renderMeta();
  renderTree();
}

function renderTabs(): void {
  const tabs = [...localTabs.values()];
  el.tabs.innerHTML = tabs
    .map((t) => {
      const active = t.cx === activeCx ? " active" : "";
      return `<button type="button" class="tab${active}" data-tab="${escapeHtml(t.cx)}">${escapeHtml(t.name)}${t.dirty ? " ·" : ""}</button>`;
    })
    .join("");
  el.tabs.querySelectorAll<HTMLElement>("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeCx = btn.getAttribute("data-tab");
      renderAll();
    });
  });
}

function renderToolbar(): void {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.toolbar.innerHTML = "";
    return;
  }
  el.toolbar.innerHTML = `
    <button type="button" data-act="source" class="${tab.mode === "source" ? "active" : ""}">Source</button>
    <button type="button" data-act="preview" class="${tab.mode === "preview" ? "active" : ""}">Preview</button>
    <button type="button" data-act="save" class="primary">Save</button>
    ${!tab.coordination ? `<button type="button" data-act="promote">Promote → goal</button>` : ""}
    <button type="button" data-act="card">Context Card</button>
    <span class="muted">${tab.dirty ? "dirty" : "clean"} · ${escapeHtml(tab.cx)}</span>
  `;
  el.toolbar.querySelectorAll<HTMLElement>("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => void onToolbar(btn.getAttribute("data-act")!));
  });
}

async function onToolbar(act: string): Promise<void> {
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
      toType: "goal",
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
      label: tab.name,
    });
    await loadCards();
  }
}

async function saveTab(tab: TabView): Promise<void> {
  try {
    const result = (await window.tentDesktop.rpc("docs.write", {
      workspaceId,
      id: tab.cx,
      baseEtag: tab.etag,
      raw: tab.buffer,
    })) as { etag: string };
    tab.etag = result.etag;
    tab.dirty = false;
    el.status.textContent = "Saved.";
    await reloadTree();
    renderAll();
  } catch (err) {
    el.status.textContent = err instanceof Error ? err.message : String(err);
  }
}

function renderEditor(): void {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.editor.innerHTML =
      '<div class="empty">Open a workspace with an in-workspace Tent (.tent), then select a concept.</div>';
    return;
  }
  if (tab.mode === "preview") {
    const body = splitBody(tab.buffer);
    el.editor.innerHTML = `<div class="preview">${renderMarkdownToHtml(body, {
      resolveWikiHref: (raw) => `#open=${encodeURIComponent(raw)}`,
      artifactRefs: tab.artifactRefs as never,
    })}</div>`;
    return;
  }
  el.editor.innerHTML = `<textarea class="editor" id="buffer" spellcheck="false"></textarea>`;
  const ta = document.getElementById("buffer") as HTMLTextAreaElement;
  ta.value = tab.buffer;
  ta.addEventListener("input", () => {
    tab.buffer = ta.value;
    tab.dirty = true;
    renderTabs();
    renderToolbar();
  });
}

function splitBody(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return raw;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return raw;
  const after = text.indexOf("\n", end + 1);
  return after === -1 ? "" : text.slice(after + 1);
}

function renderMeta(): void {
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

function renderTasks(tasks: ShellState["tasks"]): void {
  if (!tasks.length) {
    el.tasks.innerHTML = `<li class="muted">No tasks</li>`;
    return;
  }
  el.tasks.innerHTML = tasks
    .map(
      (t) => `<li class="task-item">
        <div><strong>${escapeHtml(t.status)}</strong> · ${escapeHtml(t.role)}</div>
        <div class="muted">${escapeHtml(t.path)}</div>
        <div class="muted">claims: ${escapeHtml((t.claims || []).join(", "))}</div>
      </li>`
    )
    .join("");
}

async function loadCards(): Promise<void> {
  const snap = await window.tentDesktop.getFloatingStatus();
  const cards = snap.recentCards || [];
  if (!cards.length) {
    el.cards.innerHTML = `<li class="muted">None yet — select a box and emit</li>`;
    return;
  }
  el.cards.innerHTML = cards
    .map(
      (c, i) => `<li class="card-item" draggable="true" data-card-idx="${i}">
        <div><strong>${escapeHtml(c.label)}</strong></div>
        <div class="muted">${escapeHtml(c.kind)}/${escapeHtml(c.refId)}</div>
      </li>`
    )
    .join("");
  el.cards.querySelectorAll<HTMLElement>("[data-card-idx]").forEach((node) => {
    const idx = Number(node.getAttribute("data-card-idx"));
    const card = cards[idx];
    node.addEventListener("dragstart", (ev) => {
      ev.dataTransfer?.setData("text/plain", card.text);
      void window.tentDesktop.startDrag(card.text);
    });
  });
}

async function onOpenWorkspace(): Promise<void> {
  const folder = await window.tentDesktop.pickWorkspaceFolder();
  if (!folder) return;
  try {
    await window.tentDesktop.mountWorkspace(folder);
    await refresh();
  } catch (err) {
    el.status.textContent = err instanceof Error ? err.message : String(err);
  }
}

async function onCreateNote(): Promise<void> {
  if (!workspaceId) {
    el.status.textContent = "Mount a workspace first.";
    return;
  }
  const name = `note-${Date.now().toString(36).slice(-4)}`;
  const created = (await window.tentDesktop.rpc("docs.createNote", {
    workspaceId,
    name,
    type: "note",
  })) as { id: string };
  await reloadTree();
  await openConcept(created.id);
}

async function onSearch(): Promise<void> {
  if (!workspaceId) return;
  const q = el.searchInput.value.trim();
  if (!q) {
    el.searchHits.innerHTML = "";
    return;
  }
  const result = (await window.tentDesktop.rpc("docs.search", {
    workspaceId,
    query: q,
  })) as { hits: Array<{ cx: string; name: string; snippet: string; match: string }> };
  const hits = result.hits || [];
  el.searchHits.innerHTML = hits
    .map(
      (h) =>
        `<li class="card-item" data-open="${escapeHtml(h.cx)}"><strong>${escapeHtml(h.name)}</strong>
         <div class="muted">${escapeHtml(h.match)} · ${escapeHtml(h.snippet)}</div></li>`
    )
    .join("");
  el.searchHits.querySelectorAll<HTMLElement>("[data-open]").forEach((n) => {
    n.addEventListener("click", () => void openConcept(n.getAttribute("data-open")!));
  });
}

async function onEmitCard(): Promise<void> {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.status.textContent = "Open a concept first.";
    return;
  }
  await window.tentDesktop.pushContextCard({
    kind: "box",
    id: tab.cx,
    path: tab.path,
    label: tab.name,
  });
  await loadCards();
  el.status.textContent = "Context Card ready — drag from the list.";
}

void boot();
