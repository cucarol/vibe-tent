// Main workbench renderer — talks only to preload bridge → service.
// P0-1: collaboration closed loop — create box → dispatch → review accept/reject.

import "./api-types.js";
import { renderMarkdownToHtml, escapeHtml } from "../../markdown/render.js";
import type {
  AgentProfileProjection,
  DeliveryProjection,
  RoleRegistryEntryProjection,
  SessionProjection,
  TaskProjection,
  TypeRegistryEntryProjection,
} from "../../service/types.js";
import {
  buildAcceptPayload,
  buildRejectPayload,
  buildStartSessionPayload,
  buildTaskReviewItems,
  listCoordinationTypeOptions,
  listProfileOptions,
  listRoleOptions,
  pickDefaultCoordinationType,
  pickDefaultProfileId,
  sessionStateLabel,
  suggestBoxName,
  taskStateLabel,
  validateDispatchForm,
  type CoordinationTypeOption,
  type ProfileOption,
  type RoleOption,
  type TaskReviewItem,
} from "../workbench/collaboration-ui.js";
import {
  LAYOUT_BOUNDS,
  computeEffectiveLayout,
  loadLayoutPrefs,
  resizeSide,
  saveLayoutPrefs,
  stepResize,
  toggleCollapsed,
  type MainLayoutPrefs,
} from "../workbench/layout-prefs.js";
import { bindContextCardDrag } from "./context-card-drag.js";

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
  tasks: Array<{
    path: string;
    role: string;
    status: string;
    claims: string[];
    state?: string;
    id?: string;
    prompt?: string;
    activeDeliveryId?: string;
    sessionId?: string;
  }>;
  taskReview?: TaskReviewItem[];
  roles?: RoleOption[];
  coordinationTypes?: CoordinationTypeOption[];
  profiles?: ProfileOption[];
  selectedProfileId?: string | null;
  statusMessage: string | null;
};

/** Local editor state mirrors WorkspaceController via service RPC (not core FS). */
const localTabs = new Map<string, TabView>();
let activeCx: string | null = null;
let tree: ConceptNode[] = [];
let state: ShellState | null = null;
let workspaceId: string | null = null;

/** Cached registry projections for create/dispatch pickers. */
let coordinationTypes: CoordinationTypeOption[] = [];
let roles: RoleOption[] = [];
let taskReview: TaskReviewItem[] = [];
let deliveries: DeliveryProjection[] = [];
let sessions: SessionProjection[] = [];
/** Product profiles from profile.list (safe metadata; no secrets). */
let profiles: ProfileOption[] = [];
/** Selected machine-local profile for「启动 agent」— never auto-starts. */
let selectedProfileId: string | null = null;

/** Draft form state (pure UI). */
let createTypePick = "";
let dispatchRole = "";
let dispatchPrompt = "";
/** taskPath → inline reject reason draft */
const rejectDrafts = new Map<string, string>();

/** Renderer-local layout prefs (widths + collapse). */
let layoutPrefs: MainLayoutPrefs = loadLayoutPrefs(
  typeof localStorage !== "undefined" ? localStorage : null
);
let resizeSession: {
  side: "left" | "right";
  startX: number;
  startWidth: number;
} | null = null;

const el = {
  health: document.getElementById("health-pill")!,
  wsSelect: document.getElementById("workspace-select") as HTMLSelectElement,
  status: document.getElementById("status-line")!,
  layout: document.getElementById("main-layout")!,
  treePanel: document.getElementById("tree-panel")!,
  sidePanel: document.getElementById("side-panel")!,
  splitterLeft: document.getElementById("splitter-left")!,
  splitterRight: document.getElementById("splitter-right")!,
  btnCollapseLeft: document.getElementById("btn-collapse-left") as HTMLButtonElement | null,
  btnCollapseRight: document.getElementById("btn-collapse-right") as HTMLButtonElement | null,
  btnExpandLeft: document.getElementById("btn-expand-left") as HTMLButtonElement | null,
  btnExpandRight: document.getElementById("btn-expand-right") as HTMLButtonElement | null,
  taskCount: document.getElementById("task-count"),
  tree: document.getElementById("tree")!,
  tabs: document.getElementById("tabs")!,
  toolbar: document.getElementById("toolbar")!,
  editor: document.getElementById("editor-host")!,
  meta: document.getElementById("meta")!,
  dispatch: document.getElementById("dispatch-panel")!,
  tasks: document.getElementById("tasks")!,
  cards: document.getElementById("cards")!,
  searchInput: document.getElementById("search-input") as HTMLInputElement,
  searchHits: document.getElementById("search-hits")!,
  createType: document.getElementById("create-type") as HTMLSelectElement,
  btnNewBox: document.getElementById("btn-new-box") as HTMLButtonElement,
  searchDrawer: document.getElementById("search-drawer"),
  createDrawer: document.getElementById("create-drawer"),
  railOverflow: document.getElementById("rail-overflow"),
  btnToggleSearch: document.getElementById("btn-toggle-search") as HTMLButtonElement | null,
  btnToggleCreate: document.getElementById("btn-toggle-create") as HTMLButtonElement | null,
  btnRailMore: document.getElementById("btn-rail-more") as HTMLButtonElement | null,
  secPending: document.getElementById("sec-pending") as HTMLDetailsElement | null,
  secDispatch: document.getElementById("sec-dispatch") as HTMLDetailsElement | null,
  secCards: document.getElementById("sec-cards") as HTMLDetailsElement | null,
};

function layoutViewportWidth(): number {
  return el.layout?.clientWidth || window.innerWidth || 1200;
}

function persistLayout(): void {
  saveLayoutPrefs(typeof localStorage !== "undefined" ? localStorage : null, layoutPrefs);
}

function applyLayoutChrome(): void {
  if (!el.layout) return;
  const effective = computeEffectiveLayout(layoutPrefs, layoutViewportWidth());
  el.layout.style.setProperty("--layout-left-width", `${effective.leftWidth}px`);
  el.layout.style.setProperty("--layout-right-width", `${effective.rightWidth}px`);
  el.layout.classList.toggle("is-left-collapsed", effective.leftCollapsed);
  el.layout.classList.toggle("is-right-collapsed", effective.rightCollapsed);

  // Expand chips only for user-collapsed sides (not ephemeral auto-collapse).
  if (el.btnExpandLeft) {
    el.btnExpandLeft.hidden = !layoutPrefs.leftCollapsed;
  }
  if (el.btnExpandRight) {
    el.btnExpandRight.hidden = !layoutPrefs.rightCollapsed;
  }
  if (el.btnCollapseLeft) {
    el.btnCollapseLeft.hidden = layoutPrefs.leftCollapsed;
    el.btnCollapseLeft.setAttribute("aria-expanded", layoutPrefs.leftCollapsed ? "false" : "true");
  }
  if (el.btnCollapseRight) {
    el.btnCollapseRight.hidden = layoutPrefs.rightCollapsed;
    el.btnCollapseRight.setAttribute("aria-expanded", layoutPrefs.rightCollapsed ? "false" : "true");
  }

  // Splitter ARIA values describe the adjacent panel width.
  if (el.splitterLeft) {
    el.splitterLeft.setAttribute("aria-valuemin", String(LAYOUT_BOUNDS.leftMin));
    el.splitterLeft.setAttribute("aria-valuemax", String(LAYOUT_BOUNDS.leftMax));
    el.splitterLeft.setAttribute("aria-valuenow", String(effective.leftWidth));
    el.splitterLeft.tabIndex = effective.leftCollapsed ? -1 : 0;
  }
  if (el.splitterRight) {
    el.splitterRight.setAttribute("aria-valuemin", String(LAYOUT_BOUNDS.rightMin));
    el.splitterRight.setAttribute("aria-valuemax", String(LAYOUT_BOUNDS.rightMax));
    el.splitterRight.setAttribute("aria-valuenow", String(effective.rightWidth));
    el.splitterRight.tabIndex = effective.rightCollapsed ? -1 : 0;
  }
}

function setLayoutPrefs(next: MainLayoutPrefs, persist = true): void {
  layoutPrefs = next;
  applyLayoutChrome();
  if (persist) persistLayout();
}

function onToggleSide(side: "left" | "right"): void {
  setLayoutPrefs(toggleCollapsed(layoutPrefs, side));
}

function beginResize(side: "left" | "right", clientX: number): void {
  const width = side === "left" ? layoutPrefs.leftWidth : layoutPrefs.rightWidth;
  resizeSession = { side, startX: clientX, startWidth: width };
  document.body.classList.add("is-resizing");
  const splitter = side === "left" ? el.splitterLeft : el.splitterRight;
  splitter?.classList.add("is-active");
}

function onResizePointerMove(clientX: number): void {
  if (!resizeSession) return;
  const delta = clientX - resizeSession.startX;
  // Left grows with +x; right grows with -x (drag handle toward center shrinks panel).
  const nextWidth =
    resizeSession.side === "left"
      ? resizeSession.startWidth + delta
      : resizeSession.startWidth - delta;
  setLayoutPrefs(resizeSide(layoutPrefs, resizeSession.side, nextWidth, layoutViewportWidth()), false);
}

function endResize(): void {
  if (!resizeSession) return;
  resizeSession = null;
  document.body.classList.remove("is-resizing");
  el.splitterLeft?.classList.remove("is-active");
  el.splitterRight?.classList.remove("is-active");
  persistLayout();
  applyLayoutChrome();
}

function bindSplitter(side: "left" | "right", node: HTMLElement | null): void {
  if (!node) return;
  node.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    node.setPointerCapture?.(ev.pointerId);
    beginResize(side, ev.clientX);
  });
  node.addEventListener("pointermove", (ev) => {
    if (!resizeSession || resizeSession.side !== side) return;
    onResizePointerMove(ev.clientX);
  });
  node.addEventListener("pointerup", () => endResize());
  node.addEventListener("pointercancel", () => endResize());
  node.addEventListener("lostpointercapture", () => endResize());
  node.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      ev.preventDefault();
      const dir: -1 | 1 =
        side === "left"
          ? ev.key === "ArrowRight"
            ? 1
            : -1
          : ev.key === "ArrowLeft"
            ? 1
            : -1;
      setLayoutPrefs(stepResize(layoutPrefs, side, dir, layoutViewportWidth()));
    } else if (ev.key === "Home") {
      ev.preventDefault();
      const min = side === "left" ? LAYOUT_BOUNDS.leftMin : LAYOUT_BOUNDS.rightMin;
      setLayoutPrefs(resizeSide(layoutPrefs, side, min, layoutViewportWidth()));
    } else if (ev.key === "End") {
      ev.preventDefault();
      const max = side === "left" ? LAYOUT_BOUNDS.leftMax : LAYOUT_BOUNDS.rightMax;
      setLayoutPrefs(resizeSide(layoutPrefs, side, max, layoutViewportWidth()));
    } else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      onToggleSide(side);
    }
  });
  node.addEventListener("dblclick", () => onToggleSide(side));
}

function setDrawerOpen(
  drawer: HTMLElement | null,
  toggle: HTMLButtonElement | null,
  open: boolean
): void {
  if (!drawer) return;
  drawer.hidden = !open;
  if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function setMenuOpen(open: boolean): void {
  if (!el.railOverflow) return;
  el.railOverflow.hidden = !open;
  el.btnRailMore?.setAttribute("aria-expanded", open ? "true" : "false");
}

function closeChromePopovers(): void {
  setDrawerOpen(el.searchDrawer, el.btnToggleSearch, false);
  setDrawerOpen(el.createDrawer, el.btnToggleCreate, false);
  setMenuOpen(false);
}

function bindChromeMenus(): void {
  el.btnToggleSearch?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = !!el.searchDrawer?.hidden;
    setDrawerOpen(el.createDrawer, el.btnToggleCreate, false);
    setMenuOpen(false);
    setDrawerOpen(el.searchDrawer, el.btnToggleSearch, open);
    if (open) el.searchInput?.focus();
  });
  el.btnToggleCreate?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = !!el.createDrawer?.hidden;
    setDrawerOpen(el.searchDrawer, el.btnToggleSearch, false);
    setMenuOpen(false);
    setDrawerOpen(el.createDrawer, el.btnToggleCreate, open);
  });
  el.btnRailMore?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = !!el.railOverflow?.hidden;
    setDrawerOpen(el.searchDrawer, el.btnToggleSearch, false);
    setDrawerOpen(el.createDrawer, el.btnToggleCreate, false);
    setMenuOpen(open);
  });
  el.railOverflow?.addEventListener("click", (ev) => {
    // Keep menu open only until an item is chosen.
    const t = ev.target as HTMLElement | null;
    if (t?.closest(".menu-item")) setMenuOpen(false);
  });
  document.addEventListener("click", (ev) => {
    const t = ev.target as Node | null;
    if (!t) return;
    if (el.railOverflow?.contains(t) || el.btnRailMore?.contains(t)) return;
    if (el.searchDrawer?.contains(t) || el.btnToggleSearch?.contains(t)) return;
    if (el.createDrawer?.contains(t) || el.btnToggleCreate?.contains(t)) return;
    closeChromePopovers();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeChromePopovers();
  });
}

/** Inspector: only one secondary section open; prefer pending when tasks exist. */
function syncInspectorSections(): void {
  const hasTasks = taskReview.length > 0;
  const tab = activeCx ? localTabs.get(activeCx) : null;
  const canDispatch = !!(tab && tab.coordination);
  if (!el.secPending || !el.secDispatch || !el.secCards) return;
  // User may toggle details; only auto-pick when nothing is open.
  const anyOpen = el.secPending.open || el.secDispatch.open || el.secCards.open;
  if (anyOpen) return;
  if (hasTasks) el.secPending.open = true;
  else if (canDispatch) el.secDispatch.open = true;
  else el.secPending.open = true;
}

function bindLayoutChrome(): void {
  el.btnCollapseLeft?.addEventListener("click", () => onToggleSide("left"));
  el.btnCollapseRight?.addEventListener("click", () => onToggleSide("right"));
  el.btnExpandLeft?.addEventListener("click", () => {
    if (layoutPrefs.leftCollapsed) onToggleSide("left");
  });
  el.btnExpandRight?.addEventListener("click", () => {
    if (layoutPrefs.rightCollapsed) onToggleSide("right");
  });
  bindSplitter("left", el.splitterLeft);
  bindSplitter("right", el.splitterRight);
  window.addEventListener("resize", () => applyLayoutChrome());
  // Global fallback if pointer capture is lost mid-drag.
  window.addEventListener("pointerup", () => endResize());
  applyLayoutChrome();
}

async function boot(): Promise<void> {
  bindLayoutChrome();
  bindChromeMenus();
  document.getElementById("btn-open-ws")!.addEventListener("click", onOpenWorkspace);
  document.getElementById("btn-refresh")!.addEventListener("click", () => void refresh());
  document.getElementById("btn-new-note")!.addEventListener("click", () => void onCreateNote());
  el.btnNewBox.addEventListener("click", () => void onCreateCoordBox());
  el.createType.addEventListener("change", () => {
    createTypePick = el.createType.value;
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

  window.tentDesktop.onStateChanged((s) => applyShell(s as ShellState));
  await refresh();
}

async function refresh(): Promise<void> {
  const s = (await window.tentDesktop.getState()) as ShellState;
  applyShell(s);
  if (workspaceId) {
    await Promise.all([reloadTree(), reloadRegistry(), reloadTasks(), reloadProfiles()]);
  } else {
    await reloadProfiles();
  }
}

function applyShell(s: ShellState): void {
  state = s;
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

  if (s.coordinationTypes?.length) {
    coordinationTypes = s.coordinationTypes;
    renderCreateTypeSelect();
  }
  if (s.roles) {
    roles = s.roles;
  }
  if (s.profiles?.length) {
    profiles = s.profiles;
  }
  if (s.selectedProfileId !== undefined) {
    selectedProfileId = s.selectedProfileId;
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
        status: (t.status === "taken" ? "taken" : "pending") as "pending" | "taken",
        state: t.state || t.status,
        prompt: t.prompt,
        activeDeliveryId: t.activeDeliveryId,
        sessionId: t.sessionId,
        manifest: "",
      })),
      deliveries,
      sessions
    );
  } else {
    taskReview = [];
  }

  renderTasks();
  renderDispatchPanel();
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

async function reloadRegistry(): Promise<void> {
  if (!workspaceId) return;
  try {
    const [typesResult, rolesResult] = await Promise.all([
      window.tentDesktop.rpc("registry.types", { workspaceId }) as Promise<{
        types: TypeRegistryEntryProjection[];
      }>,
      window.tentDesktop.rpc("registry.roles", { workspaceId }) as Promise<{
        roles: RoleRegistryEntryProjection[];
      }>,
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

async function reloadTasks(): Promise<void> {
  if (!workspaceId) return;
  try {
    const [taskResult, deliveryResult, sessionResult] = await Promise.all([
      window.tentDesktop.rpc("task.list", { workspaceId }) as Promise<{ tasks: TaskProjection[] }>,
      window.tentDesktop.rpc("delivery.list", { workspaceId }) as Promise<{
        deliveries: DeliveryProjection[];
      }>,
      window.tentDesktop.rpc("session.list", { workspaceId }) as Promise<{
        sessions: SessionProjection[];
      }>,
    ]);
    deliveries = deliveryResult.deliveries || [];
    sessions = sessionResult.sessions || [];
    taskReview = buildTaskReviewItems(taskResult.tasks || [], deliveries, sessions);
    renderTasks();
  } catch (err) {
    setError(err);
  }
}

/** Load product profiles (testOnly hidden by service default). */
async function reloadProfiles(): Promise<void> {
  try {
    const result = (await window.tentDesktop.rpc("profile.list", {})) as {
      profiles: AgentProfileProjection[];
    };
    profiles = listProfileOptions(result.profiles || []);
    if (!selectedProfileId || !profiles.some((p) => p.id === selectedProfileId)) {
      selectedProfileId = pickDefaultProfileId(profiles);
    }
    renderTasks();
  } catch (err) {
    // Profiles are machine-local; show Chinese error when launch is attempted.
    profiles = [];
    selectedProfileId = null;
    setError(err);
  }
}

function renderCreateTypeSelect(): void {
  const prev = createTypePick || pickDefaultCoordinationType(coordinationTypes) || "";
  createTypePick = prev;
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
        `<option value="${escapeHtml(t.name)}"${t.name === createTypePick ? " selected" : ""}>${escapeHtml(t.name)}</option>`
    )
    .join("");
}

function renderTree(): void {
  el.tree.innerHTML = tree.length ? renderNodes(tree) : `<li class="muted">暂无概念</li>`;
  el.tree.querySelectorAll<HTMLElement>("[data-open]").forEach((node) => {
    node.addEventListener("click", () => void openConcept(node.getAttribute("data-open")!));
  });
}

function renderNodes(nodes: ConceptNode[]): string {
  return nodes
    .map((n) => {
      // displayName 主显示；type 等宽弱化；status 中性 badge，不抢 accent
      const status = n.coordination && n.status
        ? `<span class="badge box">${escapeHtml(n.status)}</span>`
        : n.coordination
          ? `<span class="badge box">框</span>`
          : "";
      const active = n.id === activeCx ? " active" : "";
      const kids = n.children?.length ? `<ul>${renderNodes(n.children)}</ul>` : "";
      return `<li>
        <div class="tree-node${active}" data-open="${escapeHtml(n.id)}" title="${escapeHtml(n.id)} · ${escapeHtml(n.type)}">
          <span class="tree-name">${escapeHtml(n.name)}</span>
          <span class="tree-meta">${status}</span>
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
  renderDispatchPanel();
  renderTree();
  syncInspectorSections();
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
  const promoteTarget = pickDefaultCoordinationType(coordinationTypes) || "goal";
  // 常驻：模式 segmented + 保存状态/动作；发卡/提升进 overflow
  el.toolbar.innerHTML = `
    <div class="segmented" role="group" aria-label="编辑模式">
      <button type="button" data-act="source" class="${tab.mode === "source" ? "active" : ""}">源码</button>
      <button type="button" data-act="preview" class="${tab.mode === "preview" ? "active" : ""}">预览</button>
    </div>
    <div class="save-state">
      <span class="state-label${tab.dirty ? " is-dirty" : ""}" title="${escapeHtml(tab.cx)}">${
        tab.dirty ? "未保存" : "已保存"
      }</span>
      <button type="button" data-act="save" class="btn btn-primary"${tab.dirty ? "" : " disabled"}>保存</button>
    </div>
    <div class="menu-wrap">
      <button type="button" class="icon-btn" data-doc-more title="更多" aria-label="文档更多操作" aria-haspopup="menu">⋯</button>
      <div class="menu" data-doc-menu role="menu" hidden>
        <button type="button" class="menu-item" role="menuitem" data-act="card">发出上下文卡</button>
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
    el.status.textContent = "已保存。";
    await reloadTree();
    renderAll();
  } catch (err) {
    setError(err);
  }
}

function renderEditor(): void {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.editor.innerHTML =
      '<div class="empty">打开带有帐（.tent）的工作区，再选一个概念。</div>';
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
    el.meta.innerHTML = `<span class="muted">未选择 Node</span>`;
    el.meta.classList.add("muted");
    return;
  }
  el.meta.classList.remove("muted");
  // 身份以 displayName 为主；cx- 等宽弱化
  el.meta.innerHTML = `
    <div class="meta-name">${escapeHtml(tab.name)}</div>
    <dl>
      <dt>类型</dt><dd>${escapeHtml(tab.type)}${tab.coordination ? " · 协作" : ""}</dd>
      <dt>路径</dt><dd>${escapeHtml(tab.path)}</dd>
      <dt>标识</dt><dd><code>${escapeHtml(tab.cx)}</code></dd>
    </dl>`;
}

function renderDispatchPanel(): void {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.dispatch.innerHTML = `<div class="muted dispatch-empty">选中协作框后可派活</div>`;
    return;
  }
  if (!tab.coordination) {
    el.dispatch.innerHTML = `<div class="muted dispatch-empty">「${escapeHtml(tab.name)}」不可协调（普通笔记）。请新建协作框或提升类型。</div>`;
    return;
  }

  const roleOpts =
    roles.length > 0
      ? roles
          .map(
            (r) =>
              `<option value="${escapeHtml(r.name)}"${r.name === dispatchRole ? " selected" : ""}>${escapeHtml(r.name)}</option>`
          )
          .join("")
      : `<option value="">（无 role）</option>`;

  const validation = validateDispatchForm({
    boxId: tab.cx,
    coordination: tab.coordination,
    role: dispatchRole,
    prompt: dispatchPrompt,
    roles,
  });

  el.dispatch.innerHTML = `
    <div class="dispatch-form">
      <div class="field-row">
        <label for="dispatch-role">目标 role</label>
        <select id="dispatch-role"${roles.length ? "" : " disabled"}>${roleOpts}</select>
      </div>
      <div class="field-row">
        <label for="dispatch-prompt">user prompt</label>
        <textarea id="dispatch-prompt" rows="3" placeholder="写给目标 role 的任务说明…">${escapeHtml(dispatchPrompt)}</textarea>
      </div>
      <div class="row dispatch-actions">
        <button type="button" class="btn btn-primary" id="btn-dispatch"${validation.ok ? "" : " disabled"}>派活</button>
        ${
          validation.ok
            ? ""
            : `<span class="faint">${escapeHtml(validation.reason || "")}</span>`
        }
      </div>
    </div>
  `;

  const roleSel = document.getElementById("dispatch-role") as HTMLSelectElement | null;
  const promptTa = document.getElementById("dispatch-prompt") as HTMLTextAreaElement | null;
  const btn = document.getElementById("btn-dispatch") as HTMLButtonElement | null;

  roleSel?.addEventListener("change", () => {
    dispatchRole = roleSel.value;
    renderDispatchPanel();
  });
  promptTa?.addEventListener("input", () => {
    dispatchPrompt = promptTa.value;
    // Lightweight re-validate without full rebuild of textarea focus:
    if (btn) {
      const v = validateDispatchForm({
        boxId: tab.cx,
        coordination: tab.coordination,
        role: dispatchRole,
        prompt: dispatchPrompt,
        roles,
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

async function onDispatch(): Promise<void> {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab || !workspaceId) return;
  const validation = validateDispatchForm({
    boxId: tab.cx,
    coordination: tab.coordination,
    role: dispatchRole,
    prompt: dispatchPrompt,
    roles,
  });
  if (!validation.ok || !validation.payload) {
    el.status.textContent = validation.reason || "无法派活";
    return;
  }
  try {
    const result = (await window.tentDesktop.rpc("task.dispatch", {
      workspaceId,
      boxId: validation.payload.boxId,
      role: validation.payload.role,
      prompt: validation.payload.prompt,
      dispatchedBy: validation.payload.dispatchedBy,
      deliveryPolicy: "manual",
    })) as { taskPath: string; state: string };
    el.status.textContent = `已派活 → ${result.taskPath}（${result.state}）`;
    dispatchPrompt = "";
    await Promise.all([reloadTasks(), reloadTree()]);
    renderDispatchPanel();
  } catch (err) {
    setError(err);
  }
}

function renderTasks(): void {
  if (el.taskCount) {
    const n = taskReview.length;
    el.taskCount.hidden = n === 0;
    el.taskCount.textContent = String(n);
  }
  // Prefer opening pending when tasks arrive (first paint / refresh).
  if (taskReview.length > 0 && el.secPending && !el.secPending.open) {
    if (el.secDispatch) el.secDispatch.open = false;
    if (el.secCards) el.secCards.open = false;
    el.secPending.open = true;
  }
  if (!taskReview.length) {
    el.tasks.innerHTML = `<li class="muted">暂无任务</li>`;
    return;
  }

  const profileOpts =
    profiles.length > 0
      ? profiles
          .map(
            (p) =>
              `<option value="${escapeHtml(p.id)}"${p.id === selectedProfileId ? " selected" : ""}>${escapeHtml(p.label)}</option>`
          )
          .join("")
      : `<option value="">（无可用 profile）</option>`;

  // Shared compact profile picker once above the list when any startable task exists.
  const anyStartable = taskReview.some((t) => t.canStartAgent);
  const profileBar = anyStartable
    ? `<li class="task-profile-bar">
        <label for="agent-profile">agent profile</label>
        <select id="agent-profile" title="machine-local profile"${profiles.length ? "" : " disabled"}>${profileOpts}</select>
      </li>`
    : "";

  el.tasks.innerHTML =
    profileBar +
    taskReview
      .map((t) => {
        const commits =
          t.commits.length > 0
            ? `<div class="muted">commits：${escapeHtml(t.commits.map((c) => c.slice(0, 8)).join(", "))}</div>`
            : "";
        const summary = t.deliverySummary
          ? `<div class="task-summary">${escapeHtml(t.deliverySummary)}</div>`
          : t.prompt
            ? `<div class="muted">prompt：${escapeHtml(t.prompt)}</div>`
            : "";
        const stateLabel = taskStateLabel(t.state, t.status);
        const sessBit = t.sessionState
          ? ` · 会话${escapeHtml(sessionStateLabel(t.sessionState))}`
          : "";
        const rejectDraft = rejectDrafts.get(t.path) || "";

        const startBtn = t.canStartAgent
          ? `<button type="button" class="btn btn-primary" data-start="${escapeHtml(t.path)}"${
              profiles.length && selectedProfileId ? "" : " disabled"
            } title="通过 ACP 启动 agent（callerKind=user）">启动 agent</button>`
          : "";
        const interruptBtn = t.canInterrupt
          ? `<button type="button" class="btn btn-secondary" data-interrupt="${escapeHtml(t.path)}" title="中断 agent 会话">中断</button>`
          : "";
        const reviewActions = t.canAcceptOrReject
          ? `<button type="button" class="btn btn-primary" data-accept="${escapeHtml(t.path)}">确认交付</button>
            <div class="reject-inline">
              <input type="text" class="field" data-reject-reason="${escapeHtml(t.path)}" placeholder="驳回原因" value="${escapeHtml(rejectDraft)}" />
              <button type="button" class="btn btn-secondary" data-reject="${escapeHtml(t.path)}">驳回</button>
            </div>`
          : "";
        const actions =
          startBtn || interruptBtn || reviewActions
            ? `<div class="task-actions row">${startBtn}${interruptBtn}${reviewActions}</div>`
            : "";

        const claimNames = (t.claims || []).filter((c) => c !== "root");
        const claimLabel = claimNames.length
          ? claimNames.map((c) => escapeHtml(c)).join(", ")
          : "—";
        return `<li class="task-item" data-task="${escapeHtml(t.path)}">
        <div class="task-kind">${escapeHtml(stateLabel)}${sessBit}</div>
        <div><strong>${escapeHtml(t.role)}</strong></div>
        <div class="muted">认领 ${claimLabel}</div>
        <div class="faint" title="${escapeHtml(t.path)}">${escapeHtml(t.path)}</div>
        ${summary}
        ${commits}
        ${actions}
      </li>`;
      })
      .join("");

  const profileSel = document.getElementById("agent-profile") as HTMLSelectElement | null;
  profileSel?.addEventListener("change", () => {
    selectedProfileId = profileSel.value || null;
    renderTasks();
  });

  el.tasks.querySelectorAll<HTMLElement>("[data-start]").forEach((btn) => {
    btn.addEventListener("click", () => void onStartAgent(btn.getAttribute("data-start")!));
  });
  el.tasks.querySelectorAll<HTMLElement>("[data-interrupt]").forEach((btn) => {
    btn.addEventListener("click", () => void onInterrupt(btn.getAttribute("data-interrupt")!));
  });
  el.tasks.querySelectorAll<HTMLElement>("[data-accept]").forEach((btn) => {
    btn.addEventListener("click", () => void onAccept(btn.getAttribute("data-accept")!));
  });
  el.tasks.querySelectorAll<HTMLInputElement>("[data-reject-reason]").forEach((input) => {
    input.addEventListener("input", () => {
      rejectDrafts.set(input.getAttribute("data-reject-reason")!, input.value);
    });
  });
  el.tasks.querySelectorAll<HTMLElement>("[data-reject]").forEach((btn) => {
    btn.addEventListener("click", () => void onReject(btn.getAttribute("data-reject")!));
  });
}

/**
 * User-clicked start: task.startSession with callerKind=user.
 * Dispatch remains a separate action — never auto-spends tokens.
 */
async function onStartAgent(taskPath: string): Promise<void> {
  if (!workspaceId) return;
  const built = buildStartSessionPayload(taskPath, selectedProfileId || "");
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    const result = (await window.tentDesktop.rpc("task.startSession", {
      workspaceId,
      taskPath: built.payload.taskPath,
      profileId: built.payload.profileId,
      callerKind: built.payload.callerKind,
    })) as {
      session?: { sessionId?: string; state?: string };
      task?: { state?: string };
    };
    const sid = result.session?.sessionId;
    const st = result.session?.state || result.task?.state || "";
    el.status.textContent = sid
      ? `已启动 agent · ${sid}${st ? `（${sessionStateLabel(st) || st}）` : ""}`
      : `已启动 agent · ${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
    await reloadTasks().catch(() => undefined);
  }
}

async function onInterrupt(taskPath: string): Promise<void> {
  if (!workspaceId) return;
  try {
    await window.tentDesktop.rpc("task.interrupt", {
      workspaceId,
      taskPath,
    });
    el.status.textContent = `已中断：${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}

async function onAccept(taskPath: string): Promise<void> {
  if (!workspaceId) return;
  const payload = buildAcceptPayload(taskPath, "user");
  try {
    await window.tentDesktop.rpc("task.accept", {
      workspaceId,
      taskPath: payload.taskPath,
      actor: payload.actor,
    });
    el.status.textContent = `已确认交付：${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}

async function onReject(taskPath: string): Promise<void> {
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
      resume: built.payload.resume,
    });
    el.status.textContent = `已驳回：${taskPath}`;
    rejectDrafts.delete(taskPath);
    await Promise.all([reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}

async function loadCards(): Promise<void> {
  const snap = await window.tentDesktop.getFloatingStatus();
  const cards = snap.recentCards || [];
  if (!cards.length) {
    el.cards.innerHTML = `<li class="muted">暂无 — 选中框后发出</li>`;
    return;
  }
  el.cards.innerHTML = cards
    .map(
      (c, i) => `<li class="card-item" draggable="true" data-card-idx="${i}">
        <div><strong>${escapeHtml(c.label)}</strong></div>
        <div class="muted">${escapeHtml(c.kind)}/${escapeHtml(c.refId)}</div>
        <div class="card-hint muted">拖出 · 单击复制</div>
      </li>`
    )
    .join("");
  el.cards.querySelectorAll<HTMLElement>("[data-card-idx]").forEach((node) => {
    const idx = Number(node.getAttribute("data-card-idx"));
    const card = cards[idx];
    if (!card?.text) return;
    // HTML5 text/plain only — no clipboard IPC on dragstart.
    bindContextCardDrag(node, card.text, {
      onCopied: () => {
        el.status.textContent = "上下文卡已复制（辅助）；拖出不依赖剪贴板。";
      },
      onCopyError: (err) => setError(err),
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
    setError(err);
  }
}

async function onCreateNote(): Promise<void> {
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
    await openConcept(created.id);
  } catch (err) {
    setError(err);
  }
}

async function onCreateCoordBox(): Promise<void> {
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
    await openConcept(created.id);
  } catch (err) {
    setError(err);
  }
}

async function onSearch(): Promise<void> {
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
      n.addEventListener("click", () => void openConcept(n.getAttribute("data-open")!));
    });
  } catch (err) {
    setError(err);
  }
}

async function onEmitCard(): Promise<void> {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.status.textContent = "请先打开一个概念。";
    return;
  }
  await window.tentDesktop.pushContextCard({
    kind: "box",
    id: tab.cx,
    path: tab.path,
    label: tab.name,
  });
  await loadCards();
  el.status.textContent = "上下文卡已就绪 — 左键拖到外部输入框（text/plain）。";
}

function setError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  el.status.textContent = msg;
  el.status.title = msg;
}

void boot();
