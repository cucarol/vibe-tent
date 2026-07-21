/** Raw status node (sr-only). Assignments via `el.status` also mirror to app toast. */
const statusLine = document.getElementById("status-line")!;

/** Toast host for secondary surfaces (status-line lives inside the workbench rail). */
function ensureToastHost(): HTMLElement {
  let host = document.getElementById("app-toast");
  if (host) return host;
  host = document.createElement("div");
  host.id = "app-toast";
  host.className = "app-toast";
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  host.hidden = true;
  (document.getElementById("app-root") || document.body).appendChild(host);
  return host;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** When true, status textContent writes skip toast (setError/setStatus own the toast). */
let suppressStatusToast = false;

function showToast(message: string, kind: "info" | "error" = "info"): void {
  const host = ensureToastHost();
  host.textContent = message;
  host.hidden = !message;
  host.dataset.kind = kind;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  if (!message) return;
  // Errors linger longer so narrow-window / secondary-surface actions remain legible.
  toastTimer = setTimeout(
    () => {
      host.hidden = true;
      host.textContent = "";
      toastTimer = null;
    },
    kind === "error" ? 8000 : 4000
  );
}

function clearToast(): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  const host = document.getElementById("app-toast");
  if (host) {
    host.hidden = true;
    host.textContent = "";
  }
}

/** True when a secondary surface is showing (workbench rail + sr-only status are hidden). */
function secondarySurfaceVisible(): boolean {
  const root = document.getElementById("app-root");
  const surface = root?.dataset.surface;
  return !!surface && surface !== "workbench";
}

/**
 * Proxy so existing `el.status.textContent = …` feedback remains visible on secondary
 * surfaces (graph / activity / settings) where the workbench status-line is off-DOM.
 * Workbench keeps paper-edit silence for routine info; setError still toasts everywhere.
 */
const statusProxy = new Proxy(statusLine, {
  set(target, prop, value, receiver) {
    const ok = Reflect.set(target, prop, value, receiver);
    if (prop === "textContent" && !suppressStatusToast) {
      const text = typeof value === "string" ? value : String(value ?? "");
      if (text && secondarySurfaceVisible()) showToast(text, "info");
      else if (!text) clearToast();
    }
    return ok;
  },
}) as HTMLElement;

/** DOM hosts for the app shell + three-pane workbench (ids match index.html). */
export const el = {
  health: document.getElementById("health-pill")!,
  wsSelect: document.getElementById("workspace-select") as HTMLSelectElement,
  status: statusProxy,
  appRoot: document.getElementById("app-root"),
  layout: document.getElementById("main-layout")!,
  secondaryHost: document.getElementById("secondary-host"),
  graphHost: document.getElementById("graph-host"),
  activityHost: document.getElementById("activity-host"),
  settingsHost: document.getElementById("settings-host"),
  activityBadge: document.getElementById("activity-badge"),
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
  secBacklinks: document.getElementById("sec-backlinks") as HTMLDetailsElement | null,
  backlinks: document.getElementById("backlinks-host"),
};

/** Sync top-nav activity badge with pending + reviewable work. */
export function syncActivityBadge(count: number): void {
  if (!el.activityBadge) return;
  el.activityBadge.hidden = count === 0;
  el.activityBadge.textContent = String(count);
}

export function setStatus(message: string, title?: string): void {
  suppressStatusToast = true;
  try {
    statusLine.textContent = message;
    if (title !== undefined) statusLine.title = title;
    else if (message) statusLine.title = message;
  } finally {
    suppressStatusToast = false;
  }
  // Explicit setStatus: toast only when workbench status rail is not visible.
  if (message && secondarySurfaceVisible()) showToast(message, "info");
  else if (!message) clearToast();
}

export function setError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  suppressStatusToast = true;
  try {
    statusLine.textContent = msg;
    statusLine.title = msg;
  } finally {
    suppressStatusToast = false;
  }
  showToast(msg, "error");
}
