/**
 * Desktop main layout prefs — widths, clamp, collapse, narrow auto-collapse, persistence.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LAYOUT_BOUNDS,
  LAYOUT_STORAGE_KEY,
  clampWidth,
  computeEffectiveLayout,
  defaultLayoutPrefs,
  loadLayoutPrefs,
  normalizeLayoutPrefs,
  resizeSide,
  saveLayoutPrefs,
  stepResize,
  toggleCollapsed,
  type MainLayoutPrefs,
  type StorageLike,
} from "../src/desktop/workbench/layout-prefs.js";

function memoryStorage(seed: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key]! : null;
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
  };
}

test("clampWidth bounds and non-finite fallback", () => {
  assert.equal(clampWidth(100, 220, 420), 220);
  assert.equal(clampWidth(500, 220, 420), 420);
  assert.equal(clampWidth(300.6, 220, 420), 301);
  assert.equal(clampWidth(Number.NaN, 220, 420), 220);
});

test("normalizeLayoutPrefs clamps widths and defaults booleans", () => {
  const n = normalizeLayoutPrefs({
    leftWidth: 999,
    rightWidth: 10,
    leftCollapsed: true,
    rightCollapsed: "yes" as unknown as boolean,
  });
  assert.equal(n.leftWidth, LAYOUT_BOUNDS.leftMax);
  assert.equal(n.rightWidth, LAYOUT_BOUNDS.rightMin);
  assert.equal(n.leftCollapsed, true);
  assert.equal(n.rightCollapsed, false);
});

test("load/save layout prefs round-trip via StorageLike", () => {
  const storage = memoryStorage();
  const prefs: MainLayoutPrefs = {
    leftWidth: 300,
    rightWidth: 400,
    leftCollapsed: true,
    rightCollapsed: false,
  };
  saveLayoutPrefs(storage, prefs);
  assert.ok(storage.data[LAYOUT_STORAGE_KEY]);
  const loaded = loadLayoutPrefs(storage);
  assert.deepEqual(loaded, prefs);
});

test("loadLayoutPrefs recovers from corrupt JSON", () => {
  const storage = memoryStorage({ [LAYOUT_STORAGE_KEY]: "{not-json" });
  assert.deepEqual(loadLayoutPrefs(storage), defaultLayoutPrefs());
});

test("wide viewport keeps both side panels at preferred widths", () => {
  const prefs = defaultLayoutPrefs();
  const effective = computeEffectiveLayout(prefs, 1400);
  assert.equal(effective.leftCollapsed, false);
  assert.equal(effective.rightCollapsed, false);
  assert.equal(effective.autoCollapsedRight, false);
  assert.equal(effective.leftWidth, prefs.leftWidth);
  assert.equal(effective.rightWidth, prefs.rightWidth);
  assert.ok(effective.centerWidth >= LAYOUT_BOUNDS.centerMin);
});

test("narrow viewport auto-collapses right to protect center min width", () => {
  // 220 + 8 + 480 + 8 + 280 + pad ≈ 1016 minimum with both open at mins;
  // at ~900 the inspector should auto-collapse.
  const prefs = defaultLayoutPrefs();
  const effective = computeEffectiveLayout(prefs, 900);
  assert.equal(effective.leftCollapsed, false);
  assert.equal(effective.rightCollapsed, true);
  assert.equal(effective.autoCollapsedRight, true);
  // User preference is not mutated by computeEffectiveLayout.
  assert.equal(prefs.rightCollapsed, false);
  assert.ok(effective.centerWidth >= LAYOUT_BOUNDS.centerMin - 1);
});

test("user-collapsed right is respected without auto flag", () => {
  const prefs = { ...defaultLayoutPrefs(), rightCollapsed: true };
  const effective = computeEffectiveLayout(prefs, 1400);
  assert.equal(effective.rightCollapsed, true);
  assert.equal(effective.autoCollapsedRight, false);
});

test("toggleCollapsed flips only the requested side", () => {
  const base = defaultLayoutPrefs();
  const left = toggleCollapsed(base, "left");
  assert.equal(left.leftCollapsed, true);
  assert.equal(left.rightCollapsed, false);
  const both = toggleCollapsed(left, "right");
  assert.equal(both.leftCollapsed, true);
  assert.equal(both.rightCollapsed, true);
});

test("resizeSide clamps left within bounds and center budget", () => {
  const prefs = defaultLayoutPrefs();
  const grown = resizeSide(prefs, "left", 600, 1400);
  assert.equal(grown.leftWidth, LAYOUT_BOUNDS.leftMax);
  assert.equal(grown.leftCollapsed, false);

  const shrunk = resizeSide(prefs, "left", 100, 1400);
  assert.equal(shrunk.leftWidth, LAYOUT_BOUNDS.leftMin);

  // Dragging left too wide against a fixed right must stop before crushing center.
  // 1100px has room for both mins + centerMin, but not for leftMax + right 280.
  const tight = resizeSide(
    { ...prefs, leftWidth: 220, rightWidth: 280 },
    "left",
    420,
    1100
  );
  assert.ok(tight.leftWidth < LAYOUT_BOUNDS.leftMax);
  const center =
    1100 -
    LAYOUT_BOUNDS.layoutPadX -
    LAYOUT_BOUNDS.splitterWidth * 2 -
    tight.leftWidth -
    tight.rightWidth;
  assert.ok(center >= LAYOUT_BOUNDS.centerMin - 1);

  // When viewport already cannot host both mins + center, stay at leftMin (no further growth).
  const crushed = resizeSide(
    { ...prefs, leftWidth: 220, rightWidth: 280 },
    "left",
    420,
    900
  );
  assert.equal(crushed.leftWidth, LAYOUT_BOUNDS.leftMin);
});

test("resizeSide on right grows when dragging handle leftward (caller passes next width)", () => {
  const prefs = defaultLayoutPrefs();
  const next = resizeSide(prefs, "right", prefs.rightWidth + 40, 1400);
  assert.equal(next.rightWidth, prefs.rightWidth + 40);
});

test("stepResize moves by LAYOUT_BOUNDS.resizeStep", () => {
  const prefs = defaultLayoutPrefs();
  const next = stepResize(prefs, "left", 1, 1400);
  assert.equal(next.leftWidth, prefs.leftWidth + LAYOUT_BOUNDS.resizeStep);
});

test("index.html exposes resizable three-pane chrome landmarks", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const html = await fs.readFile(
    path.join(process.cwd(), "src/desktop/renderer/index.html"),
    "utf8"
  );
  assert.match(html, /id="main-layout"/);
  assert.match(html, /id="tree-panel"/);
  assert.match(html, /id="side-panel"/);
  assert.match(html, /id="splitter-left"/);
  assert.match(html, /id="splitter-right"/);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /id="btn-collapse-left"/);
  assert.match(html, /id="btn-collapse-right"/);
  assert.match(html, /id="btn-expand-left"/);
  assert.match(html, /id="btn-expand-right"/);
  // Hierarchy chrome: no full-width topbar; overflow keeps secondary actions.
  assert.doesNotMatch(html, /class="topbar"|id="topbar"/);
  assert.match(html, /品牌|brand|帷幄/);
  assert.match(html, /Nodes|Inspector|Document/);
  assert.match(html, /id="a2u-host"/);
  assert.match(html, /id="workspace-select"/);
  assert.match(html, /id="btn-open-ws"/);
  assert.match(html, /id="rail-overflow"/);
  assert.match(html, /id="search-drawer"/);
  assert.match(html, /id="create-drawer"/);
  assert.match(html, /id="sec-pending"/);
});

test("styles.css defines paper-edit semantic color tokens", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.join(process.cwd(), "src/desktop/renderer");
  const entry = await fs.readFile(path.join(root, "styles.css"), "utf8");
  // Layered entry imports tokens/primitives/layout/tree/document/inspector parts.
  for (const part of ["tokens", "primitives", "layout", "tree", "document", "inspector"]) {
    assert.match(entry, new RegExp(`@import\\s+"\\./styles/${part}\\.css"`));
  }
  const parts = await Promise.all(
    ["tokens", "primitives", "layout", "tree", "document", "inspector"].map((name) =>
      fs.readFile(path.join(root, "styles", `${name}.css`), "utf8")
    )
  );
  const css = parts.join("\n");
  for (const token of [
    "--color-app: #f4f1ea",
    "--color-sidebar: #f7f4ed",
    "--color-document: #fffcf7",
    "--color-surface: #fffcf7",
    "--color-text: #1c1914",
    "--color-muted: #6f685c",
    "--color-border: #e4ddd0",
    "--color-hover: #eee8dc",
    "--color-selected: #e8e0d2",
    "--color-accent: #9a3412",
    "--color-accent-soft: #f3e6dc",
    "--color-focus: #b45309",
    "--color-success: #3d6b52",
    "--color-warning: #a16207",
    "--color-danger: #9f3a3a",
    "--color-running: #4a678a",
  ]) {
    assert.ok(css.toLowerCase().includes(token.toLowerCase()), `missing token ${token}`);
  }
  assert.match(css, /\.splitter\b/);
  assert.match(css, /cursor:\s*col-resize/);
  assert.match(css, /is-left-collapsed/);
  assert.match(css, /is-right-collapsed/);
  // No yellow/amber-heavy legacy canvas as the primary app fill.
  assert.doesNotMatch(css, /--canvas-bg:\s*#e8e4d7/i);
});
