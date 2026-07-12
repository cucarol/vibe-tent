// Shared renderer bridge typings for main + float windows.

export type TentDesktopBridge = {
  getState: () => Promise<unknown>;
  health: () => Promise<unknown>;
  listWorkspaces: () => Promise<unknown>;
  mountWorkspace: (workspaceRoot: string) => Promise<unknown>;
  setForeground: (workspaceId: string) => Promise<unknown>;
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
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
  getFloatingStatus: () => Promise<{
    health: { status: string; pid?: number; version?: string };
    pendingTasks: number;
    takenTasks: number;
    recentCards: Array<{
      label: string;
      kind: string;
      refId: string;
      text: string;
      path?: string;
    }>;
    foregroundRoot?: string | null;
  }>;
  onStateChanged: (handler: (state: unknown) => void) => () => void;
};

declare global {
  interface Window {
    tentDesktop: TentDesktopBridge;
  }
}

export {};
