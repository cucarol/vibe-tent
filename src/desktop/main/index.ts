// Electron main entry — Tent Desktop Shell.
// Security: contextIsolation on, nodeIntegration off; service outlives windows.

import * as path from "node:path";
import { app, BrowserWindow, Tray, Menu, nativeImage, screen } from "electron";
import { DesktopServiceHost } from "./service-host.js";
import { createFloatWindow, createMainWindow, resolveDesktopAssetPaths } from "./windows.js";
import { registerDesktopIpc } from "./ipc.js";
import { DesktopShellModel } from "../workbench/shell-model.js";
import { loadDesktopPrefs, saveDesktopPrefs, rememberWorkspace } from "../prefs.js";
import { defaultServiceDataDir } from "../../service/data-dir.js";
import { DESKTOP_IPC } from "../types.js";
import { refreshDesktopShellForEvent } from "./service-event-refresh.js";
import { normalizeFloatWindowBounds } from "./float-window-layout.js";
import { FloatWindowBoundsPersistence } from "./float-window-persistence.js";

const isDev = !app.isPackaged;
const appRoot = isDev ? process.cwd() : app.getAppPath();
const serviceRoot = isDev ? process.cwd() : process.resourcesPath;
const dataDir = process.env.TENT_SERVICE_DATA_DIR || defaultServiceDataDir();

let mainWindow: BrowserWindow | null = null;
let floatWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let floatBoundsPersistence: FloatWindowBoundsPersistence | null = null;
let quitAfterFloatBoundsFlush = false;
const readyMainWindows = new WeakSet<BrowserWindow>();

const host = new DesktopServiceHost();
const model = new DesktopShellModel();

function captureCurrentFloatBounds() {
  if (!floatWindow || floatWindow.isDestroyed()) return;
  const currentBounds = floatWindow.getBounds();
  const workArea = screen.getDisplayMatching(currentBounds).workArea;
  return normalizeFloatWindowBounds(currentBounds, workArea);
}

async function waitUntilMainWindowReady(win: BrowserWindow): Promise<void> {
  if (readyMainWindows.has(win)) return;
  if (!win.webContents.isLoadingMainFrame()) {
    throw new Error("Main window finished loading without becoming ready");
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      win.removeListener("ready-to-show", onReady);
      win.removeListener("closed", onClosed);
      win.webContents.removeListener("did-fail-load", onFailed);
    };
    const onReady = () => {
      readyMainWindows.add(win);
      cleanup();
      resolve();
    };
    const onClosed = () => {
      cleanup();
      reject(new Error("Main window closed before it was ready"));
    };
    const onFailed = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean
    ) => {
      if (!isMainFrame) return;
      cleanup();
      reject(new Error(`Main window failed to load (${errorCode}): ${errorDescription}`));
    };
    win.once("ready-to-show", onReady);
    win.once("closed", onClosed);
    win.webContents.on("did-fail-load", onFailed);
  });
}

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
  const makeMainWindow = () => {
    const win = createMainWindow(paths, prefs, isDev);
    win.once("ready-to-show", () => {
      readyMainWindows.add(win);
    });
    win.webContents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) readyMainWindows.delete(win);
    });
    return win;
  };

  mainWindow = makeMainWindow();
  floatWindow = createFloatWindow(paths, prefs);
  const boundsPersistence = new FloatWindowBoundsPersistence({
    loadPrefs: () => loadDesktopPrefs(dataDir),
    savePrefs: (next) => saveDesktopPrefs(next, dataDir),
    onError: (error) => {
      console.warn("Failed to persist floating control bounds:", error);
    },
  });
  floatBoundsPersistence = boundsPersistence;

  const showMainWindow = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = makeMainWindow();
    }
    await waitUntilMainWindowReady(mainWindow);
    if (mainWindow.isDestroyed()) {
      throw new Error("Main window is unavailable");
    }
    mainWindow.show();
    mainWindow.focus();
    floatWindow?.hide();
  };

  const scheduleFloatBoundsSave = () => {
    const bounds = captureCurrentFloatBounds();
    if (bounds) boundsPersistence.schedule(bounds);
  };

  floatWindow.on("move", scheduleFloatBoundsSave);
  floatWindow.on("resize", scheduleFloatBoundsSave);
  floatWindow.on("closed", () => {
    floatWindow = null;
    void boundsPersistence.flush()
      .catch(() => undefined)
      .finally(() => {
        if (floatBoundsPersistence === boundsPersistence) {
          floatBoundsPersistence = null;
        }
      });
  });

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
    openMain: showMainWindow,
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
    // Invalidation must not wait for the legacy shell snapshot. The production
    // renderer owns its named re-reads and stays fail-closed on their result.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(DESKTOP_IPC.onServiceEvent, {
        type: ev.type,
        workspaceId: ev.workspaceId,
      });
    }
    void refreshDesktopShellForEvent(model, ev.type).then((changed) => {
      const snap = model.getSnapshot();
      // Product projection events do not make the main-window bootstrap stale.
      // The floating control still gets a narrow wake-up and performs its own
      // explicit getFloatingStatus read, preserving its live task counters.
      const windows = changed
        ? BrowserWindow.getAllWindows()
        : floatWindow && !floatWindow.isDestroyed()
          ? [floatWindow]
          : [];
      for (const win of windows) {
        if (win.isDestroyed()) continue;
        win.webContents.send(DESKTOP_IPC.onStateChanged, snap);
      }
    }).catch((error) => {
      console.warn("Desktop shell snapshot refresh failed after Service event:", error);
    });
  });

  createTray(paths, () => {
    void showMainWindow().catch((error) => {
      console.warn("Failed to open main window:", error);
    });
  });

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

function createTray(
  _paths: ReturnType<typeof resolveDesktopAssetPaths>,
  showMainWindow: () => void
): void {
  // 16x16 simple tray icon as data URL PNG is heavy; use empty and set title on Windows.
  const img = nativeImage.createEmpty();
  tray = new Tray(img.isEmpty() ? nativeImage.createFromDataURL(TINY_PNG) : img);
  tray.setToolTip("帷幄 · Tent");
  const menu = Menu.buildFromTemplate([
    {
      label: "打开主界面",
      click: showMainWindow,
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
  tray.on("click", showMainWindow);
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

app.on("before-quit", (event) => {
  quitting = true;
  if (quitAfterFloatBoundsFlush || !floatBoundsPersistence) return;
  event.preventDefault();
  quitAfterFloatBoundsFlush = true;
  void floatBoundsPersistence.flush()
    .catch((error) => {
      console.warn("Failed to flush floating control bounds before quit:", error);
    })
    .finally(() => app.quit());
});

// Ensure single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      floatWindow?.hide();
    }
  });
}
