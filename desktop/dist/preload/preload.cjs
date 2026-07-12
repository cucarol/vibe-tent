"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/desktop/preload/preload.ts
var preload_exports = {};
module.exports = __toCommonJS(preload_exports);
var import_electron = require("electron");

// src/desktop/types.ts
var DESKTOP_IPC = {
  getState: "tent:get-state",
  mountWorkspace: "tent:mount-workspace",
  setForeground: "tent:set-foreground",
  listWorkspaces: "tent:list-workspaces",
  health: "tent:health",
  rpc: "tent:rpc",
  openMain: "tent:open-main",
  hideMain: "tent:hide-main",
  showFloat: "tent:show-float",
  hideFloat: "tent:hide-float",
  pushContextCard: "tent:push-context-card",
  getFloatingStatus: "tent:get-floating-status",
  pickWorkspaceFolder: "tent:pick-workspace-folder",
  getPrefs: "tent:get-prefs",
  setPrefs: "tent:set-prefs",
  startDrag: "tent:start-drag",
  onStateChanged: "tent:state-changed"
};

// src/desktop/preload/preload.ts
var api = {
  getState: () => import_electron.ipcRenderer.invoke(DESKTOP_IPC.getState),
  health: () => import_electron.ipcRenderer.invoke(DESKTOP_IPC.health),
  listWorkspaces: () => import_electron.ipcRenderer.invoke(DESKTOP_IPC.listWorkspaces),
  mountWorkspace: (workspaceRoot) => import_electron.ipcRenderer.invoke(DESKTOP_IPC.mountWorkspace, workspaceRoot),
  setForeground: (workspaceId) => import_electron.ipcRenderer.invoke(DESKTOP_IPC.setForeground, workspaceId),
  rpc: (method, params) => import_electron.ipcRenderer.invoke(DESKTOP_IPC.rpc, method, params),
  pickWorkspaceFolder: () => import_electron.ipcRenderer.invoke(DESKTOP_IPC.pickWorkspaceFolder),
  getPrefs: () => import_electron.ipcRenderer.invoke(DESKTOP_IPC.getPrefs),
  setPrefs: (patch) => import_electron.ipcRenderer.invoke(DESKTOP_IPC.setPrefs, patch),
  openMain: () => import_electron.ipcRenderer.invoke(DESKTOP_IPC.openMain),
  hideMain: () => import_electron.ipcRenderer.invoke(DESKTOP_IPC.hideMain),
  showFloat: () => import_electron.ipcRenderer.invoke(DESKTOP_IPC.showFloat),
  hideFloat: () => import_electron.ipcRenderer.invoke(DESKTOP_IPC.hideFloat),
  pushContextCard: (payload) => import_electron.ipcRenderer.invoke(DESKTOP_IPC.pushContextCard, payload),
  getFloatingStatus: () => import_electron.ipcRenderer.invoke(DESKTOP_IPC.getFloatingStatus),
  startDrag: (text) => import_electron.ipcRenderer.invoke(DESKTOP_IPC.startDrag, text),
  onStateChanged: (handler) => {
    const listener = (_event, state) => handler(state);
    import_electron.ipcRenderer.on(DESKTOP_IPC.onStateChanged, listener);
    return () => import_electron.ipcRenderer.removeListener(DESKTOP_IPC.onStateChanged, listener);
  }
};
import_electron.contextBridge.exposeInMainWorld("tentDesktop", api);
//# sourceMappingURL=preload.cjs.map
