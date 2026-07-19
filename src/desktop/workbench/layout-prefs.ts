/**
 * Renderer-local main workbench layout preferences.
 * Pure model: widths, collapse flags, clamp, narrow-window effective layout.
 * Persistence is localStorage (or any StorageLike) — not a service/business model.
 */

export const LAYOUT_STORAGE_KEY = "tent.desktop.mainLayout.v1";

export const LAYOUT_BOUNDS = {
  leftMin: 220,
  leftMax: 420,
  leftDefault: 256,
  rightMin: 280,
  rightMax: 520,
  rightDefault: 312,
  centerMin: 480,
  /** Visual + hit area for each splitter */
  splitterWidth: 8,
  /** Horizontal chrome around the three columns (layout padding) */
  layoutPadX: 20,
  resizeStep: 12,
} as const;

export type MainLayoutPrefs = {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
};

export type EffectiveMainLayout = MainLayoutPrefs & {
  centerWidth: number;
  /** Right was forced shut so the editor keeps a readable width */
  autoCollapsedRight: boolean;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function defaultLayoutPrefs(): MainLayoutPrefs {
  return {
    leftWidth: LAYOUT_BOUNDS.leftDefault,
    rightWidth: LAYOUT_BOUNDS.rightDefault,
    leftCollapsed: false,
    rightCollapsed: false,
  };
}

export function clampWidth(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeLayoutPrefs(input: Partial<MainLayoutPrefs> | null | undefined): MainLayoutPrefs {
  const base = defaultLayoutPrefs();
  if (!input || typeof input !== "object") return base;
  return {
    leftWidth: clampWidth(
      typeof input.leftWidth === "number" ? input.leftWidth : base.leftWidth,
      LAYOUT_BOUNDS.leftMin,
      LAYOUT_BOUNDS.leftMax
    ),
    rightWidth: clampWidth(
      typeof input.rightWidth === "number" ? input.rightWidth : base.rightWidth,
      LAYOUT_BOUNDS.rightMin,
      LAYOUT_BOUNDS.rightMax
    ),
    leftCollapsed: input.leftCollapsed === true,
    rightCollapsed: input.rightCollapsed === true,
  };
}

export function loadLayoutPrefs(storage: StorageLike | null | undefined): MainLayoutPrefs {
  if (!storage) return defaultLayoutPrefs();
  try {
    const raw = storage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return defaultLayoutPrefs();
    return normalizeLayoutPrefs(JSON.parse(raw) as Partial<MainLayoutPrefs>);
  } catch {
    return defaultLayoutPrefs();
  }
}

export function saveLayoutPrefs(storage: StorageLike | null | undefined, prefs: MainLayoutPrefs): void {
  if (!storage) return;
  try {
    const normalized = normalizeLayoutPrefs(prefs);
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Quota / private mode — layout still works for the session.
  }
}

/** Fixed horizontal cost outside the three content columns. */
export function fixedChromeWidth(leftCollapsed: boolean, rightCollapsed: boolean): number {
  let w = LAYOUT_BOUNDS.layoutPadX;
  if (!leftCollapsed) w += LAYOUT_BOUNDS.splitterWidth;
  if (!rightCollapsed) w += LAYOUT_BOUNDS.splitterWidth;
  return w;
}

function centerWidthFor(
  available: number,
  leftCollapsed: boolean,
  rightCollapsed: boolean,
  leftWidth: number,
  rightWidth: number
): number {
  const chrome = fixedChromeWidth(leftCollapsed, rightCollapsed);
  const sides = (leftCollapsed ? 0 : leftWidth) + (rightCollapsed ? 0 : rightWidth);
  return available - chrome - sides;
}

/**
 * Resolve displayed widths for a viewport.
 * User prefs win for explicit collapse; if both side panels would crush the
 * center below centerMin, the right panel auto-collapses (ephemeral).
 */
export function computeEffectiveLayout(
  prefs: MainLayoutPrefs,
  viewportWidth: number
): EffectiveMainLayout {
  const normalized = normalizeLayoutPrefs(prefs);
  let leftCollapsed = normalized.leftCollapsed;
  let rightCollapsed = normalized.rightCollapsed;
  let leftWidth = normalized.leftWidth;
  let rightWidth = normalized.rightWidth;
  let autoCollapsedRight = false;

  const available = Math.max(0, Math.round(viewportWidth));

  // Prefer collapsing the inspector when the editor would become unreadable.
  if (
    !leftCollapsed &&
    !rightCollapsed &&
    centerWidthFor(available, false, false, leftWidth, rightWidth) < LAYOUT_BOUNDS.centerMin
  ) {
    rightCollapsed = true;
    autoCollapsedRight = true;
  }

  // Shrink open side panels toward min when the center would still be too tight.
  if (!leftCollapsed && rightCollapsed) {
    const roomForLeft =
      available - fixedChromeWidth(false, true) - LAYOUT_BOUNDS.centerMin;
    if (roomForLeft < leftWidth) {
      leftWidth = clampWidth(roomForLeft, LAYOUT_BOUNDS.leftMin, LAYOUT_BOUNDS.leftMax);
    }
  } else if (leftCollapsed && !rightCollapsed) {
    const roomForRight =
      available - fixedChromeWidth(true, false) - LAYOUT_BOUNDS.centerMin;
    if (roomForRight < rightWidth) {
      if (roomForRight < LAYOUT_BOUNDS.rightMin) {
        rightCollapsed = true;
        autoCollapsedRight = true;
      } else {
        rightWidth = clampWidth(roomForRight, LAYOUT_BOUNDS.rightMin, LAYOUT_BOUNDS.rightMax);
      }
    }
  } else if (!leftCollapsed && !rightCollapsed) {
    const roomForLeft =
      available - fixedChromeWidth(false, false) - rightWidth - LAYOUT_BOUNDS.centerMin;
    if (roomForLeft < leftWidth) {
      leftWidth = clampWidth(roomForLeft, LAYOUT_BOUNDS.leftMin, LAYOUT_BOUNDS.leftMax);
      if (
        centerWidthFor(available, false, false, leftWidth, rightWidth) < LAYOUT_BOUNDS.centerMin
      ) {
        rightCollapsed = true;
        autoCollapsedRight = true;
        const roomLeftOnly =
          available - fixedChromeWidth(false, true) - LAYOUT_BOUNDS.centerMin;
        leftWidth = clampWidth(
          Math.min(normalized.leftWidth, roomLeftOnly),
          LAYOUT_BOUNDS.leftMin,
          LAYOUT_BOUNDS.leftMax
        );
      }
    }
  }

  const centerWidth = Math.max(
    0,
    centerWidthFor(available, leftCollapsed, rightCollapsed, leftWidth, rightWidth)
  );

  return {
    leftWidth,
    rightWidth,
    leftCollapsed,
    rightCollapsed,
    centerWidth,
    autoCollapsedRight,
  };
}

/**
 * Cap a side width so the center keeps centerMin when the other side is open.
 * If the budget is already below the side's min, stay at min (auto-collapse handles display).
 */
function capSideForCenter(
  sideWidth: number,
  sideMin: number,
  sideMax: number,
  maxForCenter: number
): number {
  if (!Number.isFinite(maxForCenter)) {
    return clampWidth(sideWidth, sideMin, sideMax);
  }
  if (maxForCenter < sideMin) {
    return sideMin;
  }
  return clampWidth(Math.min(sideWidth, maxForCenter), sideMin, sideMax);
}

/** Apply a drag delta to one side while keeping the center readable when possible. */
export function resizeSide(
  prefs: MainLayoutPrefs,
  side: "left" | "right",
  nextWidth: number,
  viewportWidth: number
): MainLayoutPrefs {
  const normalized = normalizeLayoutPrefs(prefs);
  if (side === "left") {
    let leftWidth = clampWidth(nextWidth, LAYOUT_BOUNDS.leftMin, LAYOUT_BOUNDS.leftMax);
    if (!normalized.rightCollapsed) {
      const maxLeft =
        viewportWidth -
        fixedChromeWidth(false, false) -
        normalized.rightWidth -
        LAYOUT_BOUNDS.centerMin;
      leftWidth = capSideForCenter(
        leftWidth,
        LAYOUT_BOUNDS.leftMin,
        LAYOUT_BOUNDS.leftMax,
        maxLeft
      );
    } else {
      const maxLeft =
        viewportWidth - fixedChromeWidth(false, true) - LAYOUT_BOUNDS.centerMin;
      leftWidth = capSideForCenter(
        leftWidth,
        LAYOUT_BOUNDS.leftMin,
        LAYOUT_BOUNDS.leftMax,
        maxLeft
      );
    }
    return { ...normalized, leftWidth, leftCollapsed: false };
  }

  let rightWidth = clampWidth(nextWidth, LAYOUT_BOUNDS.rightMin, LAYOUT_BOUNDS.rightMax);
  if (!normalized.leftCollapsed) {
    const maxRight =
      viewportWidth -
      fixedChromeWidth(false, false) -
      normalized.leftWidth -
      LAYOUT_BOUNDS.centerMin;
    rightWidth = capSideForCenter(
      rightWidth,
      LAYOUT_BOUNDS.rightMin,
      LAYOUT_BOUNDS.rightMax,
      maxRight
    );
  } else {
    const maxRight =
      viewportWidth - fixedChromeWidth(true, false) - LAYOUT_BOUNDS.centerMin;
    rightWidth = capSideForCenter(
      rightWidth,
      LAYOUT_BOUNDS.rightMin,
      LAYOUT_BOUNDS.rightMax,
      maxRight
    );
  }
  return { ...normalized, rightWidth, rightCollapsed: false };
}

export function toggleCollapsed(prefs: MainLayoutPrefs, side: "left" | "right"): MainLayoutPrefs {
  const normalized = normalizeLayoutPrefs(prefs);
  if (side === "left") {
    return { ...normalized, leftCollapsed: !normalized.leftCollapsed };
  }
  return { ...normalized, rightCollapsed: !normalized.rightCollapsed };
}

export function stepResize(
  prefs: MainLayoutPrefs,
  side: "left" | "right",
  direction: -1 | 1,
  viewportWidth: number,
  step = LAYOUT_BOUNDS.resizeStep
): MainLayoutPrefs {
  const normalized = normalizeLayoutPrefs(prefs);
  const current = side === "left" ? normalized.leftWidth : normalized.rightWidth;
  return resizeSide(prefs, side, current + direction * step, viewportWidth);
}
