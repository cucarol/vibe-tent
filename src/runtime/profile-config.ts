// Machine-local AgentProfile shape helpers (canonical acp bag + legacy migration).
// Shared by runtime catalog clones and service load/save — not a CRUD surface.
// All legacy `grokAcp` reads/writes for disk + test fixtures go through this module.

import type { AcpProfileOptions } from "../adapters/acp/types.js";
import {
  cloneMcpServers,
  cloneSkillRefs,
} from "../adapters/acp/mcp-skills.js";
import { isSecretEnvKeyName } from "../adapters/acp/redact.js";
import type { AgentProfileConfig } from "./types.js";

/**
 * On-disk / inject shape that may still carry pre-canonical `grokAcp`.
 * Canonical in-memory and saved shape uses only `acp` (no dual-write).
 */
export type AgentProfileConfigRaw = AgentProfileConfig & {
  /** @deprecated Pre-canonical bag; load migrates to `acp` and drops this key. */
  grokAcp?: AcpProfileOptions;
};

/**
 * Normalize one profile row to canonical `acp` (drop legacy `grokAcp` from memory).
 * Does not invent provider defaults — only reshapes existing fields.
 * Returns `{ profile, migrated }` so callers can atomic-save when disk needed migration.
 * When both bags exist, `acp` wins (user/canonical fields are not overwritten by legacy).
 */
export function normalizeProfileToCanonicalAcp(
  raw: AgentProfileConfigRaw
): { profile: AgentProfileConfig; migrated: boolean } {
  const legacy = raw.grokAcp;
  const hasLegacy = legacy !== undefined && legacy !== null && typeof legacy === "object";
  const hasAcp = raw.acp !== undefined && raw.acp !== null && typeof raw.acp === "object";

  // Strip non-canonical grokAcp from the in-memory / saved shape.
  const { grokAcp: _drop, ...rest } = raw;
  void _drop;

  if (hasAcp) {
    // Canonical present: drop legacy bag only (do not merge-overwrite user acp fields).
    return {
      profile: { ...rest, acp: { ...raw.acp! } },
      migrated: hasLegacy,
    };
  }

  if (hasLegacy) {
    return {
      profile: { ...rest, acp: { ...legacy! } },
      migrated: true,
    };
  }

  return { profile: { ...rest }, migrated: false };
}

/**
 * Clone profile.env for durable SessionRegistry snapshots.
 * Secret-named keys keep the key (resume still knows which env to re-resolve)
 * but never persist the raw value — placeholders only.
 */
export function sanitizeProfileEnvForSnapshot(
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    out[key] = isSecretEnvKeyName(key) ? "[redacted]" : value;
  }
  return out;
}

/** Shallow clone of a canonical profile (one level of acp / fake / env / args / skills / mcp). */
export function cloneAgentProfileConfig(p: AgentProfileConfig): AgentProfileConfig {
  const { profile: canonical } = normalizeProfileToCanonicalAcp(p as AgentProfileConfigRaw);
  return {
    ...canonical,
    acp: canonical.acp ? { ...canonical.acp } : undefined,
    fake: canonical.fake ? { ...canonical.fake } : undefined,
    env: canonical.env ? { ...canonical.env } : undefined,
    args: canonical.args ? [...canonical.args] : undefined,
    skills: cloneSkillRefs(canonical.skills),
    mcpServers: cloneMcpServers(canonical.mcpServers),
  };
}

/**
 * Durable SessionRegistry profileSnapshot: same shape as clone, but secret-named
 * env values are redacted so projections/disk never retain raw credentials.
 */
export function cloneAgentProfileConfigForSnapshot(
  p: AgentProfileConfig
): AgentProfileConfig {
  const cloned = cloneAgentProfileConfig(p);
  return {
    ...cloned,
    env: sanitizeProfileEnvForSnapshot(cloned.env),
  };
}

/**
 * Build a pre-canonical on-disk / fixture row that still uses `grokAcp`.
 * **Only** for migration tests and temporary fixtures — product code writes `acp`.
 * Keeps legacy construction in one place so tests do not scatter `grokAcp:` bags.
 */
export function legacyGrokAcpDiskProfile(
  base: Omit<AgentProfileConfig, "acp"> & { grokAcp: AcpProfileOptions }
): AgentProfileConfigRaw {
  const { grokAcp, ...rest } = base;
  return {
    ...rest,
    grokAcp: { ...grokAcp },
  };
}
