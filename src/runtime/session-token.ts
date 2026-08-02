import * as crypto from "node:crypto";

/** Process-lifetime, Session-scoped caller capability. Plaintext is never persisted. */
export function deriveSessionToken(secret: string, sessionId: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`tent-session:${sessionId}`)
    .digest("base64url");
}
