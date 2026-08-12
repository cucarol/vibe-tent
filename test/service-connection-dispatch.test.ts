/**
 * Temporary Agent Connection Task dispatch: paths, lanes, concurrency, discovery.
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
import { loadTaskEnvelope } from "../src/core/task.js";
import { loadDeliveries } from "../src/core/delivery.js";
import { loadRolesRegistry } from "../src/core/skillRoleRegistry.js";
import { previewOperationalRetention } from "../src/core/retention.js";
import { ensureTaskWorkspace } from "../src/core/workspace.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import {
  resetManagedAutoDeliverDedupForTests,
  setBeforeTaskClaimCoreForTests,
} from "../src/service/handlers.js";
import type { AgentConnectionConfig } from "../src/runtime/agent-connection.js";
import { configureTestGitIdentity, git } from "./helpers.js";

const FAKE_DEFAULT_CONNECTION_ID = "fake-default";
const FAKE_CONNECTION: AgentConnectionConfig = {
  connectionId: FAKE_DEFAULT_CONNECTION_ID,
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, sleepMs: 60_000 },
};

/** Catalog with fake-default plus a deterministic launch-fail Connection. */
function connectionsWithLaunchFail(): AgentConnectionConfig[] {
  return [
    FAKE_CONNECTION,
    {
      connectionId: "fake-launch-fail",
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
            id: "rl-executor",
            name: "executor",
            prompt: "do work",
          },
          {
            id: "rl-orchestrator",
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
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true, connections: [FAKE_CONNECTION] });
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

test("Connection dispatch removes its exact reservation when Task creation fails", async () => {
  const ws = await makeWorkspace("connection-reservation-cleanup");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "occupied-node");
    const occupied = await rpc(svc, "task.dispatch", {
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "occupy exact Node",
      parentActor: { kind: "user", id: "user" },
    });
    assert.ok(!occupied.error, JSON.stringify(occupied.error));
    const tasksBefore = await rpc(svc, "task.list", { workspaceId });
    const sessionsBefore = await rpc(svc, "session.list", { workspaceId });

    const failed = await rpc(svc, "task.dispatch", {
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: FAKE_DEFAULT_CONNECTION_ID,
      prompt: "must fail after exact Session reservation",
      parentActor: { kind: "user", id: "user" },
    });
    assert.ok(failed.error);
    assert.match(failed.error!.message, /occupied|active Task/i);

    const tasksAfter = await rpc(svc, "task.list", { workspaceId });
    const sessionsAfter = await rpc(svc, "session.list", { workspaceId });
    assert.deepEqual(tasksAfter.result, tasksBefore.result, "failed create must not add a Task");
    assert.deepEqual(
      sessionsAfter.result,
      sessionsBefore.result,
      "failed create must remove the exact reserved Session"
    );
  });
});

test("concurrent Connection dispatch atomically claims one exact-Node Task and leaves no queued orphan", async () => {
  const ws = await makeWorkspace("connection-atomic-claim");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "atomic-node");
    const payload = (prompt: string) => ({
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: FAKE_DEFAULT_CONNECTION_ID,
      prompt,
      parentActor: { kind: "user" as const, id: "user" },
    });

    const [first, second] = await Promise.all([
      rpc(svc, "task.dispatch", payload("atomic contender one")),
      rpc(svc, "task.dispatch", payload("atomic contender two")),
    ]);
    const successes = [first, second].filter((result) => !result.error);
    const failures = [first, second].filter((result) => result.error);
    assert.equal(successes.length, 1, JSON.stringify([first, second]));
    assert.equal(failures.length, 1, JSON.stringify([first, second]));
    assert.match(failures[0]!.error!.message, /occupied|active Task/i);

    const listed = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!listed.error, JSON.stringify(listed.error));
    const tasks = (listed.result as {
      tasks: Array<{ state: string; sessionId?: string; workNodeIds: string[] }>;
    }).tasks.filter((task) => task.workNodeIds.includes(nodeId));
    assert.equal(tasks.length, 1, JSON.stringify(tasks));
    assert.notEqual(tasks[0]!.state, "queued");
    assert.match(tasks[0]!.sessionId ?? "", /^ss-/);

    const sessions = await rpc(svc, "session.list", { workspaceId });
    assert.ok(!sessions.error, JSON.stringify(sessions.error));
    const rows = (sessions.result as {
      sessions: Array<{ sessionId: string; state: string; lastTaskId?: string }>;
    }).sessions;
    assert.equal(rows.some((row) => row.state === "reserved"), false, JSON.stringify(rows));
    assert.equal(rows.length, 1, JSON.stringify(rows));
  });
});

test("Connection dispatch claim persistence failure leaves an interrupted Task and failed Session audit", async () => {
  const ws = await makeWorkspace("connection-claim-failure");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "claim-failure-node");
    setBeforeTaskClaimCoreForTests(async ({ task }) => {
      if (task.sessionId) throw new Error("injected atomic Connection claim failure");
    });
    try {
      const failed = await rpc(svc, "task.dispatch", {
        workspaceId,
        workNodeIds: [nodeId],
        contextNodeIds: [],
        connectionId: FAKE_DEFAULT_CONNECTION_ID,
        prompt: "claim must fail with a durable audit",
        parentActor: { kind: "user", id: "user" },
      });
      assert.ok(failed.error);
      assert.match(failed.error!.message, /injected atomic Connection claim failure/);

      const listed = await rpc(svc, "task.list", { workspaceId });
      assert.ok(!listed.error, JSON.stringify(listed.error));
      const tasks = (listed.result as {
        tasks: Array<{ state: string; sessionId?: string; workNodeIds: string[] }>;
      }).tasks.filter((task) => task.workNodeIds.includes(nodeId));
      assert.equal(tasks.length, 1, JSON.stringify(listed.result));
      assert.equal(tasks[0]!.state, "interrupted");
      assert.match(tasks[0]!.sessionId ?? "", /^ss-/);

      const exact = await svc.runtime.registry.read(tasks[0]!.sessionId!);
      assert.ok(exact);
      assert.equal(exact!.state, "failed");
      assert.match(exact!.lastError ?? "", /injected atomic Connection claim failure/);
    } finally {
      setBeforeTaskClaimCoreForTests(null);
    }
  });
});

test("Connection dispatch: Session path, task-scoped manifest, no Role identity", async () => {
  const ws = await makeWorkspace("ap-basic");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const beforeRoles = await loadRolesRegistry(new NodeFs(path.join(ws, ".tent")));
    const roleCount = beforeRoles.roles.length;

    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "one-shot Connection work",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const result = d.result as {
      taskPath: string;
      manifestPath: string;
      initPath?: string;
      roleId?: string;
      sessionId: string;
      relayPrompt: string;
      workspaceLane?: unknown;
    };
    assert.equal(result.roleId, undefined);
    assert.match(result.sessionId, /^ss-/);
    assert.equal(result.initPath, undefined);
    assert.match(result.taskPath, /^temp\/sessions\/ss-[a-z0-9]+\/tasks\//);
    assert.match(
      result.manifestPath,
      /^temp\/sessions\/ss-[a-z0-9]+\/manifests\/tk-.+\.yml$/
    );
    // Non-Git Connection work has no Git lane fields; authority projection remains explicit.
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
    assert.match(result.relayPrompt, /session/i);
    assert.doesNotMatch(result.relayPrompt, /Role init file/);
    assert.match(result.relayPrompt, /no Role init applies/i);

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, result.taskPath);
    assert.equal(task.roleId, undefined);
    assert.equal(task.sessionId, result.sessionId);
    assert.equal(task.manifest, result.manifestPath);
    assert.ok(task.id?.startsWith("tk-"));

    // No durable role init, no shared manifest.yml, no tent-role lane.
    assert.equal(await envFs.exists(`temp/sessions/${result.sessionId}/init.md`), false);
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
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "role path stays",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const result = d.result as {
      taskPath: string;
      manifestPath: string;
      initPath?: string;
      roleId?: string;
      relayPrompt: string;
    };
    assert.equal(result.roleId, "rl-executor");
    assert.equal(result.initPath, "temp/roles/rl-executor/init.md");
    assert.match(
      result.manifestPath,
      /^temp\/roles\/rl-executor\/manifests\/tk-.+\.yml$/
    );
    assert.match(result.taskPath, /^temp\/roles\/rl-executor\/tasks\//);
    assert.match(result.relayPrompt, /Role rl-executor/);
    assert.match(result.relayPrompt, /Role init file/);

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, result.taskPath);
    assert.equal(task.roleId, "rl-executor");
    assert.ok(await envFs.exists("temp/roles/rl-executor/init.md"));
    assert.ok(await envFs.exists(result.manifestPath));
    assert.equal(await envFs.exists("temp/roles/rl-executor/manifest.yml"), false);
  });
});

test("Git Connection Task gets tent-task/<taskId> isolated lane before provider start", async () => {
  const ws = await makeWorkspace("ap-git-lane");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "git Connection lane",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    // Connection work receives its exact Git lane before the durable Task is written.
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
    assert.ok(dispatchLane, "Connection Task projects its exact workspaceLane at dispatch");
    assert.match(dispatchLane!.branch || "", /^tent-task\//);
    assert.ok(dispatchLane!.worktree);
    assert.match(dispatchLane!.baseCommit || "", /^[0-9a-f]{40}$/);
    assert.deepEqual(dispatchLane!.integrationAuthority, {
      actor: { kind: "user", id: "user" },
      mutator: "service",
    });

    const started = d.result as {
      session: {
        task: {
          id?: string;
          workspaceLane?: { branch?: string; worktree?: string };
          roleBranchBase?: string;
        };
        session: { cwd?: string; connectionId?: string };
      };
    };
    const task = started.session.task;
    const session = started.session.session;
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

    // Role lane must not exist for the Connection id.
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

test("Connection dispatch binds two same-Connection Tasks to independent Sessions", async () => {
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
      workNodeIds: [a.nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "first",
    });
    const d2 = await rpc(svc, "task.dispatch", {
      workspaceId: a.workspaceId,
      parentActor: { kind: "user", id: "user" },
      workNodeIds: [nodeIdB],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "second",
    });
    assert.ok(!d1.error && !d2.error);
    const t1 = (d1.result as { taskPath: string }).taskPath;
    const t2 = (d2.result as { taskPath: string }).taskPath;

    const id1 = (d1.result as { sessionId: string }).sessionId;
    const id2 = (d2.result as { sessionId: string }).sessionId;
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

test("Agent Connections work for user and Role callers without identity pre-registration", async () => {
  const ws = await makeWorkspace("connection-authority");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);

    // User path always works.
    const userDispatch = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "user starts Connection",
    });
    const userPath = (userDispatch.result as { taskPath: string }).taskPath;
    assert.ok(!userDispatch.error, JSON.stringify(userDispatch.error));
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
      workNodeIds: [nodeId2],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "no dispatcher",
      parentActor: { kind: "user", id: "user" },
    });
    const noDispPath = (noDisp.result as { taskPath: string }).taskPath;
    assert.ok(!noDisp.error, JSON.stringify(noDisp.error));
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: noDispPath });

    // A durable Role may delegate to any available machine Agent Connection.
    const box3 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "box-3",
      type: "prompt",
    });
    const nodeId3 = (box3.result as { nodeId: string }).nodeId;
    const orch = await rpc(svc, "task.dispatch", {
      workspaceId,
      workNodeIds: [nodeId3],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "orch dispatch",
      parentActor: { kind: "role", id: "rl-orchestrator" },
    });
    const orchPath = (orch.result as { taskPath: string }).taskPath;
    assert.ok(!orch.error, JSON.stringify(orch.error));
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: orchPath });

    // Role identity remains separate from machine Connection launch.
    const box4 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "box-4",
      type: "prompt",
    });
    const nodeId4 = (box4.result as { nodeId: string }).nodeId;
    const execDisp = await rpc(svc, "task.dispatch", {
      workspaceId,
      workNodeIds: [nodeId4],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "executor dispatch",
      parentActor: { kind: "role", id: "rl-executor" },
    });
    const execPath = (execDisp.result as { taskPath: string }).taskPath;
    assert.ok(!execDisp.error, JSON.stringify(execDisp.error));
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: execPath });
  });
});

test("Role deletion is not blocked by a same-named Agent Connection Session", async () => {
  const ws = await makeWorkspace("ap-role-del");
  await withService(async (svc) => {
    const workspaceId = (
      await rpc(svc, "workspace.mount", { workspaceRoot: ws })
    ).result as { workspaceId: string };
    const wid = workspaceId.workspaceId;

    // Create a durable Role with the same display name as a Connection id.
    await rpc(svc, "registry.role.create", {
      workspaceId: wid,
      name: "fake-default",
      prompt: "coincidental name",
    });

    const note = await rpc(svc, "docs.createNote", {
      workspaceId: wid,
      name: "connection-work",
      type: "prompt",
    });
    const nodeId = (note.result as { nodeId: string }).nodeId;
    const d = await rpc(svc, "task.dispatch", {
      workspaceId: wid,
      parentActor: { kind: "user", id: "user" },
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "Connection Session",
    });
    assert.ok(!d.error, JSON.stringify(d.error));

    // Connection Session must not block Role deletion.
    const del = await rpc(svc, "registry.role.delete", {
      workspaceId: wid,
      name: "fake-default",
      confirmation: "fake-default",
    });
    assert.ok(!del.error, JSON.stringify(del.error));
  });
});

test("task discovery and retention see nested Session Tasks", async () => {
  const ws = await makeWorkspace("ap-discover");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "discover me",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;

    const listed = await rpc(svc, "task.list", { workspaceId });
    assert.ok(!listed.error);
    const tasks = (listed.result as { tasks: { path: string; sessionId?: string }[] })
      .tasks;
    assert.ok(tasks.some((t) => t.path === taskPath));
    const found = tasks.find((t) => t.path === taskPath)!;
    assert.match(found.sessionId || "", /^ss-/);

    // Accept so retention can see terminal candidate under nested path.
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "done",
    });
    await rpc(svc, "task.accept", {
      workspaceId,
      deliveryId: (delivered.result as { delivery: { id: string } }).delivery.id,
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

test("Connection Task projects exact Session and Delivery remains Task-scoped", async () => {
  const ws = await makeWorkspace("ap-claim-deliv");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "claim and deliver",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    const proj = await rpc(svc, "node.collaboration", { workspaceId, nodeId });
    assert.ok(!proj.error, JSON.stringify(proj.error));
    const projection = proj.result as {
      activeTask: null | { task: { roleId?: string; sessionId?: string } };
    };
    assert.ok(projection.activeTask);
    assert.equal(projection.activeTask?.task.roleId, undefined);
    assert.match(projection.activeTask?.task.sessionId || "", /^ss-/);

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "Connection Task delivery",
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const delivery = (delivered.result as { delivery: { id: string; path: string } })
      .delivery;
    assert.match(
      delivery.path,
      /^temp\/sessions\/ss-[a-z0-9]+\/deliveries\/dl-/
    );

    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      deliveryId: delivery.id,
      actor: "user",
    });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const deliveries = await loadDeliveries(envFs);
    assert.ok(deliveries.some((x) => x.taskId));
  });
});

test("invalid/missing Role-or-Connection assignment combinations fail loud", async () => {
  const ws = await makeWorkspace("ap-invalid");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);

    const missingAssignment = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      prompt: "no durable Role or Session allocator",
    });
    assert.ok(missingAssignment.error);
    assert.equal(missingAssignment.error!.code, -32602);

    const unknownConnection = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "missing-connection",
      prompt: "unknown Connection",
    });
    assert.ok(unknownConnection.error);
    assert.equal(unknownConnection.error!.code, -32004);
    assert.match(String(unknownConnection.error!.message), /Agent Connection not found/i);

    const both = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      connectionId: "fake-default",
      prompt: "ambiguous assignment",
    });
    assert.ok(both.error);
    assert.equal(both.error!.code, -32602);
    assert.match(String(both.error!.message), /exactly one of roleId or connectionId/i);

    // A durable Role Task cannot be reinterpreted as managed ACP work.
    const roleD = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "role ok",
    });
    const taskPath = (roleD.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const noSession = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(noSession.error);
    assert.equal(noSession.error!.code, -32602);
  });
});

test("Connection dispatch reserves exact Session and parks provider launch failure", async () => {
  // Role callers delegate to an available Agent Connection directly.
  {
    const ws = await makeWorkspace("connection-combined-role");
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "combined-role");
      const started = await rpc(svc, "task.dispatch", {
        workspaceId,
        workNodeIds: [nodeId],
        contextNodeIds: [],
        connectionId: "fake-default",
        prompt: "combined Role Connection",
        parentActor: { kind: "role", id: "rl-orchestrator" },
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const result = started.result as { state: string; session?: unknown };
      assert.equal(result.state, "running");
      assert.ok(result.session);
    });
  }

  // Unknown Connection fails before Task/Session creation.
  {
    const ws = await makeWorkspace("ap-combo-invalid");
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "combo-invalid");

      const unknown = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        workspaceId,
        workNodeIds: [nodeId],
        contextNodeIds: [],
        connectionId: "missing-connection",
        prompt: "unknown Connection",
      });
      assert.ok(unknown.error);
      assert.equal(unknown.error!.code, -32004);
      assert.match(String(unknown.error!.message), /Agent Connection not found/i);

      // Failed pre-reservation attempts must not leave a running occupation.
      const listed = await rpc(svc, "task.list", { workspaceId });
      const tasks = (listed.result as { tasks: { path: string; state: string }[] }).tasks;
      assert.ok(
        !tasks.some((t) => t.state === "running"),
        `stale running tasks: ${JSON.stringify(tasks)}`
      );

      const proj = await rpc(svc, "node.collaboration", { workspaceId, nodeId });
      const projection = proj.result as { activeTask: unknown | null };
      assert.equal(projection.activeTask, null);
    });
  }

  // Provider launch failure: exact Task remains waiting on the failed bound Session.
  {
    const ws = await makeWorkspace("ap-combo-launch-fail");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ap-launch-"));
    const svc = await startLocalTentService({
      dataDir,
      writeEndpoint: true,
      connections: connectionsWithLaunchFail(),
    });
    try {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "combo-launch");
      const failed = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        workspaceId,
        workNodeIds: [nodeId],
        contextNodeIds: [],
        connectionId: "fake-launch-fail",
        prompt: "combined launch fail",
      });
      assert.ok(failed.error);
      assert.match(String(failed.error!.message), /deterministic launch failure/i);

      const listed = await rpc(svc, "task.list", { workspaceId });
      const tasks = (listed.result as { tasks: { path: string; state: string; sessionId?: string }[] })
        .tasks;
      const connectionTasks = tasks.filter((t) => t.sessionId);
      assert.equal(connectionTasks.length, 1);
      assert.equal(connectionTasks[0]!.state, "waiting");
      assert.match(connectionTasks[0]!.sessionId || "", /^ss-/);

      const envFs = new NodeFs(path.join(ws, ".tent"));
      const task = await loadTaskEnvelope(envFs, connectionTasks[0]!.path);
      assert.equal(task.state, "waiting");
      assert.equal(task.wait?.code, "session_unavailable");
      assert.equal(task.sessionId, connectionTasks[0]!.sessionId);
      const session = await svc.runtime.registry.read(task.sessionId!);
      assert.equal(session?.state, "failed");
      assert.equal(session?.lastTaskId, task.id);
      assert.ok(await envFs.exists(connectionTasks[0]!.path));

      const proj = await rpc(svc, "node.collaboration", { workspaceId, nodeId });
      const projection = proj.result as { activeTask: unknown | null };
      assert.ok(projection.activeTask);
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
        workspaceId,
        workNodeIds: [nodeId],
        contextNodeIds: [],
        connectionId: FAKE_DEFAULT_CONNECTION_ID,
        prompt: "combined success",
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

test("Task envelope missing both roleId and sessionId fails loud", async () => {
  const ws = await makeWorkspace("ap-missing-assignment");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "strip canonical assignment",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    const abs = path.join(ws, ".tent", taskPath);
    let raw = await fs.readFile(abs, "utf8");
    raw = raw.replace(/\nroleId: rl-executor\r?\n/, "\n");
    await fs.writeFile(abs, raw);

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.ok(got.error);
    assert.equal(got.error!.code, -32000);
    assert.match(String(got.error!.message), /roleId|sessionId|assignment|invalid/i);
  });
});

test("managed Connection Session carries no durable Role identity", async () => {
  const ws = await makeWorkspace("ap-rt-del");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const note = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "connection-session",
      type: "prompt",
    });
    assert.ok(!note.error, JSON.stringify(note.error));
    const dispatched = await rpc(svc, "task.dispatch", {
      workspaceId,
      workNodeIds: [(note.result as { nodeId: string }).nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "managed Session without Role identity",
      parentActor: { kind: "user", id: "user" },
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const sessionId = (dispatched.result as { sessionId: string }).sessionId;
    const session = await svc.runtime.registry.read(sessionId);
    assert.equal(session?.roleId, undefined);
    assert.equal(session?.connectionId, "fake-default");
    const del = await rpc(svc, "registry.role.delete", {
      workspaceId,
      name: "executor",
      confirmation: "executor",
    });
    assert.ok(!del.error, JSON.stringify(del.error));
  });
});
