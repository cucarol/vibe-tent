// CLI ↔ Local Service wire protocol contract.
// Independent of package version (package remains 0.1.0); bump only on breaking RPC/health shape.

/**
 * Monotonic integer protocol version advertised on GET /health and service.health.
 * Clients must reject healthy-but-incompatible or legacy (missing) services before
 * business RPC — never treat them as attach success or spawn a competing service.
 */
export const TENT_SERVICE_PROTOCOL_VERSION = 1 as const;

export type TentServiceProtocolVersion = typeof TENT_SERVICE_PROTOCOL_VERSION;

export type ServiceHealthProtocolFields = {
  status?: unknown;
  protocolVersion?: unknown;
  version?: unknown;
};

/**
 * True when health payload advertises the exact protocol this client speaks.
 */
export function isServiceProtocolCompatible(
  health: ServiceHealthProtocolFields | null | undefined
): boolean {
  if (!health || typeof health !== "object") return false;
  return health.protocolVersion === TENT_SERVICE_PROTOCOL_VERSION;
}

/**
 * Fail-loud before business RPC when a Service is healthy but legacy/mismatched.
 * Matching protocol is a no-op (transparent attach).
 */
export function assertServiceProtocolCompatible(
  health: ServiceHealthProtocolFields | null | undefined
): void {
  const serviceVersion =
    health && typeof health.version === "string" && health.version.trim()
      ? health.version.trim()
      : "unknown";
  const raw = health?.protocolVersion;

  if (raw === undefined || raw === null) {
    throw new Error(
      `Local Tent Service protocol is missing (legacy endpoint). ` +
        `This CLI requires protocol ${TENT_SERVICE_PROTOCOL_VERSION} ` +
        `(package version stays 0.1.0; protocol is a separate contract). ` +
        `Service package version=${serviceVersion}. ` +
        `Restart or upgrade tent-service, then retry. ` +
        `Refusing to attach or spawn a competing service against an incompatible process.`
    );
  }

  if (raw !== TENT_SERVICE_PROTOCOL_VERSION) {
    throw new Error(
      `Local Tent Service protocol mismatch: service=${String(raw)}, ` +
        `client=${TENT_SERVICE_PROTOCOL_VERSION} (package 0.1.0; protocol is separate). ` +
        `Service package version=${serviceVersion}. ` +
        `Restart or upgrade tent-service to a compatible build before any business RPC. ` +
        `Refusing attach success and refusing to spawn a competing service.`
    );
  }
}
