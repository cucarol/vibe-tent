// Minimal host env for managed ACP / provider children (cross-platform).
// Full process.env inheritance is intentionally not used.

/**
 * Core-owned keys: profile / request / adapter env cannot override these.
 * AgentRuntime forces TENT_SERVICE_DATA_DIR; session identity is set by adapters
 * from the LaunchPlan and re-asserted here when building the final child env.
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

/** Cross-platform launch necessities only (PATH/HOME/TMP + Windows cmd/npm resolution). */
const COMMON_HOST_ENV_KEYS = [
  "PATH",
  "Path", // Windows may expose mixed case; we copy both if present
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
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
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "USERNAME",
  "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "PUBLIC",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "NUMBER_OF_PROCESSORS",
  "PATHEXT",
  // npm / node resolution on Windows often needs these when spawning .cmd shims
  "npm_config_user_agent",
  "npm_node_execpath",
  "npm_execpath",
] as const;

const POSIX_HOST_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "XDG_RUNTIME_DIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

export function isReservedTentChildEnvKey(key: string): boolean {
  return RESERVED_KEY_SET.has(key.toUpperCase());
}

/**
 * Strip reserved Tent keys from an arbitrary env bag (profile / request overlay).
 * Core re-applies authoritative values after the overlay.
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
 * Does not include arbitrary caller secrets or Tent service routing keys.
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
  /** Validated LaunchProfile / adapter / plan env (non-reserved keys preferred). */
  launchEnv?: Record<string, string> | NodeJS.ProcessEnv;
  /** Host process env to sample allowlist from (tests inject). */
  hostEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * Core-owned reserved values forced last (Service data-dir, session id, …).
   * Always win over host allowlist and launchEnv.
   */
  reserved?: Partial<Record<ReservedTentChildEnvKey, string | undefined>>;
};

/**
 * Final child env for managed ACP / provider spawns:
 * minimal host allowlist → launchEnv (reserved stripped) → Core reserved overlay.
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
  if (options.reserved) {
    for (const key of RESERVED_TENT_CHILD_ENV_KEYS) {
      const value = options.reserved[key];
      if (typeof value === "string" && value.length > 0) {
        out[key] = value;
      } else {
        // Do not leave stale host/launch values for reserved keys.
        delete out[key];
      }
    }
  } else {
    for (const key of Object.keys(out)) {
      if (isReservedTentChildEnvKey(key) && options.launchEnv?.[key] === undefined) {
        // No core reserved overlay: drop accidental host reserved bleed.
        delete out[key];
      }
    }
  }
  return out;
}
