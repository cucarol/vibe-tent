// Electron main entry — Tent Desktop Shell (B5).
// Security: contextIsolation on, nodeIntegration off; service outlives windows.

import * as path from "node:path";
import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import { DesktopServiceHost } from "./service-host.js";
import { createFloatWindow, createMainWindow, resolveDesktopAssetPaths } from "./windows.js";
import { registerDesktopIpc } from "./ipc.js";
import { DesktopShellModel } from "../workbench/shell-model.js";
import { loadDesktopPrefs, saveDesktopPrefs, rememberWorkspace } from "../prefs.js";
import { defaultServiceDataDir } from "../../service/data-dir.js";
import { DESKTOP_IPC } from "../types.js";

const isDev = !app.isPackaged;
const appRoot = isDev ? process.cwd() : app.getAppPath();
const serviceRoot = isDev ? process.cwd() : process.resourcesPath;
const dataDir = process.env.TENT_SERVICE_DATA_DIR || defaultServiceDataDir();

let mainWindow: BrowserWindow | null = null;
let floatWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const host = new DesktopServiceHost();
const model = new DesktopShellModel();

async function bootstrap(): Promise<void> {
  const serviceEntry =
    process.env.TENT_SERVICE_ENTRY ||
    path.join(serviceRoot, "service.mjs");

  const attach = await host.ensureAttached({
    dataDir,
    serviceEntry,
    cwd: serviceRoot,
  });
  model.setRpc(attach.client);
  await model.refreshHealth();

  const prefs = await loadDesktopPrefs(dataDir);
  if (prefs.lastWorkspaceRoot) {
    try {
      await model.mountWorkspace(prefs.lastWorkspaceRoot);
    } catch (err) {
      console.warn("Failed to remount last workspace:", err);
    }
  }

  const paths = resolveDesktopAssetPaths(appRoot);
  mainWindow = createMainWindow(paths, prefs, isDev);
  floatWindow = createFloatWindow(paths, prefs);

  mainWindow.on("close", (e: { preventDefault: () => void }) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow?.hide();
    if (prefs.showFloatOnClose !== false) {
      floatWindow?.show();
    }
  });

  mainWindow.on("minimize", () => {
    // Keep float available as lightweight control.
  });

  registerDesktopIpc({
    host,
    model,
    dataDir,
    getMainWindow: () => mainWindow,
    getFloatWindow: () => floatWindow,
    openMain: () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createMainWindow(paths, prefs, isDev);
      }
      mainWindow.show();
      mainWindow.focus();
    },
    showFloat: () => {
      floatWindow?.show();
    },
    hideFloat: () => {
      floatWindow?.hide();
    },
    hideMain: () => {
      mainWindow?.hide();
      if (prefs.showFloatOnClose !== false) floatWindow?.show();
    },
    broadcastState: () => {
      const snap = model.getSnapshot();
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(DESKTOP_IPC.onStateChanged, snap);
      }
    },
  });

  // SSE → IPC: renderer re-fetches projections; main does not invent UI state.
  host.onServiceEvent((ev) => {
    // Invalidation must not wait for the legacy shell snapshot. The protocol-4
    // renderer owns its named re-reads and stays fail-closed on their result.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(DESKTOP_IPC.onServiceEvent, {
        type: ev.type,
        workspaceId: ev.workspaceId,
      });
    }
    const refresh =
      ev.type === "workspace.switched" || ev.type === "service.health"
        ? Promise.all([model.refreshHealth(), model.refreshWorkspaces()])
        : model.refreshTasks();
    void refresh.then(() => {
      const snap = model.getSnapshot();
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send(DESKTOP_IPC.onStateChanged, snap);
      }
    }).catch((error) => {
      console.warn("Desktop shell snapshot refresh failed after Service event:", error);
    });
  });

  createTray(paths);

  // Optional CLI arg: tent-desktop --mount <workspace>
  const mountIdx = process.argv.indexOf("--mount");
  if (mountIdx >= 0 && process.argv[mountIdx + 1]) {
    const root = path.resolve(process.argv[mountIdx + 1]);
    try {
      await model.mountWorkspace(root);
      const next = rememberWorkspace(await loadDesktopPrefs(dataDir), root);
      await saveDesktopPrefs(next, dataDir);
    } catch (err) {
      console.error("Mount failed:", err);
    }
  }
}

function createTray(_paths: ReturnType<typeof resolveDesktopAssetPaths>): void {
  // 16x16 simple tray icon as data URL PNG is heavy; use empty and set title on Windows.
  const img = nativeImage.createEmpty();
  tray = new Tray(img.isEmpty() ? nativeImage.createFromDataURL(TINY_PNG) : img);
  tray.setToolTip("帷幄 · Tent");
  const menu = Menu.buildFromTemplate([
    {
      label: "打开主界面",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: "显示浮动控件",
      click: () => floatWindow?.show(),
    },
    { type: "separator" },
    {
      label: "退出界面（服务继续运行）",
      click: () => {
        quitting = true;
        void host.disposeShellOnly().then(() => app.quit());
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// 1x1 dark pixel PNG
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

app.whenReady().then(() => {
  void bootstrap().catch((err) => {
    console.error(err);
    app.quit();
  });
});

app.on("window-all-closed", () => {
  // Keep process for tray / float; user quits via tray menu.
  // Do not call app.quit() — Local Service must outlive the UI.
});

app.on("before-quit", () => {
  quitting = true;
});

// Ensure single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}
