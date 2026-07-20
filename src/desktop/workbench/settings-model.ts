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
  a2aPolicy?: "allow" | "ask" | "deny";
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
  if (draft.a2aPolicy) payload.a2aPolicy = draft.a2aPolicy;
  return { ok: true, payload };
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
