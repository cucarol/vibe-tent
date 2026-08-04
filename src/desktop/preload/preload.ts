// Secure preload bridge — contextIsolation on, no nodeIntegration.

import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC } from "../types.js";
import type {
  DesktopDocumentRequest,
  DesktopDocumentResponse,
} from "../document-ipc.js";

export type TentDesktopApi = {
  getState: () => Promise<unknown>;
  health: () => Promise<unknown>;
  listWorkspaces: () => Promise<unknown>;
  mountWorkspace: (workspaceRoot: string) => Promise<unknown>;
  setForeground: (workspaceId: string) => Promise<unknown>;
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  document: (request: DesktopDocumentRequest) => Promise<DesktopDocumentResponse>;
  pickWorkspaceFolder: () => Promise<string | null>;
  getPrefs: () => Promise<unknown>;
  setPrefs: (patch: Record<string, unknown>) => Promise<unknown>;
  openMain: () => Promise<void>;
  hideMain: () => Promise<void>;
  showFloat: () => Promise<void>;
  hideFloat: () => Promise<void>;
  pushContextCard: (payload: {
    kind: string;
    id: string;
    path?: string;
    label?: string;
  }) => Promise<unknown>;
  getFloatingStatus: () => Promise<unknown>;
  onStateChanged: (handler: (state: unknown) => void) => () => void;
  /** Service SSE type fan-out — renderer must re-fetch projections, not trust payload. */
  onServiceEvent: (
    handler: (ev: { type: string; workspaceId?: string }) => void
  ) => () => void;
};

const api: TentDesktopApi = {
  getState: () => ipcRenderer.invoke(DESKTOP_IPC.getState),
  health: () => ipcRenderer.invoke(DESKTOP_IPC.health),
  listWorkspaces: () => ipcRenderer.invoke(DESKTOP_IPC.listWorkspaces),
  mountWorkspace: (workspaceRoot: string) =>
    ipcRenderer.invoke(DESKTOP_IPC.mountWorkspace, workspaceRoot),
  setForeground: (workspaceId: string) =>
    ipcRenderer.invoke(DESKTOP_IPC.setForeground, workspaceId),
  rpc: (method: string, params?: Record<string, unknown>) =>
    ipcRenderer.invoke(DESKTOP_IPC.rpc, method, params),
  document: (request) => ipcRenderer.invoke(DESKTOP_IPC.document, request),
  pickWorkspaceFolder: () => ipcRenderer.invoke(DESKTOP_IPC.pickWorkspaceFolder),
  getPrefs: () => ipcRenderer.invoke(DESKTOP_IPC.getPrefs),
  setPrefs: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke(DESKTOP_IPC.setPrefs, patch),
  openMain: () => ipcRenderer.invoke(DESKTOP_IPC.openMain),
  hideMain: () => ipcRenderer.invoke(DESKTOP_IPC.hideMain),
  showFloat: () => ipcRenderer.invoke(DESKTOP_IPC.showFloat),
  hideFloat: () => ipcRenderer.invoke(DESKTOP_IPC.hideFloat),
  pushContextCard: (payload) => ipcRenderer.invoke(DESKTOP_IPC.pushContextCard, payload),
  getFloatingStatus: () => ipcRenderer.invoke(DESKTOP_IPC.getFloatingStatus),
  onStateChanged: (handler) => {
    const listener = (_event: unknown, state: unknown) => handler(state);
    ipcRenderer.on(DESKTOP_IPC.onStateChanged, listener);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.onStateChanged, listener);
  },
  onServiceEvent: (handler) => {
    const listener = (
      _event: unknown,
      payload: { type: string; workspaceId?: string }
    ) => handler(payload);
    ipcRenderer.on(DESKTOP_IPC.onServiceEvent, listener);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.onServiceEvent, listener);
  },
};

contextBridge.exposeInMainWorld("tentDesktop", api);
