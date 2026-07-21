/**
 * Pure helpers for Desktop settings panels.
 * Payload builders only — no RPC, no secrets in return values.
 */

import type { ProviderCatalogEntry, ProviderVerificationLevel } from "../../service/types.js";
import { verificationLevelLabel } from "./graph-model.js";

export type DeliveryPolicy = "manual" | "bypass" | "agent-decide";

export const DELIVERY_POLICY_OPTIONS: Array<{ value: DeliveryPolicy; label: string }> = [
  { value: "manual", label: "手动确认" },
  { value: "bypass", label: "直通" },
  { value: "agent-decide", label: "Agent 决定" },
];

export type RoleFormDraft = {
  name: string;
  displayName?: string;
  prompt?: string;
  description?: string;
  color?: string;
  a2aPolicy?: "allow" | "ask" | "deny";
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
  a2aPolicy?: "allow" | "ask" | "deny";
  /** Comma/space-separated profile ids; empty clears whitelist. */
  allowedProfilesText?: string;
};

export type ProfileFormDraft = {
  id: string;
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
 * Edit draft for profile.update — id is required key; adapterId is never patchable.
 * Empty optional strings clear the field (null) so Service can wipe prior values.
 */
export type ProfileUpdateDraft = {
  /** Immutable profile id (RPC key only; not renamed). */
  id: string;
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
  if (draft.a2aPolicy) payload.a2aPolicy = draft.a2aPolicy;
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

  if (draft.a2aPolicy) payload.a2aPolicy = draft.a2aPolicy;

  if (draft.allowedProfilesText !== undefined) {
    const ids = parseAllowedProfilesText(draft.allowedProfilesText);
    payload.allowedProfiles = ids;
  }

  return { ok: true, payload };
}

/** Split profile id whitelist from free text (comma / whitespace). */
export function parseAllowedProfilesText(text: string): string[] {
  const raw = (text || "").trim();
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function formatAllowedProfilesText(ids: string[] | undefined | null): string {
  return (ids || []).join(", ");
}

export function validateProfileCreate(draft: ProfileFormDraft):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string } {
  const id = (draft.id || "").trim();
  const adapterId = (draft.adapterId || "").trim();
  if (!id) return { ok: false, reason: "profile id 不能为空" };
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) {
    return { ok: false, reason: "profile id 须匹配 a-z 开头的小写 id" };
  }
  if (!adapterId) return { ok: false, reason: "adapterId 不能为空" };
  const payload: Record<string, unknown> = { id, adapterId };
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
 * Build profile.update payload (top-level fields only).
 * Never includes adapterId — id and adapterId are immutable after create.
 * Empty optional strings clear the field (null); omitted fields stay untouched only when
 * the draft key is undefined (callers that always collect form values should pass strings).
 * Never secrets / env maps / nested profile bags.
 */
export function validateProfileUpdate(draft: ProfileUpdateDraft):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string } {
  const id = (draft.id || "").trim();
  if (!id) return { ok: false, reason: "profile id 不能为空" };
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) {
    return { ok: false, reason: "profile id 须匹配 a-z 开头的小写 id" };
  }
  const payload: Record<string, unknown> = { id };

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

  // Defensive: never allow adapterId / secret-shaped keys on the wire from this helper.
  if ("adapterId" in payload) delete payload.adapterId;
  return { ok: true, payload };
}

/** Primary list label: mutable displayName first; immutable id is shown separately. */
export function profileDisplayLabel(profile: {
  id: string;
  displayName?: string | null;
}): string {
  const dn = (profile.displayName || "").trim();
  return dn || profile.id;
}

/**
 * Session snapshot tip for profile editors (machine-local launch config).
 * Live sessions keep boot snapshot; catalog edits apply on next session start.
 */
export const PROFILE_NEXT_SESSION_TIP =
  "本机启动配置 · Session 使用快照 · 改动下次会话生效";

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
