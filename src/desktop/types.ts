// Desktop shell shared types (B5). No Electron imports.

export type ServiceHealthView = {
  status: "ok" | "stopping" | "offline";
  pid?: number;
  version?: string;
  protocolVersion?: number;
  startedAt?: string;
  workspaceCount?: number;
  foregroundWorkspaceId?: string | null;
  url?: string;
};

export type WorkspaceSummary = {
  workspaceId: string;
  workspaceRoot: string;
  tentName: string;
  foreground: boolean;
};

export type RecentContextCard = {
  id: string;
  label: string;
  kind: string;
  refId: string;
  path?: string;
  text: string;
  createdAt: string;
};

export type FloatingStatusSnapshot = {
  health: ServiceHealthView;
  pendingTasks: number;
  takenTasks: number;
  recentCards: RecentContextCard[];
  foregroundRoot?: string | null;
};

export type DesktopPreferences = {
  recentWorkspaces: string[];
  lastWorkspaceRoot?: string;
  mainWindowBounds?: { x: number; y: number; width: number; height: number };
  floatWindowBounds?: { x: number; y: number; width: number; height: number };
  showFloatOnClose: boolean;
};

export const DEFAULT_DESKTOP_PREFS: DesktopPreferences = {
  recentWorkspaces: [],
  showFloatOnClose: true,
};

/** IPC channel names — main ↔ preload only. */
export const DESKTOP_IPC = {
  getState: "tent:get-state",
  mountWorkspace: "tent:mount-workspace",
  setForeground: "tent:set-foreground",
  listWorkspaces: "tent:list-workspaces",
  health: "tent:health",
  rpc: "tent:rpc",
  document: "tent:document",
  openMain: "tent:open-main",
  hideMain: "tent:hide-main",
  showFloat: "tent:show-float",
  hideFloat: "tent:hide-float",
  pushContextCard: "tent:push-context-card",
  getFloatingStatus: "tent:get-floating-status",
  pickWorkspaceFolder: "tent:pick-workspace-folder",
  getPrefs: "tent:get-prefs",
  setPrefs: "tent:set-prefs",
  onStateChanged: "tent:state-changed",
  /** Fan-out of Local Service SSE envelope type (renderer re-fetches projections). */
  onServiceEvent: "tent:service-event",
} as const;
