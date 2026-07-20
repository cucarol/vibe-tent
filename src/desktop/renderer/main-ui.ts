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

/** Shared 16×16 stroke icons — no char glyphs, no icon pack. */
const ICO = {
  search:
    '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2 13.5 13.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  plus:
    '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  more:
    '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="8" r="1.15" fill="currentColor"/><circle cx="8" cy="8" r="1.15" fill="currentColor"/><circle cx="12" cy="8" r="1.15" fill="currentColor"/></svg>',
  chevronLeft:
    '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.75 3.75 5.5 8l4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevronRight:
    '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.25 3.75 10.5 8l-4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  modeSource:
    '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.25 4.5 2.75 8l2.5 3.5M10.75 4.5 13.25 8l-2.5 3.5M9.1 3.5 6.9 12.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  modePreview:
    '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 4.25h10.5M2.75 8h7.5M2.75 11.75h10.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
} as const;

type ConceptNode = {
  id: string;
  path: string;
  name: string;
  type: string;
  coordination: boolean;
  status?: string;
  assignee?: string;
  mode?: "editable" | "read-only" | "archived";
  tags?: string[];
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
  nodeMode: "editable" | "read-only" | "archived";
  frontmatter: Record<string, unknown>;
  artifactRefs?: Array<{ kind: string; target: string; label?: string }>;
};

type UserAskView = {
  id: string;
  taskPath: string;
  sessionId?: string;
  role?: string;
  question: string;
  choices?: Array<{ id: string; label: string }>;
  createdAt: string;
};

type A2AApprovalView = {
  id: string;
  taskPath: string;
  role: string;
  profileId: string;
  createdAt: string;
};

type ToolApprovalView = {
  id: string;
  sessionId: string;
  taskPath?: string;
  role?: string;
  toolTitle: string;
  options?: Array<{ optionId: string; kind?: string; name?: string }>;
  createdAt: string;
  expiresAt: string;
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
let userAsks: UserAskView[] = [];
let a2aApprovals: A2AApprovalView[] = [];
let toolApprovals: ToolApprovalView[] = [];
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
  a2u: document.getElementById("a2u-host")!,
  u2a: document.getElementById("u2a-host")!,
  session: document.getElementById("session-host")!,
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

/** Inspector: empty sections stay collapsed; only open what needs attention. */
function syncInspectorSections(): void {
  const hasTasks = actionableTasks().length > 0 || pendingInteractionCount() > 0;
  const tab = activeCx ? localTabs.get(activeCx) : null;
  const canDispatch = !!(tab && tab.coordination);
  if (!el.secPending || !el.secDispatch || !el.secCards) return;
  // 不与用户折叠状态抢权；仅在全部收起时按需默认打开一项
  const anyOpen = el.secPending.open || el.secDispatch.open || el.secCards.open;
  if (anyOpen) return;
  if (hasTasks) el.secPending.open = true;
  else if (canDispatch) el.secDispatch.open = true;
  // 否则保持全收起，不展开空说明
}

function actionableTasks(): TaskReviewItem[] {
  return taskReview.filter((task) =>
    ["queued", "pending", "running", "taken", "waiting", "delivered"].includes(
      String(task.state || task.status || "")
    )
  );
}

function pendingInteractionCount(): number {
  return userAsks.length + a2aApprovals.length + toolApprovals.length;
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
    // 常态只显示 displayName；完整路径仅 title/tooltip
    const label = (w.tentName || "").trim() || "工作区";
    opt.textContent = label;
    opt.title = w.workspaceRoot || w.workspaceId;
    if (w.foreground || w.workspaceId === s.foregroundWorkspaceId) opt.selected = true;
    el.wsSelect.appendChild(opt);
  }
  workspaceId = s.foregroundWorkspaceId;
  // 状态线仅作 aria-live 错误/动作反馈，不展示常驻说明
  const live = s.statusMessage || s.workspace?.statusMessage || "";
  if (live) el.status.textContent = live;

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
  for (const [id, tab] of localTabs) {
    const concept = findConcept(tree, id);
    if (concept?.mode) tab.nodeMode = concept.mode;
  }
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
    renderTaskInput();
    renderSessions();
  } catch (err) {
    setError(err);
  }
}

async function reloadPendingInteractions(): Promise<void> {
  if (!workspaceId) return;
  try {
    const [askResult, a2aResult, toolResult] = await Promise.all([
      window.tentDesktop.rpc("userAsk.listPending", { workspaceId }) as Promise<{ asks: UserAskView[] }>,
      window.tentDesktop.rpc("a2a.listPending", { workspaceId }) as Promise<{ approvals: A2AApprovalView[] }>,
      window.tentDesktop.rpc("toolApproval.listPending", { workspaceId }) as Promise<{ approvals: ToolApprovalView[] }>,
    ]);
    userAsks = askResult.asks || [];
    a2aApprovals = a2aResult.approvals || [];
    toolApprovals = toolResult.approvals || [];
    renderPendingInteractions();
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
      const active = n.id === activeCx ? " active" : "";
      const archived = n.mode === "archived" ? " is-archived" : "";
      const kids = n.children?.length ? `<ul>${renderNodes(n.children)}</ul>` : "";
      return `<li>
        <div class="tree-node${active}${archived}" data-open="${escapeHtml(n.id)}" title="${escapeHtml(n.id)} · ${escapeHtml(n.type)} · ${escapeHtml(n.mode || "editable")}">
          <span class="tree-name">${escapeHtml(n.name)}</span>
          <span class="tree-meta">${mark}</span>
        </div>
        ${kids}
      </li>`;
    })
    .join("");
}

function findConcept(nodes: ConceptNode[], id: string): ConceptNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findConcept(node.children || [], id);
    if (child) return child;
  }
  return undefined;
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
    mode?: "editable" | "read-only" | "archived";
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
    nodeMode: edit.mode || findConcept(tree, edit.id)?.mode || "editable",
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
  renderPendingInteractions();
  renderTaskInput();
  renderSessions();
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
  const modeLabel = tab.mode === "preview" ? "预览" : "源码";
  const modeTitle = tab.mode === "preview" ? "切换到源码" : "切换到预览";
  // 克制工具组：模式图标 + dirty 时保存 + 更多；干净状态不提示「已保存」
  const modeIco = tab.mode === "preview" ? ICO.modePreview : ICO.modeSource;
  el.toolbar.innerHTML = `
    <button type="button" class="icon-btn mode-toggle" data-act="toggle-mode" title="${modeTitle}" aria-label="${modeTitle}（${modeLabel}）">${modeIco}</button>
    ${
      tab.dirty && tab.nodeMode === "editable"
        ? `<button type="button" data-act="save" class="btn btn-primary btn-quiet-save" title="保存">保存</button>`
        : ""
    }
    <div class="menu-wrap">
      <button type="button" class="icon-btn" data-doc-more title="更多" aria-label="文档更多操作" aria-haspopup="menu">${ICO.more}</button>
      <div class="menu" data-doc-menu role="menu" hidden>
        <button type="button" class="menu-item" role="menuitem" data-act="source"${tab.mode === "source" ? " aria-current=\"true\"" : ""}>源码</button>
        <button type="button" class="menu-item" role="menuitem" data-act="preview"${tab.mode === "preview" ? " aria-current=\"true\"" : ""}>预览</button>
        <div class="menu-sep" role="separator"></div>
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
  if (act === "toggle-mode") {
    tab.mode = tab.mode === "source" ? "preview" : "source";
    renderAll();
    return;
  }
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
    renderAll();
  } catch (err) {
    setError(err);
  }
}

function renderEditor(): void {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.editor.innerHTML = '<div class="empty empty-cta"><p class="empty-title">打开工作区</p></div>';
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
    el.meta.innerHTML = `<span class="muted">未选择</span>`;
    el.meta.classList.add("muted");
    return;
  }
  el.meta.classList.remove("muted");
  // 标题 + 最多一行关键属性；类型/路径/id 收进详情折叠
  const modeLabel =
    tab.nodeMode === "read-only" ? "仅可读" : tab.nodeMode === "archived" ? "封存" : "开放";
  const oneLine = tab.coordination
    ? `${escapeHtml(tab.type)} · 协作 · ${modeLabel}`
    : `${escapeHtml(tab.type)} · ${modeLabel}`;
  el.meta.innerHTML = `
    <div class="meta-name">${escapeHtml(tab.name)}</div>
    <div class="meta-line muted">${oneLine}</div>
    <div class="meta-controls">
      <label class="sr-only" for="node-display-name">名称</label>
      <input id="node-display-name" class="field" value="${escapeHtml(tab.name)}" />
      <button type="button" id="btn-rename-node" class="btn btn-secondary">重命名</button>
    </div>
    <div class="meta-controls">
      <label for="node-mode">访问</label>
      <select id="node-mode" class="field field-compact">
        <option value="editable"${tab.nodeMode === "editable" ? " selected" : ""}>开放</option>
        <option value="read-only"${tab.nodeMode === "read-only" ? " selected" : ""}>仅可读</option>
        <option value="archived"${tab.nodeMode === "archived" ? " selected" : ""}>封存</option>
      </select>
      <button type="button" id="btn-apply-node-mode" class="btn btn-secondary">应用</button>
    </div>
    <details class="meta-details">
      <summary>详情</summary>
      <dl>
        <dt>类型</dt><dd>${escapeHtml(tab.type)}${tab.coordination ? " · 协作" : ""}</dd>
        <dt>路径</dt><dd title="${escapeHtml(tab.path)}">${escapeHtml(tab.path)}</dd>
        <dt>标识</dt><dd><code>${escapeHtml(tab.cx)}</code></dd>
      </dl>
    </details>`;
  document.getElementById("btn-rename-node")?.addEventListener("click", () => void onRenameNode());
  document.getElementById("btn-apply-node-mode")?.addEventListener("click", () => void onSetNodeMode());
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
    renderAll();
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
      localTabs.delete(tab.cx);
      const remainingTabs = [...localTabs.keys()];
      activeCx = remainingTabs[remainingTabs.length - 1] || null;
    }
    await reloadTree();
    renderAll();
  } catch (err) {
    setError(err);
  }
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
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
    renderDispatchPanel();
  } catch (err) {
    setError(err);
  }
}

function renderPendingInteractions(): void {
  const hasPending = pendingInteractionCount() > 0;
  el.a2u.hidden = !hasPending;
  if (!hasPending) {
    el.a2u.innerHTML = "";
    renderTasks();
    return;
  }
  const asks = userAsks.map((ask) => {
    const choices = (ask.choices || []).map((choice) => `<label class="choice-row">
      <input type="radio" name="ask-choice-${escapeHtml(ask.id)}" value="${escapeHtml(choice.id)}" />
      <span>${escapeHtml(choice.label)}</span></label>`).join("");
    return `<article class="interaction-item" data-ask-item="${escapeHtml(ask.id)}">
      <div class="interaction-kicker">AGENT QUESTION · ${escapeHtml(ask.role || "Agent")}</div>
      <div class="interaction-title">${escapeHtml(ask.question)}</div>
      ${choices ? `<div class="choice-list">${choices}</div>` : ""}
      <textarea class="line-input" data-ask-answer="${escapeHtml(ask.id)}" rows="2" placeholder="补充说明（可选）"></textarea>
      <div class="interaction-actions"><button type="button" class="btn btn-primary" data-ask-reply="${escapeHtml(ask.id)}">回复</button>
      <button type="button" class="btn btn-ghost" data-task-stop="${escapeHtml(ask.taskPath)}">中断任务</button></div>
    </article>`;
  }).join("");
  const a2a = a2aApprovals.map((item) => `<article class="interaction-item">
    <div class="interaction-kicker">A2A APPROVAL</div>
    <div class="interaction-title">${escapeHtml(item.role)} 请求启动 ${escapeHtml(item.profileId)}</div>
    <div class="muted interaction-note">${escapeHtml(item.taskPath)}</div>
    <div class="interaction-actions"><button type="button" class="btn btn-primary" data-a2a-allow="${escapeHtml(item.id)}">允许一次</button>
    <button type="button" class="btn btn-ghost" data-a2a-deny="${escapeHtml(item.id)}">拒绝</button></div>
  </article>`).join("");
  const tools = toolApprovals.map((item) => {
    const summary = (item.options || []).map((option) => option.name || option.kind || option.optionId).filter(Boolean).join(" · ");
    return `<article class="interaction-item">
      <div class="interaction-kicker">TOOL PERMISSION</div><div class="interaction-title">${escapeHtml(item.toolTitle)}</div>
      <div class="muted interaction-note">${escapeHtml(item.role || "Agent")} · ${escapeHtml(item.sessionId)}</div>
      ${summary ? `<div class="muted interaction-note">${escapeHtml(summary)}</div>` : ""}
      <div class="interaction-actions"><button type="button" class="btn btn-primary" data-tool-allow="${escapeHtml(item.id)}">允许一次</button>
      <button type="button" class="btn btn-ghost" data-tool-deny="${escapeHtml(item.id)}">拒绝</button></div>
    </article>`;
  }).join("");
  el.a2u.innerHTML = asks + a2a + tools;
  el.a2u.querySelectorAll<HTMLElement>("[data-ask-reply]").forEach((button) => button.addEventListener("click", () => void onReplyUserAsk(button.getAttribute("data-ask-reply")!)));
  el.a2u.querySelectorAll<HTMLElement>("[data-task-stop]").forEach((button) => button.addEventListener("click", () => void onInterrupt(button.getAttribute("data-task-stop")!)));
  el.a2u.querySelectorAll<HTMLElement>("[data-a2a-allow]").forEach((button) => button.addEventListener("click", () => void onResolveA2A(button.getAttribute("data-a2a-allow")!, "approve")));
  el.a2u.querySelectorAll<HTMLElement>("[data-a2a-deny]").forEach((button) => button.addEventListener("click", () => void onResolveA2A(button.getAttribute("data-a2a-deny")!, "deny")));
  el.a2u.querySelectorAll<HTMLElement>("[data-tool-allow]").forEach((button) => button.addEventListener("click", () => void onResolveTool(button.getAttribute("data-tool-allow")!, true)));
  el.a2u.querySelectorAll<HTMLElement>("[data-tool-deny]").forEach((button) => button.addEventListener("click", () => void onResolveTool(button.getAttribute("data-tool-deny")!, false)));
  renderTasks();
  syncInspectorSections();
}

async function onReplyUserAsk(askId: string): Promise<void> {
  const item = el.a2u.querySelector<HTMLElement>(`[data-ask-item="${CSS.escape(askId)}"]`);
  const answer = item?.querySelector<HTMLTextAreaElement>("[data-ask-answer]")?.value.trim() || "";
  const choiceId = item?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value || "";
  if (!answer && !choiceId) { el.status.textContent = "请选择一个选项或填写回复。"; return; }
  try {
    await window.tentDesktop.rpc("userAsk.reply", { askId, actor: "user", ...(answer ? { answer } : {}), ...(choiceId ? { choiceId } : {}) });
    el.status.textContent = "已回复 Agent。";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) { setError(err); }
}

async function onResolveA2A(approvalId: string, decision: "approve" | "deny"): Promise<void> {
  try {
    await window.tentDesktop.rpc("a2a.resolve", { approvalId, decision, actor: "user" });
    el.status.textContent = decision === "approve" ? "已允许启动 Agent。" : "已拒绝启动 Agent。";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) { setError(err); }
}

async function onResolveTool(approvalId: string, allow: boolean): Promise<void> {
  try {
    await window.tentDesktop.rpc(allow ? "toolApproval.approveOnce" : "toolApproval.deny", { approvalId, actor: "user" });
    el.status.textContent = allow ? "已允许本次工具调用。" : "已拒绝工具调用。";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) { setError(err); }
}

function tasksForActiveNode(states?: string[]): TaskReviewItem[] {
  if (!activeCx) return [];
  return actionableTasks().filter((task) => {
    const state = String(task.state || task.status || "");
    return task.claims.includes(activeCx!) && (!states || states.includes(state));
  });
}

function renderTaskInput(): void {
  const candidates = tasksForActiveNode(["running", "taken", "waiting"]);
  el.u2a.hidden = candidates.length === 0;
  if (!candidates.length) { el.u2a.innerHTML = ""; return; }
  const options = candidates.map((task) => `<option value="${escapeHtml(task.path)}">${escapeHtml(task.role)} · ${escapeHtml(taskStateLabel(task.state, task.status))}</option>`).join("");
  el.u2a.innerHTML = `<article class="interaction-item u2a-item"><div class="interaction-kicker">追加任务输入</div>
    ${candidates.length > 1 ? `<select id="u2a-task" class="field">${options}</select>` : ""}
    <textarea id="u2a-text" class="line-input" rows="2" placeholder="发送一次性补充指令"></textarea>
    <div class="interaction-actions"><button type="button" id="btn-send-task-input" class="btn btn-secondary">发送</button></div></article>`;
  document.getElementById("btn-send-task-input")?.addEventListener("click", async () => {
    const text = (document.getElementById("u2a-text") as HTMLTextAreaElement | null)?.value.trim() || "";
    const taskPath = (document.getElementById("u2a-task") as HTMLSelectElement | null)?.value || candidates[0]!.path;
    if (!text) { el.status.textContent = "请填写补充指令。"; return; }
    try {
      await window.tentDesktop.rpc("task.sendInput", { workspaceId, taskPath, text, actor: "user" });
      el.status.textContent = "补充指令已发送。";
      await reloadTasks();
    } catch (err) { setError(err); }
  });
}

function renderSessions(): void {
  const relatedTasks = tasksForActiveNode();
  const taskIds = new Set(relatedTasks.map((task) => task.id).filter(Boolean));
  const sessionIds = new Set(relatedTasks.map((task) => task.sessionId).filter(Boolean));
  const related = sessions.filter((session) => sessionIds.has(session.sessionId) || (!!session.lastTaskId && taskIds.has(session.lastTaskId)));
  el.session.hidden = related.length === 0;
  el.session.innerHTML = related.map((session) => `<div class="session-row"><span class="session-dot ${session.alive ? "is-live" : ""}" aria-hidden="true"></span>
    <span>${escapeHtml(session.roleName || session.profileId)}</span><span class="muted">${escapeHtml(sessionStateLabel(session.state) || session.state)}</span></div>`).join("");
}

function renderTasks(): void {
  const visibleTasks = actionableTasks();
  if (el.taskCount) {
    const n = visibleTasks.length + pendingInteractionCount();
    el.taskCount.hidden = n === 0;
    el.taskCount.textContent = String(n);
  }
  // 有任务时确保待处理展开；空则收起
  if (el.secPending) {
    if (visibleTasks.length > 0 || pendingInteractionCount() > 0) {
      el.secPending.open = true;
      if (el.secDispatch) el.secDispatch.open = false;
      if (el.secCards) el.secCards.open = false;
    } else if (!el.secDispatch?.open && !el.secCards?.open) {
      el.secPending.open = false;
    }
  }
  if (!visibleTasks.length) {
    el.tasks.innerHTML = "";
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
      : `<option value="">（无 profile）</option>`;

  const anyStartable = visibleTasks.some((t) => t.canStartAgent);
  const profileBar = anyStartable
    ? `<li class="task-profile-bar">
        <label class="sr-only" for="agent-profile">profile</label>
        <select id="agent-profile" title="profile"${profiles.length ? "" : " disabled"}>${profileOpts}</select>
      </li>`
    : "";

  el.tasks.innerHTML =
    profileBar +
    visibleTasks
      .map((t) => {
        // 谁 / 在做什么 / 一句摘要 / 动作；id/path/状态字收进详情
        const who = escapeHtml(t.role);
        // 主行不裸露 cx-/rl-/tk- 等技术 id
        const claims = (t.claims || []).filter(
          (c) => c !== "root" && !/^(cx|rl|tk|ss|dl|ti)-/i.test(c)
        );
        const claimBit = claims.length
          ? `<span class="task-claims muted">${claims.map((c) => escapeHtml(c)).join(" · ")}</span>`
          : "";
        const blurbRaw = t.deliverySummary || t.prompt || "";
        const blurb = blurbRaw
          ? `<div class="task-summary">${escapeHtml(blurbRaw.length > 120 ? blurbRaw.slice(0, 117) + "…" : blurbRaw)}</div>`
          : "";
        const stateLabel = taskStateLabel(t.state, t.status);
        const sessLabel = t.sessionState ? sessionStateLabel(t.sessionState) : "";
        const rejectDraft = rejectDrafts.get(t.path) || "";

        const startBtn = t.canStartAgent
          ? `<button type="button" class="btn btn-primary" data-start="${escapeHtml(t.path)}"${
              profiles.length && selectedProfileId ? "" : " disabled"
            } title="启动 agent">启动</button>`
          : "";
        const interruptBtn = t.canInterrupt
          ? `<button type="button" class="btn btn-ghost" data-interrupt="${escapeHtml(t.path)}" title="中断">中断</button>`
          : "";
        const reviewActions = t.canAcceptOrReject
          ? `<div class="task-primary-row">
              <button type="button" class="btn btn-primary" data-accept="${escapeHtml(t.path)}">确认</button>
              <button type="button" class="btn btn-ghost" data-reject-toggle="${escapeHtml(t.path)}" aria-expanded="false">驳回</button>
            </div>
            <div class="reject-panel" data-reject-panel="${escapeHtml(t.path)}" hidden>
              <input type="text" class="field" data-reject-reason="${escapeHtml(t.path)}" placeholder="驳回原因" value="${escapeHtml(rejectDraft)}" />
              <button type="button" class="btn btn-secondary" data-reject="${escapeHtml(t.path)}">确认驳回</button>
            </div>`
          : "";
        const actions =
          startBtn || interruptBtn || reviewActions
            ? `<div class="task-actions">${startBtn}${interruptBtn}${reviewActions}</div>`
            : "";

        return `<li class="task-item" data-task="${escapeHtml(t.path)}">
        <div class="task-head">
          <strong>${who}</strong>
          ${claimBit}
        </div>
        ${blurb}
        ${actions}
        <details class="task-details">
          <summary>详情</summary>
          <div class="task-detail-body muted">
            <div>${escapeHtml(stateLabel)}${sessLabel ? ` · ${escapeHtml(sessLabel)}` : ""}</div>
            <div class="faint" title="${escapeHtml(t.path)}">${escapeHtml(t.path)}</div>
            ${
              t.commits.length > 0
                ? `<div>${escapeHtml(t.commits.map((c) => c.slice(0, 8)).join(", "))}</div>`
                : ""
            }
          </div>
        </details>
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
  el.tasks.querySelectorAll<HTMLElement>("[data-reject-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = btn.getAttribute("data-reject-toggle")!;
      const item = btn.closest(".task-item");
      const panel = item?.querySelector("[data-reject-panel]");
      if (!(panel instanceof HTMLElement)) return;
      const open = panel.hasAttribute("hidden");
      if (open) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        const reason = panel.querySelector("[data-reject-reason]");
        if (reason instanceof HTMLInputElement) reason.focus();
      }
    });
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
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
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
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
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
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
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
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
  } catch (err) {
    setError(err);
  }
}

async function loadCards(): Promise<void> {
  const snap = await window.tentDesktop.getFloatingStatus();
  const cards = snap.recentCards || [];
  if (!cards.length) {
    el.cards.innerHTML = "";
    return;
  }
  el.cards.innerHTML = cards
    .map(
      (c, i) => `<li class="card-item" draggable="true" data-card-idx="${i}" title="${escapeHtml(c.kind)}/${escapeHtml(c.refId)}">
        <div><strong>${escapeHtml(c.label)}</strong></div>
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
        el.status.textContent = "已复制";
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
