export type DesktopConnection =
  | "connecting"
  | "online"
  | "offline"
  | "reconnecting";

/**
 * Apply desktop-local disconnect truth before any asynchronous reattach read.
 * Returning the promise makes the ordering directly testable with a held
 * getState without introducing another connection state machine.
 */
export function handleDesktopRecoveryEvent(
  type: string,
  updateConnection: (connection: DesktopConnection) => void,
  reloadBootstrap: () => Promise<void>
): Promise<void> | null {
  if (type === "service.disconnected") {
    updateConnection("reconnecting");
    return reloadBootstrap();
  }
  if (type === "service.health" || type.startsWith("workspace.")) {
    return reloadBootstrap();
  }
  return null;
}
