/**
 * Service registry.roles — Role roster readiness projection (cx-b9bf58 slice).
 * Read-only: ready | missing-definition | missing-profile; no AgentDefinition invent.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import {
  agentDefinitionsPath,
  loadAgentDefinitions,
  saveAgentDefinitions,
} from "../src/service/agent-definitions.js";
import { createServiceClient } from "../src/service/client.js";
import { rpcCall } from "../src/service/http-server.js";
import { FAKE_DEFAULT_PROFILE_ID } from "../src/service/profiles.js";
import { startLocalTentService } from "../src/service/service.js";
import {
  CLIENT_METHODS,
  isClientMethod,
  ROLE_ROSTER_READINESS,
  type RoleRegistryEntryProjection,
  type RoleRosterEntryProjection,
  type RoleRosterReadiness,
} from "../src/service/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const READINESS_SET = new Set<string>(ROLE_ROSTER_READINESS);

async function makeWorkspace(name = "roster-ready"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-roster-ready-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-roster-ready-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    packageRoot: repoRoot,
  });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

function rpc(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  method: string,
  params?: Record<string, unknown>
) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

function assertSafeRosterEntry(entry: RoleRosterEntryProjection): void {
  assert.ok(typeof entry.agentId === "string" && entry.agentId.length > 0);
  assert.ok(READINESS_SET.has(entry.readiness), entry.readiness);
  const keys = Object.keys(entry);
  for (const k of keys) {
    assert.ok(
      ["agentId", "displayName", "profileId", "readiness"].includes(k),
      `unexpected roster entry key: ${k}`
    );
  }
  assert.ok(!("secret" in entry));
  assert.ok(!("apiKey" in entry));
  assert.ok(!("token" in entry));
  assert.ok(!("env" in entry));
  assert.ok(!("credential" in entry));
  assert.ok(!("credentials" in entry));
  assert.ok(!("envKey" in entry));
  assert.ok(!("baseUrl" in entry));
  assert.ok(!("command" in entry));
  assert.ok(!("args" in entry));
  assert.ok(!("executable" in entry));
  assert.ok(!("model" in entry));
  assert.ok(!("adapterId" in entry));
  assert.ok(!("credentialRef" in entry));
}

function assertSafeRoleProjection(role: RoleRegistryEntryProjection): void {
  assert.ok(!("secret" in role));
  assert.ok(!("apiKey" in role));
  assert.ok(!("token" in role));
  assert.ok(!("env" in role));
  assert.ok(!("credentials" in role));
  assert.ok(!("allowedProfiles" in role));
  if (role.rosterEntries) {
    for (const e of role.rosterEntries) assertSafeRosterEntry(e);
  }
}

test("CLIENT_METHODS includes registry.roles; readiness enum is closed", () => {
  assert.ok(isClientMethod("registry.roles"));
  assert.ok(CLIENT_METHODS.includes("registry.roles"));
  assert.deepEqual([...ROLE_ROSTER_READINESS], [
    "ready",
    "missing-definition",
    "missing-profile",
  ]);
});

test("registry.roles: empty roster omits rosterEntries; roles name-sorted", async () => {
  const ws = await makeWorkspace("empty-roster");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    await client.registryRoleCreate(workspaceId, {
      name: "zebra",
      prompt: "z",
      a2aPolicy: "deny",
    });
    await client.registryRoleCreate(workspaceId, {
      name: "alpha",
      prompt: "a",
      a2aPolicy: "deny",
      roster: [],
    });

    const listed = await client.registryRoles(workspaceId) as {
      roles: RoleRegistryEntryProjection[];
    };
    const roles = listed.roles;
    assert.deepEqual(
      roles.map((r) => r.name),
      ["alpha", "zebra"]
    );
    for (const role of roles) {
      assertSafeRoleProjection(role);
      assert.equal(role.roster, undefined);
      assert.equal(role.rosterEntries, undefined);
    }
  });
});

test("registry.roles: three readiness states + stable roster order", async () => {
  const ws = await makeWorkspace("three-states");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    // ready: definition + catalog profile
    await client.agentCreate({
      id: "worker-ready",
      profileId: FAKE_DEFAULT_PROFILE_ID,
      displayName: "Ready Worker",
    });
    // missing-profile: definition on disk with absent profileId (create RPC would reject)
    await saveAgentDefinitions(svc.dataDir, [
      ...(await loadAgentDefinitions(svc.dataDir)).agents,
      {
        id: "worker-noprofile",
        profileId: "does-not-exist-profile",
        displayName: "No Profile Worker",
      },
    ]);
    // missing-definition: roster id only — no AgentDefinition row

    await client.registryRoleCreate(workspaceId, {
      name: "dispatcher",
      prompt: "dispatch",
      a2aPolicy: "deny",
      // Explicit order must be preserved in roster + rosterEntries
      roster: ["worker-ready", "ghost-agent", "worker-noprofile"],
    });

    const listed = await client.registryRoles(workspaceId) as {
      roles: RoleRegistryEntryProjection[];
    };
    const roles = listed.roles;
    const dispatcher = roles.find((r) => r.name === "dispatcher");
    assert.ok(dispatcher);
    assertSafeRoleProjection(dispatcher!);
    assert.deepEqual(dispatcher!.roster, [
      "worker-ready",
      "ghost-agent",
      "worker-noprofile",
    ]);
    assert.ok(dispatcher!.rosterEntries);
    assert.equal(dispatcher!.rosterEntries!.length, 3);

    const byId = new Map(
      dispatcher!.rosterEntries!.map((e) => [e.agentId, e] as const)
    );
    // Order matches roster
    assert.deepEqual(
      dispatcher!.rosterEntries!.map((e) => e.agentId),
      dispatcher!.roster
    );

    const ready = byId.get("worker-ready")!;
    assert.equal(ready.readiness, "ready" satisfies RoleRosterReadiness);
    assert.equal(ready.displayName, "Ready Worker");
    assert.equal(ready.profileId, FAKE_DEFAULT_PROFILE_ID);

    const missingDef = byId.get("ghost-agent")!;
    assert.equal(missingDef.readiness, "missing-definition");
    assert.equal(missingDef.displayName, undefined);
    assert.equal(missingDef.profileId, undefined);

    const missingProf = byId.get("worker-noprofile")!;
    assert.equal(missingProf.readiness, "missing-profile");
    assert.equal(missingProf.displayName, "No Profile Worker");
    assert.equal(missingProf.profileId, "does-not-exist-profile");

    for (const e of dispatcher!.rosterEntries!) assertSafeRosterEntry(e);
  });
});

test("registry.roles: read-only — no AgentDefinition invent; no machine file mutation", async () => {
  const ws = await makeWorkspace("readonly");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    const defsPath = agentDefinitionsPath(svc.dataDir);
    const beforeExists = await fs
      .access(defsPath)
      .then(() => true)
      .catch(() => false);
    const beforeBytes = beforeExists ? await fs.readFile(defsPath) : null;
    const beforeMtime = beforeExists ? (await fs.stat(defsPath)).mtimeMs : null;

    await client.registryRoleCreate(workspaceId, {
      name: "orch",
      prompt: "o",
      a2aPolicy: "deny",
      roster: ["never-defined-agent", "also-missing"],
    });

    // Snapshot after role create (may not touch agent-definitions).
    const midExists = await fs
      .access(defsPath)
      .then(() => true)
      .catch(() => false);
    const midBytes = midExists ? await fs.readFile(defsPath) : null;

    const listed = await client.registryRoles(workspaceId) as {
      roles: RoleRegistryEntryProjection[];
    };
    const roles = listed.roles;
    const orch = roles.find((r) => r.name === "orch");
    assert.ok(orch?.rosterEntries);
    assert.deepEqual(
      orch!.rosterEntries!.map((e) => e.readiness),
      ["missing-definition", "missing-definition"]
    );

    // agent.list must not gain auto-created rows for roster ids
    const agents = await client.agentList() as {
      agents: Array<{ id: string }>;
    };
    const rows = agents.agents;
    assert.equal(
      rows.some((a) => a.id === "never-defined-agent" || a.id === "also-missing"),
      false
    );

    // agent-definitions.json unchanged by registry.roles read
    const afterExists = await fs
      .access(defsPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(afterExists, midExists);
    if (midBytes) {
      const afterBytes = await fs.readFile(defsPath);
      assert.deepEqual(afterBytes, midBytes);
    } else {
      assert.equal(afterExists, false);
    }

    // Second list still does not create
    await client.registryRoles(workspaceId);
    const after2Exists = await fs
      .access(defsPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(after2Exists, midExists);
    // Silence unused snapshots from pre-create state (role create is out of read path).
    void beforeBytes;
    void beforeMtime;
  });
});

test("registry.roles via raw RPC: no secret leakage in JSON", async () => {
  const ws = await makeWorkspace("no-secrets");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    await rpc(svc, "agent.create", {
      id: "sec-worker",
      profileId: FAKE_DEFAULT_PROFILE_ID,
      displayName: "Sec",
      actor: "user",
    });
    await rpc(svc, "registry.role.create", {
      workspaceId,
      name: "sec-role",
      roster: ["sec-worker", "absent-one"],
      actor: "user",
    });

    const listed = await rpc(svc, "registry.roles", { workspaceId });
    assert.ok(!listed.error, JSON.stringify(listed.error));
    const raw = JSON.stringify(listed.result);
    for (const banned of [
      "apiKey",
      "api_key",
      "password",
      "secret",
      "token",
      "credential",
      "XAI_API_KEY",
      "OPENAI_API_KEY",
      "Authorization",
    ]) {
      assert.equal(
        raw.toLowerCase().includes(banned.toLowerCase()),
        false,
        `leaked ${banned}`
      );
    }

    const roles = (listed.result as { roles: RoleRegistryEntryProjection[] }).roles;
    for (const role of roles) assertSafeRoleProjection(role);
  });
});
