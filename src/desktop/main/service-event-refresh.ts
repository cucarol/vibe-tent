type DesktopRefreshModel = {
  refreshHealth: () => Promise<{ status: string }>;
  refreshWorkspaces: () => Promise<unknown>;
  refreshTasks: () => Promise<unknown>;
};

/** Refresh only authoritative shell reads needed for a filtered Service event. */
export async function refreshDesktopShellForEvent(
  model: DesktopRefreshModel,
  type: string
): Promise<void> {
  if (
    type === "workspace.switched" ||
    type === "service.health" ||
    type === "service.disconnected"
  ) {
    const health = await model.refreshHealth();
    // Offline is an authoritative transport result. Do not hide it because a
    // workspace read cannot run; publish that health snapshot to renderers.
    if (health.status === "ok") await model.refreshWorkspaces();
    return;
  }
  await model.refreshTasks();
}
