/**
 * P0: external Role Task workspaceLane.baseCommit lifecycle
 * - Role claim capture-once (immutable; first-claim audit)
 * - Explicit task.backfillWorkspaceLaneBase for legacy running/waiting missing base
 * - Idempotent same SHA; conflict / foreign / unauthorized / lane mismatch fail loud
 * - Persistence reload after Service restart
 *
 * Production Service path only — no pure-helper-only coverage.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import {
  loadTaskEnvelope,
  parseBaseCommitCapture,
  patchTaskEnvelope,
} from "../src/core/task.js";
import { ensureRoleWorkspace } from "../src/core/workspace.js";
import { NodeFs } from "../src/fs/node-fs.js";
import {
  setAfterTargetHeadSnapshotForTests,
  setBeforeTaskBackfillWorkspaceLaneBaseForTests,
  setBeforeTaskClaimCoreForTests,
} from "../src/service/handlers.js";
import { rpcCall } from "../src/service/http-server.js";
import { startLocalTentService } from "../src/service/service.js";
import { RPC_LIFECYCLE } from "../src/service/types.js";
import { configureTestGitIdentity, git } from "./helpers.js";

async function makeWorkspace(name = "base-life"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `tent-${name}-`));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
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
            allowedProfiles: ["fake-default"],
          },
          {
            name: "planner",
            prompt: "plan",
            allowedProfiles: ["fake-default"],
          },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function initGitOnWorkspace(workspace: string): Promise<string> {
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", ".gitignore", "README.md");
  await git(workspace, "commit", "-q", "-m", "init");
  return (await git(workspace, "rev-parse", "HEAD")).trim();
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>,
  dataDir?: string
): Promise<T> {
  const dir = dataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "tent-base-life-svc-")));
  const svc = await startLocalTentService({ dataDir: dir, writeEndpoint: true });
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
  noteName = "work-item"
) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: noteName,
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  const boxId = (created.result as { id: string }).id;
  return { workspaceId, boxId };
}

type TaskLaneProjection = {
  state: string;
  workspaceLane?: {
    baseCommit?: string;
    worktree?: string;
    branch?: string;
    targetBranch?: string;
    workspace?: string;
  };
  baseCommitCapture?: {
    source: string;
    baseCommit: string;
    actor: { kind: string; id: string };
    capturedAt: string;
  };
};

async function getTask(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  taskPath: string
): Promise<TaskLaneProjection> {
  const got = await rpc(svc, "task.get", { workspaceId, taskPath });
  assert.ok(!got.error, JSON.stringify(got.error));
  return (got.result as { task: TaskLaneProjection }).task;
}

async function taskCommitOnLane(
  worktree: string,
  filename: string,
  contents: string,
  message: string
): Promise<string> {
  await fs.writeFile(path.join(worktree, filename), contents);
  await git(worktree, "add", filename);
  await git(worktree, "commit", "-q", "-m", message);
  return (await git(worktree, "rev-parse", "HEAD")).trim();
}

/** NodeFs for Task envelopes is rooted at workspace/.tent (system root). */
function tentFs(ws: string): NodeFs {
  return new NodeFs(path.join(ws, ".tent"));
}

async function stripBaseCommitForLegacyFixture(
  ws: string,
  taskPath: string
): Promise<void> {
  // Manual envelope write allowed only to construct legacy missing-base fixture.
  const fsa = tentFs(ws);
  const task = await loadTaskEnvelope(fsa, taskPath);
  assert.ok(task.baseCommit, "fixture setup expects a base to strip");
  await patchTaskEnvelope(fsa, taskPath, {
    baseCommit: null,
    baseCommitCapture: null,
    // Keep roleBranchBase so tests prove we never substitute it for baseCommit.
  });
  const reloaded = await loadTaskEnvelope(fsa, taskPath);
  assert.equal(reloaded.baseCommit, undefined);
  assert.equal(reloaded.baseCommitCapture, undefined);
}

/**
 * Assert queued Role envelope has no execution lane / base frozen at dispatch.
 * Production path: Role dispatch ensures worktrees for validation only.
 */
async function assertQueuedRoleHasNoExecutionLane(
  ws: string,
  taskPath: string,
  projected?: TaskLaneProjection
): Promise<void> {
  const env = await loadTaskEnvelope(tentFs(ws), taskPath);
  assert.equal(env.state, "queued");
  assert.equal(env.workspace, undefined, "Role dispatch must not persist workspace");
  assert.equal(env.worktree, undefined, "Role dispatch must not persist worktree");
  assert.equal(env.branch, undefined, "Role dispatch must not persist branch");
  assert.equal(env.targetBranch, undefined, "Role dispatch must not persist targetBranch");
  assert.equal(env.baseCommit, undefined, "Role dispatch must not freeze baseCommit");
  assert.equal(env.roleBranchBase, undefined, "Role dispatch must not freeze roleBranchBase");
  assert.equal(env.baseCommitCapture, undefined);
  if (projected) {
    assert.equal(projected.state, "queued");
    // Authority-only projection may exist from parent/reviewer; never execution tip.
    assert.equal(projected.workspaceLane?.baseCommit, undefined);
    assert.equal(projected.workspaceLane?.branch, undefined);
    assert.equal(projected.workspaceLane?.worktree, undefined);
    assert.equal(projected.workspaceLane?.targetBranch, undefined);
  }
}

test("ordinary Role: dispatch omits lane/base; claim captures advanced tip; reclaim immutable", async () => {
  const ws = await makeWorkspace("fresh-claim");
  const initSha = await initGitOnWorkspace(ws);
  const roleLane = await ensureRoleWorkspace(ws, "executor");
  assert.equal(roleLane.baseCommit, initSha);

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [boxId],
      role: "executor",
      prompt: "fresh role claim base capture",
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    const dispatchLane = (d.result as { workspaceLane?: TaskLaneProjection["workspaceLane"] })
      .workspaceLane;
    assert.equal(dispatchLane?.baseCommit, undefined);
    assert.equal(dispatchLane?.branch, undefined);

    // Production path: queued envelope has no execution lane/base (no artificial strip).
    const preClaim = await getTask(svc, workspaceId, taskPath);
    await assertQueuedRoleHasNoExecutionLane(ws, taskPath, preClaim);

    // Advance Role tip after dispatch and before claim — claim must capture the new tip.
    const advancedTip = await taskCommitOnLane(
      roleLane.worktree,
      "advance-before-claim.txt",
      "advanced\n",
      "advance role tip after dispatch before claim"
    );
    assert.notEqual(advancedTip, initSha);

    const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));
    const claimedTask = (claimed.result as { task: TaskLaneProjection }).task;
    const baseAtClaim = claimedTask.workspaceLane?.baseCommit?.trim() || "";
    assert.ok(baseAtClaim, "claim must capture exact base when missing");
    assert.equal(baseAtClaim, advancedTip, "capture-once tip of Role lane at claim time");
    assert.notEqual(baseAtClaim, initSha, "must not freeze dispatch-time tip");
    assert.equal(claimedTask.workspaceLane?.branch, "tent-role/executor");
    assert.equal(claimedTask.workspaceLane?.targetBranch, "main");
    assert.ok(claimedTask.workspaceLane?.worktree, "claim binds real Role worktree");
    assert.ok(claimedTask.baseCommitCapture, "first-claim audit required");
    assert.equal(claimedTask.baseCommitCapture!.source, "first-claim");
    assert.equal(claimedTask.baseCommitCapture!.baseCommit, baseAtClaim);
    assert.equal(claimedTask.baseCommitCapture!.actor.kind, "user");
    assert.equal(claimedTask.baseCommitCapture!.actor.id, "user");
    assert.ok(claimedTask.baseCommitCapture!.capturedAt);

    // Advance role tip after capture — base must stay immutable.
    await taskCommitOnLane(
      roleLane.worktree,
      "advance-after-claim.txt",
      "advance\n",
      "advance role tip after claim"
    );
    const tipAfter = (await git(roleLane.worktree, "rev-parse", "HEAD")).trim();
    assert.notEqual(tipAfter, baseAtClaim);

    const reclaimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
    assert.ok(!reclaimed.error, JSON.stringify(reclaimed.error));
    const again = (reclaimed.result as { task: TaskLaneProjection }).task;
    assert.equal(again.workspaceLane?.baseCommit, baseAtClaim, "reclaim must not recalculate");
    assert.equal(again.baseCommitCapture?.capturedAt, claimedTask.baseCommitCapture!.capturedAt);
    assert.equal(again.baseCommitCapture?.source, "first-claim");

    // Task commit on role lane then deliver with commits[].
    const taskSha = await taskCommitOnLane(
      roleLane.worktree,
      "work.txt",
      "done\n",
      "task work commit"
    );
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "fresh claim deliver",
      commits: [taskSha],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    const del = delivered.result as {
      task: { state: string };
      delivery: { status: string; commits: string[] };
    };
    assert.equal(del.task.state, "delivered");
    assert.equal(del.delivery.status, "ready");
    assert.deepEqual(del.delivery.commits, [taskSha]);

    const final = await getTask(svc, workspaceId, taskPath);
    assert.equal(final.workspaceLane?.baseCommit, baseAtClaim);
  });
});

test("Role asSub: dispatch omits lane/base; claim captures advanced tip + parent target; reclaim immutable", async () => {
  const ws = await makeWorkspace("asub-claim");
  const initSha = await initGitOnWorkspace(ws);
  const helperLane = await ensureRoleWorkspace(ws, "executor");
  const parentLane = await ensureRoleWorkspace(ws, "planner");
  assert.equal(helperLane.baseCommit, initSha);
  assert.equal(parentLane.baseCommit, initSha);

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws, "asub-item");
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "role", id: "planner" },
      reviewer: { kind: "role", id: "planner" },
      workspaceId,
      nodeIds: [boxId],
      role: "executor",
      prompt: "role asSub claim base capture",
      asSub: true,
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    assert.equal((d.result as { asSub?: boolean }).asSub, true);
    const dispatchLane = (d.result as { workspaceLane?: TaskLaneProjection["workspaceLane"] })
      .workspaceLane;
    assert.equal(dispatchLane?.baseCommit, undefined);
    assert.equal(dispatchLane?.branch, undefined);

    const preClaim = await getTask(svc, workspaceId, taskPath);
    await assertQueuedRoleHasNoExecutionLane(ws, taskPath, preClaim);
    const envQueued = await loadTaskEnvelope(tentFs(ws), taskPath);
    assert.equal(envQueued.asSub, true);

    // Advance assignee Role tip after dispatch; claim must bind that tip + parent target.
    const advancedTip = await taskCommitOnLane(
      helperLane.worktree,
      "asub-advance.txt",
      "asub advanced\n",
      "advance helper tip after asSub dispatch"
    );
    assert.notEqual(advancedTip, initSha);

    const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));
    const claimedTask = (claimed.result as { task: TaskLaneProjection }).task;
    const baseAtClaim = claimedTask.workspaceLane?.baseCommit?.trim() || "";
    assert.equal(baseAtClaim, advancedTip, "asSub claim captures Role tip at claim time");
    assert.equal(claimedTask.workspaceLane?.branch, "tent-role/executor");
    assert.equal(
      claimedTask.workspaceLane?.targetBranch,
      "tent-role/planner",
      "asSub claim binds parent Role target"
    );
    assert.ok(claimedTask.workspaceLane?.worktree);
    assert.equal(claimedTask.baseCommitCapture?.source, "first-claim");
    assert.equal(claimedTask.baseCommitCapture?.baseCommit, baseAtClaim);
    assert.equal(claimedTask.baseCommitCapture?.actor.kind, "role");
    assert.equal(claimedTask.baseCommitCapture?.actor.id, "planner");

    // Further tip advance must not rewrite capture on reclaim.
    await taskCommitOnLane(
      helperLane.worktree,
      "asub-after-claim.txt",
      "after\n",
      "advance after asSub claim"
    );
    const reclaimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
    assert.ok(!reclaimed.error, JSON.stringify(reclaimed.error));
    const again = (reclaimed.result as { task: TaskLaneProjection }).task;
    assert.equal(again.workspaceLane?.baseCommit, baseAtClaim);
    assert.equal(again.baseCommitCapture?.capturedAt, claimedTask.baseCommitCapture!.capturedAt);
    assert.equal(again.workspaceLane?.targetBranch, "tent-role/planner");
  });
});

test("legacy running backfill then deliver; idempotent repeat; conflicts and rejects", async () => {
  const ws = await makeWorkspace("legacy-backfill");
  const initSha = await initGitOnWorkspace(ws);
  const roleLane = await ensureRoleWorkspace(ws, "executor");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws, "legacy-item");
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [boxId],
      role: "executor",
      prompt: "legacy missing base",
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    // Construct legacy: lane present, baseCommit absent (roleBranchBase may remain).
    await stripBaseCommitForLegacyFixture(ws, taskPath);
    let task = await getTask(svc, workspaceId, taskPath);
    assert.equal(task.workspaceLane?.baseCommit, undefined);
    assert.ok(task.workspaceLane?.branch);
    assert.ok(task.workspaceLane?.worktree);

    // Deliver without base must fail loud.
    const taskShaPrep = await taskCommitOnLane(
      roleLane.worktree,
      "pre.txt",
      "pre\n",
      "pre work before backfill"
    );
    const refuse = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "no base yet",
      commits: [taskShaPrep],
    });
    assert.ok(refuse.error, "deliver without base must fail");
    assert.equal(refuse.error!.code, RPC_LIFECYCLE);

    // Unauthorized actor rejected.
    const unauth = await rpc(svc, "task.backfillWorkspaceLaneBase", {
      workspaceId,
      taskPath,
      actor: { kind: "role", id: "planner" },
      baseCommit: initSha,
    });
    assert.ok(unauth.error, "unauthorized actor must fail");
    assert.equal(unauth.error!.code, RPC_LIFECYCLE);
    assert.equal(
      (unauth.error!.data as { code?: string } | undefined)?.code,
      "BASE_BACKFILL_UNAUTHORIZED"
    );

    // Foreign / unreachable SHA rejected.
    const foreign = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const foreignRpc = await rpc(svc, "task.backfillWorkspaceLaneBase", {
      workspaceId,
      taskPath,
      actor: { kind: "user", id: "user" },
      baseCommit: foreign,
    });
    assert.ok(foreignRpc.error, "foreign SHA must fail");
    assert.equal(
      (foreignRpc.error!.data as { code?: string } | undefined)?.code,
      "BASE_BACKFILL_FOREIGN"
    );

    // Explicit backfill with real init SHA (ancestor of role branch tip).
    const backfilled = await rpc(svc, "task.backfillWorkspaceLaneBase", {
      workspaceId,
      taskPath,
      actor: { kind: "user", id: "user" },
      baseCommit: initSha,
    });
    assert.ok(!backfilled.error, JSON.stringify(backfilled.error));
    const bf = backfilled.result as {
      baseCommit: string;
      idempotent: boolean;
      task: TaskLaneProjection;
    };
    assert.equal(bf.idempotent, false);
    assert.equal(bf.baseCommit, initSha);
    assert.equal(bf.task.workspaceLane?.baseCommit, initSha);
    assert.equal(bf.task.baseCommitCapture?.source, "explicit-backfill");
    assert.equal(bf.task.baseCommitCapture?.baseCommit, initSha);
    assert.equal(bf.task.baseCommitCapture?.actor.id, "user");
    const originalCapturedAt = bf.task.baseCommitCapture!.capturedAt;

    // Idempotent same SHA: original audit unchanged.
    const again = await rpc(svc, "task.backfillWorkspaceLaneBase", {
      workspaceId,
      taskPath,
      actor: { kind: "user", id: "user" },
      baseCommit: initSha,
    });
    assert.ok(!again.error, JSON.stringify(again.error));
    const ag = again.result as {
      idempotent: boolean;
      task: TaskLaneProjection;
    };
    assert.equal(ag.idempotent, true);
    assert.equal(ag.task.baseCommitCapture?.capturedAt, originalCapturedAt);
    assert.equal(ag.task.baseCommitCapture?.source, "explicit-backfill");
    assert.equal(ag.task.workspaceLane?.baseCommit, initSha);

    // Conflicting different SHA rejected (use tip after extra commit as different ancestor-legal tip?
    // tip is descendant of init — still a valid ancestor of branch tip, but conflicts with recorded).
    const advanced = (await git(roleLane.worktree, "rev-parse", "HEAD")).trim();
    assert.notEqual(advanced, initSha);
    const conflict = await rpc(svc, "task.backfillWorkspaceLaneBase", {
      workspaceId,
      taskPath,
      actor: { kind: "user", id: "user" },
      baseCommit: advanced,
    });
    assert.ok(conflict.error, "conflicting SHA must fail");
    assert.equal(
      (conflict.error!.data as { code?: string } | undefined)?.code,
      "BASE_BACKFILL_CONFLICT"
    );
    task = await getTask(svc, workspaceId, taskPath);
    assert.equal(task.workspaceLane?.baseCommit, initSha);
    assert.equal(task.baseCommitCapture?.capturedAt, originalCapturedAt);

    // Deliver succeeds after backfill.
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "legacy backfill deliver",
      commits: [taskShaPrep],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    assert.equal(
      (delivered.result as { delivery: { status: string } }).delivery.status,
      "ready"
    );
  });
});

test("backfill rejects workspace/target mismatch and non-ancestor base", async () => {
  const ws = await makeWorkspace("mismatch");
  await initGitOnWorkspace(ws);
  const roleLane = await ensureRoleWorkspace(ws, "executor");

  // Side commit not on role branch ancestry from a detached lineage.
  const side = "tent-test/side-base";
  await git(ws, "checkout", "-q", "-b", side);
  await fs.writeFile(path.join(ws, "side.txt"), "side\n");
  await git(ws, "add", "side.txt");
  await git(ws, "commit", "-q", "-m", "side only");
  const sideSha = (await git(ws, "rev-parse", "HEAD")).trim();
  await git(ws, "checkout", "-q", "main");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws, "mm-item");
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [boxId],
      role: "executor",
      prompt: "mismatch fixture",
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    await stripBaseCommitForLegacyFixture(ws, taskPath);

    // Corrupt recorded targetBranch → lane mismatch.
    const fsa = tentFs(ws);
    await patchTaskEnvelope(fsa, taskPath, {
      targetBranch: "tent-role/does-not-exist-for-mismatch",
    });
    const mismatch = await rpc(svc, "task.backfillWorkspaceLaneBase", {
      workspaceId,
      taskPath,
      actor: { kind: "user", id: "user" },
      baseCommit: roleLane.baseCommit!,
    });
    assert.ok(mismatch.error, "target mismatch must fail");
    assert.equal(mismatch.error!.code, RPC_LIFECYCLE);
    assert.match(
      String((mismatch.error!.data as { code?: string } | undefined)?.code || mismatch.error!.message),
      /BASE_BACKFILL_LANE_MISMATCH|mismatch|targetBranch/i
    );

    // Restore targetBranch; side SHA is not ancestor of role branch tip.
    await patchTaskEnvelope(fsa, taskPath, {
      targetBranch: roleLane.targetBranch,
      baseCommit: null,
      baseCommitCapture: null,
    });
    const notAnc = await rpc(svc, "task.backfillWorkspaceLaneBase", {
      workspaceId,
      taskPath,
      actor: { kind: "user", id: "user" },
      baseCommit: sideSha,
    });
    assert.ok(notAnc.error, "non-ancestor base must fail");
    assert.equal(
      (notAnc.error!.data as { code?: string } | undefined)?.code,
      "BASE_BACKFILL_NOT_ANCESTOR"
    );
  });
});

test("baseCommitCapture persists across Service restart reload", async () => {
  const ws = await makeWorkspace("persist-reload");
  await initGitOnWorkspace(ws);
  await ensureRoleWorkspace(ws, "executor");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-base-life-persist-"));

  let workspaceId = "";
  let taskPath = "";
  let captureSnapshot: TaskLaneProjection["baseCommitCapture"];
  let baseCommit = "";

  await withService(async (svc) => {
    const mounted = await mountWorkItem(svc, ws, "persist-item");
    workspaceId = mounted.workspaceId;
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [mounted.boxId],
      role: "executor",
      prompt: "persist audit",
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    taskPath = (d.result as { taskPath: string }).taskPath;
    const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));
    const task = (claimed.result as { task: TaskLaneProjection }).task;
    baseCommit = task.workspaceLane?.baseCommit || "";
    captureSnapshot = task.baseCommitCapture;
    assert.ok(baseCommit);
    assert.ok(captureSnapshot);
    assert.equal(captureSnapshot!.source, "first-claim");
  }, dataDir);

  // Restart Service with same dataDir; re-mount workspace and reload task.
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const wid = (mounted.result as { workspaceId: string }).workspaceId;
    const task = await getTask(svc, wid, taskPath);
    assert.equal(task.workspaceLane?.baseCommit, baseCommit);
    assert.deepEqual(task.baseCommitCapture, captureSnapshot);
  }, dataDir);
});

test("non-Git Role claim invents no baseCommit", async () => {
  const ws = await makeWorkspace("nongit-claim");
  // intentionally no git init
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws, "docs-item");
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [boxId],
      role: "executor",
      prompt: "docs only",
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));
    const task = (claimed.result as { task: TaskLaneProjection }).task;
    assert.equal(task.workspaceLane?.baseCommit, undefined);
    assert.equal(task.baseCommitCapture, undefined);
    assert.equal(task.workspaceLane?.branch, undefined);
  });
});

test("claim fails loud when recorded baseCommit is unresolvable (stays queued)", async () => {
  const ws = await makeWorkspace("unresolved-base");
  await initGitOnWorkspace(ws);
  await ensureRoleWorkspace(ws, "executor");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws, "unresolved-item");
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [boxId],
      role: "executor",
      prompt: "unresolvable base",
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;

    const fsa = tentFs(ws);
    await patchTaskEnvelope(fsa, taskPath, {
      baseCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      baseCommitCapture: null,
    });
    const pre = await loadTaskEnvelope(fsa, taskPath);
    assert.equal(pre.state, "queued");
    assert.equal(pre.baseCommit, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

    const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
    assert.ok(claimed.error, "unresolvable base must fail claim");
    assert.equal(claimed.error!.code, RPC_LIFECYCLE);
    assert.equal(
      (claimed.error!.data as { code?: string } | undefined)?.code,
      "BASE_CAPTURE_UNRESOLVED"
    );

    const task = await getTask(svc, workspaceId, taskPath);
    assert.equal(task.state, "queued");
    const env = await loadTaskEnvelope(fsa, taskPath);
    assert.equal(env.state, "queued");
    assert.equal(env.status, "pending");
    // Must not write first-claim audit over an unverified raw SHA.
    assert.equal(env.baseCommitCapture, undefined);
  });
});

test("backfill rejects Task-lane tip that is foreign to target ancestry", async () => {
  const ws = await makeWorkspace("target-ancestor");
  const initSha = await initGitOnWorkspace(ws);
  const roleLane = await ensureRoleWorkspace(ws, "executor");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws, "tgt-anc-item");
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [boxId],
      role: "executor",
      prompt: "target ancestry backfill",
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    await stripBaseCommitForLegacyFixture(ws, taskPath);

    // Commit only on Role/Task branch — tip is ancestor of Task branch but not of main.
    const laneOnly = await taskCommitOnLane(
      roleLane.worktree,
      "lane-only.txt",
      "lane only\n",
      "role-lane only commit"
    );
    const mainTip = (await git(ws, "rev-parse", "main")).trim();
    assert.equal(mainTip, initSha);
    assert.notEqual(laneOnly, mainTip);

    // Sanity: laneOnly is ancestor of role tip (itself) but not of main.
    const roleTip = (await git(roleLane.worktree, "rev-parse", "HEAD")).trim();
    assert.equal(roleTip, laneOnly);

    const rejected = await rpc(svc, "task.backfillWorkspaceLaneBase", {
      workspaceId,
      taskPath,
      actor: { kind: "user", id: "user" },
      baseCommit: laneOnly,
    });
    assert.ok(rejected.error, "Task-lane-only tip must fail target ancestry");
    assert.equal(rejected.error!.code, RPC_LIFECYCLE);
    assert.equal(
      (rejected.error!.data as { code?: string } | undefined)?.code,
      "BASE_BACKFILL_NOT_TARGET_ANCESTOR"
    );
    const task = await getTask(svc, workspaceId, taskPath);
    assert.equal(task.workspaceLane?.baseCommit, undefined);

    // Legal base (init on both lanes) still succeeds.
    const ok = await rpc(svc, "task.backfillWorkspaceLaneBase", {
      workspaceId,
      taskPath,
      actor: { kind: "user", id: "user" },
      baseCommit: initSha,
    });
    assert.ok(!ok.error, JSON.stringify(ok.error));
    assert.equal((ok.result as { baseCommit: string }).baseCommit, initSha);
  });
});

test("backfill rejects bare string actor (no kind inference)", async () => {
  const ws = await makeWorkspace("bare-actor");
  const initSha = await initGitOnWorkspace(ws);
  await ensureRoleWorkspace(ws, "executor");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws, "bare-item");
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [boxId],
      role: "executor",
      prompt: "bare actor",
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    await stripBaseCommitForLegacyFixture(ws, taskPath);

    const bare = await rpc(svc, "task.backfillWorkspaceLaneBase", {
      workspaceId,
      taskPath,
      actor: "user",
      baseCommit: initSha,
    });
    assert.ok(bare.error, "bare string actor must fail");
    assert.equal(bare.error!.code, -32602);
    assert.match(String(bare.error!.message), /kind.*id|bare string/i);
    const task = await getTask(svc, workspaceId, taskPath);
    assert.equal(task.workspaceLane?.baseCommit, undefined);
  });
});

test("failed claim preparation leaves Task queued (no intermediate running)", async () => {
  const ws = await makeWorkspace("claim-fail-queued");
  await initGitOnWorkspace(ws);
  await ensureRoleWorkspace(ws, "executor");

  setBeforeTaskClaimCoreForTests(async () => {
    throw new Error("injected claim prepare-after failure");
  });
  try {
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws, "fail-claim-item");
      const d = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        nodeIds: [boxId],
        role: "executor",
        prompt: "must stay queued on claim fail",
        deliveryPolicy: "review",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const taskPath = (d.result as { taskPath: string }).taskPath;

      const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
      assert.ok(claimed.error, "claim must fail from injected hook");

      const task = await getTask(svc, workspaceId, taskPath);
      assert.equal(task.state, "queued", "failed claim must leave Task queued");

      // Envelope must not have been partially written to running.
      const fsa = tentFs(ws);
      const env = await loadTaskEnvelope(fsa, taskPath);
      assert.equal(env.state, "queued");
      assert.equal(env.status, "pending");
    });
  } finally {
    setBeforeTaskClaimCoreForTests(null);
  }
});

test("backfill cannot interleave with deliver (per-Task lifecycle flight)", async () => {
  const ws = await makeWorkspace("backfill-vs-deliver");
  const initSha = await initGitOnWorkspace(ws);
  const roleLane = await ensureRoleWorkspace(ws, "executor");

  // Deliver holds the per-Task flight after targetHead snapshot. Idempotent release
  // always runs in finally — assertion failures must not leave deliverHold forever.
  let resolveDeliverHold: (() => void) | null = null;
  let deliverHoldReleased = false;
  const releaseDeliverHold = (): void => {
    if (deliverHoldReleased) return;
    deliverHoldReleased = true;
    resolveDeliverHold?.();
    resolveDeliverHold = null;
  };
  const deliverHold = new Promise<void>((r) => {
    resolveDeliverHold = r;
  });
  // Safety: never leave the Service stuck if the test aborts mid-hold.
  const holdSafety = setTimeout(() => releaseDeliverHold(), 45_000);
  let deliverEntered = false;
  let backfillBodyEntered = false;

  setAfterTargetHeadSnapshotForTests(async () => {
    deliverEntered = true;
    await deliverHold;
  });
  setBeforeTaskBackfillWorkspaceLaneBaseForTests(async () => {
    backfillBodyEntered = true;
  });

  try {
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws, "race-item");
      const d = await rpc(svc, "task.dispatch", {
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        workspaceId,
        nodeIds: [boxId],
        role: "executor",
        prompt: "race backfill vs deliver",
        deliveryPolicy: "review",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      await stripBaseCommitForLegacyFixture(ws, taskPath);

      // Base must exist for commits[] deliver; race a *later* backfill against deliver.
      const bf0 = await rpc(svc, "task.backfillWorkspaceLaneBase", {
        workspaceId,
        taskPath,
        actor: { kind: "user", id: "user" },
        baseCommit: initSha,
      });
      assert.ok(!bf0.error, JSON.stringify(bf0.error));
      // Reset entry flag after the priming backfill so the race counter is clean.
      backfillBodyEntered = false;

      const taskSha = await taskCommitOnLane(
        roleLane.worktree,
        "race-work.txt",
        "race\n",
        "race work"
      );

      // Deliver first — holds per-Task lifecycle flight at targetHead snapshot.
      // Windows CI can take several seconds to reach the snapshot hook.
      const deliverP = rpc(svc, "task.deliver", {
        workspaceId,
        taskPath,
        summary: "race deliver",
        commits: [taskSha],
      });
      const enterDeadline = Date.now() + 30_000;
      while (!deliverEntered && Date.now() < enterDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!deliverEntered) {
        // Unblock any stuck deliver before failing so teardown cannot hang.
        releaseDeliverHold();
        const early = await Promise.race([
          deliverP,
          new Promise<{ error?: unknown }>((resolve) =>
            setTimeout(() => resolve({ error: { message: "deliver settle timeout" } }), 5_000)
          ),
        ]);
        assert.fail(
          `deliver must enter targetHead snapshot hold within 30s; early=${JSON.stringify(early)}`
        );
      }

      // Concurrent backfill must not enter flight body while deliver holds.
      const backfillP = rpc(svc, "task.backfillWorkspaceLaneBase", {
        workspaceId,
        taskPath,
        actor: { kind: "user", id: "user" },
        baseCommit: initSha,
      });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(
        backfillBodyEntered,
        false,
        "backfill body must not enter while deliver holds per-Task lifecycle flight"
      );

      releaseDeliverHold();
      const delivered = await deliverP;
      assert.ok(!delivered.error, JSON.stringify(delivered.error));
      assert.equal(
        (delivered.result as { delivery: { status: string } }).delivery.status,
        "ready"
      );
      assert.equal(
        (delivered.result as { task: { state: string } }).task.state,
        "delivered"
      );

      // After deliver wins, Task is delivered — backfill must fail state eligibility
      // (not return idempotent success). Judge did not request delivered no-op.
      const backfilled = await backfillP;
      assert.ok(backfilled.error, "backfill after delivered must fail state eligibility");
      assert.equal(backfilled.error!.code, RPC_LIFECYCLE);
      assert.equal(
        (backfilled.error!.data as { code?: string } | undefined)?.code,
        "BASE_BACKFILL_STATE"
      );
      assert.equal(
        backfillBodyEntered,
        true,
        "backfill body runs only after deliver releases the flight"
      );
    });
  } finally {
    // Always release hold before clearing hooks so Service/test teardown cannot hang.
    releaseDeliverHold();
    clearTimeout(holdSafety);
    setAfterTargetHeadSnapshotForTests(null);
    setBeforeTaskBackfillWorkspaceLaneBaseForTests(null);
  }
});

test("load fails loud on corrupt baseCommitCapture", async () => {
  const ws = await makeWorkspace("capture-corrupt");
  await initGitOnWorkspace(ws);
  await ensureRoleWorkspace(ws, "executor");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws, "corrupt-item");
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [boxId],
      role: "executor",
      prompt: "corrupt capture load",
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    const fsa = tentFs(ws);
    const env = await loadTaskEnvelope(fsa, taskPath);
    assert.ok(env.baseCommit);
    assert.ok(env.baseCommitCapture);
    const goodBase = env.baseCommit!;
    const goodCapture = env.baseCommitCapture!;

    // Capture without baseCommit (raw write only — patch/load would fail loud).
    {
      const raw = await fsa.readFile(taskPath);
      const { data, body, keyOrder } = parseFrontmatter(raw);
      data.baseCommitCapture = {
        source: "first-claim",
        baseCommit: goodBase,
        actor: { kind: "user", id: "user" },
        capturedAt: goodCapture.capturedAt,
      };
      delete data.baseCommit;
      await fsa.writeFile(taskPath, serializeFrontmatter(data, body, keyOrder));
    }
    await assert.rejects(
      () => loadTaskEnvelope(fsa, taskPath),
      /baseCommitCapture present but baseCommit missing/
    );

    // Mismatch base vs capture (raw write — load/patch would fail on prior corruption).
    {
      const raw = await fsa.readFile(taskPath);
      const { data, body, keyOrder } = parseFrontmatter(raw);
      data.baseCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      data.baseCommitCapture = {
        source: "first-claim",
        baseCommit: goodBase,
        actor: { kind: "user", id: "user" },
        capturedAt: goodCapture.capturedAt,
      };
      await fsa.writeFile(taskPath, serializeFrontmatter(data, body, keyOrder));
    }
    await assert.rejects(
      () => loadTaskEnvelope(fsa, taskPath),
      /baseCommit .* !== baseCommitCapture\.baseCommit/
    );

    // Invalid capturedAt.
    assert.throws(
      () =>
        parseBaseCommitCapture({
          source: "first-claim",
          baseCommit: goodBase,
          actor: { kind: "user", id: "user" },
          capturedAt: "not-a-timestamp",
        }),
      /ISO-8601/
    );
    assert.throws(
      () =>
        parseBaseCommitCapture({
          source: "first-claim",
          baseCommit: goodBase,
          actor: { kind: "user", id: "user" },
          capturedAt: "2026-07-29T10:00:00", // missing timezone
        }),
      /ISO-8601/
    );
  });
});
