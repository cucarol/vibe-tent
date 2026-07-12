// Main-process IPC handlers (minimal surface for secure preload bridge).

import { BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import type { DesktopServiceHost } from "./service-host.js";
import { DesktopShellModel } from "../workbench/shell-model.js";
import {
  loadDesktopPrefs,
  rememberWorkspace,
  saveDesktopPrefs,
} from "../prefs.js";
import { DESKTOP_IPC, type DesktopPreferences, type RecentContextCard } from "../types.js";
import { contextCardToDragText, parseContextCardText } from "../../core/context-card.js";

export type IpcContext = {
  host: DesktopServiceHost;
  model: DesktopShellModel;
  dataDir?: string;
  getMainWindow: () => BrowserWindow | null;
  getFloatWindow: () => BrowserWindow | null;
  openMain: () => void;
  showFloat: () => void;
  hideFloat: () => void;
  hideMain: () => void;
  broadcastState: () => void;
};

export function registerDesktopIpc(ctx: IpcContext): void {
  ipcMain.handle(DESKTOP_IPC.getState, async () => {
    await ctx.model.refreshHealth();
    await ctx.model.refreshWorkspaces();
    if (ctx.model.getSnapshot().foregroundWorkspaceId) {
      await ctx.model.refreshTasks();
    }
    return ctx.model.getSnapshot();
  });

  ipcMain.handle(DESKTOP_IPC.health, async () => {
    return ctx.model.refreshHealth();
  });

  ipcMain.handle(DESKTOP_IPC.listWorkspaces, async () => {
    return ctx.model.refreshWorkspaces();
  });

  ipcMain.handle(DESKTOP_IPC.mountWorkspace, async (_e: unknown, workspaceRoot: string) => {
    const summary = await ctx.model.mountWorkspace(workspaceRoot);
    let prefs = await loadDesktopPrefs(ctx.dataDir);
    prefs = rememberWorkspace(prefs, workspaceRoot);
    await saveDesktopPrefs(prefs, ctx.dataDir);
    ctx.broadcastState();
    return summary;
  });

  ipcMain.handle(DESKTOP_IPC.setForeground, async (_e: unknown, workspaceId: string) => {
    await ctx.model.setForeground(workspaceId);
    ctx.broadcastState();
    return ctx.model.getSnapshot();
  });

  ipcMain.handle(
    DESKTOP_IPC.rpc,
    async (_e: unknown, method: string, params?: Record<string, unknown>) => {
      const client = ctx.host.client;
      if (!client) throw new Error("Service not attached");
      return client.call(method, params);
    }
  );

  ipcMain.handle(DESKTOP_IPC.pickWorkspaceFolder, async (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ["openDirectory"],
      title: "Open workspace with in-workspace Tent (.tent)",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(DESKTOP_IPC.getPrefs, async () => {
    return loadDesktopPrefs(ctx.dataDir);
  });

  ipcMain.handle(
    DESKTOP_IPC.setPrefs,
    async (_e: unknown, patch: Partial<DesktopPreferences>) => {
      const prefs = { ...(await loadDesktopPrefs(ctx.dataDir)), ...patch };
      await saveDesktopPrefs(prefs, ctx.dataDir);
      return prefs;
    }
  );

  ipcMain.handle(DESKTOP_IPC.openMain, async () => {
    ctx.openMain();
  });

  ipcMain.handle(DESKTOP_IPC.hideMain, async () => {
    ctx.hideMain();
  });

  ipcMain.handle(DESKTOP_IPC.showFloat, async () => {
    ctx.showFloat();
  });

  ipcMain.handle(DESKTOP_IPC.hideFloat, async () => {
    ctx.hideFloat();
  });

  ipcMain.handle(
    DESKTOP_IPC.pushContextCard,
    async (
      _e: unknown,
      payload: {
        kind: string;
        id: string;
        path?: string;
        label?: string;
      }
    ) => {
      const entry = ctx.model.cards.pushRef(
        {
          kind: payload.kind as
            | "box"
            | "concept"
            | "task"
            | "delivery"
            | "handoff"
            | "selection"
            | "role",
          id: payload.id,
          path: payload.path,
        },
        { label: payload.label }
      );
      ctx.broadcastState();
      return entry;
    }
  );

  ipcMain.handle(DESKTOP_IPC.getFloatingStatus, async () => {
    await ctx.model.refreshHealth();
    await ctx.model.refreshTasks();
    return ctx.model.floatingStatus();
  });

  /**
   * Start OS drag of text/plain context card payload.
   * Electron supports startDrag for files; for text we copy to clipboard as
   * fallback and return the drag text for HTML5 drag in renderer.
   */
  ipcMain.handle(DESKTOP_IPC.startDrag, async (_e: unknown, text: string) => {
    const parsed = parseContextCardText(text);
    if (!parsed && !text.startsWith("Tent contextCard")) {
      // Still allow raw text drag payloads that look like cards.
    }
    clipboard.writeText(text);
    return { ok: true, text, mime: "text/plain" };
  });
}

export function pushCardFromModel(model: DesktopShellModel): RecentContextCard | null {
  model.emitContextCardForActive();
  return model.cards.list()[0] ?? null;
}

export { contextCardToDragText };
