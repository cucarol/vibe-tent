type DesktopRefreshModel = {
  refreshHealth: () => Promise<{ status: string }>;
  refreshWorkspaces: () => Promise<unknown>;
};

/** Refresh only the bootstrap facts carried by getState/onStateChanged. */
export async function refreshDesktopShellForEvent(
  model: DesktopRefreshModel,
  type: string
): Promise<boolean> {
  if (
    type === "workspace.switched" ||
    type === "service.health" ||
    type === "service.disconnected"
  ) {
    const health = await model.refreshHealth();
    // Offline is an authoritative transport result. Do not hide it because a
    // workspace read cannot run; publish that health snapshot to renderers.
    if (health.status === "ok") await model.refreshWorkspaces();
    return true;
  }
  // Renderer projection events are forwarded separately. Never rehydrate the
  // retired Task/Session/Delivery shell snapshot in the background.
  return false;
}
