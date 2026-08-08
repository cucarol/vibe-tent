import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  computeEffectiveLayout,
  loadLayoutPrefs,
  saveLayoutPrefs,
  toggleCollapsed,
  type EffectiveMainLayout,
  type MainLayoutPrefs,
  type StorageLike,
} from "../../workbench/layout-prefs.js";

export type LayoutSide = "left" | "right";

export type MainLayoutSnapshot = {
  prefs: MainLayoutPrefs;
  effective: EffectiveMainLayout;
};

/** Accessing localStorage can throw before loadLayoutPrefs gets a chance to recover. */
export function getBrowserLayoutStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getBrowserViewportWidth(): number {
  try {
    if (typeof window === "undefined") return 1200;
    return window.innerWidth || 1200;
  } catch {
    return 1200;
  }
}

function collapsedKey(side: LayoutSide): "leftCollapsed" | "rightCollapsed" {
  return side === "left" ? "leftCollapsed" : "rightCollapsed";
}

/**
 * Renderer-local layout state. The effective snapshot may auto-collapse the
 * right pane, but only explicit commands update prefs or write storage.
 */
export class MainLayoutController {
  private readonly storage: StorageLike | null;
  private prefs: MainLayoutPrefs;
  private viewportWidth: number;
  private snapshot: MainLayoutSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(
    storage: StorageLike | null | undefined = getBrowserLayoutStorage(),
    viewportWidth = getBrowserViewportWidth()
  ) {
    this.storage = storage ?? null;
    this.prefs = loadLayoutPrefs(this.storage);
    this.viewportWidth = viewportWidth;
    this.snapshot = this.makeSnapshot();
  }

  readonly getSnapshot = (): MainLayoutSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setViewportWidth(width: number): void {
    const nextWidth = Number.isFinite(width) ? width : getBrowserViewportWidth();
    if (nextWidth === this.viewportWidth) return;
    this.viewportWidth = nextWidth;
    this.publish();
  }

  /** Explicit header toggle: a visible auto-collapsed pane is a restore command. */
  readonly toggle = (side: LayoutSide): void => {
    if (this.snapshot.effective[collapsedKey(side)]) {
      this.restore(side);
      return;
    }
    this.commit(toggleCollapsed(this.prefs, side));
  };

  readonly collapse = (side: LayoutSide): void => {
    this.commit({ ...this.prefs, [collapsedKey(side)]: true });
  };

  readonly restore = (side: LayoutSide): void => {
    this.commit({ ...this.prefs, [collapsedKey(side)]: false });
  };

  private commit(next: MainLayoutPrefs): void {
    this.prefs = next;
    // Persistence is deliberately outside React state updates and only lives
    // on explicit user commands, so Strict Mode cannot double-write it.
    saveLayoutPrefs(this.storage, this.prefs);
    this.publish();
  }

  private makeSnapshot(): MainLayoutSnapshot {
    return {
      prefs: this.prefs,
      effective: computeEffectiveLayout(this.prefs, this.viewportWidth),
    };
  }

  private publish(): void {
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }
}

export function useMainLayout(): MainLayoutSnapshot & {
  toggle: (side: LayoutSide) => void;
  collapse: (side: LayoutSide) => void;
  restore: (side: LayoutSide) => void;
} {
  const controllerRef = useRef<MainLayoutController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new MainLayoutController();
  }
  const controller = controllerRef.current;
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => controller.setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, [controller]);

  return {
    ...snapshot,
    toggle: controller.toggle,
    collapse: controller.collapse,
    restore: controller.restore,
  };
}
