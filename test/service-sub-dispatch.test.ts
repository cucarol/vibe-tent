/**
 * Service-native peer vs sub dispatch (task-api §4.5 / SPEC).
 * Covers role/profile Git lanes, invalid/no-Git, review + A2A authority,
 * CLI attach, target mismatch, and peer regressions.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs, SystemClock } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { loadTaskEnvelope, taskAsSub, writeTaskEnvelope } from "../src/core/task.js";
import {
  assertReviewAuthority,
  TaskLifecycleError,
} from "../src/core/task-model.js";
import {
  ensureRoleWorkspace,
  integrateWorkspaceCommits,
  isGitWorkspace,
} from "../src/core/workspace.js";
import { taskAccept, taskClaim, taskDeliver, taskReject } from "../src/core/task-lifecycle.js";
import { configureTestGitIdentity, git } from "./helpers.js";


async function makeWorkspace(
  name = "sub-dispatch",
  rolePolicies?: Record<string, "allow" | "ask" | "deny">,
  roleProfiles?: Record<string, string[]>
): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-sub-ws-"));
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
              : { a2aPolicy: "allow" }),
            ...(rolePolicies?.orchestrator === "deny"
              ? {}
              : {
                  allowedProfiles:
                    roleProfiles?.orchestrator ?? ["fake-default"],
                }),
          },
          {
            name: "helper",
            prompt: "sub helper",
            ...(rolePolicies?.helper ? { a2aPolicy: rolePolicies.helper } : {}),
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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-sub-data-"));
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

async function createNote(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  name: string
): Promise<string> {
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name,
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return (created.result as { nodeId: string }).nodeId;
}

// ---- pure unit: review authority + envelope asSub ----

test("assertReviewAuthority: exact reviewer only; user cannot ordinary-bypass Role", () => {
  const userReviewer = { kind: "user" as const, id: "user" };
  const orchReviewer = { kind: "role" as const, id: "orchestrator" };

  assert.doesNotThrow(() =>
    assertReviewAuthority({
      actor: "user",
      submitterRole: "executor",
      reviewer: userReviewer,
      action: "accept",
    })
  );
  // User-reviewed tasks: non-user roles may not impersonate the user reviewer.
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "orchestrator",
        submitterRole: "executor",
        reviewer: userReviewer,
        action: "reject",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "executor",
        submitterRole: "executor",
        reviewer: userReviewer,
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "SELF_ACCEPT_FORBIDDEN"
  );

  // Role-reviewed: exact parent Role only — user must not ordinary-bypass.
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "user",
        submitterRole: "helper",
        reviewer: orchReviewer,
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );
  assert.doesNotThrow(() =>
    assertReviewAuthority({
      actor: "orchestrator",
      submitterRole: "helper",
      reviewer: orchReviewer,
      action: "reject",
    })
  );
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "executor",
        submitterRole: "helper",
        reviewer: orchReviewer,
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "helper",
        submitterRole: "helper",
        reviewer: orchReviewer,
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "SELF_ACCEPT_FORBIDDEN"
  );
});

test("writeTaskEnvelope: asSub true persists; missing/false omitted (reads as peer)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-asSub-env-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  const clock = new SystemClock();
  const peerPath = await writeTaskEnvelope(fsa, clock, {
    role: "helper",
    nodeRefs: [{ id: "cx-1", path: "a.md" }],
    manifestPath: "temp/helper/manifest.yml",
    userPrompt: "peer",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  const peer = await loadTaskEnvelope(fsa, peerPath);
  assert.equal(peer.asSub, undefined);
  assert.equal(taskAsSub(peer), false);
  assert.equal(peer.parentActor?.kind, "user");
  assert.equal(peer.reviewer?.id, "user");
  const peerRaw = await fsa.readFile(peerPath);
  assert.doesNotMatch(peerRaw, /^asSub:/m);
  assert.doesNotMatch(peerRaw, /^dispatchedBy:/m);
  assert.match(peerRaw, /parentActor:/);

  const subPath = await writeTaskEnvelope(fsa, clock, {
    role: "helper",
    nodeRefs: [{ id: "cx-2", path: "b.md" }],
    manifestPath: "temp/helper/manifest.yml",
    userPrompt: "sub",
    parentActor: { kind: "role", id: "orchestrator" },
    reviewer: { kind: "role", id: "orchestrator" },
    asSub: true,
    workspace: {
      workspace: dir,
      worktree: path.join(dir, "wt"),
      branch: "tent-role/helper",
      targetBranch: "tent-role/orchestrator",
    },
  });
  const sub = await loadTaskEnvelope(fsa, subPath);
  assert.equal(sub.asSub, true);
  assert.equal(taskAsSub(sub), true);
  assert.equal(sub.parentActor?.id, "orchestrator");
  assert.equal(sub.reviewer?.id, "orchestrator");
  assert.equal(sub.targetBranch, "tent-role/orchestrator");
  const subRaw = await fsa.readFile(subPath);
  assert.match(subRaw, /^asSub:\s*true$/m);
  assert.doesNotMatch(subRaw, /^dispatchedBy:/m);
});

// ---- Git integration into dispatcher worktree (not mainline switch) ----

test("integrateWorkspaceCommits: sub targetBranch uses dispatcher worktree without switching main", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-sub-int-"));
  const workspace = path.join(parent, "repo");
  await fs.mkdir(workspace);
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "-q", "-m", "init");
  const mainHead = (await git(workspace, "rev-parse", "HEAD")).trim();

  const dispatcher = await ensureRoleWorkspace(workspace, "orchestrator");
  const helper = await ensureRoleWorkspace(workspace, "helper");
  await fs.writeFile(path.join(helper.worktree, "sub-result.txt"), "from-sub\n");
  await git(helper.worktree, "add", "sub-result.txt");
  await git(helper.worktree, "commit", "-q", "-m", "sub delivery");
  const sourceRef = (await git(helper.worktree, "rev-parse", "HEAD")).trim();

  const subContract = { ...helper, targetBranch: dispatcher.branch };
  const [integrated] = await integrateWorkspaceCommits(subContract, [sourceRef]);
  assert.equal(integrated.alreadyIntegrated, false);

  // Main workspace stays on mainline and is unchanged.
  assert.equal((await git(workspace, "branch", "--show-current")).trim(), "main");
  assert.equal((await git(workspace, "rev-parse", "HEAD")).trim(), mainHead);
  assert.equal(await pathExists(path.join(workspace, "sub-result.txt")), false);

  // Commits land on dispatcher role branch via its worktree.
  assert.equal(
    (await git(dispatcher.worktree, "branch", "--show-current")).trim(),
    "tent-role/orchestrator"
  );
  assert.equal(
    (await fs.readFile(path.join(dispatcher.worktree, "sub-result.txt"), "utf8")).replace(
      /\r\n/g,
      "\n"
    ),
    "from-sub\n"
  );
  const [again] = await integrateWorkspaceCommits(subContract, [sourceRef]);
  assert.equal(again.alreadyIntegrated, true);
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---- Service: role sub Git lane ----

test("task.dispatch asSub role: tent-role assignee lane + dispatcher targetBranch; peer unchanged", async () => {
  const ws = await makeWorkspace("sub-role-git");
  await initGitOnWorkspace(ws);
  assert.equal(await isGitWorkspace(ws), true);

  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "role-sub");

    const sub = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [nodeId],
      role: "helper",
      prompt: "help orchestrator",
      asSub: true,
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    assert.ok(!sub.error, JSON.stringify(sub.error));
    const subResult = sub.result as {
      taskPath: string;
      asSub?: boolean;
      workspaceLane?: {
        branch?: string;
        targetBranch?: string;
        worktree?: string;
        baseCommit?: string;
      };
    };
    assert.equal(subResult.asSub, true);
    // Role execution lane is delayed until first claim (validation may ensure worktrees).
    assert.equal(subResult.workspaceLane?.branch, undefined);
    assert.equal(subResult.workspaceLane?.targetBranch, undefined);
    assert.equal(subResult.workspaceLane?.baseCommit, undefined);

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, subResult.taskPath);
    assert.equal(taskAsSub(task), true);
    assert.equal(task.parentActor?.id, "orchestrator");
    assert.equal(task.reviewer?.id, "orchestrator");
    assert.equal(task.branch, undefined);
    assert.equal(task.targetBranch, undefined);
    assert.equal(task.worktree, undefined);
    assert.equal(task.baseCommit, undefined);

    // First claim binds real Role lane + parent target + capture-once tip.
    const claimed = await rpc(svc, "task.claim", {
      workspaceId,
      taskPath: subResult.taskPath,
    });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));
    const claimedTask = (claimed.result as { task: {
      workspaceLane?: { branch?: string; targetBranch?: string; worktree?: string; baseCommit?: string };
      baseCommitCapture?: { source: string };
    } }).task;
    assert.equal(claimedTask.workspaceLane?.branch, "tent-role/helper");
    assert.equal(claimedTask.workspaceLane?.targetBranch, "tent-role/orchestrator");
    assert.match(claimedTask.workspaceLane?.worktree || "", /helper/);
    assert.ok(claimedTask.workspaceLane?.baseCommit);
    assert.equal(claimedTask.baseCommitCapture?.source, "first-claim");

    // Peer regression on a second box: mainline target, no asSub.
    const peerBox = await createNote(svc, workspaceId, "role-peer");
    const peer = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [peerBox],
      role: "executor",
      prompt: "peer work",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    });
    assert.ok(!peer.error, JSON.stringify(peer.error));
    const peerResult = peer.result as {
      asSub?: boolean;
      workspaceLane?: {
        branch?: string;
        targetBranch?: string;
        baseCommit?: string;
      };
      taskPath: string;
    };
    assert.equal(peerResult.asSub, false);
    assert.equal(peerResult.workspaceLane?.branch, undefined);
    assert.equal(peerResult.workspaceLane?.targetBranch, undefined);
    assert.equal(peerResult.workspaceLane?.baseCommit, undefined);
    const peerTask = await loadTaskEnvelope(envFs, peerResult.taskPath);
    assert.equal(taskAsSub(peerTask), false);
    assert.equal(peerTask.asSub, undefined);
    assert.equal(peerTask.branch, undefined);
    assert.equal(peerTask.baseCommit, undefined);

    const peerClaimed = await rpc(svc, "task.claim", {
      workspaceId,
      taskPath: peerResult.taskPath,
    });
    assert.ok(!peerClaimed.error, JSON.stringify(peerClaimed.error));
    const peerLane = (peerClaimed.result as { task: {
      workspaceLane?: { branch?: string; targetBranch?: string; baseCommit?: string };
    } }).task.workspaceLane;
    assert.equal(peerLane?.branch, "tent-role/executor");
    assert.equal(peerLane?.targetBranch, "main");
    assert.ok(peerLane?.baseCommit);
  });
});

// ---- Service: profile sub allocates tent-task lane at dispatch; peer deferred ----

test("task.dispatch asSub profile: tent-task lane at dispatch; peer profile stays deferred", async () => {
  const ws = await makeWorkspace("sub-profile-git");
  await initGitOnWorkspace(ws);

  // Make the dispatcher tip observably different from main. The task lane must
  // start from this exact commit, not merely record the branch in its envelope.
  const dispatcher = await ensureRoleWorkspace(ws, "orchestrator");
  await fs.writeFile(path.join(dispatcher.worktree, "dispatcher-base.txt"), "dispatcher\n");
  await git(dispatcher.worktree, "add", "dispatcher-base.txt");
  await git(dispatcher.worktree, "commit", "-q", "-m", "dispatcher-only base");
  const dispatcherHead = (await git(dispatcher.worktree, "rev-parse", "HEAD")).trim();
  assert.notEqual(dispatcherHead, (await git(ws, "rev-parse", "main")).trim());

  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "profile-sub");

    const sub = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "route",
      routeId: "fake-default",
      prompt: "profile helper",
      asSub: true,
      callerKind: "role",
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    assert.ok(!sub.error, JSON.stringify(sub.error));
    const subResult = sub.result as {
      taskPath: string;
      asSub?: boolean;
      workspaceLane?: { branch?: string; targetBranch?: string; worktree?: string };
    };
    assert.equal(subResult.asSub, true);
    assert.match(subResult.workspaceLane?.branch || "", /^tent-task\//);
    assert.equal(subResult.workspaceLane?.targetBranch, "tent-role/orchestrator");
    assert.ok(subResult.workspaceLane?.worktree);
    assert.equal(
      (await git(subResult.workspaceLane!.worktree!, "rev-parse", "HEAD")).trim(),
      dispatcherHead
    );
    assert.equal(
      (
        await fs.readFile(
          path.join(subResult.workspaceLane!.worktree!, "dispatcher-base.txt"),
          "utf8"
        )
      ).replace(/\r\n/g, "\n"),
      "dispatcher\n"
    );

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, subResult.taskPath);
    assert.equal(task.assigneeKind, "agentProfile");
    assert.equal(task.id, subResult.workspaceLane?.branch?.replace(/^tent-task\//, ""));
    assert.equal(task.branch, `tent-task/${task.id}`);
    assert.equal(task.targetBranch, "tent-role/orchestrator");
    assert.ok(task.worktree);

    const peerBox = await createNote(svc, workspaceId, "profile-peer");
    const peer = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [peerBox],
      assigneeKind: "route",
      routeId: "fake-default",
      prompt: "peer profile",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    });
    assert.ok(!peer.error, JSON.stringify(peer.error));
    const peerResult = peer.result as {
      taskPath: string;
      asSub?: boolean;
      workspaceLane?: unknown;
    };
    assert.equal(peerResult.asSub, false);
    // Peer profile defers Git lane; authority-only projection is mandatory without base/branch.
    const peerLane = peerResult.workspaceLane as
      | {
          branch?: string;
          worktree?: string;
          baseCommit?: string;
          integrationAuthority?: { mutator: string; actor: { kind: string; id: string } };
        }
      | undefined;
    assert.ok(peerLane, "peer profile still projects authority-only workspaceLane");
    assert.equal(peerLane!.branch, undefined);
    assert.equal(peerLane!.worktree, undefined);
    assert.equal(peerLane!.baseCommit, undefined);
    assert.deepEqual(peerLane!.integrationAuthority, {
      actor: { kind: "user", id: "user" },
      mutator: "service",
    });
    const peerTask = await loadTaskEnvelope(envFs, peerResult.taskPath);
    assert.equal(peerTask.branch, undefined);
    assert.equal(peerTask.worktree, undefined);
    assert.equal(peerTask.baseCommit, undefined);
    assert.equal(taskAsSub(peerTask), false);
  });
});

// ---- Invalid / no-Git ----

test("task.dispatch asSub: rejects user/self/unknown dispatcher and non-Git before envelope", async () => {
  const wsGit = await makeWorkspace("sub-invalid-git");
  await initGitOnWorkspace(wsGit);
  const wsNoGit = await makeWorkspace("sub-invalid-nongit");

  await withService(async (svc) => {
    const gitMount = await mountWorkItem(svc, wsGit, "inv-git");
    const noGitMount = await mountWorkItem(svc, wsNoGit, "inv-nongit");
    const envNo = new NodeFs(path.join(wsNoGit, ".tent"));

    const asUser = await rpc(svc, "task.dispatch", {
      workspaceId: gitMount.workspaceId,
      nodeIds: [gitMount.nodeId],
      role: "helper",
      prompt: "nope",
      asSub: true,
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    });
    assert.ok(asUser.error);
    assert.equal(asUser.error!.code, -32602);
    assert.match(String(asUser.error!.message), /parentActor|durable registry role|not user/i);

    const asSelf = await rpc(svc, "task.dispatch", {
      workspaceId: gitMount.workspaceId,
      nodeIds: [gitMount.nodeId],
      role: "helper",
      prompt: "nope",
      asSub: true,
      parentActor: { kind: "role", id: "helper" },
      reviewer: { kind: "role", id: "helper" },
    });
    assert.ok(asSelf.error);
    assert.match(String(asSelf.error!.message), /must not equal the assignee/i);

    const unknown = await rpc(svc, "task.dispatch", {
      workspaceId: gitMount.workspaceId,
      nodeIds: [gitMount.nodeId],
      role: "helper",
      prompt: "nope",
      asSub: true,
      parentActor: { kind: "role", id: "ghost-role" },
      reviewer: { kind: "role", id: "ghost-role" },
    });
    assert.ok(unknown.error);
    assert.match(String(unknown.error!.message), /not found in registry/i);

    // Failures leave no task envelope for helper.
    assert.equal(await pathExists(path.join(wsGit, ".tent", "temp", "helper", "tasks")), false);

    const noGit = await rpc(svc, "task.dispatch", {
      workspaceId: noGitMount.workspaceId,
      nodeIds: [noGitMount.nodeId],
      role: "helper",
      prompt: "nope",
      asSub: true,
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    assert.ok(noGit.error);
    assert.match(String(noGit.error!.message), /Git workspace|pure Tent/i);
    assert.equal(await pathExists(path.join(wsNoGit, ".tent", "temp", "helper", "tasks")), false);

    // Peer still works without Git.
    const peer = await rpc(svc, "task.dispatch", {
      workspaceId: noGitMount.workspaceId,
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      nodeIds: [noGitMount.nodeId],
      role: "executor",
      prompt: "pure tent peer",
    });
    assert.ok(!peer.error, JSON.stringify(peer.error));
    const peerTask = await loadTaskEnvelope(
      envNo,
      (peer.result as { taskPath: string }).taskPath
    );
    assert.equal(taskAsSub(peerTask), false);
    assert.equal(peerTask.workspace, undefined);
  });
});

// ---- Review authority via lifecycle on sub envelopes ----

test("sub task accept/reject: exact parent Role only; user cannot ordinary-bypass; self forbidden", async () => {
  const ws = await makeWorkspace("sub-review");
  await initGitOnWorkspace(ws);
  const fsa = new NodeFs(path.join(ws, ".tent"));
  const env = {
    fs: fsa,
    clock: new SystemClock(),
    tentName: "sub-review",
    tentRoot: path.join(ws, ".tent"),
  };
  // Free box for dispatch via core (legacy path also sets asSub).
  await fsa.writeFile(
    "roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "helper", prompt: "h" },
          { name: "orchestrator", prompt: "o" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  // Use service path for a real sub envelope, then exercise accept/reject actors.
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "review-box");
    const dispatched = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [nodeId],
      role: "helper",
      prompt: "sub review",
      asSub: true,
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;

    await taskClaim(env as any, taskPath);
    await taskDeliver(env as any, taskPath, {
      summary: "done",
      commits: [],
    });

    await assert.rejects(
      () => taskAccept(env as any, taskPath, { actor: "helper" }),
      (err: unknown) => err instanceof TaskLifecycleError && err.code === "SELF_ACCEPT_FORBIDDEN"
    );
    await assert.rejects(
      () => taskReject(env as any, taskPath, { actor: "executor", note: "nope" }),
      (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
    );
    // User must not ordinary-bypass parent Role review.
    await assert.rejects(
      () => taskAccept(env as any, taskPath, { actor: "user" }),
      (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
    );

    // Parent Role may reject; re-deliver for accept path.
    const rejected = await taskReject(env as any, taskPath, {
      actor: "orchestrator",
      note: "rework",
      resume: true,
    });
    assert.equal(rejected.task.state, "running");
    await taskDeliver(env as any, taskPath, { summary: "done v2", commits: [] });
    const accepted = await taskAccept(env as any, taskPath, { actor: "orchestrator" });
    assert.equal(accepted.task.state, "accepted");
    assert.equal(accepted.delivery.review?.by, "orchestrator");
  });
});

// ---- Sub and peer Tasks use machine Settings route availability ----

test("startSession route availability is independent of parent or assignee role policy", async () => {
  const ws = await makeWorkspace(
    "sub-a2a",
    { orchestrator: "allow", helper: "deny" },
    { orchestrator: ["fake-default"] }
  );
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "a2a-sub");
    const sub = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [nodeId],
      role: "helper",
      prompt: "spawn via dispatcher authority",
      asSub: true,
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    assert.ok(!sub.error, JSON.stringify(sub.error));
    const taskPath = (sub.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    const ok = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "role",
    });
    assert.ok(!ok.error, JSON.stringify(ok.error));
    await rpc(svc, "task.interrupt", { workspaceId, taskPath });

    // Peer role helper uses the same available machine route despite deny policy.
    const peerBox = await createNote(svc, workspaceId, "a2a-peer");
    const peer = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [peerBox],
      role: "helper",
      prompt: "peer helper",
    });
    assert.ok(!peer.error, JSON.stringify(peer.error));
    const peerPath = (peer.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: peerPath });
    const peerStarted = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: peerPath,
      profileId: "fake-default",
      callerKind: "role",
    });
    assert.ok(!peerStarted.error, JSON.stringify(peerStarted.error));
  });
});

// ---- Accept integrates into dispatcher lane (service path) ----

test("sub accept integrates commits into dispatcher worktree; main stays put", async () => {
  const ws = await makeWorkspace("sub-accept-git");
  await initGitOnWorkspace(ws);
  const mainHead = (await git(ws, "rev-parse", "HEAD")).trim();

  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "accept-sub");
    const sub = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [nodeId],
      role: "helper",
      prompt: "integrate to dispatcher",
      asSub: true,
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    assert.ok(!sub.error, JSON.stringify(sub.error));
    const taskPath = (sub.result as { taskPath: string }).taskPath;
    // Role asSub defers execution lane until claim.
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const claimed = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));
    const lane = (claimed.result as { task: { workspaceLane: { worktree: string; branch: string; baseCommit?: string } } })
      .task.workspaceLane;
    assert.ok(lane.worktree);
    assert.ok(lane.baseCommit);

    await fs.writeFile(path.join(lane.worktree, "shipped.txt"), "ok\n");
    await git(lane.worktree, "add", "shipped.txt");
    await git(lane.worktree, "commit", "-q", "-m", "helper ships");
    const commit = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "shipped",
      commits: [commit],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));

    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "orchestrator",
      commits: [commit],
    });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));

    assert.equal((await git(ws, "branch", "--show-current")).trim(), "main");
    assert.equal((await git(ws, "rev-parse", "HEAD")).trim(), mainHead);
    assert.equal(await pathExists(path.join(ws, "shipped.txt")), false);

    const dispatcher = await ensureRoleWorkspace(ws, "orchestrator");
    assert.equal(
      (await fs.readFile(path.join(dispatcher.worktree, "shipped.txt"), "utf8")).replace(
        /\r\n/g,
        "\n"
      ),
      "ok\n"
    );
  });
});

// ---- Target mismatch: corrupted envelope targetBranch fails integration ----

test("resolveIntegrationContract: sub targetBranch mismatch fails loud", async () => {
  const ws = await makeWorkspace("sub-mismatch");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "mismatch");
    const sub = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [nodeId],
      role: "helper",
      prompt: "corrupt me",
      asSub: true,
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    assert.ok(!sub.error, JSON.stringify(sub.error));
    const taskPath = (sub.result as { taskPath: string }).taskPath;
    // Claim captures Role base + parent target; Task commit after base so history gate is valid
    // and deliver reaches the intended targetBranch mismatch gate.
    const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));
    const lane = (
      claimed.result as { task: { workspaceLane: { worktree: string; baseCommit?: string; targetBranch?: string } } }
    ).task.workspaceLane;
    assert.ok(lane.baseCommit, "asSub claim must capture baseCommit");
    assert.equal(lane.targetBranch, "tent-role/orchestrator");
    const envFs = new NodeFs(path.join(ws, ".tent"));
    const envelope = await loadTaskEnvelope(envFs, taskPath);
    assert.equal(envelope.baseCommit, lane.baseCommit);

    await fs.writeFile(path.join(lane.worktree, "x.txt"), "x\n");
    await git(lane.worktree, "add", "x.txt");
    await git(lane.worktree, "commit", "-q", "-m", "x");
    const commit = (await git(lane.worktree, "rev-parse", "HEAD")).trim();
    const firstParent = (await git(lane.worktree, "rev-parse", `${commit}^`)).trim();
    assert.equal(firstParent, lane.baseCommit);

    // Corrupt targetBranch on disk to mainline (peer-like) while asSub stays true.
    const raw = await envFs.readFile(taskPath);
    const corrupted = raw.replace(
      /targetBranch:\s*tent-role\/orchestrator/,
      "targetBranch: main"
    );
    assert.notEqual(raw, corrupted);
    await envFs.writeFile(taskPath, corrupted);
    // Commit-bearing deliver re-resolves integration contract (targetHead snapshot);
    // corrupted targetBranch fails before Task reaches delivered.
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "x",
      commits: [commit],
    });
    assert.ok(delivered.error, "sub targetBranch mismatch must fail at deliver");
    assert.match(
      String(delivered.error!.message),
      /targetBranch mismatch|expected=tent-role\/orchestrator/i
    );

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "running");
  });
});

// ---- asSub under dispatcher's own active ancestor task ----

test("task.dispatch asSub: concurrent peer and sub under active ancestor are legal", async () => {
  const ws = await makeWorkspace("sub-under-claim");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const parent = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "parent-goal",
      type: "goal",
    });
    assert.ok(!parent.error, JSON.stringify(parent.error));
    const parentId = (parent.result as { nodeId: string; path: string }).nodeId;
    const parentPath = (parent.result as { path: string }).path;

    const child = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "child-prompt",
      type: "prompt",
      parentPath,
    });
    assert.ok(!child.error, JSON.stringify(child.error));
    const childId = (child.result as { nodeId: string }).nodeId;
    const subChild = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "child-sub-prompt",
      type: "prompt",
      parentPath,
    });
    assert.ok(!subChild.error, JSON.stringify(subChild.error));
    const subChildId = (subChild.result as { nodeId: string }).nodeId;

    const parentDispatch = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [parentId],
      role: "orchestrator",
      prompt: "own the goal",
    });
    assert.ok(!parentDispatch.error, JSON.stringify(parentDispatch.error));
    const parentTaskPath = (parentDispatch.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: parentTaskPath });

    // Parent and child Nodes are independently occupiable.
    const peerOk = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [subChildId],
      role: "helper",
      prompt: "peer concurrent under ancestor",
    });
    assert.ok(!peerOk.error, JSON.stringify(peerOk.error));
    assert.equal((peerOk.result as { asSub?: boolean }).asSub, false);

    const subOk = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [childId],
      role: "helper",
      prompt: "sub under dispatcher claim",
      asSub: true,
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    });
    assert.ok(!subOk.error, JSON.stringify(subOk.error));
    const subResult = subOk.result as {
      taskPath: string;
      asSub?: boolean;
      workspaceLane?: { branch?: string; targetBranch?: string; baseCommit?: string };
    };
    assert.equal(subResult.asSub, true);
    assert.equal(subResult.workspaceLane?.branch, undefined);
    assert.equal(subResult.workspaceLane?.targetBranch, undefined);
    assert.equal(subResult.workspaceLane?.baseCommit, undefined, "Role asSub defers base to claim");

    // asSub with a different durable parent Role is still a legal Git sub-lane
    // when it uses another exact Node.
    const otherChild = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "child-prompt-2",
      type: "prompt",
      parentPath,
    });
    assert.ok(!otherChild.error, JSON.stringify(otherChild.error));
    const otherParent = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [(otherChild.result as { nodeId: string }).nodeId],
      role: "helper",
      prompt: "sub with executor parent",
      asSub: true,
      parentActor: { kind: "role", id: "executor" },
      reviewer: { kind: "role", id: "executor" },
    });
    assert.ok(!otherParent.error, JSON.stringify(otherParent.error));
    assert.equal((otherParent.result as { asSub?: boolean }).asSub, true);
    assert.equal(
      (otherParent.result as { workspaceLane?: { targetBranch?: string } }).workspaceLane
        ?.targetBranch,
      undefined,
      "Role asSub defers parent target bind to claim"
    );
    const otherClaimed = await rpc(svc, "task.claim", {
      workspaceId,
      taskPath: (otherParent.result as { taskPath: string }).taskPath,
    });
    assert.ok(!otherClaimed.error, JSON.stringify(otherClaimed.error));
    assert.equal(
      (otherClaimed.result as { task: { workspaceLane?: { targetBranch?: string } } }).task
        .workspaceLane?.targetBranch,
      "tent-role/executor"
    );
  });
});

// ---- Full parent → sub → parent → main artifact inheritance ----

test("parent inherits accepted sub commits: main ends with both parent and sub artifacts", async () => {
  const ws = await makeWorkspace("parent-inherits-sub");
  await initGitOnWorkspace(ws);
  const mainHeadBefore = (await git(ws, "rev-parse", "HEAD")).trim();

  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    // 1. Git workspace: parent goal + child prompt.
    const parent = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "parent-goal",
      type: "goal",
    });
    assert.ok(!parent.error, JSON.stringify(parent.error));
    const parentId = (parent.result as { nodeId: string; path: string }).nodeId;
    const parentPath = (parent.result as { path: string }).path;

    const child = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "child-prompt",
      type: "prompt",
      parentPath,
    });
    assert.ok(!child.error, JSON.stringify(child.error));
    const childId = (child.result as { nodeId: string }).nodeId;

    // 2. Orchestrator dispatch + claim parent.
    const parentDispatch = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [parentId],
      role: "orchestrator",
      prompt: "own the goal; delegate child",
      deliveryPolicy: "review",
    });
    assert.ok(!parentDispatch.error, JSON.stringify(parentDispatch.error));
    const parentTaskPath = (parentDispatch.result as { taskPath: string }).taskPath;
    // Role parent: dispatch omits execution lane; claim binds orchestrator lane.
    assert.equal(
      (parentDispatch.result as { workspaceLane?: { branch?: string } }).workspaceLane?.branch,
      undefined
    );
    const parentClaim = await rpc(svc, "task.claim", {
      workspaceId,
      taskPath: parentTaskPath,
    });
    assert.ok(!parentClaim.error, JSON.stringify(parentClaim.error));
    const parentLane = (
      parentClaim.result as {
        task: { workspaceLane?: { worktree?: string; branch?: string; targetBranch?: string } };
      }
    ).task.workspaceLane;
    assert.ok(parentLane?.worktree, "parent claim must bind orchestrator role lane");
    assert.equal(parentLane?.branch, "tent-role/orchestrator");
    assert.equal(parentLane?.targetBranch, "main");

    // 3. Orchestrator dispatches helper asSub under the claimed parent.
    const subDispatch = await rpc(svc, "task.dispatch", {
      workspaceId,
      nodeIds: [childId],
      role: "helper",
      prompt: "produce sub artifact for parent",
      asSub: true,
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
      deliveryPolicy: "review",
    });
    assert.ok(!subDispatch.error, JSON.stringify(subDispatch.error));
    const subTaskPath = (subDispatch.result as { taskPath: string }).taskPath;
    assert.equal(
      (subDispatch.result as { workspaceLane?: { branch?: string } }).workspaceLane?.branch,
      undefined,
      "Role asSub dispatch defers execution lane"
    );
    const subClaim = await rpc(svc, "task.claim", {
      workspaceId,
      taskPath: subTaskPath,
    });
    assert.ok(!subClaim.error, JSON.stringify(subClaim.error));
    const subLane = (
      subClaim.result as {
        task: { workspaceLane?: { worktree?: string; branch?: string; targetBranch?: string } };
      }
    ).task.workspaceLane;
    assert.equal(subLane?.branch, "tent-role/helper");
    assert.equal(subLane?.targetBranch, "tent-role/orchestrator");
    assert.ok(subLane?.worktree);

    // 4. Helper ships sub artifact on its lane → deliver → orchestrator accept.
    await fs.writeFile(path.join(subLane!.worktree!, "sub-artifact.txt"), "sub-work\n");
    await git(subLane!.worktree!, "add", "sub-artifact.txt");
    await git(subLane!.worktree!, "commit", "-q", "-m", "helper sub artifact");
    const subCommit = (await git(subLane!.worktree!, "rev-parse", "HEAD")).trim();

    const subDelivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath: subTaskPath,
      summary: "sub artifact ready",
      commits: [subCommit],
    });
    assert.ok(!subDelivered.error, JSON.stringify(subDelivered.error));
    assert.equal((subDelivered.result as { state: string }).state, "delivered");

    const subAccepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath: subTaskPath,
      actor: "orchestrator",
      commits: [subCommit],
    });
    assert.ok(!subAccepted.error, JSON.stringify(subAccepted.error));
    assert.equal((subAccepted.result as { state: string }).state, "accepted");

    // Sub commit lives on orchestrator worktree; main is still unchanged.
    assert.equal(
      (await fs.readFile(path.join(parentLane!.worktree!, "sub-artifact.txt"), "utf8")).replace(
        /\r\n/g,
        "\n"
      ),
      "sub-work\n"
    );
    assert.equal((await git(ws, "branch", "--show-current")).trim(), "main");
    assert.equal((await git(ws, "rev-parse", "HEAD")).trim(), mainHeadBefore);
    assert.equal(await pathExists(path.join(ws, "sub-artifact.txt")), false);
    assert.equal(await pathExists(path.join(ws, "parent-artifact.txt")), false);

    // 5. Orchestrator adds parent artifact on the same lane (which already has sub),
    // delivers tip only (realistic manual path), user accept/integrate to main.
    await fs.writeFile(path.join(parentLane!.worktree!, "parent-artifact.txt"), "parent-work\n");
    await git(parentLane!.worktree!, "add", "parent-artifact.txt");
    await git(parentLane!.worktree!, "commit", "-q", "-m", "orchestrator parent artifact");
    const parentCommit = (await git(parentLane!.worktree!, "rev-parse", "HEAD")).trim();

    const parentDelivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath: parentTaskPath,
      summary: "parent ready with delegated sub work",
      commits: [parentCommit],
    });
    assert.ok(!parentDelivered.error, JSON.stringify(parentDelivered.error));
    assert.equal((parentDelivered.result as { state: string }).state, "delivered");

    const parentAccepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath: parentTaskPath,
      actor: "user",
      commits: [parentCommit],
    });
    assert.ok(!parentAccepted.error, JSON.stringify(parentAccepted.error));
    assert.equal((parentAccepted.result as { state: string }).state, "accepted");

    // 6. Final main must contain both real artifacts (no dropped sub product).
    assert.equal((await git(ws, "branch", "--show-current")).trim(), "main");
    assert.notEqual((await git(ws, "rev-parse", "HEAD")).trim(), mainHeadBefore);
    assert.equal(
      (await fs.readFile(path.join(ws, "parent-artifact.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "parent-work\n"
    );
    assert.equal(
      (await fs.readFile(path.join(ws, "sub-artifact.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "sub-work\n",
      "main must keep accepted sub artifact after parent integrate (no dropped product)"
    );
  });
});

// ---- Peer profile regression: deferred lane still holds after asSub feature ----

test("peer profile dispatch still defers lane; startSession creates tent-task", async () => {
  const ws = await makeWorkspace("peer-profile-reg");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "peer-prof");
    const peer = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [nodeId],
      assigneeKind: "route",
      routeId: "fake-default",
      prompt: "peer profile deferred",
    });
    assert.ok(!peer.error, JSON.stringify(peer.error));
    const taskPath = (peer.result as { taskPath: string }).taskPath;
    const peerLane = (
      peer.result as {
        workspaceLane?: {
          branch?: string;
          worktree?: string;
          baseCommit?: string;
          integrationAuthority?: { mutator: string; actor: { kind: string; id: string } };
        };
      }
    ).workspaceLane;
    assert.ok(peerLane, "peer profile still projects authority-only workspaceLane at dispatch");
    assert.equal(peerLane!.branch, undefined);
    assert.equal(peerLane!.worktree, undefined);
    assert.equal(peerLane!.baseCommit, undefined);
    assert.deepEqual(peerLane!.integrationAuthority, {
      actor: { kind: "user", id: "user" },
      mutator: "service",
    });

    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, taskPath);
    assert.match(task.branch || "", /^tent-task\//);
    assert.equal(task.targetBranch, "main");
    assert.equal(taskAsSub(task), false);
  });
});
