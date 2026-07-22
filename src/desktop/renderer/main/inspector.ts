// Node inspector: meta, rename, mode, box.projection, backlinks; section open defaults.

import { escapeHtml } from "../../../markdown/render.js";
import {
  boxProjectionSummaryLine,
  boxStatusLabel,
} from "../../workbench/box-projection.js";
import { closeOpenTab } from "../../workbench/open-tabs.js";
import { el, setError } from "./elements.js";
import {
  activeBacklinks,
  activeBacklinksError,
  activeCx,
  actionableTasks,
  boxProjectionFor,
  localTabs,
  pendingInteractionCount,
  reloadTree,
  setActiveCx,
  workspaceId,
} from "./state.js";
import type { TabView } from "./types.js";
import { UI, btnHtml } from "./ui.js";

export type InspectorHost = {
  renderAll: () => void;
  openConcept?: (cx: string) => Promise<void>;
};

let host: InspectorHost | null = null;

export function bindInspectorHost(h: InspectorHost): void {
  host = h;
}

/** Inspector: empty sections stay collapsed; only open what needs attention. */
export function syncInspectorSections(): void {
  const hasTasks = actionableTasks().length > 0 || pendingInteractionCount() > 0;
  const tab = activeCx ? localTabs.get(activeCx) : null;
  const canDispatch = !!(tab && tab.coordination);
  if (!el.secPending || !el.secDispatch || !el.secCards) return;
  // 不与用户折叠状态抢权；仅在全部收起时按需默认打开一项
  const anyOpen =
    el.secPending.open ||
    el.secDispatch.open ||
    el.secCards.open ||
    !!(el.secBacklinks && el.secBacklinks.open);
  if (anyOpen) return;
  if (hasTasks) el.secPending.open = true;
  else if (canDispatch) el.secDispatch.open = true;
  // 否则保持全收起，不展开空说明
}

export function renderMeta(): void {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.meta.innerHTML = `<span class="muted">未选择</span>`;
    el.meta.classList.add("muted");
    return;
  }
  el.meta.classList.remove("muted");
  // 标题 + 最多一行关键属性；类型/路径/id 收进详情折叠
  // 协作 status/assignee 只来自 box.projection（不读 frontmatter）
  const proj = tab.coordination ? boxProjectionFor(tab.cx) : null;
  const modeLabel =
    tab.nodeMode === "read-only" ? "仅可读" : tab.nodeMode === "archived" ? "封存" : "开放";
  const collabLine = boxProjectionSummaryLine(proj);
  const oneLine = tab.coordination
    ? collabLine
      ? `${escapeHtml(tab.type)} · 协作 · ${escapeHtml(collabLine)} · ${modeLabel}`
      : `${escapeHtml(tab.type)} · 协作 · ${modeLabel}`
    : `${escapeHtml(tab.type)} · ${modeLabel}`;
  const renameDisabled = tab.nodeMode === "archived";
  const projDl =
    tab.coordination && proj
      ? `<dt>状态</dt><dd>${escapeHtml(boxStatusLabel(proj.status))}</dd>
        <dt>经办</dt><dd>${proj.assignee ? escapeHtml(proj.assignee) : "—"}</dd>
        <dt>任务</dt><dd>${
          proj.activeTaskId
            ? `<code title="${escapeHtml(proj.activeTaskId)}">${escapeHtml(proj.activeTaskId)}</code>`
            : "—"
        }</dd>`
      : tab.coordination
        ? `<dt>状态</dt><dd class="muted">投影未加载</dd>`
        : "";
  el.meta.innerHTML = `
    <div class="meta-name">${escapeHtml(tab.name)}</div>
    <div class="meta-line muted">${oneLine}</div>
    <div class="meta-controls">
      <label class="sr-only" for="node-display-name">名称</label>
      <input id="node-display-name" class="${UI.field}" value="${escapeHtml(tab.name)}"${renameDisabled ? " disabled" : ""} />
      ${btnHtml({
        label: "重命名",
        variant: "secondary",
        id: "btn-rename-node",
        title: renameDisabled ? "封存节点不可重命名" : "仅改显示名（docs.rename；id 不可改）",
        disabled: renameDisabled,
      })}
    </div>
    <div class="meta-controls">
      <label for="node-mode">访问</label>
      <select id="node-mode" class="${UI.fieldCompact}">
        <option value="editable"${tab.nodeMode === "editable" ? " selected" : ""}>开放</option>
        <option value="read-only"${tab.nodeMode === "read-only" ? " selected" : ""}>仅可读</option>
        <option value="archived"${tab.nodeMode === "archived" ? " selected" : ""}>封存</option>
      </select>
      ${btnHtml({ label: "应用", variant: "secondary", id: "btn-apply-node-mode" })}
    </div>
    <details class="meta-details">
      <summary>详情</summary>
      <dl>
        <dt>类型</dt><dd>${escapeHtml(tab.type)}${tab.coordination ? " · 协作" : ""}</dd>
        <dt>路径</dt><dd title="${escapeHtml(tab.path)}">${escapeHtml(tab.path)}</dd>
        <dt>标识</dt><dd><code title="不可变 id">${escapeHtml(tab.cx)}</code></dd>
        ${projDl}
      </dl>
    </details>`;
  document.getElementById("btn-rename-node")?.addEventListener("click", () => void onRenameNode());
  document.getElementById("btn-apply-node-mode")?.addEventListener("click", () => void onSetNodeMode());
}

/** Right-rail backlinks list (docs.backlinks) — never injects into document body. */
export function renderBacklinks(): void {
  const hostEl = el.backlinks;
  if (!hostEl) return;
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    hostEl.innerHTML = `<div class="muted">未选择</div>`;
    return;
  }
  if (activeBacklinksError) {
    hostEl.innerHTML = `<div class="muted">反向链接加载失败：${escapeHtml(activeBacklinksError)}</div>`;
    return;
  }
  if (!activeBacklinks.length) {
    hostEl.innerHTML = `<div class="muted">暂无反向链接</div>`;
    return;
  }
  hostEl.innerHTML = `<ul class="card-list backlink-list" aria-label="反向链接">${activeBacklinks
    .map(
      (h) =>
        `<li class="card-item" data-open="${escapeHtml(h.cx)}" role="button" tabindex="0">
          <strong>${escapeHtml(h.name)}</strong>
          ${
            h.context
              ? `<div class="muted">${escapeHtml(h.context)}</div>`
              : h.path
                ? `<div class="muted">${escapeHtml(h.path)}</div>`
                : ""
          }
        </li>`
    )
    .join("")}</ul>`;
  hostEl.querySelectorAll<HTMLElement>("[data-open]").forEach((node) => {
    const open = () => void host?.openConcept?.(node.getAttribute("data-open")!);
    node.addEventListener("click", open);
    node.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        open();
      }
    });
  });
}

async function onRenameNode(): Promise<void> {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  const input = document.getElementById("node-display-name") as HTMLInputElement | null;
  const newName = input?.value.trim() || "";
  if (!tab || !workspaceId || !newName || newName === tab.name) return;
  try {
    const result = (await window.tentDesktop.rpc("docs.rename", {
      workspaceId,
      id: tab.cx,
      newName,
      actor: "user",
    })) as { name: string; path: string };
    tab.name = result.name;
    tab.path = result.path;
    el.status.textContent = `已重命名为「${result.name}」`;
    await reloadTree();
    host?.renderAll();
  } catch (err) {
    setError(err);
  }
}

async function onSetNodeMode(): Promise<void> {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  const select = document.getElementById("node-mode") as HTMLSelectElement | null;
  const mode = select?.value as TabView["nodeMode"] | undefined;
  if (!tab || !workspaceId || !mode || mode === tab.nodeMode) return;
  if (tab.dirty) {
    el.status.textContent = "请先保存或撤销当前修改，再切换 Node 访问模式。";
    return;
  }
  if (mode === "archived" && !window.confirm(`封存「${tab.name}」及其子树？`)) return;
  try {
    await window.tentDesktop.rpc("docs.setMode", { workspaceId, id: tab.cx, mode });
    tab.nodeMode = mode;
    el.status.textContent = mode === "archived" ? `已封存「${tab.name}」` : "访问模式已更新";
    if (mode === "archived") {
      // Same neighbor preference as user tab-close (left, else right).
      const order = [...localTabs.keys()];
      const result = closeOpenTab(order, tab.cx, activeCx);
      localTabs.delete(tab.cx);
      setActiveCx(result.activeCx);
    }
    await reloadTree();
    host?.renderAll();
  } catch (err) {
    setError(err);
  }
}
