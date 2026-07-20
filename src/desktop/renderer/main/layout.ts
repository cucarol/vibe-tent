// App shell chrome: three-pane layout resize/collapse + rail drawers/menus.

import {
  LAYOUT_BOUNDS,
  computeEffectiveLayout,
  loadLayoutPrefs,
  resizeSide,
  saveLayoutPrefs,
  stepResize,
  toggleCollapsed,
  type MainLayoutPrefs,
} from "../../workbench/layout-prefs.js";
import { el } from "./elements.js";

/** Renderer-local layout prefs (widths + collapse). */
let layoutPrefs: MainLayoutPrefs = loadLayoutPrefs(
  typeof localStorage !== "undefined" ? localStorage : null
);
let resizeSession: {
  side: "left" | "right";
  startX: number;
  startWidth: number;
} | null = null;

function layoutViewportWidth(): number {
  return el.layout?.clientWidth || window.innerWidth || 1200;
}

function persistLayout(): void {
  saveLayoutPrefs(typeof localStorage !== "undefined" ? localStorage : null, layoutPrefs);
}

export function applyLayoutChrome(): void {
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

export function bindChromeMenus(): void {
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

export function bindLayoutChrome(): void {
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
