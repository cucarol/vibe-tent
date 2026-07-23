// AgentProfile Skill refs + MCP server config → ACP session/new|load projection.
// Tent does not proxy MCP, does not mirror SKILL.md bodies, and does not rewrite agent config.toml.
// Adapter-safe module: no service/ imports (architecture: adapters ↛ service).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Safe skill directory / name: no path separators, no traversal. */
export const SAFE_SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** MCP server name: letters, digits, hyphen, underscore. */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Process env name shape for envKey maps. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Same vault id shape as CredentialStore (reference only). */
export const CREDENTIAL_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

export const MAX_PROFILE_SKILLS = 64;
export const MAX_PROFILE_MCP_SERVERS = 32;
export const MAX_MCP_ARGS = 64;
export const MAX_MCP_ENV_ENTRIES = 32;
export const MAX_MCP_HEADER_ENTRIES = 16;

export type FieldResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

function fieldOk<T>(value: T): FieldResult<T> {
  return { ok: true, value };
}

function fieldErr(message: string): FieldResult<never> {
  return { ok: false, message };
}

/**
 * Machine-local skill reference only — never SKILL.md body.
 * `name` is the stable identity; `path` is optional absolute path under allowed roots.
 */
export interface AgentProfileSkillRef {
  name: string;
  /** Absolute path to skill directory or SKILL.md under an allowed skill root. */
  path?: string;
  /** Default true. Stored when false so user can re-enable later. */
  enabled?: boolean;
}

export type AgentProfileMcpTransport = "stdio" | "http";

/**
 * Machine-local MCP server description for ACP mcpServers projection.
 * Secrets only as envKey / credentialRef — never plaintext values on disk or projection.
 */
export interface AgentProfileMcpServer {
  name: string;
  transport: AgentProfileMcpTransport;
  /** Default true. */
  enabled?: boolean;
  // ---- stdio ----
  command?: string;
  args?: string[];
  /**
   * MCP process env var name → process env *key name* (value resolved at launch).
   * Never stores secret values.
   */
  envKeys?: Record<string, string>;
  /**
   * MCP process env var name → CredentialStore id (value resolved at launch only).
   */
  envCredentialRefs?: Record<string, string>;
  // ---- http ----
  url?: string;
  /** HTTP header name → process env *key name*. */
  headerEnvKeys?: Record<string, string>;
  /** HTTP header name → CredentialStore id. */
  headerCredentialRefs?: Record<string, string>;
}

/**
 * Safe client projection (no secret values).
 * Name/path refs only — not a claim that the provider activated the skill.
 */
export type AgentProfileSkillProjection = {
  name: string;
  path?: string;
  enabled: boolean;
};

export type AgentProfileMcpServerProjection = {
  name: string;
  transport: AgentProfileMcpTransport;
  enabled: boolean;
  command?: string;
  args?: string[];
  envKeys?: Record<string, string>;
  envCredentialRefs?: Record<string, string>;
  url?: string;
  headerEnvKeys?: Record<string, string>;
  headerCredentialRefs?: Record<string, string>;
};

/**
 * ACP wire shape for session/new and session/load `mcpServers`.
 * Secret *values* may appear here only in the in-process JSON-RPC request —
 * never on SessionRecord, profile disk, projection, events, or logs.
 */
export type AcpMcpServerWire =
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    }
  | {
      name: string;
      type: "http";
      url: string;
      headers?: Array<{ name: string; value: string }>;
    };

/**
 * Skill refs projected into session/new|load `_meta.tent.skills` (paths/names only).
 * Tent metadata for adapters that honor it — not universal provider skill activation.
 */
export type AcpSkillMetaRef = {
  name: string;
  path?: string;
};

export type ResolveMcpSecret = (credentialRef: string) => string | undefined;

// ---------------------------------------------------------------------------
// Allowed skill roots (machine-local user skill dirs only — no remote / arbitrary).
// ---------------------------------------------------------------------------

export function defaultAllowedSkillRoots(home?: string): string[] {
  const root = home ?? os.homedir();
  return [
    path.join(root, ".agents", "skills"),
    path.join(root, ".claude", "skills"),
    path.join(root, ".grok", "skills"),
    path.join(root, ".cursor", "skills"),
  ];
}

function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * True when `candidate` is the root or a path strictly inside it.
 * Uses path.relative to avoid prefix false-positives.
 */
export function isPathInsideRoot(candidate: string, root: string): boolean {
  const c = normalizePathForCompare(candidate);
  const r = normalizePathForCompare(root);
  if (c === r) return true;
  const rel = path.relative(r, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isUnderAllowedSkillRoots(
  absolutePath: string,
  allowedRoots: readonly string[]
): boolean {
  const abs = path.resolve(absolutePath);
  return allowedRoots.some((root) => isPathInsideRoot(abs, root));
}

function parseNonEmptyString(raw: unknown, key: string): FieldResult<string> {
  if (typeof raw !== "string") {
    return fieldErr(`Invalid string param: ${key}`);
  }
  const v = raw.trim();
  if (!v) {
    return fieldErr(`Invalid string param: ${key} must be non-empty when set`);
  }
  return fieldOk(v);
}

function parseEnvKeyName(raw: unknown, key: string): FieldResult<string> {
  const base = parseNonEmptyString(raw, key);
  if (!base.ok) return base;
  if (!ENV_KEY_RE.test(base.value)) {
    return fieldErr(
      `Invalid ${key}: must be a process env name (A-Za-z_ then A-Za-z0-9_)`
    );
  }
  return fieldOk(base.value);
}

function parseCredentialId(raw: unknown, key: string): FieldResult<string> {
  const base = parseNonEmptyString(raw, key);
  if (!base.ok) return base;
  if (!CREDENTIAL_ID_RE.test(base.value)) {
    return fieldErr(
      `Invalid ${key}: must match ${CREDENTIAL_ID_RE} (vault id, not secret value)`
    );
  }
  return fieldOk(base.value);
}

export function assertSafeSkillName(name: unknown): FieldResult<string> {
  const base = parseNonEmptyString(name, "skills[].name");
  if (!base.ok) return base;
  if (!SAFE_SKILL_NAME_RE.test(base.value) || base.value.includes("..")) {
    return fieldErr(
      `Invalid skills[].name: must match ${SAFE_SKILL_NAME_RE} (no path separators)`
    );
  }
  return fieldOk(base.value);
}

// ---------------------------------------------------------------------------
// Parse / validate (shared by product CRUD + disk load)
// ---------------------------------------------------------------------------

function parseStringRecord(
  raw: unknown,
  field: string,
  valueParse: (v: unknown, key: string) => FieldResult<string>,
  maxEntries: number
): FieldResult<Record<string, string> | undefined> {
  if (raw === undefined || raw === null) return fieldOk(undefined);
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return fieldErr(`Invalid ${field}: must be an object of string→string`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > maxEntries) {
    return fieldErr(`Invalid ${field}: at most ${maxEntries} entries`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const key = k.trim();
    if (!key) return fieldErr(`Invalid ${field}: empty key`);
    const parsed = valueParse(v, `${field}.${key}`);
    if (!parsed.ok) return parsed;
    out[key] = parsed.value;
  }
  return fieldOk(out);
}

function parseEnvKeyMap(
  raw: unknown,
  field: string,
  maxEntries: number
): FieldResult<Record<string, string> | undefined> {
  return parseStringRecord(raw, field, (v, k) => parseEnvKeyName(v, k), maxEntries);
}

function parseCredentialRefMap(
  raw: unknown,
  field: string,
  maxEntries: number
): FieldResult<Record<string, string> | undefined> {
  return parseStringRecord(raw, field, (v, k) => parseCredentialId(v, k), maxEntries);
}

/** Reject absolute paths that are not under allowed skill roots. */
export function parseSkillPathValue(
  raw: unknown,
  allowedRoots: readonly string[]
): FieldResult<string> {
  const base = parseNonEmptyString(raw, "skills[].path");
  if (!base.ok) return base;
  const p = base.value;
  if (!path.isAbsolute(p)) {
    return fieldErr(
      "Invalid skills[].path: must be an absolute path under an allowed skill root"
    );
  }
  if (p.includes("\0")) {
    return fieldErr("Invalid skills[].path: contains NUL");
  }
  const resolved = path.resolve(p);
  if (!isUnderAllowedSkillRoots(resolved, allowedRoots)) {
    return fieldErr(
      `Invalid skills[].path: must be under allowed skill roots (${allowedRoots.join(", ")})`
    );
  }
  return fieldOk(resolved);
}

export function parseSkillRefValue(
  raw: unknown,
  allowedRoots: readonly string[]
): FieldResult<AgentProfileSkillRef> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fieldErr("Invalid skills[] entry: must be an object with name");
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "name" && key !== "path" && key !== "enabled") {
      return fieldErr(`Unknown skills[] field: ${key}`);
    }
  }
  const nameR = assertSafeSkillName(o.name);
  if (!nameR.ok) return nameR;

  let pathVal: string | undefined;
  if ("path" in o && o.path !== undefined && o.path !== null) {
    const pr = parseSkillPathValue(o.path, allowedRoots);
    if (!pr.ok) return pr;
    pathVal = pr.value;
  }

  let enabled: boolean | undefined;
  if ("enabled" in o && o.enabled !== undefined && o.enabled !== null) {
    if (typeof o.enabled !== "boolean") {
      return fieldErr("Invalid skills[].enabled: must be boolean");
    }
    enabled = o.enabled;
  }

  const ref: AgentProfileSkillRef = { name: nameR.value };
  if (pathVal !== undefined) ref.path = pathVal;
  if (enabled !== undefined) ref.enabled = enabled;
  return fieldOk(ref);
}

export function parseSkillsArrayValue(
  raw: unknown,
  allowedRoots: readonly string[] = defaultAllowedSkillRoots()
): FieldResult<AgentProfileSkillRef[] | undefined> {
  if (raw === undefined || raw === null) return fieldOk(undefined);
  if (!Array.isArray(raw)) {
    return fieldErr("Invalid skills: must be an array");
  }
  if (raw.length > MAX_PROFILE_SKILLS) {
    return fieldErr(`Invalid skills: at most ${MAX_PROFILE_SKILLS} entries`);
  }
  const out: AgentProfileSkillRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const r = parseSkillRefValue(item, allowedRoots);
    if (!r.ok) return r;
    const key = r.value.name.toLowerCase();
    if (seen.has(key)) {
      return fieldErr(`Duplicate skill name in skills: ${r.value.name}`);
    }
    seen.add(key);
    out.push(r.value);
  }
  return fieldOk(out);
}

function parseMcpName(raw: unknown): FieldResult<string> {
  const base = parseNonEmptyString(raw, "mcpServers[].name");
  if (!base.ok) return base;
  if (!MCP_SERVER_NAME_RE.test(base.value)) {
    return fieldErr(
      `Invalid mcpServers[].name: must match ${MCP_SERVER_NAME_RE}`
    );
  }
  return fieldOk(base.value);
}

function parseHttpUrl(raw: unknown): FieldResult<string> {
  const base = parseNonEmptyString(raw, "mcpServers[].url");
  if (!base.ok) return base;
  let parsed: URL;
  try {
    parsed = new URL(base.value);
  } catch {
    return fieldErr("Invalid mcpServers[].url: must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fieldErr("Invalid mcpServers[].url: only http: and https: are allowed");
  }
  if (parsed.username || parsed.password) {
    return fieldErr(
      "Invalid mcpServers[].url: username/password in URL are not allowed"
    );
  }
  return fieldOk(base.value);
}

export function parseMcpServerValue(raw: unknown): FieldResult<AgentProfileMcpServer> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fieldErr("Invalid mcpServers[] entry: must be an object");
  }
  const o = raw as Record<string, unknown>;
  const allowed = new Set([
    "name",
    "transport",
    "enabled",
    "command",
    "args",
    "envKeys",
    "envCredentialRefs",
    "url",
    "headerEnvKeys",
    "headerCredentialRefs",
  ]);
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) {
      const lower = key.toLowerCase();
      if (
        lower === "env" ||
        lower === "headers" ||
        lower.includes("secret") ||
        lower.includes("token") ||
        lower.includes("apikey") ||
        lower.includes("password") ||
        lower.includes("authorization") ||
        lower.includes("bearer")
      ) {
        return fieldErr(
          `Rejected dangerous or unsupported mcpServers[] field: ${key} (use envKeys/envCredentialRefs/headerEnvKeys/headerCredentialRefs)`
        );
      }
      return fieldErr(`Unknown mcpServers[] field: ${key}`);
    }
  }

  const nameR = parseMcpName(o.name);
  if (!nameR.ok) return nameR;

  if (typeof o.transport !== "string" || (o.transport !== "stdio" && o.transport !== "http")) {
    return fieldErr("Invalid mcpServers[].transport: must be stdio|http");
  }
  const transport = o.transport as AgentProfileMcpTransport;

  let enabled: boolean | undefined;
  if ("enabled" in o && o.enabled !== undefined && o.enabled !== null) {
    if (typeof o.enabled !== "boolean") {
      return fieldErr("Invalid mcpServers[].enabled: must be boolean");
    }
    enabled = o.enabled;
  }

  const server: AgentProfileMcpServer = { name: nameR.value, transport };
  if (enabled !== undefined) server.enabled = enabled;

  if (transport === "stdio") {
    if ("url" in o && o.url !== undefined && o.url !== null) {
      return fieldErr("Invalid mcpServers[]: stdio transport must not set url");
    }
    if ("headerEnvKeys" in o && o.headerEnvKeys != null) {
      return fieldErr("Invalid mcpServers[]: stdio transport must not set headerEnvKeys");
    }
    if ("headerCredentialRefs" in o && o.headerCredentialRefs != null) {
      return fieldErr(
        "Invalid mcpServers[]: stdio transport must not set headerCredentialRefs"
      );
    }
    const cmd = parseNonEmptyString(o.command, "mcpServers[].command");
    if (!cmd.ok) return cmd;
    server.command = cmd.value;

    if ("args" in o && o.args !== undefined && o.args !== null) {
      if (!Array.isArray(o.args) || !o.args.every((a) => typeof a === "string")) {
        return fieldErr("Invalid mcpServers[].args: must be an array of strings");
      }
      if (o.args.length > MAX_MCP_ARGS) {
        return fieldErr(`Invalid mcpServers[].args: at most ${MAX_MCP_ARGS} entries`);
      }
      server.args = o.args.map((a) => a as string);
    }

    const envKeys = parseEnvKeyMap(o.envKeys, "mcpServers[].envKeys", MAX_MCP_ENV_ENTRIES);
    if (!envKeys.ok) return envKeys;
    if (envKeys.value) server.envKeys = envKeys.value;

    const envCreds = parseCredentialRefMap(
      o.envCredentialRefs,
      "mcpServers[].envCredentialRefs",
      MAX_MCP_ENV_ENTRIES
    );
    if (!envCreds.ok) return envCreds;
    if (envCreds.value) server.envCredentialRefs = envCreds.value;
  } else {
    if ("command" in o && o.command !== undefined && o.command !== null) {
      return fieldErr("Invalid mcpServers[]: http transport must not set command");
    }
    if ("args" in o && o.args !== undefined && o.args !== null) {
      return fieldErr("Invalid mcpServers[]: http transport must not set args");
    }
    if ("envKeys" in o && o.envKeys != null) {
      return fieldErr("Invalid mcpServers[]: http transport must not set envKeys");
    }
    if ("envCredentialRefs" in o && o.envCredentialRefs != null) {
      return fieldErr(
        "Invalid mcpServers[]: http transport must not set envCredentialRefs"
      );
    }
    const urlR = parseHttpUrl(o.url);
    if (!urlR.ok) return urlR;
    server.url = urlR.value;

    const headerEnv = parseEnvKeyMap(
      o.headerEnvKeys,
      "mcpServers[].headerEnvKeys",
      MAX_MCP_HEADER_ENTRIES
    );
    if (!headerEnv.ok) return headerEnv;
    if (headerEnv.value) server.headerEnvKeys = headerEnv.value;

    const headerCreds = parseCredentialRefMap(
      o.headerCredentialRefs,
      "mcpServers[].headerCredentialRefs",
      MAX_MCP_HEADER_ENTRIES
    );
    if (!headerCreds.ok) return headerCreds;
    if (headerCreds.value) server.headerCredentialRefs = headerCreds.value;
  }

  return fieldOk(server);
}

export function parseMcpServersArrayValue(
  raw: unknown
): FieldResult<AgentProfileMcpServer[] | undefined> {
  if (raw === undefined || raw === null) return fieldOk(undefined);
  if (!Array.isArray(raw)) {
    return fieldErr("Invalid mcpServers: must be an array");
  }
  if (raw.length > MAX_PROFILE_MCP_SERVERS) {
    return fieldErr(`Invalid mcpServers: at most ${MAX_PROFILE_MCP_SERVERS} entries`);
  }
  const out: AgentProfileMcpServer[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const r = parseMcpServerValue(item);
    if (!r.ok) return r;
    const key = r.value.name.toLowerCase();
    if (seen.has(key)) {
      return fieldErr(`Duplicate mcpServers name: ${r.value.name}`);
    }
    seen.add(key);
    out.push(r.value);
  }
  return fieldOk(out);
}

// ---------------------------------------------------------------------------
// Clone / project / resolve for ACP wire
// ---------------------------------------------------------------------------

export function cloneSkillRefs(
  skills: AgentProfileSkillRef[] | undefined
): AgentProfileSkillRef[] | undefined {
  if (!skills) return undefined;
  return skills.map((s) => ({
    name: s.name,
    ...(s.path !== undefined ? { path: s.path } : {}),
    ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
  }));
}

export function cloneMcpServers(
  servers: AgentProfileMcpServer[] | undefined
): AgentProfileMcpServer[] | undefined {
  if (!servers) return undefined;
  return servers.map((s) => ({
    name: s.name,
    transport: s.transport,
    ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
    ...(s.command !== undefined ? { command: s.command } : {}),
    ...(s.args !== undefined ? { args: [...s.args] } : {}),
    ...(s.envKeys !== undefined ? { envKeys: { ...s.envKeys } } : {}),
    ...(s.envCredentialRefs !== undefined
      ? { envCredentialRefs: { ...s.envCredentialRefs } }
      : {}),
    ...(s.url !== undefined ? { url: s.url } : {}),
    ...(s.headerEnvKeys !== undefined ? { headerEnvKeys: { ...s.headerEnvKeys } } : {}),
    ...(s.headerCredentialRefs !== undefined
      ? { headerCredentialRefs: { ...s.headerCredentialRefs } }
      : {}),
  }));
}

export function projectSkillRefs(
  skills: AgentProfileSkillRef[] | undefined
): AgentProfileSkillProjection[] | undefined {
  if (!skills || skills.length === 0) return undefined;
  return skills.map((s) => ({
    name: s.name,
    ...(s.path !== undefined ? { path: s.path } : {}),
    enabled: s.enabled !== false,
  }));
}

export function projectMcpServers(
  servers: AgentProfileMcpServer[] | undefined
): AgentProfileMcpServerProjection[] | undefined {
  if (!servers || servers.length === 0) return undefined;
  return servers.map((s) => ({
    name: s.name,
    transport: s.transport,
    enabled: s.enabled !== false,
    ...(s.command !== undefined ? { command: s.command } : {}),
    ...(s.args !== undefined ? { args: [...s.args] } : {}),
    ...(s.envKeys !== undefined ? { envKeys: { ...s.envKeys } } : {}),
    ...(s.envCredentialRefs !== undefined
      ? { envCredentialRefs: { ...s.envCredentialRefs } }
      : {}),
    ...(s.url !== undefined ? { url: s.url } : {}),
    ...(s.headerEnvKeys !== undefined ? { headerEnvKeys: { ...s.headerEnvKeys } } : {}),
    ...(s.headerCredentialRefs !== undefined
      ? { headerCredentialRefs: { ...s.headerCredentialRefs } }
      : {}),
  }));
}

function resolveEnvValue(
  envKey: string,
  planEnv: Record<string, string>
): string | undefined {
  const fromPlan = planEnv[envKey];
  if (typeof fromPlan === "string" && fromPlan.length > 0) return fromPlan;
  const fromProc = process.env[envKey];
  if (typeof fromProc === "string" && fromProc.length > 0) return fromProc;
  return undefined;
}

/**
 * Build ACP mcpServers wire array from profile config.
 * Enabled servers only. Fail-loud when a required secret cannot be resolved.
 * Returned values may contain secrets — caller must only use them for in-process
 * session/new|load and must not log, persist, or emit them.
 */
export function resolveAcpMcpServersWire(
  servers: AgentProfileMcpServer[] | undefined,
  opts: {
    planEnv: Record<string, string>;
    resolveCredential?: ResolveMcpSecret;
  }
): AcpMcpServerWire[] {
  if (!servers || servers.length === 0) return [];
  const wire: AcpMcpServerWire[] = [];
  for (const s of servers) {
    if (s.enabled === false) continue;
    if (s.transport === "stdio") {
      const command = s.command?.trim();
      if (!command) {
        throw new Error(`MCP server ${s.name}: stdio requires command`);
      }
      const env: Array<{ name: string; value: string }> = [];
      if (s.envKeys) {
        for (const [envName, envKey] of Object.entries(s.envKeys)) {
          const value = resolveEnvValue(envKey, opts.planEnv);
          if (value === undefined) {
            throw new Error(
              `MCP server ${s.name}: missing process env ${envKey} for env var ${envName}`
            );
          }
          env.push({ name: envName, value });
        }
      }
      if (s.envCredentialRefs) {
        for (const [envName, credId] of Object.entries(s.envCredentialRefs)) {
          if (!opts.resolveCredential) {
            throw new Error(
              `MCP server ${s.name}: credentialRef ${credId} requires resolveCredential hook`
            );
          }
          const value = opts.resolveCredential(credId);
          if (typeof value !== "string" || !value) {
            throw new Error(
              `MCP server ${s.name}: credential not found or empty for ${credId} (env ${envName})`
            );
          }
          env.push({ name: envName, value });
        }
      }
      wire.push({
        name: s.name,
        command,
        args: s.args ? [...s.args] : [],
        env,
      });
    } else {
      const url = s.url?.trim();
      if (!url) {
        throw new Error(`MCP server ${s.name}: http requires url`);
      }
      const headers: Array<{ name: string; value: string }> = [];
      if (s.headerEnvKeys) {
        for (const [headerName, envKey] of Object.entries(s.headerEnvKeys)) {
          const value = resolveEnvValue(envKey, opts.planEnv);
          if (value === undefined) {
            throw new Error(
              `MCP server ${s.name}: missing process env ${envKey} for header ${headerName}`
            );
          }
          headers.push({ name: headerName, value });
        }
      }
      if (s.headerCredentialRefs) {
        for (const [headerName, credId] of Object.entries(s.headerCredentialRefs)) {
          if (!opts.resolveCredential) {
            throw new Error(
              `MCP server ${s.name}: credentialRef ${credId} requires resolveCredential hook`
            );
          }
          const value = opts.resolveCredential(credId);
          if (typeof value !== "string" || !value) {
            throw new Error(
              `MCP server ${s.name}: credential not found or empty for ${credId} (header ${headerName})`
            );
          }
          headers.push({ name: headerName, value });
        }
      }
      wire.push({
        name: s.name,
        type: "http",
        url,
        ...(headers.length > 0 ? { headers } : {}),
      });
    }
  }
  return wire;
}

/**
 * Enabled skill refs for session `_meta.tent.skills` (names/paths only).
 * Does not read or embed SKILL.md content.
 * When requirePathExists is true (start/resume), enabled path refs fail loud if missing;
 * name-only refs remain allowed.
 */
export function resolveAcpSkillMeta(
  skills: AgentProfileSkillRef[] | undefined,
  opts?: { requirePathExists?: boolean }
): AcpSkillMetaRef[] {
  if (!skills || skills.length === 0) return [];
  const out: AcpSkillMetaRef[] = [];
  for (const s of skills) {
    if (s.enabled === false) continue;
    if (s.path && opts?.requirePathExists) {
      if (!fs.existsSync(s.path)) {
        throw new Error(`Skill ${s.name}: path does not exist: ${s.path}`);
      }
    }
    out.push({
      name: s.name,
      ...(s.path !== undefined ? { path: s.path } : {}),
    });
  }
  return out;
}

/** Redact secret-bearing MCP wire for diagnostics (never log values). */
export function summarizeMcpServersWire(servers: AcpMcpServerWire[]): Array<{
  name: string;
  transport: "stdio" | "http";
  envCount?: number;
  headerCount?: number;
}> {
  return servers.map((s) => {
    if ("command" in s) {
      return {
        name: s.name,
        transport: "stdio" as const,
        envCount: s.env.length,
      };
    }
    return {
      name: s.name,
      transport: "http" as const,
      headerCount: s.headers?.length ?? 0,
    };
  });
}
