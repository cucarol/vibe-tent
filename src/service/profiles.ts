// Machine-local AgentProfile catalog (architecture §3.3). Never in workspace git.
// Load / save / default migration / projection / shared constants.
// CRUD catalog lives in profile-catalog.ts.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentProfileConfig } from "../runtime/types.js";
import {
  cloneAgentProfileConfig,
  normalizeProfileToCanonicalAcp,
  type AgentProfileConfigRaw,
} from "../runtime/profile-config.js";
import { FAKE_ADAPTER_ID } from "../adapters/fake/index.js";
import {
  DEFAULT_GROK_BASE_URL_ENV_KEY,
  DEFAULT_GROK_ENV_KEY,
  DEFAULT_GROK_MODEL,
  GROK_ACP_ADAPTER_ID,
} from "../adapters/grok-acp/index.js";
import { CODEX_ACP_ADAPTER_ID } from "../adapters/codex-acp/index.js";
import { CLAUDE_ACP_ADAPTER_ID } from "../adapters/claude-acp/index.js";
import { ANTIGRAVITY_ACP_ADAPTER_ID } from "../adapters/antigravity-acp/index.js";
import { OPENCODE_ACP_ADAPTER_ID } from "../adapters/opencode-acp/index.js";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";
import type { AgentProfileProjection } from "./types.js";

export {
  normalizeProfileToCanonicalAcp,
  type AgentProfileConfigRaw,
} from "../runtime/profile-config.js";

export const FAKE_DEFAULT_PROFILE_ID = "fake-default";
export const GROK_ACP_DEFAULT_PROFILE_ID = "grok-acp-default";
export const CODEX_ACP_DEFAULT_PROFILE_ID = "codex-acp-default";
export const CLAUDE_ACP_DEFAULT_PROFILE_ID = "claude-acp-default";
export const ANTIGRAVITY_ACP_DEFAULT_PROFILE_ID = "antigravity-acp-default";
export const OPENCODE_ACP_DEFAULT_PROFILE_ID = "opencode-acp-default";

/**
 * Explicit product-CRUD ACP adapter whitelist (not a universal provider router).
 * Only these adapterId strings may be created/updated/deleted via profile.* RPC.
 * Adapters are registered separately — this batch does not implement/seed non-grok providers.
 * Never include gemini-acp. antigravity-acp is id-only (third-party agy-acp bridge not implemented here).
 */
export const PRODUCT_ACP_ADAPTER_IDS = [
  "grok-acp",
  "codex-acp",
  "claude-acp",
  "antigravity-acp",
  "opencode-acp",
] as const;

export type ProductAcpAdapterId = (typeof PRODUCT_ACP_ADAPTER_IDS)[number];

const PRODUCT_ACP_ADAPTER_SET = new Set<string>(PRODUCT_ACP_ADAPTER_IDS);

export function isProductAcpAdapterId(id: string): id is ProductAcpAdapterId {
  return PRODUCT_ACP_ADAPTER_SET.has(id);
}

/**
 * Built-in *-default profile ids that product delete must refuse
 * (even if that default is not seeded yet).
 */
const BUILTIN_DEFAULT_PROFILE_IDS = new Set<string>([
  FAKE_DEFAULT_PROFILE_ID,
  GROK_ACP_DEFAULT_PROFILE_ID,
  CODEX_ACP_DEFAULT_PROFILE_ID,
  CLAUDE_ACP_DEFAULT_PROFILE_ID,
  ANTIGRAVITY_ACP_DEFAULT_PROFILE_ID,
  OPENCODE_ACP_DEFAULT_PROFILE_ID,
]);

export function isBuiltinDefaultProfileId(id: string): boolean {
  return BUILTIN_DEFAULT_PROFILE_IDS.has(id);
}

/** Whitelist of client-writable profile fields (create). id is create-only; adapterId create-only. */
export const PROFILE_CREATE_FIELDS = [
  "id",
  "adapterId",
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

/** Whitelist of client-writable profile fields (update). id and adapterId are immutable. */
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
  return (await loadAgentProfilesWithMigration(dataDir)).profiles;
}

/**
 * Load profiles and report whether any row still carried legacy `grokAcp` on disk.
 * ensureDefaultProfiles uses `migrated` to atomic-rewrite canonical `acp` without dual-write.
 */
export async function loadAgentProfilesWithMigration(
  dataDir: string
): Promise<{ profiles: AgentProfileConfig[]; migrated: boolean }> {
  const file = profilesPath(dataDir);
  try {
    const raw = await fs.readFile(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const backupPath = await backupCorruptMachineFile(file);
      warnCorruptMachineState(file, backupPath, "reset");
      return { profiles: [], migrated: false };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const backupPath = await backupCorruptMachineFile(file);
      warnCorruptMachineState(file, backupPath, "reset");
      return { profiles: [], migrated: false };
    }
    const profiles = (parsed as { profiles?: unknown }).profiles;
    if (profiles !== undefined && !Array.isArray(profiles)) {
      const backupPath = await backupCorruptMachineFile(file);
      warnCorruptMachineState(file, backupPath, "reset");
      return { profiles: [], migrated: false };
    }
    const list = Array.isArray(profiles) ? (profiles as AgentProfileConfigRaw[]) : [];
    let migrated = false;
    const out: AgentProfileConfig[] = [];
    for (const p of list) {
      if (!p || typeof p.id !== "string" || typeof p.adapterId !== "string") continue;
      const n = normalizeProfileToCanonicalAcp(p);
      if (n.migrated) migrated = true;
      out.push(n.profile);
    }
    return { profiles: out, migrated };
  } catch (err) {
    if (isNotFoundError(err)) return { profiles: [], migrated: false };
    throw err;
  }
}

export async function saveAgentProfiles(
  dataDir: string,
  profiles: AgentProfileConfig[]
): Promise<void> {
  // Canonical save only — never dual-write grokAcp.
  const canonical = profiles.map((p) => {
    const { profile } = normalizeProfileToCanonicalAcp(p as AgentProfileConfigRaw);
    return profile;
  });
  await writeJsonAtomic(profilesPath(dataDir), { profiles: canonical });
}

/**
 * Default catalog for Local Service.
 * - fake-default: test / harness only (no network)
 * - explicit product ACP defaults; secrets still only come from process env
 *
 * Still only fake + grok seeds — no codex/claude/antigravity/opencode defaults.
 * Never write API key values into this file — only env key *names* and paths.
 * Canonical bag is `acp` (not legacy grokAcp).
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
      acp: {
        // executable omitted → %USERPROFILE%\.grok\bin\grok.exe (or ~/.grok/bin/grok)
        model: DEFAULT_GROK_MODEL,
        envKey: DEFAULT_GROK_ENV_KEY,
        // CPA base URL from process env (name only here). Optional machine-local baseUrl field.
        baseUrlEnvKey: DEFAULT_GROK_BASE_URL_ENV_KEY,
        // Default deny tool permissions — never unconditional yolo.
        permissionPolicy: "deny",
      },
    },
    {
      id: CODEX_ACP_DEFAULT_PROFILE_ID,
      adapterId: CODEX_ACP_ADAPTER_ID,
      displayNameKey: "profile.codexAcp.default",
      acp: { permissionPolicy: "deny" },
    },
    {
      id: CLAUDE_ACP_DEFAULT_PROFILE_ID,
      adapterId: CLAUDE_ACP_ADAPTER_ID,
      displayNameKey: "profile.claudeAcp.default",
      acp: { permissionPolicy: "deny" },
    },
    {
      id: ANTIGRAVITY_ACP_DEFAULT_PROFILE_ID,
      adapterId: ANTIGRAVITY_ACP_ADAPTER_ID,
      displayNameKey: "profile.antigravityAcp.default",
      acp: { permissionPolicy: "deny" },
    },
    {
      id: OPENCODE_ACP_DEFAULT_PROFILE_ID,
      adapterId: OPENCODE_ACP_ADAPTER_ID,
      displayNameKey: "profile.openCodeAcp.default",
      acp: { permissionPolicy: "deny" },
    },
  ];
}

export async function ensureDefaultProfiles(dataDir: string): Promise<AgentProfileConfig[]> {
  const loaded = await loadAgentProfilesWithMigration(dataDir);
  const existing = loaded.profiles;
  if (existing.length > 0) {
    let changed = loaded.migrated;
    let next = existing;
    // Keep all built-ins present so disk, catalog, and runtime expose the same set.
    for (const builtIn of defaultAgentProfiles()) {
      if (!next.some((p) => p.id === builtIn.id)) {
        next = [...next, builtIn];
        changed = true;
      }
    }
    // Ensure grok-acp profiles know the base URL env key name (no secret values).
    // Do not invent model/envKey for non-grok adapters; only fill missing baseUrlEnvKey on grok.
    next = next.map((p) => {
      if (p.adapterId !== GROK_ACP_ADAPTER_ID) return p;
      if (p.acp?.baseUrlEnvKey) return p;
      changed = true;
      return {
        ...p,
        acp: {
          ...(p.acp ?? {}),
          baseUrlEnvKey: p.acp?.baseUrlEnvKey ?? DEFAULT_GROK_BASE_URL_ENV_KEY,
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
  "profile.codexAcp.default": "Codex ACP",
  "profile.claudeAcp.default": "Claude Agent ACP",
  "profile.antigravityAcp.default": "Antigravity ACP（agy-acp bridge）",
  "profile.openCodeAcp.default": "OpenCode ACP",
};

/**
 * Project a machine-local profile for clients / editors.
 * Non-secret fields only. Never includes env maps, API keys, tokens, or secret values.
 * Reads canonical `acp` bag (legacy grokAcp should already be migrated on load).
 */
export function projectAgentProfile(profile: AgentProfileConfig): AgentProfileProjection {
  const testOnly = isTestOnlyProfile(profile);
  const displayName =
    (typeof profile.displayName === "string" && profile.displayName.trim()
      ? profile.displayName.trim()
      : undefined) ||
    (profile.displayNameKey && DISPLAY_NAME_BY_KEY[profile.displayNameKey]) ||
    profile.id;
  // Defensive: if a raw row still has only legacy bag, normalize without scattering reads.
  const canonical = cloneAgentProfileConfig(profile);
  const g = canonical.acp;
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
