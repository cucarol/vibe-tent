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
import { COPILOT_ACP_ADAPTER_ID } from "../adapters/copilot-acp/index.js";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";
import {
  parseBaseUrlValue,
  parseCredentialRefValue,
  parseEnvKeyValue,
  parseNonEmptyStringValue,
  parsePermissionPolicyValue,
  parsePositiveTimeoutValue,
  parseProfileIdValue,
  type FieldResult,
} from "./profile-field-rules.js";
import type { AgentProfileProjection } from "./types.js";
import type { AcpProfileOptions } from "../adapters/acp/types.js";
import type { FakeProfileOptions } from "../runtime/types.js";
import {
  defaultAllowedSkillRoots,
  parseMcpServersArrayValue,
  parseSkillsArrayValue,
  projectMcpServers,
  projectSkillRefs,
} from "../adapters/acp/mcp-skills.js";

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
export const COPILOT_ACP_DEFAULT_PROFILE_ID = "copilot-acp-default";

/**
 * Explicit product-CRUD ACP adapter whitelist (not a universal provider router).
 * Only these adapterId strings may be created/updated/deleted via profile.* RPC.
 * Adapters are registered separately — this batch does not implement/seed non-grok providers.
 * Never include gemini-acp. antigravity-acp launches the separately installed
 * third-party agy-acp bridge; Tent never treats the official agy CLI as native ACP.
 */
export const PRODUCT_ACP_ADAPTER_IDS = [
  "grok-acp",
  "codex-acp",
  "claude-acp",
  "antigravity-acp",
  "opencode-acp",
  "copilot-acp",
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
  COPILOT_ACP_DEFAULT_PROFILE_ID,
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
  "credentialRef",
  "baseUrlEnvKey",
  "baseUrl",
  "permissionPolicy",
  "promptTimeoutMs",
  "permissionTimeoutMs",
  "skills",
  "mcpServers",
] as const;

/** Whitelist of client-writable profile fields (update). id and adapterId are immutable. */
export const PROFILE_UPDATE_FIELDS = [
  "displayName",
  "model",
  "executable",
  "envKey",
  "credentialRef",
  "baseUrlEnvKey",
  "baseUrl",
  "permissionPolicy",
  "promptTimeoutMs",
  "permissionTimeoutMs",
  "skills",
  "mcpServers",
] as const;

// ---------------------------------------------------------------------------
// Disk-row validation (load-path only). Pure value rules live in
// profile-field-rules.ts (shared with profile-catalog CRUD).
// One bad row (including unknown keys) → whole-file quarantine; never silent skip.
// ---------------------------------------------------------------------------

/**
 * Exact top-level allowlist for agent-profiles.json rows.
 * Any other top-level key is malformed and quarantines the whole catalog.
 */
const DISK_PROFILE_TOP_LEVEL_KEYS = new Set([
  "id",
  "adapterId",
  "displayName",
  "displayNameKey",
  "command",
  "args",
  "env",
  "fake",
  "acp",
  "grokAcp",
  "skills",
  "mcpServers",
]);

/** Keys allowed inside canonical `acp` / legacy `grokAcp` bags. */
const DISK_ACP_KEYS = new Set([
  "executable",
  "model",
  "envKey",
  "credentialRef",
  "baseUrlEnvKey",
  "baseUrl",
  "promptTimeoutMs",
  "permissionPolicy",
  "permissionTimeoutMs",
]);

const DISK_FAKE_KEYS = new Set([
  "sleepMs",
  "exitCode",
  "waitForSignal",
  "emitStdout",
  "failLaunch",
  "canResume",
]);

export function profilesPath(dataDir: string): string {
  return path.join(dataDir, "agent-profiles.json");
}

async function quarantineAgentProfilesFile(
  file: string
): Promise<{ profiles: AgentProfileConfig[]; migrated: boolean }> {
  const backupPath = await backupCorruptMachineFile(file);
  warnCorruptMachineState(file, backupPath, "reset");
  return { profiles: [], migrated: false };
}

/** Map FieldResult → disk optional: undefined/null omit; invalid → null (quarantine). */
function diskOptional<T>(
  value: unknown,
  parse: (v: unknown) => FieldResult<T>
): T | undefined | null {
  if (value === undefined || value === null) return undefined;
  const r = parse(value);
  return r.ok ? r.value : null;
}

/**
 * Strict ACP bag parse for disk rows. Shared FieldResult rules:
 * invalid type/value or unknown key → null (caller quarantines whole file).
 */
function parseDiskAcpBag(value: unknown): AcpProfileOptions | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const acp: AcpProfileOptions = {};

  for (const key of Object.keys(raw)) {
    if (!DISK_ACP_KEYS.has(key)) return null; // unknown acp/grokAcp key → malformed
    const v = raw[key];
    switch (key) {
      case "executable": {
        const s = diskOptional(v, (x) => parseNonEmptyStringValue(x, "executable"));
        if (s === null) return null;
        if (s !== undefined) acp.executable = s;
        break;
      }
      case "model": {
        const s = diskOptional(v, (x) => parseNonEmptyStringValue(x, "model"));
        if (s === null) return null;
        if (s !== undefined) acp.model = s;
        break;
      }
      case "envKey": {
        const s = diskOptional(v, (x) => parseEnvKeyValue(x, "envKey"));
        if (s === null) return null;
        if (s !== undefined) acp.envKey = s;
        break;
      }
      case "baseUrlEnvKey": {
        const s = diskOptional(v, (x) => parseEnvKeyValue(x, "baseUrlEnvKey"));
        if (s === null) return null;
        if (s !== undefined) acp.baseUrlEnvKey = s;
        break;
      }
      case "credentialRef": {
        const s = diskOptional(v, parseCredentialRefValue);
        if (s === null) return null;
        if (s !== undefined) acp.credentialRef = s;
        break;
      }
      case "baseUrl": {
        const s = diskOptional(v, parseBaseUrlValue);
        if (s === null) return null;
        if (s !== undefined) acp.baseUrl = s;
        break;
      }
      case "permissionPolicy": {
        const p = diskOptional(v, parsePermissionPolicyValue);
        if (p === null) return null;
        if (p !== undefined) acp.permissionPolicy = p;
        break;
      }
      case "promptTimeoutMs": {
        const n = diskOptional(v, (x) => parsePositiveTimeoutValue(x, "promptTimeoutMs"));
        if (n === null) return null;
        if (n !== undefined) acp.promptTimeoutMs = n;
        break;
      }
      case "permissionTimeoutMs": {
        const n = diskOptional(v, (x) => parsePositiveTimeoutValue(x, "permissionTimeoutMs"));
        if (n === null) return null;
        if (n !== undefined) acp.permissionTimeoutMs = n;
        break;
      }
      default:
        return null;
    }
  }
  return acp;
}

function parseDiskFakeBag(value: unknown): FakeProfileOptions | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const fake: FakeProfileOptions = {};
  for (const key of Object.keys(raw)) {
    if (!DISK_FAKE_KEYS.has(key)) return null; // unknown fake key → malformed
    const v = raw[key];
    switch (key) {
      case "sleepMs": {
        if (v === undefined || v === null) break;
        if (typeof v !== "number" || !Number.isFinite(v)) return null;
        fake.sleepMs = v;
        break;
      }
      case "exitCode": {
        if (v === undefined || v === null) break;
        if (typeof v !== "number" || !Number.isFinite(v)) return null;
        fake.exitCode = v;
        break;
      }
      case "waitForSignal": {
        if (v === undefined || v === null) break;
        if (typeof v !== "boolean") return null;
        fake.waitForSignal = v;
        break;
      }
      case "emitStdout": {
        if (v === undefined || v === null) break;
        if (typeof v !== "boolean") return null;
        fake.emitStdout = v;
        break;
      }
      case "canResume": {
        if (v === undefined || v === null) break;
        if (typeof v !== "boolean") return null;
        fake.canResume = v;
        break;
      }
      case "failLaunch": {
        if (v === undefined || v === null) break;
        if (typeof v !== "string") return null;
        fake.failLaunch = v;
        break;
      }
      default:
        return null;
    }
  }
  return fake;
}

function parseDiskEnvMap(value: unknown): Record<string, string> | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

function parseDiskArgs(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/**
 * Strict disk-row parser for agent-profiles.json.
 * Returns null for any malformed row so the loader can quarantine the whole file —
 * never silently skip bad rows. Exact top-level allowlist only; unknown top-level /
 * acp / grokAcp / fake keys are malformed. Legacy `grokAcp` migrates to canonical
 * `acp` via normalizeProfileToCanonicalAcp.
 * Not exported — load path only; tests exercise via load/ensureDefaultProfiles.
 */
function parseAgentProfileDiskRow(
  value: unknown
): { profile: AgentProfileConfig; migrated: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;

  // Exact top-level allowlist: any extra key (apiKey, secrets, typos) is malformed.
  for (const key of Object.keys(item)) {
    if (!DISK_PROFILE_TOP_LEVEL_KEYS.has(key)) return null;
  }

  // id / adapterId are required structural fields (same gate as product CRUD id shape).
  const idResult = parseProfileIdValue(item.id);
  if (!idResult.ok) return null;
  const id = idResult.value;
  if (typeof item.adapterId !== "string" || !item.adapterId.trim()) return null;
  const adapterId = item.adapterId.trim();

  const raw: AgentProfileConfigRaw = { id, adapterId };

  if ("displayName" in item && item.displayName !== undefined && item.displayName !== null) {
    const displayName = diskOptional(item.displayName, (x) =>
      parseNonEmptyStringValue(x, "displayName")
    );
    if (displayName === null) return null;
    if (displayName !== undefined) raw.displayName = displayName;
  }

  if ("displayNameKey" in item && item.displayNameKey !== undefined && item.displayNameKey !== null) {
    if (typeof item.displayNameKey !== "string" || !item.displayNameKey.trim()) return null;
    raw.displayNameKey = item.displayNameKey.trim();
  }

  if ("command" in item && item.command !== undefined && item.command !== null) {
    const command = diskOptional(item.command, (x) => parseNonEmptyStringValue(x, "command"));
    if (command === null) return null;
    if (command !== undefined) raw.command = command;
  }

  if ("args" in item) {
    const args = parseDiskArgs(item.args);
    if (args === null) return null;
    if (args !== undefined) raw.args = args;
  }

  if ("env" in item) {
    const env = parseDiskEnvMap(item.env);
    if (env === null) return null;
    if (env !== undefined) raw.env = env;
  }

  if ("fake" in item && item.fake !== undefined && item.fake !== null) {
    const fake = parseDiskFakeBag(item.fake);
    if (fake === null) return null;
    raw.fake = fake;
  }

  if ("acp" in item && item.acp !== undefined && item.acp !== null) {
    const acp = parseDiskAcpBag(item.acp);
    if (acp === null) return null;
    raw.acp = acp;
  }

  if ("grokAcp" in item && item.grokAcp !== undefined && item.grokAcp !== null) {
    const grokAcp = parseDiskAcpBag(item.grokAcp);
    if (grokAcp === null) return null;
    raw.grokAcp = grokAcp;
  }

  if ("skills" in item && item.skills !== undefined && item.skills !== null) {
    const skillsR = parseSkillsArrayValue(item.skills, defaultAllowedSkillRoots());
    if (!skillsR.ok) return null;
    if (skillsR.value !== undefined) raw.skills = skillsR.value;
  }

  if ("mcpServers" in item && item.mcpServers !== undefined && item.mcpServers !== null) {
    const mcpR = parseMcpServersArrayValue(item.mcpServers);
    if (!mcpR.ok) return null;
    if (mcpR.value !== undefined) raw.mcpServers = mcpR.value;
  }

  return normalizeProfileToCanonicalAcp(raw);
}

export async function loadAgentProfiles(dataDir: string): Promise<AgentProfileConfig[]> {
  return (await loadAgentProfilesWithMigration(dataDir)).profiles;
}

/**
 * Load profiles and report whether any row still carried legacy `grokAcp` on disk.
 * ensureDefaultProfiles uses `migrated` to atomic-rewrite canonical `acp` without dual-write.
 *
 * Any malformed row (missing id/adapterId, unknown top-level/acp/fake key, bad acp shape)
 * quarantines the whole agent-profiles.json — never silent-skip into a shrunk catalog.
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
      return quarantineAgentProfilesFile(file);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return quarantineAgentProfilesFile(file);
    }
    const profiles = (parsed as { profiles?: unknown }).profiles;
    if (profiles !== undefined && !Array.isArray(profiles)) {
      return quarantineAgentProfilesFile(file);
    }
    const list = Array.isArray(profiles) ? profiles : [];
    let migrated = false;
    const out: AgentProfileConfig[] = [];
    for (const p of list) {
      const n = parseAgentProfileDiskRow(p);
      if (!n) {
        // One bad row poisons the whole machine-state file — never skip.
        return quarantineAgentProfilesFile(file);
      }
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
    {
      id: COPILOT_ACP_DEFAULT_PROFILE_ID,
      adapterId: COPILOT_ACP_ADAPTER_ID,
      displayNameKey: "profile.copilotAcp.default",
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
  "profile.copilotAcp.default": "GitHub Copilot ACP",
};

/**
 * Project a machine-local profile for clients / editors.
 * Non-secret fields only. Never includes env maps, API keys, tokens, or secret values.
 * Reads canonical `acp` bag (legacy grokAcp should already be migrated on load).
 * credentialRef is a vault id only; credentialExists is optional presence (no secret).
 */
export function projectAgentProfile(
  profile: AgentProfileConfig,
  opts?: { credentialExists?: boolean }
): AgentProfileProjection {
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
  const credentialRef =
    typeof g?.credentialRef === "string" && g.credentialRef.trim()
      ? g.credentialRef.trim()
      : undefined;
  const skills = projectSkillRefs(canonical.skills);
  const mcpServers = projectMcpServers(canonical.mcpServers);
  return {
    id: profile.id,
    adapterId: profile.adapterId,
    displayName,
    displayNameKey: profile.displayNameKey,
    model: g?.model,
    executable: g?.executable,
    envKey: g?.envKey,
    credentialRef,
    ...(credentialRef !== undefined && opts?.credentialExists !== undefined
      ? { credentialExists: opts.credentialExists }
      : {}),
    baseUrlEnvKey: g?.baseUrlEnvKey,
    baseUrl: g?.baseUrl,
    testOnly,
    permissionPolicy: g?.permissionPolicy,
    promptTimeoutMs: g?.promptTimeoutMs,
    permissionTimeoutMs: g?.permissionTimeoutMs,
    ...(skills !== undefined ? { skills } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
  };
}

/** Safe list for profile.list RPC — never secrets. */
export function projectAgentProfiles(
  profiles: AgentProfileConfig[],
  opts?: { credentialExistsById?: ReadonlyMap<string, boolean> | Record<string, boolean> }
): AgentProfileProjection[] {
  const existsMap = opts?.credentialExistsById;
  const lookup = (ref: string | undefined): boolean | undefined => {
    if (!ref || !existsMap) return undefined;
    if (existsMap instanceof Map) return existsMap.get(ref);
    return (existsMap as Record<string, boolean>)[ref];
  };
  return profiles
    .map((p) => {
      const ref = p.acp?.credentialRef;
      const exists = typeof ref === "string" ? lookup(ref.trim()) : undefined;
      return projectAgentProfile(p, exists === undefined ? undefined : { credentialExists: exists });
    })
    .sort((a, b) => {
      // Product profiles first; then id.
      if (a.testOnly !== b.testOnly) return a.testOnly ? 1 : -1;
      return a.id.localeCompare(b.id);
    });
}
