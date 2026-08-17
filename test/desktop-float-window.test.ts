import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import type { DesktopPreferences } from "../src/desktop/types.js";
import {
  FLOAT_WINDOW_BOUNDS,
  normalizeFloatWindowBounds,
} from "../src/desktop/main/float-window-layout.js";
import { FloatWindowBoundsPersistence } from "../src/desktop/main/float-window-persistence.js";

const root = process.cwd();

test("floating control clamps stale oversized and offscreen preferences", () => {
  const bounds = normalizeFloatWindowBounds(
    { x: 5000, y: -5000, width: 480, height: 420 },
    { x: 0, y: 0, width: 1920, height: 1040 }
  );
  assert.deepEqual(bounds, {
    x: 1920 - FLOAT_WINDOW_BOUNDS.maxWidth,
    y: 0,
    width: FLOAT_WINDOW_BOUNDS.maxWidth,
    height: FLOAT_WINDOW_BOUNDS.maxHeight,
  });
});

test("floating control defaults to a compact top-right panel", () => {
  assert.deepEqual(
    normalizeFloatWindowBounds(undefined, { x: 0, y: 0, width: 1920, height: 1040 }),
    {
      x: 1920 - FLOAT_WINDOW_BOUNDS.defaultWidth - FLOAT_WINDOW_BOUNDS.edgeMargin,
      y: FLOAT_WINDOW_BOUNDS.edgeMargin,
      width: FLOAT_WINDOW_BOUNDS.defaultWidth,
      height: FLOAT_WINDOW_BOUNDS.defaultHeight,
    }
  );
});

test("floating control preserves valid bounds on a secondary display", () => {
  assert.deepEqual(
    normalizeFloatWindowBounds(
      { x: -1180, y: 80, width: 340, height: 300 },
      { x: -1280, y: 0, width: 1280, height: 984 }
    ),
    { x: -1180, y: 80, width: 340, height: 300 }
  );
});

test("floating bounds writes serialize and the newest captured bounds win", async () => {
  let persisted: DesktopPreferences = {
    recentWorkspaces: ["C:\\workspace"],
    lastWorkspaceRoot: "C:\\workspace",
    showFloatOnClose: false,
  };
  let saveCount = 0;
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const serializedWrites: string[] = [];
  const persistence = new FloatWindowBoundsPersistence({
    delayMs: 5,
    loadPrefs: async () => ({ ...persisted }),
    savePrefs: async (next) => {
      saveCount += 1;
      const serialized = JSON.stringify(next);
      serializedWrites.push(serialized);
      if (saveCount === 1) {
        markFirstStarted();
        await firstRelease;
      }
      persisted = JSON.parse(serialized);
    },
  });

  persistence.schedule({ x: 10, y: 20, width: 320, height: 260 });
  const firstFlush = persistence.flush();
  await firstStarted;
  persistence.schedule({ x: 120, y: 140, width: 340, height: 300 });
  const closeFlush = persistence.flush();
  releaseFirst();
  await Promise.all([firstFlush, closeFlush]);

  assert.equal(saveCount, 2);
  assert.deepEqual(persisted.floatWindowBounds, {
    x: 120,
    y: 140,
    width: 340,
    height: 300,
  });
  assert.deepEqual(persisted.recentWorkspaces, ["C:\\workspace"]);
  assert.equal(persisted.lastWorkspaceRoot, "C:\\workspace");
  assert.equal(persisted.showFloatOnClose, false);
  for (const serialized of serializedWrites) assert.doesNotThrow(() => JSON.parse(serialized));
});

test("flush deterministically commits a debounced final move exactly once", async () => {
  let savedBounds: unknown;
  let saveCount = 0;
  const persistence = new FloatWindowBoundsPersistence({
    delayMs: 20,
    loadPrefs: async () => ({ recentWorkspaces: [], showFloatOnClose: true }),
    savePrefs: async (next) => {
      saveCount += 1;
      savedBounds = next.floatWindowBounds;
    },
  });

  persistence.schedule({ x: -1100, y: 60, width: 328, height: 280 });
  await persistence.flush();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await persistence.flush();

  assert.equal(saveCount, 1);
  assert.deepEqual(savedBounds, { x: -1100, y: 60, width: 328, height: 280 });
});

test("floating control has an honest, draggable, recoverable surface", async () => {
  const renderer = path.join(root, "src", "desktop", "renderer");
  const html = await fs.readFile(path.join(renderer, "float.html"), "utf8");
  const css = await fs.readFile(path.join(renderer, "float.css"), "utf8");
  const ui = await fs.readFile(path.join(renderer, "float-ui.ts"), "utf8");
  const main = await fs.readFile(path.join(root, "src", "desktop", "main", "index.ts"), "utf8");
  const windows = await fs.readFile(
    path.join(root, "src", "desktop", "main", "windows.ts"),
    "utf8"
  );
  const build = await fs.readFile(path.join(root, "scripts", "build-desktop.mjs"), "utf8");

  assert.match(html, /href="\.\/float\.css"/);
  assert.match(html, /id="btn-hide-float"[^>]*aria-label="隐藏浮动控件"/);
  assert.match(html, /aria-label="浮动通知"/);
  assert.match(html, /任务包在主界面/);
  assert.doesNotMatch(html, /<form|<textarea|package-submit/);
  assert.doesNotMatch(html, /style=/);
  assert.match(css, /\.float-head\s*\{[^}]*-webkit-app-region:\s*drag/s);
  assert.match(css, /\.float-head-actions\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  assert.match(css, /\.float-context\s*\{[^}]*overflow:\s*auto/s);
  assert.match(ui, /refreshInFlight/);
  assert.match(ui, /状态不可用/);
  assert.match(ui, /window\.tentDesktop\.openMain\(\)/);
  assert.match(ui, /event\.key !== "Escape"/);
  assert.doesNotMatch(ui, /dispatchTask|taskPackageDraft|taskPackageDetached/);
  assert.doesNotMatch(ui, /await window\.tentDesktop\.hideFloat/);
  assert.match(
    main,
    /await waitUntilMainWindowReady\(mainWindow\);[\s\S]*mainWindow\.focus\(\);\s*floatWindow\?\.hide\(\);/
  );
  assert.match(main, /readyMainWindows\.has\(win\)/);
  assert.match(main, /did-fail-load/);
  assert.match(main, /Main window finished loading without becoming ready/);
  assert.match(main, /floatWindow\.on\("move", scheduleFloatBoundsSave\)/);
  assert.match(main, /floatWindow\.on\("resize", scheduleFloatBoundsSave\)/);
  assert.match(main, /normalizeFloatWindowBounds\(currentBounds, workArea\)/);
  assert.match(main, /floatWindow\.on\("closed"/);
  assert.match(main, /event\.preventDefault\(\)/);
  assert.match(main, /floatBoundsPersistence\.flush\(\)/);
  assert.match(windows, /screen\.getDisplayMatching\(savedBounds\)/);
  assert.match(build, /"float\.css"/);
});
