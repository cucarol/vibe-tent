import type { AcpPermissionPolicy, AcpProfileOptions } from "../acp/types.js";

export type AntigravityAcpPermissionPolicy = AcpPermissionPolicy;
export interface AntigravityAcpProfileOptions extends AcpProfileOptions {}

export const ANTIGRAVITY_ACP_ADAPTER_ID = "antigravity-acp";

/**
 * Antigravity's official `agy` CLI does not expose ACP directly. Tent connects
 * through the separately installed, third-party `agy-acp` bridge.
 */
export const ANTIGRAVITY_ACP_BRIDGE = "agy-acp";
