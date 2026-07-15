// Machine-local AgentProfile catalog (architecture §3.3). Never in workspace git.
// Load / save / default migration / projection / shared constants.
// CRUD catalog lives in profile-catalog.ts.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentProfileConfig } from "../runtime/types.js";
import { FAKE_ADAPTER_ID } from "../adapters/fake/index.js";
import {
  DEFAULT_GROK_BASE_URL_ENV_KEY,
  DEFAULT_GROK_ENV_KEY,
  DEFAULT_GROK_MODEL,
  GROK_ACP_ADAPTER_ID,
} from "../adapters/grok-acp/index.js";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";
import type { AgentProfileProjection } from "./types.js";

export const FAKE_DEFAULT_PROFILE_ID = "fake-default";
export const GROK_ACP_DEFAULT_PROFILE_ID = "grok-acp-default";

/** Product CRUD only allows this adapter (no general provider router). */
export const PRODUCT_CRUD_ADAPTER_ID = GROK_ACP_ADAPTER_ID;

/** Whitelist of client-writable profile fields (create). id is create-only. */
export const PROFILE_CREATE_FIELDS = [
  "id",
  "displayName",
  "model",
  "executable",
  "envKey",
  "baseUrlEnvKey",
  "baseUrl",
  "permissionPolicy",
  "promptTimeoutMs",
  "permissionTimeoutMs",
] as const;

/** Whitelist of client-writable profile fields (update). id is immutable. */
export const PROFILE_UPDATE_FIELDS = [
  "displayName",
  "model",
  "executable",
  "envKey",
  "baseUrlEnvKey",
  "baseUrl",
  "permissionPolicy",
  "promptTimeoutMs",
  "permissionTimeoutMs",
] as const;

export function profilesPath(dataDir: string): string {
  return path.join(dataDir, "agent-profiles.json");
}

export async function loadAgentProfiles(dataDir: string): Promise<AgentProfileConfig[]> {
  const file = profilesPath(dataDir);
  try {
    const raw = await fs.readFile(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const backupPath = await backupCorruptMachineFile(file);
      warnCorruptMachineState(file, backupPath, "reset");
      return [];
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const backupPath = await backupCorruptMachineFile(file);
      warnCorruptMachineState(file, backupPath, "reset");
      return [];
    }
    const profiles = (parsed as { profiles?: unknown }).profiles;
    if (profiles !== undefined && !Array.isArray(profiles)) {
      const backupPath = await backupCorruptMachineFile(file);
      warnCorruptMachineState(file, backupPath, "reset");
      return [];
    }
    const list = Array.isArray(profiles) ? (profiles as AgentProfileConfig[]) : [];
    return list.filter((p) => p && typeof p.id === "string" && typeof p.adapterId === "string");
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

export async function saveAgentProfiles(
  dataDir: string,
  profiles: AgentProfileConfig[]
): Promise<void> {
  await writeJsonAtomic(profilesPath(dataDir), { profiles });
}

/**
 * Default catalog for Local Service.
 * - fake-default: test / harness only (no network)
 * - grok-acp-default: first real provider; secrets only via process env (envKey name here)
 *
 * Never write API key values into this file — only env key *names* and paths.
 */
export function defaultAgentProfiles(): AgentProfileConfig[] {
  return [
    {
      id: FAKE_DEFAULT_PROFILE_ID,
      adapterId: FAKE_ADAPTER_ID,
      displayNameKey: "profile.fake.default",
      fake: { waitForSignal: true, emitStdout: true, canResume: true },
    },
    {
      id: GROK_ACP_DEFAULT_PROFILE_ID,
      adapterId: GROK_ACP_ADAPTER_ID,
      displayNameKey: "profile.grokAcp.default",
      grokAcp: {
        // executable omitted → %USERPROFILE%\.grok\bin\grok.exe (or ~/.grok/bin/grok)
        model: DEFAULT_GROK_MODEL,
        envKey: DEFAULT_GROK_ENV_KEY,
        // CPA base URL from process env (name only here). Optional machine-local baseUrl field.
        baseUrlEnvKey: DEFAULT_GROK_BASE_URL_ENV_KEY,
        // Default deny tool permissions — never unconditional yolo.
        permissionPolicy: "deny",
      },
    },
  ];
}

export async function ensureDefaultProfiles(dataDir: string): Promise<AgentProfileConfig[]> {
  const existing = await loadAgentProfiles(dataDir);
  if (existing.length > 0) {
    let changed = false;
    let next = existing;
    // Keep both built-ins present so disk, catalog, and runtime expose the same set.
    if (!existing.some((p) => p.id === FAKE_DEFAULT_PROFILE_ID)) {
      const fake = defaultAgentProfiles().find((p) => p.id === FAKE_DEFAULT_PROFILE_ID)!;
      next = [...next, fake];
      changed = true;
    }
    if (!existing.some((p) => p.id === GROK_ACP_DEFAULT_PROFILE_ID)) {
      const grok = defaultAgentProfiles().find((p) => p.id === GROK_ACP_DEFAULT_PROFILE_ID)!;
      next = [...next, grok];
      changed = true;
    }
    // Ensure grok-acp profiles know the base URL env key name (no secret values).
    next = next.map((p) => {
      if (p.adapterId !== GROK_ACP_ADAPTER_ID) return p;
      if (p.grokAcp?.baseUrlEnvKey) return p;
      changed = true;
      return {
        ...p,
        grokAcp: {
          ...(p.grokAcp ?? {}),
          baseUrlEnvKey: p.grokAcp?.baseUrlEnvKey ?? DEFAULT_GROK_BASE_URL_ENV_KEY,
        },
      };
    });
    if (changed) await saveAgentProfiles(dataDir, next);
    return next;
  }
  const defaults = defaultAgentProfiles();
  await saveAgentProfiles(dataDir, defaults);
  return defaults;
}

/** Whether a profile is harness/test-only (must not be product default). */
export function isTestOnlyProfile(profile: AgentProfileConfig): boolean {
  return profile.adapterId === FAKE_ADAPTER_ID || !!profile.fake;
}

const DISPLAY_NAME_BY_KEY: Record<string, string> = {
  "profile.fake.default": "fake-default（测试）",
  "profile.grokAcp.default": "Grok ACP",
};

/**
 * Project a machine-local profile for clients / editors.
 * Non-secret fields only. Never includes env maps, API keys, tokens, or secret values.
 */
export function projectAgentProfile(profile: AgentProfileConfig): AgentProfileProjection {
  const testOnly = isTestOnlyProfile(profile);
  const displayName =
    (typeof profile.displayName === "string" && profile.displayName.trim()
      ? profile.displayName.trim()
      : undefined) ||
    (profile.displayNameKey && DISPLAY_NAME_BY_KEY[profile.displayNameKey]) ||
    profile.id;
  const g = profile.grokAcp;
  return {
    id: profile.id,
    adapterId: profile.adapterId,
    displayName,
    displayNameKey: profile.displayNameKey,
    model: g?.model,
    executable: g?.executable,
    envKey: g?.envKey,
    baseUrlEnvKey: g?.baseUrlEnvKey,
    baseUrl: g?.baseUrl,
    testOnly,
    permissionPolicy: g?.permissionPolicy,
    promptTimeoutMs: g?.promptTimeoutMs,
    permissionTimeoutMs: g?.permissionTimeoutMs,
  };
}

/** Safe list for profile.list RPC — never secrets. */
export function projectAgentProfiles(profiles: AgentProfileConfig[]): AgentProfileProjection[] {
  return profiles
    .map(projectAgentProfile)
    .sort((a, b) => {
      // Product profiles first; then id.
      if (a.testOnly !== b.testOnly) return a.testOnly ? 1 : -1;
      return a.id.localeCompare(b.id);
    });
}
