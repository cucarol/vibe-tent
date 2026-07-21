// Node tree + create-type rail (left pane content).

import { escapeHtml } from "../../../markdown/render.js";
import {
  pickDefaultCoordinationType,
  suggestBoxName,
} from "../../workbench/collaboration-ui.js";
import { el, setError } from "./elements.js";
import {
  activeCx,
  coordinationTypes,
  createTypePick,
  setCreateTypePick,
  tree,
  workspaceId,
  reloadTree,
} from "./state.js";
import type { ConceptNode } from "./types.js";
import { UI, treeRowClass } from "./ui.js";

export type TreeHost = {
  openConcept: (cx: string) => Promise<void>;
};

let host: TreeHost | null = null;

export function bindTreeHost(h: TreeHost): void {
  host = h;
}

export function renderCreateTypeSelect(): void {
  const selected = createTypePick || pickDefaultCoordinationType(coordinationTypes) || "";
  setCreateTypePick(selected);
  if (!coordinationTypes.length) {
    el.createType.innerHTML = `<option value="">无可协调类型</option>`;
    el.createType.disabled = true;
    el.btnNewBox.disabled = true;
    el.btnNewBox.title = "当前 types 注册表没有 coordination=true 的一级类型";
    return;
  }
  el.createType.disabled = false;
  el.btnNewBox.disabled = false;
  el.btnNewBox.title = "使用所选可协调类型新建协作框";
  el.createType.innerHTML = coordinationTypes
    .map(
      (t) =>
        `<option value="${escapeHtml(t.name)}"${t.name === selected ? " selected" : ""}>${escapeHtml(t.name)}</option>`
    )
    .join("");
}

export function renderTree(): void {
  el.tree.setAttribute("role", "tree");
  el.tree.innerHTML = tree.length ? renderNodes(tree) : `<li class="muted">暂无概念</li>`;
  el.tree.querySelectorAll<HTMLElement>("[data-open]").forEach((node) => {
    const open = () => void host?.openConcept(node.getAttribute("data-open")!);
    node.addEventListener("click", open);
    node.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        open();
      }
    });
  });
}

function nodeStatusMark(status?: string): string {
  // 仅对进行中 / 待处理显示极弱标记；完成与普通节点默认无状态字
  if (!status) return "";
  const s = status.toLowerCase();
  if (s === "done" || s === "completed" || s === "accepted" || s === "closed") return "";
  if (s === "doing" || s === "running" || s === "in_progress" || s === "active") {
    return `<span class="status-mark is-doing" title="${escapeHtml(status)}" aria-hidden="true"></span>`;
  }
  if (s === "todo" || s === "pending" || s === "queued" || s === "open") {
    return `<span class="status-mark is-todo" title="${escapeHtml(status)}" aria-hidden="true"></span>`;
  }
  // 其它协调状态：细点，不显示英文胶囊
  return `<span class="status-mark" title="${escapeHtml(status)}" aria-hidden="true"></span>`;
}

function renderNodes(nodes: ConceptNode[]): string {
  return nodes
    .map((n) => {
      const mark = n.coordination ? nodeStatusMark(n.status) : "";
      const rowClass = treeRowClass({
        active: n.id === activeCx,
        archived: n.mode === "archived",
      });
      const kids = n.children?.length ? `<ul>${renderNodes(n.children)}</ul>` : "";
      return `<li>
        <div class="${rowClass}" role="treeitem" tabindex="0" data-open="${escapeHtml(n.id)}" title="${escapeHtml(n.id)} · ${escapeHtml(n.type)} · ${escapeHtml(n.mode || "editable")}">
          <span class="${UI.treeName}">${escapeHtml(n.name)}</span>
          <span class="${UI.treeMeta}">${mark}</span>
        </div>
        ${kids}
      </li>`;
    })
    .join("");
}

export async function onCreateNote(): Promise<void> {
  if (!workspaceId) {
    el.status.textContent = "请先挂载工作区。";
    return;
  }
  const name = `note-${Date.now().toString(36).slice(-4)}`;
  try {
    const created = (await window.tentDesktop.rpc("docs.createNote", {
      workspaceId,
      name,
      type: "note",
    })) as { id: string };
    await reloadTree();
    await host?.openConcept(created.id);
  } catch (err) {
    setError(err);
  }
}

export async function onCreateCoordBox(): Promise<void> {
  if (!workspaceId) {
    el.status.textContent = "请先挂载工作区。";
    return;
  }
  const typeName = createTypePick || pickDefaultCoordinationType(coordinationTypes);
  if (!typeName) {
    el.status.textContent = "当前 types 注册表没有可协调的一级类型。";
    return;
  }
  const name = suggestBoxName(typeName);
  try {
    const created = (await window.tentDesktop.rpc("docs.createNote", {
      workspaceId,
      name,
      type: typeName,
    })) as { id: string; type?: string };
    el.status.textContent = `已新建协作框「${name}」（${created.type || typeName}）`;
    await reloadTree();
    await host?.openConcept(created.id);
  } catch (err) {
    setError(err);
  }
}

export async function onSearch(): Promise<void> {
  if (!workspaceId) return;
  const q = el.searchInput.value.trim();
  if (!q) {
    el.searchHits.innerHTML = "";
    return;
  }
  try {
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
      n.addEventListener("click", () => void host?.openConcept(n.getAttribute("data-open")!));
    });
  } catch (err) {
    setError(err);
  }
}
