/**
 * One-shot agentProfile task dispatch: paths, lanes, A2A, concurrency, discovery.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { makeSessionId } from "../src/runtime/types.js";
import { loadTaskEnvelope } from "../src/core/task.js";
import { loadDeliveries } from "../src/core/delivery.js";
import { loadRolesRegistry } from "../src/core/skillRoleRegistry.js";
import { previewOperationalRetention } from "../src/core/retention.js";
import { ensureTaskWorkspace } from "../src/core/workspace.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import {
  defaultAgentProfiles,
  FAKE_DEFAULT_PROFILE_ID,
} from "../src/service/profiles.js";
import {
  resetManagedAutoDeliverDedupForTests,
  setBeforeCombinedDispatchCompensateForTests,
} from "../src/service/handlers.js";
import {
  RPC_A2A_ASK,
  RPC_A2A_DENIED,
} from "../src/service/types.js";
import type { AgentProfileConfig } from "../src/runtime/types.js";
import { configureTestGitIdentity, git } from "./helpers.js";

/** Catalog with fake-default plus a deterministic launch-fail profile. */
function profilesWithLaunchFail(): AgentProfileConfig[] {
  return [
    ...defaultAgentProfiles(),
    {
      id: "fake-launch-fail",
      adapterId: FAKE_ADAPTER_ID,
      displayNameKey: "profile.fake.launchFail",
      fake: { failLaunch: "deterministic launch failure for combined dispatch" },
    },
  ];
}

async function makeWorkspace(
  name = "ap-dispatch",
  rolePolicies?: Record<string, "allow" | "ask" | "deny">,
  roleProfiles?: Record<string, string[]>
): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ap-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    rules: "# RULES\n\nagentProfile dispatch\n",
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          {
            name: "executor",
            prompt: "do work",
            ...(rolePolicies?.executor ? { a2aPolicy: rolePolicies.executor } : {}),
            ...(rolePolicies?.executor === "allow"
              ? { allowedProfiles: roleProfiles?.executor ?? ["fake-default"] }
              : roleProfiles?.executor
                ? { allowedProfiles: roleProfiles.executor }
                : {}),
          },
          {
            name: "orchestrator",
            prompt: "dispatch work",
            ...(rolePolicies?.orchestrator
              ? { a2aPolicy: rolePolicies.orchestrator }
              : {}),
            ...(rolePolicies?.orchestrator === "allow"
              ? {
                  allowedProfiles:
                    roleProfiles?.orchestrator ?? ["fake-default"],
                }
              : roleProfiles?.orchestrator
                ? { allowedProfiles: roleProfiles.orchestrator }
                : {}),
          },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ap-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
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

async function mountWorkItem(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string,
  name = "work-item"
) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name,
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return {
    workspaceId,
    boxId: (created.result as { id: string }).id,
  };
}

async function initGitOnWorkspace(workspace: string): Promise<void> {
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", ".gitignore", "README.md");
  await git(workspace, "commit", "-q", "-m", "init");
}

test("agentProfile dispatch: envelope path, task-scoped manifest, no init/registry/tent-role", async () => {
  const ws = await makeWorkspace("ap-basic");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const beforeRoles = await loadRolesRegistry(new NodeFs(path.join(ws, ".tent")));
    const roleCount = beforeRoles.roles.length;

    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "one-shot profile work",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const result = d.result as {
      taskPath: string;
      manifestPath: string;
      initPath?: string;
      assigneeKind: string;
      assignee: string;
      relayPrompt: string;
      workspaceLane?: unknown;
    };
    assert.equal(result.assigneeKind, "agentProfile");
    assert.equal(result.assignee, "fake-default");
    assert.equal(result.initPath, undefined);
    assert.match(result.taskPath, /^temp\/agent-profiles\/fake-default\/tasks\//);
    assert.match(
      result.manifestPath,
      /^temp\/agent-profiles\/fake-default\/manifests\/tk-.+\.yml$/
    );
    assert.equal(result.workspaceLane, undefined);
    assert.match(result.relayPrompt, /agentProfile fake-default/);
    assert.doesNotMatch(result.relayPrompt, /Role init file/);
    assert.match(result.relayPrompt, /do not look for a role init/i);

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, result.taskPath);
    assert.equal(task.assigneeKind, "agentProfile");
    assert.equal(task.role, "fake-default");
    assert.equal(task.manifest, result.manifestPath);
    assert.ok(task.id?.startsWith("tk-"));

    // No durable role init, no shared manifest.yml, no tent-role lane.
    assert.equal(await envFs.exists("temp/fake-default/init.md"), false);
    assert.equal(await envFs.exists("temp/fake-default/manifest.yml"), false);
    assert.equal(await envFs.exists("temp/fake-default"), false);
    assert.ok(await envFs.exists(result.manifestPath));
    assert.ok(await envFs.exists(result.taskPath));

    const afterRoles = await loadRolesRegistry(envFs);
    assert.equal(afterRoles.roles.length, roleCount);
    assert.ok(!afterRoles.roles.some((r) => r.name === "fake-default"));

    // Git lane naming must not appear under worktrees for this non-Git workspace.
    const sibling = path.join(path.dirname(ws), `${path.basename(ws)}-worktrees`);
    assert.equal(await fs.access(sibling).then(() => true).catch(() => false), false);
  });
});

test("role dispatch regression: still creates init + shared manifest + role path", async () => {
  const ws = await makeWorkspace("ap-role-reg");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      role: "executor",
      prompt: "role path stays",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const result = d.result as {
      taskPath: string;
      manifestPath: string;
      initPath?: string;
      assigneeKind?: string;
      relayPrompt: string;
    };
    assert.equal(result.assigneeKind, "role");
    assert.equal(result.initPath, "temp/executor/init.md");
    assert.equal(result.manifestPath, "temp/executor/manifest.yml");
    assert.match(result.taskPath, /^temp\/executor\/tasks\//);
    assert.match(result.relayPrompt, /role executor/);
    assert.match(result.relayPrompt, /Role init file/);

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, result.taskPath);
    assert.equal(taskAssigneeKindOrRole(task.assigneeKind), "role");
    assert.equal(task.role, "executor");
    assert.ok(await envFs.exists("temp/executor/init.md"));
    assert.ok(await envFs.exists("temp/executor/manifest.yml"));
  });
});

test("agent-profiles is reserved from durable role registration and dispatch", async () => {
  const ws = await makeWorkspace("ap-reserved-role");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const created = await rpc(svc, "registry.role.create", {
      workspaceId,
      name: "agent-profiles",
      prompt: "must not shadow the profile namespace",
    });
    assert.ok(created.error);
    assert.match(String(created.error!.message), /reserved/i);

    const dispatched = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      role: "agent-profiles",
      prompt: "must not enter the reserved namespace",
    });
    assert.ok(dispatched.error);
    assert.match(String(dispatched.error!.message), /reserved/i);
  });
});

function taskAssigneeKindOrRole(kind: string | undefined): string {
  return kind === "agentProfile" ? "agentProfile" : "role";
}

test("Git agentProfile task gets tent-task/<taskId> isolated lane; commits from that lane only", async () => {
  const ws = await makeWorkspace("ap-git-lane");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "git profile lane",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    // Dispatch does not create a lane for profile tasks.
    assert.equal((d.result as { workspaceLane?: unknown }).workspaceLane, undefined);

    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const task = (started.result as {
      task: {
        id?: string;
        workspaceLane?: { branch?: string; worktree?: string };
        roleBranchBase?: string;
      };
      session: { cwd?: string };
    }).task;
    const session = (started.result as { session: { cwd?: string } }).session;
    assert.ok(task.id);
    assert.equal(task.workspaceLane?.branch, `tent-task/${task.id}`);
    assert.ok(task.workspaceLane?.worktree);
    assert.ok(session.cwd);
    assert.equal(path.resolve(session.cwd!), path.resolve(task.workspaceLane!.worktree!));
    assert.doesNotMatch(task.workspaceLane!.branch!, /^tent-role\//);
    assert.ok(!task.workspaceLane!.worktree!.endsWith(`${path.sep}fake-default`));

    // Commit only on the task lane; managed collection baseline is roleBranchBase.
    const envelope = await loadTaskEnvelope(
      new NodeFs(path.join(ws, ".tent")),
      taskPath
    );
    assert.ok(envelope.roleBranchBase);
    const contract = await ensureTaskWorkspace(ws, task.id!);
    assert.equal(contract.branch, `tent-task/${task.id}`);
    await fs.writeFile(path.join(contract.worktree, "from-task.txt"), "task-only\n");
    await git(contract.worktree, "add", "from-task.txt");
    await git(contract.worktree, "commit", "-q", "-m", "task lane commit");
    const taskSha = (await git(contract.worktree, "rev-parse", "HEAD")).trim();

    // Role lane must not exist for the profile id.
    const roleBranchExists = await git(ws, "show-ref", "--verify", "--quiet", "refs/heads/tent-role/fake-default")
      .then(() => true)
      .catch(() => false);
    assert.equal(roleBranchExists, false);

    const listed = await git(
      ws,
      "log",
      `${envelope.roleBranchBase}..${contract.branch}`,
      "--format=%H"
    );
    const shas = listed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    assert.deepEqual(shas, [taskSha]);
  });
});

test("startSession profile match/mismatch; two same-profile tasks concurrent", async () => {
  const ws = await makeWorkspace("ap-concurrent");
  await withService(async (svc) => {
    const a = await mountWorkItem(svc, ws, "box-a");
    const boxB = await rpc(svc, "docs.createNote", {
      workspaceId: a.workspaceId,
      name: "box-b",
      type: "prompt",
    });
    const boxIdB = (boxB.result as { id: string }).id;

    const d1 = await rpc(svc, "task.dispatch", {
      workspaceId: a.workspaceId,
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      boxId: a.boxId,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "first",
    });
    const d2 = await rpc(svc, "task.dispatch", {
      workspaceId: a.workspaceId,
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      boxId: boxIdB,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "second",
    });
    assert.ok(!d1.error && !d2.error);
    const t1 = (d1.result as { taskPath: string }).taskPath;
    const t2 = (d2.result as { taskPath: string }).taskPath;

    await rpc(svc, "task.claim", { workspaceId: a.workspaceId, taskPath: t1 });
    await rpc(svc, "task.claim", { workspaceId: a.workspaceId, taskPath: t2 });

    const mismatch = await rpc(svc, "task.startSession", {
      workspaceId: a.workspaceId,
      taskPath: t1,
      profileId: "other-profile",
      callerKind: "user",
    });
    assert.ok(mismatch.error);
    assert.equal(mismatch.error!.code, -32602);
    assert.match(String(mismatch.error!.message), /must match agentProfile/i);

    const s1 = await rpc(svc, "task.startSession", {
      workspaceId: a.workspaceId,
      taskPath: t1,
      profileId: "fake-default",
      callerKind: "user",
    });
    const s2 = await rpc(svc, "task.startSession", {
      workspaceId: a.workspaceId,
      taskPath: t2,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!s1.error, JSON.stringify(s1.error));
    assert.ok(!s2.error, JSON.stringify(s2.error));
    const id1 = (s1.result as { session: { sessionId: string } }).session.sessionId;
    const id2 = (s2.result as { session: { sessionId: string } }).session.sessionId;
    assert.notEqual(id1, id2);

    // Idempotent re-start of same task returns same session.
    const s1b = await rpc(svc, "task.startSession", {
      workspaceId: a.workspaceId,
      taskPath: t1,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!s1b.error);
    assert.equal(
      (s1b.result as { session: { sessionId: string } }).session.sessionId,
      id1
    );
  });
});

test("A2A: dispatcher role policy governs agentProfile launch; user path works", async () => {
  const ws = await makeWorkspace(
    "ap-a2a",
    { orchestrator: "allow", executor: "deny" },
    { orchestrator: ["fake-default"] }
  );
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);

    // User path always works.
    const userDispatch = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "user starts profile",
    });
    const userPath = (userDispatch.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: userPath });
    const userStart = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: userPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!userStart.error, JSON.stringify(userStart.error));
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: userPath });

    // Role caller without allowed dispatcher → deny / invalid.
    const box2 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "box-2",
      type: "prompt",
    });
    const boxId2 = (box2.result as { id: string }).id;
    const noDisp = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: boxId2,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "no dispatcher",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    });
    const noDispPath = (noDisp.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: noDispPath });
    const badCaller = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: noDispPath,
      profileId: "fake-default",
      callerKind: "role",
    });
    assert.ok(badCaller.error);
    assert.equal(badCaller.error!.code, -32602);
    assert.match(String(badCaller.error!.message), /parentActor|dispatchedBy/i);
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: noDispPath });

    // Orchestrator allow + whitelist permits matching profileId.
    const box3 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "box-3",
      type: "prompt",
    });
    const boxId3 = (box3.result as { id: string }).id;
    const orch = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: boxId3,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "orch dispatch",
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    const orchPath = (orch.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: orchPath });
    const ok = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: orchPath,
      profileId: "fake-default",
      callerKind: "role",
    });
    assert.ok(!ok.error, JSON.stringify(ok.error));
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: orchPath });

    // Same dispatcher with empty whitelist denies (profile still matches envelope).
    await rpc(svc, "registry.role.update", {
      workspaceId,
      name: "orchestrator",
      a2aPolicy: "allow",
      roster: [],
    });
    const box3b = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "box-3b",
      type: "prompt",
    });
    const boxId3b = (box3b.result as { id: string }).id;
    const orchDenied = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: boxId3b,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "orch deny whitelist",
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    const orchDeniedPath = (orchDenied.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: orchDeniedPath });
    const deniedWhitelist = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: orchDeniedPath,
      profileId: "fake-default",
      callerKind: "role",
    });
    assert.ok(deniedWhitelist.error);
    assert.equal(deniedWhitelist.error!.code, RPC_A2A_DENIED);
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: orchDeniedPath });

    // executor deny policy as dispatcher
    const box4 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "box-4",
      type: "prompt",
    });
    const boxId4 = (box4.result as { id: string }).id;
    const execDisp = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: boxId4,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "executor dispatch",
      parentActor: { kind: "role", id: "executor" },
      reviewer: { kind: "role", id: "executor" },
    });
    const execPath = (execDisp.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: execPath });
    const denied = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: execPath,
      profileId: "fake-default",
      callerKind: "role",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, RPC_A2A_DENIED);
  });
});

test("role deletion not blocked by same-named profile session", async () => {
  const ws = await makeWorkspace("ap-role-del");
  await withService(async (svc) => {
    const workspaceId = (
      await rpc(svc, "workspace.mount", { workspaceRoot: ws })
    ).result as { workspaceId: string };
    const wid = workspaceId.workspaceId;

    // Create a durable role with the same name as a profile id we will use.
    await rpc(svc, "registry.role.create", {
      workspaceId: wid,
      name: "fake-default",
      prompt: "coincidental name",
    });

    const note = await rpc(svc, "docs.createNote", {
      workspaceId: wid,
      name: "profile-work",
      type: "prompt",
    });
    const boxId = (note.result as { id: string }).id;
    const d = await rpc(svc, "task.dispatch", {
      workspaceId: wid,
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      boxId,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "profile session",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId: wid, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId: wid,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));

    // Profile session must not block role delete.
    const del = await rpc(svc, "registry.role.delete", {
      workspaceId: wid,
      name: "fake-default",
      confirmation: "fake-default",
    });
    assert.ok(!del.error, JSON.stringify(del.error));
  });
});

test("task discovery and retention see nested profile tasks", async () => {
  const ws = await makeWorkspace("ap-discover");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "discover me",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;

    const listed = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!listed.error);
    const tasks = (listed.result as { tasks: { path: string; assigneeKind?: string }[] })
      .tasks;
    assert.ok(tasks.some((t) => t.path === taskPath));
    const found = tasks.find((t) => t.path === taskPath)!;
    assert.equal(found.assigneeKind, "agentProfile");

    // Accept so retention can see terminal candidate under nested path.
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "done",
    });
    await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "user",
    });

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const preview = await previewOperationalRetention(envFs, {
      keepTerminalTasksDays: 0,
    });
    assert.ok(
      preview.candidates.some(
        (c) => c.kind === "task-group" && c.taskPath === taskPath
      ),
      JSON.stringify(preview.candidates)
    );
  });
});

test("claim projects assignee=profileId; delivery submitter is profileId", async () => {
  const ws = await makeWorkspace("ap-claim-deliv");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "claim and deliver",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    const proj = await rpc(svc, "box.projection", { workspaceId, boxId });
    assert.ok(!proj.error, JSON.stringify(proj.error));
    const projection = proj.result as {
      status: string;
      assignee?: string;
      activeTaskId?: string;
    };
    assert.equal(projection.status, "doing");
    assert.equal(projection.assignee, "fake-default");

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "profile delivery",
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const delivery = (delivered.result as { delivery: { role: string; path: string } })
      .delivery;
    assert.equal(delivery.role, "fake-default");
    assert.match(
      delivery.path,
      /^temp\/agent-profiles\/fake-default\/deliveries\/dl-/
    );

    // Self-accept still forbidden when actor equals submitter profileId.
    const selfAccept = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "fake-default",
    });
    assert.ok(selfAccept.error);
    assert.match(String(selfAccept.error!.message), /self|submitter/i);

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const deliveries = await loadDeliveries(envFs);
    assert.ok(deliveries.some((x) => x.role === "fake-default"));
  });
});

test("invalid/missing assignee combinations fail loud", async () => {
  const ws = await makeWorkspace("ap-invalid");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);

    const missingRole = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      prompt: "no role",
    });
    assert.ok(missingRole.error);
    assert.equal(missingRole.error!.code, -32602);

    const missingProfile = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      prompt: "no profile",
    });
    assert.ok(missingProfile.error);
    assert.equal(missingProfile.error!.code, -32602);
    assert.match(String(missingProfile.error!.message), /profileId/i);

    const unknownProfile = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      profileId: "missing-profile",
      prompt: "unknown profile",
    });
    assert.ok(unknownProfile.error);
    assert.equal(unknownProfile.error!.code, -32004);
    assert.match(String(unknownProfile.error!.message), /Profile not found/i);

    const conflict = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      role: "executor",
      prompt: "conflict",
    });
    assert.ok(conflict.error);
    assert.equal(conflict.error!.code, -32602);
    assert.match(String(conflict.error!.message), /different role/i);

    const badKind = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      assigneeKind: "wizard",
      role: "executor",
      prompt: "bad kind",
    });
    assert.ok(badKind.error);
    assert.equal(badKind.error!.code, -32602);

    // startSession without profileId still fails.
    const roleD = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      role: "executor",
      prompt: "role ok",
    });
    const taskPath = (roleD.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const noProfile = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(noProfile.error);
    assert.equal(noProfile.error!.code, -32602);
  });
});

test("combined dispatch startSession=true compensates pre-bind start failures", async () => {
  // A2A deny: claim+start leaves running without sessionId → interrupt; box free.
  {
    const ws = await makeWorkspace(
      "ap-combo-deny",
      { orchestrator: "deny" },
      { orchestrator: ["fake-default"] }
    );
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws, "combo-deny");
      const denied = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        assigneeKind: "agentProfile",
        profileId: "fake-default",
        prompt: "combined deny",
        startSession: true,
        callerKind: "role",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
      });
      assert.ok(denied.error);
      assert.equal(denied.error!.code, RPC_A2A_DENIED);
      assert.match(String(denied.error!.message), /denies|A2A/i);

      const listed = await rpc(svc, "task.list", { workspaceId });
      assert.ok(!listed.error);
      const tasks = (listed.result as { tasks: { path: string; state: string; sessionId?: string }[] })
        .tasks;
      const profileTasks = tasks.filter((t) => t.path.includes("agent-profiles"));
      assert.equal(profileTasks.length, 1);
      assert.equal(profileTasks[0]!.state, "interrupted");
      assert.equal(profileTasks[0]!.sessionId, undefined);

      const envFs = new NodeFs(path.join(ws, ".tent"));
      const task = await loadTaskEnvelope(envFs, profileTasks[0]!.path);
      assert.equal(task.state, "interrupted");
      assert.ok(!task.sessionId);
      // Audit preserved (envelope not deleted).
      assert.ok(await envFs.exists(profileTasks[0]!.path));

      const proj = await rpc(svc, "box.projection", { workspaceId, boxId });
      assert.ok(!proj.error, JSON.stringify(proj.error));
      const projection = proj.result as { status: string; activeTaskId?: string };
      assert.notEqual(projection.status, "doing");
      assert.ok(!projection.activeTaskId);

      // Same box can be re-dispatched after compensation.
      const again = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        boxId,
        assigneeKind: "agentProfile",
        profileId: "fake-default",
        prompt: "re-dispatch after deny compensate",
      });
      assert.ok(!again.error, JSON.stringify(again.error));
    });
  }

  // A2A ask: waiting(a2a-approval) + pending approval intact (do not interrupt).
  {
    const ws = await makeWorkspace(
      "ap-combo-ask",
      { orchestrator: "ask" },
      { orchestrator: ["fake-default"] }
    );
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws, "combo-ask");
      const ask = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        assigneeKind: "agentProfile",
        profileId: "fake-default",
        prompt: "combined ask",
        startSession: true,
        callerKind: "role",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
      });
      assert.ok(ask.error);
      assert.equal(ask.error!.code, RPC_A2A_ASK);
      const approvalId = (ask.error!.data as { approvalId: string }).approvalId;
      assert.match(approvalId, /^ap-/);

      const listed = await rpc(svc, "task.list", { workspaceId });
      const tasks = (listed.result as { tasks: { path: string; state: string }[] }).tasks;
      const profileTasks = tasks.filter((t) => t.path.includes("agent-profiles"));
      assert.equal(profileTasks.length, 1);
      assert.equal(profileTasks[0]!.state, "waiting");

      const envFs = new NodeFs(path.join(ws, ".tent"));
      const task = await loadTaskEnvelope(envFs, profileTasks[0]!.path);
      assert.equal(task.state, "waiting");
      assert.equal(task.wait?.reason, "a2a-approval");
      assert.ok(!task.sessionId);

      const pending = await rpc(svc, "a2a.listPending", { workspaceId });
      assert.ok(!pending.error);
      const approvals = (pending.result as { approvals: { id: string; status: string }[] })
        .approvals;
      assert.ok(approvals.some((a) => a.id === approvalId && a.status === "pending"));

      const proj = await rpc(svc, "box.projection", { workspaceId, boxId });
      const projection = proj.result as { status: string; activeTaskId?: string };
      assert.equal(projection.status, "doing");
      assert.ok(projection.activeTaskId);
    });
  }

  // Invalid / missing profile or start precondition: original error; no stale running claim.
  {
    const ws = await makeWorkspace("ap-combo-invalid");
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws, "combo-invalid");

      const unknown = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        boxId,
        assigneeKind: "agentProfile",
        profileId: "missing-profile-xyz",
        prompt: "unknown profile combined",
        startSession: true,
      });
      assert.ok(unknown.error);
      assert.equal(unknown.error!.code, -32004);
      assert.match(String(unknown.error!.message), /Profile not found/i);

      const missingProfileId = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        boxId,
        role: "executor",
        prompt: "start without profileId",
        startSession: true,
      });
      assert.ok(missingProfileId.error);
      assert.equal(missingProfileId.error!.code, -32602);
      assert.match(String(missingProfileId.error!.message), /profileId/i);

      // Failed combined attempts must not leave a running agentProfile occupation.
      const listed = await rpc(svc, "task.list", { workspaceId });
      const tasks = (listed.result as { tasks: { path: string; state: string }[] }).tasks;
      assert.ok(
        !tasks.some((t) => t.path.includes("agent-profiles") && t.state === "running"),
        JSON.stringify(tasks)
      );
      assert.ok(
        !tasks.some((t) => t.state === "running"),
        `stale running tasks: ${JSON.stringify(tasks)}`
      );

      const proj = await rpc(svc, "box.projection", { workspaceId, boxId });
      const projection = proj.result as { status: string; activeTaskId?: string };
      assert.notEqual(projection.status, "doing");
      assert.ok(!projection.activeTaskId);
    });
  }

  // Provider launch failure: honest failed state from startSession path; no interrupt overwrite.
  {
    const ws = await makeWorkspace("ap-combo-launch-fail");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ap-launch-"));
    const svc = await startLocalTentService({
      dataDir,
      writeEndpoint: true,
      profiles: profilesWithLaunchFail(),
    });
    try {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws, "combo-launch");
      const failed = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        boxId,
        assigneeKind: "agentProfile",
        profileId: "fake-launch-fail",
        prompt: "combined launch fail",
        startSession: true,
        callerKind: "user",
      });
      assert.ok(failed.error);
      assert.match(String(failed.error!.message), /deterministic launch failure/i);

      const listed = await rpc(svc, "task.list", { workspaceId });
      const tasks = (listed.result as { tasks: { path: string; state: string; sessionId?: string }[] })
        .tasks;
      const profileTasks = tasks.filter((t) => t.path.includes("fake-launch-fail"));
      assert.equal(profileTasks.length, 1);
      assert.equal(profileTasks[0]!.state, "failed");
      assert.ok(!profileTasks[0]!.sessionId);

      const envFs = new NodeFs(path.join(ws, ".tent"));
      const task = await loadTaskEnvelope(envFs, profileTasks[0]!.path);
      assert.equal(task.state, "failed");
      assert.ok(await envFs.exists(profileTasks[0]!.path));

      const proj = await rpc(svc, "box.projection", { workspaceId, boxId });
      const projection = proj.result as { status: string; activeTaskId?: string };
      assert.notEqual(projection.status, "doing");
      assert.ok(!projection.activeTaskId);
    } finally {
      await svc.stop();
    }
  }

  // Success: running + sessionId; occupation held.
  {
    const ws = await makeWorkspace("ap-combo-ok");
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws, "combo-ok");
      const ok = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        boxId,
        assigneeKind: "agentProfile",
        profileId: FAKE_DEFAULT_PROFILE_ID,
        prompt: "combined success",
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!ok.error, JSON.stringify(ok.error));
      const result = ok.result as {
        taskPath: string;
        state: string;
        session?: { session?: { sessionId?: string }; sessionId?: string };
      };
      assert.equal(result.state, "running");
      const sessionId =
        result.session?.session?.sessionId ?? result.session?.sessionId;
      assert.ok(sessionId);
      assert.match(String(sessionId), /^ss-/);

      const envFs = new NodeFs(path.join(ws, ".tent"));
      const task = await loadTaskEnvelope(envFs, result.taskPath);
      assert.equal(task.state, "running");
      assert.equal(task.sessionId, sessionId);

      const proj = await rpc(svc, "box.projection", { workspaceId, boxId });
      const projection = proj.result as { status: string; activeTaskId?: string };
      assert.equal(projection.status, "doing");
      assert.ok(projection.activeTaskId);
    });
  }

  // Separate claim + startSession APIs are unchanged: deny still leaves running occupation.
  {
    const ws = await makeWorkspace(
      "ap-separate-deny",
      { orchestrator: "deny" },
      { orchestrator: ["fake-default"] }
    );
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws, "separate-deny");
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        assigneeKind: "agentProfile",
        profileId: "fake-default",
        prompt: "separate path deny",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const denied = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "fake-default",
        callerKind: "role",
      });
      assert.ok(denied.error);
      assert.equal(denied.error!.code, RPC_A2A_DENIED);

      const envFs = new NodeFs(path.join(ws, ".tent"));
      const task = await loadTaskEnvelope(envFs, taskPath);
      assert.equal(task.state, "running");
      assert.ok(!task.sessionId);

      const proj = await rpc(svc, "box.projection", { workspaceId, boxId });
      const projection = proj.result as { status: string };
      assert.equal(projection.status, "doing");
    });
  }
});

test("combined dispatch compensation skips when Session binds concurrently", async () => {
  // Deterministic race: pause compensation, bind sessionId via concurrent startSession,
  // then prove compensation skips (Task stays running with sessionId; Session not stopped).
  const ws = await makeWorkspace(
    "ap-combo-race",
    { orchestrator: "deny" },
    { orchestrator: ["fake-default"] }
  );
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ap-race-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  resetManagedAutoDeliverDedupForTests();
  try {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws, "combo-race");

    let taskPathForRace = "";
    let concurrentBindDone = false;

    setBeforeCombinedDispatchCompensateForTests(async (input) => {
      taskPathForRace = input.taskPath;
      // Pause point is before MutationBus: concurrent user startSession binds sessionId.
      // User caller bypasses A2A deny that rejected the combined path.
      const bind = await rpc(svc, "task.startSession", {
        workspaceId: input.workspaceId,
        taskPath: input.taskPath,
        profileId: "fake-default",
        callerKind: "user",
      });
      assert.ok(!bind.error, JSON.stringify(bind.error));
      concurrentBindDone = true;
    });

    const denied = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "combined race bind-before-compensate",
      startSession: true,
      callerKind: "role",
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, RPC_A2A_DENIED);
    assert.ok(concurrentBindDone);
    assert.ok(taskPathForRace);

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, taskPathForRace);
    assert.equal(task.state, "running", "compensation must not interrupt after concurrent bind");
    assert.ok(task.sessionId, "sessionId from concurrent bind must remain");
    assert.match(String(task.sessionId), /^ss-/);

    const got = await rpc(svc, "session.get", {
      workspaceId,
      sessionId: task.sessionId,
    });
    assert.ok(!got.error, JSON.stringify(got.error));
    const session = got.result as {
      session?: { id?: string; state?: string };
      id?: string;
      state?: string;
    };
    const sessionState = session.session?.state ?? session.state;
    assert.ok(
      sessionState && !/stopped|failed|exited|interrupted/i.test(sessionState),
      `Session must not be stopped by compensation: ${JSON.stringify(got.result)}`
    );

    const proj = await rpc(svc, "box.projection", { workspaceId, boxId });
    const projection = proj.result as { status: string; activeTaskId?: string };
    assert.equal(projection.status, "doing");
    assert.ok(projection.activeTaskId);
  } finally {
    setBeforeCombinedDispatchCompensateForTests(null);
    resetManagedAutoDeliverDedupForTests();
    await svc.stop();
  }
});

test("missing assigneeKind on historical envelope reads as role", async () => {
  const ws = await makeWorkspace("ap-legacy");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      role: "executor",
      prompt: "legacy strip",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    const abs = path.join(ws, ".tent", taskPath);
    let raw = await fs.readFile(abs, "utf8");
    raw = raw.replace(/\nassigneeKind: role\r?\n/, "\n");
    await fs.writeFile(abs, raw);

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.ok(!got.error);
    const task = (got.result as { task: { assigneeKind?: string; role: string } }).task;
    assert.equal(task.assigneeKind, "role");
    assert.equal(task.role, "executor");
  });
});

test("direct runtime profile session does not block role delete", async () => {
  const ws = await makeWorkspace("ap-rt-del");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    await svc.runtime.startSession({
      sessionId: makeSessionId(),
      profileId: "fake-default",
      roleName: "executor",
      assigneeKind: "agentProfile",
      workspace: workspaceId,
      cwd: ws,
      runtimeWorkspace: { cwd: ws },
    });
    const del = await rpc(svc, "registry.role.delete", {
      workspaceId,
      name: "executor",
      confirmation: "executor",
    });
    assert.ok(!del.error, JSON.stringify(del.error));
  });
});
