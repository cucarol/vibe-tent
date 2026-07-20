/** DOM hosts for the three-pane main workbench (ids match index.html). */
export const el = {
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

export function setStatus(message: string, title?: string): void {
  el.status.textContent = message;
  if (title !== undefined) el.status.title = title;
  else if (message) el.status.title = message;
}

export function setError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  el.status.textContent = msg;
  el.status.title = msg;
}
