// Role discovery + roster config — tent role list|show|config (Service-backed).

import type { ServiceClient } from "../service/client.js";
import {
  ROLE_ROSTER_READINESS,
  type RoleRegistryEntryProjection,
  type RoleRosterEntryProjection,
  type RoleRosterReadiness,
} from "../service/types.js";
import { attachOrBootstrapService, type CliAttachOptions } from "./service-attach.js";
import { ensureMountedWorkspace } from "./workspace-context.js";

export type RoleRpcGlobalOptions = {
  workspace?: string;
  cwd?: string;
  dataDir?: string;
  attachOnly?: boolean;
  serviceEntry?: string;
  packageRoot?: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  client?: ServiceClient;
};

export type RoleCommandResult = { exitCode: number; stdout: string; stderr: string };

const READINESS = new Set<string>(ROLE_ROSTER_READINESS);

export async function runRoleCommand(
  sub: string,
  args: string[],
  globals: RoleRpcGlobalOptions = {}
): Promise<RoleCommandResult> {
  const cmd = (sub || "").trim().toLowerCase();
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    return { exitCode: 0, stdout: roleHelpText() + "\n", stderr: "" };
  }
  if (cmd !== "list" && cmd !== "show" && cmd !== "config") {
    return fail(`Unknown role subcommand: ${sub || "(empty)"}\n` + roleHelpText());
  }
  try {
    const { positionals, flags } = parseFlags(args, ["json", "attach-only"]);
    const json = globals.json === true || flags.json === "true";
    const attach: CliAttachOptions = {
      dataDir: flags["data-dir"] || globals.dataDir,
      attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
      serviceEntry: flags["service-entry"] || globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env,
    };
    const client = globals.client ?? (await attachOrBootstrapService(attach)).client;
    const { workspaceId } = await ensureMountedWorkspace(client, {
      cwd: globals.cwd,
      workspace: flags.workspace || globals.workspace,
    });

    if (cmd === "list") {
      if (positionals.length > 0) return fail("Usage: tent role list [--workspace <path>] [--json]");
      const result = (await client.registryRoles(workspaceId)) as { roles: RoleRegistryEntryProjection[] };
      const roles = (result.roles ?? []).map(whitelistRole);
      return print({ workspaceId, roles }, json, () => (roles.length ? roles.map(formatRole).join("") : "(no roles)\n"));
    }
    if (cmd === "show") {
      const ref = positionals[0]?.trim();
      if (!ref || positionals.length > 1) return fail("Usage: tent role show <name|roleId> [--workspace <path>] [--json]");
      const result = (await client.registryRoles(workspaceId)) as { roles: RoleRegistryEntryProjection[] };
      const found = (result.roles ?? []).find((r) => r.name === ref || r.roleId === ref);
      if (!found) return fail(`Role not found: ${ref}`);
      const role = whitelistRole(found);
      return print({ workspaceId, role }, json, () => formatRole(role));
    }
    return await configRole(client, workspaceId, positionals, flags, json);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function roleHelpText(): string {
  return `tent role — Service-backed Role discovery and roster configuration

Usage:
  tent role list   [--workspace <path>] [--json]
  tent role show   <name|roleId> [--workspace <path>] [--json]
  tent role config <name|roleId> (--roster-add <agentId> | --roster-remove <agentId> | --roster <id,id>)
                   [--display-name <label>] [--prompt <text>] [--description <text>] [--a2a-policy allow|ask|deny] [--json]

list/show project rosterEntries in roster order with readiness ready|missing-definition|missing-profile (no secrets).
config patches roster by agentId via registry.role.update (actor=user); never invents AgentDefinitions.
`;
}

async function configRole(
  client: ServiceClient,
  workspaceId: string,
  positionals: string[],
  flags: Record<string, string>,
  json: boolean
): Promise<RoleCommandResult> {
  const ref = positionals[0]?.trim();
  if (!ref || positionals.length > 1) {
    return fail("Usage: tent role config <name|roleId> (--roster-add|--roster-remove|--roster) …");
  }
  const hasAdd = "roster-add" in flags;
  const hasRemove = "roster-remove" in flags;
  const hasSet = "roster" in flags;
  if (hasSet && (hasAdd || hasRemove)) {
    return fail("tent role config: --roster cannot combine with --roster-add / --roster-remove");
  }
  if (hasAdd && hasRemove) {
    const addId = (flags["roster-add"] || "").trim();
    const removeId = (flags["roster-remove"] || "").trim();
    if (addId && removeId && addId === removeId) {
      return fail(`tent role config: conflicting --roster-add and --roster-remove for same agentId ${addId}`);
    }
  }
  const hasMeta =
    "display-name" in flags || "displayName" in flags || "prompt" in flags ||
    "description" in flags || "a2a-policy" in flags || "a2aPolicy" in flags || "color" in flags;
  if (!hasAdd && !hasRemove && !hasSet && !hasMeta) {
    return fail("tent role config requires --roster-add / --roster-remove / --roster and/or metadata flags");
  }

  const listed = (await client.registryRoles(workspaceId)) as { roles: RoleRegistryEntryProjection[] };
  const current = (listed.roles ?? []).find((r) => r.name === ref || r.roleId === ref);
  if (!current) return fail(`Role not found: ${ref}`);

  const patch: {
    roleId?: string;
    displayName?: string | null;
    prompt?: string | null;
    description?: string | null;
    color?: string | null;
    a2aPolicy?: "allow" | "ask" | "deny" | null;
    roster?: string[] | null;
    actor: string;
  } = { actor: "user" };
  if (current.roleId) patch.roleId = current.roleId;

  if (hasSet) {
    patch.roster = [...new Set((flags.roster || "").split(",").map((s) => s.trim()).filter(Boolean))];
  } else if (hasAdd || hasRemove) {
    let roster = [...(current.roster ?? [])];
    if (hasRemove) {
      const removeId = (flags["roster-remove"] || "").trim();
      if (!removeId) return fail("tent role config --roster-remove requires <agentId>");
      roster = roster.filter((id) => id !== removeId);
    }
    if (hasAdd) {
      const addId = (flags["roster-add"] || "").trim();
      if (!addId) return fail("tent role config --roster-add requires <agentId>");
      if (!roster.includes(addId)) roster.push(addId);
    }
    patch.roster = roster;
  }

  if ("display-name" in flags) patch.displayName = flags["display-name"] === "" ? null : flags["display-name"];
  else if ("displayName" in flags) patch.displayName = flags.displayName === "" ? null : flags.displayName;
  if ("prompt" in flags) patch.prompt = flags.prompt === "" ? null : flags.prompt;
  if ("description" in flags) patch.description = flags.description === "" ? null : flags.description;
  if ("color" in flags) patch.color = flags.color === "" ? null : flags.color;
  if ("a2a-policy" in flags || "a2aPolicy" in flags) {
    const raw = flags["a2a-policy"] ?? flags.a2aPolicy ?? "";
    if (raw === "" || raw === "null") patch.a2aPolicy = null;
    else if (raw === "allow" || raw === "ask" || raw === "deny") patch.a2aPolicy = raw;
    else return fail(`tent role config --a2a-policy must be allow|ask|deny (got ${raw})`);
  }

  const result = (await client.registryRoleUpdate(workspaceId, current.name, patch)) as {
    workspaceId: string;
    role: RoleRegistryEntryProjection;
  };
  const role = whitelistRole(result.role);
  return print({ workspaceId, role }, json, () => `Updated role ${role.name}\n` + formatRole(role));
}

/** Whitelist Role projection; preserve roster order; validate readiness. */
function whitelistRole(raw: RoleRegistryEntryProjection | Record<string, unknown>): RoleRegistryEntryProjection {
  const src = raw as Record<string, unknown>;
  const name = typeof src.name === "string" ? src.name : "";
  if (!name) throw new Error("Role projection missing name");
  const role: RoleRegistryEntryProjection = {
    roleId: typeof src.roleId === "string" ? src.roleId : "",
    name,
    displayName: typeof src.displayName === "string" && src.displayName.trim() ? src.displayName : name,
  };
  if (typeof src.description === "string") role.description = src.description;
  if (typeof src.color === "string") role.color = src.color;
  if (typeof src.prompt === "string") role.prompt = src.prompt;
  if (src.a2aPolicy === "allow" || src.a2aPolicy === "ask" || src.a2aPolicy === "deny") role.a2aPolicy = src.a2aPolicy;
  if (Array.isArray(src.roster)) role.roster = src.roster.filter((id): id is string => typeof id === "string");
  if (Array.isArray(src.rosterEntries)) {
    const entries = src.rosterEntries.map((e, i) => whitelistRosterEntry(e, i));
    if (role.roster?.length) {
      const byId = new Map(entries.map((e) => [e.agentId, e] as const));
      role.rosterEntries = role.roster.map(
        (id) => byId.get(id) ?? { agentId: id, readiness: "missing-definition" as const }
      );
    } else {
      role.rosterEntries = entries;
    }
  }
  return role;
}

function whitelistRosterEntry(raw: unknown, index: number): RoleRosterEntryProjection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid rosterEntries[${index}] from Service`);
  }
  const src = raw as Record<string, unknown>;
  const agentId = typeof src.agentId === "string" ? src.agentId : "";
  if (!agentId) throw new Error(`rosterEntries[${index}] missing agentId`);
  if (typeof src.readiness !== "string" || !READINESS.has(src.readiness)) {
    throw new Error(
      `Invalid readiness for agentId ${agentId}: ${String(src.readiness)} (expected ${ROLE_ROSTER_READINESS.join("|")})`
    );
  }
  const entry: RoleRosterEntryProjection = { agentId, readiness: src.readiness as RoleRosterReadiness };
  if (typeof src.displayName === "string" && src.displayName.trim()) entry.displayName = src.displayName;
  if (typeof src.profileId === "string" && src.profileId.trim()) entry.profileId = src.profileId;
  return entry;
}

function formatRole(role: RoleRegistryEntryProjection): string {
  const label = role.displayName && role.displayName !== role.name ? ` "${role.displayName}"` : "";
  const lines = [
    `${role.name}${label}${role.roleId ? ` ${role.roleId}` : ""}`,
    ...(role.description ? [`description: ${role.description}`] : []),
    ...(role.a2aPolicy ? [`a2aPolicy: ${role.a2aPolicy}`] : []),
    `roster: ${(role.roster ?? []).length}`,
  ];
  if (role.rosterEntries?.length) {
    for (const e of role.rosterEntries) {
      const el = e.displayName && e.displayName !== e.agentId ? ` "${e.displayName}"` : "";
      const pf = e.profileId ? ` profileId=${e.profileId}` : "";
      lines.push(`  - ${e.agentId}${el}  readiness=${e.readiness}${pf}`);
    }
  } else if (role.roster?.length) {
    for (const id of role.roster) lines.push(`  - ${id}`);
  } else {
    lines.push("  (empty roster)");
  }
  return lines.join("\n") + "\n";
}

function parseFlags(args: string[], booleans: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const bool = new Set(booleans);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { positionals.push(...args.slice(i + 1)); break; }
    if (!a.startsWith("--")) { positionals.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    if (bool.has(key)) { flags[key] = "true"; continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = "true";
  }
  return { positionals, flags };
}

function print(result: unknown, json: boolean, human: () => string): RoleCommandResult {
  return { exitCode: 0, stdout: json ? JSON.stringify(result, null, 2) + "\n" : human(), stderr: "" };
}

function fail(msg: string): RoleCommandResult {
  return { exitCode: 1, stdout: "", stderr: msg.trimEnd() + "\n" };
}
