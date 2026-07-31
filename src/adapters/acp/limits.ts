import { StringDecoder } from "node:string_decoder";

export const ACP_OUTPUT_LIMIT_CODE = "ACP_OUTPUT_LIMIT";
export const ACP_REQUEST_LIMIT_CODE = "ACP_REQUEST_LIMIT";

export const DEFAULT_ACP_ASSISTANT_REPORT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_ACP_ASSISTANT_SEGMENTS = 4096;
export const DEFAULT_ACP_SESSION_UPDATES = 65_536;
export const DEFAULT_ACP_STDOUT_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_ACP_BOOTSTRAP_TEXT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_ACP_REQUEST_FRAME_BYTES = 40 * 1024 * 1024;
export const ACP_DIAGNOSTIC_EVENT_BYTES = 16 * 1024;

export type AcpLimitCode =
  | typeof ACP_OUTPUT_LIMIT_CODE
  | typeof ACP_REQUEST_LIMIT_CODE;

export type AcpResourceLimits = {
  assistantReportBytes: number;
  assistantSegments: number;
  sessionUpdates: number;
  stdoutFrameBytes: number;
  bootstrapTextBytes: number;
  requestFrameBytes: number;
};

export const DEFAULT_ACP_RESOURCE_LIMITS: Readonly<AcpResourceLimits> = {
  assistantReportBytes: DEFAULT_ACP_ASSISTANT_REPORT_BYTES,
  assistantSegments: DEFAULT_ACP_ASSISTANT_SEGMENTS,
  sessionUpdates: DEFAULT_ACP_SESSION_UPDATES,
  stdoutFrameBytes: DEFAULT_ACP_STDOUT_FRAME_BYTES,
  bootstrapTextBytes: DEFAULT_ACP_BOOTSTRAP_TEXT_BYTES,
  requestFrameBytes: DEFAULT_ACP_REQUEST_FRAME_BYTES,
};

export class AcpLimitError extends Error {
  readonly code: AcpLimitCode;

  constructor(code: AcpLimitCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "AcpLimitError";
    this.code = code;
  }
}

export function isAcpLimitError(value: unknown): value is AcpLimitError {
  if (!(value instanceof Error)) return false;
  const code = (value as Error & { code?: unknown }).code;
  return code === ACP_OUTPUT_LIMIT_CODE || code === ACP_REQUEST_LIMIT_CODE;
}

export function resolveAcpResourceLimits(
  overrides?: Partial<AcpResourceLimits>
): AcpResourceLimits {
  const resolved = { ...DEFAULT_ACP_RESOURCE_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid ACP resource limit ${name}=${value}`);
    }
  }
  return resolved;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

const TRUNCATED_MARKER = "\n…[truncated]";
const REDACTED_MARKER = "[redacted]";
const MAX_DIAGNOSTIC_SECRET_LOOKAHEAD_BYTES = 4096;

/**
 * Bound a diagnostic string without first allocating a full encoded Buffer.
 * Buffer.write stops at a complete UTF-8 sequence within the destination.
 */
export function truncateUtf8Text(
  text: string,
  maxBytes = ACP_DIAGNOSTIC_EVENT_BYTES
): string {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(text) <= maxBytes) return text;
  const markerBytes = utf8Bytes(TRUNCATED_MARKER);
  if (markerBytes >= maxBytes) {
    const marker = Buffer.allocUnsafe(maxBytes);
    const markerWritten = marker.write(TRUNCATED_MARKER, 0, maxBytes, "utf8");
    return marker.subarray(0, markerWritten).toString("utf8");
  }
  const payloadBytes = Math.max(0, maxBytes - markerBytes);
  const buffer = Buffer.allocUnsafe(payloadBytes);
  const written = buffer.write(text, 0, payloadBytes, "utf8");
  return buffer.subarray(0, written).toString("utf8") + TRUNCATED_MARKER;
}

/** Bound a raw child-process chunk before decoding/copying it as a full string. */
export function truncateUtf8Buffer(
  value: Buffer,
  maxBytes = ACP_DIAGNOSTIC_EVENT_BYTES
): string {
  if (value.byteLength <= maxBytes) return value.toString("utf8");
  const markerBytes = utf8Bytes(TRUNCATED_MARKER);
  const payloadBytes = Math.max(0, maxBytes - markerBytes);
  const prefix = value.subarray(0, payloadBytes).toString("utf8");
  return truncateUtf8Text(prefix + TRUNCATED_MARKER, maxBytes);
}

/** Keep a UTF-8 byte-bounded diagnostic tail; inputs are expected to be bounded. */
export function appendUtf8Tail(
  current: string,
  next: string,
  maxBytes: number
): string {
  const combined = current + next;
  if (utf8Bytes(combined) <= maxBytes) return combined;
  const encoded = Buffer.from(combined, "utf8");
  return truncateUtf8Text(
    encoded.subarray(Math.max(0, encoded.byteLength - maxBytes)).toString("utf8"),
    maxBytes
  );
}

function utf8Prefix(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };
  const buffer = Buffer.allocUnsafe(maxBytes);
  const written = buffer.write(text, 0, maxBytes, "utf8");
  return {
    text: buffer.subarray(0, written).toString("utf8"),
    truncated: true,
  };
}

function activeDiagnosticSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.filter((secret) => secret.length >= 4))].sort(
    (a, b) => b.length - a.length
  );
}

/** Redact the union of every known-secret occurrence, including overlaps. */
function redactDiagnosticSecrets(
  raw: string,
  secrets: readonly string[]
): string {
  const intervals: Array<{ start: number; end: number }> = [];
  for (const secret of secrets) {
    let found = raw.indexOf(secret);
    while (found >= 0) {
      intervals.push({ start: found, end: found + secret.length });
      found = raw.indexOf(secret, found + 1);
    }
  }
  if (intervals.length === 0) return raw;
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);

  let output = "";
  let cursor = 0;
  let start = intervals[0]!.start;
  let end = intervals[0]!.end;
  for (const interval of intervals.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
      continue;
    }
    output += raw.slice(cursor, start) + REDACTED_MARKER;
    cursor = end;
    start = interval.start;
    end = interval.end;
  }
  return output + raw.slice(cursor, start) + REDACTED_MARKER + raw.slice(end);
}

/**
 * Retain only the longest raw suffix that may become a secret after the next
 * chunk. A suffix already covered by a complete secret occurrence is emitted
 * through the redactor now instead of being carried again. This keeps carry
 * strictly below the longest secret even for self-overlapping values.
 */
function diagnosticCarryChars(
  raw: string,
  secrets: readonly string[]
): number {
  let lastCompleteSecretEnd = 0;
  for (const secret of secrets) {
    let found = raw.indexOf(secret);
    while (found >= 0) {
      lastCompleteSecretEnd = Math.max(
        lastCompleteSecretEnd,
        found + secret.length
      );
      found = raw.indexOf(secret, found + 1);
    }
  }

  let carryChars = 0;
  for (const secret of secrets) {
    const max = Math.min(secret.length - 1, raw.length);
    for (let length = max; length > carryChars; length -= 1) {
      const start = raw.length - length;
      if (
        start >= lastCompleteSecretEnd &&
        raw.endsWith(secret.slice(0, length))
      ) {
        carryChars = length;
        break;
      }
    }
  }
  return carryChars;
}

/**
 * Redact a final raw tail, replacing any suffix that could be the beginning of
 * a known secret. This avoids revealing credential prefixes at stream end.
 */
function redactFinalDiagnosticTail(
  raw: string,
  secrets: readonly string[]
): string {
  let partialChars = 0;
  for (const secret of secrets) {
    const max = Math.min(secret.length - 1, raw.length);
    for (let length = max; length >= 1; length -= 1) {
      if (raw.endsWith(secret.slice(0, length))) {
        partialChars = Math.max(partialChars, length);
        break;
      }
    }
  }
  if (partialChars === 0) return redactDiagnosticSecrets(raw, secrets);
  return (
    redactDiagnosticSecrets(
      raw.slice(0, raw.length - partialChars),
      secrets
    ) +
    REDACTED_MARKER
  );
}

/**
 * Stateful, byte-bounded diagnostic redaction for child strings and Buffers.
 *
 * It retains a small raw carry across adjacent chunks, uses bounded lookahead
 * past the eventual output cut, redacts complete known secrets before the final
 * UTF-8 byte bound, and never emits a trailing credential prefix on flush.
 */
export class BoundedDiagnosticRedactor {
  private readonly secrets: string[];
  private readonly maxSecretChars: number;
  private readonly lookaheadBytes: number;
  private carry = "";
  private bufferDecoder = new StringDecoder("utf8");
  private discardUntilFlush = false;

  constructor(
    secrets: readonly string[],
    private readonly maxBytes = ACP_DIAGNOSTIC_EVENT_BYTES
  ) {
    this.secrets = activeDiagnosticSecrets(secrets);
    const oversizedSecret = this.secrets.find(
      (secret) => utf8Bytes(secret) > MAX_DIAGNOSTIC_SECRET_LOOKAHEAD_BYTES
    );
    // An unusually large credential would require equally large lookahead.
    // Suppress raw diagnostics instead of weakening the memory or secrecy bound.
    if (oversizedSecret) {
      this.maxSecretChars = -1;
      this.lookaheadBytes = 0;
      return;
    }
    this.maxSecretChars = Math.max(
      1,
      ...this.secrets.map((secret) => secret.length)
    );
    this.lookaheadBytes = Math.max(
      0,
      ...this.secrets.map((secret) => utf8Bytes(secret))
    );
  }

  pushText(text: string): string {
    if (this.discardUntilFlush) return "";
    return this.project(utf8Prefix(text, this.inputWindowBytes()));
  }

  pushBuffer(value: Buffer): string {
    if (this.discardUntilFlush) return "";
    const windowBytes = this.inputWindowBytes();
    const truncated = value.byteLength > windowBytes;
    let text = this.bufferDecoder.write(
      truncated ? value.subarray(0, windowBytes) : value
    );
    if (truncated) {
      text += this.bufferDecoder.end();
      this.bufferDecoder = new StringDecoder("utf8");
    }
    return this.project({ text, truncated });
  }

  flush(): string {
    if (this.discardUntilFlush) {
      this.bufferDecoder.end();
      this.bufferDecoder = new StringDecoder("utf8");
      this.carry = "";
      this.discardUntilFlush = false;
      return "";
    }
    const decodedTail = this.bufferDecoder.end();
    this.bufferDecoder = new StringDecoder("utf8");
    const decodedHead = decodedTail
      ? this.project({ text: decodedTail, truncated: false })
      : "";
    if (!this.carry) return truncateUtf8Text(decodedHead, this.maxBytes);
    if (this.maxSecretChars < 0) {
      this.carry = "";
      return joinBoundedDiagnosticParts(
        decodedHead,
        REDACTED_MARKER,
        this.maxBytes
      );
    }
    const raw = this.carry;
    this.carry = "";
    return joinBoundedDiagnosticParts(
      decodedHead,
      redactFinalDiagnosticTail(raw, this.secrets),
      this.maxBytes
    );
  }

  private inputWindowBytes(): number {
    return this.maxBytes + this.lookaheadBytes * 2;
  }

  private project(input: { text: string; truncated: boolean }): string {
    // Once raw bytes/chars have been discarded, the next chunk could begin
    // with the suffix of a credential whose prefix was in that discarded
    // region. Do not resume this logical diagnostic stream until flush marks
    // an explicit boundary.
    if (input.truncated) this.discardUntilFlush = true;
    if (this.maxSecretChars < 0) {
      this.carry = "";
      return truncateUtf8Text(REDACTED_MARKER, this.maxBytes);
    }

    const raw = this.carry + input.text;
    this.carry = "";
    let safeRaw: string;
    if (input.truncated) {
      // The ignored remainder breaks stream continuity. Lookahead already covers
      // every secret that could cross the final maxBytes output cut.
      safeRaw = raw;
    } else {
      const retainedChars = diagnosticCarryChars(raw, this.secrets);
      const boundary = raw.length - retainedChars;
      safeRaw = raw.slice(0, boundary);
      this.carry = raw.slice(boundary);
    }

    let redacted = input.truncated
      ? redactFinalDiagnosticTail(safeRaw, this.secrets)
      : redactDiagnosticSecrets(safeRaw, this.secrets);
    if (redacted !== safeRaw) {
      // Keep the redaction fact visible even when the original occurrence sat
      // at the eventual byte cut and the final truncation marker consumes tail room.
      redacted = `${REDACTED_MARKER}\n${redacted}`;
    }
    if (input.truncated) redacted += TRUNCATED_MARKER;
    return truncateUtf8Text(redacted, this.maxBytes);
  }
}

function joinBoundedDiagnosticParts(
  head: string,
  tail: string,
  maxBytes: number
): string {
  if (!tail) return truncateUtf8Text(head, maxBytes);
  const boundedTail = truncateUtf8Text(tail, maxBytes);
  const headBudget = Math.max(0, maxBytes - utf8Bytes(boundedTail));
  return truncateUtf8Text(head, headBudget) + boundedTail;
}

/** One-shot bounded diagnostic redaction (RPC errors/status strings). */
export function redactBoundedDiagnosticText(
  text: string,
  secrets: readonly string[],
  maxBytes = ACP_DIAGNOSTIC_EVENT_BYTES
): string {
  const redactor = new BoundedDiagnosticRedactor(secrets, maxBytes);
  const head = redactor.pushText(text);
  const tail = redactor.flush();
  return joinBoundedDiagnosticParts(head, tail, maxBytes);
}
