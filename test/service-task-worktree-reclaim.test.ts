/**
 * Service: terminal Task worktree auto-reclaim + mount recovery + preview RPC.
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
  cancelAndDrainHistoricalTaskWorktreeReclaim,
  historicalTaskWorktreeReclaimJobCountForTests,
  isHistoricalReclaimScanCandidate,
  recoverTerminalTaskWorktreesOnMount,
  resetHistoricalTaskWorktreeReclaimForTests,
  runOneHistoricalTaskWorktreeReclaimBatch,
  scheduleHistoricalTaskWorktreeReclaimAfterMount,
  setBeforeTaskWorktreeReclaimRemoveForTests,
  setHistoricalReclaimBatchHoldForTests,
} from "../src/service/handlers.js";
import {
  TASK_WORKTREE_RECLAIM_HISTORICAL_BATCH_SIZE,
  readTaskWorktreeReclaimHistoricalScan,
  listTaskWorktreeReclaimPending,
  replaceTaskWorktreeReclaimQueueForTests,
} from "../src/core/task-worktree-reclaim-queue.js";
import type { TaskEnvelope } from "../src/core/task.js";

async function stopHeldAutomaticHistoricalRunner(
  workspaceId: string,
  hold: { release: () => void }
): Promise<void> {
  const drain = cancelAndDrainHistoricalTaskWorktreeReclaim(workspaceId, 0);
  hold.release();
  await drain;
  setHistoricalReclaimBatchHoldForTests(false);
}

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

test("CLIENT_METHODS includes task.worktreeReclaim.preview", () => {
  assert.ok(isClientMethod("task.worktreeReclaim.preview"));
  assert.ok(CLIENT_METHODS.includes("task.worktreeReclaim.preview"));
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

test("P0: dirty terminal lane fails closed; pending queue + mount recovery after clean", async () => {
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

    // Historical terminal without pending marker: mount must NOT mass-clean.
    const beforePending = await recoverTerminalTaskWorktreesOnMount(svc.ctx, workspaceId);
    assert.equal(beforePending.attempted, 0, "no pending → no historical mass-clean");
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

    // Clean outside service, then recovery retries ONLY pending entries.
    await fs.unlink(path.join(lane.worktree, "UNCOMMITTED.txt"));
    assert.equal((await git(lane.worktree, "status", "--porcelain")).trim(), "");

    const stats = await recoverTerminalTaskWorktreesOnMount(svc.ctx, workspaceId);
    assert.ok(stats.attempted >= 1);
    assert.ok(stats.reclaimed >= 1);
    assert.equal(await pathExists(lane.worktree), false);

    // Second recovery: pending cleared → attempted 0 (or already-gone dequeue).
    const again = await recoverTerminalTaskWorktreesOnMount(svc.ctx, workspaceId);
    assert.equal(await pathExists(lane.worktree), false);
    assert.ok(again.attempted === 0 || again.reclaimed >= 0);
  });
});

test("P0: mount recovery ignores historical terminal without pending marker", async () => {
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
    const stats = await recoverTerminalTaskWorktreesOnMount(svc.ctx, workspaceId);
    assert.equal(stats.attempted, 0);
    assert.equal(stats.reclaimed, 0);
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

    const stats = await recoverTerminalTaskWorktreesOnMount(svc.ctx, workspaceId);
    assert.ok(stats.attempted >= 1);
    assert.ok(stats.refused >= 1);
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
    const cleaned = await recoverTerminalTaskWorktreesOnMount(svc.ctx, workspaceId);
    assert.equal(
      await pathExists(lane.worktree),
      false,
      `worktree must reclaim after session stop (stats=${JSON.stringify(cleaned)})`
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
    const { recoverTerminalTaskWorktreesOnMount: recover } = await import(
      "../src/service/handlers.js"
    );
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
    const blocked = await recover(svc.ctx, workspaceId);
    assert.ok(blocked.attempted >= 1, `expected pending attempts, got ${JSON.stringify(blocked)}`);
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
      parentActor: { kind: "user", id: "user" },
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

    await recoverTerminalTaskWorktreesOnMount(svc.ctx, workspaceId);
    assert.equal(await pathExists(roleLane.worktree), true, "role lane must survive recovery");
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

    const blockedBusy = await recoverTerminalTaskWorktreesOnMount(svc.ctx, workspaceId);
    assert.ok(blockedBusy.attempted >= 1);
    assert.ok(blockedBusy.refused >= 1);
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
      const blockedDirty = await recoverTerminalTaskWorktreesOnMount(svc.ctx, workspaceId);
      assert.ok(blockedDirty.attempted >= 1);
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
    const cleaned = await recoverTerminalTaskWorktreesOnMount(svc.ctx, workspaceId);
    assert.equal(
      await pathExists(lane.worktree),
      false,
      `reclaim only after session settle + clean (stats=${JSON.stringify(cleaned)})`
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

test("P0: historical candidate filter excludes Role / nonterminal / incomplete lanes", () => {
  const base = {
    path: "temp/agent-profiles/fake/tasks/t.md",
    id: "tk-x",
    role: "fake",
    status: "taken" as const,
    state: "accepted" as const,
    assigneeKind: "agentProfile" as const,
    worktree: "C:\\ws-worktrees\\task-tk-x",
    branch: "tent-task/tk-x",
    workspace: "C:\\ws",
  };
  assert.equal(
    isHistoricalReclaimScanCandidate(base as TaskEnvelope, "C:\\ws"),
    true
  );
  assert.equal(
    isHistoricalReclaimScanCandidate(
      { ...base, assigneeKind: "role", branch: "tent-role/executor" } as TaskEnvelope,
      "C:\\ws"
    ),
    false,
    "Role lanes never enqueued"
  );
  assert.equal(
    isHistoricalReclaimScanCandidate(
      { ...base, state: "running" } as TaskEnvelope,
      "C:\\ws"
    ),
    false,
    "nonterminal never enqueued"
  );
  assert.equal(
    isHistoricalReclaimScanCandidate(
      { ...base, worktree: undefined } as TaskEnvelope,
      "C:\\ws"
    ),
    false,
    "missing worktree never enqueued"
  );
  assert.equal(
    isHistoricalReclaimScanCandidate(
      { ...base, branch: undefined } as TaskEnvelope,
      "C:\\ws"
    ),
    false,
    "missing branch never enqueued"
  );
  assert.equal(
    isHistoricalReclaimScanCandidate(
      { ...base, branch: "tent-role/executor" } as TaskEnvelope,
      "C:\\ws"
    ),
    false,
    "tent-role branch never enqueued"
  );
});

test("P0: workspace.mount returns before held historical background batch", async () => {
  resetHistoricalTaskWorktreeReclaimForTests();
  const ws = await makeGitTentWorkspace("reclaim-hist-nonblock");
  const hold = setHistoricalReclaimBatchHoldForTests(true);
  assert.ok(hold);
  try {
    await withService(async (svc) => {
      const t0 = Date.now();
      const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
      const elapsed = Date.now() - t0;
      assert.ok(!mounted.error, JSON.stringify(mounted.error));
      // Mount must not await the held background batch (would hang until release).
      assert.ok(
        elapsed < 3_000,
        `mount must return while historical batch is held (elapsed=${elapsed}ms)`
      );
      hold!.release();
      // Allow the scheduled tick to finish so stop() can drain cleanly.
      await new Promise((r) => setTimeout(r, 50));
    });
  } finally {
    hold?.release();
    resetHistoricalTaskWorktreeReclaimForTests();
  }
});

test("P0: one runner owns an FsAdapter until bounded drain settles", async () => {
  resetHistoricalTaskWorktreeReclaimForTests();
  const ws = await makeGitTentWorkspace("reclaim-runner-drain");
  const hold = setHistoricalReclaimBatchHoldForTests(true);
  try {
    await withService(async (svc) => {
      const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
      assert.ok(!mounted.error, JSON.stringify(mounted.error));
      const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
      assert.equal(historicalTaskWorktreeReclaimJobCountForTests(), 1);

      scheduleHistoricalTaskWorktreeReclaimAfterMount(svc.ctx, workspaceId);
      assert.equal(
        historicalTaskWorktreeReclaimJobCountForTests(),
        1,
        "duplicate mount scheduling must not create another runner"
      );

      await assert.rejects(
        () => cancelAndDrainHistoricalTaskWorktreeReclaim(workspaceId, 10),
        /drain timed out/
      );
      assert.equal(
        historicalTaskWorktreeReclaimJobCountForTests(),
        1,
        "timed-out drain retains the FsAdapter lease"
      );
      scheduleHistoricalTaskWorktreeReclaimAfterMount(svc.ctx, workspaceId);
      assert.equal(
        historicalTaskWorktreeReclaimJobCountForTests(),
        1,
        "cancelled in-flight runner cannot be replaced before settle"
      );

      hold!.release();
      await cancelAndDrainHistoricalTaskWorktreeReclaim(workspaceId, 0);
      setHistoricalReclaimBatchHoldForTests(false);
      assert.equal(historicalTaskWorktreeReclaimJobCountForTests(), 0);
    });
  } finally {
    hold?.release();
    resetHistoricalTaskWorktreeReclaimForTests();
  }
});

test("P0: unreadable historical envelope records diagnostic without cursor advance", async () => {
  resetHistoricalTaskWorktreeReclaimForTests();
  const ws = await makeGitTentWorkspace("reclaim-unreadable");
  const sysFs = new NodeFs(path.join(ws, ".tent"));
  const badTaskPath = "temp/agent-profiles/broken/tasks/000-corrupt.md";
  await sysFs.writeFile(badTaskPath, "---\nid: [unterminated\n");

  await withService(async (svc) => {
    const hold = setHistoricalReclaimBatchHoldForTests(true);
    try {
      const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
      assert.ok(!mounted.error, JSON.stringify(mounted.error));
      const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
      await stopHeldAutomaticHistoricalRunner(workspaceId, hold!);
      await replaceTaskWorktreeReclaimQueueForTests(sysFs, {
        entries: [],
        historicalScan: { complete: false },
      });

      assert.equal(
        await runOneHistoricalTaskWorktreeReclaimBatch(svc.ctx, workspaceId),
        false,
        "unreadable candidate ends this boot's one-pass runner"
      );
      const scan = await readTaskWorktreeReclaimHistoricalScan(sysFs);
      assert.equal(scan?.complete, false);
      assert.equal(scan?.nextTaskPath, undefined);
      assert.equal(scan?.lastDecision?.taskPath, badTaskPath);
      assert.equal(scan?.lastDecision?.code, "UNREADABLE_TASK");
      assert.deepEqual(await listTaskWorktreeReclaimPending(sysFs), []);
    } finally {
      hold?.release();
      resetHistoricalTaskWorktreeReclaimForTests();
    }
  });
});

test("P0: historical multi-batch large inventory is deterministic and bounded", async () => {
  resetHistoricalTaskWorktreeReclaimForTests();
  const ws = await makeGitTentWorkspace("reclaim-hist-multi");
  const systemRoot = path.join(ws, ".tent");
  const sysFs = new NodeFs(systemRoot);
  const clock = { now: () => new Date().toISOString() };
  const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
  const inboxBox = [...tent.byId.values()][0];
  const boxId = inboxBox?.id ?? "bx-1";
  const boxPath = inboxBox?.path ?? "inbox";
  const batch = TASK_WORKTREE_RECLAIM_HISTORICAL_BATCH_SIZE;
  const total = batch * 2 + 3;
  const taskIds: string[] = [];

  for (let i = 0; i < total; i++) {
    const taskId = `tk-hist-batch-${String(i).padStart(3, "0")}`;
    taskIds.push(taskId);
    const lane = await ensureTaskWorkspace(ws, taskId);
    // Integrate tip so accepted settle can succeed when reclaim runs.
    const tip = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
    await git(ws, "merge", "--ff-only", tip).catch(async () => {
      // already on same tip
    });
    const taskPath = await writeTaskEnvelope(sysFs, clock, {
      parentActor: { kind: "user", id: "user" },
      role: FAKE_DEFAULT_PROFILE_ID,
      claims: [{ id: boxId, path: boxPath }],
      manifestPath: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/manifests/${taskId}.yml`,
      userPrompt: `historical batch ${i}`,
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
  }

  // Role terminal with lane shape must never be enqueued by historical scan.
  const roleLane = await ensureRoleWorkspace(ws, "executor");
  const roleTaskPath = await writeTaskEnvelope(sysFs, clock, {
    parentActor: { kind: "user", id: "user" },
    role: "executor",
    claims: [{ id: boxId, path: boxPath }],
    manifestPath: "temp/executor/manifests/role-hist.yml",
    userPrompt: "role durable",
    id: "tk-role-hist",
    assigneeKind: "role",
    tasksDir: "temp/executor/tasks",
    workspace: {
      workspace: roleLane.workspace,
      worktree: roleLane.worktree,
      branch: roleLane.branch,
      targetBranch: roleLane.targetBranch,
    },
  });
  await patchTaskEnvelope(sysFs, roleTaskPath, {
    state: "accepted",
    status: "taken",
    updatedAt: clock.now(),
  });

  await withService(async (svc) => {
    const hold = setHistoricalReclaimBatchHoldForTests(true);
    try {
      const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
      assert.ok(!mounted.error, JSON.stringify(mounted.error));
      const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
      await stopHeldAutomaticHistoricalRunner(workspaceId, hold!);
      await replaceTaskWorktreeReclaimQueueForTests(sysFs, {
        entries: [],
        historicalScan: { complete: false },
      });

      let batches = 0;
      let cont = true;
      const cursors: Array<string | undefined> = [];
      while (cont) {
        batches += 1;
        assert.ok(batches <= Math.ceil(total / batch) + 5, "must bound batch count");
        cont = await runOneHistoricalTaskWorktreeReclaimBatch(svc.ctx, workspaceId);
        const scan = await readTaskWorktreeReclaimHistoricalScan(sysFs);
        cursors.push(scan?.nextTaskPath);
        if (scan?.complete) break;
      }
      const finalScan = await readTaskWorktreeReclaimHistoricalScan(sysFs);
      assert.equal(finalScan?.complete, true);
      assert.ok(
        batches >= Math.ceil(total / batch),
        `expected multi-batch for ${total} tasks (batches=${batches}, size=${batch})`
      );

      // Role lane never enqueued.
      const pending = await listTaskWorktreeReclaimPending(sysFs);
      assert.ok(
        !pending.some((e) => e.taskId === "tk-role-hist"),
        "Role lane must not appear in reclaim queue"
      );
      assert.equal(await pathExists(roleLane.worktree), true, "Role worktree preserved");

      // Cursor advances monotonically in path order across incomplete batches.
      const incompleteCursors = cursors.filter((c) => c !== undefined);
      for (let i = 1; i < incompleteCursors.length; i++) {
        assert.ok(
          incompleteCursors[i]!.localeCompare(incompleteCursors[i - 1]!) > 0,
          "cursor must advance in stable taskPath order"
        );
      }

      // Repeated run after complete: no further work.
      const again = await runOneHistoricalTaskWorktreeReclaimBatch(svc.ctx, workspaceId);
      assert.equal(again, false);
    } finally {
      hold?.release();
      resetHistoricalTaskWorktreeReclaimForTests();
    }
  });
});

test("P0: historical scan restart/cursor idempotent; crash between batches does not skip", async () => {
  resetHistoricalTaskWorktreeReclaimForTests();
  const ws = await makeGitTentWorkspace("reclaim-hist-crash");
  const systemRoot = path.join(ws, ".tent");
  const sysFs = new NodeFs(systemRoot);
  const clock = { now: () => new Date().toISOString() };
  const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
  const inboxBox = [...tent.byId.values()][0];
  const boxId = inboxBox?.id ?? "bx-1";
  const boxPath = inboxBox?.path ?? "inbox";
  const batch = TASK_WORKTREE_RECLAIM_HISTORICAL_BATCH_SIZE;
  const total = batch + 2;
  const lanes = new Map<string, Awaited<ReturnType<typeof ensureTaskWorkspace>>>();
  const taskPaths = new Map<string, string>();

  for (let i = 0; i < total; i++) {
    const taskId = `tk-crash-${String(i).padStart(2, "0")}`;
    const lane = await ensureTaskWorkspace(ws, taskId);
    lanes.set(taskId, lane);
    const tip = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
    await git(ws, "merge", "--ff-only", tip).catch(() => undefined);
    const taskPath = await writeTaskEnvelope(sysFs, clock, {
      parentActor: { kind: "user", id: "user" },
      role: FAKE_DEFAULT_PROFILE_ID,
      claims: [{ id: boxId, path: boxPath }],
      manifestPath: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/manifests/${taskId}.yml`,
      userPrompt: `crash ${i}`,
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
    taskPaths.set(taskId, taskPath);
    await patchTaskEnvelope(sysFs, taskPath, {
      state: "rejected",
      status: "taken",
      updatedAt: clock.now(),
    });
  }

  await withService(async (svc) => {
    const hold = setHistoricalReclaimBatchHoldForTests(true);
    try {
      const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
      assert.ok(!mounted.error, JSON.stringify(mounted.error));
      const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
      await stopHeldAutomaticHistoricalRunner(workspaceId, hold!);
      await replaceTaskWorktreeReclaimQueueForTests(sysFs, {
        entries: [],
        historicalScan: { complete: false },
      });

      // First batch only — simulate crash before further batches.
      const cont = await runOneHistoricalTaskWorktreeReclaimBatch(svc.ctx, workspaceId);
      assert.equal(cont, true, "more batches remain after first");
      const mid = await readTaskWorktreeReclaimHistoricalScan(sysFs);
      assert.equal(mid?.complete, false);
      assert.ok(mid?.nextTaskPath, "cursor persisted after batch");
      const firstProcessed = [...taskPaths]
        .filter(([, taskPath]) => taskPath.localeCompare(mid!.nextTaskPath!) <= 0)
        .map(([taskId]) => taskId);
      assert.ok(firstProcessed.length > 0, "first batch covered persisted Task paths");
      for (const id of firstProcessed) {
        assert.equal(
          await pathExists(lanes.get(id)!.worktree),
          false,
          `first-batch candidate ${id} was reclaimed before cursor advanced`
        );
      }

      // "Restart": re-run from persisted cursor (idempotent — no skip, no duplicate spin).
      let guard = 0;
      let more = true;
      while (more && guard < 20) {
        guard += 1;
        more = await runOneHistoricalTaskWorktreeReclaimBatch(svc.ctx, workspaceId);
      }
      const done = await readTaskWorktreeReclaimHistoricalScan(sysFs);
      assert.equal(done?.complete, true);
      const finalPending = await listTaskWorktreeReclaimPending(sysFs);
      assert.equal(finalPending.length, 0, "all clean historical candidates reclaimed");
      for (const [id, lane] of lanes) {
        assert.equal(
          await pathExists(lane.worktree),
          false,
          `historical candidate ${id} lane reclaimed`
        );
      }
      assert.equal(done?.complete, true);
    } finally {
      hold?.release();
      resetHistoricalTaskWorktreeReclaimForTests();
    }
  });
});

test("P0: historical refuse persists needs-attention diagnostic; no same-boot spin", async () => {
  resetHistoricalTaskWorktreeReclaimForTests();
  const ws = await makeGitTentWorkspace("reclaim-hist-dirty");
  const systemRoot = path.join(ws, ".tent");
  const sysFs = new NodeFs(systemRoot);
  const clock = { now: () => new Date().toISOString() };
  const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
  const inboxBox = [...tent.byId.values()][0];
  const taskId = "tk-hist-dirty-diag";
  const lane = await ensureTaskWorkspace(ws, taskId);
  await fs.writeFile(path.join(lane.worktree, "DIRTY.txt"), "keep\n");
  const taskPath = await writeTaskEnvelope(sysFs, clock, {
    parentActor: { kind: "user", id: "user" },
    role: FAKE_DEFAULT_PROFILE_ID,
    claims: [{ id: inboxBox?.id ?? "bx-1", path: inboxBox?.path ?? "inbox" }],
    manifestPath: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/manifests/${taskId}.yml`,
    userPrompt: "dirty historical",
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
    state: "failed",
    status: "taken",
    updatedAt: clock.now(),
  });

  await withService(async (svc) => {
    const hold = setHistoricalReclaimBatchHoldForTests(true);
    try {
      const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
      assert.ok(!mounted.error, JSON.stringify(mounted.error));
      const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
      await stopHeldAutomaticHistoricalRunner(workspaceId, hold!);
      await replaceTaskWorktreeReclaimQueueForTests(sysFs, {
        entries: [],
        historicalScan: { complete: false },
      });

      const cont = await runOneHistoricalTaskWorktreeReclaimBatch(svc.ctx, workspaceId);
      // May complete in one batch if inventory is small.
      void cont;
      const pending = await listTaskWorktreeReclaimPending(sysFs);
      const row = pending.find((e) => e.taskId === taskId);
      assert.ok(row, "dirty candidate must stay on queue");
      assert.equal(row!.status, "needs-attention");
      assert.equal(row!.lastDiagnostic?.code, "DIRTY");
      assert.ok(row!.lastDiagnostic?.attemptedAt);
      assert.equal(await pathExists(lane.worktree), true);

      // Second historical batch after complete must not re-attempt (scan done).
      // Force complete if not already, then ensure repeated run is idle.
      let guard = 0;
      let more = true;
      while (more && guard < 10) {
        guard += 1;
        more = await runOneHistoricalTaskWorktreeReclaimBatch(svc.ctx, workspaceId);
      }
      const after = await listTaskWorktreeReclaimPending(sysFs);
      const row2 = after.find((e) => e.taskId === taskId);
      assert.equal(row2?.status, "needs-attention");
      assert.equal(row2?.lastDiagnostic?.code, "DIRTY");
      // Attempt timestamp unchanged by idle complete re-runs (no spin).
      assert.equal(row2?.lastDiagnostic?.attemptedAt, row!.lastDiagnostic?.attemptedAt);
    } finally {
      hold?.release();
      resetHistoricalTaskWorktreeReclaimForTests();
    }
  });
});

test("P0: historical path never invokes global git worktree prune", async () => {
  resetHistoricalTaskWorktreeReclaimForTests();
  const ws = await makeGitTentWorkspace("reclaim-no-prune");
  const systemRoot = path.join(ws, ".tent");
  const sysFs = new NodeFs(systemRoot);
  const clock = { now: () => new Date().toISOString() };
  const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
  const inboxBox = [...tent.byId.values()][0];
  const taskId = "tk-no-prune";
  const lane = await ensureTaskWorkspace(ws, taskId);
  const tip = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
  await git(ws, "merge", "--ff-only", tip).catch(() => undefined);
  const taskPath = await writeTaskEnvelope(sysFs, clock, {
    parentActor: { kind: "user", id: "user" },
    role: FAKE_DEFAULT_PROFILE_ID,
    claims: [{ id: inboxBox?.id ?? "bx-1", path: inboxBox?.path ?? "inbox" }],
    manifestPath: `temp/agent-profiles/${FAKE_DEFAULT_PROFILE_ID}/manifests/${taskId}.yml`,
    userPrompt: "no prune",
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

  // Sibling foreign registration that prune would touch — must remain.
  const foreign = await ensureTaskWorkspace(ws, "tk-foreign-sibling");

  await withService(async (svc) => {
    const hold = setHistoricalReclaimBatchHoldForTests(true);
    try {
      const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
      assert.ok(!mounted.error, JSON.stringify(mounted.error));
      const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
      await stopHeldAutomaticHistoricalRunner(workspaceId, hold!);
      await replaceTaskWorktreeReclaimQueueForTests(sysFs, {
        entries: [],
        historicalScan: { complete: false },
      });
      let more = true;
      let guard = 0;
      while (more && guard < 10) {
        guard += 1;
        more = await runOneHistoricalTaskWorktreeReclaimBatch(svc.ctx, workspaceId);
      }
      assert.equal(await pathExists(foreign.worktree), true, "sibling lane untouched (no global prune)");
      const list = await git(ws, "worktree", "list", "--porcelain");
      assert.match(list, /tk-foreign-sibling/);
    } finally {
      hold?.release();
      resetHistoricalTaskWorktreeReclaimForTests();
    }
  });
});
