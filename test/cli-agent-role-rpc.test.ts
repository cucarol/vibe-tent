/**
 * Focused fake-client tests for Role metadata CLI RPCs.
 * ACP route authorization belongs to machine Settings, not Role metadata.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { roleHelpText, runRoleCommand } from "../src/cli/role-rpc.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import type { ServiceClient } from "../src/service/client.js";
import type { RoleRegistryEntryProjection } from "../src/service/types.js";

type Call = { method: string; args: unknown[] };

function fake(state: { roles: RoleRegistryEntryProjection[] }): { client: ServiceClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
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
      const current = state.roles[i]!;
      const role = { ...current, ...patch } as RoleRegistryEntryProjection;
      delete (role as Record<string, unknown>).actor;
      state.roles[i] = role;
      return { workspaceId, role };
    },
    listWorkspaces: async () => ({ workspaces: [] }),
    mount: async (workspaceRoot: string) => ({
      workspaceId: "ws-fake",
      workspaceRoot,
      systemRoot: workspaceRoot + "/.tent",
    }),
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

test("role help and list/show expose metadata only", async () => {
  const help = roleHelpText();
  assert.match(help, /tent role list/);
  assert.match(help, /--display-name/);
  assert.doesNotMatch(help, /a2a|roster|rosterEntries|readiness|agentId/);

  const state = {
    roles: [
      {
        roleId: "rl-planner",
        name: "planner",
        displayName: "Planner",
        description: "plans work",
        prompt: "plan",
        color: "blue",
        a2aPolicy: "ask",
        roster: ["hidden-agent"],
        rosterEntries: [{ agentId: "hidden-agent", readiness: "ready" }],
      },
    ],
  };
  const { client, calls } = fake(state);
  const g = await roleGlobals(client);

  const list = await runRoleCommand("list", ["--json"], g);
  assert.equal(list.exitCode, 0, list.stderr);
  const listed = JSON.parse(list.stdout) as { roles: Record<string, unknown>[] };
  assert.equal(listed.roles[0]!.name, "planner");
  assert.equal("roster" in listed.roles[0]!, false);
  assert.equal("rosterEntries" in listed.roles[0]!, false);

  const show = await runRoleCommand("show", ["planner", "--json"], g);
  assert.equal(show.exitCode, 0, show.stderr);
  const shown = JSON.parse(show.stdout) as { role: Record<string, unknown> };
  assert.equal(shown.role.prompt, "plan");
  assert.equal("roster" in shown.role, false);
  assert.equal("rosterEntries" in shown.role, false);
  assert.deepEqual(calls.map((call) => call.method), ["registry.roles", "registry.roles"]);
});

test("role config updates metadata without roster fields", async () => {
  const state = {
    roles: [{ roleId: "rl-exec", name: "executor", displayName: "Executor" }],
  };
  const { client, calls } = fake(state);
  const g = await roleGlobals(client);

  const result = await runRoleCommand(
    "config",
    [
      "executor",
      "--display-name",
      "Execution",
      "--prompt",
      "ship",
      "--description",
      "does work",
      "--color",
      "green",
      "--json",
    ],
    g
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const update = calls.find((call) => call.method === "registry.role.update")!;
  assert.deepEqual(update.args[2], {
    roleId: "rl-exec",
    displayName: "Execution",
    prompt: "ship",
    description: "does work",
    color: "green",
    actor: "user",
  });
  assert.equal("roster" in (update.args[2] as Record<string, unknown>), false);
});

test("retired Role authorization flags fail without compatibility or mutation", async () => {
  const state = { roles: [{ roleId: "rl-y", name: "y", displayName: "Y" }] };
  const { client, calls } = fake(state);
  const g = await roleGlobals(client);

  for (const flag of ["--roster", "--roster-add", "--roster-remove", "--a2a-policy"]) {
    const result = await runRoleCommand("config", ["y", flag, "agent-a"], g);
    assert.notEqual(result.exitCode, 0, flag);
    assert.match(result.stderr, /retired|no longer accepts/i, flag);
  }
  assert.equal(calls.length, 0);
});
