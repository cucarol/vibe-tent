/**
 * Renderer-local open-tab session helpers.
 * Closing a tab never mutates Node / Service state — only the in-memory tab list.
 */

/** Prefer the left neighbor, else the right; keep active when closing another tab. */
export function resolveActiveAfterClose(
  tabOrder: readonly string[],
  closingCx: string,
  activeCx: string | null
): string | null {
  const remaining = tabOrder.filter((id) => id !== closingCx);
  if (remaining.length === 0) return null;
  if (activeCx && activeCx !== closingCx && remaining.includes(activeCx)) {
    return activeCx;
  }
  const idx = tabOrder.indexOf(closingCx);
  if (idx === -1) {
    return remaining[remaining.length - 1] ?? null;
  }
  // Left neighbor stays at the same index in the pre-close list.
  if (idx > 0) {
    const left = tabOrder[idx - 1]!;
    if (remaining.includes(left)) return left;
  }
  // Was first (or left missing): take the tab that slid into this slot.
  return remaining[Math.min(idx, remaining.length - 1)] ?? null;
}

export type CloseTabResult = {
  order: string[];
  activeCx: string | null;
  closed: boolean;
};

/** Remove one open tab and recompute the active id. */
export function closeOpenTab(
  tabOrder: readonly string[],
  closingCx: string,
  activeCx: string | null
): CloseTabResult {
  if (!tabOrder.includes(closingCx)) {
    return { order: [...tabOrder], activeCx, closed: false };
  }
  const nextActive = resolveActiveAfterClose(tabOrder, closingCx, activeCx);
  return {
    order: tabOrder.filter((id) => id !== closingCx),
    activeCx: nextActive,
    closed: true,
  };
}

/** Empty document canvas copy — distinct from “no workspace mounted”. */
export function documentEmptyCopy(hasWorkspace: boolean): {
  title: string;
  hint: string | null;
  /** When true, empty canvas exposes a left-click mount entry (data-empty-act=open-ws). */
  action: "open-workspace" | null;
} {
  if (!hasWorkspace) {
    return {
      title: "打开工作区",
      hint: "选择本机文件夹挂载为工作区（不直接读取 .tent）",
      action: "open-workspace",
    };
  }
  return {
    title: "未打开文档",
    hint: "从左侧 Nodes 选择一条笔记",
    action: null,
  };
}

/** True when Ctrl/Cmd+W should close the active document tab. */
export function isCloseTabShortcut(ev: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (ev.altKey || ev.shiftKey) return false;
  if (!(ev.ctrlKey || ev.metaKey)) return false;
  return ev.key === "w" || ev.key === "W";
}
