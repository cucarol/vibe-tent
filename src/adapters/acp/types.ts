// Provider-neutral ACP JSON-RPC types and session defaults.
// No provider-specific argv / auth / env / model knowledge.

import { utf8Bytes } from "./limits.js";

/** Permission handling for ACP `session/request_permission` (no unconditional yolo). */
export type AcpPermissionPolicy = "allow" | "ask" | "deny";

/** Max wait for session/prompt result (ms). Default: 30 minutes. */
export const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;
/** When permissionPolicy is ask, max wait before deny (ms). Default: 120_000. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

export type AcpJsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

export type AcpJsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type AcpJsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id?: number | string;
};

export type AcpPermissionOption = {
  optionId: string;
  kind?: string;
  name?: string;
};

export type AcpSessionUpdate = {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  configOptions?: unknown;
  toolCallId?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
};

export type AcpSessionConfigOptionValue = {
  value: string;
  name: string;
  description?: string;
};

export type AcpSessionConfigSelectOptions =
  | { kind: "flat"; options: AcpSessionConfigOptionValue[] }
  | {
      kind: "grouped";
      groups: Array<{
        group: string;
        name: string;
        options: AcpSessionConfigOptionValue[];
      }>;
    };

export type AcpSessionConfigOption =
  | {
      id: string;
      name: string;
      description?: string;
      category?: string;
      type: "select";
      currentValue: string;
      options: AcpSessionConfigSelectOptions;
    }
  | {
      id: string;
      name: string;
      description?: string;
      category?: string;
      type: "boolean";
      currentValue: boolean;
    };

/**
 * Bounded, non-secret ACP facts negotiated for one provider Session.
 * Connections never own these values: the Agent is authoritative for its
 * capabilities, auth method ids, option defaults, and current values.
 */
export type AcpSessionConfigSnapshot = {
  capabilities: {
    loadSession: boolean;
    resumeSession: boolean;
    promptImage: boolean;
  };
  authMethodIds: string[];
  configOptions: AcpSessionConfigOption[];
  /** True when an adversarially large Agent projection was safely bounded. */
  truncated: boolean;
};

const ACP_SESSION_AUTH_METHODS_MAX = 64;
const ACP_SESSION_CONFIG_OPTIONS_MAX = 128;
const ACP_SESSION_CONFIG_VALUES_MAX = 256;
const ACP_SESSION_CONFIG_GROUPS_MAX = 64;
const ACP_SESSION_CONFIG_SNAPSHOT_BYTES = 256 * 1024;
const ACP_SESSION_CONFIG_ID_BYTES = 256;
const ACP_SESSION_CONFIG_LABEL_BYTES = 1024;
const ACP_SESSION_CONFIG_DESCRIPTION_BYTES = 4096;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type AcpSessionConfigTextPolicy = {
  /** Marker-scrub display-only strings before byte accounting. */
  scrubDisplayText?: (value: string) => string | undefined;
  /** Exact known-secret containment for identity/value fields. */
  containsSecret?: (value: string) => boolean;
};

function boundedString(
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
  scrubText?: (value: string) => string | undefined
): string | undefined {
  if (typeof value !== "string") return undefined;
  const scrubbed = scrubText ? scrubText(value) : value;
  if (scrubbed === undefined) return undefined;
  if (!allowEmpty && scrubbed.length === 0) return undefined;
  return utf8Bytes(scrubbed) <= maxBytes ? scrubbed : undefined;
}

function boundedDisplayString(
  value: unknown,
  maxBytes: number,
  bounds: { truncated: boolean },
  policy: AcpSessionConfigTextPolicy,
  allowEmpty = false
): string | undefined {
  const containedSecret =
    typeof value === "string" && policy.containsSecret?.(value) === true;
  const normalized = boundedString(
    value,
    maxBytes,
    allowEmpty,
    policy.scrubDisplayText
  );
  if (containedSecret && normalized === undefined) bounds.truncated = true;
  return normalized;
}

function optionalBoundedDisplayString(
  value: unknown,
  maxBytes: number,
  bounds: { truncated: boolean },
  policy: AcpSessionConfigTextPolicy
): string | undefined | null {
  if (value === undefined) return undefined;
  return (
    boundedDisplayString(value, maxBytes, bounds, policy, true) ?? null
  );
}

function normalizeConfigOptionValue(
  value: unknown,
  bounds: { truncated: boolean },
  policy: AcpSessionConfigTextPolicy
): AcpSessionConfigOptionValue | undefined {
  if (!plainRecord(value)) return undefined;
  if (
    typeof value.value === "string" &&
    policy.containsSecret?.(value.value)
  ) {
    bounds.truncated = true;
    return undefined;
  }
  const id = boundedString(value.value, ACP_SESSION_CONFIG_ID_BYTES);
  const name = boundedDisplayString(
    value.name,
    ACP_SESSION_CONFIG_LABEL_BYTES,
    bounds,
    policy
  );
  const description = optionalBoundedDisplayString(
    value.description,
    ACP_SESSION_CONFIG_DESCRIPTION_BYTES,
    bounds,
    policy
  );
  if (!id || !name || description === null) return undefined;
  return {
    value: id,
    name,
    ...(description !== undefined ? { description } : {}),
  };
}

function normalizeConfigOption(
  value: unknown,
  bounds: { truncated: boolean },
  policy: AcpSessionConfigTextPolicy
): AcpSessionConfigOption | undefined {
  if (!plainRecord(value)) return undefined;
  // ACP requires clients to ignore option types they do not understand. Do
  // this before secret inspection so an unknown wire shape cannot create a
  // false structural-truncation fact from fields we do not project.
  if (value.type !== "boolean" && value.type !== "select") return undefined;
  if (typeof value.id === "string" && policy.containsSecret?.(value.id)) {
    bounds.truncated = true;
    return undefined;
  }
  const id = boundedString(value.id, ACP_SESSION_CONFIG_ID_BYTES);
  const name = boundedDisplayString(
    value.name,
    ACP_SESSION_CONFIG_LABEL_BYTES,
    bounds,
    policy
  );
  const description = optionalBoundedDisplayString(
    value.description,
    ACP_SESSION_CONFIG_DESCRIPTION_BYTES,
    bounds,
    policy
  );
  const category = optionalBoundedDisplayString(
    value.category,
    ACP_SESSION_CONFIG_ID_BYTES,
    bounds,
    policy
  );
  if (!id || !name || description === null || category === null) return undefined;

  const common = {
    id,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(category !== undefined ? { category } : {}),
  };
  if (value.type === "boolean") {
    if (typeof value.currentValue !== "boolean") return undefined;
    return { ...common, type: "boolean", currentValue: value.currentValue };
  }
  if (
    typeof value.currentValue === "string" &&
    policy.containsSecret?.(value.currentValue)
  ) {
    bounds.truncated = true;
    return undefined;
  }
  const currentValue = boundedString(value.currentValue, ACP_SESSION_CONFIG_ID_BYTES);
  if (!currentValue) return undefined;
  if (!Array.isArray(value.options)) return undefined;
  const grouped = value.options.some(
    (option) => plainRecord(option) && "group" in option
  );
  let options: AcpSessionConfigSelectOptions;
  if (grouped) {
    const groups: Extract<AcpSessionConfigSelectOptions, { kind: "grouped" }>["groups"] = [];
    const seenGroups = new Set<string>();
    const seenValues = new Set<string>();
    let valueCount = 0;
    if (value.options.length > ACP_SESSION_CONFIG_GROUPS_MAX) bounds.truncated = true;
    for (const rawGroup of value.options.slice(0, ACP_SESSION_CONFIG_GROUPS_MAX)) {
      if (!plainRecord(rawGroup) || !Array.isArray(rawGroup.options)) continue;
      if (
        typeof rawGroup.group === "string" &&
        policy.containsSecret?.(rawGroup.group)
      ) {
        bounds.truncated = true;
        continue;
      }
      const group = boundedString(
        rawGroup.group,
        ACP_SESSION_CONFIG_ID_BYTES
      );
      const groupName = boundedDisplayString(
        rawGroup.name,
        ACP_SESSION_CONFIG_LABEL_BYTES,
        bounds,
        policy
      );
      if (!group || !groupName || seenGroups.has(group)) continue;
      const groupOptions: AcpSessionConfigOptionValue[] = [];
      for (const raw of rawGroup.options) {
        if (valueCount >= ACP_SESSION_CONFIG_VALUES_MAX) {
          bounds.truncated = true;
          break;
        }
        valueCount += 1;
        const option = normalizeConfigOptionValue(raw, bounds, policy);
        if (!option || seenValues.has(option.value)) continue;
        seenValues.add(option.value);
        groupOptions.push(option);
      }
      if (groupOptions.length === 0) continue;
      seenGroups.add(group);
      groups.push({ group, name: groupName, options: groupOptions });
      if (valueCount >= ACP_SESSION_CONFIG_VALUES_MAX) break;
    }
    if (groups.length === 0) return undefined;
    options = { kind: "grouped", groups };
  } else {
    const flatOptions: AcpSessionConfigOptionValue[] = [];
    const seen = new Set<string>();
    if (value.options.length > ACP_SESSION_CONFIG_VALUES_MAX) bounds.truncated = true;
    for (const raw of value.options.slice(0, ACP_SESSION_CONFIG_VALUES_MAX)) {
      const option = normalizeConfigOptionValue(raw, bounds, policy);
      if (!option || seen.has(option.value)) continue;
      seen.add(option.value);
      flatOptions.push(option);
    }
    if (flatOptions.length === 0) return undefined;
    options = { kind: "flat", options: flatOptions };
  }
  const survivingValues =
    options.kind === "flat"
      ? options.options.map((option) => option.value)
      : options.groups.flatMap((group) =>
          group.options.map((option) => option.value)
        );
  if (!survivingValues.includes(currentValue)) {
    bounds.truncated = true;
    return undefined;
  }
  return {
    ...common,
    type: "select",
    currentValue,
    options,
  };
}

function normalizeAuthMethodIds(
  value: unknown,
  policy: AcpSessionConfigTextPolicy
): {
  ids: string[];
  truncated: boolean;
} {
  if (!Array.isArray(value)) return { ids: [], truncated: false };
  const ids: string[] = [];
  const seen = new Set<string>();
  let truncated = value.length > ACP_SESSION_AUTH_METHODS_MAX;
  for (const raw of value.slice(0, ACP_SESSION_AUTH_METHODS_MAX)) {
    if (
      plainRecord(raw) &&
      typeof raw.id === "string" &&
      policy.containsSecret?.(raw.id)
    ) {
      truncated = true;
      continue;
    }
    const id = plainRecord(raw)
      ? boundedString(raw.id, ACP_SESSION_CONFIG_ID_BYTES)
      : undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids, truncated };
}

export function createAcpSessionConfigSnapshot(input: {
  agentCapabilities?: unknown;
  authMethods?: unknown;
  configOptions?: unknown;
  /** Marker-scrub display-only strings before any byte accounting. */
  scrubDisplayText?: (value: string) => string | undefined;
  /** Drop structural identities/values containing a known launch secret. */
  containsSecret?: (value: string) => boolean;
}): AcpSessionConfigSnapshot {
  const capabilities = plainRecord(input.agentCapabilities)
    ? input.agentCapabilities
    : {};
  const sessionCapabilities = plainRecord(capabilities.sessionCapabilities)
    ? capabilities.sessionCapabilities
    : {};
  const promptCapabilities = plainRecord(capabilities.promptCapabilities)
    ? capabilities.promptCapabilities
    : {};
  const policy: AcpSessionConfigTextPolicy = {
    scrubDisplayText: input.scrubDisplayText,
    containsSecret: input.containsSecret,
  };
  const auth = normalizeAuthMethodIds(input.authMethods, policy);
  const rawOptions = Array.isArray(input.configOptions) ? input.configOptions : [];
  const configOptions: AcpSessionConfigOption[] = [];
  const seen = new Set<string>();
  const bounds = { truncated: false };
  let bytes = 2;
  let truncated = auth.truncated || rawOptions.length > ACP_SESSION_CONFIG_OPTIONS_MAX;
  for (const raw of rawOptions.slice(0, ACP_SESSION_CONFIG_OPTIONS_MAX)) {
    const option = normalizeConfigOption(raw, bounds, policy);
    if (!option || seen.has(option.id)) continue;
    const optionBytes = utf8Bytes(JSON.stringify(option)) + 1;
    if (bytes + optionBytes > ACP_SESSION_CONFIG_SNAPSHOT_BYTES) {
      truncated = true;
      break;
    }
    bytes += optionBytes;
    seen.add(option.id);
    configOptions.push(option);
  }
  return {
    capabilities: {
      loadSession: capabilities.loadSession === true,
      resumeSession:
        plainRecord(sessionCapabilities.resume),
      promptImage: promptCapabilities.image === true,
    },
    authMethodIds: auth.ids,
    configOptions,
    truncated: truncated || bounds.truncated,
  };
}

export function cloneAcpSessionConfigSnapshot(
  snapshot: AcpSessionConfigSnapshot
): AcpSessionConfigSnapshot {
  return {
    capabilities: { ...snapshot.capabilities },
    authMethodIds: [...snapshot.authMethodIds],
    configOptions: snapshot.configOptions.map((option) =>
      option.type === "select"
        ? {
            ...option,
            options:
              option.options.kind === "flat"
                ? {
                    kind: "flat" as const,
                    options: option.options.options.map((value) => ({ ...value })),
                  }
                : {
                    kind: "grouped" as const,
                    groups: option.options.groups.map((group) => ({
                      ...group,
                      options: group.options.map((value) => ({ ...value })),
                    })),
                  },
          }
        : { ...option }
    ),
    truncated: snapshot.truncated,
  };
}

/** Strict persisted-row parser; runtime wire normalization happens before disk. */
export function parseAcpSessionConfigSnapshot(
  value: unknown
): AcpSessionConfigSnapshot | null {
  if (!plainRecord(value)) return null;
  if (
    Object.keys(value).some(
      (key) =>
        key !== "capabilities" &&
        key !== "authMethodIds" &&
        key !== "configOptions" &&
        key !== "truncated"
    )
  ) {
    return null;
  }
  if (!plainRecord(value.capabilities)) return null;
  if (
    Object.keys(value.capabilities).some(
      (key) => key !== "loadSession" && key !== "resumeSession" && key !== "promptImage"
    ) ||
    typeof value.capabilities.loadSession !== "boolean" ||
    typeof value.capabilities.resumeSession !== "boolean" ||
    typeof value.capabilities.promptImage !== "boolean"
  ) {
    return null;
  }
  if (!Array.isArray(value.authMethodIds) || !Array.isArray(value.configOptions)) {
    return null;
  }
  if (typeof value.truncated !== "boolean") return null;
  const wireOptions = value.configOptions.map((option) => {
    if (!plainRecord(option) || option.type !== "select") return option;
    if (!plainRecord(option.options)) return option;
    if (option.options.kind === "flat" && Array.isArray(option.options.options)) {
      return { ...option, options: option.options.options };
    }
    if (
      option.options.kind === "grouped" &&
      Array.isArray(option.options.groups)
    ) {
      return { ...option, options: option.options.groups };
    }
    return option;
  });
  const normalized = createAcpSessionConfigSnapshot({
    agentCapabilities: {
      loadSession: value.capabilities.loadSession,
      sessionCapabilities: value.capabilities.resumeSession ? { resume: {} } : {},
      promptCapabilities: { image: value.capabilities.promptImage },
    },
    authMethods: value.authMethodIds.map((id) => ({ id })),
    configOptions: wireOptions,
  });
  if (
    normalized.truncated ||
    JSON.stringify(normalized.authMethodIds) !== JSON.stringify(value.authMethodIds) ||
    JSON.stringify(normalized.configOptions) !== JSON.stringify(value.configOptions)
  ) {
    return null;
  }
  normalized.truncated = value.truncated;
  return normalized;
}

/** Params returned by the adapter auth hook for the ACP `authenticate` RPC. */
export type AcpAuthenticateParams = {
  methodId: string;
  [key: string]: unknown;
};

/**
 * Shared machine-local ACP Connection launch bag (`ConnectionLaunchPlan.extras.acp`).
 * Provider-neutral field names; each *-acp adapter interprets values for its CLI.
 * Secret values stay in OS/process env — only env key *names* and non-secret paths live here.
 * Provider adapters may extend this bag for provider-only knobs.
 */
export interface AcpRouteOptions {
  /** Absolute path to the provider CLI / ACP bridge executable on this machine. */
  executable?: string;
  /** Explicit model id passed to the provider CLI when supported. */
  model?: string;
  /**
   * Process env key for API token (read from service process env only).
   * Value is never written to workspace, Node, Task, or connections.json.
   * When launchSecretRef is set, AgentRuntime resolves the encrypted launch secret into this env key
   * at startSession (process-scoped ConnectionLaunchPlan.env only — never SessionRecord / disk).
   */
  envKey?: string;
  /**
   * Machine-local LaunchSecretStore id (reference only — never the secret value).
   * Service resolves via the OS-backed LaunchSecretStore; connections.json stores only this id.
   */
  launchSecretRef?: string;
  /**
   * Process env key whose **value** is an OpenAI-compatible / provider base URL.
   * Only the env key *name* is stored on the machine-local Connection.
   */
  baseUrlEnvKey?: string;
  /**
   * Optional literal base URL on the **machine-local** Connection only.
   * Prefer baseUrlEnvKey + process env. Never copy this field into workspace / git.
   */
  baseUrl?: string;
  /** Max wait for session/prompt result (ms). Default: DEFAULT_PROMPT_TIMEOUT_MS. */
  promptTimeoutMs?: number;
  /**
   * How to answer ACP tool permission requests:
   * - deny (default): cancel — never auto-approve
   * - allow: allow_once only (never allow_always / yolo)
   * - ask: emit session.waiting_user and wait for runtime permission decision or timeout→deny
   */
  permissionPolicy?: AcpPermissionPolicy;
  /** When permissionPolicy is ask, max wait before deny (ms). Default: DEFAULT_PERMISSION_TIMEOUT_MS. */
  permissionTimeoutMs?: number;
}
