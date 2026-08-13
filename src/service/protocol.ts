// CLI ↔ Local Service wire protocol contract.
// Independent of package version (currently 0.2.0); bump only on breaking RPC/health shape.

/**
 * Monotonic integer protocol version advertised on GET /health and service.health.
 * Clients must reject healthy-but-incompatible or legacy (missing) services before
 * business RPC — never treat them as attach success or spawn a competing service.
 */
export const TENT_SERVICE_PROTOCOL_VERSION = 9 as const;

export type TentServiceProtocolVersion = typeof TENT_SERVICE_PROTOCOL_VERSION;

export type ServiceHealthProtocolFields = {
  status?: unknown;
  protocolVersion?: unknown;
  version?: unknown;
};

export type ServiceProtocolIncompatibilityKind = "missing" | "mismatch";

/**
 * Typed fail-loud error for healthy-but-incompatible/legacy Service endpoints.
 * Attach paths rethrow this class only — ordinary network/health failures stay null.
 */
export class ServiceProtocolIncompatibleError extends Error {
  readonly code = "TENT_SERVICE_PROTOCOL_INCOMPATIBLE" as const;
  readonly kind: ServiceProtocolIncompatibilityKind;
  readonly clientProtocolVersion: number;
  readonly serviceProtocolVersion: unknown;
  readonly servicePackageVersion: string;

  constructor(
    kind: ServiceProtocolIncompatibilityKind,
    options: {
      serviceProtocolVersion?: unknown;
      servicePackageVersion?: string;
      message?: string;
    } = {}
  ) {
    const servicePackageVersion =
      typeof options.servicePackageVersion === "string" &&
      options.servicePackageVersion.trim()
        ? options.servicePackageVersion.trim()
        : "unknown";
    const serviceProtocolVersion = options.serviceProtocolVersion;
    const message =
      options.message ??
      (kind === "missing"
        ? `Local Tent Service protocol is missing (legacy endpoint). ` +
          `This CLI requires protocol ${TENT_SERVICE_PROTOCOL_VERSION} ` +
          `(package version is 0.2.0; protocol is a separate contract). ` +
          `Service package version=${servicePackageVersion}. ` +
          `Restart or upgrade tent-service, then retry. ` +
          `Refusing to attach or spawn a competing service against an incompatible process.`
        : `Local Tent Service protocol mismatch: service=${String(serviceProtocolVersion)}, ` +
          `client=${TENT_SERVICE_PROTOCOL_VERSION} (package 0.2.0; protocol is separate). ` +
          `Service package version=${servicePackageVersion}. ` +
          `Restart or upgrade tent-service to a compatible build before any business RPC. ` +
          `Refusing attach success and refusing to spawn a competing service.`);
    super(message);
    this.name = "ServiceProtocolIncompatibleError";
    this.kind = kind;
    this.clientProtocolVersion = TENT_SERVICE_PROTOCOL_VERSION;
    this.serviceProtocolVersion = serviceProtocolVersion;
    this.servicePackageVersion = servicePackageVersion;
  }
}

export function isServiceProtocolIncompatibleError(
  err: unknown
): err is ServiceProtocolIncompatibleError {
  return (
    err instanceof ServiceProtocolIncompatibleError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === "TENT_SERVICE_PROTOCOL_INCOMPATIBLE")
  );
}

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
  const servicePackageVersion =
    health && typeof health.version === "string" && health.version.trim()
      ? health.version.trim()
      : "unknown";
  const raw = health?.protocolVersion;

  if (raw === undefined || raw === null) {
    throw new ServiceProtocolIncompatibleError("missing", {
      servicePackageVersion,
      serviceProtocolVersion: raw,
    });
  }

  if (raw !== TENT_SERVICE_PROTOCOL_VERSION) {
    throw new ServiceProtocolIncompatibleError("mismatch", {
      servicePackageVersion,
      serviceProtocolVersion: raw,
    });
  }
}
