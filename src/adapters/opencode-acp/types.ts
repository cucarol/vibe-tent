import type { AcpPermissionPolicy, AcpProfileOptions } from "../acp/types.js";

export type OpenCodeAcpPermissionPolicy = AcpPermissionPolicy;
export interface OpenCodeAcpProfileOptions extends AcpProfileOptions {}

export const OPENCODE_ACP_ADAPTER_ID = "opencode-acp";
