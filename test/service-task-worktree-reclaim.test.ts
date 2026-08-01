/**
 * Service: terminal Task worktree auto-reclaim + exact preview/reconcile RPC.
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
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";
import { ensureRoleWorkspace, ensureTaskWorkspace } from "../src/core/workspace.js";
import { writeTaskEnvelope, patchTaskEnvelope, loadTaskEnvelope } from "../src/core/task.js";
import { createDelivery } from "../src/core/delivery.js";
import { configureTestGitIdentity, git } from "./helpers.js";
import { FAKE_DEFAULT_PROFILE_ID, defaultAgentProfiles } from "../src/service/profiles.js";
import {
  setBeforeTaskWorktreeReclaimRemoveForTests,
} from "../src/service/handlers.js";
import {
  listTaskWorktreeReclaimPending,
} from "../src/core/task-worktree-reclaim-queue.js";
import type { TaskEnvelope } from "../src/core/task.js";

async function makeGitTentWorkspace(name = "reclaim-svc"): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-reclaim-svc-"));
  const workspace = path.join(parent, "repo");
  await fs.mkdir(workspace);
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await git(workspace, "add", "-A");
  await git(workspace, "commit", "-q", "-m", "scaffold tent");
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          {
            name: "executor",
            prompt: "do work",
            a2aPolicy: "allow",
            allowedProfiles: [FAKE_DEFAULT_PROFILE_ID],
          },
        ],
      },
      null,
      2
    ) + "\n"
  );
  const dirty = (await git(workspace, "status", "--porcelain")).trim();
  if (dirty) {
    await git(workspace, "add", "-A");
    await git(workspace, "commit", "-q", "-m", "roles");
  }
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-reclaim-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    profiles: defaultAgentProfiles(),
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

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test("CLIENT_METHODS includes exact Task worktree preview and reconcile", () => {
  assert.ok(isClientMethod("task.worktreeReclaim.preview"));
  assert.ok(CLIENT_METHODS.includes("task.worktreeReclaim.preview"));
  assert.ok(isClientMethod("task.worktreeReclaim.reconcile"));
  assert.ok(CLIENT_METHODS.includes("task.worktreeReclaim.reconcile"));
});

test("P0: terminal reject auto-reclaims clean profile Task worktree", async () => {
  const ws = await makeGitTentWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const systemRoot = path.join(ws, ".tent");
    const sysFs = new NodeFs(systemRoot);
    const clock = { now: () => new Date().toISOString() };
    const taskId = "tk-svc-reclaim-1";
    const lane = await ensureTaskWorkspace(ws, taskId);

    // Prefer real box id from tent tree when available.
    const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
    const inboxBox =
      [...tent.byId.values()].find((b) => b.path === "inbox" || b.path.endsWith("/inbox")) ??
      [...tent.byId.values()][0];
    const boxId = inboxBox?.id ?? "bx-inbox";
    const boxPath = inboxBox?.path ?? "inbox";

    const taskPath = await writeTaskEnvelope(sysFs, clock, {
      parentActor: { kind: "user", id: "user" },
      role: FAKE_DEFAULT_PROFILE_ID,
      claims: [{ id: boxId, path: boxPath }],
      manifestPath: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/manifests/${taskId}.yml`,
      userPrompt: "reclaim after reject",
      id: taskId,
      assigneeKind: "agentProfile",
      tasksDir: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/tasks`,
      workspace: {
        workspace: lane.workspace,
        worktree: lane.worktree,
        branch: lane.branch,
        targetBranch: lane.targetBranch,
      },
    });
    await patchTaskEnvelope(sysFs, taskPath, {
      state: "delivered",
      status: "taken",
      updatedAt: clock.now(),
    });
    const delivery = await createDelivery(sysFs, clock, {
      taskId,
      boxId,
      role: FAKE_DEFAULT_PROFILE_ID,
      summary: "ready for terminal reject",
      status: "ready",
      deliveriesDir: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/deliveries`,
    });
    await patchTaskEnvelope(sysFs, taskPath, {
      activeDeliveryId: delivery.id,
      updatedAt: clock.now(),
    });

    assert.equal(await pathExists(lane.worktree), true);

    const previewRes = await rpc(svc, "task.worktreeReclaim.preview", {
      workspaceId,
      taskPath,
    });
    assert.ok(!previewRes.error, JSON.stringify(previewRes.error));
    const preview = previewRes.result as { code: string; eligible: boolean };
    // Still delivered → not terminal for reclaim.
    assert.equal(preview.code, "NOT_TERMINAL");
    assert.equal(preview.eligible, false);

    const rejectedRes = await rpc(svc, "task.reject", {
      workspaceId,
      taskPath,
      actor: "user",
      resume: false,
      note: "no rework",
    });
    assert.ok(!rejectedRes.error, JSON.stringify(rejectedRes.error));
    const rejected = rejectedRes.result as { state: string };
    assert.equal(rejected.state, "rejected");

    // Auto-reclaim should have removed the worktree.
    assert.equal(
      await pathExists(lane.worktree),
      false,
      "terminal reject must auto-reclaim clean Task worktree"
    );
    // Task envelope remains for audit.
    const task = await loadTaskEnvelope(sysFs, taskPath);
    assert.equal(task.state, "rejected");
    const branchExists = await git(ws, "show-ref", "--verify", `refs/heads/${lane.branch}`)
      .then(() => true)
      .catch(() => false);
    assert.equal(branchExists, true, "branch preserved for audit");

    // Idempotent preview after reclaim.
    const afterRes = await rpc(svc, "task.worktreeReclaim.preview", {
      workspaceId,
      taskPath,
    });
    assert.ok(!afterRes.error, JSON.stringify(afterRes.error));
    const after = afterRes.result as { code: string; eligible: boolean };
    assert.equal(after.code, "ALREADY_GONE");
    assert.equal(after.eligible, true);
  });
});

test("P0: dirty terminal lane fails closed; exact reconcile reclaims after clean", async () => {
  const ws = await makeGitTentWorkspace();
  const systemRoot = path.join(ws, ".tent");
  const sysFs = new NodeFs(systemRoot);
  const clock = { now: () => new Date().toISOString() };
  const taskId = "tk-svc-reclaim-dirty";
  const lane = await ensureTaskWorkspace(ws, taskId);
  await fs.writeFile(path.join(lane.worktree, "UNCOMMITTED.txt"), "dirty\n");

  const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
  const inboxBox =
    [...tent.byId.values()].find((b) => b.path === "inbox" || b.path.endsWith("/inbox")) ??
    [...tent.byId.values()][0];
  const boxId = inboxBox?.id ?? "bx-inbox";
  const boxPath = inboxBox?.path ?? "inbox";

  const taskPath = await writeTaskEnvelope(sysFs, clock, {
    parentActor: { kind: "user", id: "user" },
    role: FAKE_DEFAULT_PROFILE_ID,
    claims: [{ id: boxId, path: boxPath }],
    manifestPath: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/manifests/${taskId}.yml`,
    userPrompt: "dirty then clean",
    id: taskId,
    assigneeKind: "agentProfile",
    tasksDir: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/tasks`,
    workspace: {
      workspace: lane.workspace,
      worktree: lane.worktree,
      branch: lane.branch,
      targetBranch: lane.targetBranch,
    },
  });
  await patchTaskEnvelope(sysFs, taskPath, {
    state: "delivered",
    status: "taken",
    updatedAt: clock.now(),
  });
  const delivery = await createDelivery(sysFs, clock, {
    taskId,
    boxId,
    role: FAKE_DEFAULT_PROFILE_ID,
    summary: "terminal via interrupt path",
    status: "ready",
    deliveriesDir: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/deliveries`,
  });
  await patchTaskEnvelope(sysFs, taskPath, {
    activeDeliveryId: delivery.id,
    updatedAt: clock.now(),
  });

  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    // Mount never scans historical inventory or mutates this lane.
    assert.equal((await listTaskWorktreeReclaimPending(sysFs)).length, 0);
    assert.equal(await pathExists(lane.worktree), true);

    // Terminal reject enqueues pending even when dirty (fail-closed keep scene).
    const rejectedRes = await rpc(svc, "task.reject", {
      workspaceId,
      taskPath,
      actor: "user",
      resume: false,
      note: "dirty keep",
    });
    assert.ok(!rejectedRes.error, JSON.stringify(rejectedRes.error));
    assert.equal(await pathExists(lane.worktree), true);

    const previewRes = await rpc(svc, "task.worktreeReclaim.preview", {
      workspaceId,
      taskPath,
    });
    assert.ok(!previewRes.error, JSON.stringify(previewRes.error));
    assert.equal((previewRes.result as { code: string }).code, "DIRTY");

    // Clean outside service, then explicitly reconcile this exact Task only.
    await fs.unlink(path.join(lane.worktree, "UNCOMMITTED.txt"));
    assert.equal((await git(lane.worktree, "status", "--porcelain")).trim(), "");

    const reconciled = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(!reconciled.error, JSON.stringify(reconciled.error));
    assert.equal((reconciled.result as { reclaimed: boolean }).reclaimed, true);
    assert.equal(await pathExists(lane.worktree), false);

    // Exact reconcile is idempotent after the lane is gone.
    const again = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(!again.error, JSON.stringify(again.error));
    assert.equal((again.result as { code: string }).code, "ALREADY_GONE");
    assert.equal(await pathExists(lane.worktree), false);
  });
});

test("P0: workspace.mount does not discover or reclaim historical terminal lanes", async () => {
  const ws = await makeGitTentWorkspace("reclaim-hist");
  const systemRoot = path.join(ws, ".tent");
  const sysFs = new NodeFs(systemRoot);
  const clock = { now: () => new Date().toISOString() };
  const taskId = "tk-historical-only";
  const lane = await ensureTaskWorkspace(ws, taskId);
  const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
  const inboxBox = [...tent.byId.values()][0];
  const taskPath = await writeTaskEnvelope(sysFs, clock, {
    parentActor: { kind: "user", id: "user" },
    role: FAKE_DEFAULT_PROFILE_ID,
    claims: [{ id: inboxBox?.id ?? "bx-1", path: inboxBox?.path ?? "inbox" }],
    manifestPath: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/manifests/${taskId}.yml`,
    userPrompt: "old terminal never observed by reclaim feature",
    id: taskId,
    assigneeKind: "agentProfile",
    tasksDir: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/tasks`,
    workspace: {
      workspace: lane.workspace,
      worktree: lane.worktree,
      branch: lane.branch,
      targetBranch: lane.targetBranch,
    },
  });
  await patchTaskEnvelope(sysFs, taskPath, {
    state: "accepted",
    status: "taken",
    updatedAt: clock.now(),
  });

  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    assert.equal((await listTaskWorktreeReclaimPending(sysFs)).length, 0);
    assert.equal(await pathExists(lane.worktree), true, "historical inventory untouched");
  });
});

test("P0: SESSION_ACTIVE when bound managed session still live", async () => {
  const ws = await makeGitTentWorkspace("reclaim-sess");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const systemRoot = path.join(ws, ".tent");
    const sysFs = new NodeFs(systemRoot);
    const clock = { now: () => new Date().toISOString() };
    const taskId = "tk-sess-active";
    const lane = await ensureTaskWorkspace(ws, taskId);
    const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
    const inboxBox = [...tent.byId.values()][0];
    const boxId = inboxBox?.id ?? "bx-1";
    const boxPath = inboxBox?.path ?? "inbox";

    const taskPath = await writeTaskEnvelope(sysFs, clock, {
      parentActor: { kind: "user", id: "user" },
      role: FAKE_DEFAULT_PROFILE_ID,
      claims: [{ id: boxId, path: boxPath }],
      manifestPath: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/manifests/${taskId}.yml`,
      userPrompt: "session still live",
      id: taskId,
      assigneeKind: "agentProfile",
      tasksDir: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/tasks`,
      workspace: {
        workspace: lane.workspace,
        worktree: lane.worktree,
        branch: lane.branch,
        targetBranch: lane.targetBranch,
      },
    });
    await patchTaskEnvelope(sysFs, taskPath, {
      state: "running",
      status: "taken",
      updatedAt: clock.now(),
    });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: FAKE_DEFAULT_PROFILE_ID,
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const liveSessionId = (started.result as { session?: { sessionId?: string } }).session
      ?.sessionId;
    assert.ok(liveSessionId, "need a live managed session id");

    // Force terminal without stopping the live session (simulates race / external leave lag).
    await patchTaskEnvelope(sysFs, taskPath, {
      state: "failed",
      status: "taken",
      workspace: lane.workspace,
      worktree: lane.worktree,
      branch: lane.branch,
      targetBranch: lane.targetBranch,
      sessionId: liveSessionId,
      updatedAt: clock.now(),
    });

    const { enqueueTaskWorktreeReclaimPending } = await import(
      "../src/core/task-worktree-reclaim-queue.js"
    );
    await enqueueTaskWorktreeReclaimPending(sysFs, {
      taskId,
      taskPath,
      workspaceRoot: ws,
      trigger: "test.session-active",
    });

    const blocked = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(!blocked.error, JSON.stringify(blocked.error));
    assert.equal((blocked.result as { code: string }).code, "SESSION_ACTIVE");
    assert.equal(await pathExists(lane.worktree), true, "live session must block reclaim");

    // After stop, settle gate passes and reclaim succeeds.
    try {
      await svc.ctx.runtime.stopSession(liveSessionId, "user");
    } catch {
      // already stopped
    }
    // Drop session binding so registry residue cannot keep SESSION_ACTIVE after stop.
    await patchTaskEnvelope(sysFs, taskPath, {
      state: "failed",
      sessionId: null,
      workspace: lane.workspace,
      worktree: lane.worktree,
      branch: lane.branch,
      targetBranch: lane.targetBranch,
      updatedAt: clock.now(),
    });
    await enqueueTaskWorktreeReclaimPending(sysFs, {
      taskId,
      taskPath,
      workspaceRoot: ws,
      trigger: "test.after-stop",
    });
    const cleaned = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(!cleaned.error, JSON.stringify(cleaned.error));
    assert.equal(
      await pathExists(lane.worktree),
      false,
      `worktree must reclaim after session stop (result=${JSON.stringify(cleaned.result)})`
    );
  });
});

test("P0: accepted-while-external queues; session.leave reclaims exact Task only", async () => {
  const ws = await makeGitTentWorkspace("reclaim-ext-leave");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const systemRoot = path.join(ws, ".tent");
    const sysFs = new NodeFs(systemRoot);
    const clock = { now: () => new Date().toISOString() };
    const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
    const inboxBox = [...tent.byId.values()][0];
    const boxId = inboxBox?.id ?? "bx-1";
    const boxPath = inboxBox?.path ?? "inbox";

    const targetId = "tk-ext-target";
    const otherId = "tk-ext-other";
    const targetLane = await ensureTaskWorkspace(ws, targetId);
    const otherLane = await ensureTaskWorkspace(ws, otherId);

    const targetPath = await writeTaskEnvelope(sysFs, clock, {
      parentActor: { kind: "user", id: "user" },
      role: FAKE_DEFAULT_PROFILE_ID,
      claims: [{ id: boxId, path: boxPath }],
      manifestPath: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/manifests/${targetId}.yml`,
      userPrompt: "accepted under external session",
      id: targetId,
      assigneeKind: "agentProfile",
      tasksDir: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/tasks`,
      workspace: {
        workspace: targetLane.workspace,
        worktree: targetLane.worktree,
        branch: targetLane.branch,
        targetBranch: targetLane.targetBranch,
      },
    });
    const otherPath = await writeTaskEnvelope(sysFs, clock, {
      parentActor: { kind: "user", id: "user" },
      role: FAKE_DEFAULT_PROFILE_ID,
      claims: [{ id: boxId, path: boxPath }],
      manifestPath: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/manifests/${otherId}.yml`,
      userPrompt: "unrelated pending must stay",
      id: otherId,
      assigneeKind: "agentProfile",
      tasksDir: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/tasks`,
      workspace: {
        workspace: otherLane.workspace,
        worktree: otherLane.worktree,
        branch: otherLane.branch,
        targetBranch: otherLane.targetBranch,
      },
    });

    // Enter external session bound to the target task.
    const entered = await rpc(svc, "session.enter", {
      workspaceId,
      roleName: "executor",
      externalKey: "reclaim-ext-key",
      cwd: targetLane.worktree,
      lastTaskId: targetId,
    });
    assert.ok(!entered.error, JSON.stringify(entered.error));
    const sessionId = (entered.result as { session: { sessionId: string } }).session
      .sessionId;

    await patchTaskEnvelope(sysFs, targetPath, {
      state: "accepted",
      status: "taken",
      sessionId,
      workspace: targetLane.workspace,
      worktree: targetLane.worktree,
      branch: targetLane.branch,
      targetBranch: targetLane.targetBranch,
      updatedAt: clock.now(),
    });
    await patchTaskEnvelope(sysFs, otherPath, {
      state: "failed",
      status: "taken",
      workspace: otherLane.workspace,
      worktree: otherLane.worktree,
      branch: otherLane.branch,
      targetBranch: otherLane.targetBranch,
      updatedAt: clock.now(),
    });

    const { enqueueTaskWorktreeReclaimPending, listTaskWorktreeReclaimPending } =
      await import("../src/core/task-worktree-reclaim-queue.js");

    // Simulate terminal accept while external still open → SESSION_ACTIVE queue.
    await enqueueTaskWorktreeReclaimPending(sysFs, {
      taskId: targetId,
      taskPath: targetPath,
      workspaceRoot: ws,
      trigger: "task.accept",
    });
    await enqueueTaskWorktreeReclaimPending(sysFs, {
      taskId: otherId,
      taskPath: otherPath,
      workspaceRoot: ws,
      trigger: "task.fail",
    });

    // Dirty the unrelated lane so recover cannot reclaim it even if attempted.
    await fs.writeFile(path.join(otherLane.worktree, "KEEP.txt"), "other\n");

    // While external is open, target reclaim must refuse and keep the lane.
    const blocked = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath: targetPath,
      actor: "user",
    });
    assert.ok(!blocked.error, JSON.stringify(blocked.error));
    assert.equal((blocked.result as { code: string }).code, "SESSION_ACTIVE");
    assert.equal(
      await pathExists(targetLane.worktree),
      true,
      "target must survive SESSION_ACTIVE while external is open"
    );
    assert.equal(await pathExists(otherLane.worktree), true);

    // Leave external — never deliver/accept; must retry exact lastTaskId only.
    const left = await rpc(svc, "session.leave", {
      workspaceId,
      sessionId,
    });
    assert.ok(!left.error, JSON.stringify(left.error));
    const leftBody = left.result as {
      delivered: boolean;
      accepted: boolean;
      left: boolean;
    };
    assert.equal(leftBody.delivered, false);
    assert.equal(leftBody.accepted, false);
    assert.equal(leftBody.left, true);

    assert.equal(
      await pathExists(targetLane.worktree),
      false,
      "exact Task worktree must reclaim on session.leave"
    );
    assert.equal(
      await pathExists(otherLane.worktree),
      true,
      "unrelated pending queue must remain untouched"
    );
    const pending = await listTaskWorktreeReclaimPending(sysFs);
    assert.ok(
      pending.some((e) => e.taskId === otherId),
      "other pending entry must still be queued"
    );
    assert.ok(
      !pending.some((e) => e.taskId === targetId),
      "target pending entry cleared after successful reclaim"
    );
  });
});

test("P0: role worktree never reclaimed on terminal role task", async () => {
  const ws = await makeGitTentWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const roleLane = await ensureRoleWorkspace(ws, "executor");
    const systemRoot = path.join(ws, ".tent");
    const sysFs = new NodeFs(systemRoot);
    const clock = { now: () => new Date().toISOString() };
    const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
    const inboxBox =
      [...tent.byId.values()].find((b) => b.path === "inbox" || b.path.endsWith("/inbox")) ??
      [...tent.byId.values()][0];
    const boxId = inboxBox?.id ?? "bx-inbox";
    const boxPath = inboxBox?.path ?? "inbox";

    const taskPath = await writeTaskEnvelope(sysFs, clock, {
      parentActor: { kind: "role", id: "规划" },
      role: "executor",
      claims: [{ id: boxId, path: boxPath }],
      manifestPath: "temp/executor/manifests/m.yml",
      userPrompt: "role terminal",
      id: "tk-role-keep",
      assigneeKind: "role",
      workspace: {
        workspace: roleLane.workspace,
        worktree: roleLane.worktree,
        branch: roleLane.branch,
        targetBranch: roleLane.targetBranch,
      },
    });
    await patchTaskEnvelope(sysFs, taskPath, {
      state: "accepted",
      status: "taken",
      updatedAt: clock.now(),
    });

    const previewRes = await rpc(svc, "task.worktreeReclaim.preview", {
      workspaceId,
      taskPath,
    });
    assert.ok(!previewRes.error, JSON.stringify(previewRes.error));
    const preview = previewRes.result as { code: string; eligible: boolean };
    assert.equal(preview.code, "NOT_APPLICABLE");
    assert.equal(preview.eligible, false);
    assert.equal(await pathExists(roleLane.worktree), true);

    const omitted = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
    });
    assert.ok(omitted.error, "mutation must not default an omitted actor to user");

    const unauthorized = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor: "intruder",
    });
    assert.ok(unauthorized.error, "non-parent Role must not gain reconcile authority");

    const reconcile = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor: "规划",
    });
    assert.ok(!reconcile.error, JSON.stringify(reconcile.error));
    assert.equal((reconcile.result as { code: string }).code, "NOT_APPLICABLE");
    assert.equal(await pathExists(roleLane.worktree), true, "role lane must survive reconcile");
  });
});

test("P0: terminal+busy late-write defers reclaim until settle+clean", async () => {
  const ws = await makeGitTentWorkspace("reclaim-busy-late");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const systemRoot = path.join(ws, ".tent");
    const sysFs = new NodeFs(systemRoot);
    const clock = { now: () => new Date().toISOString() };
    const taskId = "tk-busy-late";
    const lane = await ensureTaskWorkspace(ws, taskId);
    const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
    const inboxBox = [...tent.byId.values()][0];
    const boxId = inboxBox?.id ?? "bx-1";
    const boxPath = inboxBox?.path ?? "inbox";

    const taskPath = await writeTaskEnvelope(sysFs, clock, {
      parentActor: { kind: "user", id: "user" },
      role: FAKE_DEFAULT_PROFILE_ID,
      claims: [{ id: boxId, path: boxPath }],
      manifestPath: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/manifests/${taskId}.yml`,
      userPrompt: "terminal while turn still busy + late write",
      id: taskId,
      assigneeKind: "agentProfile",
      tasksDir: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/tasks`,
      workspace: {
        workspace: lane.workspace,
        worktree: lane.worktree,
        branch: lane.branch,
        targetBranch: lane.targetBranch,
      },
    });
    await patchTaskEnvelope(sysFs, taskPath, {
      state: "running",
      status: "taken",
      updatedAt: clock.now(),
    });

    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: FAKE_DEFAULT_PROFILE_ID,
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const liveSessionId = (started.result as { session?: { sessionId?: string } }).session
      ?.sessionId;
    assert.ok(liveSessionId, "need a live managed session (busy/alive)");

    // Publish/force collaboration-terminal while the bound Session remains live.
    await patchTaskEnvelope(sysFs, taskPath, {
      state: "failed",
      status: "taken",
      workspace: lane.workspace,
      worktree: lane.worktree,
      branch: lane.branch,
      targetBranch: lane.targetBranch,
      sessionId: liveSessionId,
      updatedAt: clock.now(),
    });

    // Late write + commit after terminal publish (post-Delivery late-write race).
    const lateFile = path.join(lane.worktree, "late-after-terminal.txt");
    await fs.writeFile(lateFile, "late write while session still busy\n");
    await git(lane.worktree, "add", "late-after-terminal.txt");
    await git(lane.worktree, "commit", "-q", "-m", "late post-terminal commit");

    const { enqueueTaskWorktreeReclaimPending } = await import(
      "../src/core/task-worktree-reclaim-queue.js"
    );
    await enqueueTaskWorktreeReclaimPending(sysFs, {
      taskId,
      taskPath,
      workspaceRoot: ws,
      trigger: "test.terminal-busy-late-write",
    });

    const blockedBusy = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(!blockedBusy.error, JSON.stringify(blockedBusy.error));
    assert.equal((blockedBusy.result as { code: string }).code, "SESSION_ACTIVE");
    assert.equal(
      await pathExists(lane.worktree),
      true,
      "lane must stay while bound session is still alive/busy after late write"
    );

    // Install critical-section TOCTOU hook BEFORE session settle: stopSession may
    // immediately retry pending reclaim via session.exited. The hook dirties the
    // lane after evaluate eligibility and before exact remove → DIRTY fail-closed.
    setBeforeTaskWorktreeReclaimRemoveForTests(async () => {
      await fs.writeFile(
        path.join(lane.worktree, "critical-section-race.txt"),
        "dirty after settle gate, before remove\n"
      );
    });
    try {
      try {
        await svc.ctx.runtime.stopSession(liveSessionId, "user");
      } catch {
        // already stopped
      }
      // Drop binding residue so registry cannot keep SESSION_ACTIVE after stop.
      await patchTaskEnvelope(sysFs, taskPath, {
        state: "failed",
        sessionId: null,
        workspace: lane.workspace,
        worktree: lane.worktree,
        branch: lane.branch,
        targetBranch: lane.targetBranch,
        updatedAt: clock.now(),
      });
      await enqueueTaskWorktreeReclaimPending(sysFs, {
        taskId,
        taskPath,
        workspaceRoot: ws,
        trigger: "test.after-session-settle-critical-dirty",
      });
      const blockedDirty = await rpc(svc, "task.worktreeReclaim.reconcile", {
        workspaceId,
        taskPath,
        actor: "user",
      });
      assert.ok(!blockedDirty.error, JSON.stringify(blockedDirty.error));
      assert.equal(
        await pathExists(lane.worktree),
        true,
        "critical-section late write must fail-closed (DIRTY) and keep the lane"
      );
      const previewDirty = await rpc(svc, "task.worktreeReclaim.preview", {
        workspaceId,
        taskPath,
      });
      assert.ok(!previewDirty.error, JSON.stringify(previewDirty.error));
      assert.equal(
        (previewDirty.result as { code: string }).code,
        "DIRTY",
        "preview must report DIRTY after critical-section late write"
      );
    } finally {
      setBeforeTaskWorktreeReclaimRemoveForTests(undefined);
    }

    // Clean the race file; worktree must be clean+settled before reclaim.
    await fs.unlink(path.join(lane.worktree, "critical-section-race.txt"));
    await enqueueTaskWorktreeReclaimPending(sysFs, {
      taskId,
      taskPath,
      workspaceRoot: ws,
      trigger: "test.after-clean-settle",
    });
    const cleaned = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(!cleaned.error, JSON.stringify(cleaned.error));
    assert.equal(
      await pathExists(lane.worktree),
      false,
      `reclaim only after session settle + clean (result=${JSON.stringify(cleaned.result)})`
    );
    // Branch + late commit preserved for audit (exact remove only).
    const branchExists = await git(ws, "show-ref", "--verify", `refs/heads/${lane.branch}`)
      .then(() => true)
      .catch(() => false);
    assert.equal(branchExists, true, "Task branch and commits preserved after reclaim");
    const tipMsg = await git(ws, "log", "-1", "--format=%s", lane.branch);
    assert.match(tipMsg, /late post-terminal commit/);
  });
});
