// Canonical machine-local Settings route store. Never workspace state or an executor catalog.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ANTIGRAVITY_ACP_ADAPTER_ID,
  CLAUDE_ACP_ADAPTER_ID,
  CODEX_ACP_ADAPTER_ID,
  COPILOT_ACP_ADAPTER_ID,
  DEFAULT_GROK_BASE_URL_ENV_KEY,
  DEFAULT_GROK_ENV_KEY,
  DEFAULT_GROK_MODEL,
  GROK_ACP_ADAPTER_ID,
  OPENCODE_ACP_ADAPTER_ID,
  PI_ACP_ADAPTER_ID,
} from "../adapters/index.js";
import {
  defaultAllowedSkillRoots,
  parseMcpServersArrayValue,
  parseSkillsArrayValue,
  projectMcpServers,
  projectSkillRefs,
} from "../adapters/acp/mcp-skills.js";
import { cloneSettingsRoute, type SettingsRouteConfig } from "../runtime/route-config.js";
import type { SettingsRouteProjection } from "./types.js";
import { backupCorruptMachineFile, isNotFoundError, warnCorruptMachineState, writeJsonAtomic } from "../machine-state.js";
import {
  parseBaseUrlValue, parseCredentialRefValue, parseEnvKeyValue, parseNonEmptyStringValue,
  parsePermissionPolicyValue, parsePositiveTimeoutValue, parseRouteIdValue, type FieldResult,
} from "./route-field-rules.js";

export type { SettingsRouteConfig } from "../runtime/route-config.js";

export const SETTINGS_ROUTE_CREATE_FIELDS = [
  "routeId", "provider", "adapterId", "displayName", "command", "args", "executable", "model", "envKey",
  "credentialRef", "baseUrlEnvKey", "baseUrl", "permissionPolicy", "promptTimeoutMs",
  "permissionTimeoutMs", "skills", "mcpServers",
] as const;
export const SETTINGS_ROUTE_UPDATE_FIELDS = SETTINGS_ROUTE_CREATE_FIELDS.filter((field) => field !== "routeId") as readonly string[];

const DISK_KEYS: ReadonlySet<string> = new Set(SETTINGS_ROUTE_CREATE_FIELDS);

export function routesPath(dataDir: string): string {
  return path.join(dataDir, "routes.json");
}

function diskOptional<T>(value: unknown, parse: (value: unknown) => FieldResult<T>): T | undefined | null {
  if (value === undefined || value === null) return undefined;
  const result = parse(value);
  return result.ok ? result.value : null;
}

function parseArgsValue(value: unknown): FieldResult<string[]> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { ok: false, message: "Invalid args: must be an array of strings" };
  }
  return { ok: true, value: [...value] };
}

function parseRouteRow(value: unknown): SettingsRouteConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !DISK_KEYS.has(key))) return null;
  const routeId = parseRouteIdValue(row.routeId);
  const provider = parseNonEmptyStringValue(row.provider, "provider");
  const adapterId = parseNonEmptyStringValue(row.adapterId, "adapterId");
  if (!routeId.ok || !provider.ok || !adapterId.ok) return null;
  const route: SettingsRouteConfig = { routeId: routeId.value, provider: provider.value, adapterId: adapterId.value };
  const optional = <T>(key: string, parse: (v: unknown) => FieldResult<T>, assign: (v: T) => void) => {
    const parsed = diskOptional(row[key], parse);
    if (parsed === null) return false;
    if (parsed !== undefined) assign(parsed);
    return true;
  };
  if (!optional("displayName", (v) => parseNonEmptyStringValue(v, "displayName"), (v) => { route.displayName = v; })) return null;
  if (!optional("command", (v) => parseNonEmptyStringValue(v, "command"), (v) => { route.command = v; })) return null;
  if (!optional("args", parseArgsValue, (v) => { route.args = v; })) return null;
  if (!optional("executable", (v) => parseNonEmptyStringValue(v, "executable"), (v) => { route.executable = v; })) return null;
  if (!optional("model", (v) => parseNonEmptyStringValue(v, "model"), (v) => { route.model = v; })) return null;
  if (!optional("envKey", (v) => parseEnvKeyValue(v, "envKey"), (v) => { route.envKey = v; })) return null;
  if (!optional("credentialRef", parseCredentialRefValue, (v) => { route.credentialRef = v; })) return null;
  if (!optional("baseUrlEnvKey", (v) => parseEnvKeyValue(v, "baseUrlEnvKey"), (v) => { route.baseUrlEnvKey = v; })) return null;
  if (!optional("baseUrl", parseBaseUrlValue, (v) => { route.baseUrl = v; })) return null;
  if (!optional("permissionPolicy", parsePermissionPolicyValue, (v) => { route.permissionPolicy = v; })) return null;
  if (!optional("promptTimeoutMs", (v) => parsePositiveTimeoutValue(v, "promptTimeoutMs"), (v) => { route.promptTimeoutMs = v; })) return null;
  if (!optional("permissionTimeoutMs", (v) => parsePositiveTimeoutValue(v, "permissionTimeoutMs"), (v) => { route.permissionTimeoutMs = v; })) return null;
  if (row.skills !== undefined && row.skills !== null) {
    const skills = parseSkillsArrayValue(row.skills, defaultAllowedSkillRoots());
    if (!skills.ok) return null;
    route.skills = skills.value;
  }
  if (row.mcpServers !== undefined && row.mcpServers !== null) {
    const mcp = parseMcpServersArrayValue(row.mcpServers);
    if (!mcp.ok) return null;
    route.mcpServers = mcp.value;
  }
  return route;
}

async function quarantineRoutes(file: string): Promise<never> {
  const backup = await backupCorruptMachineFile(file);
  warnCorruptMachineState(file, backup, "ignored");
  throw new Error(
    `Settings routes are unreadable and were quarantined: ${file}` +
      (backup ? ` (backup: ${backup})` : "")
  );
}

/** Reads only `{ routes: [...] }`; no profile file, alias, or legacy migration is consulted. */
export async function loadSettingsRoutes(dataDir: string): Promise<SettingsRouteConfig[]> {
  const file = routesPath(dataDir);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isNotFoundError(err)) return [];
    return quarantineRoutes(file);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return quarantineRoutes(file);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return quarantineRoutes(file);
  }
  const routes = (parsed as { routes?: unknown }).routes;
  if (!Array.isArray(routes)) return quarantineRoutes(file);
  const out: SettingsRouteConfig[] = [];
  for (const value of routes) {
    const route = parseRouteRow(value);
    if (!route || out.some((existing) => existing.routeId === route.routeId)) {
      return quarantineRoutes(file);
    }
    out.push(route);
  }
  return out;
}

export async function saveSettingsRoutes(dataDir: string, routes: SettingsRouteConfig[]): Promise<void> {
  await writeJsonAtomic(routesPath(dataDir), { routes: routes.map(cloneSettingsRoute) });
}

export function defaultSettingsRoutes(): SettingsRouteConfig[] {
  const route = (routeId: string, provider: string, adapterId: string, extra: Partial<SettingsRouteConfig> = {}): SettingsRouteConfig => ({
    routeId, provider, adapterId, permissionPolicy: "deny", ...extra,
  });
  return [
    route("grok-acp-default", "grok", GROK_ACP_ADAPTER_ID, { model: DEFAULT_GROK_MODEL, envKey: DEFAULT_GROK_ENV_KEY, baseUrlEnvKey: DEFAULT_GROK_BASE_URL_ENV_KEY }),
    route("codex-acp-default", "codex", CODEX_ACP_ADAPTER_ID),
    route("claude-acp-default", "claude", CLAUDE_ACP_ADAPTER_ID),
    route("antigravity-acp-default", "antigravity", ANTIGRAVITY_ACP_ADAPTER_ID),
    route("opencode-acp-default", "opencode", OPENCODE_ACP_ADAPTER_ID),
    route("copilot-acp-default", "copilot", COPILOT_ACP_ADAPTER_ID),
    route("pi-acp-default", "pi", PI_ACP_ADAPTER_ID),
  ];
}

export async function ensureDefaultSettingsRoutes(dataDir: string): Promise<SettingsRouteConfig[]> {
  const file = routesPath(dataDir);
  try {
    await fs.access(file);
    return loadSettingsRoutes(dataDir);
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
  const defaults = defaultSettingsRoutes();
  await saveSettingsRoutes(dataDir, defaults);
  return defaults;
}

/** Safe client projection; credential values and raw environment values never cross this boundary. */
export function projectSettingsRoute(
  route: SettingsRouteConfig,
  opts?: { credentialExists?: boolean }
): SettingsRouteProjection {
  const credentialRef = route.credentialRef?.trim() || undefined;
  const skills = projectSkillRefs(route.skills);
  const mcpServers = projectMcpServers(route.mcpServers);
  return {
    routeId: route.routeId,
    provider: route.provider,
    adapterId: route.adapterId,
    displayName: route.displayName?.trim() || route.routeId,
    ...(route.command ? { command: route.command } : {}),
    ...(route.args ? { args: [...route.args] } : {}),
    ...(route.model ? { model: route.model } : {}),
    ...(route.executable ? { executable: route.executable } : {}),
    ...(route.envKey ? { envKey: route.envKey } : {}),
    ...(credentialRef ? { credentialRef } : {}),
    ...(credentialRef && opts?.credentialExists !== undefined
      ? { credentialExists: opts.credentialExists }
      : {}),
    ...(route.baseUrlEnvKey ? { baseUrlEnvKey: route.baseUrlEnvKey } : {}),
    ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}),
    ...(route.permissionPolicy ? { permissionPolicy: route.permissionPolicy } : {}),
    ...(route.promptTimeoutMs !== undefined ? { promptTimeoutMs: route.promptTimeoutMs } : {}),
    ...(route.permissionTimeoutMs !== undefined
      ? { permissionTimeoutMs: route.permissionTimeoutMs }
      : {}),
    ...(skills
      ? {
          skills,
          skillsProjectionMode: "metadata-provider-dependent" as const,
          skillsNote:
            "Skill name/path refs only (_meta.tent.skills). Provider-dependent; not a claim of activation.",
        }
      : {}),
    ...(mcpServers ? { mcpServers } : {}),
  };
}

export function projectSettingsRoutes(
  routes: SettingsRouteConfig[],
  opts?: { credentialExistsById?: ReadonlyMap<string, boolean> | Record<string, boolean> }
): SettingsRouteProjection[] {
  const lookup = (ref: string | undefined): boolean | undefined => {
    if (!ref || !opts?.credentialExistsById) return undefined;
    return opts.credentialExistsById instanceof Map
      ? opts.credentialExistsById.get(ref)
      : (opts.credentialExistsById as Record<string, boolean>)[ref];
  };
  return routes
    .map((route) => {
      const exists = lookup(route.credentialRef?.trim());
      return projectSettingsRoute(
        route,
        exists === undefined ? undefined : { credentialExists: exists }
      );
    })
    .sort((a, b) => a.routeId.localeCompare(b.routeId));
}
