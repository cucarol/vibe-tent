/**
 * V0.2 AgentDefinition + Role roster + built-in skill composition (cx-74esv8 slice 1).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import {
  ensureRolesRosterMigrated,
  loadRolesRegistry,
  normalizeAgentIdList,
  normalizeRoleDefinition,
  roleAllowsAgent,
  roleRoster,
  updateRole,
} from "../src/core/skillRoleRegistry.js";
import {
  assembleManagedSessionBootstrap,
  builtinSkillNamesForExecutor,
  composeManagedSkillBootstrapPrefix,
  composeManagedSkillRefs,
  formatStableRosterDigest,
  MANAGED_SESSION_BOOTSTRAP_BANNER,
  splitManagedBootstrapStableAndDynamic,
  STABLE_SKILL_CONTRACTS_END_MARKER,
} from "../src/core/managed-skill-compose.js";
import { sessionBootstrapPromptForTask } from "../src/core/task.js";
import { taskContextCard } from "../src/core/context-card.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import {
  ensureAgentDefinitionsForProfileIds,
  loadAgentDefinitions,
  resolveProfileIdForAgent,
  saveAgentDefinitions,
} from "../src/service/agent-definitions.js";
import { FAKE_DEFAULT_PROFILE_ID } from "../src/service/profiles.js";
import { CLIENT_METHODS, isClientMethod, RPC_A2A_DENIED } from "../src/service/types.js";
import { runTaskCommand, taskHelpText } from "../src/cli/task-rpc.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function makeWorkspace(name = "agent-roster"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-agent-roster-ws-"));
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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-agent-roster-data-"));
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

test("CLIENT_METHODS includes agent.list/get/create/update/delete", () => {
  for (const m of ["agent.list", "agent.get", "agent.create", "agent.update", "agent.delete"]) {
    assert.ok(isClientMethod(m), m);
    assert.ok(CLIENT_METHODS.includes(m as (typeof CLIENT_METHODS)[number]));
  }
});

test("normalizeRoleDefinition: allowedProfiles migrates to roster; no dual field", () => {
  const role = normalizeRoleDefinition({
    name: "orch",
    allowedProfiles: ["  fake-default ", "fake-default", "grok-acp-default"],
  });
  assert.deepEqual(role.roster, ["fake-default", "grok-acp-default"]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(role, "allowedProfiles"),
    false
  );
  assert.equal(roleAllowsAgent(role, "fake-default"), true);
  assert.equal(roleAllowsAgent(role, "missing"), false);
  assert.deepEqual(roleRoster(role), ["fake-default", "grok-acp-default"]);
  assert.equal(normalizeAgentIdList([]), undefined);
});

test("ensureRolesRosterMigrated: one-time write-forward drops allowedProfiles", async () => {
  const ws = await makeWorkspace("roster-migrate");
  const systemRoot = path.join(ws, ".tent");
  const fsa = new NodeFs(systemRoot);
  await fsa.writeFile(
    "roles.json",
    JSON.stringify(
      {
        roles: [
          {
            name: "orchestrator",
            prompt: "dispatch",
            a2aPolicy: "allow",
            allowedProfiles: ["fake-default", "  fake-default "],
          },
        ],
      },
      null,
      2
    ) + "\n"
  );

  // Plain load projects roster in memory without requiring write.
  const loaded = await loadRolesRegistry(fsa);
  assert.deepEqual(loaded.roles[0]!.roster, ["fake-default"]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(loaded.roles[0]!, "allowedProfiles"),
    false
  );

  const diskBefore = JSON.parse(await fsa.readFile("roles.json")) as {
    roles: Array<{ allowedProfiles?: string[]; roster?: string[] }>;
  };
  assert.ok(diskBefore.roles[0]!.allowedProfiles, "disk still legacy before migrate");
  assert.equal(diskBefore.roles[0]!.roster, undefined);

  const first = await ensureRolesRosterMigrated(fsa);
  assert.equal(first.wrote, true);
  const diskAfter = JSON.parse(await fsa.readFile("roles.json")) as {
    roles: Array<{ allowedProfiles?: string[]; roster?: string[] }>;
  };
  assert.deepEqual(diskAfter.roles[0]!.roster, ["fake-default"]);
  assert.equal(diskAfter.roles[0]!.allowedProfiles, undefined);

  const second = await ensureRolesRosterMigrated(fsa);
  assert.equal(second.wrote, false);
});

test("AgentDefinition store: bind agentId→profileId; resolve launch profile", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-agent-defs-"));
  await saveAgentDefinitions(dataDir, [
    { id: "worker-core", profileId: "fake-default", displayName: "Core worker" },
  ]);
  const { agents } = await loadAgentDefinitions(dataDir);
  assert.equal(agents.length, 1);
  assert.equal(resolveProfileIdForAgent(agents, "worker-core"), "fake-default");
  assert.throws(() => resolveProfileIdForAgent(agents, "missing"), /not found/i);

  const ensured = ensureAgentDefinitionsForProfileIds(agents, ["fake-default", "grok-acp-default"]);
  assert.equal(ensured.added, true);
  assert.ok(ensured.agents.some((a) => a.id === "fake-default" && a.profileId === "fake-default"));
  assert.ok(ensured.agents.some((a) => a.id === "worker-core"));
});

test("builtin skill composition: prompt is sole model-visible source; ACP meta is extras only", () => {
  assert.deepEqual(builtinSkillNamesForExecutor("role"), ["tent-role", "tent-task"]);
  assert.deepEqual(builtinSkillNamesForExecutor("agentProfile"), ["tent-task"]);

  // ACP meta must not re-advertise built-ins (even if profile lists them).
  const refs = composeManagedSkillRefs({
    packageRoot: repoRoot,
    assigneeKind: "role",
    profileSkills: [
      { name: "tent-task", path: "/tmp/should-not-win" },
      { name: "tent-role", path: "/tmp/also-not-win" },
      { name: "user-extra", path: path.join(os.homedir(), ".agents", "skills", "user-extra") },
      { name: "user-extra", path: "/tmp/dup" },
      { name: "TENT-TASK", path: "/tmp/case-collide" },
    ],
  });
  assert.deepEqual(
    refs.map((r) => r.name),
    ["user-extra"],
    "ACP meta is profile extras only; built-ins stripped and extras deduped"
  );
  assert.equal(
    refs.some((r) => /tent-(role|task)/i.test(r.name)),
    false,
    "built-in names must not appear in ACP skill meta"
  );

  const prefix = composeManagedSkillBootstrapPrefix({
    packageRoot: repoRoot,
    assigneeKind: "role",
    role: {
      name: "规划",
      prompt: "Plan carefully",
      roster: ["worker-b", "worker-a"],
    },
  });
  const roleHeading = "## Built-in skill: tent-role";
  const taskHeading = "## Built-in skill: tent-task";
  const roleIdx = prefix.indexOf(roleHeading);
  const promptIdx = prefix.indexOf("## Role prompt");
  const rosterIdx = prefix.indexOf("## Role roster");
  const taskIdx = prefix.indexOf(taskHeading);
  assert.ok(roleIdx >= 0 && promptIdx > roleIdx && rosterIdx > promptIdx && taskIdx > rosterIdx);

  // Each built-in heading/body appears exactly once in the stable prefix.
  const count = (hay: string, needle: string) => {
    let n = 0;
    let from = 0;
    while (true) {
      const i = hay.indexOf(needle, from);
      if (i === -1) return n;
      n += 1;
      from = i + needle.length;
    }
  };
  assert.equal(count(prefix, roleHeading), 1);
  assert.equal(count(prefix, taskHeading), 1);
  // Body identity: distinctive first lines from each SKILL after frontmatter strip.
  const roleBodySample = "Apply this contract whenever acting as a durable Role";
  const taskBodySample = "Apply this contract whenever executing a Tent Task";
  assert.equal(count(prefix, roleBodySample), 1, "tent-role body once in prefix");
  assert.equal(count(prefix, taskBodySample), 1, "tent-task body once in prefix");
  // Combined model-visible surface (prefix + ACP meta names) still has each built-in once.
  const metaJoined = refs.map((r) => r.name).join("\n");
  assert.equal(count(prefix + "\n" + metaJoined, roleHeading), 1);
  assert.equal(count(prefix + "\n" + metaJoined, taskHeading), 1);
  assert.doesNotMatch(metaJoined, /tent-role|tent-task/i);

  assert.match(prefix, /Plan carefully/);
  assert.equal(
    formatStableRosterDigest(["worker-b", "worker-a"]),
    "- worker-a\n- worker-b"
  );
  assert.match(prefix, /- worker-a/);
  assert.match(prefix, /- worker-b/);

  const oneShot = composeManagedSkillBootstrapPrefix({
    packageRoot: repoRoot,
    assigneeKind: "agentProfile",
  });
  // One-shot must not embed the role contract section (body text may still mention tent-role).
  assert.doesNotMatch(oneShot, /## Built-in skill: tent-role/);
  assert.equal(count(oneShot, taskHeading), 1);
  assert.equal(count(oneShot, taskBodySample), 1);

  const oneShotMeta = composeManagedSkillRefs({
    packageRoot: repoRoot,
    assigneeKind: "agentProfile",
    profileSkills: [{ name: "tent-task" }, { name: "extra-a" }, { name: "extra-a" }],
  });
  assert.deepEqual(
    oneShotMeta.map((r) => r.name),
    ["extra-a"]
  );
});

test("stable bootstrap prefix is byte-identical across two Tasks; only dynamic tail diverges", () => {
  const role = {
    name: "规划",
    id: "rl-test",
    displayName: "规划",
    prompt: "Stable role prompt for cache",
    roster: ["worker-a", "worker-b"],
  };
  const skillPrefix = composeManagedSkillBootstrapPrefix({
    packageRoot: repoRoot,
    assigneeKind: "role",
    role,
  });
  assert.ok(skillPrefix.endsWith(STABLE_SKILL_CONTRACTS_END_MARKER));

  const roots = {
    workspaceRoot: "C:\\ws",
    systemRoot: "C:\\ws\\.tent",
  };

  const taskA = {
    path: "temp/规划/tasks/task-aaa-cx-1.md",
    role: "规划",
    manifest: "temp/规划/manifest.yml",
    status: "taken" as const,
    state: "running" as const,
    id: "tk-taskaaa",
    assigneeKind: "role" as const,
    prompt:
      "# Task\n\n## Context Pointers\n\n- cx-aaaaaa: A\n\n## User Prompt\n\nDo work A uniquely.\n",
  };
  const taskB = {
    path: "temp/规划/tasks/task-bbb-cx-2.md",
    role: "规划",
    manifest: "temp/规划/manifest.yml",
    status: "taken" as const,
    state: "running" as const,
    id: "tk-taskbbb",
    assigneeKind: "role" as const,
    prompt:
      "# Task\n\n## Context Pointers\n\n- cx-bbbbbb: B\n\n## User Prompt\n\nDo work B differently.\n",
  };

  const cardA = taskContextCard(taskA.id, {
    path: taskA.path,
    workspaceRoot: roots.workspaceRoot,
    systemRoot: roots.systemRoot,
    label: `task:${taskA.role}`,
  });
  const cardB = taskContextCard(taskB.id, {
    path: taskB.path,
    workspaceRoot: roots.workspaceRoot,
    systemRoot: roots.systemRoot,
    label: `task:${taskB.role}`,
  });

  const fullA = assembleManagedSessionBootstrap({
    stableSkillPrefix: skillPrefix,
    contextCardPrompt: cardA.prompt,
    dynamicTaskTail: sessionBootstrapPromptForTask(taskA, roots),
  });
  const fullB = assembleManagedSessionBootstrap({
    stableSkillPrefix: skillPrefix,
    contextCardPrompt: cardB.prompt,
    dynamicTaskTail: sessionBootstrapPromptForTask(taskB, roots),
  });

  // Banner before skills; Context Card after tent-task end marker (not before).
  assert.ok(fullA.startsWith(MANAGED_SESSION_BOOTSTRAP_BANNER + "\n"));
  const markerPos = fullA.indexOf(STABLE_SKILL_CONTRACTS_END_MARKER);
  const cardPos = fullA.indexOf("Tent contextCard v1");
  const taskBodyPos = fullA.indexOf("## Built-in skill: tent-task");
  assert.ok(markerPos > taskBodyPos);
  assert.ok(cardPos > markerPos, "Context Card must follow stable skill contracts");

  const splitA = splitManagedBootstrapStableAndDynamic(fullA);
  const splitB = splitManagedBootstrapStableAndDynamic(fullB);
  assert.equal(
    splitA.stablePrefix,
    splitB.stablePrefix,
    "stable prefixes through end of tent-task must be byte-identical"
  );
  assert.notEqual(fullA, fullB);
  assert.notEqual(splitA.dynamicTail, splitB.dynamicTail);
  assert.match(splitA.dynamicTail, /tk-taskaaa|task-aaa/);
  assert.match(splitB.dynamicTail, /tk-taskbbb|task-bbb/);
  assert.match(splitA.dynamicTail, /Do work A uniquely/);
  assert.match(splitB.dynamicTail, /Do work B differently/);
  // Dynamic tail must not re-embed built-in skill headings.
  assert.doesNotMatch(splitA.dynamicTail, /## Built-in skill: tent-/);
  assert.doesNotMatch(splitB.dynamicTail, /## Built-in skill: tent-/);
});

test("Service agent CRUD + role roster projection; out-of-roster denies", async () => {
  const ws = await makeWorkspace("svc-agent");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    const createdAgent = (await client.agentCreate({
      id: "core-worker",
      profileId: FAKE_DEFAULT_PROFILE_ID,
      displayName: "Core",
    })) as { agent: { id: string; profileId: string } };
    assert.equal(createdAgent.agent.id, "core-worker");
    assert.equal(createdAgent.agent.profileId, FAKE_DEFAULT_PROFILE_ID);

    const listed = (await client.agentList()) as {
      agents: Array<{ id: string; profileExists?: boolean }>;
    };
    assert.ok(listed.agents.some((a) => a.id === "core-worker" && a.profileExists === true));

    const rejectLegacy = await rpc(svc, "registry.role.create", {
      workspaceId,
      name: "nope",
      allowedProfiles: ["core-worker"],
    });
    assert.ok(rejectLegacy.error);
    assert.equal(rejectLegacy.error!.code, -32602);
    assert.match(String(rejectLegacy.error!.message), /no longer accepts allowedProfiles|use roster/i);

    const createdRole = (await client.registryRoleCreate(workspaceId, {
      name: "dispatcher",
      prompt: "dispatch subs",
      a2aPolicy: "ask", // standing roster must ignore ask for agentId path
      roster: ["core-worker"],
    })) as { role: { roster?: string[]; a2aPolicy?: string } };
    assert.deepEqual(createdRole.role.roster, ["core-worker"]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(createdRole.role, "allowedProfiles"),
      false,
      "projection must not expose allowedProfiles"
    );
    assert.equal(createdRole.role.a2aPolicy, "ask");

    const disk = JSON.parse(
      await fs.readFile(path.join(ws, ".tent", "roles.json"), "utf8")
    ) as { roles: Array<Record<string, unknown>> };
    const row = disk.roles.find((r) => r.name === "dispatcher");
    assert.deepEqual(row?.roster, ["core-worker"]);
    assert.equal("allowedProfiles" in (row ?? {}), false, "must not dual-write allowedProfiles");

    const note = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "work",
      type: "prompt",
    });
    assert.ok(!note.error, JSON.stringify(note.error));
    const boxId = (note.result as { id: string }).id;

    // In-roster Role-agent dispatch: standing auth (no A2A ask), persists agentId.
    const hit = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      agentId: "core-worker",
      prompt: "in roster with a2a ask role — must not park",
      callerKind: "role",
      parentActor: { kind: "role", id: "dispatcher" },
      startSession: true,
    });
    assert.ok(!hit.error, JSON.stringify(hit.error));
    const hitPath = (hit.result as { taskPath: string }).taskPath;
    const hitGet = await rpc(svc, "task.get", { workspaceId, taskPath: hitPath });
    assert.ok(!hitGet.error, JSON.stringify(hitGet.error));
    const hitTask = (hitGet.result as { task: { agentId?: string; role?: string; state?: string } })
      .task;
    assert.equal(hitTask.agentId, "core-worker");
    assert.equal(hitTask.role, FAKE_DEFAULT_PROFILE_ID);
    assert.notEqual(hitTask.state, "waiting", "roster hit must not enter a2a ask waiting");
    // No pending A2A approvals for standing roster path.
    const pending = await rpc(svc, "a2a.listPending", { workspaceId });
    assert.ok(!pending.error, JSON.stringify(pending.error));
    const items = (pending.result as { items?: unknown[] }).items ?? [];
    assert.equal(items.length, 0);

    await client.registryRoleUpdate(workspaceId, "dispatcher", { roster: [] });
    const out = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      agentId: "core-worker",
      prompt: "out of roster",
      callerKind: "role",
      parentActor: { kind: "role", id: "dispatcher" },
      startSession: true,
    });
    assert.ok(out.error);
    assert.equal(out.error!.code, RPC_A2A_DENIED);
    assert.match(String(out.error!.message), /roster|not on role/i);
  });
});

test("Service: legacy allowedProfiles on disk migrates once; public RPC rejects field", async () => {
  const ws = await makeWorkspace("legacy-ap");
  await fs.writeFile(
    path.join(ws, ".tent", "roles.json"),
    JSON.stringify(
      {
        roles: [
          {
            name: "orchestrator",
            prompt: "orch",
            a2aPolicy: "allow",
            allowedProfiles: ["fake-default"],
          },
        ],
      },
      null,
      2
    ) + "\n"
  );
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const listed = await rpc(svc, "registry.roles", { workspaceId });
    assert.ok(!listed.error, JSON.stringify(listed.error));
    const roles = (listed.result as {
      roles: Array<{
        name: string;
        roster?: string[];
        rosterEntries?: Array<{ agentId: string; readiness: string }>;
      }>;
    }).roles;
    const orch = roles.find((r) => r.name === "orchestrator");
    assert.deepEqual(orch?.roster, ["fake-default"]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(orch ?? {}, "allowedProfiles"),
      false,
      "projection is roster-only"
    );
    // Read-only readiness: list must not invent AgentDefinitions for migrated roster ids.
    assert.deepEqual(orch?.rosterEntries, [
      { agentId: "fake-default", readiness: "missing-definition" },
    ]);

    const disk = JSON.parse(
      await fs.readFile(path.join(ws, ".tent", "roles.json"), "utf8")
    ) as { roles: Array<Record<string, unknown>> };
    assert.deepEqual(disk.roles[0]!.roster, ["fake-default"]);
    assert.equal("allowedProfiles" in disk.roles[0]!, false);

    // Second list does not re-introduce allowedProfiles on projection.
    const listed2 = await rpc(svc, "registry.roles", { workspaceId });
    assert.ok(!listed2.error);
    const orch2 = (
      listed2.result as { roles: Array<{ name: string; roster?: string[] }> }
    ).roles.find((r) => r.name === "orchestrator");
    assert.equal(
      Object.prototype.hasOwnProperty.call(orch2 ?? {}, "allowedProfiles"),
      false
    );

    // registry.roles must not auto-create AgentDefinitions (read-only projection).
    const agents = await rpc(svc, "agent.list", {});
    assert.ok(!agents.error, JSON.stringify(agents.error));
    const rows = (agents.result as { agents: Array<{ id: string; profileId: string }> }).agents;
    assert.equal(
      rows.some((a) => a.id === "fake-default"),
      false,
      "list path must not invent AgentDefinitions for roster agentIds"
    );

    const reject = await rpc(svc, "registry.role.update", {
      workspaceId,
      name: "orchestrator",
      allowedProfiles: ["x"],
    });
    assert.ok(reject.error);
    assert.match(String(reject.error!.message), /no longer accepts allowedProfiles|use roster/i);
  });
});

test("Task records agentId; multi-agent same profile is unambiguous", async () => {
  const ws = await makeWorkspace("agentid-persist");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    await client.agentCreate({ id: "worker-a", profileId: FAKE_DEFAULT_PROFILE_ID });
    await client.agentCreate({ id: "worker-b", profileId: FAKE_DEFAULT_PROFILE_ID });
    await client.registryRoleCreate(workspaceId, {
      name: "boss",
      a2aPolicy: "deny", // standing roster must still allow agentId path
      roster: ["worker-a", "worker-b"],
    });

    const note = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "job",
      type: "prompt",
    });
    const boxId = (note.result as { id: string }).id;

    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      agentId: "worker-b",
      prompt: "choose b among two agents on same profile",
      callerKind: "role",
      parentActor: { kind: "role", id: "boss" },
      startSession: true,
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    const task = (got.result as { task: { agentId?: string; role?: string } }).task;
    assert.equal(task.agentId, "worker-b");
    assert.equal(task.role, FAKE_DEFAULT_PROFILE_ID);

    // startSession uses Task.agentId — still worker-b, not ambiguous profile inference.
    const start = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: FAKE_DEFAULT_PROFILE_ID,
      callerKind: "role",
    });
    // May reuse existing session from dispatch startSession — must not deny as ambiguous.
    assert.ok(!start.error, JSON.stringify(start.error));
  });
});

test("CLI help documents --agent; user --profile one-shot still works", async () => {
  const help = taskHelpText();
  assert.match(help, /--agent <agentId>/);
  assert.match(help, /--profile <profileId>/);

  const ws = await makeWorkspace("cli-profile-ok");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-agent-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    packageRoot: repoRoot,
  });
  try {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const created = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "job",
      type: "prompt",
    });
    assert.ok(!created.error, JSON.stringify(created.error));
    const boxId = (created.result as { id: string }).id;

    const result = await runTaskCommand(
      "dispatch",
      [boxId, "--profile", "fake-default", "one-shot still works", "--json"],
      {
        cwd: ws,
        dataDir,
        attachOnly: true,
        packageRoot: repoRoot,
        json: true,
      }
    );
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    const payload = JSON.parse(result.stdout) as {
      assigneeKind?: string;
      assignee?: string;
      session?: { profileId?: string };
    };
    assert.equal(payload.assigneeKind, "agentProfile");
    assert.equal(payload.assignee, "fake-default");
  } finally {
    await svc.stop();
  }
});

test("updateRole: roster replace/clear; allowedProfiles mutation rejected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-roster-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir(".tent");
  const system = new NodeFs(path.join(dir, ".tent"));
  await system.writeFile(
    "roles.json",
    JSON.stringify({ roles: [{ name: "r", prompt: "x", roster: ["a"] }] }, null, 2) + "\n"
  );
  await updateRole(system, "r", { roster: ["b", "a", "b"] });
  let reg = await loadRolesRegistry(system);
  assert.deepEqual(reg.roles[0]!.roster, ["b", "a"]);
  await assert.rejects(
    () => updateRole(system, "r", { allowedProfiles: ["legacy-id"] } as never),
    /no longer accept allowedProfiles|use roster/i
  );
  reg = await loadRolesRegistry(system);
  assert.deepEqual(reg.roles[0]!.roster, ["b", "a"], "rejected mutation must not change roster");
  const raw = JSON.parse(await system.readFile("roles.json")) as {
    roles: Array<Record<string, unknown>>;
  };
  assert.equal("allowedProfiles" in raw.roles[0]!, false);
  assert.deepEqual(raw.roles[0]!.roster, ["b", "a"]);
  await updateRole(system, "r", { roster: [] });
  reg = await loadRolesRegistry(system);
  assert.equal(reg.roles[0]!.roster, undefined);
});
