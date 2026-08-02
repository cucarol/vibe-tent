import type { AcpPermissionPolicy, AcpRouteOptions } from "../acp/types.js";

export type PiAcpPermissionPolicy = AcpPermissionPolicy;
export interface PiAcpRouteOptions extends AcpRouteOptions {}

/** Product adapter id — third-party `pi-acp` bridge over `pi --mode rpc`. */
export const PI_ACP_ADAPTER_ID = "pi-acp";

/**
 * npm package for the ACP stdio bridge.
 * Launch: `npx --yes pi-acp` (bridge spawns `pi --mode rpc` itself).
 * Requires Node ≥20 for the bridge; `@earendil-works/pi-coding-agent` (pi CLI)
 * currently documents Node ≥22.19.
 */
export const PI_ACP_NPX_PACKAGE = "pi-acp";
