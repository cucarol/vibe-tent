// Immutable, non-secret machine Agent Connection shapes.
// This module deliberately has no legacy executor-catalog compatibility surface.

import type { AcpPermissionPolicy } from "../adapters/acp/types.js";
import type { ConnectionMcpServer, ConnectionSkillRef } from "../adapters/acp/mcp-skills.js";
import { cloneMcpServers, cloneSkillRefs } from "../adapters/acp/mcp-skills.js";
import { createHash } from "node:crypto";
import { isConnectionId } from "../core/id.js";

/** Canonical row in machine-local Settings `connections.json`. */
export interface AgentConnectionConfig {
  connectionId: string;
  /** Provider family, used for attribution and resume snapshot validation. */
  provider: string;
  /** Registered local adapter which launches this Connection. */
  adapterId: string;
  displayName?: string;
  /** Exact non-secret launch command for this Connection. */
  command?: string;
  /** Complete non-secret argv for this Connection. */
  args?: string[];
  model?: string;
  /** Process env key name only; the value is never persisted. */
  envKey?: string;
  /** LaunchSecretStore id only; resolve it for each start/resume. */
  launchSecretRef?: string;
  /** Non-secret endpoint configured directly in Settings. */
  endpoint?: string;
  /** ACP tool-permission policy; unrelated to role-to-role authority. */
  permissionPolicy?: AcpPermissionPolicy;
  promptTimeoutMs?: number;
  permissionTimeoutMs?: number;
  skills?: ConnectionSkillRef[];
  mcpServers?: ConnectionMcpServer[];
  /** Test/in-memory fake adapter knobs. Never serialized by connections.json. */
  fake?: FakeConnectionOptions;
}

export interface FakeConnectionOptions {
  sleepMs?: number;
  exitCode?: number;
  waitForSignal?: boolean;
  emitStdout?: boolean;
  failLaunch?: string;
  canResume?: boolean;
}

/**
 * Persisted session binding. `effectiveEndpointDigest` is derived by the launch
 * planner from a normalized endpoint; the raw resolved endpoint is never stored.
 * No raw environment map or secret material may be added to this type.
 */
export interface AgentConnectionSnapshot {
  connectionId: string;
  provider: string;
  adapterId: string;
  model?: string;
  command?: string;
  args?: string[];
  envKey?: string;
  launchSecretRef?: string;
  endpoint?: string;
  permissionPolicy?: AcpPermissionPolicy;
  promptTimeoutMs?: number;
  permissionTimeoutMs?: number;
  skills?: ConnectionSkillRef[];
  mcpServers?: ConnectionMcpServer[];
  /** Test-only launch facts for in-memory fake Connections. */
  fake?: FakeConnectionOptions;
  effectiveEndpointDigest?: string;
  launchDigest: string;
}

export function cloneAgentConnection(connection: AgentConnectionConfig): AgentConnectionConfig {
  return {
    ...connection,
    args: connection.args ? [...connection.args] : undefined,
    skills: connection.skills?.length ? cloneSkillRefs(connection.skills) : undefined,
    mcpServers: connection.mcpServers?.length ? cloneMcpServers(connection.mcpServers) : undefined,
    fake: connection.fake ? { ...connection.fake } : undefined,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/**
 * The continuity digest covers every non-secret launch-affecting Connection fact,
 * including custom command/args and skills/MCP topology. It intentionally uses
 * only env key names and launch-secret ids, never their resolved values.
 */
export function calculateAgentConnectionLaunchDigest(
  connection: AgentConnectionConfig,
  effectiveEndpointDigest?: string
): string {
  const canonical = cloneAgentConnection(connection);
  const input = {
    connectionId: canonical.connectionId, provider: canonical.provider, adapterId: canonical.adapterId,
    command: canonical.command, args: canonical.args, model: canonical.model,
    envKey: canonical.envKey, launchSecretRef: canonical.launchSecretRef,
    endpoint: canonical.endpoint,
    effectiveEndpointDigest, permissionPolicy: canonical.permissionPolicy,
    promptTimeoutMs: canonical.promptTimeoutMs,
    permissionTimeoutMs: canonical.permissionTimeoutMs,
    skills: canonical.skills, mcpServers: canonical.mcpServers, fake: canonical.fake,
  };
  return `sha256:${createHash("sha256").update(stableJson(input)).digest("hex")}`;
}

export function createAgentConnectionSnapshot(
  connection: AgentConnectionConfig,
  details: Pick<AgentConnectionSnapshot, "effectiveEndpointDigest">
): AgentConnectionSnapshot {
  return {
    connectionId: connection.connectionId,
    provider: connection.provider,
    adapterId: connection.adapterId,
    ...(connection.model ? { model: connection.model } : {}),
    ...(connection.command ? { command: connection.command } : {}),
    ...(connection.args ? { args: [...connection.args] } : {}),
    ...(connection.envKey ? { envKey: connection.envKey } : {}),
    ...(connection.launchSecretRef ? { launchSecretRef: connection.launchSecretRef } : {}),
    ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
    ...(connection.permissionPolicy ? { permissionPolicy: connection.permissionPolicy } : {}),
    ...(connection.promptTimeoutMs !== undefined ? { promptTimeoutMs: connection.promptTimeoutMs } : {}),
    ...(connection.permissionTimeoutMs !== undefined
      ? { permissionTimeoutMs: connection.permissionTimeoutMs }
      : {}),
    ...(connection.skills?.length ? { skills: cloneSkillRefs(connection.skills) } : {}),
    ...(connection.mcpServers?.length ? { mcpServers: cloneMcpServers(connection.mcpServers) } : {}),
    ...(connection.fake ? { fake: { ...connection.fake } } : {}),
    ...(details.effectiveEndpointDigest ? { effectiveEndpointDigest: details.effectiveEndpointDigest } : {}),
    launchDigest: calculateAgentConnectionLaunchDigest(connection, details.effectiveEndpointDigest),
  };
}

/** Reconstruct the immutable non-secret launch subset for provider-native resume. */
export function connectionConfigFromSnapshot(snapshot: AgentConnectionSnapshot): AgentConnectionConfig {
  return {
    connectionId: snapshot.connectionId,
    provider: snapshot.provider,
    adapterId: snapshot.adapterId,
    ...(snapshot.model ? { model: snapshot.model } : {}),
    ...(snapshot.command ? { command: snapshot.command } : {}),
    ...(snapshot.args ? { args: [...snapshot.args] } : {}),
    ...(snapshot.envKey ? { envKey: snapshot.envKey } : {}),
    ...(snapshot.launchSecretRef ? { launchSecretRef: snapshot.launchSecretRef } : {}),
    ...(snapshot.endpoint ? { endpoint: snapshot.endpoint } : {}),
    ...(snapshot.permissionPolicy ? { permissionPolicy: snapshot.permissionPolicy } : {}),
    ...(snapshot.promptTimeoutMs !== undefined
      ? { promptTimeoutMs: snapshot.promptTimeoutMs }
      : {}),
    ...(snapshot.permissionTimeoutMs !== undefined
      ? { permissionTimeoutMs: snapshot.permissionTimeoutMs }
      : {}),
    ...(snapshot.skills ? { skills: cloneSkillRefs(snapshot.skills) } : {}),
    ...(snapshot.mcpServers ? { mcpServers: cloneMcpServers(snapshot.mcpServers) } : {}),
    ...(snapshot.fake ? { fake: { ...snapshot.fake } } : {}),
  };
}

const SNAPSHOT_KEYS = new Set([
  "connectionId", "provider", "adapterId", "model", "command", "args",
  "envKey", "launchSecretRef", "endpoint", "permissionPolicy",
  "promptTimeoutMs", "permissionTimeoutMs", "skills", "mcpServers", "fake",
  "effectiveEndpointDigest", "launchDigest",
]);
const SKILL_KEYS = new Set(["name", "path", "enabled"]);
const MCP_KEYS = new Set([
  "name", "transport", "enabled", "command", "args", "envKeys",
  "envSecretRefs", "url", "headerEnvKeys", "headerSecretRefs",
]);
const FAKE_KEYS = new Set([
  "sleepMs", "exitCode", "waitForSignal", "emitStdout", "failLaunch", "canResume",
]);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LAUNCH_SECRET_REF_RE = /^[a-z][a-z0-9-]{0,62}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function optionalString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function optionalPositiveInt(value: unknown): boolean {
  return value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value > 0);
}

function stringMap(value: unknown): boolean {
  return plainRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function validSkill(value: unknown): value is ConnectionSkillRef {
  return plainRecord(value) && onlyKeys(value, SKILL_KEYS) &&
    typeof value.name === "string" && value.name.length > 0 &&
    optionalString(value.path) &&
    (value.enabled === undefined || typeof value.enabled === "boolean");
}

function validMcp(value: unknown): value is ConnectionMcpServer {
  if (!plainRecord(value) || !onlyKeys(value, MCP_KEYS)) return false;
  if (typeof value.name !== "string" || !value.name) return false;
  if (value.transport !== "stdio" && value.transport !== "http") return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (!optionalString(value.command) || !optionalString(value.url)) return false;
  if (value.args !== undefined &&
      (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string"))) {
    return false;
  }
  for (const key of ["envKeys", "envSecretRefs", "headerEnvKeys", "headerSecretRefs"] as const) {
    if (value[key] !== undefined && !stringMap(value[key])) return false;
  }
  return true;
}

function validFake(value: unknown): value is FakeConnectionOptions {
  if (!plainRecord(value) || !onlyKeys(value, FAKE_KEYS)) return false;
  for (const key of ["sleepMs", "exitCode"] as const) {
    if (value[key] !== undefined &&
        (typeof value[key] !== "number" || !Number.isInteger(value[key]))) return false;
  }
  for (const key of ["waitForSignal", "emitStdout", "canResume"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
  }
  return optionalString(value.failLaunch);
}

function safeBaseUrl(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Strict parser for persisted immutable Session Connection facts. */
export function parseAgentConnectionSnapshot(value: unknown): AgentConnectionSnapshot | null {
  if (!plainRecord(value) || !onlyKeys(value, SNAPSHOT_KEYS)) return null;
  if (!isConnectionId(value.connectionId)) return null;
  if (typeof value.provider !== "string" || !value.provider) return null;
  if (typeof value.adapterId !== "string" || !value.adapterId) return null;
  for (const key of ["model", "command"] as const) {
    if (!optionalString(value[key])) return null;
  }
  if (value.args !== undefined &&
      (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string"))) {
    return null;
  }
  for (const key of ["envKey"] as const) {
    if (value[key] !== undefined &&
        (typeof value[key] !== "string" || !ENV_KEY_RE.test(value[key]))) return null;
  }
  if (value.launchSecretRef !== undefined &&
      (typeof value.launchSecretRef !== "string" || !LAUNCH_SECRET_REF_RE.test(value.launchSecretRef))) {
    return null;
  }
  if (!safeBaseUrl(value.endpoint)) return null;
  if (value.permissionPolicy !== undefined &&
      value.permissionPolicy !== "allow" && value.permissionPolicy !== "ask" &&
      value.permissionPolicy !== "deny") return null;
  if (!optionalPositiveInt(value.promptTimeoutMs) ||
      !optionalPositiveInt(value.permissionTimeoutMs)) return null;
  if (value.skills !== undefined &&
      (!Array.isArray(value.skills) || !value.skills.every(validSkill))) return null;
  if (value.mcpServers !== undefined &&
      (!Array.isArray(value.mcpServers) || !value.mcpServers.every(validMcp))) return null;
  if (value.fake !== undefined && !validFake(value.fake)) return null;
  if (value.effectiveEndpointDigest !== undefined &&
      (typeof value.effectiveEndpointDigest !== "string" ||
       !SHA256_RE.test(value.effectiveEndpointDigest))) return null;
  if (typeof value.launchDigest !== "string" || !SHA256_RE.test(value.launchDigest)) return null;

  const snapshot = value as unknown as AgentConnectionSnapshot;
  const connection = connectionConfigFromSnapshot(snapshot);
  if (calculateAgentConnectionLaunchDigest(connection, snapshot.effectiveEndpointDigest) !== snapshot.launchDigest) {
    return null;
  }
  return createAgentConnectionSnapshot(connection, {
    effectiveEndpointDigest: snapshot.effectiveEndpointDigest,
  });
}
