// Logical AgentDefinition CLI — tent agent list|get|config (not Session lifecycle).
// Session enter|status|leave remains in baseline agent-rpc until rename integrates.

import type { ServiceClient } from "../service/client.js";
import type { AgentDefinitionProjection } from "../service/types.js";
import { attachOrBootstrapService, type CliAttachOptions } from "./service-attach.js";

export type AgentDefinitionRpcGlobalOptions = {
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

export type AgentDefinitionCommandResult = { exitCode: number; stdout: string; stderr: string };

const BANNED = new Set([
  "secret", "secrets", "token", "api-key", "api_key", "apikey", "password",
  "credential", "credentials", "env", "model", "provider", "executable",
  "base-url", "base_url", "baseurl", "command", "args", "url", "key",
]);

export async function runAgentDefinitionCommand(
  sub: string,
  args: string[],
  globals: AgentDefinitionRpcGlobalOptions = {}
): Promise<AgentDefinitionCommandResult> {
  const cmd = (sub || "").trim().toLowerCase();
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    return { exitCode: 0, stdout: agentDefinitionHelpText() + "\n", stderr: "" };
  }
  if (cmd !== "list" && cmd !== "get" && cmd !== "config") {
    return fail(`Unknown agent-definition subcommand: ${sub || "(empty)"}\n` + agentDefinitionHelpText());
  }
  try {
    const { positionals, flags } = parseFlags(args, ["json", "attach-only", "delete"]);
    const json = globals.json === true || flags.json === "true";
    for (const k of Object.keys(flags)) {
      if (BANNED.has(k.toLowerCase())) {
        return fail(`tent agent does not accept --${k}; AgentDefinition stores id/profileId only, never launch secrets`);
      }
    }
    const attach: CliAttachOptions = {
      dataDir: flags["data-dir"] || globals.dataDir,
      attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
      serviceEntry: flags["service-entry"] || globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env,
    };
    const client = globals.client ?? (await attachOrBootstrapService(attach)).client;

    if (cmd === "list") {
      if (positionals.length > 0) return fail("Usage: tent agent list [--json]");
      const result = (await client.agentList()) as { agents: AgentDefinitionProjection[] };
      const agents = (result.agents ?? []).map(whitelistAgent);
      return print({ agents }, json, () =>
        agents.length === 0
          ? "(no agents)\n"
          : agents.map((a) => {
              const pe = a.profileExists === undefined ? "" : a.profileExists ? " profile=ready" : " profile=missing";
              const label = a.displayName && a.displayName !== a.id ? ` "${a.displayName}"` : "";
              return `${a.id}${label}  profileId=${a.profileId}${pe}`;
            }).join("\n") + "\n"
      );
    }
    if (cmd === "get") {
      const id = positionals[0]?.trim();
      if (!id || positionals.length > 1) return fail("Usage: tent agent get <agentId> [--json]");
      const result = (await client.agentGet(id)) as { agent: AgentDefinitionProjection };
      const agent = whitelistAgent(result.agent);
      return print({ agent }, json, () => formatAgent(agent));
    }
    return await configAgent(client, positionals, flags, json);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function agentDefinitionHelpText(): string {
  return `tent agent — logical AgentDefinition management (machine-local)

Usage:
  tent agent list   [--json]
  tent agent get    <agentId> [--json]
  tent agent config <agentId> --profile <profileId> [--display-name <label>] [--description|--capabilities <text>] [--json]
  tent agent config <agentId> --delete --confirm <agentId> [--json]

list/get read-only. config upserts non-secret id→profileId (actor=user). --delete needs matching --confirm.
Never accepts secrets or launches a Session. Session lifecycle stays in baseline agent-rpc until rename integrates.
`;
}

async function configAgent(
  client: ServiceClient,
  positionals: string[],
  flags: Record<string, string>,
  json: boolean
): Promise<AgentDefinitionCommandResult> {
  const agentId = positionals[0]?.trim();
  if (!agentId || positionals.length > 1) {
    return fail("Usage: tent agent config <agentId> --profile <profileId> […]  |  --delete --confirm <agentId>");
  }
  const isDelete = flags.delete === "true";
  const profileId = flags.profile || flags["profile-id"] || flags.profileId;
  const hasDisplay = "display-name" in flags || "displayName" in flags;
  const hasDesc = "description" in flags || "capabilities" in flags;
  if (isDelete) {
    if (profileId || hasDisplay || hasDesc) {
      return fail("tent agent config --delete cannot combine with --profile / --display-name / --description / --capabilities");
    }
    const confirm = flags.confirm || flags.confirmation || flags["confirm-id"] || "";
    if (!confirm) return fail(`tent agent config --delete requires --confirm ${agentId}`);
    if (confirm !== agentId) return fail(`Confirmation mismatch; --confirm must equal agentId ${agentId}`);
    return print(await client.agentDelete(agentId, confirm, "user"), json, () => `Deleted AgentDefinition ${agentId}\n`);
  }
  if ("description" in flags && "capabilities" in flags) {
    return fail("tent agent config: pass only one of --description or --capabilities");
  }
  const displayNameRaw = "display-name" in flags ? flags["display-name"] : "displayName" in flags ? flags.displayName : undefined;
  const descriptionRaw = "description" in flags ? flags.description : "capabilities" in flags ? flags.capabilities : undefined;

  let existing: AgentDefinitionProjection | null = null;
  try {
    existing = ((await client.agentGet(agentId)) as { agent: AgentDefinitionProjection }).agent;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/not found/i.test(message)) throw err;
  }
  if (!existing) {
    if (!profileId) return fail("tent agent config create requires --profile <profileId> for a new agentId");
    const created = (await client.agentCreate({
      id: agentId,
      profileId,
      ...(displayNameRaw ? { displayName: displayNameRaw } : {}),
      ...(descriptionRaw ? { description: descriptionRaw } : {}),
      actor: "user",
    })) as { agent: AgentDefinitionProjection };
    const agent = whitelistAgent(created.agent);
    return print({ agent }, json, () => `Created ${formatAgent(agent)}`);
  }
  if (!profileId && displayNameRaw === undefined && descriptionRaw === undefined) {
    return fail("tent agent config update requires --profile and/or --display-name and/or --description|--capabilities (or --delete --confirm)");
  }
  const patch: { profileId?: string; displayName?: string | null; description?: string | null; actor: string } = { actor: "user" };
  if (profileId) patch.profileId = profileId;
  if (displayNameRaw !== undefined) patch.displayName = displayNameRaw === "" ? null : displayNameRaw;
  if (descriptionRaw !== undefined) patch.description = descriptionRaw === "" ? null : descriptionRaw;
  const updated = (await client.agentUpdate(agentId, patch)) as { agent: AgentDefinitionProjection };
  const agent = whitelistAgent(updated.agent);
  return print({ agent }, json, () => `Updated ${formatAgent(agent)}`);
}

function whitelistAgent(raw: AgentDefinitionProjection | Record<string, unknown>): AgentDefinitionProjection {
  const src = raw as Record<string, unknown>;
  const id = typeof src.id === "string" ? src.id : "";
  const profileId = typeof src.profileId === "string" ? src.profileId : "";
  if (!id || !profileId) throw new Error("AgentDefinition projection missing id or profileId");
  const out: AgentDefinitionProjection = {
    id,
    displayName: typeof src.displayName === "string" && src.displayName.trim() ? src.displayName : id,
    profileId,
  };
  if (typeof src.description === "string" && src.description.trim()) out.description = src.description;
  if (typeof src.profileExists === "boolean") out.profileExists = src.profileExists;
  return out;
}

function formatAgent(a: AgentDefinitionProjection): string {
  const lines = [`id: ${a.id}`, `displayName: ${a.displayName}`, `profileId: ${a.profileId}`];
  if (a.description) lines.push(`description: ${a.description}`);
  if (a.profileExists !== undefined) lines.push(`profileExists: ${a.profileExists}`);
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

function print(result: unknown, json: boolean, human: () => string): AgentDefinitionCommandResult {
  return { exitCode: 0, stdout: json ? JSON.stringify(result, null, 2) + "\n" : human(), stderr: "" };
}

function fail(msg: string): AgentDefinitionCommandResult {
  return { exitCode: 1, stdout: "", stderr: msg.trimEnd() + "\n" };
}
