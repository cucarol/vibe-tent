// Shared renderer bridge typings for main + float windows.

import type {
  DesktopDocumentRequest,
  DesktopDocumentResponse,
} from "../document-ipc.js";
import type {
  DesktopCollaborationRequest,
  DesktopCollaborationResponse,
} from "../collaboration-ipc.js";

export type TentDesktopBridge = {
  getState: () => Promise<unknown>;
  health: () => Promise<unknown>;
  listWorkspaces: () => Promise<unknown>;
  mountWorkspace: (workspaceRoot: string) => Promise<unknown>;
  setForeground: (workspaceId: string) => Promise<unknown>;
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  document: (request: DesktopDocumentRequest) => Promise<DesktopDocumentResponse>;
  collaboration: (
    request: DesktopCollaborationRequest
  ) => Promise<DesktopCollaborationResponse>;
  pickWorkspaceFolder: () => Promise<string | null>;
  getPrefs: () => Promise<unknown>;
  setPrefs: (patch: Record<string, unknown>) => Promise<unknown>;
  openMain: () => Promise<void>;
  hideMain: () => Promise<void>;
  showFloat: () => Promise<void>;
  hideFloat: () => Promise<void>;
  getFloatingStatus: () => Promise<{
    health: { status: string; pid?: number; version?: string };
    pendingTasks: number;
    takenTasks: number;
    foregroundRoot?: string | null;
  }>;
  onStateChanged: (handler: (state: unknown) => void) => () => void;
  /** Service SSE type only — re-fetch named projections; do not invent state. */
  onServiceEvent: (
    handler: (ev: { type: string; workspaceId?: string }) => void
  ) => () => void;
};

declare global {
  interface Window {
    tentDesktop: TentDesktopBridge;
  }
}

export {};
