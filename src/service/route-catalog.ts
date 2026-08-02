// In-process Settings route catalog. Routes are machine launch configuration only.

import { cloneSettingsRoute, type SettingsRouteConfig } from "../runtime/route-config.js";
import {
  SECRET_ROUTE_FIELD_HINTS, parseBaseUrlValue, parseCredentialRefValue, parseEnvKeyValue,
  parseNonEmptyStringValue, parsePermissionPolicyValue, parsePositiveTimeoutValue, parseRouteIdValue,
  type FieldResult,
} from "./route-field-rules.js";
import { SETTINGS_ROUTE_CREATE_FIELDS, SETTINGS_ROUTE_UPDATE_FIELDS, saveSettingsRoutes } from "./routes.js";
import { RpcError } from "./rpc-error.js";
import { defaultAllowedSkillRoots, parseMcpServersArrayValue, parseSkillsArrayValue } from "../adapters/acp/mcp-skills.js";

export type SettingsRouteCatalogOptions = {
  persistToDisk?: boolean;
  saveRoutes?: (dataDir: string, routes: SettingsRouteConfig[]) => Promise<void>;
  publishRoutes?: (routes: SettingsRouteConfig[]) => void | Promise<void>;
};

const unwrap = <T>(result: FieldResult<T>): T => {
  if (!result.ok) throw new RpcError(-32602, result.message);
  return result.value;
};

function rejectUnknownOrSecret(raw: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (allowedSet.has(key)) continue;
    const lower = key.toLowerCase();
    if (SECRET_ROUTE_FIELD_HINTS.some((hint) => lower.includes(hint))) {
      throw new RpcError(-32602, `Rejected dangerous or unsupported route field: ${key}`);
    }
    throw new RpcError(-32602, `Unknown route field: ${key}`);
  }
}

const optional = <T>(raw: Record<string, unknown>, key: string, parse: (v: unknown) => FieldResult<T>): T | undefined =>
  !(key in raw) || raw[key] === undefined || raw[key] === null ? undefined : unwrap(parse(raw[key]));

function parseArgsValue(value: unknown): FieldResult<string[]> {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? { ok: true, value: [...value] }
    : { ok: false, message: "Invalid args: must be an array of strings" };
}

function parseCreate(raw: Record<string, unknown>): SettingsRouteConfig {
  rejectUnknownOrSecret(raw, SETTINGS_ROUTE_CREATE_FIELDS);
  const routeId = unwrap(parseRouteIdValue(raw.routeId));
  const provider = unwrap(parseNonEmptyStringValue(raw.provider, "provider"));
  const adapterId = unwrap(parseNonEmptyStringValue(raw.adapterId, "adapterId"));
  const route: SettingsRouteConfig = { routeId, provider, adapterId };
  const assign = <K extends keyof SettingsRouteConfig>(key: K, value: SettingsRouteConfig[K] | undefined) => { if (value !== undefined) route[key] = value; };
  assign("displayName", optional(raw, "displayName", (v) => parseNonEmptyStringValue(v, "displayName")));
  assign("command", optional(raw, "command", (v) => parseNonEmptyStringValue(v, "command")));
  assign("args", optional(raw, "args", parseArgsValue));
  assign("executable", optional(raw, "executable", (v) => parseNonEmptyStringValue(v, "executable")));
  assign("model", optional(raw, "model", (v) => parseNonEmptyStringValue(v, "model")));
  assign("envKey", optional(raw, "envKey", (v) => parseEnvKeyValue(v, "envKey")));
  assign("credentialRef", optional(raw, "credentialRef", parseCredentialRefValue));
  assign("baseUrlEnvKey", optional(raw, "baseUrlEnvKey", (v) => parseEnvKeyValue(v, "baseUrlEnvKey")));
  assign("baseUrl", optional(raw, "baseUrl", parseBaseUrlValue));
  assign("permissionPolicy", optional(raw, "permissionPolicy", parsePermissionPolicyValue));
  assign("promptTimeoutMs", optional(raw, "promptTimeoutMs", (v) => parsePositiveTimeoutValue(v, "promptTimeoutMs")));
  assign("permissionTimeoutMs", optional(raw, "permissionTimeoutMs", (v) => parsePositiveTimeoutValue(v, "permissionTimeoutMs")));
  if (raw.skills !== undefined && raw.skills !== null) route.skills = unwrap(parseSkillsArrayValue(raw.skills, defaultAllowedSkillRoots()));
  if (raw.mcpServers !== undefined && raw.mcpServers !== null) route.mcpServers = unwrap(parseMcpServersArrayValue(raw.mcpServers));
  return route;
}

function applyPatch(current: SettingsRouteConfig, raw: Record<string, unknown>): SettingsRouteConfig {
  rejectUnknownOrSecret(raw, SETTINGS_ROUTE_UPDATE_FIELDS);
  if ("routeId" in raw || "provider" in raw || "adapterId" in raw) {
    throw new RpcError(-32602, "routeId, provider, and adapterId are immutable; create a replacement route instead");
  }
  const next = cloneSettingsRoute(current);
  const scalar: Array<[keyof SettingsRouteConfig, (v: unknown) => FieldResult<unknown>]> = [
    ["displayName", (v) => parseNonEmptyStringValue(v, "displayName")], ["executable", (v) => parseNonEmptyStringValue(v, "executable")],
    ["model", (v) => parseNonEmptyStringValue(v, "model")], ["envKey", (v) => parseEnvKeyValue(v, "envKey")],
    ["credentialRef", parseCredentialRefValue], ["baseUrlEnvKey", (v) => parseEnvKeyValue(v, "baseUrlEnvKey")],
    ["baseUrl", parseBaseUrlValue], ["permissionPolicy", parsePermissionPolicyValue],
    ["promptTimeoutMs", (v) => parsePositiveTimeoutValue(v, "promptTimeoutMs")], ["permissionTimeoutMs", (v) => parsePositiveTimeoutValue(v, "permissionTimeoutMs")],
  ];
  for (const [key, parse] of scalar) {
    if (!(key in raw) || raw[key] === undefined) continue;
    if (raw[key] === null) delete next[key]; else (next as unknown as Record<string, unknown>)[key] = unwrap(parse(raw[key]));
  }
  if ("command" in raw && raw.command !== undefined) {
    if (raw.command === null) delete next.command; else next.command = unwrap(parseNonEmptyStringValue(raw.command, "command"));
  }
  if ("args" in raw && raw.args !== undefined) {
    if (raw.args === null) delete next.args; else next.args = unwrap(parseArgsValue(raw.args));
  }
  if ("skills" in raw && raw.skills !== undefined) {
    if (raw.skills === null) delete next.skills; else next.skills = unwrap(parseSkillsArrayValue(raw.skills, defaultAllowedSkillRoots()));
  }
  if ("mcpServers" in raw && raw.mcpServers !== undefined) {
    if (raw.mcpServers === null) delete next.mcpServers; else next.mcpServers = unwrap(parseMcpServersArrayValue(raw.mcpServers));
  }
  return next;
}

export class SettingsRouteCatalog {
  private routes: SettingsRouteConfig[];
  private chain: Promise<void> = Promise.resolve();
  private readonly persistToDisk: boolean;
  private readonly saveRoutes: (dataDir: string, routes: SettingsRouteConfig[]) => Promise<void>;
  private readonly publishRoutes?: (routes: SettingsRouteConfig[]) => void | Promise<void>;

  constructor(private readonly dataDir: string, initial: SettingsRouteConfig[], options?: SettingsRouteCatalogOptions) {
    this.routes = initial.map(cloneSettingsRoute);
    this.persistToDisk = options?.persistToDisk !== false;
    this.saveRoutes = options?.saveRoutes ?? saveSettingsRoutes;
    this.publishRoutes = options?.publishRoutes;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  list(): SettingsRouteConfig[] { return this.routes.map(cloneSettingsRoute); }
  get(routeId: string): SettingsRouteConfig | undefined {
    const route = this.routes.find((candidate) => candidate.routeId === routeId);
    return route && cloneSettingsRoute(route);
  }
  private async commit(next: SettingsRouteConfig[]): Promise<void> {
    const canonical = next.map(cloneSettingsRoute);
    if (this.persistToDisk) await this.saveRoutes(this.dataDir, canonical);
    await this.publishRoutes?.(canonical.map(cloneSettingsRoute));
    this.routes = canonical;
  }
  async create(raw: Record<string, unknown>): Promise<SettingsRouteConfig> {
    return this.enqueue(async () => {
      const route = parseCreate(raw);
      if (this.routes.some((candidate) => candidate.routeId === route.routeId)) throw new RpcError(-32009, `Route already exists: ${route.routeId}`);
      await this.commit([...this.routes, route]);
      return this.get(route.routeId)!;
    });
  }
  async update(routeIdRaw: unknown, raw: Record<string, unknown>): Promise<SettingsRouteConfig> {
    return this.enqueue(async () => {
      const routeId = unwrap(parseRouteIdValue(routeIdRaw));
      const index = this.routes.findIndex((route) => route.routeId === routeId);
      if (index < 0) throw new RpcError(-32004, `Route not found: ${routeId}`);
      const next = applyPatch(this.routes[index]!, raw);
      await this.commit(this.routes.map((route, i) => i === index ? next : route));
      return this.get(routeId)!;
    });
  }
  async delete(routeIdRaw: unknown): Promise<{ deleted: string }> {
    return this.enqueue(async () => {
      const routeId = unwrap(parseRouteIdValue(routeIdRaw));
      if (!this.routes.some((route) => route.routeId === routeId)) throw new RpcError(-32004, `Route not found: ${routeId}`);
      await this.commit(this.routes.filter((route) => route.routeId !== routeId));
      return { deleted: routeId };
    });
  }
}
