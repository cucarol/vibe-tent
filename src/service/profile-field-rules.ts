// Pure FieldResult value rules for AgentProfile fields.
// Shared by product CRUD (profile-catalog → RpcError) and disk load (profiles → quarantine).
// Presence / clearable-null / dangerous-unknown policy stay at the thin boundaries.

import type { AcpPermissionPolicy } from "../adapters/acp/types.js";
import { CREDENTIAL_ID_RE, assertCredentialId } from "./credential-store.js";

export type FieldResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export function fieldOk<T>(value: T): FieldResult<T> {
  return { ok: true, value };
}

export function fieldErr(message: string): FieldResult<never> {
  return { ok: false, message };
}

/** Same id shape as credential vault ids / product profile CRUD. */
export const PROFILE_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
/** Process env name shape for envKey / baseUrlEnvKey. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
export const PERMISSION_POLICIES = new Set<AcpPermissionPolicy>(["allow", "ask", "deny"]);

/** Field names that must never be accepted via product CRUD (explicit reject). */
export const DANGEROUS_FIELD_HINTS = [
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

/**
 * Profile id (create/update/delete path). Empty / non-string → missing-or-invalid;
 * shape mismatch → must match PROFILE_ID_RE.
 */
export function parseProfileIdValue(raw: unknown, field = "id"): FieldResult<string> {
  if (typeof raw !== "string" || !raw.trim()) {
    return fieldErr(`Missing or invalid string param: ${field}`);
  }
  const id = raw.trim();
  if (!PROFILE_ID_RE.test(id)) {
    return fieldErr(
      `Invalid profile id: must match ${PROFILE_ID_RE} (lowercase letter, then a-z0-9-, max 63)`
    );
  }
  return fieldOk(id);
}

/** Non-empty trimmed string; type must already be present at the boundary. */
export function parseNonEmptyStringValue(raw: unknown, key: string): FieldResult<string> {
  if (typeof raw !== "string") {
    return fieldErr(`Invalid string param: ${key}`);
  }
  const v = raw.trim();
  if (!v) {
    return fieldErr(`Invalid string param: ${key} must be non-empty when set`);
  }
  return fieldOk(v);
}

export function parseEnvKeyValue(raw: unknown, key: string): FieldResult<string> {
  const base = parseNonEmptyStringValue(raw, key);
  if (!base.ok) return base;
  if (!ENV_KEY_RE.test(base.value)) {
    return fieldErr(
      `Invalid ${key}: must be a process env name (A-Za-z_ then A-Za-z0-9_)`
    );
  }
  return fieldOk(base.value);
}

/** Absolute http(s) URL; no userinfo / query / hash (secrets cannot hide in the URL). */
export function validateBaseUrlValue(v: string): FieldResult<string> {
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return fieldErr("Invalid baseUrl: must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fieldErr("Invalid baseUrl: only http: and https: are allowed");
  }
  if (parsed.username || parsed.password) {
    return fieldErr("Invalid baseUrl: username/password in URL are not allowed");
  }
  if (parsed.search || parsed.hash) {
    return fieldErr("Invalid baseUrl: query string and hash fragment are not allowed");
  }
  return fieldOk(v);
}

export function parseBaseUrlValue(raw: unknown): FieldResult<string> {
  const base = parseNonEmptyStringValue(raw, "baseUrl");
  if (!base.ok) return base;
  return validateBaseUrlValue(base.value);
}

export function parsePermissionPolicyValue(raw: unknown): FieldResult<AcpPermissionPolicy> {
  if (typeof raw !== "string") {
    return fieldErr("Invalid permissionPolicy: must be allow|ask|deny");
  }
  if (!PERMISSION_POLICIES.has(raw as AcpPermissionPolicy)) {
    return fieldErr("Invalid permissionPolicy: must be allow|ask|deny");
  }
  return fieldOk(raw as AcpPermissionPolicy);
}

export function parsePositiveTimeoutValue(raw: unknown, key: string): FieldResult<number> {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > MAX_TIMEOUT_MS) {
    return fieldErr(
      `Invalid ${key}: must be a positive integer no greater than ${MAX_TIMEOUT_MS}`
    );
  }
  return fieldOk(raw);
}

/** Vault id (not a secret); same id rules as CredentialStore. */
export function parseCredentialRefValue(raw: unknown): FieldResult<string> {
  const base = parseNonEmptyStringValue(raw, "credentialRef");
  if (!base.ok) return base;
  try {
    return fieldOk(assertCredentialId(base.value));
  } catch (err) {
    return fieldErr(
      err instanceof Error
        ? err.message.replace(/^Invalid credential id/, "Invalid credentialRef")
        : `Invalid credentialRef: must match ${CREDENTIAL_ID_RE}`
    );
  }
}
