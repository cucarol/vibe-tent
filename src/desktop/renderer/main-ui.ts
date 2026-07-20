// Main workbench renderer — talks only to preload bridge → service.
// Componentized pure refactor: shell wires domains; state owns RPC adapters.

import "./api-types.js";
import {
  buildTaskReviewItems,
} from "../workbench/collaboration-ui.js";
import {
  renderPendingInteractions,
  renderSessions,
  renderTaskInput,
  renderTasks,
  loadCards,
  onEmitCard,
} from "./main/collaboration.js";
import { openConcept, renderEditor, renderTabs, renderToolbar, bindDocumentHost } from "./main/document.js";
import { renderDispatchPanel, bindDispatchHost } from "./main/dispatch.js";
import { el, setError } from "./main/elements.js";
import { renderMeta, syncInspectorSections, bindInspectorHost } from "./main/inspector.js";
import { bindChromeMenus, bindLayoutChrome } from "./main/layout.js";
import {
  bindStateHost,
  deliveries,
  reloadPendingInteractions,
  reloadProfiles,
  reloadRegistry,
  reloadTasks,
  reloadTree,
  sessions,
  setCoordinationTypes,
  setProfiles,
  setRoles,
  setSelectedProfileId,
  setState,
  setTaskReview,
  setTree,
  setWorkspaceId,
  setCreateTypePick,
  workspaceId,
} from "./main/state.js";
import type { ShellState } from "./main/types.js";
import {
  bindTreeHost,
  onCreateCoordBox,
  onCreateNote,
  onSearch,
  renderCreateTypeSelect,
  renderTree,
} from "./main/tree.js";

function renderAll(): void {
  renderTabs();
  renderToolbar();
  renderEditor();
  renderMeta();
  renderDispatchPanel();
  renderPendingInteractions();
  renderTaskInput();
  renderSessions();
  renderTree();
  syncInspectorSections();
}

bindStateHost({
  renderTree,
  renderCreateTypeSelect,
  renderDispatchPanel,
  renderTasks,
  renderTaskInput,
  renderSessions,
  renderPendingInteractions,
});
bindTreeHost({ openConcept });
bindDocumentHost({
  renderAll,
  renderTabs,
  renderToolbar,
  loadCards,
});
bindInspectorHost({ renderAll });
bindDispatchHost({ renderDispatchPanel });

async function boot(): Promise<void> {
  bindLayoutChrome();
  bindChromeMenus();
  document.getElementById("btn-open-ws")!.addEventListener("click", onOpenWorkspace);
  document.getElementById("btn-refresh")!.addEventListener("click", () => void refresh());
  document.getElementById("btn-new-note")!.addEventListener("click", () => void onCreateNote());
  el.btnNewBox.addEventListener("click", () => void onCreateCoordBox());
  el.createType.addEventListener("change", () => {
    setCreateTypePick(el.createType.value);
  });
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

  window.tentDesktop.onStateChanged((s) => {
    applyShell(s as ShellState);
    if (workspaceId) void Promise.all([reloadPendingInteractions(), reloadTasks()]);
  });
  await refresh();
}

async function refresh(): Promise<void> {
  const s = (await window.tentDesktop.getState()) as ShellState;
  applyShell(s);
  if (workspaceId) {
    await Promise.all([
      reloadTree(),
      reloadRegistry(),
      reloadTasks(),
      reloadProfiles(),
      reloadPendingInteractions(),
    ]);
  } else {
    await reloadProfiles();
  }
}

function applyShell(s: ShellState): void {
  setState(s);
  const ok = s.health.status === "ok";
  el.health.className = `status-dot ${ok ? "ok" : "off"}`;
  el.health.textContent = "";
  el.health.setAttribute("aria-label", ok ? "服务在线" : "服务离线");
  el.health.title = ok
    ? `Local Service 正常 · pid ${s.health.pid ?? "?"} · ${s.health.version ?? ""}`
    : "Local Service 离线";

  el.wsSelect.innerHTML = "";
  for (const w of s.workspaces) {
    const opt = document.createElement("option");
    opt.value = w.workspaceId;
    // 常态只显示 displayName；完整路径仅 title/tooltip
    const label = (w.tentName || "").trim() || "工作区";
    opt.textContent = label;
    opt.title = w.workspaceRoot || w.workspaceId;
    if (w.foreground || w.workspaceId === s.foregroundWorkspaceId) opt.selected = true;
    el.wsSelect.appendChild(opt);
  }
  setWorkspaceId(s.foregroundWorkspaceId);
  // 状态线仅作 aria-live 错误/动作反馈，不展示常驻说明
  const live = s.statusMessage || s.workspace?.statusMessage || "";
  if (live) el.status.textContent = live;

  if (s.workspace?.tree?.length) {
    setTree(s.workspace.tree);
    renderTree();
  }

  if (s.coordinationTypes?.length) {
    setCoordinationTypes(s.coordinationTypes);
    renderCreateTypeSelect();
  }
  if (s.roles) {
    setRoles(s.roles);
  }
  if (s.profiles?.length) {
    setProfiles(s.profiles);
  }
  if (s.selectedProfileId !== undefined) {
    setSelectedProfileId(s.selectedProfileId);
  }
  if (s.taskReview?.length) {
    setTaskReview(s.taskReview);
  } else if (s.tasks?.length) {
    setTaskReview(
      buildTaskReviewItems(
        s.tasks.map((t) => ({
          path: t.path,
          id: t.id,
          role: t.role,
          claims: t.claims || [],
          status: (t.status === "taken" ? "taken" : "pending") as "pending" | "taken",
          state: t.state || t.status,
          prompt: t.prompt,
          activeDeliveryId: t.activeDeliveryId,
          sessionId: t.sessionId,
          manifest: "",
        })),
        deliveries,
        sessions
      )
    );
  } else {
    setTaskReview([]);
  }

  renderTasks();
  renderDispatchPanel();
  void loadCards();
}

async function onOpenWorkspace(): Promise<void> {
  const folder = await window.tentDesktop.pickWorkspaceFolder();
  if (!folder) return;
  try {
    await window.tentDesktop.mountWorkspace(folder);
    await refresh();
  } catch (err) {
    setError(err);
  }
}

void boot();
