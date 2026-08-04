import * as path from "node:path";
import { pathToFileURL } from "node:url";

export type DesktopNavigationDecision =
  | { kind: "allow-local" }
  | { kind: "open-external"; url: string }
  | { kind: "deny" };

type NavigationEvent = { preventDefault: () => void };

export type DesktopNavigationWebContents = {
  on: (
    event: "will-navigate",
    listener: (event: NavigationEvent, url: string) => void
  ) => unknown;
  setWindowOpenHandler: (
    handler: (details: { url: string }) => { action: "deny" }
  ) => unknown;
};

export function decideDesktopNavigation(
  requestedUrl: string,
  localHtmlPath: string
): DesktopNavigationDecision {
  let requested: URL;
  try {
    requested = new URL(requestedUrl);
  } catch {
    return { kind: "deny" };
  }

  if (requested.protocol === "http:" || requested.protocol === "https:") {
    return { kind: "open-external", url: requested.href };
  }

  if (requested.protocol !== "file:") return { kind: "deny" };

  const expected = new URL(pathToFileURL(path.resolve(localHtmlPath)).href);
  requested.hash = "";
  if (requested.href === expected.href) return { kind: "allow-local" };
  return { kind: "deny" };
}

export function installDesktopNavigationPolicy(
  webContents: DesktopNavigationWebContents,
  localHtmlPath: string,
  openExternal: (url: string) => Promise<unknown>
): void {
  const openInSystemBrowser = (url: string) => {
    void openExternal(url).catch((error) => {
      console.warn("Failed to open external URL:", error);
    });
  };

  webContents.on("will-navigate", (event, url) => {
    const decision = decideDesktopNavigation(url, localHtmlPath);
    if (decision.kind === "allow-local") return;
    event.preventDefault();
    if (decision.kind === "open-external") {
      openInSystemBrowser(decision.url);
    }
  });

  webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideDesktopNavigation(url, localHtmlPath);
    if (decision.kind === "open-external") {
      openInSystemBrowser(decision.url);
    }
    return { action: "deny" };
  });
}
