import type { ServiceRpcClient } from "../client/rpc-client.js";
import { loadDesktopPrefs } from "../prefs.js";

export type DesktopRecoveryHost = {
  ensureAttached(): Promise<{ client: ServiceRpcClient }>;
};

export type DesktopRecoveryModel = {
  setRpc(client: ServiceRpcClient): void;
  refreshHealth(): Promise<unknown>;
  refreshWorkspaces(): Promise<unknown>;
  getSnapshot(): { foregroundWorkspaceId: string | null };
  mountWorkspace(workspaceRoot: string): Promise<unknown>;
  refreshTasks(): Promise<unknown>;
};

/**
 * Re-establish the desktop's authoritative workspace after a healthy attach.
 * A Service can restart behind the same endpoint and client object, so the
 * refreshed workspace projection—not client identity—decides whether the
 * remembered workspace must be mounted.
 */
export async function recoverDesktopState(args: {
  host: DesktopRecoveryHost;
  model: DesktopRecoveryModel;
  dataDir?: string;
  loadPrefs?: typeof loadDesktopPrefs;
}): Promise<ReturnType<DesktopRecoveryModel["getSnapshot"]>> {
  const attach = await args.host.ensureAttached();
  args.model.setRpc(attach.client);
  await args.model.refreshHealth();
  await args.model.refreshWorkspaces();

  if (!args.model.getSnapshot().foregroundWorkspaceId) {
    const prefs = await (args.loadPrefs ?? loadDesktopPrefs)(args.dataDir);
    if (prefs.lastWorkspaceRoot) {
      await args.model.mountWorkspace(prefs.lastWorkspaceRoot);
    }
  }

  if (args.model.getSnapshot().foregroundWorkspaceId) {
    await args.model.refreshTasks();
  }
  return args.model.getSnapshot();
}
