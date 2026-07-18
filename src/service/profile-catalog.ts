// In-process machine-local AgentProfile catalog (serial CRUD + runtime sync).
// Validation, patch helpers, and AgentProfileCatalog live here.
// Load / save / defaults / projection stay in profiles.ts (no circular import).

import type { AcpPermissionPolicy, AcpProfileOptions } from "../adapters/acp/types.js";
import {
  cloneMcpServers,
  cloneSkillRefs,
  defaultAllowedSkillRoots,
  parseMcpServersArrayValue,
  parseSkillsArrayValue,
  type AgentProfileMcpServer,
  type AgentProfileSkillRef,
} from "../adapters/acp/mcp-skills.js";
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
import {
  DANGEROUS_FIELD_HINTS,
  parseBaseUrlValue,
  parseCredentialRefValue,
  parseEnvKeyValue,
  parseNonEmptyStringValue,
  parsePermissionPolicyValue,
  parsePositiveTimeoutValue,
  parseProfileIdValue,
  type FieldResult,
} from "./profile-field-rules.js";
import { RpcError } from "./rpc-error.js";

// ---------------------------------------------------------------------------
// CRUD boundary: presence / clearable-null / dangerous-unknown → RpcError.
// Pure value rules live in profile-field-rules.ts (shared with disk load).
// ---------------------------------------------------------------------------

function unwrapField<T>(result: FieldResult<T>): T {
  if (!result.ok) throw new RpcError(-32602, result.message);
  return result.value;
}

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
  return unwrapField(parseProfileIdValue(raw, field));
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
  return unwrapField(parseNonEmptyStringValue(raw[key], key));
}

/** Update: undefined/absent keep; null clear; string set. */
function clearableNonEmptyString(
  raw: Record<string, unknown>,
  key: string
): string | null | undefined {
  if (!(key in raw) || raw[key] === undefined) return undefined;
  if (raw[key] === null) return null;
  return unwrapField(parseNonEmptyStringValue(raw[key], key));
}

function optionalEnvKey(raw: Record<string, unknown>, key: string): string | undefined {
  if (!(key in raw) || raw[key] === undefined || raw[key] === null) return undefined;
  return unwrapField(parseEnvKeyValue(raw[key], key));
}

function clearableEnvKey(
  raw: Record<string, unknown>,
  key: string
): string | null | undefined {
  if (!(key in raw) || raw[key] === undefined) return undefined;
  if (raw[key] === null) return null;
  return unwrapField(parseEnvKeyValue(raw[key], key));
}

/** credentialRef is a vault id (not a secret); same id rules as CredentialStore. */
function optionalCredentialRef(raw: Record<string, unknown>): string | undefined {
  if (!("credentialRef" in raw) || raw.credentialRef === undefined || raw.credentialRef === null) {
    return undefined;
  }
  return unwrapField(parseCredentialRefValue(raw.credentialRef));
}

function clearableCredentialRef(
  raw: Record<string, unknown>
): string | null | undefined {
  if (!("credentialRef" in raw) || raw.credentialRef === undefined) return undefined;
  if (raw.credentialRef === null) return null;
  return unwrapField(parseCredentialRefValue(raw.credentialRef));
}

function optionalBaseUrl(raw: Record<string, unknown>): string | undefined {
  if (!("baseUrl" in raw) || raw.baseUrl === undefined || raw.baseUrl === null) return undefined;
  return unwrapField(parseBaseUrlValue(raw.baseUrl));
}

function clearableBaseUrl(raw: Record<string, unknown>): string | null | undefined {
  if (!("baseUrl" in raw) || raw.baseUrl === undefined) return undefined;
  if (raw.baseUrl === null) return null;
  return unwrapField(parseBaseUrlValue(raw.baseUrl));
}

function optionalPermissionPolicy(
  raw: Record<string, unknown>
): AcpPermissionPolicy | undefined {
  if (!("permissionPolicy" in raw) || raw.permissionPolicy === undefined || raw.permissionPolicy === null) {
    return undefined;
  }
  return unwrapField(parsePermissionPolicyValue(raw.permissionPolicy));
}

function clearablePermissionPolicy(
  raw: Record<string, unknown>
): AcpPermissionPolicy | null | undefined {
  if (!("permissionPolicy" in raw) || raw.permissionPolicy === undefined) return undefined;
  if (raw.permissionPolicy === null) return null;
  return unwrapField(parsePermissionPolicyValue(raw.permissionPolicy));
}

function optionalPositiveInt(raw: Record<string, unknown>, key: string): number | undefined {
  if (!(key in raw) || raw[key] === undefined || raw[key] === null) return undefined;
  return unwrapField(parsePositiveTimeoutValue(raw[key], key));
}

function clearablePositiveInt(
  raw: Record<string, unknown>,
  key: string
): number | null | undefined {
  if (!(key in raw) || raw[key] === undefined) return undefined;
  if (raw[key] === null) return null;
  return unwrapField(parsePositiveTimeoutValue(raw[key], key));
}

/**
 * Parse create-time ACP fields into the shared bag + top-level skills/mcp.
 * Field names stay top-level on the RPC (not nested `acp` / `grokAcp`).
 */
function parseAcpFieldsCreate(raw: Record<string, unknown>): {
  displayName?: string;
  acp: AcpProfileOptions;
  skills?: AgentProfileSkillRef[];
  mcpServers?: AgentProfileMcpServer[];
} {
  const displayName = optionalNonEmptyString(raw, "displayName");
  const acp: AcpProfileOptions = {};
  const model = optionalNonEmptyString(raw, "model");
  if (model !== undefined) acp.model = model;
  const executable = optionalNonEmptyString(raw, "executable");
  if (executable !== undefined) acp.executable = executable;
  const envKey = optionalEnvKey(raw, "envKey");
  if (envKey !== undefined) acp.envKey = envKey;
  const credentialRef = optionalCredentialRef(raw);
  if (credentialRef !== undefined) acp.credentialRef = credentialRef;
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
  const skills = parseSkillsFieldCreate(raw);
  const mcpServers = parseMcpServersFieldCreate(raw);
  return {
    displayName,
    acp,
    ...(skills !== undefined ? { skills } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
  };
}

/** Patch values: undefined = keep, null = clear field, else set. */
type ClearablePatch = {
  displayName?: string | null;
  model?: string | null;
  executable?: string | null;
  envKey?: string | null;
  credentialRef?: string | null;
  baseUrlEnvKey?: string | null;
  baseUrl?: string | null;
  permissionPolicy?: AcpPermissionPolicy | null;
  promptTimeoutMs?: number | null;
  permissionTimeoutMs?: number | null;
  skills?: AgentProfileSkillRef[] | null;
  mcpServers?: AgentProfileMcpServer[] | null;
};

function parseSkillsFieldCreate(
  raw: Record<string, unknown>
): AgentProfileSkillRef[] | undefined {
  if (!("skills" in raw) || raw.skills === undefined || raw.skills === null) {
    return undefined;
  }
  return unwrapField(parseSkillsArrayValue(raw.skills, defaultAllowedSkillRoots()));
}

function parseMcpServersFieldCreate(
  raw: Record<string, unknown>
): AgentProfileMcpServer[] | undefined {
  if (!("mcpServers" in raw) || raw.mcpServers === undefined || raw.mcpServers === null) {
    return undefined;
  }
  return unwrapField(parseMcpServersArrayValue(raw.mcpServers));
}

/** Update: undefined keep; null clear; array set (replace whole list). */
function clearableSkills(
  raw: Record<string, unknown>
): AgentProfileSkillRef[] | null | undefined {
  if (!("skills" in raw) || raw.skills === undefined) return undefined;
  if (raw.skills === null) return null;
  return unwrapField(parseSkillsArrayValue(raw.skills, defaultAllowedSkillRoots())) ?? null;
}

function clearableMcpServers(
  raw: Record<string, unknown>
): AgentProfileMcpServer[] | null | undefined {
  if (!("mcpServers" in raw) || raw.mcpServers === undefined) return undefined;
  if (raw.mcpServers === null) return null;
  return unwrapField(parseMcpServersArrayValue(raw.mcpServers)) ?? null;
}

function parseAcpFieldsUpdate(raw: Record<string, unknown>): ClearablePatch {
  return {
    displayName: clearableNonEmptyString(raw, "displayName"),
    model: clearableNonEmptyString(raw, "model"),
    executable: clearableNonEmptyString(raw, "executable"),
    envKey: clearableEnvKey(raw, "envKey"),
    credentialRef: clearableCredentialRef(raw),
    baseUrlEnvKey: clearableEnvKey(raw, "baseUrlEnvKey"),
    baseUrl: clearableBaseUrl(raw),
    permissionPolicy: clearablePermissionPolicy(raw),
    promptTimeoutMs: clearablePositiveInt(raw, "promptTimeoutMs"),
    permissionTimeoutMs: clearablePositiveInt(raw, "permissionTimeoutMs"),
    skills: clearableSkills(raw),
    mcpServers: clearableMcpServers(raw),
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
    "credentialRef",
    patch.credentialRef as AcpProfileOptions["credentialRef"] | null | undefined
  );
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

  if (patch.skills === null) {
    delete next.skills;
  } else if (patch.skills !== undefined) {
    next.skills = cloneSkillRefs(patch.skills);
  }

  if (patch.mcpServers === null) {
    delete next.mcpServers;
  } else if (patch.mcpServers !== undefined) {
    next.mcpServers = cloneMcpServers(patch.mcpServers);
  }

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
      const { displayName, acp, skills, mcpServers } = parseAcpFieldsCreate(raw);
      applyCreateDefaults(adapterId, acp);

      const profile: AgentProfileConfig = {
        id,
        adapterId,
        ...(displayName !== undefined ? { displayName } : {}),
        acp,
        ...(skills !== undefined ? { skills: cloneSkillRefs(skills) } : {}),
        ...(mcpServers !== undefined
          ? { mcpServers: cloneMcpServers(mcpServers) }
          : {}),
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
