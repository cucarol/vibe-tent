// Document workspace: tabs, toolbar, source/preview editor.

import { renderMarkdownToHtml, escapeHtml } from "../../../markdown/render.js";
import { pickDefaultCoordinationType } from "../../workbench/collaboration-ui.js";
import {
  closeOpenTab,
  documentEmptyCopy,
  isCloseTabShortcut,
} from "../../workbench/open-tabs.js";
import { ICO } from "./icons.js";
import { el, setError } from "./elements.js";
import {
  activeCx,
  coordinationTypes,
  findConcept,
  localTabs,
  reconstruct,
  reloadTree,
  setActiveCx,
  splitBody,
  tree,
  workspaceId,
} from "./state.js";
import type { TabView } from "./types.js";
import { btnHtml, documentTabHtml, iconBtnHtml } from "./ui.js";

export type DocumentHost = {
  renderAll: () => void;
  renderTabs: () => void;
  renderToolbar: () => void;
  loadCards: () => Promise<void>;
};

let host: DocumentHost | null = null;
let documentChromeBound = false;

export function bindDocumentHost(h: DocumentHost): void {
  host = h;
  bindDocumentChrome();
}

/** Close button, middle-click, Ctrl/Cmd+W — once per renderer session. */
function bindDocumentChrome(): void {
  if (documentChromeBound) return;
  documentChromeBound = true;

  el.tabs.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement | null;
    const closeBtn = t?.closest<HTMLElement>("[data-close-tab]");
    if (closeBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      void closeTab(closeBtn.getAttribute("data-close-tab")!);
      return;
    }
    const tabBtn = t?.closest<HTMLElement>("[data-tab]");
    if (tabBtn && el.tabs.contains(tabBtn)) {
      setActiveCx(tabBtn.getAttribute("data-tab"));
      host?.renderAll();
      focusActiveTab();
    }
  });

  el.tabs.addEventListener("auxclick", (ev) => {
    if (ev.button !== 1) return;
    const t = ev.target as HTMLElement | null;
    const tabEl = t?.closest<HTMLElement>("[data-tab], [data-tab-wrap], [data-close-tab]");
    if (!tabEl || !el.tabs.contains(tabEl)) return;
    const cx =
      tabEl.getAttribute("data-close-tab") ||
      tabEl.getAttribute("data-tab") ||
      tabEl.getAttribute("data-tab-wrap");
    if (!cx) return;
    ev.preventDefault();
    void closeTab(cx);
  });

  // Middle-click often fires auto-scroll; block on tab strip.
  el.tabs.addEventListener("mousedown", (ev) => {
    if (
      ev.button === 1 &&
      (ev.target as HTMLElement | null)?.closest("[data-tab], [data-tab-wrap], [data-close-tab]")
    ) {
      ev.preventDefault();
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (!isCloseTabShortcut(ev)) return;
    if (!activeCx || !localTabs.has(activeCx)) return;
    // Only when workbench document chrome is relevant.
    const surface = document.getElementById("app-root")?.dataset.surface;
    if (surface && surface !== "workbench") return;
    ev.preventDefault();
    void closeTab(activeCx);
  });

  // Doc overflow menu: Escape + outside click (same exit contract as rail overflow).
  document.addEventListener("click", (ev) => {
    const t = ev.target as Node | null;
    if (!t) return;
    const wrap = el.toolbar.querySelector(".menu-wrap");
    if (wrap?.contains(t)) return;
    closeDocMoreMenu();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeDocMoreMenu();
  });
}

function closeDocMoreMenu(): void {
  const moreMenu = el.toolbar.querySelector<HTMLElement>("[data-doc-menu]");
  const moreBtn = el.toolbar.querySelector<HTMLButtonElement>("[data-doc-more]");
  if (moreMenu && !moreMenu.hidden) {
    moreMenu.hidden = true;
    moreBtn?.setAttribute("aria-expanded", "false");
  }
}

/**
 * Close a renderer-local tab. Does not delete/archive the Node.
 * Dirty tabs ask once before discarding the buffer.
 */
export async function closeTab(cx: string): Promise<boolean> {
  const tab = localTabs.get(cx);
  if (!tab) return false;
  if (tab.dirty) {
    const ok = window.confirm(`「${tab.name}」有未保存更改，关闭将丢弃修改。仍要关闭？`);
    if (!ok) return false;
  }
  const order = [...localTabs.keys()];
  const result = closeOpenTab(order, cx, activeCx);
  if (!result.closed) return false;
  localTabs.delete(cx);
  setActiveCx(result.activeCx);
  host?.renderAll();
  // Move focus to the new active tab, or the stage when empty.
  queueMicrotask(() => {
    if (result.activeCx) focusActiveTab();
    else {
      const stage = document.getElementById("main-panel");
      stage?.focus({ preventScroll: true });
    }
  });
  return true;
}

function focusActiveTab(): void {
  if (!activeCx) return;
  const safe =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(activeCx)
      : activeCx.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const btn = el.tabs.querySelector<HTMLElement>(`[data-tab="${safe}"]`);
  btn?.focus({ preventScroll: true });
}

export async function openConcept(cx: string): Promise<void> {
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
    mode?: "editable" | "read-only" | "archived";
    body: string;
    raw?: string;
    etag: string;
    frontmatter: Record<string, unknown>;
    artifactRefs?: TabView["artifactRefs"];
  };

  const existing = localTabs.get(edit.id);
  if (existing?.dirty) {
    setActiveCx(edit.id);
    host?.renderAll();
    el.status.textContent = "当前标签有未保存更改。";
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
    nodeMode: edit.mode || findConcept(tree, edit.id)?.mode || "editable",
    frontmatter: edit.frontmatter || {},
    artifactRefs: edit.artifactRefs,
  };
  localTabs.set(tab.cx, tab);
  setActiveCx(tab.cx);
  host?.renderAll();
}

export function renderTabs(): void {
  const tabs = [...localTabs.values()];
  el.tabs.setAttribute("role", "tablist");
  el.tabs.setAttribute("aria-label", "打开的文档");
  el.tabs.innerHTML = tabs
    .map((t) =>
      documentTabHtml({
        cx: t.cx,
        name: t.name,
        active: t.cx === activeCx,
        dirty: t.dirty,
        closeIcon: ICO.close,
      })
    )
    .join("");
}

export function renderToolbar(): void {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.toolbar.innerHTML = "";
    return;
  }
  const promoteTarget = pickDefaultCoordinationType(coordinationTypes) || "goal";
  const modeLabel = tab.mode === "preview" ? "预览" : "源码";
  const modeTitle = tab.mode === "preview" ? "切换到源码" : "切换到预览";
  // 克制工具组：模式图标 + dirty 时保存 + 更多；干净状态不提示「已保存」
  const modeIco = tab.mode === "preview" ? ICO.modePreview : ICO.modeSource;
  const saveBtn =
    tab.dirty && tab.nodeMode === "editable"
      ? btnHtml({
          label: "保存",
          variant: "primary",
          title: "保存",
          attrs: 'data-act="save"',
          extraClass: "btn-quiet-save",
        })
      : "";
  el.toolbar.innerHTML = `
    ${iconBtnHtml({
      icon: modeIco,
      title: modeTitle,
      ariaLabel: `${modeTitle}（${modeLabel}）`,
      extraClass: "mode-toggle",
      attrs: 'data-act="toggle-mode"',
    })}
    ${saveBtn}
    <div class="menu-wrap">
      ${iconBtnHtml({
        icon: ICO.more,
        title: "更多",
        ariaLabel: "文档更多操作",
        attrs: 'data-doc-more aria-haspopup="menu"',
      })}
      <div class="menu" data-doc-menu role="menu" hidden>
        <button type="button" class="menu-item" role="menuitem" data-act="source"${tab.mode === "source" ? " aria-current=\"true\"" : ""}>源码</button>
        <button type="button" class="menu-item" role="menuitem" data-act="preview"${tab.mode === "preview" ? " aria-current=\"true\"" : ""}>预览</button>
        <div class="menu-sep" role="separator"></div>
        <button type="button" class="menu-item" role="menuitem" data-act="card">发出上下文卡</button>
        <button type="button" class="menu-item" role="menuitem" data-act="fork" title="复制子树并重发 id">派生副本</button>
        ${
          tab.nodeMode === "editable"
            ? `<button type="button" class="menu-item" role="menuitem" data-act="attach">导入附件…</button>`
            : ""
        }
        ${
          !tab.coordination
            ? `<button type="button" class="menu-item" role="menuitem" data-act="promote" title="提升为 ${escapeHtml(promoteTarget)}">提升为协作框</button>`
            : ""
        }
      </div>
    </div>
  `;
  const moreBtn = el.toolbar.querySelector<HTMLButtonElement>("[data-doc-more]");
  const moreMenu = el.toolbar.querySelector<HTMLElement>("[data-doc-menu]");
  moreBtn?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!moreMenu) return;
    moreMenu.hidden = !moreMenu.hidden;
    moreBtn.setAttribute("aria-expanded", moreMenu.hidden ? "false" : "true");
  });
  el.toolbar.querySelectorAll<HTMLElement>("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (moreMenu) moreMenu.hidden = true;
      void onToolbar(btn.getAttribute("data-act")!);
    });
  });
}

async function onToolbar(act: string): Promise<void> {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) return;
  if (act === "toggle-mode") {
    tab.mode = tab.mode === "source" ? "preview" : "source";
    host?.renderAll();
    return;
  }
  if (act === "source" || act === "preview") {
    tab.mode = act;
    host?.renderAll();
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
        toType,
      });
      el.status.textContent = `已提升为 ${toType}`;
      await openConcept(tab.cx);
      await reloadTree();
    } catch (err) {
      setError(err);
    }
    return;
  }
  if (act === "fork") {
    if (tab.dirty) {
      el.status.textContent = "请先保存或撤销当前修改，再派生副本。";
      return;
    }
    try {
      const result = (await window.tentDesktop.rpc("docs.fork", {
        workspaceId,
        id: tab.cx,
      })) as { id?: string; cx?: string };
      const newId = result.id || result.cx;
      el.status.textContent = newId ? `已派生副本` : "已派生副本";
      await reloadTree();
      if (newId) await openConcept(newId);
    } catch (err) {
      setError(err);
    }
    return;
  }
  if (act === "attach") {
    await onImportAttachment(tab);
    return;
  }
  if (act === "card") {
    await window.tentDesktop.pushContextCard({
      kind: "box",
      id: tab.cx,
      path: tab.path,
      label: tab.name,
    });
    await host?.loadCards();
  }
}

/** Pick a local file, base64-encode, and store via docs.importAttachment (no secret echo). */
async function onImportAttachment(tab: TabView): Promise<void> {
  if (!workspaceId) return;
  if (tab.nodeMode !== "editable") {
    el.status.textContent = "当前 Node 不是开放模式，不能导入附件。";
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  document.body.appendChild(input);
  const file = await new Promise<File | null>((resolve) => {
    input.addEventListener(
      "change",
      () => {
        resolve(input.files?.[0] ?? null);
        input.remove();
      },
      { once: true }
    );
    input.addEventListener(
      "cancel",
      () => {
        resolve(null);
        input.remove();
      },
      { once: true }
    );
    input.click();
  });
  if (!file) return;
  try {
    const bytesBase64 = await fileToBase64(file);
    const result = (await window.tentDesktop.rpc("docs.importAttachment", {
      workspaceId,
      id: tab.cx,
      fileName: file.name,
      bytesBase64,
    })) as { markdown?: string; relativePath?: string };
    // Append markdown link into buffer when Service returns a snippet; user still saves.
    if (result.markdown) {
      const sep = tab.buffer.endsWith("\n") || tab.buffer.length === 0 ? "" : "\n";
      tab.buffer = `${tab.buffer}${sep}\n${result.markdown}\n`;
      tab.dirty = true;
      host?.renderAll();
    }
    el.status.textContent = result.relativePath
      ? `已导入附件 ${result.relativePath}（请保存正文）`
      : "附件已导入";
  } catch (err) {
    setError(err);
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.readAsDataURL(file);
  });
}

export async function saveTab(tab: TabView): Promise<void> {
  if (tab.nodeMode !== "editable") {
    el.status.textContent = "当前 Node 不是开放模式，不能保存正文。";
    return;
  }
  try {
    const result = (await window.tentDesktop.rpc("docs.write", {
      workspaceId,
      id: tab.cx,
      baseEtag: tab.etag,
      raw: tab.buffer,
    })) as { etag: string };
    tab.etag = result.etag;
    tab.dirty = false;
    // 干净状态不提示「已保存」
    el.status.textContent = "";
    await reloadTree();
    host?.renderAll();
  } catch (err) {
    setError(err);
  }
}

export function renderEditor(): void {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    const copy = documentEmptyCopy(!!workspaceId);
    const hint = copy.hint
      ? `<p class="empty-hint">${escapeHtml(copy.hint)}</p>`
      : "";
    el.editor.innerHTML = `<div class="empty empty-cta" tabindex="-1"><p class="empty-title">${escapeHtml(copy.title)}</p>${hint}</div>`;
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
  ta.readOnly = tab.nodeMode !== "editable";
  ta.setAttribute("aria-readonly", ta.readOnly ? "true" : "false");
  ta.addEventListener("input", () => {
    tab.buffer = ta.value;
    tab.dirty = true;
    host?.renderTabs();
    host?.renderToolbar();
  });
}
