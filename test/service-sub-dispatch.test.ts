/**
 * Service-native peer vs sub dispatch (task-api §4.5 / SPEC).
 * Covers role/route Git lanes, invalid/no-Git, review authority,
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
import { createServiceClient } from "../src/service/client.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import type { AgentConnectionConfig } from "../src/runtime/agent-connection.js";
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

const FAKE_CONNECTION: AgentConnectionConfig = {
  connectionId: "fake-default",
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, sleepMs: 60_000 },
};

async function makeWorkspace(name = "sub-dispatch"): Promise<string> {
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
            id: "rl-executor",
            name: "executor",
            prompt: "do work",
          },
          {
            id: "rl-orchestrator",
            name: "orchestrator",
            prompt: "dispatch work",
          },
          {
            id: "rl-helper",
            name: "helper",
            prompt: "sub helper",
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

async function claimRoleTask(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  workspace: string,
  roleId: string,
  taskPath: string
) {
  const roleClient = await enterRoleClient(
    svc,
    workspaceId,
    workspace,
    roleId,
    `sub-dispatch:${roleId}:${taskPath}`
  );
  return roleClient.rpcRaw("task.claim", { workspaceId, taskPath });
}

async function enterRoleClient(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  workspace: string,
  roleId: string,
  externalKey: string
) {
  const setup = createServiceClient({ baseUrl: svc.url, token: svc.token });
  const entered = (await setup.sessionEnter({
    workspaceId,
    roleId,
    externalKey,
    cwd: workspace,
  })) as { session: { sessionId: string }; sessionToken: string };
  return createServiceClient({
    baseUrl: svc.url,
    token: svc.token,
    currentSessionId: entered.session.sessionId,
    currentSessionToken: entered.sessionToken,
  });
}

// ---- pure unit: review authority + envelope asSub ----

test("assertReviewAuthority: exact parentActor only; user cannot ordinary-bypass Role", () => {
  const userReviewer = { kind: "user" as const, id: "user" };
  const orchReviewer = { kind: "role" as const, id: "rl-orchestrator" };

  assert.doesNotThrow(() =>
    assertReviewAuthority({
      actor: "user",
      executorRoleId: "rl-executor",
      parentActor: userReviewer,
      action: "accept",
    })
  );
  // User-reviewed tasks: non-user roles may not impersonate the user reviewer.
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "rl-orchestrator",
        executorRoleId: "rl-executor",
        parentActor: userReviewer,
        action: "reject",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "rl-executor",
        executorRoleId: "rl-executor",
        parentActor: userReviewer,
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "SELF_ACCEPT_FORBIDDEN"
  );

  // Role-reviewed: exact parent Role only — user must not ordinary-bypass.
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "user",
        executorRoleId: "rl-helper",
        parentActor: orchReviewer,
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );
  assert.doesNotThrow(() =>
    assertReviewAuthority({
      actor: "rl-orchestrator",
      executorRoleId: "rl-helper",
      parentActor: orchReviewer,
      action: "reject",
    })
  );
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "rl-executor",
        executorRoleId: "rl-helper",
        parentActor: orchReviewer,
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "rl-helper",
        executorRoleId: "rl-helper",
        parentActor: orchReviewer,
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
    roleId: "rl-helper",
    workNodeIds: ["cx-1"],
    contextNodeIds: [],
    nodeSnapshots: [{ id: "cx-1", path: "a.md", type: "prompt", tags: [], body: "", etag: "a".repeat(24) }],
    manifestPath: "temp/helper/manifest.yml",
    userPrompt: "peer",
    parentActor: { kind: "user", id: "user" },
  });
  const peer = await loadTaskEnvelope(fsa, peerPath);
  assert.equal(peer.asSub, undefined);
  assert.equal(taskAsSub(peer), false);
  assert.equal(peer.parentActor?.kind, "user");
  assert.equal(peer.parentActor?.id, "user");
  const peerRaw = await fsa.readFile(peerPath);
  assert.doesNotMatch(peerRaw, /^asSub:/m);
  assert.doesNotMatch(peerRaw, /^dispatchedBy:/m);
  assert.match(peerRaw, /parentActor:/);

  const subPath = await writeTaskEnvelope(fsa, clock, {
    roleId: "rl-helper",
    workNodeIds: ["cx-2"],
    contextNodeIds: [],
    nodeSnapshots: [{ id: "cx-2", path: "b.md", type: "prompt", tags: [], body: "", etag: "a".repeat(24) }],
    manifestPath: "temp/helper/manifest.yml",
    userPrompt: "sub",
    parentActor: { kind: "role", id: "rl-orchestrator" },
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
  assert.equal(sub.parentActor?.id, "rl-orchestrator");
  assert.equal(sub.parentActor?.id, "rl-orchestrator");
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
      workNodeIds: [nodeId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "help orchestrator",
      asSub: true,
      parentActor: { kind: "role", id: "rl-orchestrator" },
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
    assert.equal(task.parentActor?.id, "rl-orchestrator");
    assert.equal(task.parentActor?.id, "rl-orchestrator");
    assert.equal(task.branch, undefined);
    assert.equal(task.targetBranch, undefined);
    assert.equal(task.worktree, undefined);
    assert.equal(task.baseCommit, undefined);

    // First claim binds real Role lane + parent target + capture-once tip.
    const claimed = await claimRoleTask(svc, workspaceId, ws, "rl-helper", subResult.taskPath);
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
      workNodeIds: [peerBox],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "peer work",
      parentActor: { kind: "user", id: "user" },
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

    const peerClaimed = await claimRoleTask(svc, workspaceId, ws, "rl-executor", peerResult.taskPath);
    assert.ok(!peerClaimed.error, JSON.stringify(peerClaimed.error));
    const peerLane = (peerClaimed.result as { task: {
      workspaceLane?: { branch?: string; targetBranch?: string; baseCommit?: string };
    } }).task.workspaceLane;
    assert.equal(peerLane?.branch, "tent-role/executor");
    assert.equal(peerLane?.targetBranch, "main");
    assert.ok(peerLane?.baseCommit);
  });
});

// ---- Service: Connection Tasks allocate exact tent-task lanes at dispatch ----

test("task.dispatch asSub Connection: exact Task lane at dispatch for sub and peer", async () => {
  const ws = await makeWorkspace("sub-connection-git");
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
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "connection-sub");

    const sub = await rpc(svc, "task.dispatch", {
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "Connection helper",
      asSub: true,
      parentActor: { kind: "role", id: "rl-orchestrator" },
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
    assert.equal(task.roleId, undefined);
    assert.match(task.sessionId || "", /^ss-/);
    assert.match(subResult.taskPath, /^temp\/sessions\/ss-[a-z0-9]+\/tasks\//);
    assert.equal(task.id, subResult.workspaceLane?.branch?.replace(/^tent-task\//, ""));
    assert.equal(task.branch, `tent-task/${task.id}`);
    assert.equal(task.targetBranch, "tent-role/orchestrator");
    assert.ok(task.worktree);

    const peerBox = await createNote(svc, workspaceId, "connection-peer");
    const peer = await rpc(svc, "task.dispatch", {
      workspaceId,
      workNodeIds: [peerBox],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "peer Connection",
      parentActor: { kind: "user", id: "user" },
    });
    assert.ok(!peer.error, JSON.stringify(peer.error));
    const peerResult = peer.result as {
      taskPath: string;
      asSub?: boolean;
      workspaceLane?: unknown;
    };
    assert.equal(peerResult.asSub, false);
    // Peer Connection work also receives its exact Task lane before provider launch.
    const peerLane = peerResult.workspaceLane as
      | {
          branch?: string;
          worktree?: string;
          baseCommit?: string;
          integrationAuthority?: { mutator: string; actor: { kind: string; id: string } };
        }
      | undefined;
    assert.ok(peerLane, "peer Connection projects its exact Task workspaceLane");
    assert.match(peerLane!.branch || "", /^tent-task\//);
    assert.ok(peerLane!.worktree);
    assert.match(peerLane!.baseCommit || "", /^[0-9a-f]{40}$/);
    assert.deepEqual(peerLane!.integrationAuthority, {
      actor: { kind: "user", id: "user" },
      mutator: "service",
    });
    const peerTask = await loadTaskEnvelope(envFs, peerResult.taskPath);
    assert.equal(peerTask.branch, peerLane!.branch);
    assert.equal(peerTask.worktree, peerLane!.worktree);
    assert.equal(peerTask.baseCommit, peerLane!.baseCommit);
    assert.match(peerResult.taskPath, /^temp\/sessions\/ss-[a-z0-9]+\/tasks\//);
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
      workNodeIds: [gitMount.nodeId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "nope",
      asSub: true,
      parentActor: { kind: "user", id: "user" },
    });
    assert.ok(asUser.error);
    assert.equal(asUser.error!.code, -32004);
    assert.match(String(asUser.error!.message), /parent role|parentActor|durable registry role|not user/i);

    const asSelf = await rpc(svc, "task.dispatch", {
      workspaceId: gitMount.workspaceId,
      workNodeIds: [gitMount.nodeId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "nope",
      asSub: true,
      parentActor: { kind: "role", id: "rl-helper" },
    });
    assert.ok(asSelf.error);
    assert.match(String(asSelf.error!.message), /must not equal the assignee/i);

    const unknown = await rpc(svc, "task.dispatch", {
      workspaceId: gitMount.workspaceId,
      workNodeIds: [gitMount.nodeId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "nope",
      asSub: true,
      parentActor: { kind: "role", id: "ghost-role" },
    });
    assert.ok(unknown.error);
    assert.match(String(unknown.error!.message), /not found in registry/i);

    // Failures leave no task envelope for helper.
    assert.equal(await pathExists(path.join(wsGit, ".tent", "temp", "helper", "tasks")), false);

    const noGit = await rpc(svc, "task.dispatch", {
      workspaceId: noGitMount.workspaceId,
      workNodeIds: [noGitMount.nodeId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "nope",
      asSub: true,
      parentActor: { kind: "role", id: "rl-orchestrator" },
    });
    assert.ok(noGit.error);
    assert.match(String(noGit.error!.message), /Git workspace|pure Tent/i);
    assert.equal(await pathExists(path.join(wsNoGit, ".tent", "temp", "helper", "tasks")), false);

    // Peer still works without Git.
    const peer = await rpc(svc, "task.dispatch", {
      workspaceId: noGitMount.workspaceId,
      parentActor: { kind: "user", id: "user" },
      workNodeIds: [noGitMount.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
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
          { id: "rl-helper", name: "helper", prompt: "h" },
          { id: "rl-orchestrator", name: "orchestrator", prompt: "o" },
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
      workNodeIds: [nodeId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "sub review",
      asSub: true,
      parentActor: { kind: "role", id: "rl-orchestrator" },
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;

    await taskClaim(env as any, taskPath);
    const delivered = await taskDeliver(env as any, taskPath, {
      summary: "done",
      commits: [],
    });

    await assert.rejects(
      () => taskAccept(env as any, taskPath, {
        actor: "rl-helper",
        deliveryId: delivered.delivery.id,
      }),
      (err: unknown) => err instanceof TaskLifecycleError && err.code === "SELF_ACCEPT_FORBIDDEN"
    );
    await assert.rejects(
      () => taskReject(env as any, taskPath, {
        actor: "rl-executor",
        deliveryId: delivered.delivery.id,
        note: "nope",
      }),
      (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
    );
    // User must not ordinary-bypass parent Role review.
    await assert.rejects(
      () => taskAccept(env as any, taskPath, {
        actor: "user",
        deliveryId: delivered.delivery.id,
      }),
      (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
    );

    // Parent Role may reject; re-deliver for accept path.
    const rejected = await taskReject(env as any, taskPath, {
      actor: "rl-orchestrator",
      deliveryId: delivered.delivery.id,
      note: "rework",
      resume: true,
    });
    assert.equal(rejected.task.state, "running");
    const redelivered = await taskDeliver(env as any, taskPath, { summary: "done v2", commits: [] });
    const accepted = await taskAccept(env as any, taskPath, {
      actor: "rl-orchestrator",
      deliveryId: redelivered.delivery.id,
    });
    assert.equal(accepted.task.state, "accepted");
    assert.equal(accepted.delivery.review?.by, "rl-orchestrator");
  });
});

// ---- Managed Sessions belong only to Agent Connection Tasks ----

test("managed Sessions are Connection-only; Role Tasks never start one", async () => {
  const ws = await makeWorkspace("sub-route-only");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "role-task");
    const roleTask = await rpc(svc, "task.dispatch", {
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "durable handoff only",
      asSub: true,
      parentActor: { kind: "role", id: "rl-orchestrator" },
    });
    assert.ok(!roleTask.error, JSON.stringify(roleTask.error));
    const roleTaskPath = (roleTask.result as { taskPath: string }).taskPath;
    const roleStart = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: roleTaskPath,
      callerKind: "role",
    });
    assert.ok(roleStart.error, "Role Task must reject managed session start");
    assert.match(String(roleStart.error!.message), /requires an exact bound Session/i);

    const connectionNode = await createNote(svc, workspaceId, "connection-task");
    const connectionTask = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [connectionNode],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "managed Connection task",
    });
    assert.ok(!connectionTask.error, JSON.stringify(connectionTask.error));
    const connectionTaskPath = (connectionTask.result as { taskPath: string }).taskPath;
    assert.match(connectionTaskPath, /^temp\/sessions\/ss-[a-z0-9]+\/tasks\//);
    await rpc(svc, "task.interrupt", { workspaceId, taskPath: connectionTaskPath });
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
      workNodeIds: [nodeId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "integrate to dispatcher",
      asSub: true,
      parentActor: { kind: "role", id: "rl-orchestrator" },
    });
    assert.ok(!sub.error, JSON.stringify(sub.error));
    const taskPath = (sub.result as { taskPath: string }).taskPath;
    // Role asSub defers execution lane until claim.
    await claimRoleTask(svc, workspaceId, ws, "rl-helper", taskPath);
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

    const reviewerClient = await enterRoleClient(
      svc,
      workspaceId,
      ws,
      "rl-orchestrator",
      `sub-review:${taskPath}`
    );
    const accepted = await reviewerClient.rpcRaw("task.accept", {
      workspaceId,
      taskPath,
      deliveryId: (delivered.result as { delivery: { id: string } }).delivery.id,
      actor: "rl-orchestrator",
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
      workNodeIds: [nodeId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "corrupt me",
      asSub: true,
      parentActor: { kind: "role", id: "rl-orchestrator" },
    });
    assert.ok(!sub.error, JSON.stringify(sub.error));
    const taskPath = (sub.result as { taskPath: string }).taskPath;
    // Claim captures Role base + parent target; Task commit after base so history gate is valid
    // and deliver reaches the intended targetBranch mismatch gate.
    const claimed = await claimRoleTask(svc, workspaceId, ws, "rl-helper", taskPath);
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
      workspaceId,
      workNodeIds: [parentId],
      contextNodeIds: [],
      roleId: "rl-orchestrator",
      prompt: "own the goal",
    });
    assert.ok(!parentDispatch.error, JSON.stringify(parentDispatch.error));
    const parentTaskPath = (parentDispatch.result as { taskPath: string }).taskPath;
    await claimRoleTask(svc, workspaceId, ws, "rl-orchestrator", parentTaskPath);

    // Parent and child Nodes are independently occupiable.
    const peerOk = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [subChildId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "peer concurrent under ancestor",
    });
    assert.ok(!peerOk.error, JSON.stringify(peerOk.error));
    assert.equal((peerOk.result as { asSub?: boolean }).asSub, false);

    const subOk = await rpc(svc, "task.dispatch", {
      workspaceId,
      workNodeIds: [childId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "sub under dispatcher claim",
      asSub: true,
      parentActor: { kind: "role", id: "rl-orchestrator" },
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
      workNodeIds: [(otherChild.result as { nodeId: string }).nodeId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "sub with executor parent",
      asSub: true,
      parentActor: { kind: "role", id: "rl-executor" },
    });
    assert.ok(!otherParent.error, JSON.stringify(otherParent.error));
    assert.equal((otherParent.result as { asSub?: boolean }).asSub, true);
    assert.equal(
      (otherParent.result as { workspaceLane?: { targetBranch?: string } }).workspaceLane
        ?.targetBranch,
      undefined,
      "Role asSub defers parent target bind to claim"
    );
    const otherClaimed = await claimRoleTask(
      svc,
      workspaceId,
      ws,
      "rl-helper",
      (otherParent.result as { taskPath: string }).taskPath
    );
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
      workspaceId,
      workNodeIds: [parentId],
      contextNodeIds: [],
      roleId: "rl-orchestrator",
      prompt: "own the goal; delegate child",
      acceptMode: "review-required",
    });
    assert.ok(!parentDispatch.error, JSON.stringify(parentDispatch.error));
    const parentTaskPath = (parentDispatch.result as { taskPath: string }).taskPath;
    // Role parent: dispatch omits execution lane; claim binds orchestrator lane.
    assert.equal(
      (parentDispatch.result as { workspaceLane?: { branch?: string } }).workspaceLane?.branch,
      undefined
    );
    const parentClaim = await claimRoleTask(svc, workspaceId, ws, "rl-orchestrator", parentTaskPath);
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
      workNodeIds: [childId],
      contextNodeIds: [],
      roleId: "rl-helper",
      prompt: "produce sub artifact for parent",
      asSub: true,
      parentActor: { kind: "role", id: "rl-orchestrator" },
      acceptMode: "review-required",
    });
    assert.ok(!subDispatch.error, JSON.stringify(subDispatch.error));
    const subTaskPath = (subDispatch.result as { taskPath: string }).taskPath;
    assert.equal(
      (subDispatch.result as { workspaceLane?: { branch?: string } }).workspaceLane?.branch,
      undefined,
      "Role asSub dispatch defers execution lane"
    );
    const subClaim = await claimRoleTask(svc, workspaceId, ws, "rl-helper", subTaskPath);
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

    const reviewerClient = await enterRoleClient(
      svc,
      workspaceId,
      ws,
      "rl-orchestrator",
      `sub-review:${subTaskPath}`
    );
    const subAccepted = await reviewerClient.rpcRaw("task.accept", {
      workspaceId,
      taskPath: subTaskPath,
      deliveryId: (subDelivered.result as { delivery: { id: string } }).delivery.id,
      actor: "rl-orchestrator",
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
      deliveryId: (parentDelivered.result as { delivery: { id: string } }).delivery.id,
      actor: "user",
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

// ---- Peer Connection regression: exact lane exists before provider work ----

test("peer Connection dispatch creates exact tent-task lane before provider work", async () => {
  const ws = await makeWorkspace("peer-connection-reg");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws, "peer-connection");
    const peer = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "peer Connection exact lane",
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
    assert.ok(peerLane, "peer Connection projects exact workspaceLane at dispatch");
    assert.match(peerLane!.branch || "", /^tent-task\//);
    assert.ok(peerLane!.worktree);
    assert.match(peerLane!.baseCommit || "", /^[0-9a-f]{40}$/);
    assert.deepEqual(peerLane!.integrationAuthority, {
      actor: { kind: "user", id: "user" },
      mutator: "service",
    });

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, taskPath);
    assert.match(task.branch || "", /^tent-task\//);
    assert.equal(task.targetBranch, "main");
    assert.equal(taskAsSub(task), false);
  });
});
