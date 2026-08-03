// Canonical machine-local Agent Connection store. Never workspace state or an executor catalog.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
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
import { cloneAgentConnection, type AgentConnectionConfig } from "../runtime/agent-connection.js";
import type { AgentConnectionProjection } from "./types.js";
import { backupCorruptMachineFile, isNotFoundError, warnCorruptMachineState, writeJsonAtomic } from "../machine-state.js";
import {
  parseBaseUrlValue, parseCredentialRefValue, parseEnvKeyValue, parseNonEmptyStringValue,
  parsePermissionPolicyValue, parsePositiveTimeoutValue, parseConnectionIdValue, type FieldResult,
} from "./connection-field-rules.js";

export type { AgentConnectionConfig } from "../runtime/agent-connection.js";

export const AGENT_CONNECTION_CREATE_FIELDS = [
  "connectionId", "provider", "adapterId", "displayName", "command", "args", "executable", "model", "envKey",
  "credentialRef", "baseUrlEnvKey", "baseUrl", "permissionPolicy", "promptTimeoutMs",
  "permissionTimeoutMs", "skills", "mcpServers",
] as const;
export const AGENT_CONNECTION_UPDATE_FIELDS = AGENT_CONNECTION_CREATE_FIELDS.filter((field) => field !== "connectionId") as readonly string[];

const DISK_KEYS: ReadonlySet<string> = new Set(AGENT_CONNECTION_CREATE_FIELDS);

export function connectionsPath(dataDir: string): string {
  return path.join(dataDir, "connections.json");
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

function parseConnectionRow(value: unknown): AgentConnectionConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !DISK_KEYS.has(key))) return null;
  const connectionId = parseConnectionIdValue(row.connectionId);
  const provider = parseNonEmptyStringValue(row.provider, "provider");
  const adapterId = parseNonEmptyStringValue(row.adapterId, "adapterId");
  if (!connectionId.ok || !provider.ok || !adapterId.ok) return null;
  const route: AgentConnectionConfig = { connectionId: connectionId.value, provider: provider.value, adapterId: adapterId.value };
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

async function quarantineConnections(file: string): Promise<never> {
  const backup = await backupCorruptMachineFile(file);
  warnCorruptMachineState(file, backup, "ignored");
  throw new Error(
    `Agent Connections are unreadable and were quarantined: ${file}` +
      (backup ? ` (backup: ${backup})` : "")
  );
}

/** Reads only `{ connections: [...] }`; no alternate file, alias, or migration is consulted. */
export async function loadAgentConnections(dataDir: string): Promise<AgentConnectionConfig[]> {
  const file = connectionsPath(dataDir);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isNotFoundError(err)) return [];
    return quarantineConnections(file);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return quarantineConnections(file);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return quarantineConnections(file);
  }
  const connections = (parsed as { connections?: unknown }).connections;
  if (!Array.isArray(connections)) return quarantineConnections(file);
  const out: AgentConnectionConfig[] = [];
  for (const value of connections) {
    const connection = parseConnectionRow(value);
    if (!connection || out.some((existing) => existing.connectionId === connection.connectionId)) {
      return quarantineConnections(file);
    }
    out.push(connection);
  }
  return out;
}

export async function saveAgentConnections(dataDir: string, connections: AgentConnectionConfig[]): Promise<void> {
  await writeJsonAtomic(connectionsPath(dataDir), {
    connections: connections.map(cloneAgentConnection),
  });
}

export function defaultAgentConnections(): AgentConnectionConfig[] {
  const route = (connectionId: string, provider: string, adapterId: string, extra: Partial<AgentConnectionConfig> = {}): AgentConnectionConfig => ({
    connectionId, provider, adapterId, permissionPolicy: "deny", ...extra,
  });
  return [
    route("grok-acp-default", "grok", GROK_ACP_ADAPTER_ID, { model: DEFAULT_GROK_MODEL, envKey: DEFAULT_GROK_ENV_KEY, baseUrlEnvKey: DEFAULT_GROK_BASE_URL_ENV_KEY }),
    route("codex-acp-default", "codex", CODEX_ACP_ADAPTER_ID),
    route("claude-acp-default", "claude", CLAUDE_ACP_ADAPTER_ID),
    route("opencode-acp-default", "opencode", OPENCODE_ACP_ADAPTER_ID),
    route("copilot-acp-default", "copilot", COPILOT_ACP_ADAPTER_ID),
    route("pi-acp-default", "pi", PI_ACP_ADAPTER_ID),
  ];
}

export async function ensureDefaultAgentConnections(dataDir: string): Promise<AgentConnectionConfig[]> {
  const file = connectionsPath(dataDir);
  try {
    await fs.access(file);
    return loadAgentConnections(dataDir);
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
  const defaults = defaultAgentConnections();
  await saveAgentConnections(dataDir, defaults);
  return defaults;
}

/** Safe client projection; credential values and raw environment values never cross this boundary. */
export function projectAgentConnection(
  connection: AgentConnectionConfig,
  opts?: { credentialExists?: boolean }
): AgentConnectionProjection {
  const credentialRef = connection.credentialRef?.trim() || undefined;
  const skills = projectSkillRefs(connection.skills);
  const mcpServers = projectMcpServers(connection.mcpServers);
  return {
    connectionId: connection.connectionId,
    provider: connection.provider,
    adapterId: connection.adapterId,
    displayName: connection.displayName?.trim() || connection.connectionId,
    ...(connection.command ? { command: connection.command } : {}),
    ...(connection.args ? { args: [...connection.args] } : {}),
    ...(connection.model ? { model: connection.model } : {}),
    ...(connection.executable ? { executable: connection.executable } : {}),
    ...(connection.envKey ? { envKey: connection.envKey } : {}),
    ...(credentialRef ? { credentialRef } : {}),
    ...(credentialRef && opts?.credentialExists !== undefined
      ? { credentialExists: opts.credentialExists }
      : {}),
    ...(connection.baseUrlEnvKey ? { baseUrlEnvKey: connection.baseUrlEnvKey } : {}),
    ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
    ...(connection.permissionPolicy ? { permissionPolicy: connection.permissionPolicy } : {}),
    ...(connection.promptTimeoutMs !== undefined ? { promptTimeoutMs: connection.promptTimeoutMs } : {}),
    ...(connection.permissionTimeoutMs !== undefined
      ? { permissionTimeoutMs: connection.permissionTimeoutMs }
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

export function projectAgentConnections(
  connections: AgentConnectionConfig[],
  opts?: { credentialExistsById?: ReadonlyMap<string, boolean> | Record<string, boolean> }
): AgentConnectionProjection[] {
  const lookup = (ref: string | undefined): boolean | undefined => {
    if (!ref || !opts?.credentialExistsById) return undefined;
    return opts.credentialExistsById instanceof Map
      ? opts.credentialExistsById.get(ref)
      : (opts.credentialExistsById as Record<string, boolean>)[ref];
  };
  return connections
    .map((connection) => {
      const exists = lookup(connection.credentialRef?.trim());
      return projectAgentConnection(
        connection,
        exists === undefined ? undefined : { credentialExists: exists }
      );
    })
    .sort((a, b) => a.connectionId.localeCompare(b.connectionId));
}
