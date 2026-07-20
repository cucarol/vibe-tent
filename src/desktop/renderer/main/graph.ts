// Graph secondary surface: local node projection + selected-node backlinks/links.
// No bulk graph RPC — see contract-gaps graph.bulk. Never fabricates edges.

import { escapeHtml } from "../../../markdown/render.js";
import { extractOutLinks } from "../../../markdown/links.js";
import {
  buildGraphSelectionView,
  findGraphNode,
  flattenGraphNodes,
  type GraphBacklink,
  type GraphNode,
  type GraphOutLink,
  type GraphSelectionView,
} from "../../workbench/graph-model.js";
import { el, setError } from "./elements.js";
import {
  activeCx,
  setActiveCx,
  tree,
  workspaceId,
} from "./state.js";

export type GraphHost = {
  /** Open concept in workbench when user drills in. */
  openConcept: (cx: string) => Promise<void>;
  /** Switch app surface (e.g. back to workbench after open). */
  goWorkbench: () => void;
};

let host: GraphHost | null = null;
let selectedId: string | null = null;
let loadGen = 0;
let selectionView: GraphSelectionView = buildGraphSelectionView({ node: null });
let loadState: "idle" | "loading" | "ready" | "error" = "idle";
let loadError: string | null = null;

export function bindGraphHost(h: GraphHost): void {
  host = h;
}

export function getGraphSelectedId(): string | null {
  return selectedId;
}

/** Call when entering graph surface or after tree refresh. */
export async function reloadGraph(): Promise<void> {
  const hostEl = el.graphHost;
  if (!hostEl) return;
  if (!workspaceId) {
    loadState = "idle";
    loadError = null;
    selectedId = null;
    selectionView = buildGraphSelectionView({ node: null });
    renderGraph();
    return;
  }
  loadState = "loading";
  loadError = null;
  renderGraph();

  // Prefer active workbench selection; else keep prior graph selection.
  if (activeCx) selectedId = activeCx;
  else if (selectedId && !findGraphNode(tree as GraphNode[], selectedId)) {
    selectedId = null;
  }
  if (!selectedId) {
    const flat = flattenGraphNodes(tree as GraphNode[]);
    selectedId = flat[0]?.id ?? null;
  }
  await loadSelection(selectedId);
}

async function loadSelection(cx: string | null): Promise<void> {
  const gen = ++loadGen;
  if (!workspaceId || !cx) {
    selectionView = buildGraphSelectionView({ node: null });
    loadState = "ready";
    renderGraph();
    return;
  }
  const node = findGraphNode(tree as GraphNode[], cx) || null;
  let backlinks: GraphBacklink[] = [];
  let outLinks: GraphOutLink[] = [];
  let backlinksError: string | null = null;
  let outLinksError: string | null = null;

  try {
    const bl = (await window.tentDesktop.rpc("docs.backlinks", {
      workspaceId,
      id: cx,
    })) as { backlinks?: GraphBacklink[] };
    if (gen !== loadGen) return;
    backlinks = bl.backlinks || [];
  } catch (err) {
    if (gen !== loadGen) return;
    backlinksError = err instanceof Error ? err.message : String(err);
  }

  // Outgoing links: docs.get body + extractOutLinks (no bulk graph).
  try {
    const got = (await window.tentDesktop.rpc("docs.get", {
      workspaceId,
      id: cx,
    })) as { concept?: { body?: string; bodyPreview?: string } };
    if (gen !== loadGen) return;
    const body = got.concept?.body ?? got.concept?.bodyPreview ?? "";
    if (body) {
      outLinks = extractOutLinks(body).map((l) => ({
        raw: l.raw,
        kind: l.kind,
        targetCx: l.targetCx,
        targetPath: l.targetPath,
        label: l.label,
      }));
    }
  } catch (err) {
    if (gen !== loadGen) return;
    outLinksError = err instanceof Error ? err.message : String(err);
  }

  selectionView = buildGraphSelectionView({
    node,
    backlinks,
    outLinks,
    backlinksError,
    outLinksError,
  });
  loadState = "ready";
  renderGraph();
}

export function renderGraph(): void {
  const hostEl = el.graphHost;
  if (!hostEl) return;

  if (!workspaceId) {
    hostEl.innerHTML = `<div class="empty empty-cta"><p class="empty-title">打开工作区</p></div>`;
    return;
  }

  if (loadState === "loading" && !selectionView.node && !tree.length) {
    hostEl.innerHTML = `<div class="empty"><p class="muted">加载中…</p></div>`;
    return;
  }

  if (loadState === "error" && loadError) {
    hostEl.innerHTML = `<div class="empty"><p class="empty-title">图谱不可用</p><p class="muted">${escapeHtml(loadError)}</p></div>`;
    return;
  }

  const flat = flattenGraphNodes(tree as GraphNode[]);
  if (!flat.length) {
    hostEl.innerHTML = `<div class="empty"><p class="empty-title">无节点</p></div>`;
    return;
  }

  const nodesHtml = flat
    .map((n) => {
      const active = n.id === selectedId ? " is-active" : "";
      const pad = 8 + n.depth * 14;
      const kind = n.coordination ? "协作" : n.type;
      return `<button type="button" class="graph-node${active}" data-graph-node="${escapeHtml(n.id)}" style="padding-left:${pad}px" title="${escapeHtml(n.path)}">
        <span class="graph-node-name">${escapeHtml(n.name)}</span>
        <span class="muted graph-node-kind">${escapeHtml(kind)}</span>
      </button>`;
    })
    .join("");

  const sel = selectionView;
  const title = sel.node
    ? escapeHtml(sel.node.name)
    : selectedId
      ? escapeHtml(selectedId)
      : "未选择";

  let edgesHtml = "";
  if (sel.backlinksError) {
    edgesHtml += `<p class="muted graph-err">反向链接：${escapeHtml(sel.backlinksError)}</p>`;
  } else if (!sel.backlinks.length) {
    edgesHtml += `<p class="muted">无反向链接</p>`;
  } else {
    edgesHtml += `<ul class="graph-edge-list" aria-label="反向链接">${sel.backlinks
      .map(
        (b) =>
          `<li><button type="button" class="linkish" data-graph-jump="${escapeHtml(b.fromCx)}">${escapeHtml(b.fromName || b.fromPath)}</button>
          <span class="faint">${escapeHtml(b.raw)}</span></li>`
      )
      .join("")}</ul>`;
  }

  let outHtml = "";
  if (sel.outLinksError) {
    outHtml = `<p class="muted graph-err">出链：${escapeHtml(sel.outLinksError)}</p>`;
  } else if (!sel.outLinks.length) {
    outHtml = `<p class="muted">无出链</p>`;
  } else {
    outHtml = `<ul class="graph-edge-list" aria-label="出链">${sel.outLinks
      .map((l) => {
        const label = l.label || l.targetPath || l.raw;
        const jump = l.targetCx
          ? ` data-graph-jump="${escapeHtml(l.targetCx)}"`
          : "";
        const tag = l.targetCx ? "button" : "span";
        const cls = l.targetCx ? " class=\"linkish\"" : " class=\"muted\"";
        return `<li><${tag} type="button"${cls}${jump}>${escapeHtml(label)}</${tag}>
          <span class="faint">${escapeHtml(l.kind)} · ${escapeHtml(l.raw)}</span></li>`;
      })
      .join("")}</ul>`;
  }

  const openBtn = sel.node
    ? `<button type="button" class="btn btn-secondary" id="btn-graph-open">在工作台打开</button>`
    : "";

  hostEl.innerHTML = `
    <div class="graph-layout">
      <aside class="graph-list-pane" aria-label="节点">
        <div class="surface-section-head">节点</div>
        <div class="graph-node-list">${nodesHtml}</div>
      </aside>
      <section class="graph-detail-pane" aria-label="关系">
        <div class="surface-section-head graph-detail-head">
          <span>${title}</span>
          ${openBtn}
        </div>
        <div class="graph-detail-body">
          <div class="graph-block">
            <div class="graph-block-title">反向链接</div>
            ${edgesHtml}
          </div>
          <div class="graph-block">
            <div class="graph-block-title">出链</div>
            ${outHtml}
          </div>
          <p class="faint graph-footnote">局部投影 · 无全局图谱 RPC</p>
        </div>
      </section>
    </div>`;

  hostEl.querySelectorAll<HTMLElement>("[data-graph-node]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-graph-node");
      if (!id || id === selectedId) return;
      selectedId = id;
      setActiveCx(id);
      void loadSelection(id);
    });
  });
  hostEl.querySelectorAll<HTMLElement>("[data-graph-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-graph-jump");
      if (!id) return;
      selectedId = id;
      setActiveCx(id);
      void loadSelection(id);
    });
  });
  document.getElementById("btn-graph-open")?.addEventListener("click", () => {
    if (!selectedId) return;
    void host?.openConcept(selectedId).then(() => host?.goWorkbench());
  });
}

export function onGraphTreeChanged(): void {
  // Re-render list; re-fetch selection if still present.
  if (!el.graphHost || el.graphHost.closest("[hidden]")) {
    // Surface not visible — light refresh of selection id only.
    if (selectedId && !findGraphNode(tree as GraphNode[], selectedId)) {
      selectedId = null;
    }
    return;
  }
  void reloadGraph().catch((err) => {
    setError(err);
    loadState = "error";
    loadError = err instanceof Error ? err.message : String(err);
    renderGraph();
  });
}
