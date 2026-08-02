// Server-rendered HTML shell for the Markdown workspace preview.
// Component boundaries mirror Desktop UI: tree / tabs / editor / search / backlinks.

import { escapeHtml } from "./render.js";
import type { WorkspaceSnapshot } from "./workspace-controller.js";
import type { WorkspaceController } from "./workspace-controller.js";

export function renderWorkspacePage(controller: WorkspaceController): string {
  const snap = controller.getSnapshot();
  const active = controller.getActiveTab();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tent · Markdown Node Workspace</title>
  <style>${SHELL_CSS}</style>
</head>
<body>
  <header class="topbar">
    <strong>Tent Markdown Workspace</strong>
    <span class="muted">B3 node tree · docs.* client · no workspace source tree</span>
    ${snap.statusMessage ? `<span class="status">${escapeHtml(snap.statusMessage)}</span>` : ""}
  </header>
  <div class="layout">
    <aside class="panel tree-panel">
      <div class="panel-head">
        <span>Nodes</span>
        <form class="inline" method="POST" action="/action">
          <input type="hidden" name="op" value="createNote" />
          <input name="name" placeholder="New note" required />
          <button type="submit">+</button>
        </form>
      </div>
      <form method="GET" action="/" class="search-form">
        <input name="q" value="${escapeHtml(snap.searchQuery)}" placeholder="Search title / body" />
        <button type="submit">Search</button>
      </form>
      ${renderSearchHits(snap)}
      <nav class="tree" aria-label="Node tree">${renderTree(snap.tree, snap.activeCx)}</nav>
    </aside>
    <main class="panel main-panel">
      ${renderTabs(snap)}
      ${active ? renderEditor(controller, active.nodeId) : `<div class="empty">Open a node from the tree.</div>`}
    </main>
    <aside class="panel side-panel">
      <div class="panel-head">Backlinks</div>
      ${renderBacklinks(snap)}
      ${active ? renderMeta(active) : ""}
    </aside>
  </div>
  <script>
    document.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const cx = el.getAttribute('data-open');
        window.location = '/?open=' + encodeURIComponent(cx);
      });
    });
  </script>
</body>
</html>`;
}

function renderTree(nodes: WorkspaceSnapshot["tree"], activeCx: string | null, depth = 0): string {
  if (!nodes.length) return depth === 0 ? `<p class="muted">No nodes</p>` : "";
  const items = nodes
    .map((n) => {
      const usable = !n.invalid && !n.archived;
      const badge = usable
        ? `<span class="badge node">${escapeHtml(n.type)}</span>`
        : `<span class="badge note">${n.archived ? "archived" : "invalid"}</span>`;
      const active = n.nodeId === activeCx ? " active" : "";
      const kids = n.children?.length ? renderTree(n.children, activeCx, depth + 1) : "";
      return `<li class="tree-node${active}">
        <a href="/?open=${encodeURIComponent(n.nodeId)}" data-open="${escapeHtml(n.nodeId)}">
          <span class="name">${escapeHtml(n.title || n.name)}</span>
          <span class="type">${escapeHtml(n.type)}</span>
          ${badge}
        </a>
        ${kids ? `<ul>${kids}</ul>` : ""}
      </li>`;
    })
    .join("");
  return depth === 0 ? `<ul>${items}</ul>` : items;
}

function renderSearchHits(snap: WorkspaceSnapshot): string {
  if (!snap.searchQuery || !snap.searchHits.length) return "";
  const items = snap.searchHits
    .map(
      (h) =>
        `<li><a href="/?open=${encodeURIComponent(h.nodeId)}">${escapeHtml(h.name)}</a>
         <span class="muted">${escapeHtml(h.match)} · ${escapeHtml(h.snippet)}</span></li>`
    )
    .join("");
  return `<div class="search-hits"><ul>${items}</ul></div>`;
}

function renderTabs(snap: WorkspaceSnapshot): string {
  if (!snap.tabs.length) return "";
  const tabs = snap.tabs
    .map((t) => {
      const active = t.nodeId === snap.activeCx ? " active" : "";
      const dirty = t.dirty ? " ·" : "";
      return `<a class="tab${active}" href="/?open=${encodeURIComponent(t.nodeId)}">${escapeHtml(t.name)}${dirty}</a>`;
    })
    .join("");
  return `<div class="tabs">${tabs}</div>`;
}

function renderEditor(controller: WorkspaceController, nodeId: string): string {
  const tab = controller.getSnapshot().tabs.find((t) => t.nodeId === nodeId);
  if (!tab) return "";
  const conflict = tab.conflict
    ? `<div class="conflict">
        <strong>Conflict</strong>: ${escapeHtml(tab.conflict.message)}
        <form method="POST" action="/action" class="inline">
          <input type="hidden" name="op" value="loadDisk" />
          <input type="hidden" name="nodeId" value="${escapeHtml(nodeId)}" />
          <button type="submit">Load disk</button>
        </form>
        <form method="POST" action="/action" class="inline">
          <input type="hidden" name="op" value="overwrite" />
          <input type="hidden" name="nodeId" value="${escapeHtml(nodeId)}" />
          <button type="submit">Keep mine / overwrite</button>
        </form>
      </div>`
    : "";

  const modeToggle = `
    <div class="toolbar">
      <form method="POST" action="/action" class="inline">
        <input type="hidden" name="op" value="setMode" />
        <input type="hidden" name="nodeId" value="${escapeHtml(nodeId)}" />
        <input type="hidden" name="mode" value="source" />
        <button type="submit" class="${tab.mode === "source" ? "active" : ""}">Source</button>
      </form>
      <form method="POST" action="/action" class="inline">
        <input type="hidden" name="op" value="setMode" />
        <input type="hidden" name="nodeId" value="${escapeHtml(nodeId)}" />
        <input type="hidden" name="mode" value="preview" />
        <button type="submit" class="${tab.mode === "preview" ? "active" : ""}">Preview</button>
      </form>
      <form method="POST" action="/action" class="inline">
        <input type="hidden" name="op" value="save" />
        <input type="hidden" name="nodeId" value="${escapeHtml(nodeId)}" />
        <button type="submit">Save</button>
      </form>
      <span class="muted">${tab.dirty ? "dirty" : "clean"} · etag ${escapeHtml(tab.etag.slice(0, 8))}</span>
    </div>`;

  const body =
    tab.mode === "preview"
      ? `<div class="preview">${controller.previewHtml(nodeId)}</div>`
      : `<form method="POST" action="/action" class="editor-form">
          <input type="hidden" name="op" value="updateAndSave" />
          <input type="hidden" name="nodeId" value="${escapeHtml(nodeId)}" />
          <textarea name="buffer" spellcheck="false">${escapeHtml(tab.buffer)}</textarea>
          <div class="toolbar"><button type="submit">Save</button></div>
        </form>`;

  return `${conflict}${modeToggle}${body}`;
}

function renderBacklinks(snap: WorkspaceSnapshot): string {
  if (!snap.backlinks.length) return `<p class="muted">No backlinks</p>`;
  return `<ul class="backlinks">${snap.backlinks
    .map(
      (b) =>
        `<li><a href="/?open=${encodeURIComponent(b.fromNodeId)}">${escapeHtml(b.fromName)}</a>
         <span class="muted">${escapeHtml(b.kind)} · ${escapeHtml(b.raw)}</span></li>`
    )
    .join("")}</ul>`;
}

function renderMeta(tab: NonNullable<ReturnType<WorkspaceController["getActiveTab"]>>): string {
  const artifacts =
    tab.artifactRefs?.length ?
      `<div class="panel-head">ArtifactRef</div>
       <ul>${tab.artifactRefs
         .map(
           (a) =>
             `<li class="artifact-chip" title="Open externally">${escapeHtml(a.kind)}: ${escapeHtml(a.label || a.target)}</li>`
         )
         .join("")}</ul>`
    : "";
  return `<div class="meta">
    <div class="panel-head">Meta</div>
    <dl>
      <dt>cx</dt><dd><code>${escapeHtml(tab.nodeId)}</code></dd>
      <dt>path</dt><dd>${escapeHtml(tab.path)}</dd>
      <dt>type</dt><dd>${escapeHtml(tab.type)}</dd>
    </dl>
    ${artifacts}
  </div>`;
}

const SHELL_CSS = `
:root {
  color-scheme: light dark;
  --bg: #0f1419;
  --panel: #1a222c;
  --border: #2c3a4a;
  --text: #e7eef7;
  --muted: #8b9bb0;
  --accent: #5b9fd4;
  --badge-node: #3d8b6e;
  --badge-note: #6b7280;
  --danger: #c45c5c;
  font-family: "Segoe UI", system-ui, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
.topbar {
  display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;
  padding: .6rem 1rem; border-bottom: 1px solid var(--border); background: var(--panel);
}
.muted { color: var(--muted); font-size: .85rem; }
.status { color: var(--accent); }
.layout { display: grid; grid-template-columns: 280px 1fr 240px; min-height: calc(100vh - 48px); }
.panel { border-right: 1px solid var(--border); min-height: 100%; }
.side-panel { border-right: none; border-left: 1px solid var(--border); padding: .75rem; }
.panel-head { font-weight: 600; margin: .75rem; display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
.tree-panel { overflow: auto; }
.tree ul { list-style: none; margin: 0; padding-left: .75rem; }
.tree > ul { padding: 0 .5rem 1rem; }
.tree-node a {
  display: flex; gap: .35rem; align-items: center; flex-wrap: wrap;
  padding: .25rem .4rem; border-radius: 4px; color: inherit; text-decoration: none;
}
.tree-node.active > a, .tree-node a:hover { background: #243041; }
.tree .type { color: var(--muted); font-size: .75rem; }
.badge { font-size: .65rem; padding: .1rem .35rem; border-radius: 999px; text-transform: uppercase; }
.badge.node { background: var(--badge-node); }
.badge.note { background: var(--badge-note); }
.search-form, .inline { display: flex; gap: .35rem; margin: 0 .75rem .5rem; }
input, textarea, button {
  background: #111820; color: var(--text); border: 1px solid var(--border); border-radius: 4px;
  padding: .35rem .5rem; font: inherit;
}
button { cursor: pointer; }
button.active, button:hover { border-color: var(--accent); }
.tabs { display: flex; gap: .25rem; padding: .5rem; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.tab { padding: .35rem .6rem; border-radius: 4px 4px 0 0; background: #151c25; color: inherit; text-decoration: none; }
.tab.active { background: var(--panel); border: 1px solid var(--border); border-bottom-color: var(--panel); }
.toolbar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; padding: .5rem .75rem; border-bottom: 1px solid var(--border); }
.editor-form { display: flex; flex-direction: column; height: calc(100vh - 140px); }
textarea {
  flex: 1; width: 100%; resize: none; border: none; border-radius: 0;
  padding: 1rem; font-family: ui-monospace, Consolas, monospace; font-size: .9rem; line-height: 1.45;
}
.preview { padding: 1rem 1.25rem; max-width: 52rem; line-height: 1.55; }
.preview h1,.preview h2,.preview h3 { margin-top: 1.2em; }
.preview code { background: #111820; padding: .1rem .3rem; border-radius: 3px; }
.preview pre { background: #111820; padding: .75rem; overflow: auto; border-radius: 6px; }
.preview a { color: var(--accent); }
.conflict { background: #3a2222; border: 1px solid var(--danger); margin: .75rem; padding: .75rem; border-radius: 6px; }
.empty { padding: 2rem; color: var(--muted); }
.backlinks, .search-hits ul, .meta ul { list-style: none; padding: 0 .25rem; margin: 0; }
.backlinks li, .search-hits li { margin-bottom: .5rem; font-size: .9rem; }
.meta dl { display: grid; grid-template-columns: auto 1fr; gap: .25rem .5rem; font-size: .85rem; }
.meta dt { color: var(--muted); }
.artifact-chip {
  display: inline-block; margin: .2rem 0; padding: .2rem .45rem;
  border: 1px dashed var(--border); border-radius: 4px; font-size: .8rem;
}
code { font-size: .8rem; }
@media (max-width: 960px) {
  .layout { grid-template-columns: 1fr; }
  .side-panel { border-left: none; border-top: 1px solid var(--border); }
}
`;
