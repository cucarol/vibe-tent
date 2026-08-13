// Main-process IPC handlers (minimal surface for secure preload bridge).

import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import type { DesktopServiceHost } from "./service-host.js";
import { DesktopShellModel } from "../workbench/shell-model.js";
import {
  loadDesktopPrefs,
  rememberWorkspace,
  saveDesktopPrefs,
} from "../prefs.js";
import { DESKTOP_IPC, type DesktopPreferences } from "../types.js";
import { contextCardToDragText } from "../../core/context-card.js";
import type { DesktopDocumentResponse } from "../document-ipc.js";
import { handleDesktopDocumentRequest } from "./document-ipc-handler.js";
import type { DesktopCollaborationResponse } from "../collaboration-ipc.js";
import { handleDesktopCollaborationRequest } from "./collaboration-ipc-handler.js";
import {
  invokeDesktopProjectionRpc,
} from "../projection-ipc.js";
import { recoverDesktopState } from "./workspace-recovery.js";

export type IpcContext = {
  host: DesktopServiceHost;
  model: DesktopShellModel;
  dataDir?: string;
  getMainWindow: () => BrowserWindow | null;
  getFloatWindow: () => BrowserWindow | null;
  openMain: () => void | Promise<void>;
  showFloat: () => void;
  hideFloat: () => void;
  hideMain: () => void;
  broadcastState: () => void;
};

export function registerDesktopIpc(ctx: IpcContext): void {
  ipcMain.handle(DESKTOP_IPC.getState, async () => {
    return recoverDesktopState({
      host: ctx.host,
      model: ctx.model,
      dataDir: ctx.dataDir,
    });
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
    async (_e: unknown, method: unknown, params?: Record<string, unknown>) => {
      return invokeDesktopProjectionRpc(() => ctx.host.client, method, params);
    }
  );

  ipcMain.handle(
    DESKTOP_IPC.document,
    async (_e: unknown, request: unknown): Promise<DesktopDocumentResponse> =>
      handleDesktopDocumentRequest(ctx.host.client, request)
  );

  ipcMain.handle(
    DESKTOP_IPC.collaboration,
    async (_e: unknown, request: unknown): Promise<DesktopCollaborationResponse> =>
      handleDesktopCollaborationRequest(ctx.host.client, request)
  );

  ipcMain.handle(DESKTOP_IPC.pickWorkspaceFolder, async (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ["openDirectory"],
      title: "打开带有帐（.tent）的工作区",
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
    await ctx.openMain();
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
            | "node"
            | "task"
            | "result"
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
    await ctx.model.refreshFloatingTasks();
    return ctx.model.floatingStatus();
  });

  // Context Card cross-app drag is renderer HTML5 text/plain (Chromium OLE on
  // Windows). Electron webContents.startDrag is file-path only — do not expose
  // a clipboard-write IPC as if it were native text drag.
}

export { contextCardToDragText };
