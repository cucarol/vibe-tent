/**
 * V0.2 external / pull-host session lifecycle:
 * - Runtime enterExternalSession (no ACP spawn)
 * - Service RPC session.enter / status / leave
 * - CLI tent session enter|status|leave (+ hook aliases)
 * - Idempotency, non-Tent silent exit 0 for hooks
 * - leave never deliver/accept
 */
import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDeliveries } from "../src/core/delivery.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadTaskEnvelope, patchTaskEnvelope } from "../src/core/task.js";
import { taskClaim, taskReject, taskWait } from "../src/core/task-lifecycle.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { createServiceClient } from "../src/service/client.js";
import { REJECT_RESUME_SESSION_FAILED_WAIT_SUMMARY } from "../src/service/handlers.js";
import {
  createAgentRuntime,
  makeSessionId,
  SessionRegistry,
  EXTERNAL_ADAPTER_ID,
} from "../src/runtime/index.js";
import {
  buildHookExternalKey,
  normalizeSessionSub,
  parseNativeHookStdin,
  pickNativeSessionId,
  runSessionCommand,
} from "../src/cli/session-rpc.js";
import { recordExternalKey } from "../src/runtime/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function makeWorkspace(name = "ext-sess"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ext-ws-"));
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
          { id: "rl-executor", name: "executor", prompt: "do work" },
          { id: "rl-orchestrator", name: "orchestrator", prompt: "dispatch" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function snapshotDirectoryTree(root: string): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  const visit = async (dir: string, relativeDir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = relativeDir
        ? path.join(relativeDir, entry.name)
        : entry.name;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isSymbolicLink()) {
        out.push([relativePath, `link:${await fs.readlink(absolutePath)}`]);
      } else {
        out.push([
          relativePath,
          (await fs.readFile(absolutePath)).toString("base64"),
        ]);
      }
    }
  };
  await visit(root, "");
  return out;
}

async function withService<T>(
  fn: (
    svc: Awaited<ReturnType<typeof startLocalTentService>>,
    dataDir: string
  ) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ext-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc, dataDir);
  } finally {
    await svc.stop();
  }
}

test("normalizeSessionSub maps public + hook aliases", () => {
  assert.equal(normalizeSessionSub("enter"), "enter");
  assert.equal(normalizeSessionSub("session-start"), "enter");
  assert.equal(normalizeSessionSub("status"), "status");
  assert.equal(normalizeSessionSub("session-status"), "status");
  assert.equal(normalizeSessionSub("leave"), "leave");
  assert.equal(normalizeSessionSub("session-end"), "leave");
  assert.equal(normalizeSessionSub("nope"), null);
});

test("SessionRegistry.isOpen includes external; isNonTerminal does not", () => {
  assert.equal(SessionRegistry.isNonTerminal("external"), false);
  assert.equal(SessionRegistry.isOpen("external"), true);
  assert.equal(SessionRegistry.isOpen("live"), true);
  assert.equal(SessionRegistry.isOpen("stopped"), false);
});

test("runtime enterExternalSession: no process, state=external, idempotent", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ext-rt-"));
  const runtime = createAgentRuntime({ dataDir });
  try {
    const sessionId = makeSessionId(() => 0.42);
    const h1 = await runtime.enterExternalSession({
      sessionId,
      roleId: "rl-executor",
      workspace: "ws-1",
      externalKey: "gui-key-1",
      cwd: dataDir,
    });
    assert.equal(h1.sessionId, sessionId);
    assert.equal(h1.state, "external");
    assert.equal(h1.adapterId, EXTERNAL_ADAPTER_ID);
    assert.equal(runtime.supervisor.isAlive(sessionId), false);

    const probe = await runtime.probe(sessionId);
    assert.equal(probe.state, "external");
    assert.equal(probe.alive, true);
    assert.equal(probe.resumeCapable, false);

    // Idempotent re-enter with same id
    const h2 = await runtime.enterExternalSession({
      sessionId,
      roleId: "rl-executor",
      workspace: "ws-1",
      externalKey: "gui-key-1",
    });
    assert.equal(h2.sessionId, sessionId);
    assert.equal(h2.state, "external");

    // externalKey alone reuses
    const h3 = await runtime.enterExternalSession({
      externalKey: "gui-key-1",
      workspace: "ws-1",
    });
    assert.equal(h3.sessionId, sessionId);

    await runtime.stopSession(sessionId, "user");
    const after = await runtime.probe(sessionId);
    assert.equal(after.state, "stopped");
    assert.equal(after.alive, false);
  } finally {
    await runtime.shutdown();
  }
});

test("service RPC session.enter/status/leave: idempotent, no deliver", async () => {
  await withService(async (svc, dataDir) => {
    const ws = await makeWorkspace();
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;

    const entered = (await client.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      externalKey: "rpc-key-a",
      cwd: ws,
    })) as {
      session: { sessionId: string; state: string; adapterId: string; alive: boolean };
      sessionToken: string;
      reused: boolean;
    };
    assert.equal(entered.session.state, "external");
    assert.equal(entered.session.adapterId, EXTERNAL_ADAPTER_ID);
    assert.equal(entered.session.alive, true);
    assert.equal(entered.reused, false);
    const sessionId = entered.session.sessionId;
    assert.ok(sessionId.startsWith("ss-"));
    const roleClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: sessionId,
      currentSessionToken: entered.sessionToken,
    });

    // Idempotent enter
    const again = (await client.sessionEnter({
      workspaceId,
      sessionId,
      externalKey: "rpc-key-a",
    })) as { session: { sessionId: string }; reused: boolean };
    assert.equal(again.session.sessionId, sessionId);
    assert.equal(again.reused, true);

    // A Role claim derives the exact executing Session from trusted transport
    // context; callers cannot select a Session in task.claim params.
    const note = (await client.call("docs.createNote", {
      workspaceId,
      name: "work-item",
      type: "prompt",
      body: "# work\n",
    })) as { nodeId: string };
    // Prefer task.dispatch if available via client helper
    const dispatched = (await client.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId], contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "do the thing",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };
    await roleClient.taskClaim(workspaceId, dispatched.taskPath);

    const status = (await client.sessionStatus({
      workspaceId,
      sessionId,
    })) as {
      session: { state: string };
      open: boolean;
      incompleteTasks: Array<{ path: string; state: string }>;
    };
    assert.equal(status.session.state, "external");
    assert.equal(status.open, true);
    assert.deepEqual(status.incompleteTasks.map((task) => task.path), [dispatched.taskPath]);

    const left = (await client.sessionLeave(sessionId, workspaceId)) as {
      sessionId: string;
      state: string;
      left: boolean;
      delivered: boolean;
      accepted: boolean;
      incompleteTasks: Array<{ path: string; state: string }>;
    };
    assert.equal(left.left, true);
    assert.equal(left.state, "stopped");
    assert.equal(left.delivered, false);
    assert.equal(left.accepted, false);
    assert.deepEqual(left.incompleteTasks.map((task) => task.path), [dispatched.taskPath]);
    // Leave never completes the Task; it preserves occupation in an honest,
    // recoverable wait because the exact external Session is no longer open.
    const task = (await client.taskGet(workspaceId, dispatched.taskPath)) as {
      task: { state: string; sessionId?: string };
    };
    assert.equal(task.task.state, "waiting");
    assert.equal(task.task.sessionId, sessionId);

    // Idempotent leave
    const left2 = (await client.sessionLeave(sessionId, workspaceId)) as {
      left: boolean;
      alreadyLeft: boolean;
      delivered: boolean;
    };
    assert.equal(left2.left, false);
    assert.equal(left2.alreadyLeft, true);
    assert.equal(left2.delivered, false);

    // dataDir used so service endpoint exists under test isolation
    assert.ok(dataDir);
  });
});

test("external Role reject-resume keeps the exact live Session and Task running", async () => {
  await withService(async (svc) => {
    const workspace = await makeWorkspace("external-reject-resume");
    const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await root.mount(workspace)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const entered = (await root.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      externalKey: "external-reject-resume",
      cwd: workspace,
    })) as { session: { sessionId: string }; sessionToken: string };
    const roleClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: entered.session.sessionId,
      currentSessionToken: entered.sessionToken,
    });
    const note = (await root.call("docs.createNote", {
      workspaceId,
      name: "external-reject-resume",
      type: "prompt",
      body: "# external reject resume\n",
    })) as { nodeId: string };
    const dispatched = (await root.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "external reject resume",
      parentActor: { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as { taskPath: string };
    await roleClient.taskClaim(workspaceId, dispatched.taskPath);
    const delivered = (await roleClient.taskDeliver(workspaceId, dispatched.taskPath, {
      summary: "external work ready",
    })) as { delivery: { id: string } };

    const rejected = (await root.taskReject(
      workspaceId,
      dispatched.taskPath,
      delivered.delivery.id,
      "user",
      { note: "revise externally", resume: true }
    )) as {
      task: { state: string; sessionId?: string };
      delivery: { status: string };
      accepted: boolean;
      enqueued: boolean;
    };
    assert.equal(rejected.delivery.status, "rejected");
    assert.equal(rejected.task.state, "running");
    assert.equal(rejected.task.sessionId, entered.session.sessionId);
    assert.equal(rejected.accepted, true);
    assert.equal(rejected.enqueued, false);
    const exactSession = await svc.runtime.registry.read(entered.session.sessionId);
    const exactTask = await loadTaskEnvelope(
      svc.hostApi.require(workspaceId).env.fs,
      dispatched.taskPath
    );
    assert.equal(exactSession?.lastTaskId, exactTask.id);
    assert.equal((await svc.runtime.probe(entered.session.sessionId)).state, "external");
  });
});

test("external session.leave defensively parks every exact active Task and new claims refuse a second binding", async () => {
  await withService(async (svc, dataDir) => {
    const workspace = await makeWorkspace("external-multi-task-leave");
    const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await root.mount(workspace)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const entered = (await root.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      externalKey: "external-multi-task-leave",
      cwd: workspace,
    })) as { session: { sessionId: string }; sessionToken: string };
    const sessionId = entered.session.sessionId;
    const roleClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: sessionId,
      currentSessionToken: entered.sessionToken,
    });
    const firstNode = (await root.call("docs.createNote", {
      workspaceId,
      name: "external-first-active",
      type: "prompt",
    })) as { nodeId: string };
    const secondNode = (await root.call("docs.createNote", {
      workspaceId,
      name: "external-second-active",
      type: "prompt",
    })) as { nodeId: string };
    const directNode = (await root.call("docs.createNote", {
      workspaceId,
      name: "external-direct-conflict",
      type: "prompt",
    })) as { nodeId: string };
    const first = (await root.taskDispatch(workspaceId, {
      workNodeIds: [firstNode.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "first exact external Task",
      parentActor: { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as { taskPath: string };
    await roleClient.taskClaim(workspaceId, first.taskPath);
    const firstDelivery = (await roleClient.taskDeliver(workspaceId, first.taskPath, {
      summary: "first Task ready for review",
    })) as { delivery: { id: string } };
    const rejected = (await root.taskReject(
      workspaceId,
      first.taskPath,
      firstDelivery.delivery.id,
      "user",
      { note: "preserve this exact review feedback", resume: true }
    )) as {
      input: { id: string; text?: string; status: string };
      task: { state: string };
    };
    assert.equal(rejected.task.state, "running");
    assert.equal(rejected.input.status, "pending");

    const mount = svc.hostApi.require(workspaceId);
    const directBefore = {
      temp: await snapshotDirectoryTree(path.join(workspace, "temp")),
      session: await svc.runtime.registry.read(sessionId),
    };
    const directRefused = await roleClient.tryCall("task.claimDirect", {
      workspaceId,
      roleId: "rl-executor",
      workNodeIds: [directNode.nodeId],
      contextNodeIds: [],
      prompt: "must not create a second active direct Task",
    });
    assert.equal(directRefused.ok, false);
    if (!directRefused.ok) {
      assert.equal(
        (directRefused.error.data as { code?: string } | undefined)?.code,
        "TASK_CLAIM_SESSION_ALREADY_ACTIVE"
      );
    }
    assert.deepEqual(
      {
        temp: await snapshotDirectoryTree(path.join(workspace, "temp")),
        session: await svc.runtime.registry.read(sessionId),
      },
      directBefore
    );

    const second = (await root.taskDispatch(workspaceId, {
      workNodeIds: [secondNode.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "second exact external Task",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };
    const secondBefore = await mount.env.fs.readFile(second.taskPath);
    const sessionBefore = await svc.runtime.registry.read(sessionId);
    const refused = await roleClient.tryCall("task.claim", {
      workspaceId,
      taskPath: second.taskPath,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(
        (refused.error.data as { code?: string } | undefined)?.code,
        "TASK_CLAIM_SESSION_ALREADY_ACTIVE"
      );
    }
    assert.equal(await mount.env.fs.readFile(second.taskPath), secondBefore);
    assert.deepEqual(await svc.runtime.registry.read(sessionId), sessionBefore);

    // Recreate an already-persisted pre-hard-cut/racing multi-binding directly
    // through Core. session.leave must defensively enumerate every exact active
    // binding rather than trusting only Session.lastTaskId.
    const secondBound = await taskClaim(mount.env, second.taskPath, {
      claimWrite: { sessionId },
    });
    await svc.runtime.registry.update(sessionId, {
      lastTaskId: secondBound.id || secondBound.path,
    });
    const firstTaskBeforeLeave = await loadTaskEnvelope(mount.env.fs, first.taskPath);
    const delivery = (await loadDeliveries(mount.env.fs, {
      taskId: firstTaskBeforeLeave.id,
    })).find((row) => row.id === firstDelivery.delivery.id);
    assert.ok(delivery);
    const preserved = {
      delivery: await mount.env.fs.readFile(delivery!.path),
      inputs: await fs.readFile(path.join(dataDir, "task-inputs.json"), "utf8"),
    };

    await root.sessionLeave(sessionId, workspaceId);

    for (const taskPath of [first.taskPath, second.taskPath]) {
      const persisted = await loadTaskEnvelope(mount.env.fs, taskPath);
      const projected = (await root.taskGet(workspaceId, taskPath)) as {
        task: { state: string; wait?: { code?: string }; sessionId?: string };
      };
      assert.equal(persisted.state, "waiting");
      assert.equal(persisted.wait?.code, "session_unavailable");
      assert.equal(persisted.sessionId, sessionId);
      assert.equal(projected.task.state, "waiting");
      assert.equal(projected.task.wait?.code, "session_unavailable");
      assert.equal(projected.task.sessionId, sessionId);
    }
    const firstAfterLeave = await loadTaskEnvelope(mount.env.fs, first.taskPath);
    assert.equal(firstAfterLeave.activeDeliveryId, firstDelivery.delivery.id);
    assert.deepEqual(
      {
        delivery: await mount.env.fs.readFile(delivery!.path),
        inputs: await fs.readFile(path.join(dataDir, "task-inputs.json"), "utf8"),
      },
      preserved
    );
    const stopped = await svc.runtime.probe(sessionId);
    assert.equal(stopped.alive, false);
    assert.equal(stopped.state, "stopped");
  });
});

test("task.claim recovers only the exact rejected external Role Task from its parked wait", async () => {
  await withService(async (svc) => {
    const workspace = await makeWorkspace("external-claim-recovery");
    const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await root.mount(workspace)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const entered = (await root.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      externalKey: "external-claim-recovery",
      cwd: workspace,
    })) as { session: { sessionId: string }; sessionToken: string };
    const roleClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: entered.session.sessionId,
      currentSessionToken: entered.sessionToken,
    });
    const note = (await root.call("docs.createNote", {
      workspaceId,
      name: "external-claim-recovery",
      type: "prompt",
    })) as { nodeId: string };
    const dispatched = (await root.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "recover exact external Task",
      parentActor: { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as { taskPath: string };
    await roleClient.taskClaim(workspaceId, dispatched.taskPath);
    const delivered = (await roleClient.taskDeliver(workspaceId, dispatched.taskPath, {
      summary: "ready before partial reject",
    })) as { delivery: { id: string } };
    const mount = svc.hostApi.require(workspaceId);
    const coreRejected = await taskReject(mount.env, dispatched.taskPath, {
      actor: "user",
      deliveryId: delivered.delivery.id,
      note: "partial external restore",
      resume: true,
    });
    assert.equal(coreRejected.delivery.status, "rejected");
    await taskWait(mount.env, dispatched.taskPath, {
      reason: "external",
      summary: `${REJECT_RESUME_SESSION_FAILED_WAIT_SUMMARY} (legacy managed restore misclassification)`,
    });

    const recovered = (await roleClient.taskClaim(workspaceId, dispatched.taskPath)) as {
      task: { state: string; sessionId?: string };
    };
    assert.equal(recovered.task.state, "running");
    assert.equal(recovered.task.sessionId, entered.session.sessionId);
    const exact = await loadTaskEnvelope(mount.env.fs, dispatched.taskPath);
    assert.equal(exact.state, "running");
    assert.equal(exact.wait, undefined);
    // Recovery preserves the immutable rejected Delivery reference; it only
    // clears the recoverable wait and restores execution on the exact Session.
    assert.equal(exact.activeDeliveryId, delivered.delivery.id);
    assert.equal(exact.sessionId, entered.session.sessionId);
    assert.equal((await svc.runtime.probe(entered.session.sessionId)).state, "external");

    // An arbitrary user/tool/external wait is not a recovery authority. The
    // exact same Session capability must still fail with zero Task mutation.
    await taskWait(mount.env, dispatched.taskPath, {
      reason: "external",
      summary: "Waiting for an unrelated operator action",
    });
    const beforeArbitraryClaim = await mount.env.fs.readFile(dispatched.taskPath);
    const arbitraryClaim = await roleClient.tryCall("task.claim", {
      workspaceId,
      taskPath: dispatched.taskPath,
    });
    assert.equal(arbitraryClaim.ok, false);
    if (!arbitraryClaim.ok) {
      assert.equal(
        (arbitraryClaim.error.data as { code?: string } | undefined)?.code,
        "EXTERNAL_ROLE_TASK_WAIT_NOT_RECOVERABLE"
      );
    }
    assert.equal(await mount.env.fs.readFile(dispatched.taskPath), beforeArbitraryClaim);
  });
});

test("external Role claim racing exact session.leave converges to a recoverable wait", async () => {
  await withService(async (svc) => {
    const workspace = await makeWorkspace("external-claim-leave-race");
    const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await root.mount(workspace)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const entered = (await root.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      externalKey: "external-claim-leave-race",
      cwd: workspace,
    })) as { session: { sessionId: string }; sessionToken: string };
    const roleClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: entered.session.sessionId,
      currentSessionToken: entered.sessionToken,
    });
    const note = (await root.call("docs.createNote", {
      workspaceId,
      name: "external-claim-leave-race",
      type: "prompt",
    })) as { nodeId: string };
    const dispatched = (await root.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "race exact external recovery with leave",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };
    await roleClient.taskClaim(workspaceId, dispatched.taskPath);
    await roleClient.taskWait(
      workspaceId,
      dispatched.taskPath,
      "external",
      REJECT_RESUME_SESSION_FAILED_WAIT_SUMMARY
    );

    const originalProbe = svc.runtime.probe.bind(svc.runtime);
    const originalStopSession = svc.runtime.stopSession.bind(svc.runtime);
    const closedSnapshots: Array<{ persisted: string; projected: string }> = [];
    svc.runtime.stopSession = async (...args: Parameters<typeof originalStopSession>) => {
      await originalStopSession(...args);
      if (args[0] !== entered.session.sessionId) return;
      const persisted = await loadTaskEnvelope(
        svc.hostApi.require(workspaceId).env.fs,
        dispatched.taskPath
      );
      const projected = (await root.taskGet(workspaceId, dispatched.taskPath)) as {
        task: { state: string };
      };
      closedSnapshots.push({ persisted: persisted.state, projected: projected.task.state });
    };
    let releaseProbe!: () => void;
    let notifyProbe!: () => void;
    const probeHeld = new Promise<void>((resolve) => {
      notifyProbe = resolve;
    });
    const probeRelease = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let held = false;
    svc.runtime.probe = async (sessionId: string) => {
      const snapshot = await originalProbe(sessionId);
      if (sessionId === entered.session.sessionId && !held) {
        held = true;
        notifyProbe();
        await probeRelease;
      }
      return snapshot;
    };
    try {
      const claim = roleClient.taskClaim(workspaceId, dispatched.taskPath);
      await probeHeld;
      const leave = root.sessionLeave(entered.session.sessionId, workspaceId);
      releaseProbe();
      await Promise.all([claim, leave]);
    } finally {
      svc.runtime.probe = originalProbe;
      svc.runtime.stopSession = originalStopSession;
      releaseProbe();
    }

    const finalTask = await loadTaskEnvelope(
      svc.hostApi.require(workspaceId).env.fs,
      dispatched.taskPath
    );
    assert.equal(finalTask.state, "waiting");
    assert.equal(finalTask.wait?.code, "session_unavailable");
    assert.equal(finalTask.sessionId, entered.session.sessionId);
    const finalProbe = await originalProbe(entered.session.sessionId);
    assert.equal(finalProbe.alive, false);
    assert.equal(finalProbe.state, "stopped");
    assert.deepEqual(closedSnapshots, [{ persisted: "waiting", projected: "waiting" }]);
  });
});

test("external Role reject-resume racing session.leave never projects closed Session as running", async () => {
  await withService(async (svc, dataDir) => {
    const workspace = await makeWorkspace("external-reject-leave-race");
    const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await root.mount(workspace)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const entered = (await root.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      externalKey: "external-reject-leave-race",
      cwd: workspace,
    })) as { session: { sessionId: string }; sessionToken: string };
    const roleClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: entered.session.sessionId,
      currentSessionToken: entered.sessionToken,
    });
    const note = (await root.call("docs.createNote", {
      workspaceId,
      name: "external-reject-leave-race",
      type: "prompt",
    })) as { nodeId: string };
    const dispatched = (await root.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "race reject resume with exact external leave",
      parentActor: { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as { taskPath: string };
    await roleClient.taskClaim(workspaceId, dispatched.taskPath);
    const delivered = (await roleClient.taskDeliver(workspaceId, dispatched.taskPath, {
      summary: "ready before reject leave race",
    })) as { delivery: { id: string } };

    const originalProbe = svc.runtime.probe.bind(svc.runtime);
    const originalStopSession = svc.runtime.stopSession.bind(svc.runtime);
    let releaseProbe!: () => void;
    let notifyProbe!: () => void;
    const probeHeld = new Promise<void>((resolve) => {
      notifyProbe = resolve;
    });
    const probeRelease = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let held = false;
    const closedSnapshots: Array<{ persisted: string; projected: string }> = [];
    svc.runtime.probe = async (sessionId: string) => {
      const snapshot = await originalProbe(sessionId);
      if (sessionId === entered.session.sessionId && !held) {
        held = true;
        notifyProbe();
        await probeRelease;
      }
      return snapshot;
    };
    svc.runtime.stopSession = async (...args: Parameters<typeof originalStopSession>) => {
      await originalStopSession(...args);
      if (args[0] !== entered.session.sessionId) return;
      const persisted = await loadTaskEnvelope(
        svc.hostApi.require(workspaceId).env.fs,
        dispatched.taskPath
      );
      const projected = (await root.taskGet(workspaceId, dispatched.taskPath)) as {
        task: { state: string };
      };
      closedSnapshots.push({ persisted: persisted.state, projected: projected.task.state });
    };

    const exactReviewText = "preserve exact external review feedback";
    let rejected!: {
      task: { state: string; sessionId?: string };
      delivery: { status: string };
      input: { id: string; text?: string; status: string };
    };
    try {
      const rejectPromise = root.taskReject(
        workspaceId,
        dispatched.taskPath,
        delivered.delivery.id,
        "user",
        { note: exactReviewText, resume: true }
      ) as Promise<typeof rejected>;
      await probeHeld;
      const leavePromise = root.sessionLeave(entered.session.sessionId, workspaceId);
      releaseProbe();
      [rejected] = await Promise.all([rejectPromise, leavePromise]);
    } finally {
      svc.runtime.probe = originalProbe;
      svc.runtime.stopSession = originalStopSession;
      releaseProbe();
    }

    assert.equal(rejected.delivery.status, "rejected");
    assert.equal(rejected.task.sessionId, entered.session.sessionId);
    assert.equal(rejected.input.text, exactReviewText);
    assert.equal(rejected.input.status, "pending");
    assert.deepEqual(closedSnapshots, [{ persisted: "waiting", projected: "waiting" }]);

    const mount = svc.hostApi.require(workspaceId);
    let finalTask = await loadTaskEnvelope(mount.env.fs, dispatched.taskPath);
    assert.equal(finalTask.state, "waiting");
    assert.equal(finalTask.wait?.code, "session_unavailable");
    assert.equal(finalTask.activeDeliveryId, delivered.delivery.id);
    const storedInput = await svc.ctx.taskInputs.get(
      rejected.input.id,
      workspaceId,
      dispatched.taskPath
    );
    assert.equal(storedInput?.text, exactReviewText);
    assert.equal(storedInput?.status, "pending");

    const delivery = (await loadDeliveries(mount.env.fs, { taskId: finalTask.id })).find(
      (row) => row.id === delivered.delivery.id
    );
    assert.equal(delivery?.status, "rejected");
    assert.ok(delivery);

    // Closed Session plus an unrelated wait remains entirely immutable across
    // Task, rejected Delivery and durable review-feedback TaskInput.
    finalTask = await patchTaskEnvelope(mount.env.fs, dispatched.taskPath, {
      wait: { reason: "external", summary: "Unrelated operator hold" },
      updatedAt: mount.env.clock.now(),
    });
    const before = {
      task: await mount.env.fs.readFile(dispatched.taskPath),
      delivery: await mount.env.fs.readFile(delivery!.path),
      inputs: await fs.readFile(path.join(dataDir, "task-inputs.json"), "utf8"),
    };
    const claim = await roleClient.tryCall("task.claim", {
      workspaceId,
      taskPath: dispatched.taskPath,
    });
    assert.equal(claim.ok, false);
    assert.deepEqual(
      {
        task: await mount.env.fs.readFile(dispatched.taskPath),
        delivery: await mount.env.fs.readFile(delivery!.path),
        inputs: await fs.readFile(path.join(dataDir, "task-inputs.json"), "utf8"),
      },
      before
    );
    assert.equal(finalTask.sessionId, entered.session.sessionId);
  });
});

test("external Role reject-resume failure is parked without managed-Session diagnostics", async () => {
  await withService(async (svc) => {
    const workspace = await makeWorkspace("external-reject-diagnostic");
    const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await root.mount(workspace)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const entered = (await root.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      externalKey: "external-reject-diagnostic",
      cwd: workspace,
    })) as { session: { sessionId: string }; sessionToken: string };
    const roleClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: entered.session.sessionId,
      currentSessionToken: entered.sessionToken,
    });
    const note = (await root.call("docs.createNote", {
      workspaceId,
      name: "external-reject-diagnostic",
      type: "prompt",
    })) as { nodeId: string };
    const dispatched = (await root.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "external failure wording",
      parentActor: { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as { taskPath: string };
    await roleClient.taskClaim(workspaceId, dispatched.taskPath);
    const delivered = (await roleClient.taskDeliver(workspaceId, dispatched.taskPath, {
      summary: "ready before external host leaves",
    })) as { delivery: { id: string } };
    await root.sessionLeave(entered.session.sessionId, workspaceId);

    const rejected = await root.tryCall("task.reject", {
      workspaceId,
      taskPath: dispatched.taskPath,
      deliveryId: delivered.delivery.id,
      actor: "user",
      note: "resume after external host left",
      resume: true,
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.doesNotMatch(rejected.error.message, /managed session/i);
      assert.match(rejected.error.message, /external Role Session/i);
    }
    const parked = await loadTaskEnvelope(
      svc.hostApi.require(workspaceId).env.fs,
      dispatched.taskPath
    );
    assert.equal(parked.state, "waiting");
    assert.doesNotMatch(parked.wait?.summary ?? "", /managed session/i);
    assert.match(parked.wait?.summary ?? "", /External Role Session/i);
    assert.equal(parked.activeDeliveryId, delivered.delivery.id);
  });
});

test("CLI session enter/status/leave via service", async () => {
  await withService(async (svc, dataDir) => {
    const ws = await makeWorkspace();
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await client.mount(ws);

    const enter = await runSessionCommand(
      "enter",
      ["--role", "executor", "--key", "cli-key-1", "--json"],
      { client, cwd: ws, dataDir, packageRoot: repoRoot }
    );
    assert.equal(enter.exitCode, 0, enter.stderr);
    const enterBody = JSON.parse(enter.stdout) as {
      session: { sessionId: string; state: string };
      reused: boolean;
    };
    assert.equal(enterBody.session.state, "external");
    const sessionId = enterBody.session.sessionId;

    const enter2 = await runSessionCommand(
      "enter",
      ["--session", sessionId, "--json"],
      { client, cwd: ws, dataDir }
    );
    assert.equal(enter2.exitCode, 0, enter2.stderr);
    const enter2Body = JSON.parse(enter2.stdout) as { reused: boolean };
    assert.equal(enter2Body.reused, true);

    const status = await runSessionCommand("status", [sessionId, "--json"], {
      client,
      cwd: ws,
      dataDir,
    });
    assert.equal(status.exitCode, 0, status.stderr);
    const statusBody = JSON.parse(status.stdout) as {
      session: { sessionId: string; state: string };
      open: boolean;
    };
    assert.equal(statusBody.session.sessionId, sessionId);
    assert.equal(statusBody.open, true);

    const leave = await runSessionCommand("leave", [sessionId, "--json"], {
      client,
      cwd: ws,
      dataDir,
    });
    assert.equal(leave.exitCode, 0, leave.stderr);
    const leaveBody = JSON.parse(leave.stdout) as {
      left: boolean;
      delivered: boolean;
      accepted: boolean;
      state: string;
    };
    assert.equal(leaveBody.left, true);
    assert.equal(leaveBody.delivered, false);
    assert.equal(leaveBody.accepted, false);
    assert.equal(leaveBody.state, "stopped");
  });
});

test("hook alias session-start outside Tent: silent exit 0", async () => {
  const nonTent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-not-ws-"));
  const result = await runSessionCommand("session-start", ["--json"], {
    cwd: nonTent,
    attachOnly: true,
    dataDir: path.join(os.tmpdir(), "no-svc-" + Date.now()),
    skipStdin: true,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout) as { skipped: boolean; reason: string };
  assert.equal(body.skipped, true);
  assert.equal(body.reason, "not-a-tent-workspace");
});

test("public enter outside Tent: fail-loud (not silent)", async () => {
  const nonTent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-not-ws2-"));
  const result = await runSessionCommand("enter", ["--json"], {
    cwd: nonTent,
    attachOnly: true,
    dataDir: path.join(os.tmpdir(), "no-svc2-" + Date.now()),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Not inside a Tent/i);
});

test("hook session-end outside Tent: silent exit 0", async () => {
  const nonTent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-not-ws3-"));
  const result = await runSessionCommand(
    "session-end",
    ["ss-doesnotmatter", "--json"],
    {
      cwd: nonTent,
      attachOnly: true,
      dataDir: path.join(os.tmpdir(), "no-svc3-" + Date.now()),
      skipStdin: true,
    }
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const body = JSON.parse(result.stdout) as {
    skipped: boolean;
    delivered: boolean;
    accepted: boolean;
  };
  assert.equal(body.skipped, true);
  assert.equal(body.delivered, false);
  assert.equal(body.accepted, false);
});

test("buildHookExternalKey: host+nativeSessionId or host+workspace fallback", () => {
  assert.equal(
    buildHookExternalKey({ host: "Codex", nativeSessionId: "abc-123" }),
    "codex:abc-123"
  );
  assert.equal(
    buildHookExternalKey({
      host: "claude",
      workspaceRoot: "C:\\proj\\MyRepo\\",
    }),
    "claude:ws:c:/proj/myrepo"
  );
  // No host → refuse (no silent orphan key)
  assert.equal(
    buildHookExternalKey({ nativeSessionId: "x", workspaceRoot: "/w" }),
    undefined
  );
  assert.equal(buildHookExternalKey({ host: "unsupported-host" }), undefined);
});

test("parseNativeHookStdin + pickNativeSessionId accept common fields", () => {
  const a = parseNativeHookStdin(
    JSON.stringify({ session_id: "nat-1", cwd: "/ws" })
  );
  assert.equal(pickNativeSessionId(a), "nat-1");
  const b = parseNativeHookStdin(
    JSON.stringify({ sessionId: "nat-2", workspace: "/ws2" })
  );
  assert.equal(pickNativeSessionId(b), "nat-2");
  assert.equal(parseNativeHookStdin(""), null);
  assert.equal(parseNativeHookStdin("not-json"), null);
});

test("runtime stores first-class externalKey only", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ext-key-"));
  const runtime = createAgentRuntime({ dataDir });
  try {
    const h = await runtime.enterExternalSession({
      externalKey: "explicit-key-1",
      workspace: "ws-k",
      roleId: "rl-executor",
    });
    const rec = await runtime.registry.read(h.sessionId);
    assert.equal(rec?.externalKey, "explicit-key-1");
    assert.equal(recordExternalKey(rec!), "explicit-key-1");
    // Key lives only on the first-class field; the route snapshot has no raw env.
    assert.equal((rec?.connectionSnapshot as { env?: unknown } | undefined)?.env, undefined);
    // Missing first-class field → no key.
    assert.equal(recordExternalKey({}), undefined);
    assert.equal(recordExternalKey({ externalKey: "  " }), undefined);
  } finally {
    await runtime.shutdown();
  }
});

test("service status/leave resolve by externalKey without sessionId", async () => {
  await withService(async (svc) => {
    const ws = await makeWorkspace();
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;

    const entered = (await client.sessionEnter({
      workspaceId,
      externalKey: "lookup-key-1",
      roleId: "rl-executor",
      cwd: ws,
    })) as { session: { sessionId: string; externalKey?: string } };
    assert.equal(entered.session.externalKey, "lookup-key-1");
    const sessionId = entered.session.sessionId;

    const status = (await client.sessionStatus({
      workspaceId,
      externalKey: "lookup-key-1",
    })) as {
      session: { sessionId: string; externalKey?: string; state: string };
      open: boolean;
    };
    assert.equal(status.session.sessionId, sessionId);
    assert.equal(status.session.externalKey, "lookup-key-1");
    assert.equal(status.open, true);

    const left = (await client.sessionLeave({
      externalKey: "lookup-key-1",
      workspaceId,
    })) as {
      sessionId: string;
      left: boolean;
      delivered: boolean;
      accepted: boolean;
    };
    assert.equal(left.sessionId, sessionId);
    assert.equal(left.left, true);
    assert.equal(left.delivered, false);
    assert.equal(left.accepted, false);

    const left2 = (await client.sessionLeave({
      externalKey: "lookup-key-1",
      workspaceId,
    })) as { alreadyLeft: boolean; left: boolean };
    assert.equal(left2.alreadyLeft, true);
    assert.equal(left2.left, false);
  });
});

test("hook session-start → status → session-end closed loop via --host + stdin (no sessionId file)", async () => {
  await withService(async (svc, dataDir) => {
    const ws = await makeWorkspace();
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await client.mount(ws);

    const stdinStart = JSON.stringify({
      session_id: "provider-sess-42",
      cwd: ws,
    });
    const start = await runSessionCommand(
      "session-start",
      ["--host", "codex", "--json"],
      {
        client,
        cwd: ws,
        dataDir,
        packageRoot: repoRoot,
        stdinText: stdinStart,
        skipStdin: true,
      }
    );
    assert.equal(start.exitCode, 0, start.stderr);
    const startBody = JSON.parse(start.stdout) as {
      session: { sessionId: string; externalKey?: string; state: string };
      reused: boolean;
    };
    assert.equal(startBody.session.state, "external");
    assert.equal(startBody.session.externalKey, "codex:provider-sess-42");
    assert.equal(startBody.reused, false);
    const sessionId = startBody.session.sessionId;

    // Re-enter same host+native id reuses (idempotent) without knowing ss-
    const start2 = await runSessionCommand(
      "session-start",
      ["--host", "codex", "--json"],
      {
        client,
        cwd: ws,
        dataDir,
        stdinText: stdinStart,
        skipStdin: true,
      }
    );
    assert.equal(start2.exitCode, 0, start2.stderr);
    const start2Body = JSON.parse(start2.stdout) as {
      session: { sessionId: string };
      reused: boolean;
    };
    assert.equal(start2Body.session.sessionId, sessionId);
    assert.equal(start2Body.reused, true);

    // status without sessionId — only --host + same stdin
    const status = await runSessionCommand(
      "session-status",
      ["--host", "codex", "--json"],
      {
        client,
        cwd: ws,
        dataDir,
        stdinText: stdinStart,
        skipStdin: true,
      }
    );
    assert.equal(status.exitCode, 0, status.stderr);
    const statusBody = JSON.parse(status.stdout) as {
      session: { sessionId: string; externalKey?: string };
      open: boolean;
    };
    assert.equal(statusBody.session.sessionId, sessionId);
    assert.equal(statusBody.session.externalKey, "codex:provider-sess-42");
    assert.equal(statusBody.open, true);

    // end in a "separate process" style call: no sessionId positional
    const end = await runSessionCommand(
      "session-end",
      ["--host", "codex", "--json"],
      {
        client,
        cwd: ws,
        dataDir,
        stdinText: stdinStart,
        skipStdin: true,
      }
    );
    assert.equal(end.exitCode, 0, end.stderr);
    const endBody = JSON.parse(end.stdout) as {
      sessionId: string;
      left: boolean;
      delivered: boolean;
      accepted: boolean;
      state: string;
    };
    assert.equal(endBody.sessionId, sessionId);
    assert.equal(endBody.left, true);
    assert.equal(endBody.delivered, false);
    assert.equal(endBody.accepted, false);
    assert.equal(endBody.state, "stopped");
  });
});

test("hook session-start without native id uses host+workspace fallback; no host fails loud in Tent", async () => {
  await withService(async (svc, dataDir) => {
    const ws = await makeWorkspace();
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await client.mount(ws);

    // No host → refuse enter (would create un-findable orphans)
    const noHost = await runSessionCommand("session-start", ["--json"], {
      client,
      cwd: ws,
      dataDir,
      skipStdin: true,
      stdinText: "",
    });
    assert.equal(noHost.exitCode, 1);
    assert.match(noHost.stderr, /externalKey|orphan|--host/i);

    // host + workspace fallback (empty stdin, no session_id)
    const start = await runSessionCommand(
      "session-start",
      ["--host", "claude", "--json"],
      {
        client,
        cwd: ws,
        dataDir,
        skipStdin: true,
        stdinText: "",
      }
    );
    assert.equal(start.exitCode, 0, start.stderr);
    const startBody = JSON.parse(start.stdout) as {
      session: { sessionId: string; externalKey?: string };
    };
    const expectedKey = buildHookExternalKey({
      host: "claude",
      workspaceRoot: ws,
    });
    assert.equal(startBody.session.externalKey, expectedKey);

    const end = await runSessionCommand(
      "session-end",
      ["--host", "claude", "--json"],
      {
        client,
        cwd: ws,
        dataDir,
        skipStdin: true,
        stdinText: "",
      }
    );
    assert.equal(end.exitCode, 0, end.stderr);
    const endBody = JSON.parse(end.stdout) as { left: boolean; sessionId: string };
    assert.equal(endBody.left, true);
    assert.equal(endBody.sessionId, startBody.session.sessionId);
  });
});

test("hook aliases silent outside Tent even with --host", async () => {
  const nonTent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-not-ws4-"));
  const result = await runSessionCommand(
    "session-start",
    ["--host", "codex", "--json"],
    {
      cwd: nonTent,
      attachOnly: true,
      dataDir: path.join(os.tmpdir(), "no-svc4-" + Date.now()),
      skipStdin: true,
      stdinText: JSON.stringify({ session_id: "x", cwd: nonTent }),
    }
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const body = JSON.parse(result.stdout) as { skipped: boolean };
  assert.equal(body.skipped, true);
});
