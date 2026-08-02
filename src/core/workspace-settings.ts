// Workspace collaboration settings under system root (.tent/settings.json).
// Extensible projection: unknown fields are preserved on load/save.
// defaultAcceptMode defaults to review-required only when omitted.

import { withTentMutation, type FsAdapter } from "./adapter.js";
import { backupCorruptRegistry, warnRegistryRecovered } from "./registryRecovery.js";
import {
  DEFAULT_ACCEPT_MODE,
  isAcceptMode,
  type AcceptMode,
} from "./task-model.js";
import { WORKSPACE_SETTINGS_PATH } from "./paths.js";

export { WORKSPACE_SETTINGS_PATH };

/** Known acceptance mode for workspace defaults and Task envelopes. */
export type WorkspaceAcceptMode = AcceptMode;

/**
 * Workspace-level collaboration settings (system-root settings.json).
 * Extensible: additional keys round-trip through load/save.
 */
export type WorkspaceSettings = {
  /** Default for task.dispatch when acceptMode is omitted. */
  defaultAcceptMode: WorkspaceAcceptMode;
  /** Future / unknown collaboration keys preserved on disk. */
  [key: string]: unknown;
};

const DEFAULT_SETTINGS: WorkspaceSettings = {
  defaultAcceptMode: DEFAULT_ACCEPT_MODE,
};

/** Canonical hard-cut values only. */
export function isAcceptModeValue(value: unknown): value is WorkspaceAcceptMode {
  return isAcceptMode(value);
}

/**
 * Normalize raw JSON into WorkspaceSettings.
 * Missing defaultAcceptMode → review-required.
 * Invalid or retired fields fail loud; there is no compatibility read path.
 * Other own enumerable keys are preserved as-is for extensibility.
 */
export function normalizeWorkspaceSettings(value: unknown): WorkspaceSettings {
  if (!isRecord(value)) {
    throw new WorkspaceSettingsError(
      "INVALID_PATCH",
      "Workspace settings must be an object"
    );
  }
  if ("defaultDeliveryPolicy" in value || "deliveryPolicy" in value) {
    throw new WorkspaceSettingsError(
      "INVALID_ACCEPT_MODE",
      "Workspace settings contain a retired acceptance-policy field; use defaultAcceptMode"
    );
  }
  const out: WorkspaceSettings = { ...value } as WorkspaceSettings;
  if (out.defaultAcceptMode === undefined) {
    out.defaultAcceptMode = DEFAULT_ACCEPT_MODE;
  } else if (!isAcceptMode(out.defaultAcceptMode)) {
    throw new WorkspaceSettingsError(
      "INVALID_ACCEPT_MODE",
      `Invalid defaultAcceptMode: ${String(out.defaultAcceptMode)}`
    );
  }
  return out;
}

/** Clone of the effective default when the file is absent. */
export function defaultWorkspaceSettings(): WorkspaceSettings {
  return { ...DEFAULT_SETTINGS };
}

/**
 * Load `.tent/settings.json` relative to system-root FsAdapter.
 * Missing file → defaults. Corrupt JSON → backup + reset + warning (registry convention).
 */
export async function loadWorkspaceSettings(fs: FsAdapter): Promise<WorkspaceSettings> {
  if (!(await fs.exists(WORKSPACE_SETTINGS_PATH))) {
    return defaultWorkspaceSettings();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(WORKSPACE_SETTINGS_PATH)) as unknown;
  } catch {
    const backupPath = await backupCorruptRegistry(fs, WORKSPACE_SETTINGS_PATH);
    const reset = defaultWorkspaceSettings();
    await writeSettingsUnlocked(fs, reset);
    warnRegistryRecovered(
      WORKSPACE_SETTINGS_PATH,
      backupPath,
      "reset",
      "IMPORTANT: workspace settings cannot be inferred; restore needed keys from the backup."
    );
    return reset;
  }
  return normalizeWorkspaceSettings(parsed);
}

/**
 * Persist settings under mutation.lock. Always normalizes before write.
 * Returns the normalized settings that were written.
 */
export async function saveWorkspaceSettings(
  fs: FsAdapter,
  settings: WorkspaceSettings | Record<string, unknown>
): Promise<WorkspaceSettings> {
  return withTentMutation(fs, async () => {
    const normalized = normalizeWorkspaceSettings(settings);
    await writeSettingsUnlocked(fs, normalized);
    return normalized;
  });
}

/**
 * Apply a partial patch under mutation.lock.
 * Only provided keys are updated; unknown keys in the patch are stored (extensibility).
 * Invalid defaultAcceptMode in the patch throws.
 *
 * Returns `{ settings, changed }` where `changed` is true only when the normalized
 * projection actually differs from the pre-patch normalized load (no-op → no event upstream).
 */
export async function updateWorkspaceSettings(
  fs: FsAdapter,
  patch: Partial<WorkspaceSettings> | Record<string, unknown>
): Promise<{ settings: WorkspaceSettings; changed: boolean }> {
  return withTentMutation(fs, async () => {
    if (!isRecord(patch)) {
      throw new WorkspaceSettingsError(
        "INVALID_PATCH",
        "workspace.settings.update patch must be an object"
      );
    }
    const before = await loadWorkspaceSettings(fs);
    const nextRaw: Record<string, unknown> = { ...before };

    for (const [key, value] of Object.entries(patch)) {
      if (key === "defaultAcceptMode") {
        if (value === undefined) continue;
        if (!isAcceptModeValue(value)) {
          throw new WorkspaceSettingsError(
            "INVALID_ACCEPT_MODE",
            `Invalid defaultAcceptMode: ${String(value)}`
          );
        }
        nextRaw.defaultAcceptMode = value;
        continue;
      }
      // Extensibility: store other keys as provided (including null to clear).
      if (value === undefined) continue;
      nextRaw[key] = value;
    }

    const next = normalizeWorkspaceSettings(nextRaw);
    const changed = !settingsEqual(before, next);
    if (changed) {
      await writeSettingsUnlocked(fs, next);
    }
    return { settings: next, changed };
  });
}

export class WorkspaceSettingsError extends Error {
  code: "INVALID_ACCEPT_MODE" | "INVALID_PATCH";
  constructor(code: "INVALID_ACCEPT_MODE" | "INVALID_PATCH", message: string) {
    super(message);
    this.code = code;
    this.name = "WorkspaceSettingsError";
  }
}

async function writeSettingsUnlocked(fs: FsAdapter, settings: WorkspaceSettings): Promise<void> {
  // Stable key order: known fields first, then remaining keys sorted.
  const known = ["defaultAcceptMode"] as const;
  const ordered: Record<string, unknown> = {};
  for (const key of known) {
    if (key in settings) ordered[key] = settings[key];
  }
  const rest = Object.keys(settings)
    .filter((k) => !(known as readonly string[]).includes(k))
    .sort((a, b) => a.localeCompare(b));
  for (const key of rest) {
    ordered[key] = settings[key];
  }
  await fs.writeFile(WORKSPACE_SETTINGS_PATH, JSON.stringify(ordered, null, 2) + "\n");
}

/** Structural equality of normalized settings projections (key-order independent). */
function settingsEqual(a: WorkspaceSettings, b: WorkspaceSettings): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    out[key] = sortKeysDeep(value[key]);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
