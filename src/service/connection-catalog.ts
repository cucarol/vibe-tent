// In-process Agent Connection catalog. Connections are launch configuration only.

import { cloneAgentConnection, type AgentConnectionConfig } from "../runtime/agent-connection.js";
import {
  SECRET_CONNECTION_FIELD_HINTS, parseBaseUrlValue, parseLaunchSecretRefValue, parseEnvKeyValue,
  parseNonEmptyStringValue, parsePermissionPolicyValue, parsePositiveTimeoutValue, parseConnectionIdValue,
  type FieldResult,
} from "./connection-field-rules.js";
import {
  AGENT_CONNECTION_CREATE_FIELDS,
  AGENT_CONNECTION_UPDATE_FIELDS,
  saveAgentConnections,
} from "./connections.js";
import { RpcError } from "./rpc-error.js";
import { defaultAllowedSkillRoots, parseMcpServersArrayValue, parseSkillsArrayValue } from "../adapters/acp/mcp-skills.js";

export type AgentConnectionCatalogOptions = {
  persistToDisk?: boolean;
  saveConnections?: (dataDir: string, connections: AgentConnectionConfig[]) => Promise<void>;
  publishConnections?: (connections: AgentConnectionConfig[]) => void | Promise<void>;
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
    if (SECRET_CONNECTION_FIELD_HINTS.some((hint) => lower.includes(hint))) {
      throw new RpcError(-32602, `Rejected dangerous or unsupported Agent Connection field: ${key}`);
    }
    throw new RpcError(-32602, `Unknown Agent Connection field: ${key}`);
  }
}

const optional = <T>(raw: Record<string, unknown>, key: string, parse: (v: unknown) => FieldResult<T>): T | undefined =>
  !(key in raw) || raw[key] === undefined || raw[key] === null ? undefined : unwrap(parse(raw[key]));

function parseArgsValue(value: unknown): FieldResult<string[]> {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? { ok: true, value: [...value] }
    : { ok: false, message: "Invalid args: must be an array of strings" };
}

function parseCreate(raw: Record<string, unknown>): AgentConnectionConfig {
  rejectUnknownOrSecret(raw, AGENT_CONNECTION_CREATE_FIELDS);
  const connectionId = unwrap(parseConnectionIdValue(raw.connectionId));
  const provider = unwrap(parseNonEmptyStringValue(raw.provider, "provider"));
  const adapterId = unwrap(parseNonEmptyStringValue(raw.adapterId, "adapterId"));
  const connection: AgentConnectionConfig = { connectionId, provider, adapterId };
  const assign = <K extends keyof AgentConnectionConfig>(key: K, value: AgentConnectionConfig[K] | undefined) => { if (value !== undefined) connection[key] = value; };
  assign("displayName", optional(raw, "displayName", (v) => parseNonEmptyStringValue(v, "displayName")));
  assign("command", optional(raw, "command", (v) => parseNonEmptyStringValue(v, "command")));
  assign("args", optional(raw, "args", parseArgsValue));
  assign("executable", optional(raw, "executable", (v) => parseNonEmptyStringValue(v, "executable")));
  assign("model", optional(raw, "model", (v) => parseNonEmptyStringValue(v, "model")));
  assign("envKey", optional(raw, "envKey", (v) => parseEnvKeyValue(v, "envKey")));
  assign("launchSecretRef", optional(raw, "launchSecretRef", parseLaunchSecretRefValue));
  assign("baseUrlEnvKey", optional(raw, "baseUrlEnvKey", (v) => parseEnvKeyValue(v, "baseUrlEnvKey")));
  assign("baseUrl", optional(raw, "baseUrl", parseBaseUrlValue));
  assign("permissionPolicy", optional(raw, "permissionPolicy", parsePermissionPolicyValue));
  assign("promptTimeoutMs", optional(raw, "promptTimeoutMs", (v) => parsePositiveTimeoutValue(v, "promptTimeoutMs")));
  assign("permissionTimeoutMs", optional(raw, "permissionTimeoutMs", (v) => parsePositiveTimeoutValue(v, "permissionTimeoutMs")));
  if (raw.skills !== undefined && raw.skills !== null) connection.skills = unwrap(parseSkillsArrayValue(raw.skills, defaultAllowedSkillRoots()));
  if (raw.mcpServers !== undefined && raw.mcpServers !== null) connection.mcpServers = unwrap(parseMcpServersArrayValue(raw.mcpServers));
  return connection;
}

function applyPatch(current: AgentConnectionConfig, raw: Record<string, unknown>): AgentConnectionConfig {
  rejectUnknownOrSecret(raw, AGENT_CONNECTION_UPDATE_FIELDS);
  if ("connectionId" in raw || "provider" in raw || "adapterId" in raw) {
    throw new RpcError(-32602, "connectionId, provider, and adapterId are immutable; create a replacement Agent Connection instead");
  }
  const next = cloneAgentConnection(current);
  const scalar: Array<[keyof AgentConnectionConfig, (v: unknown) => FieldResult<unknown>]> = [
    ["displayName", (v) => parseNonEmptyStringValue(v, "displayName")], ["executable", (v) => parseNonEmptyStringValue(v, "executable")],
    ["model", (v) => parseNonEmptyStringValue(v, "model")], ["envKey", (v) => parseEnvKeyValue(v, "envKey")],
    ["launchSecretRef", parseLaunchSecretRefValue], ["baseUrlEnvKey", (v) => parseEnvKeyValue(v, "baseUrlEnvKey")],
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

export class AgentConnectionCatalog {
  private connections: AgentConnectionConfig[];
  private chain: Promise<void> = Promise.resolve();
  private readonly persistToDisk: boolean;
  private readonly saveConnections: (dataDir: string, connections: AgentConnectionConfig[]) => Promise<void>;
  private readonly publishConnections?: (connections: AgentConnectionConfig[]) => void | Promise<void>;

  constructor(private readonly dataDir: string, initial: AgentConnectionConfig[], options?: AgentConnectionCatalogOptions) {
    this.connections = initial.map(cloneAgentConnection);
    this.persistToDisk = options?.persistToDisk !== false;
    this.saveConnections = options?.saveConnections ?? saveAgentConnections;
    this.publishConnections = options?.publishConnections;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  list(): AgentConnectionConfig[] { return this.connections.map(cloneAgentConnection); }
  get(connectionId: string): AgentConnectionConfig | undefined {
    const connection = this.connections.find((candidate) => candidate.connectionId === connectionId);
    return connection && cloneAgentConnection(connection);
  }
  private async commit(next: AgentConnectionConfig[]): Promise<void> {
    const canonical = next.map(cloneAgentConnection);
    if (this.persistToDisk) await this.saveConnections(this.dataDir, canonical);
    await this.publishConnections?.(canonical.map(cloneAgentConnection));
    this.connections = canonical;
  }
  async create(raw: Record<string, unknown>): Promise<AgentConnectionConfig> {
    return this.enqueue(async () => {
      const connection = parseCreate(raw);
      if (this.connections.some((candidate) => candidate.connectionId === connection.connectionId)) throw new RpcError(-32009, `Agent Connection already exists: ${connection.connectionId}`);
      await this.commit([...this.connections, connection]);
      return this.get(connection.connectionId)!;
    });
  }
  async update(connectionIdRaw: unknown, raw: Record<string, unknown>): Promise<AgentConnectionConfig> {
    return this.enqueue(async () => {
      const connectionId = unwrap(parseConnectionIdValue(connectionIdRaw));
      const index = this.connections.findIndex((connection) => connection.connectionId === connectionId);
      if (index < 0) throw new RpcError(-32004, `Agent Connection not found: ${connectionId}`);
      const next = applyPatch(this.connections[index]!, raw);
      await this.commit(this.connections.map((connection, i) => i === index ? next : connection));
      return this.get(connectionId)!;
    });
  }
  async delete(connectionIdRaw: unknown): Promise<{ deleted: string }> {
    return this.enqueue(async () => {
      const connectionId = unwrap(parseConnectionIdValue(connectionIdRaw));
      if (!this.connections.some((connection) => connection.connectionId === connectionId)) throw new RpcError(-32004, `Agent Connection not found: ${connectionId}`);
      await this.commit(this.connections.filter((connection) => connection.connectionId !== connectionId));
      return { deleted: connectionId };
    });
  }
}
