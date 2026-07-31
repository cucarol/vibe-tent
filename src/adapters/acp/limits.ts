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

/**
 * Bound a diagnostic string without first allocating a full encoded Buffer.
 * Buffer.write stops at a complete UTF-8 sequence within the destination.
 */
export function truncateUtf8Text(
  text: string,
  maxBytes = ACP_DIAGNOSTIC_EVENT_BYTES
): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const markerBytes = utf8Bytes(TRUNCATED_MARKER);
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
