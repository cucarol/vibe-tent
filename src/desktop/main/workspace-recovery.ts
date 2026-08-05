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

type DesktopRecoverySnapshot = ReturnType<DesktopRecoveryModel["getSnapshot"]>;

const recoveryFlights = new WeakMap<
  DesktopRecoveryModel,
  Promise<DesktopRecoverySnapshot>
>();

/**
 * Re-establish the desktop's authoritative workspace after a healthy attach.
 * A Service can restart behind the same endpoint and client object, so the
 * refreshed workspace projection—not client identity—decides whether the
 * remembered workspace must be mounted.
 */
export function recoverDesktopState(args: {
  host: DesktopRecoveryHost;
  model: DesktopRecoveryModel;
  dataDir?: string;
  loadPrefs?: typeof loadDesktopPrefs;
}): Promise<DesktopRecoverySnapshot> {
  const existing = recoveryFlights.get(args.model);
  if (existing) return existing;

  const flight = recoverDesktopStateOnce(args);
  const tracked = flight.finally(() => {
    if (recoveryFlights.get(args.model) === tracked) {
      recoveryFlights.delete(args.model);
    }
  });
  recoveryFlights.set(args.model, tracked);
  return tracked;
}

async function recoverDesktopStateOnce(args: {
  host: DesktopRecoveryHost;
  model: DesktopRecoveryModel;
  dataDir?: string;
  loadPrefs?: typeof loadDesktopPrefs;
}): Promise<DesktopRecoverySnapshot> {
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
