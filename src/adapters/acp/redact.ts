// Central ACP diagnostic redaction — never persist or emit raw secrets.

const SECRET_ENV_KEY_RE =
  /^(.*_)?(API[_-]?KEY|TOKEN|SECRET|PASSWORD|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)$/i;

const DEFAULT_PLACEHOLDER = "[redacted]";

/**
 * True when an env key name looks like it holds credential material.
 * Used to harvest values for diagnostic redaction (not for allowlisting spawn env).
 */
export function isSecretEnvKeyName(key: string): boolean {
  if (SECRET_ENV_KEY_RE.test(key)) return true;
  // Explicit provider / Tent auth bags
  if (/AUTH_REQUEST/i.test(key)) return true;
  if (/^TENT_.*_(KEY|TOKEN|SECRET)$/i.test(key)) return true;
  return false;
}

/**
 * Collect non-empty secret-looking values from an env map plus explicit extras.
 * Longer secrets first so nested/overlapping redactionsions prefer the full value.
 */
export function collectSecretValues(
  env?: Record<string, string | undefined> | NodeJS.ProcessEnv,
  extraSecrets?: Iterable<string | undefined | null>
): string[] {
  const found = new Set<string>();
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string" || !value) continue;
      if (isSecretEnvKeyName(key) || valueLooksLikeHighEntropySecret(value)) {
        // Only auto-harvest from secret-named keys to avoid redacting PATH fragments.
        if (isSecretEnvKeyName(key)) found.add(value);
      }
    }
  }
  if (extraSecrets) {
    for (const value of extraSecrets) {
      if (typeof value === "string" && value.length > 0) found.add(value);
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

function valueLooksLikeHighEntropySecret(value: string): boolean {
  // Reserved for future heuristics; key-name driven collection is the default.
  void value;
  return false;
}

/**
 * Replace every occurrence of known secret values in diagnostic text.
 * Empty/short secrets (< 4 chars) are skipped to avoid mangling normal prose.
 */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
  placeholder: string = DEFAULT_PLACEHOLDER
): string {
  if (!text || secrets.length === 0) return text;
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(placeholder);
  }
  return out;
}

/**
 * Redact a diagnostic string using env-derived + explicit secrets.
 */
export function redactDiagnosticText(
  text: string,
  options?: {
    env?: Record<string, string | undefined> | NodeJS.ProcessEnv;
    secrets?: Iterable<string | undefined | null>;
    placeholder?: string;
  }
): string {
  const secrets = collectSecretValues(options?.env, options?.secrets);
  return redactSecrets(text, secrets, options?.placeholder ?? DEFAULT_PLACEHOLDER);
}

/**
 * Deep-clone a JSON-compatible value while redacting string leaves.
 * Used for safe RPC error data / projection sanitization.
 */
export function redactDiagnosticValue<T>(
  value: T,
  secrets: readonly string[],
  placeholder: string = DEFAULT_PLACEHOLDER
): T {
  if (secrets.length === 0) return value;
  if (typeof value === "string") {
    return redactSecrets(value, secrets, placeholder) as T;
  }
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item, secrets, placeholder)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactDiagnosticValue(v, secrets, placeholder);
  }
  return out as T;
}
