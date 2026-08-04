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
  const display = screen.getPrimaryDisplay().workArea;
  const width = prefs.floatWindowBounds?.width ?? 320;
  const height = prefs.floatWindowBounds?.height ?? 280;
  const x = prefs.floatWindowBounds?.x ?? display.x + display.width - width - 24;
  const y = prefs.floatWindowBounds?.y ?? display.y + 24;

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: "帷幄 · 浮动控件",
    backgroundColor: "#e8e4d7",
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
