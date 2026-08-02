// Minimal host env for managed ACP / provider children (cross-platform).
// Full process.env inheritance is intentionally not used.
// Contract: OS/process launch necessities only — not convenience network/Node tooling.

/**
 * Core-owned keys: route / request / adapter / arbitrary launchEnv cannot set these.
 * Only an explicit `reserved` / `coreEnv` overlay from AgentRuntime (or equivalent) may.
 */
export const RESERVED_TENT_CHILD_ENV_KEYS = [
  "TENT_SERVICE_DATA_DIR",
  "TENT_SERVICE_TOKEN",
  "TENT_SERVICE_URL",
  "TENT_SERVICE_HOST",
  "TENT_SERVICE_PORT",
  "TENT_SESSION_ID",
  "TENT_SESSION_TOKEN",
] as const;

export type ReservedTentChildEnvKey = (typeof RESERVED_TENT_CHILD_ENV_KEYS)[number];

const RESERVED_KEY_SET = new Set<string>(
  RESERVED_TENT_CHILD_ENV_KEYS.map((k) => k.toUpperCase())
);

/**
 * Cross-platform launch necessities only.
 * Explicitly NOT inherited (must come from validated launchEnv if needed):
 * NODE_OPTIONS, NODE_PATH, npm_*, proxy vars, SSL/CA cert paths, usernames, ProgramFiles.
 */
const COMMON_HOST_ENV_KEYS = [
  "PATH",
  "Path", // Windows may expose mixed case
  "TMP",
  "TEMP",
  "TMPDIR",
  // Narrow locale only — enough for libc/node message catalogs, not full user identity.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const;

const WIN32_HOST_ENV_KEYS = [
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "USERPROFILE",
  "HOME",
  // HOMEDRIVE+HOMEPATH together resolve ~ equivalent on some Windows toolchains
  "HOMEDRIVE",
  "HOMEPATH",
] as const;

const POSIX_HOST_ENV_KEYS = ["HOME"] as const;

export function isReservedTentChildEnvKey(key: string): boolean {
  return RESERVED_KEY_SET.has(key.toUpperCase());
}

/**
 * Strip reserved Tent keys from an arbitrary env bag (route / request / launch overlay).
 * Core re-applies authoritative values only via the explicit `reserved` argument.
 */
export function stripReservedTentChildEnv(
  env: Record<string, string> | NodeJS.ProcessEnv | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const [key, value] of Object.entries(env)) {
    if (value == null) continue;
    if (isReservedTentChildEnvKey(key)) continue;
    if (typeof value !== "string") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Copy only the minimal host allowlist from `hostEnv` (default: process.env).
 * Does not include NODE_OPTIONS, proxies, npm_* paths, or Tent service routing keys.
 */
export function pickMinimalHostEnv(
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const keys = new Set<string>([
    ...COMMON_HOST_ENV_KEYS,
    ...(platform === "win32" ? WIN32_HOST_ENV_KEYS : POSIX_HOST_ENV_KEYS),
  ]);
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = hostEnv[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  // Windows PATH is case-insensitive; ensure PATH is set if only Path exists.
  if (platform === "win32" && out.PATH == null && typeof hostEnv.Path === "string") {
    out.PATH = hostEnv.Path;
  }
  return out;
}

export type BuildManagedChildEnvOptions = {
  /** Validated Settings route / adapter env. Reserved keys are always stripped. */
  launchEnv?: Record<string, string> | NodeJS.ProcessEnv;
  /** Host process env to sample allowlist from (tests inject). */
  hostEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * Core-owned reserved values forced last (Service data-dir, session id, …).
   * Only this overlay may set reserved keys — never launchEnv alone.
   */
  reserved?: Partial<Record<ReservedTentChildEnvKey, string | undefined>>;
};

/**
 * Final child env for managed ACP / provider spawns:
 * minimal host allowlist → launchEnv (reserved stripped) → explicit Core reserved overlay.
 *
 * Arbitrary launchEnv cannot smuggle reserved Tent keys; callers must pass `reserved`.
 */
export function buildManagedChildEnv(
  options: BuildManagedChildEnvOptions = {}
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const host = pickMinimalHostEnv(options.hostEnv ?? process.env, platform);
  const launch = stripReservedTentChildEnv(options.launchEnv);
  const out: Record<string, string> = {
    ...host,
    ...launch,
  };
  // Drop any reserved key that slipped in via host allowlist (none today) or case variants.
  for (const key of Object.keys(out)) {
    if (isReservedTentChildEnvKey(key)) delete out[key];
  }
  if (options.reserved) {
    for (const key of RESERVED_TENT_CHILD_ENV_KEYS) {
      const value = options.reserved[key];
      if (typeof value === "string" && value.length > 0) {
        out[key] = value;
      }
    }
  }
  return out;
}
