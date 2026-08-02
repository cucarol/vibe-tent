// Pure validation rules for machine Settings routes.
// A route is a launch target, never an executor identity and never a secret store.

import type { AcpPermissionPolicy } from "../adapters/acp/types.js";
import { ROUTE_ID_RE, isRouteId } from "../core/id.js";
import { CREDENTIAL_ID_RE, assertCredentialId } from "./credential-store.js";

export type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

export { ROUTE_ID_RE };
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
export const PERMISSION_POLICIES = new Set<AcpPermissionPolicy>(["allow", "ask", "deny"]);

export const SECRET_ROUTE_FIELD_HINTS = [
  "apikey", "api_key", "token", "secret", "password", "authorization", "bearer",
] as const;

const ok = <T>(value: T): FieldResult<T> => ({ ok: true, value });
const fail = (message: string): FieldResult<never> => ({ ok: false, message });

export function parseRouteIdValue(raw: unknown, field = "routeId"): FieldResult<string> {
  if (typeof raw !== "string" || !raw.trim()) return fail(`Missing or invalid string param: ${field}`);
  const routeId = raw.trim();
  return isRouteId(routeId)
    ? ok(routeId)
    : fail(`Invalid routeId: must match ${ROUTE_ID_RE} (lowercase letter, then a-z0-9-, max 63)`);
}

export function parseNonEmptyStringValue(raw: unknown, key: string): FieldResult<string> {
  if (typeof raw !== "string" || !raw.trim()) return fail(`Invalid string param: ${key}`);
  return ok(raw.trim());
}

export function parseEnvKeyValue(raw: unknown, key: string): FieldResult<string> {
  const value = parseNonEmptyStringValue(raw, key);
  if (!value.ok) return value;
  return ENV_KEY_RE.test(value.value)
    ? value
    : fail(`Invalid ${key}: must be a process env name (A-Za-z_ then A-Za-z0-9_)`);
}

/** Absolute http(s) URL with no embedded credentials, query, or fragment. */
export function parseBaseUrlValue(raw: unknown): FieldResult<string> {
  const value = parseNonEmptyStringValue(raw, "baseUrl");
  if (!value.ok) return value;
  try {
    const url = new URL(value.value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password || url.search || url.hash
    ) {
      return fail("Invalid baseUrl: only clean absolute http(s) URLs are allowed");
    }
  } catch {
    return fail("Invalid baseUrl: must be an absolute http(s) URL");
  }
  return value;
}

export function parseCredentialRefValue(raw: unknown): FieldResult<string> {
  const value = parseNonEmptyStringValue(raw, "credentialRef");
  if (!value.ok) return value;
  try {
    return ok(assertCredentialId(value.value));
  } catch (err) {
    return fail(err instanceof Error ? err.message.replace(/^Invalid credential id/, "Invalid credentialRef") : `Invalid credentialRef: must match ${CREDENTIAL_ID_RE}`);
  }
}

export function parsePermissionPolicyValue(raw: unknown): FieldResult<AcpPermissionPolicy> {
  return typeof raw === "string" && PERMISSION_POLICIES.has(raw as AcpPermissionPolicy)
    ? ok(raw as AcpPermissionPolicy)
    : fail("Invalid permissionPolicy: must be allow|ask|deny");
}

export function parsePositiveTimeoutValue(raw: unknown, key: string): FieldResult<number> {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw <= MAX_TIMEOUT_MS
    ? ok(raw)
    : fail(`Invalid ${key}: must be a positive integer no greater than ${MAX_TIMEOUT_MS}`);
}
