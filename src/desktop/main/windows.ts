// Electron BrowserWindow factory for main workbench + floating control.

import * as path from "node:path";
import {
  BrowserWindow,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
} from "electron";
import type { DesktopPreferences } from "../types.js";
import { installDesktopNavigationPolicy } from "./navigation-policy.js";
import {
  FLOAT_WINDOW_BOUNDS,
  normalizeFloatWindowBounds,
} from "./float-window-layout.js";

export type WindowPaths = {
  preload: string;
  mainHtml: string;
  floatHtml: string;
};

export function createMainWindow(
  paths: WindowPaths,
  prefs: DesktopPreferences,
  isDev: boolean
): BrowserWindow {
  const bounds = prefs.mainWindowBounds;
  const opts: BrowserWindowConstructorOptions = {
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 840,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: "帷幄 · Tent",
    backgroundColor: "#f4f1ea",
    ...(process.platform === "win32"
      ? {
          // Let the renderer's pane headers double as the draggable title bar.
          // Native window controls remain available in the top-right overlay;
          // the application menu can still be revealed temporarily with Alt.
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "#f4f1ea",
            symbolColor: "#1c1914",
            height: 56,
          },
          autoHideMenuBar: true,
        }
      : {}),
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  };
  const win = new BrowserWindow(opts);
  installDesktopNavigationPolicy(
    win.webContents,
    paths.mainHtml,
    (url) => shell.openExternal(url)
  );
  void win.loadFile(paths.mainHtml);
  if (isDev) {
    // Optional: open DevTools when TENT_DESKTOP_DEVTOOLS=1
    if (process.env.TENT_DESKTOP_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
  }
  win.once("ready-to-show", () => win.show());
  return win;
}

export function createFloatWindow(
  paths: WindowPaths,
  prefs: DesktopPreferences
): BrowserWindow {
  const savedBounds = prefs.floatWindowBounds;
  const display = savedBounds
    ? screen.getDisplayMatching(savedBounds).workArea
    : screen.getPrimaryDisplay().workArea;
  const bounds = normalizeFloatWindowBounds(savedBounds, display);

  const win = new BrowserWindow({
    ...bounds,
    minWidth: FLOAT_WINDOW_BOUNDS.minWidth,
    maxWidth: FLOAT_WINDOW_BOUNDS.maxWidth,
    minHeight: FLOAT_WINDOW_BOUNDS.minHeight,
    maxHeight: FLOAT_WINDOW_BOUNDS.maxHeight,
    show: false,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: "帷幄 · 浮动控件",
    backgroundColor: "#f7f7f8",
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  installDesktopNavigationPolicy(
    win.webContents,
    paths.floatHtml,
    (url) => shell.openExternal(url)
  );
  void win.loadFile(paths.floatHtml);
  return win;
}

export function resolveDesktopAssetPaths(appRoot: string): WindowPaths {
  // Built layout: desktop/dist/{main,preload,renderer}
  return {
    preload: path.join(appRoot, "desktop", "dist", "preload", "preload.cjs"),
    mainHtml: path.join(appRoot, "desktop", "dist", "renderer-next", "index.html"),
    floatHtml: path.join(appRoot, "desktop", "dist", "renderer", "float.html"),
  };
}
