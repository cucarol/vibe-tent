// Loopback client token — machine-local only; never written into workspace / tent files.

import * as crypto from "node:crypto";
export { deriveSessionToken } from "../runtime/session-token.js";

export const AUTH_HEADER = "authorization";
export const AUTH_TOKEN_HEADER = "x-tent-token";
export const CALLER_SESSION_ID_HEADER = "x-tent-session-id";
export const CALLER_SESSION_TOKEN_HEADER = "x-tent-session-token";
export const CALLER_EXTERNAL_KEY_HEADER = "x-tent-external-key";

/** Opaque bearer token for loopback attach (RPC + SSE). */
export function generateServiceToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Extract client token from request headers.
 * Accepts `Authorization: Bearer <token>` or `X-Tent-Token: <token>`.
 */
export function extractRequestToken(
  headers: Record<string, string | string[] | undefined> | {
    [key: string]: string | string[] | undefined;
  }
): string | undefined {
  const auth = headerValue(headers, AUTH_HEADER) ?? headerValue(headers, "Authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const direct =
    headerValue(headers, AUTH_TOKEN_HEADER) ?? headerValue(headers, "X-Tent-Token");
  if (direct) return direct.trim() || undefined;
  return undefined;
}

export function tokensEqual(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function extractCallerSessionContext(
  headers: Record<string, string | string[] | undefined> | {
    [key: string]: string | string[] | undefined;
  }
): { sessionId?: string; sessionToken?: string; externalKey?: string } {
  const sessionId = headerValue(headers, CALLER_SESSION_ID_HEADER)?.trim() || undefined;
  const sessionToken = headerValue(headers, CALLER_SESSION_TOKEN_HEADER)?.trim() || undefined;
  const externalKey = headerValue(headers, CALLER_EXTERNAL_KEY_HEADER)?.trim() || undefined;
  return { sessionId, sessionToken, externalKey };
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | {
    [key: string]: string | string[] | undefined;
  },
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue;
    if (Array.isArray(v)) return v[0];
    return v;
  }
  return undefined;
}
