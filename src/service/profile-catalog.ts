// In-process machine-local AgentProfile catalog (serial CRUD + runtime sync).
// Validation, patch helpers, and AgentProfileCatalog live here.
// Load / save / defaults / projection stay in profiles.ts (no circular import).

import type { AcpPermissionPolicy, AcpProfileOptions } from "../adapters/acp/types.js";
import type { AgentProfileConfig } from "../runtime/types.js";
import { cloneAgentProfileConfig } from "../runtime/profile-config.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import { SessionRegistry } from "../runtime/session-registry.js";
import {
  DEFAULT_GROK_BASE_URL_ENV_KEY,
  DEFAULT_GROK_ENV_KEY,
  DEFAULT_GROK_MODEL,
  GROK_ACP_ADAPTER_ID,
} from "../adapters/grok-acp/index.js";
import {
  defaultAgentProfiles,
  FAKE_DEFAULT_PROFILE_ID,
  isBuiltinDefaultProfileId,
  isProductAcpAdapterId,
  isTestOnlyProfile,
  PRODUCT_ACP_ADAPTER_IDS,
  PROFILE_CREATE_FIELDS,
  PROFILE_UPDATE_FIELDS,
  saveAgentProfiles,
  type ProductAcpAdapterId,
} from "./profiles.js";
import { RpcError } from "./rpc-error.js";

// ---------------------------------------------------------------------------
// Validation helpers (clear RpcError, never silent discard of bad input)
// ---------------------------------------------------------------------------

const PROFILE_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const PERMISSION_POLICIES = new Set<AcpPermissionPolicy>(["allow", "ask", "deny"]);

/** Field names that must never be accepted via product CRUD (explicit reject). */
const DANGEROUS_FIELD_HINTS = [
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "credential",
  "authorization",
  "bearer",
  "env",
  "fake",
  "command",
  "args",
  "displayNameKey",
  "grokAcp",
  "acp",
] as const;

function rejectUnknownAndDangerous(
  raw: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (allowedSet.has(key)) continue;
    const lower = key.toLowerCase();
    const dangerous = DANGEROUS_FIELD_HINTS.some(
      (d) => lower === d.toLowerCase() || lower.includes(d.toLowerCase())
    );
    if (dangerous || lower.includes("secret") || lower.includes("token") || lower.includes("apikey")) {
      throw new RpcError(
        -32602,
        `Rejected dangerous or unsupported profile field: ${key}`
      );
    }
    throw new RpcError(-32602, `Unknown profile field: ${key}`);
  }
}

function requireProfileId(raw: unknown, field = "id"): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new RpcError(-32602, `Missing or invalid string param: ${field}`);
  }
  const id = raw.trim();
  if (!PROFILE_ID_RE.test(id)) {
    throw new RpcError(
      -32602,
      `Invalid profile id: must match ${PROFILE_ID_RE} (lowercase letter, then a-z0-9-, max 63)`
    );
  }
  return id;
}

/**
 * Optional string for create: absent/undefined/null → omit; empty string rejected.
 * For update use clearable* helpers (null clears).
 */
function optionalNonEmptyString(
  raw: Record<string, unknown>,
  key: string
): string | undefined {
  if (!(key in raw) || raw[key] === undefined || raw[key] === null) return undefined;
  if (typeof raw[key] !== "string") {
    throw new RpcError(-32602, `Invalid string param: ${key}`);
  }
  const v = (raw[key] as string).trim();
  if (!v) {
    throw new RpcError(-32602, `Invalid string param: ${key} must be non-empty when set`);
  }
  return v;
}

/** Update: undefined/absent keep; null clear; string set. */
function clearableNonEmptyString(
  raw: Record<string, unknown>,
  key: string
): string | null | undefined {
  if (!(key in raw) || raw[key] === undefined) return undefined;
  if (raw[key] === null) return null;
  if (typeof raw[key] !== "string") {
    throw new RpcError(-32602, `Invalid string param: ${key}`);
  }
  const v = (raw[key] as string).trim();
  if (!v) {
    throw new RpcError(-32602, `Invalid string param: ${key} must be non-empty when set`);
  }
  return v;
}

function optionalEnvKey(raw: Record<string, unknown>, key: string): string | undefined {
  const v = optionalNonEmptyString(raw, key);
  if (v === undefined) return undefined;
  if (!ENV_KEY_RE.test(v)) {
    throw new RpcError(
      -32602,
      `Invalid ${key}: must be a process env name (A-Za-z_ then A-Za-z0-9_)`
    );
  }
  return v;
}

function clearableEnvKey(
  raw: Record<string, unknown>,
  key: string
): string | null | undefined {
  const v = clearableNonEmptyString(raw, key);
  if (v === undefined || v === null) return v;
  if (!ENV_KEY_RE.test(v)) {
    throw new RpcError(
      -32602,
      `Invalid ${key}: must be a process env name (A-Za-z_ then A-Za-z0-9_)`
    );
  }
  return v;
}

function validateBaseUrl(v: string): string {
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new RpcError(-32602, "Invalid baseUrl: must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RpcError(-32602, "Invalid baseUrl: only http: and https: are allowed");
  }
  // Reject credentials / query / hash so secrets cannot hide in the URL.
  if (parsed.username || parsed.password) {
    throw new RpcError(
      -32602,
      "Invalid baseUrl: username/password in URL are not allowed"
    );
  }
  if (parsed.search || parsed.hash) {
    throw new RpcError(
      -32602,
      "Invalid baseUrl: query string and hash fragment are not allowed"
    );
  }
  return v;
}

function optionalBaseUrl(raw: Record<string, unknown>): string | undefined {
  const v = optionalNonEmptyString(raw, "baseUrl");
  if (v === undefined) return undefined;
  return validateBaseUrl(v);
}

function clearableBaseUrl(raw: Record<string, unknown>): string | null | undefined {
  const v = clearableNonEmptyString(raw, "baseUrl");
  if (v === undefined || v === null) return v;
  return validateBaseUrl(v);
}

function optionalPermissionPolicy(
  raw: Record<string, unknown>
): AcpPermissionPolicy | undefined {
  if (!("permissionPolicy" in raw) || raw.permissionPolicy === undefined || raw.permissionPolicy === null) {
    return undefined;
  }
  if (typeof raw.permissionPolicy !== "string") {
    throw new RpcError(-32602, "Invalid permissionPolicy: must be allow|ask|deny");
  }
  const v = raw.permissionPolicy as string;
  if (!PERMISSION_POLICIES.has(v as AcpPermissionPolicy)) {
    throw new RpcError(-32602, "Invalid permissionPolicy: must be allow|ask|deny");
  }
  return v as AcpPermissionPolicy;
}

function clearablePermissionPolicy(
  raw: Record<string, unknown>
): AcpPermissionPolicy | null | undefined {
  if (!("permissionPolicy" in raw) || raw.permissionPolicy === undefined) return undefined;
  if (raw.permissionPolicy === null) return null;
  if (typeof raw.permissionPolicy !== "string") {
    throw new RpcError(-32602, "Invalid permissionPolicy: must be allow|ask|deny");
  }
  const v = raw.permissionPolicy as string;
  if (!PERMISSION_POLICIES.has(v as AcpPermissionPolicy)) {
    throw new RpcError(-32602, "Invalid permissionPolicy: must be allow|ask|deny");
  }
  return v as AcpPermissionPolicy;
}

function optionalPositiveInt(raw: Record<string, unknown>, key: string): number | undefined {
  if (!(key in raw) || raw[key] === undefined || raw[key] === null) return undefined;
  const v = raw[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > MAX_TIMEOUT_MS) {
    throw new RpcError(
      -32602,
      `Invalid ${key}: must be a positive integer no greater than ${MAX_TIMEOUT_MS}`
    );
  }
  return v;
}

function clearablePositiveInt(
  raw: Record<string, unknown>,
  key: string
): number | null | undefined {
  if (!(key in raw) || raw[key] === undefined) return undefined;
  if (raw[key] === null) return null;
  const v = raw[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > MAX_TIMEOUT_MS) {
    throw new RpcError(
      -32602,
      `Invalid ${key}: must be a positive integer no greater than ${MAX_TIMEOUT_MS}`
    );
  }
  return v;
}

/**
 * Parse create-time ACP fields into the shared bag.
 * Field names stay top-level on the RPC (not nested `acp` / `grokAcp`).
 */
function parseAcpFieldsCreate(raw: Record<string, unknown>): {
  displayName?: string;
  acp: AcpProfileOptions;
} {
  const displayName = optionalNonEmptyString(raw, "displayName");
  const acp: AcpProfileOptions = {};
  const model = optionalNonEmptyString(raw, "model");
  if (model !== undefined) acp.model = model;
  const executable = optionalNonEmptyString(raw, "executable");
  if (executable !== undefined) acp.executable = executable;
  const envKey = optionalEnvKey(raw, "envKey");
  if (envKey !== undefined) acp.envKey = envKey;
  const baseUrlEnvKey = optionalEnvKey(raw, "baseUrlEnvKey");
  if (baseUrlEnvKey !== undefined) acp.baseUrlEnvKey = baseUrlEnvKey;
  const baseUrl = optionalBaseUrl(raw);
  if (baseUrl !== undefined) acp.baseUrl = baseUrl;
  const permissionPolicy = optionalPermissionPolicy(raw);
  if (permissionPolicy !== undefined) acp.permissionPolicy = permissionPolicy;
  const promptTimeoutMs = optionalPositiveInt(raw, "promptTimeoutMs");
  if (promptTimeoutMs !== undefined) acp.promptTimeoutMs = promptTimeoutMs;
  const permissionTimeoutMs = optionalPositiveInt(raw, "permissionTimeoutMs");
  if (permissionTimeoutMs !== undefined) acp.permissionTimeoutMs = permissionTimeoutMs;
  return { displayName, acp };
}

/** Patch values: undefined = keep, null = clear field, else set. */
type ClearablePatch = {
  displayName?: string | null;
  model?: string | null;
  executable?: string | null;
  envKey?: string | null;
  baseUrlEnvKey?: string | null;
  baseUrl?: string | null;
  permissionPolicy?: AcpPermissionPolicy | null;
  promptTimeoutMs?: number | null;
  permissionTimeoutMs?: number | null;
};

function parseAcpFieldsUpdate(raw: Record<string, unknown>): ClearablePatch {
  return {
    displayName: clearableNonEmptyString(raw, "displayName"),
    model: clearableNonEmptyString(raw, "model"),
    executable: clearableNonEmptyString(raw, "executable"),
    envKey: clearableEnvKey(raw, "envKey"),
    baseUrlEnvKey: clearableEnvKey(raw, "baseUrlEnvKey"),
    baseUrl: clearableBaseUrl(raw),
    permissionPolicy: clearablePermissionPolicy(raw),
    promptTimeoutMs: clearablePositiveInt(raw, "promptTimeoutMs"),
    permissionTimeoutMs: clearablePositiveInt(raw, "permissionTimeoutMs"),
  };
}

function applyClearablePatch(
  current: AgentProfileConfig,
  patch: ClearablePatch
): AgentProfileConfig {
  const next: AgentProfileConfig = {
    ...current,
    acp: current.acp ? { ...current.acp } : {},
  };
  const g = next.acp!;

  if (patch.displayName === null) {
    delete next.displayName;
  } else if (patch.displayName !== undefined) {
    next.displayName = patch.displayName;
  }

  const assign = <K extends keyof AcpProfileOptions>(
    key: K,
    value: AcpProfileOptions[K] | null | undefined
  ) => {
    if (value === undefined) return;
    if (value === null) {
      delete g[key];
      return;
    }
    g[key] = value;
  };

  assign("model", patch.model as AcpProfileOptions["model"] | null | undefined);
  assign("executable", patch.executable as AcpProfileOptions["executable"] | null | undefined);
  assign("envKey", patch.envKey as AcpProfileOptions["envKey"] | null | undefined);
  assign(
    "baseUrlEnvKey",
    patch.baseUrlEnvKey as AcpProfileOptions["baseUrlEnvKey"] | null | undefined
  );
  assign("baseUrl", patch.baseUrl as AcpProfileOptions["baseUrl"] | null | undefined);
  assign(
    "permissionPolicy",
    patch.permissionPolicy as AcpProfileOptions["permissionPolicy"] | null | undefined
  );
  assign(
    "promptTimeoutMs",
    patch.promptTimeoutMs as AcpProfileOptions["promptTimeoutMs"] | null | undefined
  );
  assign(
    "permissionTimeoutMs",
    patch.permissionTimeoutMs as AcpProfileOptions["permissionTimeoutMs"] | null | undefined
  );

  return next;
}

/**
 * Create-time defaults by adapterId.
 * - grok-acp: fill DEFAULT_GROK_MODEL / ENV / BASE_URL_ENV + permissionPolicy=deny
 * - other whitelist adapters: only permissionPolicy=deny — never invent model/envKey
 */
function applyCreateDefaults(
  adapterId: ProductAcpAdapterId,
  acp: AcpProfileOptions
): void {
  if (!acp.permissionPolicy) acp.permissionPolicy = "deny";
  if (adapterId === GROK_ACP_ADAPTER_ID) {
    if (!acp.model) acp.model = DEFAULT_GROK_MODEL;
    if (!acp.envKey) acp.envKey = DEFAULT_GROK_ENV_KEY;
    if (!acp.baseUrlEnvKey) acp.baseUrlEnvKey = DEFAULT_GROK_BASE_URL_ENV_KEY;
  }
}

function parseCreateAdapterId(raw: Record<string, unknown>): ProductAcpAdapterId {
  if (!("adapterId" in raw) || raw.adapterId === undefined || raw.adapterId === null) {
    // Default keeps existing UI/RPC that omits adapterId (still grok-acp).
    return GROK_ACP_ADAPTER_ID;
  }
  if (typeof raw.adapterId !== "string" || !raw.adapterId.trim()) {
    throw new RpcError(-32602, "Invalid string param: adapterId");
  }
  const id = raw.adapterId.trim();
  if (!isProductAcpAdapterId(id)) {
    throw new RpcError(
      -32602,
      `Unsupported adapterId for product profile CRUD: ${id}. Allowed: ${PRODUCT_ACP_ADAPTER_IDS.join(", ")} (not a universal provider router)`
    );
  }
  return id;
}

function assertProductCrudAdapter(adapterId: string, op: "update" | "delete"): void {
  if (!isProductAcpAdapterId(adapterId)) {
    throw new RpcError(
      -32602,
      `Product profile ${op} only supports adapterIds: ${PRODUCT_ACP_ADAPTER_IDS.join(", ")} (got ${adapterId})`
    );
  }
}

export type AgentProfileCatalogOptions = {
  /**
   * When false, CRUD never writes dataDir/agent-profiles.json (in-memory only).
   * Service sets this false for options.profiles inject; true for normal boot.
   */
  persistToDisk?: boolean;
  /**
   * Optional save override (tests: deterministic write failure).
   * Only used when persistToDisk is true.
   */
  saveProfiles?: (dataDir: string, profiles: AgentProfileConfig[]) => Promise<void>;
};

/**
 * In-process machine-local profile catalog.
 * Mutations are serialized: build next from the old snapshot, atomic save(next) first,
 * then replace in-memory catalog + runtime. On write failure, disk/catalog/runtime stay old.
 * options.profiles inject → persistToDisk=false so tests never touch host dataDir.
 */
export class AgentProfileCatalog {
  private profiles: AgentProfileConfig[];
  private chain: Promise<void> = Promise.resolve();
  private readonly persistToDisk: boolean;
  private readonly saveProfiles: (
    dataDir: string,
    profiles: AgentProfileConfig[]
  ) => Promise<void>;

  constructor(
    private readonly dataDir: string,
    private readonly runtime: AgentRuntime,
    initial: AgentProfileConfig[],
    opts?: AgentProfileCatalogOptions
  ) {
    const source = initial.some((p) => p.id === FAKE_DEFAULT_PROFILE_ID)
      ? initial
      : [
          ...initial,
          defaultAgentProfiles().find((p) => p.id === FAKE_DEFAULT_PROFILE_ID)!,
        ];
    // Normalize legacy grokAcp bags from inject/disk into canonical acp.
    this.profiles = source.map((p) => cloneAgentProfileConfig(p));
    this.persistToDisk = opts?.persistToDisk !== false;
    this.saveProfiles = opts?.saveProfiles ?? saveAgentProfiles;
    this.runtime.replaceProfileCatalog(this.profiles);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  list(): AgentProfileConfig[] {
    return this.profiles.map((p) => cloneAgentProfileConfig(p));
  }

  get(id: string): AgentProfileConfig | undefined {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) return undefined;
    return cloneAgentProfileConfig(p);
  }

  /**
   * Atomic commit: persist next first (when enabled); only then swap memory + runtime.
   * Write failure leaves this.profiles and runtime on the previous snapshot.
   */
  private async commit(next: AgentProfileConfig[]): Promise<void> {
    if (this.persistToDisk) {
      await this.saveProfiles(this.dataDir, next);
    }
    this.profiles = next;
    this.runtime.replaceProfileCatalog(this.profiles);
  }

  async create(raw: Record<string, unknown>): Promise<AgentProfileConfig> {
    return this.enqueue(async () => {
      rejectUnknownAndDangerous(raw, PROFILE_CREATE_FIELDS);
      const id = requireProfileId(raw.id);
      if (this.profiles.some((p) => p.id === id)) {
        throw new RpcError(-32009, `Profile already exists: ${id}`);
      }
      if (id === FAKE_DEFAULT_PROFILE_ID) {
        throw new RpcError(-32602, "Cannot create reserved test profile id: fake-default");
      }
      const adapterId = parseCreateAdapterId(raw);
      const { displayName, acp } = parseAcpFieldsCreate(raw);
      applyCreateDefaults(adapterId, acp);

      const profile: AgentProfileConfig = {
        id,
        adapterId,
        ...(displayName !== undefined ? { displayName } : {}),
        acp,
      };
      await this.commit([...this.profiles, profile]);
      return this.get(id)!;
    });
  }

  async update(idRaw: unknown, raw: Record<string, unknown>): Promise<AgentProfileConfig> {
    return this.enqueue(async () => {
      const id = requireProfileId(idRaw);
      // id must not appear as a mutable body field (handler strips top-level id already).
      if ("id" in raw) {
        throw new RpcError(-32602, "id cannot be updated; omit id from profile body");
      }
      // adapterId is create-only / immutable — reject even though not in UPDATE whitelist.
      if ("adapterId" in raw) {
        throw new RpcError(-32602, "adapterId cannot be updated; omit adapterId from profile body");
      }
      rejectUnknownAndDangerous(raw, PROFILE_UPDATE_FIELDS);

      const idx = this.profiles.findIndex((p) => p.id === id);
      if (idx < 0) {
        throw new RpcError(-32004, `Profile not found: ${id}`);
      }
      const current = this.profiles[idx]!;
      if (isTestOnlyProfile(current) || current.id === FAKE_DEFAULT_PROFILE_ID) {
        throw new RpcError(
          -32602,
          "Test-only profile fake-default cannot be modified via product CRUD"
        );
      }
      assertProductCrudAdapter(current.adapterId, "update");

      const nextProfile = applyClearablePatch(current, parseAcpFieldsUpdate(raw));
      await this.commit(this.profiles.map((p, i) => (i === idx ? nextProfile : p)));
      return this.get(id)!;
    });
  }

  async delete(idRaw: unknown): Promise<{ deleted: string }> {
    return this.enqueue(async () => {
      const id = requireProfileId(idRaw);
      const idx = this.profiles.findIndex((p) => p.id === id);
      if (idx < 0) {
        throw new RpcError(-32004, `Profile not found: ${id}`);
      }
      const current = this.profiles[idx]!;
      if (isTestOnlyProfile(current) || current.id === FAKE_DEFAULT_PROFILE_ID) {
        throw new RpcError(
          -32602,
          "Test-only profile fake-default cannot be deleted via product CRUD"
        );
      }
      if (isBuiltinDefaultProfileId(current.id)) {
        throw new RpcError(
          -32602,
          `Built-in profile ${current.id} cannot be deleted`
        );
      }
      assertProductCrudAdapter(current.adapterId, "delete");

      const sessions = await this.runtime.registry.list();
      const active = sessions.filter(
        (s) => s.profileId === id && SessionRegistry.isNonTerminal(s.state)
      );
      if (active.length > 0) {
        throw new RpcError(
          -32022,
          `Cannot delete profile ${id}: ${active.length} non-terminal session(s) still use it`,
          { sessionIds: active.map((s) => s.id) }
        );
      }

      await this.commit(this.profiles.filter((p) => p.id !== id));
      return { deleted: id };
    });
  }
}
