/**
 * Document open-tab close: active fallback, final empty, keyboard shortcut, chrome landmarks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeOpenTab,
  documentEmptyCopy,
  isCloseTabShortcut,
  resolveActiveAfterClose,
} from "../src/desktop/workbench/open-tabs.js";

test("resolveActiveAfterClose prefers left neighbor then right", () => {
  const order = ["a", "b", "c"];
  assert.equal(resolveActiveAfterClose(order, "b", "b"), "a");
  assert.equal(resolveActiveAfterClose(order, "a", "a"), "b");
  assert.equal(resolveActiveAfterClose(order, "c", "c"), "b");
});

test("resolveActiveAfterClose keeps active when closing another tab", () => {
  assert.equal(resolveActiveAfterClose(["a", "b", "c"], "a", "c"), "c");
  assert.equal(resolveActiveAfterClose(["a", "b", "c"], "b", "c"), "c");
});

test("resolveActiveAfterClose last tab yields null", () => {
  assert.equal(resolveActiveAfterClose(["only"], "only", "only"), null);
  assert.equal(resolveActiveAfterClose(["only"], "only", null), null);
});

test("closeOpenTab removes id and recomputes active", () => {
  const closed = closeOpenTab(["a", "b", "c"], "b", "b");
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.order, ["a", "c"]);
  assert.equal(closed.activeCx, "a");

  const last = closeOpenTab(["a"], "a", "a");
  assert.deepEqual(last.order, []);
  assert.equal(last.activeCx, null);

  const missing = closeOpenTab(["a"], "z", "a");
  assert.equal(missing.closed, false);
  assert.deepEqual(missing.order, ["a"]);
  assert.equal(missing.activeCx, "a");
});

test("documentEmptyCopy distinguishes workspace vs open-doc empty", () => {
  const noWs = documentEmptyCopy(false);
  assert.equal(noWs.title, "打开工作区");
  assert.equal(noWs.action, "open-workspace");
  assert.ok(noWs.hint);

  const emptyDocs = documentEmptyCopy(true);
  assert.equal(emptyDocs.title, "未打开文档");
  assert.equal(emptyDocs.action, null);
  assert.match(emptyDocs.hint || "", /Nodes/);
});

test("isCloseTabShortcut matches Ctrl/Cmd+W only", () => {
  assert.equal(
    isCloseTabShortcut({ key: "w", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }),
    true
  );
  assert.equal(
    isCloseTabShortcut({ key: "W", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }),
    true
  );
  assert.equal(
    isCloseTabShortcut({ key: "w", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }),
    false
  );
  assert.equal(
    isCloseTabShortcut({ key: "w", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }),
    false
  );
  assert.equal(
    isCloseTabShortcut({ key: "1", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }),
    false
  );
});

test("document tab strip exposes close controls and empty-state copy in source", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = process.cwd();
  const documentTs = await fs.readFile(
    path.join(root, "src/desktop/renderer/main/document.ts"),
    "utf8"
  );
  const openTabsTs = await fs.readFile(
    path.join(root, "src/desktop/workbench/open-tabs.ts"),
    "utf8"
  );
  const documentCss = await fs.readFile(
    path.join(root, "src/desktop/renderer/styles/document.css"),
    "utf8"
  );
  const html = await fs.readFile(path.join(root, "src/desktop/renderer/index.html"), "utf8");

  assert.match(documentTs, /data-close-tab/);
  assert.match(documentTs, /closeTab/);
  assert.match(documentTs, /documentTabHtml/);
  assert.match(documentTs, /documentEmptyCopy/);
  assert.match(documentTs, /data-empty-act="open-ws"/);
  assert.match(openTabsTs, /未打开文档/);
  assert.match(openTabsTs, /open-workspace/);
  assert.match(documentCss, /\.tab-close\b/);
  assert.match(documentCss, /focus-visible/);
  assert.match(documentCss, /var\(--size-tab-close\)/);
  assert.match(html, /id="main-panel"[^>]*tabindex="-1"/);
});

test("layout chrome keeps user collapse distinct from narrow auto-collapse", async () => {
  const {
    computeEffectiveLayout,
    defaultLayoutPrefs,
    toggleCollapsed,
    saveLayoutPrefs,
    loadLayoutPrefs,
    LAYOUT_STORAGE_KEY,
  } = await import("../src/desktop/workbench/layout-prefs.js");

  const storage: { data: Record<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } = {
    data: {},
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k]! : null;
    },
    setItem(k, v) {
      this.data[k] = v;
    },
  };

  const userLeft = toggleCollapsed(defaultLayoutPrefs(), "left");
  saveLayoutPrefs(storage, userLeft);
  const loaded = loadLayoutPrefs(storage);
  assert.equal(loaded.leftCollapsed, true);
  assert.ok(storage.data[LAYOUT_STORAGE_KEY]);

  // Narrow viewport auto-collapses right without mutating user prefs.
  const prefs = defaultLayoutPrefs();
  const effective = computeEffectiveLayout(prefs, 900);
  assert.equal(effective.rightCollapsed, true);
  assert.equal(effective.autoCollapsedRight, true);
  assert.equal(prefs.rightCollapsed, false);

  // User explicit right collapse is not flagged auto.
  const userRight = { ...defaultLayoutPrefs(), rightCollapsed: true };
  const effUser = computeEffectiveLayout(userRight, 1400);
  assert.equal(effUser.rightCollapsed, true);
  assert.equal(effUser.autoCollapsedRight, false);
});

test("layout.ts wires collapse/expand and Escape exit for temporary surfaces", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const layoutTs = await fs.readFile(
    path.join(process.cwd(), "src/desktop/renderer/main/layout.ts"),
    "utf8"
  );
  assert.match(layoutTs, /btnCollapseLeft/);
  assert.match(layoutTs, /btnExpandLeft/);
  assert.match(layoutTs, /btnCollapseRight/);
  assert.match(layoutTs, /btnExpandRight/);
  assert.match(layoutTs, /toggleCollapsed/);
  assert.match(layoutTs, /layoutPrefs\.leftCollapsed/);
  assert.match(layoutTs, /auto-collapse|autoCollapsed|user-collapsed/i);
  assert.match(layoutTs, /Escape/);
  assert.match(layoutTs, /closeChromePopovers/);
  assert.match(layoutTs, /searchDrawer/);
  assert.match(layoutTs, /createDrawer/);
  assert.match(layoutTs, /railOverflow/);
});
