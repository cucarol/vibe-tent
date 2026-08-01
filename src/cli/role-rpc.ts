// Role discovery + metadata config — tent role list|show|config (Service-backed).

import type { ServiceClient } from "../service/client.js";
import type { RoleRegistryEntryProjection } from "../service/types.js";
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

const RETIRED_ROLE_FLAGS = new Set([
  "roster",
  "roster-add",
  "roster-remove",
  "a2a-policy",
  "a2aPolicy",
]);
const COMMON_ROLE_FLAGS = new Set(["json", "attach-only", "data-dir", "service-entry", "workspace"]);
const METADATA_ROLE_FLAGS = new Set([
  "display-name",
  "displayName",
  "prompt",
  "description",
  "color",
]);

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
    for (const key of Object.keys(flags)) {
      if (RETIRED_ROLE_FLAGS.has(key)) {
        return fail(`tent role no longer accepts --${key}; roster configuration is retired`);
      }
      if (!COMMON_ROLE_FLAGS.has(key) && !METADATA_ROLE_FLAGS.has(key)) {
        return fail(`Unknown role option: --${key}`);
      }
    }
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
  return `tent role — Service-backed Role discovery and metadata configuration

Usage:
  tent role list   [--workspace <path>] [--json]
  tent role show   <name|roleId> [--workspace <path>] [--json]
  tent role config <name|roleId> [--display-name <label>] [--prompt <text>]
                   [--description <text>] [--color <value>] [--json]

list/show project Role metadata only.
config patches Role metadata via registry.role.update (actor=user).
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
    return fail("Usage: tent role config <name|roleId> [metadata options]");
  }
  const hasMeta =
    "display-name" in flags || "displayName" in flags || "prompt" in flags ||
    "description" in flags || "color" in flags;
  if (!hasMeta) {
    return fail("tent role config requires Role metadata options");
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
    actor: string;
  } = { actor: "user" };
  if (current.roleId) patch.roleId = current.roleId;

  if ("display-name" in flags) patch.displayName = flags["display-name"] === "" ? null : flags["display-name"];
  else if ("displayName" in flags) patch.displayName = flags.displayName === "" ? null : flags.displayName;
  if ("prompt" in flags) patch.prompt = flags.prompt === "" ? null : flags.prompt;
  if ("description" in flags) patch.description = flags.description === "" ? null : flags.description;
  if ("color" in flags) patch.color = flags.color === "" ? null : flags.color;

  const result = (await client.registryRoleUpdate(workspaceId, current.name, patch)) as {
    workspaceId: string;
    role: RoleRegistryEntryProjection;
  };
  const role = whitelistRole(result.role);
  return print({ workspaceId, role }, json, () => `Updated role ${role.name}\n` + formatRole(role));
}

/** Whitelist durable Role metadata. */
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
  return role;
}

function formatRole(role: RoleRegistryEntryProjection): string {
  const label = role.displayName && role.displayName !== role.name ? ` "${role.displayName}"` : "";
  const lines = [
    `${role.name}${label}${role.roleId ? ` ${role.roleId}` : ""}`,
    ...(role.description ? [`description: ${role.description}`] : []),
  ];
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
