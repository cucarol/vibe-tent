import type { ChildProcess } from "node:child_process";
import {
  readServiceEndpointCandidates,
  serviceBaseUrl,
  type ServiceEndpointRecord,
} from "./data-dir.js";
import {
  assertServiceProtocolCompatible,
  isServiceProtocolIncompatibleError,
} from "./protocol.js";

export type AuthenticatedServiceEndpointHealth = {
  status?: unknown;
  instanceId?: unknown;
  pid?: unknown;
  startedAt?: unknown;
  protocolVersion?: unknown;
};

export const SERVICE_ENDPOINT_PROBE_TIMEOUT_MS = 1_000;
const OWNED_SERVICE_CHILD_STOP_TIMEOUT_MS = 2_000;

export type ServiceEndpointProbe<T> = (
  endpoint: ServiceEndpointRecord,
  signal: AbortSignal
) => Promise<{ health: AuthenticatedServiceEndpointHealth; value: T } | null>;

export class MultipleHealthyServiceEndpointsError extends Error {
  readonly code = "MULTIPLE_HEALTHY_SERVICE_ENDPOINTS";

  constructor(readonly endpoints: readonly ServiceEndpointRecord[]) {
    super(
      `Multiple authenticated Local Tent Services are healthy: ${endpoints
        .map((endpoint) => `${endpoint.instanceId}@${serviceBaseUrl(endpoint.host, endpoint.port)}`)
        .join(", ")}`
    );
    this.name = "MultipleHealthyServiceEndpointsError";
  }
}

/**
 * Evaluate the complete bounded generation set before selecting an attach.
 * Missing, malformed, locked, unauthenticated, or stale generations are ignored.
 * Any authenticated status=ok but protocol-incompatible Service, or more than
 * one compatible exact live identity, fails loud so no caller can bootstrap a
 * competitor.
 */
export async function discoverAuthenticatedServiceEndpoint<T>(
  dataDir: string,
  probe: ServiceEndpointProbe<T>
): Promise<T | null> {
  const candidates = await readServiceEndpointCandidates(dataDir);
  const results = await Promise.all(
    candidates.map(async (endpoint) => {
      if (!endpoint.token?.trim()) return { kind: "unhealthy" as const, endpoint };
      let probed: Awaited<ReturnType<ServiceEndpointProbe<T>>>;
      try {
        probed = await runBoundedProbe(endpoint, probe);
      } catch {
        return { kind: "unhealthy" as const, endpoint };
      }
      if (!probed || probed.health.status !== "ok") {
        return { kind: "unhealthy" as const, endpoint };
      }
      try {
        assertServiceProtocolCompatible(probed.health);
      } catch (error) {
        if (isServiceProtocolIncompatibleError(error)) {
          return { kind: "incompatible" as const, endpoint, error };
        }
        throw error;
      }
      if (
        probed.health.instanceId !== endpoint.instanceId ||
        probed.health.pid !== endpoint.pid ||
        probed.health.startedAt !== endpoint.startedAt
      ) {
        return { kind: "unhealthy" as const, endpoint };
      }
      return { kind: "compatible" as const, endpoint, value: probed.value };
    })
  );

  const incompatible = results.find((result) => result.kind === "incompatible");
  if (incompatible?.kind === "incompatible") throw incompatible.error;

  const compatible = results.filter(
    (result): result is Extract<(typeof results)[number], { kind: "compatible" }> =>
      result.kind === "compatible"
  );
  if (compatible.length > 1) {
    throw new MultipleHealthyServiceEndpointsError(
      compatible.map((result) => result.endpoint)
    );
  }
  return compatible[0]?.value ?? null;
}

async function runBoundedProbe<T>(
  endpoint: ServiceEndpointRecord,
  probe: ServiceEndpointProbe<T>
): Promise<Awaited<ReturnType<ServiceEndpointProbe<T>>>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe(endpoint, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Local Tent Service authenticated probe timed out"));
        }, SERVICE_ENDPOINT_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Stop only the exact Service child spawned by a failed attach attempt.
 * Successful attach paths intentionally retain their detached Service.
 */
export async function stopOwnedServiceChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
    // The exact process may already have exited between the state check and kill.
  }
  if (await waitForChildExit(child, OWNED_SERVICE_CHILD_STOP_TIMEOUT_MS)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // Re-check below; an already-dead exact child is success.
  }
  if (await waitForChildExit(child, OWNED_SERVICE_CHILD_STOP_TIMEOUT_MS)) return;
  throw new Error(`Owned Local Tent Service child ${child.pid} did not exit`);
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exited: boolean) => {
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(child.exitCode !== null || child.signalCode !== null);
    child.once("exit", onExit);
    child.once("error", onError);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}
