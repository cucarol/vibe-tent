// Machine-local AgentDefinition catalog (V0.2 logical worker identity).
// Lives only in the service data area — never workspace git / concept bodies.
// AgentDefinition binds agentId → profileId only (no provider/model/credential/key).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";
import {
  fieldErr,
  fieldOk,
  parseNonEmptyStringValue,
  parseProfileIdValue,
  type FieldResult,
} from "./profile-field-rules.js";

/** Same id shape as AgentProfile ids (stable logical handle, not a secret). */
export const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Stable logical worker / capability identity exposed to Role configuration.
 * Never stores provider, model, API key, or credential material.
 */
export type AgentDefinition = {
  /** Stable agentId (Role roster membership key). */
  id: string;
  /** Optional human label for pickers. */
  displayName?: string;
  /** Optional one-line capability note. */
  description?: string;
  /**
   * Machine-local AgentProfile id used for provider/model/credential/launch.
   * Resolution only — not Role authorization.
   */
  profileId: string;
};

export type AgentDefinitionProjection = {
  id: string;
  displayName: string;
  description?: string;
  profileId: string;
  /** true when bound profile exists in the local catalog (no secrets). */
  profileExists?: boolean;
};

export type AgentDefinitionsFile = {
  agents: AgentDefinition[];
};

export function agentDefinitionsPath(dataDir: string): string {
  return path.join(dataDir, "agent-definitions.json");
}

export function parseAgentIdValue(raw: unknown, field = "id"): FieldResult<string> {
  if (typeof raw !== "string" || !raw.trim()) {
    return fieldErr(`Missing or invalid string param: ${field}`);
  }
  const id = raw.trim();
  if (!AGENT_ID_RE.test(id)) {
    return fieldErr(
      `Invalid agent id: must match ${AGENT_ID_RE} (lowercase letter, then a-z0-9-, max 63)`
    );
  }
  return fieldOk(id);
}

export function normalizeAgentDefinition(
  value: Partial<AgentDefinition> | Record<string, unknown>
): AgentDefinition {
  const idR = parseAgentIdValue(value.id, "id");
  if (!idR.ok) throw new Error(idR.message);
  const profileR = parseProfileIdValue(value.profileId, "profileId");
  if (!profileR.ok) throw new Error(profileR.message);

  const agent: AgentDefinition = {
    id: idR.value,
    profileId: profileR.value,
  };
  if (typeof value.displayName === "string" && value.displayName.trim()) {
    agent.displayName = value.displayName.trim();
  }
  if (typeof value.description === "string" && value.description.trim()) {
    agent.description = value.description.trim();
  }
  return agent;
}

export function projectAgentDefinition(
  agent: AgentDefinition,
  opts?: { profileExists?: boolean }
): AgentDefinitionProjection {
  const proj: AgentDefinitionProjection = {
    id: agent.id,
    displayName: agent.displayName?.trim() || agent.id,
    profileId: agent.profileId,
  };
  if (agent.description) proj.description = agent.description;
  if (opts?.profileExists !== undefined) proj.profileExists = opts.profileExists;
  return proj;
}

/**
 * Load machine-local agent definitions.
 * Missing file → empty catalog (no seed invent). Corrupt → quarantine + empty.
 */
export async function loadAgentDefinitions(
  dataDir: string
): Promise<{ agents: AgentDefinition[]; recovered: boolean }> {
  const file = agentDefinitionsPath(dataDir);
  try {
    const raw = await fs.readFile(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const backupPath = await backupCorruptMachineFile(file);
      warnCorruptMachineState(file, backupPath, "reset", "agent-definitions.json");
      await writeJsonAtomic(file, { agents: [] } satisfies AgentDefinitionsFile);
      return { agents: [], recovered: true };
    }
    const agents = normalizeAgentDefinitionsFile(parsed);
    return { agents, recovered: false };
  } catch (err) {
    if (isNotFoundError(err)) return { agents: [], recovered: false };
    throw err;
  }
}

export async function saveAgentDefinitions(
  dataDir: string,
  agents: readonly AgentDefinition[]
): Promise<void> {
  const file = agentDefinitionsPath(dataDir);
  const normalized = agents.map((a) => normalizeAgentDefinition(a));
  // Stable order for deterministic disk.
  normalized.sort((a, b) => a.id.localeCompare(b.id));
  await writeJsonAtomic(file, { agents: normalized } satisfies AgentDefinitionsFile);
}

function normalizeAgentDefinitionsFile(value: unknown): AgentDefinition[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("agent-definitions.json must be an object with agents[]");
  }
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.agents)) {
    throw new Error("agent-definitions.json must contain agents array");
  }
  const out: AgentDefinition[] = [];
  const seen = new Set<string>();
  for (const item of root.agents) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("agent-definitions.json agents[] entries must be objects");
    }
    const agent = normalizeAgentDefinition(item as Record<string, unknown>);
    if (seen.has(agent.id)) {
      throw new Error(`Duplicate agent id in agent-definitions.json: ${agent.id}`);
    }
    seen.add(agent.id);
    out.push(agent);
  }
  return out;
}

/**
 * Ensure AgentDefinitions exist for legacy profile ids (one-time migration helper).
 * agentId defaults to profileId (deterministic 1:1). Existing agentIds are kept.
 * Returns whether any row was added.
 */
export function ensureAgentDefinitionsForProfileIds(
  agents: AgentDefinition[],
  profileIds: readonly string[]
): { agents: AgentDefinition[]; added: boolean } {
  const byId = new Map(agents.map((a) => [a.id, a]));
  let added = false;
  for (const raw of profileIds) {
    const idR = parseAgentIdValue(raw, "profileId");
    if (!idR.ok) continue;
    const id = idR.value;
    if (byId.has(id)) continue;
    const next: AgentDefinition = { id, profileId: id, displayName: id };
    byId.set(id, next);
    added = true;
  }
  const nextAgents = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { agents: nextAgents, added };
}

export function findAgentDefinition(
  agents: readonly AgentDefinition[],
  agentId: string
): AgentDefinition | undefined {
  const key = typeof agentId === "string" ? agentId.trim() : "";
  if (!key) return undefined;
  return agents.find((a) => a.id === key);
}

/**
 * Resolve launch profileId from agentId. Fails loud when missing or unbound.
 */
export function resolveProfileIdForAgent(
  agents: readonly AgentDefinition[],
  agentId: string
): string {
  const agent = findAgentDefinition(agents, agentId);
  if (!agent) {
    throw new Error(`AgentDefinition not found: ${agentId}`);
  }
  const profileId = agent.profileId?.trim();
  if (!profileId) {
    throw new Error(`AgentDefinition ${agentId} has no profileId binding`);
  }
  return profileId;
}

/**
 * When a role caller only has profileId (legacy path), find a roster agent bound to it.
 * Prefer agentId === profileId; otherwise the sole roster member with that profileId.
 * Fails loud when zero or ambiguous.
 */
export function resolveAgentIdForProfileOnRoster(
  agents: readonly AgentDefinition[],
  roster: readonly string[] | undefined,
  profileId: string
): string {
  const pid = profileId.trim();
  if (!pid) throw new Error("profileId cannot be empty");
  const allowed = new Set((roster ?? []).map((id) => id.trim()).filter(Boolean));
  if (allowed.size === 0) {
    throw new Error(`No roster agents authorized for profile ${pid}`);
  }
  if (allowed.has(pid) && findAgentDefinition(agents, pid)?.profileId === pid) {
    return pid;
  }
  const matches = [...allowed].filter((agentId) => {
    const def = findAgentDefinition(agents, agentId);
    return def?.profileId === pid;
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new Error(
      `No AgentDefinition on roster binds profileId ${pid}; dispatch by agentId or bind an agent`
    );
  }
  throw new Error(
    `Ambiguous roster agents for profileId ${pid}: ${matches.sort().join(", ")}`
  );
}

export function parseAgentDefinitionParams(
  p: Record<string, unknown>,
  opts: { requireId?: boolean; forUpdate?: boolean } = {}
): Partial<AgentDefinition> & { id?: string; profileId?: string } {
  for (const banned of [
    "secret",
    "secrets",
    "token",
    "apiKey",
    "api_key",
    "password",
    "credential",
    "credentials",
    "env",
    "model",
    "provider",
    "executable",
    "baseUrl",
    "command",
    "args",
  ]) {
    if (banned in p) {
      throw new Error(
        `agent.* does not accept ${banned}; AgentDefinition stores id/profileId only, never launch secrets`
      );
    }
  }

  const out: Partial<AgentDefinition> & { id?: string; profileId?: string } = {};
  if (opts.requireId || typeof p.id === "string") {
    const idR = parseAgentIdValue(p.id, "id");
    if (!idR.ok) throw new Error(idR.message);
    out.id = idR.value;
  } else if (!opts.forUpdate) {
    throw new Error("Missing string param: id");
  }

  if ("profileId" in p || opts.requireId) {
    if (!("profileId" in p) && opts.requireId) {
      throw new Error("Missing string param: profileId");
    }
    if ("profileId" in p) {
      const pr = parseProfileIdValue(p.profileId, "profileId");
      if (!pr.ok) throw new Error(pr.message);
      out.profileId = pr.value;
    }
  }

  if ("displayName" in p) {
    if (p.displayName !== undefined && p.displayName !== null && typeof p.displayName !== "string") {
      throw new Error("Invalid string param: displayName");
    }
    if (typeof p.displayName === "string") {
      const dn = parseNonEmptyStringValue(p.displayName, "displayName");
      if (dn.ok) out.displayName = dn.value;
      else if (p.displayName.trim() === "") out.displayName = undefined;
      else throw new Error(dn.message);
    }
  }
  if ("description" in p) {
    if (p.description !== undefined && p.description !== null && typeof p.description !== "string") {
      throw new Error("Invalid string param: description");
    }
    if (typeof p.description === "string") {
      const d = p.description.trim();
      out.description = d || undefined;
    }
  }
  return out;
}
