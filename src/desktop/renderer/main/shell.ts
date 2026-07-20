// App-level surface navigation: workbench | graph | activity | settings.
// Workbench three-pane chrome stays intact; secondary surfaces swap the stage host.

export type AppSurface = "workbench" | "graph" | "activity" | "settings";

export type ShellHost = {
  onSurfaceChange: (surface: AppSurface) => void;
};

const SURFACES: AppSurface[] = ["workbench", "graph", "activity", "settings"];

let current: AppSurface = "workbench";
let host: ShellHost | null = null;

export function getSurface(): AppSurface {
  return current;
}

export function bindShellHost(h: ShellHost): void {
  host = h;
}

export function setSurface(next: AppSurface, notify = true): void {
  if (!SURFACES.includes(next)) return;
  if (current === next) return;
  current = next;
  applySurfaceDom(current);
  if (notify) host?.onSurfaceChange(current);
}

export function applySurfaceDom(surface: AppSurface = current): void {
  const app = document.getElementById("app-root");
  if (app) app.dataset.surface = surface;

  document.querySelectorAll<HTMLElement>("[data-surface-nav]").forEach((btn) => {
    const id = btn.getAttribute("data-surface-nav") as AppSurface | null;
    const active = id === surface;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-current", active ? "page" : "false");
  });

  const workbench = document.getElementById("main-layout");
  const secondary = document.getElementById("secondary-host");
  if (workbench) {
    workbench.hidden = surface !== "workbench";
    workbench.setAttribute("aria-hidden", surface === "workbench" ? "false" : "true");
  }
  if (secondary) {
    secondary.hidden = surface === "workbench";
    secondary.setAttribute("aria-hidden", surface === "workbench" ? "true" : "false");
  }

  // Secondary panes
  for (const s of SURFACES) {
    if (s === "workbench") continue;
    const pane = document.getElementById(`surface-${s}`);
    if (pane) {
      const show = surface === s;
      pane.hidden = !show;
      pane.setAttribute("aria-hidden", show ? "false" : "true");
    }
  }
}

export function bindSurfaceNav(): void {
  document.querySelectorAll<HTMLElement>("[data-surface-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-surface-nav") as AppSurface | null;
      if (id) setSurface(id);
    });
  });
  // Keyboard: Ctrl/Cmd+1..4 for surfaces (workbench-first).
  document.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return;
    const map: Record<string, AppSurface> = {
      "1": "workbench",
      "2": "graph",
      "3": "activity",
      "4": "settings",
    };
    const next = map[ev.key];
    if (!next) return;
    // Avoid stealing when typing in fields with digit shortcuts rarely used —
    // only when target is not an editable field, or always for Ctrl+digit which is app chrome.
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
      // Still allow Ctrl+digit as chrome shortcut even in fields.
    }
    ev.preventDefault();
    setSurface(next);
  });
  applySurfaceDom(current);
}
