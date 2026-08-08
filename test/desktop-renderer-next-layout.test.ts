import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import {
  getBrowserLayoutStorage,
  MainLayoutController,
} from "../src/desktop/renderer-next/model/use-main-layout.js";
import {
  LAYOUT_STORAGE_KEY,
  defaultLayoutPrefs,
} from "../src/desktop/workbench/layout-prefs.js";

type FakeStorage = {
  data: Record<string, string>;
  writes: string[];
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function storage(seed?: string): FakeStorage {
  return {
    data: seed === undefined ? {} : { [LAYOUT_STORAGE_KEY]: seed },
    writes: [],
    getItem(key) {
      return this.data[key] ?? null;
    },
    setItem(key, value) {
      this.data[key] = value;
      this.writes.push(value);
    },
  };
}

function savedPrefs(store: FakeStorage) {
  return JSON.parse(store.data[LAYOUT_STORAGE_KEY]!) as ReturnType<typeof defaultLayoutPrefs>;
}

test("renderer-next layout initializes from saved preferences", () => {
  const store = storage(JSON.stringify({
    leftWidth: 333,
    rightWidth: 444,
    leftCollapsed: true,
    rightCollapsed: false,
  }));
  const controller = new MainLayoutController(store, 1400);

  assert.deepEqual(controller.getSnapshot().prefs, {
    leftWidth: 333,
    rightWidth: 444,
    leftCollapsed: true,
    rightCollapsed: false,
  });
  assert.equal(controller.getSnapshot().effective.leftCollapsed, true);
  assert.equal(controller.getSnapshot().effective.rightCollapsed, false);
  assert.equal(store.writes.length, 0);
});

test("renderer-next explicit left and right toggles write once and preserve widths", () => {
  const store = storage();
  store.data[LAYOUT_STORAGE_KEY] = JSON.stringify({
    ...defaultLayoutPrefs(),
    leftWidth: 301,
    rightWidth: 407,
  });
  const controller = new MainLayoutController(store, 1400);

  controller.toggle("left");
  controller.toggle("right");

  assert.equal(store.writes.length, 2);
  assert.deepEqual(savedPrefs(store), {
    leftWidth: 301,
    rightWidth: 407,
    leftCollapsed: true,
    rightCollapsed: true,
  });
});

test("renderer-next layout reload restores both explicit collapse choices", () => {
  const store = storage();
  const first = new MainLayoutController(store, 1400);
  first.toggle("left");
  first.toggle("right");

  const reloaded = new MainLayoutController(store, 1400);
  assert.equal(reloaded.getSnapshot().prefs.leftCollapsed, true);
  assert.equal(reloaded.getSnapshot().prefs.rightCollapsed, true);
});

test("renderer-next layout falls back for malformed and throwing storage", () => {
  const malformed = storage("not-json");
  assert.deepEqual(
    new MainLayoutController(malformed, 1400).getSnapshot().prefs,
    defaultLayoutPrefs()
  );

  const throwing: FakeStorage = {
    data: {},
    writes: [],
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {
      throw new Error("storage blocked");
    },
  };
  const controller = new MainLayoutController(throwing, 1400);
  assert.deepEqual(controller.getSnapshot().prefs, defaultLayoutPrefs());
  assert.doesNotThrow(() => controller.toggle("left"));
  assert.equal(controller.getSnapshot().prefs.leftCollapsed, true);
});

test("renderer-next guards a throwing window.localStorage getter", () => {
  const globalObject = globalThis as typeof globalThis & { window?: unknown };
  const descriptor = Object.getOwnPropertyDescriptor(globalObject, "window");
  Object.defineProperty(globalObject, "window", {
    configurable: true,
    get() {
      throw new Error("localStorage getter blocked");
    },
  });
  try {
    assert.equal(getBrowserLayoutStorage(), null);
  } finally {
    if (descriptor) Object.defineProperty(globalObject, "window", descriptor);
    else Reflect.deleteProperty(globalObject, "window");
  }
});

test("renderer-next automatic right collapse is ephemeral and reopens when widened", () => {
  const store = storage();
  const controller = new MainLayoutController(store, 900);
  const narrow = controller.getSnapshot();

  assert.equal(narrow.effective.rightCollapsed, true);
  assert.equal(narrow.effective.autoCollapsedRight, true);
  assert.equal(narrow.prefs.rightCollapsed, false);
  assert.equal(store.writes.length, 0);

  controller.setViewportWidth(1400);
  assert.equal(controller.getSnapshot().effective.rightCollapsed, false);
  assert.equal(controller.getSnapshot().prefs.rightCollapsed, false);
  assert.equal(store.writes.length, 0);
});

test("renderer-next restore commands clear explicit collapse without toggling it back", () => {
  const store = storage();
  const controller = new MainLayoutController(store, 1400);
  controller.collapse("right");
  controller.restore("right");
  assert.equal(controller.getSnapshot().prefs.rightCollapsed, false);
  assert.equal(controller.getSnapshot().effective.rightCollapsed, false);
  assert.equal(savedPrefs(store).rightCollapsed, false);
  assert.equal(store.writes.length, 2);
});

test("ordinary Canvas and Outline selection does not open either pane", async () => {
  const shell = await fs.readFile(
    path.join(process.cwd(), "src/desktop/renderer-next/shell/AppShell.tsx"),
    "utf8"
  );
  const canvasSelection = shell.slice(
    shell.indexOf("const selectNodeFromCanvas"),
    shell.indexOf("const selectNodeFromOutline")
  );
  const outlineSelection = shell.slice(
    shell.indexOf("const selectNodeFromOutline"),
    shell.indexOf("const updateDocument")
  );
  assert.doesNotMatch(canvasSelection, /layout\.(toggle|restore|collapse)\(/);
  assert.doesNotMatch(outlineSelection, /layout\.(toggle|restore|collapse)\(/);
});

test("Outline ordinary rows stay dense while selected rows retain type and full-title access", async () => {
  const outline = await fs.readFile(
    path.join(process.cwd(), "src/desktop/renderer-next/components/OutlinePanel.tsx"),
    "utf8"
  );
  const css = await fs.readFile(
    path.join(process.cwd(), "src/desktop/renderer-next/styles/shell.css"),
    "utf8"
  );
  assert.match(outline, /role="treeitem"/);
  assert.match(outline, /title=\{nodeTitle\(node\)\}/);
  assert.match(outline, /selected \? <span className="tn-outline-meta">/);
  assert.match(outline, /selected && projectionReady && node\.activeTaskState/);
  assert.match(css, /\.tn-outline-node\s*\{[^}]*min-height: 32px;/s);
  assert.match(css, /\.tn-outline-copy\s*\{[^}]*display: block;/s);
  assert.match(css, /\.tn-outline-node\[data-selected="true"\] \.tn-outline-copy\s*\{[^}]*display: grid;/s);
  assert.match(css, /\.tn-outline-title\s*\{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
});
