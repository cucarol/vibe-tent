// Pure validation rules for machine Agent Connections.
// A Connection is launch configuration, never executor identity or a secret store.

import type { AcpPermissionPolicy } from "../adapters/acp/types.js";
import { CONNECTION_ID_RE, isConnectionId } from "../core/id.js";
import { LAUNCH_SECRET_ID_RE, assertLaunchSecretId } from "./launch-secret-store.js";

export type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

export { CONNECTION_ID_RE };
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
export const PERMISSION_POLICIES = new Set<AcpPermissionPolicy>(["allow", "ask", "deny"]);

export const SECRET_CONNECTION_FIELD_HINTS = [
  "apikey", "api_key", "token", "secret", "password", "authorization", "bearer",
] as const;

const ok = <T>(value: T): FieldResult<T> => ({ ok: true, value });
const fail = (message: string): FieldResult<never> => ({ ok: false, message });

export function parseConnectionIdValue(raw: unknown, field = "connectionId"): FieldResult<string> {
  if (typeof raw !== "string" || !raw.trim()) return fail(`Missing or invalid string param: ${field}`);
  const connectionId = raw.trim();
  return isConnectionId(connectionId)
    ? ok(connectionId)
    : fail(`Invalid connectionId: must match ${CONNECTION_ID_RE} (lowercase letter, then a-z0-9-, max 63)`);
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

export function parseLaunchSecretRefValue(raw: unknown): FieldResult<string> {
  const value = parseNonEmptyStringValue(raw, "launchSecretRef");
  if (!value.ok) return value;
  try {
    return ok(assertLaunchSecretId(value.value));
  } catch (err) {
    return fail(
      err instanceof Error
        ? err.message.replace(/^Invalid launch secret id/, "Invalid launchSecretRef")
        : `Invalid launchSecretRef: must match ${LAUNCH_SECRET_ID_RE}`
    );
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
