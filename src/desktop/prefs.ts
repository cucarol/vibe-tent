// Machine-local desktop preferences (service data area / desktop.json).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defaultServiceDataDir } from "../service/data-dir.js";
import { DEFAULT_DESKTOP_PREFS, type DesktopPreferences } from "./types.js";

export function desktopPrefsPath(dataDir?: string): string {
  return path.join(dataDir ?? defaultServiceDataDir(), "desktop.json");
}

export async function loadDesktopPrefs(dataDir?: string): Promise<DesktopPreferences> {
  try {
    const raw = await fs.readFile(desktopPrefsPath(dataDir), "utf8");
    const data = JSON.parse(raw) as Partial<DesktopPreferences>;
    return {
      ...DEFAULT_DESKTOP_PREFS,
      ...data,
      recentWorkspaces: Array.isArray(data.recentWorkspaces)
        ? data.recentWorkspaces.filter((x): x is string => typeof x === "string")
        : [],
      showFloatOnClose: data.showFloatOnClose !== false,
    };
  } catch {
    return { ...DEFAULT_DESKTOP_PREFS, recentWorkspaces: [] };
  }
}

export async function saveDesktopPrefs(
  prefs: DesktopPreferences,
  dataDir?: string
): Promise<void> {
  const file = desktopPrefsPath(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(prefs, null, 2) + "\n", "utf8");
}

export function rememberWorkspace(prefs: DesktopPreferences, root: string): DesktopPreferences {
  const resolved = root;
  const recent = [resolved, ...prefs.recentWorkspaces.filter((p) => p !== resolved)].slice(0, 12);
  return {
    ...prefs,
    recentWorkspaces: recent,
    lastWorkspaceRoot: resolved,
  };
}
