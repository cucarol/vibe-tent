/**
 * Pure helpers for Desktop settings panels.
 * Payload builders only — no RPC, no secrets in return values.
 */

import type {
  ConnectionMcpServerProjection,
  RouteSkillProjection,
} from "../../adapters/acp/mcp-skills.js";
import type { CredentialProjection } from "../../service/credential-store.js";
import type { ProviderCatalogEntry, ProviderVerificationLevel } from "../../service/types.js";
import { verificationLevelLabel } from "./graph-model.js";

/** Canonical Task acceptance modes. */
export type AcceptMode = "review-required" | "auto-accept" | "agent-decide";

export const ACCEPT_MODE_OPTIONS: Array<{ value: AcceptMode; label: string }> = [
  { value: "review-required", label: "Review required" },
  { value: "auto-accept", label: "Auto accept" },
  { value: "agent-decide", label: "Agent Decide" },
];

export type RoleFormDraft = {
  name: string;
  displayName?: string;
  prompt?: string;
  description?: string;
  color?: string;
};

/** Edit draft for registry.role.update — operational name is identity, not patchable. */
export type RoleUpdateDraft = {
  /** Operational name (required for RPC name field). */
  name: string;
  roleId?: string;
  displayName?: string;
  prompt?: string;
  description?: string;
  color?: string;
};

export type ConnectionFormDraft = {
  connectionId: string;
  provider: string;
  adapterId: string;
  displayName?: string;
  model?: string;
  executable?: string;
  envKey?: string;
  credentialRef?: string;
  baseUrlEnvKey?: string;
  baseUrl?: string;
  permissionPolicy?: "allow" | "ask" | "deny";
};

/**
 * Edit draft for connection.update — connectionId is the required key.
 * Empty optional strings clear the field (null) so Service can wipe prior values.
 */
export type ConnectionUpdateDraft = {
  /** Immutable Connection id (RPC key only). */
  connectionId: string;
  displayName?: string;
  model?: string;
  executable?: string;
  envKey?: string;
  credentialRef?: string;
  baseUrlEnvKey?: string;
  baseUrl?: string;
  permissionPolicy?: "allow" | "ask" | "deny";
};

export type CredentialFormDraft = {
  id: string;
  secret: string;
  label?: string;
};

export type ProviderRow = {
  adapterId: string;
  verificationLevel: ProviderVerificationLevel | string;
  levelLabel: string;
  canResume?: boolean;
  notes?: string;
};

/** Map provider.catalog entries for Settings → never hardcode levels in UI. */
export function mapProviderCatalogRows(providers: ProviderCatalogEntry[]): ProviderRow[] {
  return (providers || []).map((p) => ({
    adapterId: p.adapterId,
    verificationLevel: p.verificationLevel,
    levelLabel: verificationLevelLabel(p.verificationLevel),
    canResume: p.canResume,
    notes: p.notes,
  }));
}

export function lookupProviderLevel(
  rows: ProviderRow[],
  adapterId: string
): ProviderRow | undefined {
  return rows.find((r) => r.adapterId === adapterId);
}

export function validateRoleCreate(draft: RoleFormDraft):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string } {
  const name = (draft.name || "").trim();
  if (!name) return { ok: false, reason: "角色名不能为空" };
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    return { ok: false, reason: "角色名需以字母开头，仅含字母数字 _ -" };
  }
  const payload: Record<string, unknown> = {
    name,
    actor: "user",
  };
  if (draft.displayName?.trim()) payload.displayName = draft.displayName.trim();
  if (draft.prompt?.trim()) payload.prompt = draft.prompt.trim();
  if (draft.description?.trim()) payload.description = draft.description.trim();
  if (draft.color?.trim()) payload.color = draft.color.trim();
  return { ok: true, payload };
}

/**
 * Build registry.role.update payload (top-level fields + actor).
 * Empty optional strings clear the field (null) so Service can wipe prior values.
 * Operational name is never renamed — only displayName is the mutable label.
 */
export function validateRoleUpdate(draft: RoleUpdateDraft):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string } {
  const name = (draft.name || "").trim();
  if (!name) return { ok: false, reason: "角色运营键不能为空" };
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    return { ok: false, reason: "角色运营键无效" };
  }
  const payload: Record<string, unknown> = {
    name,
    actor: "user",
  };
  if (draft.roleId?.trim()) payload.roleId = draft.roleId.trim();

  // Always send displayName so UI can clear custom labels (null → server resets).
  const dn = (draft.displayName ?? "").trim();
  payload.displayName = dn || null;

  const prompt = (draft.prompt ?? "").trim();
  payload.prompt = prompt || null;

  const description = (draft.description ?? "").trim();
  payload.description = description || null;

  const color = (draft.color ?? "").trim();
  payload.color = color || null;

  return { ok: true, payload };
}

export function validateConnectionCreate(draft: ConnectionFormDraft):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string } {
  const connectionId = (draft.connectionId || "").trim();
  const provider = (draft.provider || "").trim();
  const adapterId = (draft.adapterId || "").trim();
  if (!connectionId) return { ok: false, reason: "connectionId 不能为空" };
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(connectionId)) {
    return { ok: false, reason: "connectionId 须匹配 a-z 开头的小写 id" };
  }
  if (!provider) return { ok: false, reason: "provider 不能为空" };
  if (!adapterId) return { ok: false, reason: "adapterId 不能为空" };
  const payload: Record<string, unknown> = { connectionId, provider, adapterId };
  if (draft.displayName?.trim()) payload.displayName = draft.displayName.trim();
  if (draft.model?.trim()) payload.model = draft.model.trim();
  if (draft.executable?.trim()) payload.executable = draft.executable.trim();
  if (draft.envKey?.trim()) payload.envKey = draft.envKey.trim();
  if (draft.credentialRef?.trim()) payload.credentialRef = draft.credentialRef.trim();
  if (draft.baseUrlEnvKey?.trim()) payload.baseUrlEnvKey = draft.baseUrlEnvKey.trim();
  if (draft.baseUrl?.trim()) payload.baseUrl = draft.baseUrl.trim();
  if (draft.permissionPolicy) payload.permissionPolicy = draft.permissionPolicy;
  return { ok: true, payload };
}

/**
 * Build connection.update payload (top-level fields only).
 * connectionId selects the machine Connection being updated.
 * Empty optional strings clear the field (null); omitted fields stay untouched only when
 * the draft key is undefined (callers that always collect form values should pass strings).
 * Never secrets / env maps / nested Connection bags.
 */
export function validateConnectionUpdate(draft: ConnectionUpdateDraft):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string } {
  const connectionId = (draft.connectionId || "").trim();
  if (!connectionId) return { ok: false, reason: "connectionId 不能为空" };
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(connectionId)) {
    return { ok: false, reason: "connectionId 须匹配 a-z 开头的小写 id" };
  }
  const payload: Record<string, unknown> = { connectionId };

  // Always send displayName so UI can clear custom labels (null → server falls back to id/key).
  const dn = (draft.displayName ?? "").trim();
  payload.displayName = dn || null;

  if (draft.model !== undefined) {
    payload.model = (draft.model ?? "").trim() || null;
  }
  if (draft.executable !== undefined) {
    payload.executable = (draft.executable ?? "").trim() || null;
  }
  if (draft.envKey !== undefined) {
    payload.envKey = (draft.envKey ?? "").trim() || null;
  }
  if (draft.credentialRef !== undefined) {
    payload.credentialRef = (draft.credentialRef ?? "").trim() || null;
  }
  if (draft.baseUrlEnvKey !== undefined) {
    payload.baseUrlEnvKey = (draft.baseUrlEnvKey ?? "").trim() || null;
  }
  if (draft.baseUrl !== undefined) {
    payload.baseUrl = (draft.baseUrl ?? "").trim() || null;
  }
  if (draft.permissionPolicy) {
    payload.permissionPolicy = draft.permissionPolicy;
  }

  return { ok: true, payload };
}

/** Primary list label: mutable displayName first; immutable connectionId is shown separately. */
export function connectionDisplayLabel(connection: {
  connectionId: string;
  displayName?: string | null;
}): string {
  const dn = (connection.displayName || "").trim();
  return dn || connection.connectionId;
}

/**
 * Session snapshot tip for Agent Connection editors (machine-local launch config).
 * Live sessions keep boot snapshot; catalog edits apply on next session start.
 */
export const CONNECTION_NEXT_SESSION_TIP =
  "本机启动配置 · Session 使用快照 · 改动下次会话生效";

/**
 * Honesty copy for Connection skill refs: metadata projection only,
 * provider-dependent — never claim skills are activated.
 */
export const CONNECTION_SKILLS_METADATA_TIP =
  "Skill 仅 name/path 元数据（_meta.tent.skills）· 是否生效取决于 provider · 不宣称已激活";

/** Vault entry type shown in credentials UI (store has no multi-provider field). */
export const CREDENTIAL_VAULT_TYPE = "secret";

/**
 * Credential set payload. Secret is passed through for RPC only —
 * callers must not log it or render it back after submit.
 */
export function validateCredentialSet(draft: CredentialFormDraft):
  | { ok: true; payload: { id: string; secret: string; label?: string } }
  | { ok: false; reason: string } {
  const id = (draft.id || "").trim();
  if (!id) return { ok: false, reason: "credential id 不能为空" };
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) {
    return { ok: false, reason: "credential id 须匹配 a-z 开头的小写 id" };
  }
  if (!draft.secret || draft.secret.length === 0) {
    return { ok: false, reason: "secret 不能为空" };
  }
  const payload: { id: string; secret: string; label?: string } = {
    id,
    secret: draft.secret,
  };
  if (draft.label?.trim()) payload.label = draft.label.trim();
  return { ok: true, payload };
}

/**
 * Safe credential list row for Settings — ref id + vault type + configured status.
 * Never includes secret, ciphertext, or provider tokens.
 */
export function credentialListRow(c: CredentialProjection): {
  id: string;
  type: string;
  status: "已配置";
  /** Optional non-secret label only (never a secret). */
  label?: string;
  updatedAt?: string;
} {
  const label = (c.label || c.metadata?.label || "").trim() || undefined;
  return {
    id: c.id,
    type: CREDENTIAL_VAULT_TYPE,
    status: "已配置",
    ...(label ? { label } : {}),
    ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Connection Skills / MCP drafts (id/ref + enabled only; no displayName, no secrets)
// ---------------------------------------------------------------------------

export type SkillRefDraft = {
  name: string;
  path?: string;
  enabled: boolean;
};

export type McpServerDraft = {
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  command?: string;
  args?: string[];
  envKeys?: Record<string, string>;
  envCredentialRefs?: Record<string, string>;
  url?: string;
  headerEnvKeys?: Record<string, string>;
  headerCredentialRefs?: Record<string, string>;
};

/** Map projection → editor drafts (name/path/enabled only). */
export function skillDraftsFromProjection(
  skills?: RouteSkillProjection[] | null
): SkillRefDraft[] {
  if (!skills?.length) return [];
  return skills.map((s) => ({
    name: s.name,
    ...(s.path ? { path: s.path } : {}),
    enabled: s.enabled !== false,
  }));
}

/** Map projection → editor drafts (refs only; projection already has no secrets). */
export function mcpDraftsFromProjection(
  servers?: ConnectionMcpServerProjection[] | null
): McpServerDraft[] {
  if (!servers?.length) return [];
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

export function setSkillEnabled(
  drafts: SkillRefDraft[],
  name: string,
  enabled: boolean
): SkillRefDraft[] {
  return drafts.map((d) => (d.name === name ? { ...d, enabled } : d));
}

export function setMcpEnabled(
  drafts: McpServerDraft[],
  name: string,
  enabled: boolean
): McpServerDraft[] {
  return drafts.map((d) => (d.name === name ? { ...d, enabled } : d));
}

export function removeSkillDraft(drafts: SkillRefDraft[], name: string): SkillRefDraft[] {
  return drafts.filter((d) => d.name !== name);
}

export function removeMcpDraft(drafts: McpServerDraft[], name: string): McpServerDraft[] {
  return drafts.filter((d) => d.name !== name);
}

/**
 * Wire skills for connection.update — name / optional path / enabled only.
 * Never displayName, body, or secret-shaped keys.
 */
export function buildSkillsPayload(
  drafts: SkillRefDraft[]
): Array<{ name: string; path?: string; enabled?: boolean }> {
  return drafts.map((d) => {
    const row: { name: string; path?: string; enabled?: boolean } = {
      name: d.name,
    };
    if (d.path?.trim()) row.path = d.path.trim();
    // Persist false so re-enable later works; omit true (default).
    if (d.enabled === false) row.enabled = false;
    else if (d.enabled === true) row.enabled = true;
    return row;
  });
}

/**
 * Wire mcpServers for connection.update — envKey/credentialRef *names* only.
 * Strips accidental secret-shaped keys; never plaintext env/headers.
 */
export function buildMcpServersPayload(drafts: McpServerDraft[]): Array<Record<string, unknown>> {
  return drafts.map((d) => {
    const row: Record<string, unknown> = {
      name: d.name,
      transport: d.transport,
      enabled: d.enabled !== false,
    };
    if (d.transport === "stdio") {
      if (d.command?.trim()) row.command = d.command.trim();
      if (d.args?.length) row.args = [...d.args];
      if (d.envKeys && Object.keys(d.envKeys).length) row.envKeys = { ...d.envKeys };
      if (d.envCredentialRefs && Object.keys(d.envCredentialRefs).length) {
        row.envCredentialRefs = { ...d.envCredentialRefs };
      }
    } else {
      if (d.url?.trim()) row.url = d.url.trim();
      if (d.headerEnvKeys && Object.keys(d.headerEnvKeys).length) {
        row.headerEnvKeys = { ...d.headerEnvKeys };
      }
      if (d.headerCredentialRefs && Object.keys(d.headerCredentialRefs).length) {
        row.headerCredentialRefs = { ...d.headerCredentialRefs };
      }
    }
    // Defensive: never allow plaintext secret bags on the wire from this helper.
    delete row.env;
    delete row.headers;
    delete row.secret;
    delete row.token;
    delete row.apiKey;
    delete row.displayName;
    return row;
  });
}

/** Source / path line for a skill ref (name identity + optional path). */
export function skillSourceLine(s: { name: string; path?: string | null }): string {
  const p = (s.path || "").trim();
  return p ? p : "name-only（无 path）";
}

/** Source line for MCP: transport + command/url (never secrets). */
export function mcpSourceLine(s: {
  transport: string;
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
}): string {
  if (s.transport === "http") {
    const url = (s.url || "").trim();
    return url ? `http · ${url}` : "http";
  }
  const cmd = (s.command || "").trim();
  const args = (s.args || []).join(" ").trim();
  if (cmd && args) return `stdio · ${cmd} ${args}`;
  if (cmd) return `stdio · ${cmd}`;
  return "stdio";
}

/**
 * MCP credential ref status for UI — only ref ids + 已配置 / 缺失.
 * Never secret values. `configuredIds` is the set of vault ids from credential.list.
 */
export function mcpCredentialStatusParts(
  s: {
    envCredentialRefs?: Record<string, string> | null;
    headerCredentialRefs?: Record<string, string> | null;
  },
  configuredIds: ReadonlySet<string> | readonly string[]
): Array<{ envName: string; refId: string; configured: boolean }> {
  const set =
    configuredIds instanceof Set
      ? configuredIds
      : new Set(
          Array.from(configuredIds).filter(
            (x): x is string => typeof x === "string" && x.length > 0
          )
        );
  const out: Array<{ envName: string; refId: string; configured: boolean }> = [];
  const pushMap = (map?: Record<string, string> | null) => {
    if (!map) return;
    for (const [envName, refId] of Object.entries(map)) {
      const id = (refId || "").trim();
      if (!id) continue;
      out.push({ envName, refId: id, configured: set.has(id) });
    }
  };
  pushMap(s.envCredentialRefs);
  pushMap(s.headerCredentialRefs);
  return out;
}

/** Compact Chinese status for MCP credential refs (no secrets). */
export function mcpCredentialStatusLine(
  s: {
    envCredentialRefs?: Record<string, string> | null;
    headerCredentialRefs?: Record<string, string> | null;
  },
  configuredIds: ReadonlySet<string> | readonly string[]
): string {
  const parts = mcpCredentialStatusParts(s, configuredIds);
  if (!parts.length) return "";
  return parts
    .map((p) => `${p.refId}${p.configured ? "·已配置" : "·缺失"}`)
    .join(" ");
}

/**
 * Minimal skill add draft (name + optional path). Not a skill editor —
 * only identity refs for Connection skills.
 */
export function validateSkillAddDraft(draft: {
  name: string;
  path?: string;
  enabled?: boolean;
}): { ok: true; entry: SkillRefDraft } | { ok: false; reason: string } {
  const name = (draft.name || "").trim();
  if (!name) return { ok: false, reason: "skill name 不能为空" };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || name.includes("..")) {
    return { ok: false, reason: "skill name 无效" };
  }
  const path = (draft.path || "").trim();
  const entry: SkillRefDraft = {
    name,
    enabled: draft.enabled !== false,
    ...(path ? { path } : {}),
  };
  return { ok: true, entry };
}

/**
 * Minimal MCP add draft (name + transport + command/url + optional credential refs).
 * Not an MCP proxy / marketplace UI — refs only.
 */
export function validateMcpAddDraft(draft: {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  url?: string;
  /** Single env var name → credential id (optional convenience). */
  envCredentialName?: string;
  envCredentialRef?: string;
  enabled?: boolean;
}): { ok: true; entry: McpServerDraft } | { ok: false; reason: string } {
  const name = (draft.name || "").trim();
  if (!name) return { ok: false, reason: "MCP name 不能为空" };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    return { ok: false, reason: "MCP name 无效" };
  }
  if (draft.transport !== "stdio" && draft.transport !== "http") {
    return { ok: false, reason: "transport 须为 stdio 或 http" };
  }
  const entry: McpServerDraft = {
    name,
    transport: draft.transport,
    enabled: draft.enabled !== false,
  };
  if (draft.transport === "stdio") {
    const command = (draft.command || "").trim();
    if (!command) return { ok: false, reason: "stdio 需要 command" };
    entry.command = command;
  } else {
    const url = (draft.url || "").trim();
    if (!url) return { ok: false, reason: "http 需要 url" };
    entry.url = url;
  }
  const envName = (draft.envCredentialName || "").trim();
  const envRef = (draft.envCredentialRef || "").trim();
  if (envName || envRef) {
    if (!envName || !envRef) {
      return { ok: false, reason: "credential 需同时填 env 名与 vault id" };
    }
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(envRef)) {
      return { ok: false, reason: "credentialRef 须为 vault id" };
    }
    if (draft.transport === "stdio") {
      entry.envCredentialRefs = { [envName]: envRef };
    } else {
      entry.headerCredentialRefs = { [envName]: envRef };
    }
  }
  return { ok: true, entry };
}

export function retentionSummaryLine(preview: {
  candidateTaskCount?: number;
  candidateDeliveryCount?: number;
  keepTerminalTasksDays?: number;
  warnings?: string[];
}): string {
  const tasks = preview.candidateTaskCount ?? 0;
  const deliveries = preview.candidateDeliveryCount ?? 0;
  const days = preview.keepTerminalTasksDays ?? 30;
  const warn = preview.warnings?.length ? ` · ${preview.warnings.length} 警告` : "";
  return `保留 ${days} 天 · 可清理 ${tasks} 任务 / ${deliveries} 交付${warn}`;
}
