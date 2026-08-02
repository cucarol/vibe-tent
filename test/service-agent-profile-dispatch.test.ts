/**
 * Temporary Settings route task dispatch: paths, lanes, concurrency, discovery.
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
  resetManagedAutoDeliverDedupForTests,
  setBeforeCombinedDispatchCompensateForTests,
} from "../src/service/handlers.js";
import type { SettingsRouteConfig } from "../src/runtime/types.js";
import { createSettingsRouteSnapshot } from "../src/runtime/route-config.js";
import { configureTestGitIdentity, git } from "./helpers.js";

const FAKE_DEFAULT_ROUTE_ID = "fake-default";
const FAKE_ROUTE: SettingsRouteConfig = {
  routeId: FAKE_DEFAULT_ROUTE_ID,
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, sleepMs: 60_000 },
};

/** Catalog with fake-default plus a deterministic launch-fail route. */
function routesWithLaunchFail(): SettingsRouteConfig[] {
  return [
    FAKE_ROUTE,
    {
      routeId: "fake-launch-fail",
      provider: "fake",
      adapterId: FAKE_ADAPTER_ID,
      fake: { failLaunch: "deterministic launch failure for combined dispatch" },
    },
  ];
}

async function makeWorkspace(
  name = "ap-dispatch"
): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ap-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          {
            name: "executor",
            prompt: "do work",
          },
          {
            name: "orchestrator",
            prompt: "dispatch work",
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
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true, routes: [FAKE_ROUTE] });
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
    nodeId: (created.result as { nodeId: string }).nodeId,
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

test("route dispatch: envelope path, task-scoped manifest, no init/registry/tent-role", async () => {
  const ws = await makeWorkspace("ap-basic");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const beforeRoles = await loadRolesRegistry(new NodeFs(path.join(ws, ".tent")));
    const roleCount = beforeRoles.roles.length;

    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "one-shot route work",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const result = d.result as {
      taskPath: string;
      manifestPath: string;
      initPath?: string;
      assigneeKind: string;
      assigneeId: string;
      relayPrompt: string;
      workspaceLane?: unknown;
    };
    assert.equal(result.assigneeKind, "route");
    assert.equal(result.assigneeId, "fake-default");
    assert.equal(result.initPath, undefined);
    assert.match(result.taskPath, /^temp\/routes\/fake-default\/tasks\//);
    assert.match(
      result.manifestPath,
      /^temp\/routes\/fake-default\/manifests\/tk-.+\.yml$/
    );
    // Non-Git peer profile: no Git lane fields; authority-only projection is mandatory.
    const lane = result.workspaceLane as
      | {
          workspace?: string;
          worktree?: string;
          branch?: string;
          targetBranch?: string;
          baseCommit?: string;
          integrationAuthority?: { mutator: string; actor: { kind: string; id: string } };
        }
      | undefined;
    assert.ok(lane, "non-Git peer still projects authority-only workspaceLane");
    assert.equal(lane!.workspace, undefined);
    assert.equal(lane!.worktree, undefined);
    assert.equal(lane!.branch, undefined);
    assert.equal(lane!.targetBranch, undefined);
    assert.equal(lane!.baseCommit, undefined);
    assert.deepEqual(lane!.integrationAuthority, {
      actor: { kind: "user", id: "user" },
      mutator: "service",
    });
    assert.match(result.relayPrompt, /route fake-default/);
    assert.doesNotMatch(result.relayPrompt, /Role init file/);
    assert.match(result.relayPrompt, /do not look for a role init/i);

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, result.taskPath);
    assert.equal(task.assigneeKind, "route");
    assert.equal(task.assigneeId, "fake-default");
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

test("role dispatch creates init + task-scoped manifest + role path", async () => {
  const ws = await makeWorkspace("ap-role-reg");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "role",
      assigneeId: "executor",
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
    assert.match(
      result.manifestPath,
      /^temp\/executor\/manifests\/tk-.+\.yml$/
    );
    assert.match(result.taskPath, /^temp\/executor\/tasks\//);
    assert.match(result.relayPrompt, /role executor/);
    assert.match(result.relayPrompt, /Role init file/);

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, result.taskPath);
    assert.equal(taskAssigneeKindOrRole(task.assigneeKind), "role");
    assert.equal(task.assigneeId, "executor");
    assert.ok(await envFs.exists("temp/executor/init.md"));
    assert.ok(await envFs.exists(result.manifestPath));
    assert.equal(await envFs.exists("temp/executor/manifest.yml"), false);
  });
});

test("routes is reserved from durable role registration and dispatch", async () => {
  const ws = await makeWorkspace("ap-reserved-role");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const created = await rpc(svc, "registry.role.create", {
      workspaceId,
      name: "routes",
      prompt: "must not shadow the profile namespace",
    });
    assert.ok(created.error);
    assert.match(String(created.error!.message), /reserved/i);

    const dispatched = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "role",
      assigneeId: "routes",
      prompt: "must not enter the reserved namespace",
    });
    assert.ok(dispatched.error);
    assert.match(String(dispatched.error!.message), /reserved/i);
  });
});

function taskAssigneeKindOrRole(kind: string | undefined): string {
  return kind === "route" ? "route" : "role";
}

test("Git route task gets tent-task/<taskId> isolated lane; commits from that lane only", async () => {
  const ws = await makeWorkspace("ap-git-lane");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "git route lane",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    // Peer profile: no Git lane at dispatch; authority-only projection is mandatory.
    const dispatchLane = (
      d.result as {
        workspaceLane?: {
          branch?: string;
          worktree?: string;
          baseCommit?: string;
          integrationAuthority?: { mutator: string; actor: { kind: string; id: string } };
        };
      }
    ).workspaceLane;
    assert.ok(dispatchLane, "peer profile still projects authority-only workspaceLane at dispatch");
    assert.equal(dispatchLane!.branch, undefined);
    assert.equal(dispatchLane!.worktree, undefined);
    assert.equal(dispatchLane!.baseCommit, undefined);
    assert.deepEqual(dispatchLane!.integrationAuthority, {
      actor: { kind: "user", id: "user" },
      mutator: "service",
    });

    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
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

    // Role lane must not exist for the route id.
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

test("startSession uses the exact Task route; two same-route tasks concurrent", async () => {
  const ws = await makeWorkspace("ap-concurrent");
  await withService(async (svc) => {
    const a = await mountWorkItem(svc, ws, "box-a");
    const boxB = await rpc(svc, "docs.createNote", {
      workspaceId: a.workspaceId,
      name: "box-b",
      type: "prompt",
    });
    const nodeIdB = (boxB.result as { nodeId: string }).nodeId;

    const d1 = await rpc(svc, "task.dispatch", {
      workspaceId: a.workspaceId,
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      nodeIds: [a.nodeId],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "first",
    });
    const d2 = await rpc(svc, "task.dispatch", {
      workspaceId: a.workspaceId,
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      nodeIds: [nodeIdB],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "second",
    });
    assert.ok(!d1.error && !d2.error);
    const t1 = (d1.result as { taskPath: string }).taskPath;
    const t2 = (d2.result as { taskPath: string }).taskPath;

    await rpc(svc, "task.claim", { workspaceId: a.workspaceId, taskPath: t1 });
    await rpc(svc, "task.claim", { workspaceId: a.workspaceId, taskPath: t2 });

    const s1 = await rpc(svc, "task.startSession", {
      workspaceId: a.workspaceId,
      taskPath: t1,
      callerKind: "user",
    });
    const s2 = await rpc(svc, "task.startSession", {
      workspaceId: a.workspaceId,
      taskPath: t2,
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
      callerKind: "user",
    });
    assert.ok(!s1b.error);
    assert.equal(
      (s1b.result as { session: { sessionId: string } }).session.sessionId,
      id1
    );
  });
});

test("Settings routes work for user and Role callers without roster authorization", async () => {
  const ws = await makeWorkspace("route-authority");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);

    // User path always works.
    const userDispatch = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "user starts profile",
    });
    const userPath = (userDispatch.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: userPath });
    const userStart = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: userPath,
      callerKind: "user",
    });
    assert.ok(!userStart.error, JSON.stringify(userStart.error));
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: userPath });

    // callerKind is launch context only; persisted Task actors remain authoritative.
    const box2 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "box-2",
      type: "prompt",
    });
    const nodeId2 = (box2.result as { nodeId: string }).nodeId;
    const noDisp = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [nodeId2],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "no dispatcher",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    });
    const noDispPath = (noDisp.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: noDispPath });
    const crossCaller = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: noDispPath,
      callerKind: "role",
    });
    assert.ok(!crossCaller.error, JSON.stringify(crossCaller.error));
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: noDispPath });

    // A durable Role may use any available machine Settings route.
    const box3 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "box-3",
      type: "prompt",
    });
    const nodeId3 = (box3.result as { nodeId: string }).nodeId;
    const orch = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [nodeId3],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "orch dispatch",
      callerKind: "role",
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    const orchPath = (orch.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: orchPath });
    const ok = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: orchPath,
      callerKind: "role",
    });
    assert.ok(!ok.error, JSON.stringify(ok.error));
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: orchPath });

    // Retired roster mutation fails loud and does not affect route availability.
    const retiredRoster = await rpc(svc, "registry.role.update", {
      workspaceId,
      name: "orchestrator",
      roster: [],
    });
    assert.equal(retiredRoster.error?.code, -32602);
    const box3b = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "box-3b",
      type: "prompt",
    });
    const nodeId3b = (box3b.result as { nodeId: string }).nodeId;
    const orchDenied = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [nodeId3b],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "orch deny whitelist",
      callerKind: "role",
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    const orchDeniedPath = (orchDenied.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: orchDeniedPath });
    const afterRetiredRoster = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: orchDeniedPath,
      callerKind: "role",
    });
    assert.ok(!afterRetiredRoster.error, JSON.stringify(afterRetiredRoster.error));
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: orchDeniedPath });

    // Role policy is unrelated to machine route launch.
    const box4 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "box-4",
      type: "prompt",
    });
    const nodeId4 = (box4.result as { nodeId: string }).nodeId;
    const execDisp = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [nodeId4],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "executor dispatch",
      callerKind: "role",
      parentActor: { kind: "role", id: "executor" },
      reviewer: { kind: "role", id: "executor" },
    });
    const execPath = (execDisp.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: execPath });
    const roleRoute = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: execPath,
      callerKind: "role",
    });
    assert.ok(!roleRoute.error, JSON.stringify(roleRoute.error));
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: execPath });
  });
});

test("role deletion not blocked by same-named route session", async () => {
  const ws = await makeWorkspace("ap-role-del");
  await withService(async (svc) => {
    const workspaceId = (
      await rpc(svc, "workspace.mount", { workspaceRoot: ws })
    ).result as { workspaceId: string };
    const wid = workspaceId.workspaceId;

    // Create a durable role with the same name as a route id we will use.
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
    const nodeId = (note.result as { nodeId: string }).nodeId;
    const d = await rpc(svc, "task.dispatch", {
      workspaceId: wid,
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      nodeIds: [nodeId],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "route session",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId: wid, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId: wid,
      taskPath,
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

test("task discovery and retention see nested route tasks", async () => {
  const ws = await makeWorkspace("ap-discover");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "discover me",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;

    const listed = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!listed.error);
    const tasks = (listed.result as { tasks: { path: string; assigneeKind?: string }[] })
      .tasks;
    assert.ok(tasks.some((t) => t.path === taskPath));
    const found = tasks.find((t) => t.path === taskPath)!;
    assert.equal(found.assigneeKind, "route");

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

test("claim projects assignee=routeId; delivery submitter is routeId", async () => {
  const ws = await makeWorkspace("ap-claim-deliv");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "route",
      assigneeId: "fake-default",
      prompt: "claim and deliver",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    const proj = await rpc(svc, "node.collaboration", { workspaceId, nodeId });
    assert.ok(!proj.error, JSON.stringify(proj.error));
    const projection = proj.result as {
      activeTask: null | { task: { assigneeId?: string } };
    };
    assert.ok(projection.activeTask);
    assert.equal(projection.activeTask?.task.assigneeId, "fake-default");

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "profile delivery",
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const delivery = (delivered.result as { delivery: { path: string } })
      .delivery;
    assert.match(
      delivery.path,
      /^temp\/routes\/fake-default\/deliveries\/dl-/
    );

    // Self-accept still forbidden when actor equals submitter routeId.
    const selfAccept = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "fake-default",
    });
    assert.ok(selfAccept.error);
    assert.match(String(selfAccept.error!.message), /self|submitter/i);

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const deliveries = await loadDeliveries(envFs);
    assert.ok(deliveries.some((x) => x.taskId));
  });
});

test("invalid/missing assignee combinations fail loud", async () => {
  const ws = await makeWorkspace("ap-invalid");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);

    const missingRole = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      prompt: "no role",
    });
    assert.ok(missingRole.error);
    assert.equal(missingRole.error!.code, -32602);

    const missingProfile = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "route",
      prompt: "no profile",
    });
    assert.ok(missingProfile.error);
    assert.equal(missingProfile.error!.code, -32602);
    assert.match(String(missingProfile.error!.message), /assigneeId/i);

    const unknownProfile = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "route",
      assigneeId: "missing-profile",
      prompt: "unknown profile",
    });
    assert.ok(unknownProfile.error);
    assert.equal(unknownProfile.error!.code, -32004);
    assert.match(String(unknownProfile.error!.message), /Settings route not found/i);

    const conflict = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "route",
      assigneeId: "fake-default",
      routeId: "fake-default",
      prompt: "conflict",
    });
    assert.ok(conflict.error);
    assert.equal(conflict.error!.code, -32602);
    assert.match(String(conflict.error!.message), /unknown parameter: routeId/i);

    const badKind = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "wizard",
      prompt: "bad kind",
    });
    assert.ok(badKind.error);
    assert.equal(badKind.error!.code, -32602);

    for (const retired of [
      { agentId: "old-worker" },
      { routeId: "fake-default" },
    ]) {
      const oldWire = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        nodeIds: [nodeId],
        assigneeKind: "route",
        prompt: "retired route wire",
        ...retired,
      });
      assert.equal(oldWire.error?.code, -32602);
      assert.match(String(oldWire.error?.message), /unknown parameter: (agentId|routeId)/i);
    }

    const oldAgentKind = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "agent",
      assigneeId: "fake-default",
      prompt: "retired assignee kind",
    });
    assert.equal(oldAgentKind.error?.code, -32602);

    // startSession without routeId still fails.
    const roleD = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "role",
      assigneeId: "executor",
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
  // Role callers use an available Settings route directly; no A2A/roster gate.
  {
    const ws = await makeWorkspace("route-combined-role");
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "combined-role");
      const started = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        assigneeKind: "route",
        assigneeId: "fake-default",
        prompt: "combined role route",
        startSession: true,
        callerKind: "role",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const result = started.result as { state: string; session?: unknown };
      assert.equal(result.state, "running");
      assert.ok(result.session);
    });
  }

  // Invalid / missing profile or start precondition: original error; no stale running claim.
  {
    const ws = await makeWorkspace("ap-combo-invalid");
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "combo-invalid");

      const unknown = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        nodeIds: [nodeId],
        assigneeKind: "route",
        assigneeId: "missing-profile-xyz",
        prompt: "unknown profile combined",
        startSession: true,
      });
      assert.ok(unknown.error);
      assert.equal(unknown.error!.code, -32004);
      assert.match(String(unknown.error!.message), /Settings route not found/i);

      const missingProfileId = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        nodeIds: [nodeId],
        assigneeKind: "route",
        prompt: "start without routeId",
        startSession: true,
      });
      assert.ok(missingProfileId.error);
      assert.equal(missingProfileId.error!.code, -32602);
      assert.match(String(missingProfileId.error!.message), /assigneeId/i);

      // Failed combined attempts must not leave a running route occupation.
      const listed = await rpc(svc, "task.list", { workspaceId });
      const tasks = (listed.result as { tasks: { path: string; state: string }[] }).tasks;
      assert.ok(
        !tasks.some((t) => t.path.includes("routes") && t.state === "running"),
        JSON.stringify(tasks)
      );
      assert.ok(
        !tasks.some((t) => t.state === "running"),
        `stale running tasks: ${JSON.stringify(tasks)}`
      );

      const proj = await rpc(svc, "node.collaboration", { workspaceId, nodeId });
      const projection = proj.result as { activeTask: unknown | null };
      assert.equal(projection.activeTask, null);
    });
  }

  // Provider launch failure: honest failed state from startSession path; no interrupt overwrite.
  {
    const ws = await makeWorkspace("ap-combo-launch-fail");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ap-launch-"));
    const svc = await startLocalTentService({
      dataDir,
      writeEndpoint: true,
      routes: routesWithLaunchFail(),
    });
    try {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "combo-launch");
      const failed = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        nodeIds: [nodeId],
        assigneeKind: "route",
        assigneeId: "fake-launch-fail",
        prompt: "combined launch fail",
        startSession: true,
        callerKind: "user",
      });
      assert.ok(failed.error);
      assert.match(String(failed.error!.message), /deterministic launch failure/i);

      const listed = await rpc(svc, "task.list", { workspaceId });
      const tasks = (listed.result as { tasks: { path: string; state: string; sessionId?: string }[] })
        .tasks;
      const routeTasks = tasks.filter((t) => t.path.includes("fake-launch-fail"));
      assert.equal(routeTasks.length, 1);
      assert.equal(routeTasks[0]!.state, "failed");
      assert.ok(!routeTasks[0]!.sessionId);

      const envFs = new NodeFs(path.join(ws, ".tent"));
      const task = await loadTaskEnvelope(envFs, routeTasks[0]!.path);
      assert.equal(task.state, "failed");
      assert.ok(await envFs.exists(routeTasks[0]!.path));

      const proj = await rpc(svc, "node.collaboration", { workspaceId, nodeId });
      const projection = proj.result as { activeTask: unknown | null };
      assert.equal(projection.activeTask, null);
    } finally {
      await svc.stop();
    }
  }

  // Success: running + sessionId; occupation held.
  {
    const ws = await makeWorkspace("ap-combo-ok");
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "combo-ok");
      const ok = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        nodeIds: [nodeId],
        assigneeKind: "route",
        assigneeId: FAKE_DEFAULT_ROUTE_ID,
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

      const proj = await rpc(svc, "node.collaboration", { workspaceId, nodeId });
      const projection = proj.result as { activeTask: unknown | null };
      assert.ok(projection.activeTask);
    });
  }

});

test("missing assigneeKind on a historical envelope fails loud", async () => {
  const ws = await makeWorkspace("ap-legacy");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "role",
      assigneeId: "executor",
      prompt: "legacy strip",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    const abs = path.join(ws, ".tent", taskPath);
    let raw = await fs.readFile(abs, "utf8");
    raw = raw.replace(/\nassigneeKind: role\r?\n/, "\n");
    await fs.writeFile(abs, raw);

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.ok(got.error);
    assert.equal(got.error!.code, -32000);
    assert.match(String(got.error!.message), /assigneeKind|invalid/i);
  });
});

test("direct runtime route session does not block role delete", async () => {
  const ws = await makeWorkspace("ap-rt-del");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    await svc.runtime.startSession({
      sessionId: makeSessionId(),
      routeId: "fake-default",
      routeSnapshot: createSettingsRouteSnapshot(FAKE_ROUTE, {}),
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
