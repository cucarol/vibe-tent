/**
 * Service: explicit exact-Task worktree preview/reconcile RPC.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { createServiceClient } from "../src/service/client.js";
import { rpcCall } from "../src/service/http-server.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";
import { ensureRoleWorkspace, ensureTaskWorkspace } from "../src/core/workspace.js";
import { writeTaskRecord, patchTaskRecord, loadTaskRecord } from "../src/core/task.js";
import { createTaskResult } from "../src/core/task-result.js";
import { configureTestGitIdentity, git } from "./helpers.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import {
  setBeforeTaskWorktreeReclaimRemoveForTests,
} from "../src/service/handlers.js";
import type { TaskRecord } from "../src/core/task.js";

const FAKE_DEFAULT_CONNECTION_ID = "fake-default";
const FAKE_CONNECTION = {
  connectionId: FAKE_DEFAULT_CONNECTION_ID,
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, sleepMs: 60_000 },
} as const;

function taskNodeContext(id: string, nodePath: string) {
  return {
    nodeIds: [id],
    nodeSnapshots: [
      { id, path: nodePath, type: "prompt", archived: false, tags: [], body: "", etag: "a".repeat(24) },
    ],
  };
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
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await git(workspace, "add", "-A");
  await git(workspace, "commit", "-q", "-m", "scaffold tent");
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
    connections: [FAKE_CONNECTION],
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

test("terminal reject preserves the lane until explicit exact reconcile", async () => {
  const ws = await makeGitTentWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const systemRoot = path.join(ws, ".tent");
    const sysFs = new NodeFs(systemRoot);
    const clock = { now: () => new Date().toISOString() };
    const taskId = "tk-svcreclaim1";
    const lane = await ensureTaskWorkspace(ws, taskId);

    // Prefer real box id from tent tree when available.
    const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
    const inboxNode =
      [...tent.byId.values()].find((b) => b.path === "inbox" || b.path.endsWith("/inbox")) ??
      [...tent.byId.values()][0];
    const nodeId = inboxNode?.id ?? "cx-inbox";
    const nodePath = inboxNode?.path ?? "inbox";

    const taskPath = await writeTaskRecord(sysFs, clock, {
      requester: { kind: "user", id: "user" },
      executionSessionId: "ss-fakedefault",
      ...taskNodeContext(nodeId, nodePath),
      manifestPath: `temp/sessions/ss-fakedefault/manifests/${taskId}.yml`,
      prompt: "reclaim after reject",
      id: taskId,
      workspace: {
        workspace: lane.workspace,
        worktree: lane.worktree,
        branch: lane.branch,
        targetBranch: lane.targetBranch,
      },
    });
    await patchTaskRecord(sysFs, taskPath, {
      state: "submitted",
      updatedAt: clock.now(),
    });
    const result = await createTaskResult(sysFs, clock, {
      taskId,
      report: "ready for terminal reject",
      status: "ready",
      resultsDir: `temp/sessions/ss-fakedefault/results`,
    });
    await patchTaskRecord(sysFs, taskPath, {
      currentResultId: result.id,
      updatedAt: clock.now(),
    });
    const sessionAt = clock.now();
    await svc.ctx.runtime.registry.create({
      id: "ss-fakedefault",
      adapterId: "external",
      state: "stopped",
      workspace: workspaceId,
      currentTaskId: taskId,
      createdAt: sessionAt,
      updatedAt: sessionAt,
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
      resultId: result.id,
      actor: "user",
      resume: false,
      note: "no rework",
    });
    assert.ok(!rejectedRes.error, JSON.stringify(rejectedRes.error));
    const rejected = rejectedRes.result as { state: string };
    assert.equal(rejected.state, "rejected");

    assert.equal(await pathExists(lane.worktree), true, "review does not auto-delete worktrees");
    const reclaimed = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(!reclaimed.error, JSON.stringify(reclaimed.error));
    assert.equal(
      (reclaimed.result as { reclaimed: boolean }).reclaimed,
      true,
      JSON.stringify(reclaimed.result)
    );
    assert.equal(await pathExists(lane.worktree), false);
    // Task envelope remains for audit.
    const task = await loadTaskRecord(sysFs, taskPath);
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
  const taskId = "tk-svcreclaimdirty";
  const lane = await ensureTaskWorkspace(ws, taskId);
  await fs.writeFile(path.join(lane.worktree, "UNCOMMITTED.txt"), "dirty\n");

  const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
  const inboxNode =
    [...tent.byId.values()].find((b) => b.path === "inbox" || b.path.endsWith("/inbox")) ??
    [...tent.byId.values()][0];
  const nodeId = inboxNode?.id ?? "cx-inbox";
  const nodePath = inboxNode?.path ?? "inbox";

  const taskPath = await writeTaskRecord(sysFs, clock, {
    requester: { kind: "user", id: "user" },
    executionSessionId: "ss-fakedefault",
    ...taskNodeContext(nodeId, nodePath),
    manifestPath: `temp/sessions/ss-fakedefault/manifests/${taskId}.yml`,
    prompt: "dirty then clean",
    id: taskId,
    workspace: {
      workspace: lane.workspace,
      worktree: lane.worktree,
      branch: lane.branch,
      targetBranch: lane.targetBranch,
    },
  });
  await patchTaskRecord(sysFs, taskPath, {
    state: "submitted",
    updatedAt: clock.now(),
  });
  const result = await createTaskResult(sysFs, clock, {
    taskId,
    report: "terminal via interrupt path",
    status: "ready",
    resultsDir: `temp/sessions/ss-fakedefault/results`,
  });
  await patchTaskRecord(sysFs, taskPath, {
    currentResultId: result.id,
    updatedAt: clock.now(),
  });

  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    // Mount never scans historical inventory or mutates this lane.
    assert.equal(await pathExists(lane.worktree), true);

    const sessionAt = clock.now();
    await svc.ctx.runtime.registry.create({
      id: "ss-fakedefault",
      adapterId: "external",
      state: "stopped",
      workspace: workspaceId,
      currentTaskId: taskId,
      createdAt: sessionAt,
      updatedAt: sessionAt,
    });

    // Terminal reject leaves the dirty scene intact.
    const rejectedRes = await rpc(svc, "task.reject", {
      workspaceId,
      resultId: result.id,
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
  const taskId = "tk-historicalonly";
  const lane = await ensureTaskWorkspace(ws, taskId);
  const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
  const inboxNode = [...tent.byId.values()][0];
  const taskPath = await writeTaskRecord(sysFs, clock, {
    requester: { kind: "user", id: "user" },
    executionSessionId: "ss-fakedefault",
    ...taskNodeContext(inboxNode?.id ?? "cx-1", inboxNode?.path ?? "inbox"),
    manifestPath: `temp/sessions/ss-fakedefault/manifests/${taskId}.yml`,
    prompt: "old terminal never observed by reclaim feature",
    id: taskId,
    workspace: {
      workspace: lane.workspace,
      worktree: lane.worktree,
      branch: lane.branch,
      targetBranch: lane.targetBranch,
    },
  });
  await patchTaskRecord(sysFs, taskPath, {
    state: "accepted",
    updatedAt: clock.now(),
  });

  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
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
    const taskId = "tk-sessactive";
    const lane = await ensureTaskWorkspace(ws, taskId);
    const managedSessionId = "ss-sessactive";
    await svc.ctx.runtime.reserveSession({
      sessionId: managedSessionId,
      connectionId: FAKE_DEFAULT_CONNECTION_ID,
      currentTaskId: taskId,
      workspace: workspaceId,
      workspaceLane: lane,
      runtimeWorkspace: { cwd: lane.worktree },
    });
    const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
    const inboxNode = [...tent.byId.values()][0];
    const nodeId = inboxNode?.id ?? "cx-1";
    const nodePath = inboxNode?.path ?? "inbox";

    const taskPath = await writeTaskRecord(sysFs, clock, {
      requester: { kind: "user", id: "user" },
      executionSessionId: managedSessionId,
      ...taskNodeContext(nodeId, nodePath),
      manifestPath: `temp/sessions/${managedSessionId}/manifests/${taskId}.yml`,
      prompt: "session still live",
      id: taskId,
      workspace: {
        workspace: lane.workspace,
        worktree: lane.worktree,
        branch: lane.branch,
        targetBranch: lane.targetBranch,
      },
    });
    await patchTaskRecord(sysFs, taskPath, {
      state: "running",
      updatedAt: clock.now(),
    });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const liveSessionId = (started.result as { session?: { sessionId?: string } }).session
      ?.sessionId;
    assert.ok(liveSessionId, "need a live managed session id");

    // Force terminal without stopping the live session (simulates race / external leave lag).
    await patchTaskRecord(sysFs, taskPath, {
      state: "failed",
      workspace: lane.workspace,
      worktree: lane.worktree,
      branch: lane.branch,
      targetBranch: lane.targetBranch,
      executionSessionId: liveSessionId,
      updatedAt: clock.now(),
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
    // The exact stopped binding is sufficient; no global Session scan is used.
    await patchTaskRecord(sysFs, taskPath, {
      state: "failed",
      workspace: lane.workspace,
      worktree: lane.worktree,
      branch: lane.branch,
      targetBranch: lane.targetBranch,
      updatedAt: clock.now(),
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

test("external Session leave never deletes a lane; explicit reconcile remains exact", async () => {
  const ws = await makeGitTentWorkspace("reclaim-ext-leave");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const systemRoot = path.join(ws, ".tent");
    const sysFs = new NodeFs(systemRoot);
    const clock = { now: () => new Date().toISOString() };
    const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
    const inboxNode = [...tent.byId.values()][0];
    const nodeId = inboxNode?.id ?? "cx-1";
    const nodePath = inboxNode?.path ?? "inbox";

    const targetId = "tk-exttarget";
    const otherId = "tk-extother";
    const targetLane = await ensureTaskWorkspace(ws, targetId);
    const otherLane = await ensureTaskWorkspace(ws, otherId);

    const targetPath = await writeTaskRecord(sysFs, clock, {
      requester: { kind: "user", id: "user" },
      executionSessionId: "ss-fakedefault",
      ...taskNodeContext(nodeId, nodePath),
      manifestPath: `temp/sessions/ss-fakedefault/manifests/${targetId}.yml`,
      prompt: "accepted under external session",
      id: targetId,
      workspace: {
        workspace: targetLane.workspace,
        worktree: targetLane.worktree,
        branch: targetLane.branch,
        targetBranch: targetLane.targetBranch,
        baseCommit: targetLane.baseCommit,
      },
    });
    const otherPath = await writeTaskRecord(sysFs, clock, {
      requester: { kind: "user", id: "user" },
      executionSessionId: "ss-fakedefault",
      ...taskNodeContext(nodeId, nodePath),
      manifestPath: `temp/sessions/ss-fakedefault/manifests/${otherId}.yml`,
      prompt: "unrelated pending must stay",
      id: otherId,
      workspace: {
        workspace: otherLane.workspace,
        worktree: otherLane.worktree,
        branch: otherLane.branch,
        targetBranch: otherLane.targetBranch,
        baseCommit: otherLane.baseCommit,
      },
    });

    // Enter external session bound to the target task.
    const entered = await rpc(svc, "session.enter", {
      workspaceId,
      roleId: "rl-executor",
      externalKey: "reclaim-ext-key",
      cwd: targetLane.worktree,
      currentTaskId: targetId,
    });
    assert.ok(!entered.error, JSON.stringify(entered.error));
    const sessionId = (entered.result as { session: { sessionId: string } }).session
      .sessionId;

    await patchTaskRecord(sysFs, targetPath, {
      state: "accepted",
      executionSessionId: sessionId,
      workspace: targetLane.workspace,
      worktree: targetLane.worktree,
      branch: targetLane.branch,
      targetBranch: targetLane.targetBranch,
      updatedAt: clock.now(),
    });
    await patchTaskRecord(sysFs, otherPath, {
      state: "failed",
      workspace: otherLane.workspace,
      worktree: otherLane.worktree,
      branch: otherLane.branch,
      targetBranch: otherLane.targetBranch,
      updatedAt: clock.now(),
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

    // Leave external — never submit/review and never auto-delete a worktree.
    const left = await rpc(svc, "session.leave", {
      workspaceId,
      sessionId,
    });
    assert.ok(!left.error, JSON.stringify(left.error));
    const leftBody = left.result as { left: boolean };
    assert.equal(leftBody.left, true);

    assert.equal(await pathExists(targetLane.worktree), true);
    const reconciled = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath: targetPath,
      actor: "user",
    });
    assert.ok(!reconciled.error, JSON.stringify(reconciled.error));
    assert.equal(
      (reconciled.result as { reclaimed: boolean }).reclaimed,
      true,
      JSON.stringify(reconciled.result)
    );
    assert.equal(await pathExists(targetLane.worktree), false);
    assert.equal(
      await pathExists(otherLane.worktree),
      true,
      "unrelated exact Task lane must remain untouched"
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
    const inboxNode =
      [...tent.byId.values()].find((b) => b.path === "inbox" || b.path.endsWith("/inbox")) ??
      [...tent.byId.values()][0];
    const nodeId = inboxNode?.id ?? "cx-inbox";
    const nodePath = inboxNode?.path ?? "inbox";

    const taskPath = await writeTaskRecord(sysFs, clock, {
      requester: { kind: "role", id: "rl-executor" },
      assigneeRoleId: "rl-executor",
      ...taskNodeContext(nodeId, nodePath),
      manifestPath: "temp/roles/rl-executor/manifests/m.yml",
      prompt: "role terminal",
      id: "tk-rolekeep",

      workspace: {
        workspace: roleLane.workspace,
        worktree: roleLane.worktree,
        branch: roleLane.branch,
        targetBranch: roleLane.targetBranch,
      },
    });
    await patchTaskRecord(sysFs, taskPath, {
      state: "accepted",
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

    const localImpersonation = await rpc(svc, "task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor: "rl-executor",
    });
    assert.ok(localImpersonation.error, "local caller cannot impersonate the parent Role");

    const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const entered = (await root.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      cwd: roleLane.worktree,
      externalKey: "reclaim-role-authority",
    })) as { session: { sessionId: string }; sessionToken: string };
    const roleClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: entered.session.sessionId,
      currentSessionToken: entered.sessionToken,
    });
    const reconcile = await roleClient.tryCall("task.worktreeReclaim.reconcile", {
      workspaceId,
      taskPath,
      actor: "rl-executor",
    });
    assert.equal(reconcile.ok, true, reconcile.ok ? undefined : reconcile.error.message);
    if (!reconcile.ok) return;
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
    const taskId = "tk-busylate";
    const lane = await ensureTaskWorkspace(ws, taskId);
    const managedSessionId = "ss-busylate";
    await svc.ctx.runtime.reserveSession({
      sessionId: managedSessionId,
      connectionId: FAKE_DEFAULT_CONNECTION_ID,
      currentTaskId: taskId,
      workspace: workspaceId,
      workspaceLane: lane,
      runtimeWorkspace: { cwd: lane.worktree },
    });
    const tent = await import("../src/core/tree.js").then((m) => m.loadTent(sysFs));
    const inboxNode = [...tent.byId.values()][0];
    const nodeId = inboxNode?.id ?? "cx-1";
    const nodePath = inboxNode?.path ?? "inbox";

    const taskPath = await writeTaskRecord(sysFs, clock, {
      requester: { kind: "user", id: "user" },
      executionSessionId: managedSessionId,
      ...taskNodeContext(nodeId, nodePath),
      manifestPath: `temp/sessions/${managedSessionId}/manifests/${taskId}.yml`,
      prompt: "terminal while turn still busy + late write",
      id: taskId,
      workspace: {
        workspace: lane.workspace,
        worktree: lane.worktree,
        branch: lane.branch,
        targetBranch: lane.targetBranch,
      },
    });
    await patchTaskRecord(sysFs, taskPath, {
      state: "running",
      updatedAt: clock.now(),
    });

    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const liveSessionId = (started.result as { session?: { sessionId?: string } }).session
      ?.sessionId;
    assert.ok(liveSessionId, "need a live managed session (busy/alive)");

    // Publish/force collaboration-terminal while the bound Session remains live.
    await patchTaskRecord(sysFs, taskPath, {
      state: "failed",
      workspace: lane.workspace,
      worktree: lane.worktree,
      branch: lane.branch,
      targetBranch: lane.targetBranch,
      executionSessionId: liveSessionId,
      updatedAt: clock.now(),
    });

    // Late write + commit after terminal publish (post-TaskResult late-write race).
    const lateFile = path.join(lane.worktree, "late-after-terminal.txt");
    await fs.writeFile(lateFile, "late write while session still busy\n");
    await git(lane.worktree, "add", "late-after-terminal.txt");
    await git(lane.worktree, "commit", "-q", "-m", "late post-terminal commit");

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

    // Install the critical-section TOCTOU hook before the explicit reconcile.
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
      // Preserve the exact stopped binding; no inventory scan is permitted.
      await patchTaskRecord(sysFs, taskPath, {
        state: "failed",
        workspace: lane.workspace,
        worktree: lane.worktree,
        branch: lane.branch,
        targetBranch: lane.targetBranch,
        updatedAt: clock.now(),
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
