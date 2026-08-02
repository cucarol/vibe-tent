// Immutable, non-secret machine Settings route shapes.
// This module deliberately has no legacy executor-catalog compatibility surface.

import type { AcpPermissionPolicy } from "../adapters/acp/types.js";
import type { RouteMcpServer, RouteSkillRef } from "../adapters/acp/mcp-skills.js";
import { cloneMcpServers, cloneSkillRefs } from "../adapters/acp/mcp-skills.js";
import { createHash } from "node:crypto";
import { isRouteId } from "../core/id.js";

/** Canonical row in machine-local Settings `routes.json`. */
export interface SettingsRouteConfig {
  routeId: string;
  /** Provider family, used for attribution and resume snapshot validation. */
  provider: string;
  /** Registered local adapter which launches this route. */
  adapterId: string;
  displayName?: string;
  /** Non-secret executable command for custom/generic local routes. */
  command?: string;
  /** Non-secret argv for custom/generic local routes. */
  args?: string[];
  executable?: string;
  model?: string;
  /** Process env key name only; the value is never persisted. */
  envKey?: string;
  /** CredentialStore id only; resolve it for each start/resume. */
  credentialRef?: string;
  /** Process env key name only; its resolved endpoint affects continuity digest. */
  baseUrlEnvKey?: string;
  /** Non-secret endpoint configured directly in Settings. */
  baseUrl?: string;
  /** ACP tool-permission policy; unrelated to role-to-role authority. */
  permissionPolicy?: AcpPermissionPolicy;
  promptTimeoutMs?: number;
  permissionTimeoutMs?: number;
  skills?: RouteSkillRef[];
  mcpServers?: RouteMcpServer[];
  /** Test/in-memory fake adapter knobs. Never serialized by routes.json. */
  fake?: FakeRouteOptions;
}

export interface FakeRouteOptions {
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
 * No raw environment map or credential material may be added to this type.
 */
export interface SettingsRouteSnapshot {
  routeId: string;
  provider: string;
  adapterId: string;
  model?: string;
  command?: string;
  args?: string[];
  executable?: string;
  envKey?: string;
  credentialRef?: string;
  baseUrlEnvKey?: string;
  baseUrl?: string;
  permissionPolicy?: AcpPermissionPolicy;
  promptTimeoutMs?: number;
  permissionTimeoutMs?: number;
  skills?: RouteSkillRef[];
  mcpServers?: RouteMcpServer[];
  /** Test-only launch facts for in-memory fake routes. */
  fake?: FakeRouteOptions;
  effectiveEndpointDigest?: string;
  launchDigest: string;
}

export function cloneSettingsRoute(route: SettingsRouteConfig): SettingsRouteConfig {
  return {
    ...route,
    args: route.args?.length ? [...route.args] : undefined,
    skills: route.skills?.length ? cloneSkillRefs(route.skills) : undefined,
    mcpServers: route.mcpServers?.length ? cloneMcpServers(route.mcpServers) : undefined,
    fake: route.fake ? { ...route.fake } : undefined,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/**
 * The continuity digest covers every non-secret launch-affecting route fact,
 * including custom command/args and skills/MCP topology. It intentionally uses
 * only env key names and credential ids, never their resolved values.
 */
export function calculateSettingsRouteLaunchDigest(
  route: SettingsRouteConfig,
  effectiveEndpointDigest?: string
): string {
  const canonical = cloneSettingsRoute(route);
  const input = {
    routeId: canonical.routeId, provider: canonical.provider, adapterId: canonical.adapterId,
    command: canonical.command, args: canonical.args, executable: canonical.executable, model: canonical.model,
    envKey: canonical.envKey, credentialRef: canonical.credentialRef,
    baseUrlEnvKey: canonical.baseUrlEnvKey, baseUrl: canonical.baseUrl,
    effectiveEndpointDigest, permissionPolicy: canonical.permissionPolicy,
    promptTimeoutMs: canonical.promptTimeoutMs,
    permissionTimeoutMs: canonical.permissionTimeoutMs,
    skills: canonical.skills, mcpServers: canonical.mcpServers, fake: canonical.fake,
  };
  return `sha256:${createHash("sha256").update(stableJson(input)).digest("hex")}`;
}

export function createSettingsRouteSnapshot(
  route: SettingsRouteConfig,
  details: Pick<SettingsRouteSnapshot, "effectiveEndpointDigest">
): SettingsRouteSnapshot {
  return {
    routeId: route.routeId,
    provider: route.provider,
    adapterId: route.adapterId,
    ...(route.model ? { model: route.model } : {}),
    ...(route.command ? { command: route.command } : {}),
    ...(route.args?.length ? { args: [...route.args] } : {}),
    ...(route.executable ? { executable: route.executable } : {}),
    ...(route.envKey ? { envKey: route.envKey } : {}),
    ...(route.credentialRef ? { credentialRef: route.credentialRef } : {}),
    ...(route.baseUrlEnvKey ? { baseUrlEnvKey: route.baseUrlEnvKey } : {}),
    ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}),
    ...(route.permissionPolicy ? { permissionPolicy: route.permissionPolicy } : {}),
    ...(route.promptTimeoutMs !== undefined ? { promptTimeoutMs: route.promptTimeoutMs } : {}),
    ...(route.permissionTimeoutMs !== undefined
      ? { permissionTimeoutMs: route.permissionTimeoutMs }
      : {}),
    ...(route.skills?.length ? { skills: cloneSkillRefs(route.skills) } : {}),
    ...(route.mcpServers?.length ? { mcpServers: cloneMcpServers(route.mcpServers) } : {}),
    ...(route.fake ? { fake: { ...route.fake } } : {}),
    ...(details.effectiveEndpointDigest ? { effectiveEndpointDigest: details.effectiveEndpointDigest } : {}),
    launchDigest: calculateSettingsRouteLaunchDigest(route, details.effectiveEndpointDigest),
  };
}

/** Reconstruct the immutable non-secret launch subset for provider-native resume. */
export function routeConfigFromSnapshot(snapshot: SettingsRouteSnapshot): SettingsRouteConfig {
  return {
    routeId: snapshot.routeId,
    provider: snapshot.provider,
    adapterId: snapshot.adapterId,
    ...(snapshot.model ? { model: snapshot.model } : {}),
    ...(snapshot.command ? { command: snapshot.command } : {}),
    ...(snapshot.args ? { args: [...snapshot.args] } : {}),
    ...(snapshot.executable ? { executable: snapshot.executable } : {}),
    ...(snapshot.envKey ? { envKey: snapshot.envKey } : {}),
    ...(snapshot.credentialRef ? { credentialRef: snapshot.credentialRef } : {}),
    ...(snapshot.baseUrlEnvKey ? { baseUrlEnvKey: snapshot.baseUrlEnvKey } : {}),
    ...(snapshot.baseUrl ? { baseUrl: snapshot.baseUrl } : {}),
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
  "routeId", "provider", "adapterId", "model", "command", "args", "executable",
  "envKey", "credentialRef", "baseUrlEnvKey", "baseUrl", "permissionPolicy",
  "promptTimeoutMs", "permissionTimeoutMs", "skills", "mcpServers", "fake",
  "effectiveEndpointDigest", "launchDigest",
]);
const SKILL_KEYS = new Set(["name", "path", "enabled"]);
const MCP_KEYS = new Set([
  "name", "transport", "enabled", "command", "args", "envKeys",
  "envCredentialRefs", "url", "headerEnvKeys", "headerCredentialRefs",
]);
const FAKE_KEYS = new Set([
  "sleepMs", "exitCode", "waitForSignal", "emitStdout", "failLaunch", "canResume",
]);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_REF_RE = /^[a-z][a-z0-9-]{0,62}$/;
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

function validSkill(value: unknown): value is RouteSkillRef {
  return plainRecord(value) && onlyKeys(value, SKILL_KEYS) &&
    typeof value.name === "string" && value.name.length > 0 &&
    optionalString(value.path) &&
    (value.enabled === undefined || typeof value.enabled === "boolean");
}

function validMcp(value: unknown): value is RouteMcpServer {
  if (!plainRecord(value) || !onlyKeys(value, MCP_KEYS)) return false;
  if (typeof value.name !== "string" || !value.name) return false;
  if (value.transport !== "stdio" && value.transport !== "http") return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (!optionalString(value.command) || !optionalString(value.url)) return false;
  if (value.args !== undefined &&
      (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string"))) {
    return false;
  }
  for (const key of ["envKeys", "envCredentialRefs", "headerEnvKeys", "headerCredentialRefs"] as const) {
    if (value[key] !== undefined && !stringMap(value[key])) return false;
  }
  return true;
}

function validFake(value: unknown): value is FakeRouteOptions {
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

/** Strict fresh-schema parser for persisted immutable Session route facts. */
export function parseSettingsRouteSnapshot(value: unknown): SettingsRouteSnapshot | null {
  if (!plainRecord(value) || !onlyKeys(value, SNAPSHOT_KEYS)) return null;
  if (!isRouteId(value.routeId)) return null;
  if (typeof value.provider !== "string" || !value.provider) return null;
  if (typeof value.adapterId !== "string" || !value.adapterId) return null;
  for (const key of ["model", "command", "executable"] as const) {
    if (!optionalString(value[key])) return null;
  }
  if (value.args !== undefined &&
      (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string"))) {
    return null;
  }
  for (const key of ["envKey", "baseUrlEnvKey"] as const) {
    if (value[key] !== undefined &&
        (typeof value[key] !== "string" || !ENV_KEY_RE.test(value[key]))) return null;
  }
  if (value.credentialRef !== undefined &&
      (typeof value.credentialRef !== "string" || !CREDENTIAL_REF_RE.test(value.credentialRef))) {
    return null;
  }
  if (!safeBaseUrl(value.baseUrl)) return null;
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

  const snapshot = value as unknown as SettingsRouteSnapshot;
  const route = routeConfigFromSnapshot(snapshot);
  if (calculateSettingsRouteLaunchDigest(route, snapshot.effectiveEndpointDigest) !== snapshot.launchDigest) {
    return null;
  }
  return createSettingsRouteSnapshot(route, {
    effectiveEndpointDigest: snapshot.effectiveEndpointDigest,
  });
}
