/**
 * Focused fake-client tests: agent-definition-rpc + role-rpc (cx-b9bf58).
 * Covers list/get/config, roster readiness/order, exact RPC payloads,
 * actor=user, and secret-whitelist negatives. No Session / agent-rpc edits.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  agentDefinitionHelpText,
  runAgentDefinitionCommand,
} from "../src/cli/agent-definition-rpc.js";
import { roleHelpText, runRoleCommand } from "../src/cli/role-rpc.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import type { ServiceClient } from "../src/service/client.js";
import type {
  AgentDefinitionProjection,
  RoleRegistryEntryProjection,
} from "../src/service/types.js";

type Call = { method: string; args: unknown[] };
type State = {
  agents: Map<string, AgentDefinitionProjection>;
  roles: RoleRegistryEntryProjection[];
};

function fake(state: State): { client: ServiceClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    agentList: async () => {
      calls.push({ method: "agent.list", args: [] });
      return { agents: [...state.agents.values()].sort((a, b) => a.id.localeCompare(b.id)) };
    },
    agentGet: async (id: string) => {
      calls.push({ method: "agent.get", args: [id] });
      const agent = state.agents.get(id);
      if (!agent) throw Object.assign(new Error(`AgentDefinition not found: ${id}`), { code: -32004 });
      return { agent: { ...agent, apiKey: "leak", secret: "nope" } };
    },
    agentCreate: async (agent: {
      id: string;
      profileId: string;
      displayName?: string;
      description?: string;
      actor?: string;
    }) => {
      calls.push({ method: "agent.create", args: [agent] });
      const row: AgentDefinitionProjection = {
        id: agent.id,
        profileId: agent.profileId,
        displayName: agent.displayName?.trim() || agent.id,
        ...(agent.description ? { description: agent.description } : {}),
        profileExists: true,
      };
      state.agents.set(agent.id, row);
      return { agent: row };
    },
    agentUpdate: async (
      id: string,
      patch: {
        profileId?: string;
        displayName?: string | null;
        description?: string | null;
        actor?: string;
      }
    ) => {
      calls.push({ method: "agent.update", args: [id, patch] });
      const cur = state.agents.get(id);
      if (!cur) throw new Error(`AgentDefinition not found: ${id}`);
      const next: AgentDefinitionProjection = { ...cur, profileId: patch.profileId ?? cur.profileId };
      if ("displayName" in patch) {
        next.displayName = patch.displayName ? patch.displayName : id;
      }
      if ("description" in patch) {
        if (!patch.description) delete next.description;
        else next.description = patch.description;
      }
      state.agents.set(id, next);
      return { agent: next };
    },
    agentDelete: async (id: string, confirmation: string, actor = "user") => {
      calls.push({ method: "agent.delete", args: [id, confirmation, actor] });
      if (confirmation !== id) throw new Error(`Confirmation mismatch; enter the agent id ${id}.`);
      if (!state.agents.has(id)) throw new Error(`AgentDefinition not found: ${id}`);
      state.agents.delete(id);
      return { id, deleted: true };
    },
    registryRoles: async (workspaceId: string) => {
      calls.push({ method: "registry.roles", args: [workspaceId] });
      return { workspaceId, roles: structuredClone(state.roles) };
    },
    registryRoleUpdate: async (
      workspaceId: string,
      name: string,
      patch: Record<string, unknown>
    ) => {
      calls.push({ method: "registry.role.update", args: [workspaceId, name, patch] });
      const i = state.roles.findIndex((r) => r.name === name);
      if (i < 0) throw new Error(`Role does not exist: ${name}`);
      const cur = state.roles[i]!;
      const next: RoleRegistryEntryProjection = { ...cur };
      if ("roster" in patch && Array.isArray(patch.roster)) {
        const roster = patch.roster as string[];
        next.roster = roster;
        next.rosterEntries = roster.map((agentId) => {
          const prior = cur.rosterEntries?.find((e) => e.agentId === agentId);
          return prior ? { ...prior } : { agentId, readiness: "missing-definition" as const };
        });
      }
      state.roles[i] = next;
      return { workspaceId, role: structuredClone(next) };
    },
    listWorkspaces: async () => {
      calls.push({ method: "workspace.list", args: [] });
      return { workspaces: [] };
    },
    mount: async (workspaceRoot: string) => {
      calls.push({ method: "workspace.mount", args: [workspaceRoot] });
      return { workspaceId: "ws-fake", workspaceRoot, systemRoot: workspaceRoot + "/.tent" };
    },
  } as unknown as ServiceClient;
  return { client, calls };
}

async function roleGlobals(client: ServiceClient) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-cli-"));
  await scaffoldInWorkspace(new NodeFs(ws), {
    name: "role-cli-fake",
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  return { client, cwd: ws, workspace: ws };
}

const SECRET_RE = /apiKey|should-never-leak|secret|credential|token/i;

test("agent-definition list/get/config + role list/show/config contracts", async () => {
  assert.match(agentDefinitionHelpText(), /tent agent list/);
  assert.match(agentDefinitionHelpText(), /tent agent config/);
  assert.match(roleHelpText(), /roster-add/);
  assert.match(roleHelpText(), /ready\|missing-definition\|missing-profile/);

  // --- agent list/get: read-only, whitelist (no secrets) ---
  const agents = new Map<string, AgentDefinitionProjection>([
    ["worker-b", { id: "worker-b", displayName: "Worker B", profileId: "prof-b", profileExists: false }],
    ["worker-a", { id: "worker-a", displayName: "worker-a", profileId: "prof-a", profileExists: true }],
    [
      "coder",
      {
        id: "coder",
        displayName: "Coder",
        description: "writes code",
        profileId: "local-coder",
        profileExists: true,
      },
    ],
  ]);
  const state: State = { agents, roles: [] };
  const { client, calls } = fake(state);
  const beforeAgents = structuredClone([...agents.entries()]);

  const list = await runAgentDefinitionCommand("list", ["--json"], { client });
  assert.equal(list.exitCode, 0, list.stderr);
  const listed = JSON.parse(list.stdout) as { agents: AgentDefinitionProjection[] };
  assert.deepEqual(
    listed.agents.map((a) => a.id),
    ["coder", "worker-a", "worker-b"]
  );
  for (const a of listed.agents) {
    assert.equal("apiKey" in a, false);
    assert.equal("secret" in a, false);
  }
  assert.deepEqual(
    calls.map((c) => c.method),
    ["agent.list"]
  );
  assert.deepEqual([...state.agents.entries()], beforeAgents);

  const getJson = await runAgentDefinitionCommand("get", ["coder", "--json"], { client });
  assert.equal(getJson.exitCode, 0, getJson.stderr);
  assert.doesNotMatch(getJson.stdout, SECRET_RE);
  assert.equal(JSON.parse(getJson.stdout).agent.profileId, "local-coder");
  const getText = await runAgentDefinitionCommand("get", ["coder"], { client });
  assert.doesNotMatch(getText.stdout, SECRET_RE);

  const missing = await runAgentDefinitionCommand("get", [], { client });
  assert.equal(missing.exitCode, 1);

  // --- agent config: exact payloads + actor=user + secret/confirm negatives ---
  calls.length = 0;
  const create = await runAgentDefinitionCommand(
    "config",
    [
      "my-agent",
      "--profile",
      "prof-1",
      "--display-name",
      "My Agent",
      "--description",
      "does work",
      "--json",
    ],
    { client }
  );
  assert.equal(create.exitCode, 0, create.stderr);
  assert.equal(calls[0]?.method, "agent.get");
  assert.equal(calls[1]?.method, "agent.create");
  assert.deepEqual(calls[1]!.args[0], {
    id: "my-agent",
    profileId: "prof-1",
    displayName: "My Agent",
    description: "does work",
    actor: "user",
  });

  calls.length = 0;
  const update = await runAgentDefinitionCommand(
    "config",
    ["my-agent", "--profile", "prof-new", "--capabilities", "fast", "--json"],
    { client }
  );
  assert.equal(update.exitCode, 0, update.stderr);
  assert.equal(calls[1]?.method, "agent.update");
  assert.deepEqual(calls[1]!.args[1], {
    profileId: "prof-new",
    description: "fast",
    actor: "user",
  });

  assert.equal(
    (await runAgentDefinitionCommand("config", ["doomed", "--delete"], { client })).exitCode,
    1
  );
  assert.equal(
    (
      await runAgentDefinitionCommand("config", ["my-agent", "--delete", "--confirm", "other"], {
        client,
      })
    ).exitCode,
    1
  );
  assert.equal(
    (
      await runAgentDefinitionCommand(
        "config",
        ["x", "--profile", "p", "--api-key", "sk"],
        { client }
      )
    ).exitCode,
    1
  );
  calls.length = 0;
  const del = await runAgentDefinitionCommand(
    "config",
    ["my-agent", "--delete", "--confirm", "my-agent", "--json"],
    { client }
  );
  assert.equal(del.exitCode, 0, del.stderr);
  assert.deepEqual(calls[0], { method: "agent.delete", args: ["my-agent", "my-agent", "user"] });

  // --- role list/show: readiness order, no mutation, no secrets ---
  state.roles = [
    {
      roleId: "rl-planner",
      name: "规划",
      displayName: "Planner",
      prompt: "plan",
      a2aPolicy: "ask",
      roster: ["first-agent", "second-agent", "third-agent"],
      rosterEntries: [
        { agentId: "first-agent", displayName: "First", profileId: "prof-1", readiness: "ready" },
        { agentId: "second-agent", readiness: "missing-definition" },
        {
          agentId: "third-agent",
          displayName: "Third",
          profileId: "ghost",
          readiness: "missing-profile",
        },
      ],
    },
    { roleId: "rl-empty", name: "empty-role", displayName: "empty-role" },
  ];
  const snap = structuredClone(state.roles);
  const g = await roleGlobals(client);
  calls.length = 0;

  const roleList = await runRoleCommand("list", ["--json"], g);
  assert.equal(roleList.exitCode, 0, roleList.stderr);
  const planner = (
    JSON.parse(roleList.stdout) as { roles: RoleRegistryEntryProjection[] }
  ).roles.find((r) => r.name === "规划")!;
  assert.deepEqual(
    planner.rosterEntries?.map((e) => [e.agentId, e.readiness]),
    [
      ["first-agent", "ready"],
      ["second-agent", "missing-definition"],
      ["third-agent", "missing-profile"],
    ]
  );
  assert.doesNotMatch(roleList.stdout, SECRET_RE);
  assert.ok(calls.some((c) => c.method === "registry.roles"));
  assert.ok(!calls.some((c) => c.method === "registry.role.update"));
  assert.deepEqual(state.roles, snap);

  const show = await runRoleCommand("show", ["规划", "--json"], g);
  assert.equal(show.exitCode, 0, show.stderr);
  assert.deepEqual(
    (JSON.parse(show.stdout) as { role: RoleRegistryEntryProjection }).role.rosterEntries?.map(
      (e) => e.readiness
    ),
    ["ready", "missing-definition", "missing-profile"]
  );

  // invalid readiness fails loud
  state.roles = [
    {
      roleId: "rl-bad",
      name: "bad",
      displayName: "bad",
      roster: ["x"],
      // @ts-expect-error intentional
      rosterEntries: [{ agentId: "x", readiness: "offline" }],
    },
  ];
  assert.equal((await runRoleCommand("show", ["bad"], g)).exitCode, 1);
  assert.equal((await runRoleCommand("show", ["nope"], g)).exitCode, 1);

  // --- role config: exact roster add/remove payloads + actor=user ---
  state.roles = [
    {
      roleId: "rl-exec",
      name: "executor",
      displayName: "Executor",
      roster: ["alpha", "beta"],
      rosterEntries: [
        { agentId: "alpha", readiness: "ready", profileId: "p-a" },
        { agentId: "beta", readiness: "missing-profile", profileId: "p-b" },
      ],
    },
  ];
  calls.length = 0;
  const add = await runRoleCommand("config", ["executor", "--roster-add", "gamma", "--json"], g);
  assert.equal(add.exitCode, 0, add.stderr);
  const addPatch = calls.find((c) => c.method === "registry.role.update")!.args[2] as Record<
    string,
    unknown
  >;
  assert.equal(addPatch.actor, "user");
  assert.deepEqual(addPatch.roster, ["alpha", "beta", "gamma"]);
  assert.equal(addPatch.roleId, "rl-exec");

  calls.length = 0;
  const rem = await runRoleCommand("config", ["executor", "--roster-remove", "alpha", "--json"], g);
  assert.equal(rem.exitCode, 0, rem.stderr);
  assert.deepEqual(
    (calls.find((c) => c.method === "registry.role.update")!.args[2] as { roster: string[] }).roster,
    ["beta", "gamma"]
  );
  assert.equal(
    (
      await runRoleCommand("config", ["executor", "--roster-add", "a", "--roster-remove", "a"], g)
    ).exitCode,
    1
  );

  // roster-add does not invent AgentDefinitions
  state.agents.clear();
  state.roles = [{ roleId: "rl-y", name: "y", displayName: "y", roster: [] }];
  calls.length = 0;
  const invent = await runRoleCommand("config", ["y", "--roster-add", "brand-new", "--json"], g);
  assert.equal(invent.exitCode, 0, invent.stderr);
  assert.ok(!calls.some((c) => c.method.startsWith("agent.")));
  assert.equal(
    (JSON.parse(invent.stdout) as { role: RoleRegistryEntryProjection }).role.rosterEntries?.[0]
      ?.readiness,
    "missing-definition"
  );
  assert.equal(state.agents.size, 0);
});
