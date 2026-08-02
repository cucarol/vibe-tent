import type { AcpPermissionPolicy, AcpRouteOptions } from "../acp/types.js";

export type OpenCodeAcpPermissionPolicy = AcpPermissionPolicy;
export interface OpenCodeAcpRouteOptions extends AcpRouteOptions {}

export const OPENCODE_ACP_ADAPTER_ID = "opencode-acp";
