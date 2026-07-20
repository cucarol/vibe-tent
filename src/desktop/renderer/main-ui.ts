// Main workbench renderer — talks only to preload bridge → service.
// Componentized: shell wires domains; state owns RPC adapters; secondary surfaces
// (graph / activity / settings) extend without collapsing back into one file.

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
import { el, setError, syncActivityBadge } from "./main/elements.js";
import { renderMeta, syncInspectorSections, bindInspectorHost } from "./main/inspector.js";
import { bindChromeMenus, bindLayoutChrome } from "./main/layout.js";
import {
  bindStateHost,
  deliveries,
  pendingInteractionCount,
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
  actionableTasks,
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
import { bindShellHost, bindSurfaceNav, getSurface, setSurface, type AppSurface } from "./main/shell.js";
import { bindGraphHost, onGraphTreeChanged, reloadGraph, renderGraph } from "./main/graph.js";
import { bindActivityHost, renderActivity } from "./main/activity.js";
import { reloadSettings, renderSettings } from "./main/settings.js";

function updateActivityChrome(): void {
  const n =
    pendingInteractionCount() +
    actionableTasks().filter((t) => t.canAcceptOrReject).length;
  syncActivityBadge(n);
}

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
  updateActivityChrome();
  // Keep secondary surfaces coherent when data reloads while they are open.
  const surface = getSurface();
  if (surface === "activity") renderActivity();
  if (surface === "graph") renderGraph();
}

bindStateHost({
  renderTree,
  renderCreateTypeSelect,
  renderDispatchPanel,
  renderTasks: () => {
    renderTasks();
    updateActivityChrome();
    if (getSurface() === "activity") renderActivity();
  },
  renderTaskInput,
  renderSessions,
  renderPendingInteractions: () => {
    renderPendingInteractions();
    updateActivityChrome();
    if (getSurface() === "activity") renderActivity();
  },
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
bindShellHost({
  onSurfaceChange: (surface) => {
    void onSurfaceEnter(surface);
  },
});
bindGraphHost({
  openConcept,
  goWorkbench: () => setSurface("workbench"),
});
bindActivityHost({
  goWorkbench: () => setSurface("workbench"),
});

async function onSurfaceEnter(surface: AppSurface): Promise<void> {
  if (surface === "graph") {
    await reloadGraph().catch((err) => setError(err));
  } else if (surface === "activity") {
    renderActivity();
  } else if (surface === "settings") {
    await reloadSettings().catch((err) => setError(err));
  }
}

async function boot(): Promise<void> {
  bindLayoutChrome();
  bindChromeMenus();
  bindSurfaceNav();
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
    onGraphTreeChanged();
  } else {
    await reloadProfiles();
  }
  updateActivityChrome();
  const surface = getSurface();
  if (surface !== "workbench") await onSurfaceEnter(surface);
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
  updateActivityChrome();
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
