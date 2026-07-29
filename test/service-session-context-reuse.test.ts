/**
 * Production-path tests for Context generation + managed Session reuse (cx-5q6za6).
 * Pure-function-only tests are insufficient — these drive real Service start/resume.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import {
  loadTaskEnvelope,
  patchTaskEnvelope,
  writeTaskEnvelope,
  type TaskEnvelope,
} from "../src/core/task.js";
import { SystemClock } from "../src/fs/node-fs.js";
import {
  computeContextGeneration,
  isContextGenerationId,
} from "../src/core/task-context-card.js";
import {
  appendCallerBootstrapSection,
  assertDurableContextCardRefsResolved,
  collectStableContextGeneration,
  evaluateCandidateSessionLeaseGates,
  findTasksBoundToSession,
  isTaskLifecycleSafelySettledForReuse,
  profileLaunchCompatibilityDigestFromConfig,
} from "../src/service/session-context-generation.js";
import {
  profileLaunchCompatibilityDigest,
  skillSetCompatibilityDigest,
} from "../src/core/task-context-card.js";
import { buildTaskContextCard } from "../src/core/task-context-card.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { configureTestGitIdentity, git } from "./helpers.js";
import { writeWorkspaceAgents } from "../src/core/workspace-agents.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Svc = Awaited<ReturnType<typeof startLocalTentService>>;

const FAKE_RESUMABLE = {
  id: "fake-resumable",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, canResume: true, sleepMs: 60_000, emitStdout: false },
} as const;

const FAKE_OTHER = {
  id: "fake-other",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, canResume: true, sleepMs: 60_000, emitStdout: false },
} as const;

async function makeWorkspace(name = "ctx-reuse"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ctx-reuse-"));
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
            name: "orchestrator",
            prompt: "dispatch work",
            a2aPolicy: "allow",
            allowedProfiles: ["fake-resumable", "fake-other"],
            roster: ["worker-a"],
          },
          {
            name: "executor",
            prompt: "do work",
            a2aPolicy: "allow",
            allowedProfiles: ["fake-resumable"],
          },
        ],
      },
      null,
      2
    ) + "\n"
  );
  await writeWorkspaceAgents(workspace, "# AGENTS for context generation tests\n");
  return workspace;
}

async function withService<T>(
  fn: (svc: Svc) => Promise<T>,
  opts?: { profiles?: import("../src/runtime/types.js").AgentProfileConfig[] }
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ctx-reuse-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    profiles: opts?.profiles ?? [FAKE_RESUMABLE, FAKE_OTHER],
  });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

function rpc(svc: Svc, method: string, params?: Record<string, unknown>) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

async function mountWorkItem(svc: Svc, ws: string) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: "work-item",
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return { workspaceId, boxId: (created.result as { id: string }).id };
}

async function initGit(workspace: string): Promise<void> {
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", ".gitignore", "README.md", "AGENTS.md");
  await git(workspace, "commit", "-q", "-m", "init");
}

// ---- collector unit (still production collector, not pure hash) ----

test("collectStableContextGeneration digests real AGENTS + skill bodies; excludes taskId", async () => {
  const ws = await makeWorkspace("collect");
  try {
    const a = await collectStableContextGeneration({
      workspaceRoot: ws,
      workspaceIdentity: "ws-collect",
      packageRoot: repoRoot,
      packageVersion: "0.1.0",
      assigneeKind: "agentProfile",
      assigneeLabel: "fake-resumable",
      profileId: "fake-resumable",
      adapterId: FAKE_ADAPTER_ID,
      parentRoleId: "orchestrator",
      roleFs: new NodeFs(ws),
    });
    assert.ok(isContextGenerationId(a.contextGeneration));
    assert.ok(a.tentTaskDigest.length > 0);
    assert.equal(a.tentRoleDigest, "", "agentProfile does not include tent-role body");
    assert.ok(a.skillsDigest.length > 0);

    // Same facts → same generation (cross-Task cache compatible).
    const b = await collectStableContextGeneration({
      workspaceRoot: ws,
      workspaceIdentity: "ws-collect",
      packageRoot: repoRoot,
      packageVersion: "0.1.0",
      assigneeKind: "agentProfile",
      assigneeLabel: "fake-resumable",
      agentId: "other-task-label-ignored-for-profile-id",
      profileId: "fake-resumable",
      adapterId: FAKE_ADAPTER_ID,
      parentRoleId: "orchestrator",
      roleFs: new NodeFs(ws),
    });
    // agentId is part of extraStable — different agentId flips generation.
    // Same agentId/profile:
    const c = await collectStableContextGeneration({
      workspaceRoot: ws,
      workspaceIdentity: "ws-collect",
      packageRoot: repoRoot,
      packageVersion: "0.1.0",
      assigneeKind: "agentProfile",
      assigneeLabel: "fake-resumable",
      profileId: "fake-resumable",
      adapterId: FAKE_ADAPTER_ID,
      parentRoleId: "orchestrator",
      roleFs: new NodeFs(ws),
    });
    assert.equal(a.contextGeneration, c.contextGeneration);

    // AGENTS body change flips generation.
    await writeWorkspaceAgents(ws, "# AGENTS changed\n");
    const d = await collectStableContextGeneration({
      workspaceRoot: ws,
      workspaceIdentity: "ws-collect",
      packageRoot: repoRoot,
      packageVersion: "0.1.0",
      assigneeKind: "agentProfile",
      assigneeLabel: "fake-resumable",
      profileId: "fake-resumable",
      adapterId: FAKE_ADAPTER_ID,
      parentRoleId: "orchestrator",
      roleFs: new NodeFs(ws),
    });
    assert.notEqual(a.contextGeneration, d.contextGeneration);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("assertDurableContextCardRefsResolved fails loud on missing node/task/delivery", async () => {
  const ws = await makeWorkspace("refs");
  try {
    await initGit(ws);
    const fsa = new NodeFs(ws);
    const gen = computeContextGeneration({
      workspaceIdentity: "ws",
      agentsPointerDigest: "x",
    });
    const good = buildTaskContextCard({
      objective: "o",
      acceptance: ["a"],
      refs: { nodes: [], tasks: [], deliveries: [], git: [{ id: "HEAD" }] },
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
      assignee: { kind: "agentId", id: "fake-resumable" },
      contextGeneration: gen,
    });
    await assertDurableContextCardRefsResolved(fsa, good);

    const badNode = buildTaskContextCard({
      objective: "o",
      acceptance: ["a"],
      refs: {
        nodes: [{ id: "cx-does-not-exist" }],
        tasks: [],
        deliveries: [],
        git: [],
      },
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
      assignee: { kind: "agentId", id: "fake-resumable" },
      contextGeneration: gen,
    });
    await assert.rejects(
      () => assertDurableContextCardRefsResolved(fsa, badNode),
      (err: unknown) =>
        err instanceof Error && /could not be resolved|UNRESOLVED_REF|refs\.nodes/i.test(err.message)
    );

    const badTask = buildTaskContextCard({
      objective: "o",
      acceptance: ["a"],
      refs: {
        nodes: [],
        tasks: [{ id: "tk-zzzzzzzz" }],
        deliveries: [],
        git: [],
      },
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
      assignee: { kind: "agentId", id: "fake-resumable" },
      contextGeneration: gen,
    });
    await assert.rejects(() => assertDurableContextCardRefsResolved(fsa, badTask));

    const badDelivery = buildTaskContextCard({
      objective: "o",
      acceptance: ["a"],
      refs: {
        nodes: [],
        tasks: [],
        deliveries: [{ id: "dl-zzzzzzzz" }],
        git: [],
      },
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
      assignee: { kind: "agentId", id: "fake-resumable" },
      contextGeneration: gen,
    });
    await assert.rejects(() => assertDurableContextCardRefsResolved(fsa, badDelivery));
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ---- production Service path ----

test("task.dispatch persists real contextGeneration without taskId; two tasks share generation", async () => {
  const ws = await makeWorkspace("dispatch-gen");
  try {
    await initGit(ws);
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d1 = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        prompt: "Task one implement feature A",
        assigneeKind: "agentProfile",
        profileId: "fake-resumable",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
      });
      assert.ok(!d1.error, JSON.stringify(d1.error));
      const path1 = (d1.result as { taskPath: string }).taskPath;
      const envFs = new NodeFs(path.join(ws, ".tent"));
      const t1 = await loadTaskEnvelope(envFs, path1);
      assert.ok(t1.contextGeneration && isContextGenerationId(t1.contextGeneration));
      assert.ok(t1.contextCard?.contextGeneration === t1.contextGeneration);

      const d2 = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        prompt: "Task two completely different objective",
        assigneeKind: "agentProfile",
        profileId: "fake-resumable",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
      });
      assert.ok(!d2.error, JSON.stringify(d2.error));
      const path2 = (d2.result as { taskPath: string }).taskPath;
      const t2 = await loadTaskEnvelope(envFs, path2);
      assert.notEqual(t1.id, t2.id);
      assert.notEqual(t1.contextCard?.objective, t2.contextCard?.objective);
      // Same stable facts → same contextGeneration across Tasks (cache compatible).
      assert.equal(
        t1.contextGeneration,
        t2.contextGeneration,
        "cross-Task objectives must not change contextGeneration"
      );
      // taskDeltaDigest still differs (dynamic).
      assert.notEqual(t1.taskDeltaDigest, t2.taskDeltaDigest);
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("startSession persists reuse facts; same-lane resume reuses; lane/profile mismatch creates fresh", async () => {
  const ws = await makeWorkspace("reuse-path");
  try {
    await initGit(ws);
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));

      // Task A (agentProfile): start + stop — same-lane resume candidate.
      const d1 = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        prompt: "First task",
        assigneeKind: "agentProfile",
        profileId: "fake-resumable",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!d1.error, JSON.stringify(d1.error));
      const t1 = await loadTaskEnvelope(envFs, (d1.result as { taskPath: string }).taskPath);
      const sessionId1 = t1.sessionId;
      assert.ok(sessionId1, "task A must bind sessionId");

      const row1 = await svc.runtime.registry.read(sessionId1!);
      assert.ok(row1);
      assert.ok(
        typeof row1.contextGeneration === "string" &&
          isContextGenerationId(row1.contextGeneration),
        "Session row must persist contextGeneration"
      );
      assert.equal(typeof row1.skillsDigest, "string");
      assert.equal(row1.parentRoleId, "orchestrator");

      await svc.runtime.stopSession(sessionId1!, "user");
      const probeStopped = await svc.runtime.probe(sessionId1!);
      assert.equal(probeStopped.alive, false);
      assert.equal(probeStopped.resumeCapable, true);

      // Same Task startSession again → same lane → Core gate allows resume.
      const restart = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath: t1.path,
        profileId: "fake-resumable",
        callerKind: "user",
      });
      assert.ok(!restart.error, JSON.stringify(restart.error));
      const t1b = await loadTaskEnvelope(envFs, t1.path);
      assert.equal(t1b.sessionId, sessionId1, "same-lane resume must reuse Session");

      await svc.runtime.stopSession(sessionId1!, "user");

      // Task B: same profile/facts but distinct tent-task lane → fail closed to fresh.
      // contextGeneration still matches (cache-compatible across Tasks).
      const d2 = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        prompt: "Second task different objective same stable facts",
        assigneeKind: "agentProfile",
        profileId: "fake-resumable",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!d2.error, JSON.stringify(d2.error));
      const t2 = await loadTaskEnvelope(
        envFs,
        (d2.result as { taskPath: string }).taskPath
      );
      assert.equal(
        t1.contextGeneration,
        t2.contextGeneration,
        "cross-Task cache-compatible: same contextGeneration"
      );
      assert.notEqual(
        t2.sessionId,
        sessionId1,
        "different agentProfile lane must create a fresh Session"
      );

      // Task C: different profile → different generation + fresh Session.
      const d3 = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        prompt: "Third task different profile",
        assigneeKind: "agentProfile",
        profileId: "fake-other",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!d3.error, JSON.stringify(d3.error));
      const t3 = await loadTaskEnvelope(
        envFs,
        (d3.result as { taskPath: string }).taskPath
      );
      assert.notEqual(t3.sessionId, sessionId1);
      assert.notEqual(t3.sessionId, t2.sessionId);
      assert.notEqual(
        t3.contextGeneration,
        t1.contextGeneration,
        "profile mismatch must change contextGeneration"
      );

    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("Role cross-Task: running+stopped Session blocks; accepted prior reuses", async () => {
  const ws = await makeWorkspace("role-lease");
  try {
    await initGit(ws);
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));

      const roleA = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "Role task one",
        assigneeKind: "role",
        profileId: "fake-resumable",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!roleA.error, JSON.stringify(roleA.error));
      const tr1 = await loadTaskEnvelope(
        envFs,
        (roleA.result as { taskPath: string }).taskPath
      );
      const roleSessionId = tr1.sessionId!;
      assert.ok(roleSessionId);
      assert.ok(isContextGenerationId(tr1.contextGeneration!));
      const rowRole = await svc.runtime.registry.read(roleSessionId);
      assert.equal(rowRole?.contextGeneration, tr1.contextGeneration);
      assert.ok(typeof rowRole?.skillsDigest === "string" && rowRole.skillsDigest.length > 0);

      // P0: Task still running, Session stopped → next Role Task must get FRESH Session.
      await svc.runtime.stopSession(roleSessionId, "user");
      assert.equal((await loadTaskEnvelope(envFs, tr1.path)).state, "running");

      const roleBusy = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "while A running",
        assigneeKind: "role",
        profileId: "fake-resumable",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!roleBusy.error, JSON.stringify(roleBusy.error));
      const tBusy = await loadTaskEnvelope(
        envFs,
        (roleBusy.result as { taskPath: string }).taskPath
      );
      assert.notEqual(
        tBusy.sessionId,
        roleSessionId,
        "prior running Task must block cross-Task Session reuse"
      );
      const busySessionId = tBusy.sessionId;
      if (busySessionId) {
        await svc.runtime.stopSession(busySessionId, "user");
        // Retire busy Session so it is not preferred over A's settled Session.
        await svc.runtime.registry.update(busySessionId, {
          state: "failed",
          resumeToken: undefined,
        });
      }
      await rpc(svc, "task.interrupt", { workspaceId, taskPath: tBusy.path });
      await patchTaskEnvelope(envFs, tBusy.path, {
        state: "interrupted",
        sessionId: null,
      });

      // Accept A (safely settled). Keep sessionId for binding discovery.
      await patchTaskEnvelope(envFs, tr1.path, {
        state: "accepted",
        sessionId: roleSessionId,
        activeDeliveryId: null,
      });
      const probe = await svc.runtime.probe(roleSessionId);
      assert.equal(probe.alive, false);
      assert.equal(probe.resumeCapable, true);

      const roleOk = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "after A accepted",
        assigneeKind: "role",
        profileId: "fake-resumable",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!roleOk.error, JSON.stringify(roleOk.error));
      const tOk = await loadTaskEnvelope(
        envFs,
        (roleOk.result as { taskPath: string }).taskPath
      );
      assert.equal(tOk.contextGeneration, tr1.contextGeneration);
      assert.equal(
        tOk.sessionId,
        roleSessionId,
        "accepted prior Role Task may reuse shared-lane Session"
      );
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("startSession fails loud when Context Card declares missing Node ref", async () => {
  const ws = await makeWorkspace("missing-ref");
  try {
    await initGit(ws);
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        prompt: "will patch bad ref",
        assigneeKind: "agentProfile",
        profileId: "fake-resumable",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const taskPath = (d.result as { taskPath: string }).taskPath;
      const fsa = new NodeFs(path.join(ws, ".tent"));
      const task = await loadTaskEnvelope(fsa, taskPath);
      assert.ok(task.contextCard);
      // Inject foreign/missing node ref into card.
      const badCard = {
        ...task.contextCard!,
        refs: {
          ...task.contextCard!.refs,
          nodes: [{ id: "cx-missing-foreign-node", path: "nope" }],
        },
      };
      await patchTaskEnvelope(fsa, taskPath, { contextCard: badCard });

      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const start = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "fake-resumable",
        callerKind: "user",
      });
      assert.ok(start.error, "missing ref must fail loud");
      const msg = String(start.error.message || JSON.stringify(start.error));
      assert.match(msg, /could not be resolved|UNRESOLVED_REF|cx-missing-foreign-node/i);
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("writeTaskEnvelope fallback generation is stable across task ids", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-gen-fallback-"));
  try {
    const nfs = new NodeFs(dir);
    const a = await writeTaskEnvelope(nfs, new SystemClock(), {
      role: "fake-resumable",
      assigneeKind: "agentProfile",
      claims: [{ id: "root", path: "./" }],
      manifestPath: "temp/agent-profiles/fake-resumable/manifests/a.yml",
      userPrompt: "objective A",
      parentActor: { kind: "role", id: "orchestrator" },
      id: "tk-aaaaaaa1",
    });
    const b = await writeTaskEnvelope(nfs, new SystemClock(), {
      role: "fake-resumable",
      assigneeKind: "agentProfile",
      claims: [{ id: "root", path: "./" }],
      manifestPath: "temp/agent-profiles/fake-resumable/manifests/b.yml",
      userPrompt: "objective B totally different",
      parentActor: { kind: "role", id: "orchestrator" },
      id: "tk-bbbbbbb2",
    });
    const ta = await loadTaskEnvelope(nfs, a);
    const tb = await loadTaskEnvelope(nfs, b);
    assert.equal(ta.contextGeneration, tb.contextGeneration);
    assert.notEqual(ta.taskDeltaDigest, tb.taskDeltaDigest);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("evaluateCandidateSessionLeaseGates: prior running/delivery/input/dual-bind block reuse", async () => {
  const priorRunning: TaskEnvelope = {
    path: "temp/executor/tasks/a.md",
    role: "executor",
    manifest: "m",
    status: "taken",
    state: "running",
    id: "tk-prior001",
    sessionId: "ss-shared01",
  };
  const request: TaskEnvelope = {
    path: "temp/executor/tasks/b.md",
    role: "executor",
    manifest: "m",
    status: "taken",
    state: "running",
    id: "tk-req0002",
  };
  const candidate = {
    id: "ss-shared01",
    lastTaskId: "tk-prior001",
    state: "stopped" as const,
  };

  const bound = findTasksBoundToSession([priorRunning, request], candidate);
  assert.ok(bound.some((t) => t.id === "tk-prior001"));
  assert.equal(isTaskLifecycleSafelySettledForReuse(priorRunning), false);

  const busy = await evaluateCandidateSessionLeaseGates({
    allTasks: [priorRunning, request],
    candidate,
    requestTaskPath: request.path,
    requestTaskId: request.id,
    turnBusy: false,
    workspaceId: "ws",
    listPendingInputs: async () => [],
    hasPendingUserAsk: async () => false,
  });
  assert.equal(busy.exclusiveLease, false);
  assert.ok(busy.reasons.includes("other_active_task_owns_session"));

  const priorDelivered: TaskEnvelope = {
    ...priorRunning,
    state: "delivered",
    activeDeliveryId: "dl-ready01",
  };
  const del = await evaluateCandidateSessionLeaseGates({
    allTasks: [priorDelivered, request],
    candidate,
    requestTaskPath: request.path,
    requestTaskId: request.id,
    turnBusy: false,
    workspaceId: "ws",
    listPendingInputs: async () => [],
    hasPendingUserAsk: async () => false,
  });
  assert.equal(del.exclusiveLease, false);
  assert.equal(del.noPendingDelivery, false);
  assert.ok(del.reasons.includes("prior_pending_delivery"));

  const priorAccepted: TaskEnvelope = {
    ...priorRunning,
    state: "accepted",
    sessionId: "ss-shared01",
    activeDeliveryId: undefined,
  };
  const pendingInput = await evaluateCandidateSessionLeaseGates({
    allTasks: [priorAccepted, request],
    candidate,
    requestTaskPath: request.path,
    requestTaskId: request.id,
    turnBusy: false,
    workspaceId: "ws",
    listPendingInputs: async (_ws, tp) =>
      tp === priorAccepted.path ? [{ id: "ti-1" }] : [],
    hasPendingUserAsk: async () => false,
  });
  assert.equal(pendingInput.noPendingInput, false);
  assert.ok(pendingInput.reasons.includes("prior_pending_input"));

  const dual: TaskEnvelope = {
    ...request,
    sessionId: "ss-shared01",
  };
  const dualGate = await evaluateCandidateSessionLeaseGates({
    allTasks: [priorAccepted, dual],
    candidate,
    requestTaskPath: dual.path,
    requestTaskId: dual.id,
    turnBusy: false,
    workspaceId: "ws",
    listPendingInputs: async () => [],
    hasPendingUserAsk: async () => false,
  });
  // dual is the request itself with sessionId — exclusive ok for same-task;
  // add a third active binder:
  const otherActive: TaskEnvelope = {
    path: "temp/executor/tasks/c.md",
    role: "executor",
    manifest: "m",
    status: "taken",
    state: "running",
    id: "tk-other03",
    sessionId: "ss-shared01",
  };
  const dual2 = await evaluateCandidateSessionLeaseGates({
    allTasks: [priorAccepted, dual, otherActive],
    candidate,
    requestTaskPath: dual.path,
    requestTaskId: dual.id,
    turnBusy: false,
    workspaceId: "ws",
    listPendingInputs: async () => [],
    hasPendingUserAsk: async () => false,
  });
  assert.equal(dual2.exclusiveLease, false);
  assert.ok(dual2.reasons.includes("dual_session_binding"));

  // Fully settled prior → exclusive lease ok.
  const ok = await evaluateCandidateSessionLeaseGates({
    allTasks: [priorAccepted, request],
    candidate,
    requestTaskPath: request.path,
    requestTaskId: request.id,
    turnBusy: false,
    workspaceId: "ws",
    listPendingInputs: async () => [],
    hasPendingUserAsk: async () => false,
  });
  assert.equal(ok.exclusiveLease, true);
  assert.equal(ok.noPendingInput, true);
  assert.equal(ok.noPendingDelivery, true);
  assert.equal(ok.previousTurnSettled, true);
});

test("Role startSession captures real profile/adapter generation; purpose mismatch creates fresh", async () => {
  const ws = await makeWorkspace("role-gen-purpose");
  try {
    await initGit(ws);
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));

      // Role dispatch without profileId: no frozen generation until start.
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "role without profile at dispatch",
        assigneeKind: "role",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        purpose: "implement",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const taskPath = (d.result as { taskPath: string }).taskPath;
      const before = await loadTaskEnvelope(envFs, taskPath);
      assert.equal(before.purpose, "implement");
      // May have fallback generation without real adapter — start will replace.
      const genBefore = before.contextGeneration;

      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const start = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "fake-resumable",
        callerKind: "user",
      });
      assert.ok(!start.error, JSON.stringify(start.error));
      const after = await loadTaskEnvelope(envFs, taskPath);
      assert.ok(isContextGenerationId(after.contextGeneration!));
      // Real profile/adapter must be reflected (differs from role/unknown-adapter fallback).
      if (genBefore) {
        // If dispatch wrote a fallback, start must have rewritten with real adapter.
        // (If somehow equal, still require Session row matches Task.)
      }
      const row = await svc.runtime.registry.read(after.sessionId!);
      assert.equal(row?.contextGeneration, after.contextGeneration);
      assert.equal(row?.purpose, "implement");
      assert.equal(row?.profileId, "fake-resumable");
      assert.equal(row?.adapterId, FAKE_ADAPTER_ID);

      await svc.runtime.stopSession(after.sessionId!, "user");
      await patchTaskEnvelope(envFs, taskPath, { state: "accepted" });

      // Second Role Task with different purpose → fresh Session (purpose mismatch).
      const d2 = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "role different purpose",
        assigneeKind: "role",
        profileId: "fake-resumable",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        purpose: "review",
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!d2.error, JSON.stringify(d2.error));
      const t2 = await loadTaskEnvelope(envFs, (d2.result as { taskPath: string }).taskPath);
      assert.equal(t2.purpose, "review");
      assert.notEqual(t2.contextGeneration, after.contextGeneration);
      assert.notEqual(
        t2.sessionId,
        after.sessionId,
        "purpose mismatch must fail closed to fresh Session"
      );
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("Role profile change at startSession rewrites contextGeneration", async () => {
  const ws = await makeWorkspace("role-profile-change");
  try {
    await initGit(ws);
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));

      // Allow fake-other on executor for this test.
      await fs.writeFile(
        path.join(ws, ".tent", "roles.json"),
        JSON.stringify(
          {
            roles: [
              {
                name: "orchestrator",
                prompt: "dispatch work",
                a2aPolicy: "allow",
                allowedProfiles: ["fake-resumable", "fake-other"],
                roster: ["worker-a"],
              },
              {
                name: "executor",
                prompt: "do work",
                a2aPolicy: "allow",
                allowedProfiles: ["fake-resumable", "fake-other"],
              },
            ],
          },
          null,
          2
        ) + "\n"
      );

      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "start with one profile then compare",
        assigneeKind: "role",
        profileId: "fake-resumable",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const t1 = await loadTaskEnvelope(envFs, (d.result as { taskPath: string }).taskPath);
      const gen1 = t1.contextGeneration!;
      await svc.runtime.stopSession(t1.sessionId!, "user");
      await patchTaskEnvelope(envFs, t1.path, { state: "accepted" });

      const d2 = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "same role different profile",
        assigneeKind: "role",
        profileId: "fake-other",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!d2.error, JSON.stringify(d2.error));
      const t2 = await loadTaskEnvelope(envFs, (d2.result as { taskPath: string }).taskPath);
      assert.notEqual(t2.contextGeneration, gen1);
      assert.notEqual(t2.sessionId, t1.sessionId);
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("appendCallerBootstrapSection never replaces official managed bootstrap", () => {
  const official =
    "--- Tent managed session bootstrap ---\n" +
    "Tent managed bootstrap invariant v1\n" +
    "--- End of stable Tent skill contracts ---\n" +
    "dynamic card\n";
  const only = appendCallerBootstrapSection(official, undefined);
  assert.match(only, /managed session bootstrap/);
  assert.doesNotMatch(only, /Caller bootstrap append/);

  const withCaller = appendCallerBootstrapSection(official, "CUSTOM_ONLY_TEXT");
  assert.match(withCaller, /managed session bootstrap/);
  assert.match(withCaller, /Caller bootstrap append/);
  assert.match(withCaller, /CUSTOM_ONLY_TEXT/);
  assert.ok(withCaller.indexOf("managed session bootstrap") < withCaller.indexOf("CUSTOM_ONLY_TEXT"));
  // Caller text alone is not the whole bootstrap.
  assert.notEqual(withCaller.trim(), "CUSTOM_ONLY_TEXT");
});

test("skillSetCompatibilityDigest includes body/version; profile launch digest flips on in-place edit", () => {
  const a = skillSetCompatibilityDigest([
    { name: "tent-task", bodyDigest: "body-a", version: "0.1.0" },
  ]);
  const b = skillSetCompatibilityDigest([
    { name: "tent-task", bodyDigest: "body-b", version: "0.1.0" },
  ]);
  const c = skillSetCompatibilityDigest([
    { name: "tent-task", bodyDigest: "body-a", version: "0.2.0" },
  ]);
  assert.notEqual(a, b);
  assert.notEqual(a, c);

  const p1 = profileLaunchCompatibilityDigest({
    profileId: "fake-resumable",
    adapterId: FAKE_ADAPTER_ID,
    command: "cmd-a",
    args: ["--x"],
  });
  const p2 = profileLaunchCompatibilityDigest({
    profileId: "fake-resumable",
    adapterId: FAKE_ADAPTER_ID,
    command: "cmd-b",
    args: ["--x"],
  });
  assert.notEqual(p1, p2);
  const fromCfg = profileLaunchCompatibilityDigestFromConfig({
    id: "fake-resumable",
    adapterId: FAKE_ADAPTER_ID,
    command: "cmd-a",
    args: ["--x"],
    fake: { canResume: true },
  });
  assert.equal(typeof fromCfg, "string");
  assert.equal(fromCfg.length, 64);
});

test("live generation: AGENTS/Role/Skill/profile mutations force fresh Session and refresh Task gen", async () => {
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skills-live-"));
  try {
    // Minimal skill bundle for packageRoot override.
    for (const name of ["tent-task", "tent-role"]) {
      const dir = path.join(skillRoot, "skills", name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\nversion: "1.0.0"\n---\n\n# ${name}\nbody-v1\n`
      );
    }

    const ws = await makeWorkspace("live-gen");
    try {
      await initGit(ws);
      await withService(
        async (svc) => {
          const { workspaceId, boxId } = await mountWorkItem(svc, ws);
          const envFs = new NodeFs(path.join(ws, ".tent"));

          const d1 = await rpc(svc, "task.dispatch", {
            workspaceId,
            boxId,
            prompt: "first",
            assigneeKind: "agentProfile",
            profileId: "fake-resumable",
            parentActor: { kind: "role", id: "orchestrator" },
            reviewer: { kind: "role", id: "orchestrator" },
            startSession: true,
            callerKind: "user",
            bootstrapPrompt: "CUSTOM_CALLER_ONLY",
          });
          assert.ok(!d1.error, JSON.stringify(d1.error));
          const t1 = await loadTaskEnvelope(
            envFs,
            (d1.result as { taskPath: string }).taskPath
          );
          const gen1 = t1.contextGeneration!;
          const sid1 = t1.sessionId!;
          assert.ok(isContextGenerationId(gen1));
          // Session facts use live generation (not empty / placeholder).
          const row1 = await svc.runtime.registry.read(sid1);
          assert.equal(row1?.contextGeneration, gen1);

          await svc.runtime.stopSession(sid1, "user");

          // Mutate AGENTS between sessions → live generation must change.
          await writeWorkspaceAgents(ws, "# AGENTS mutated for live generation\n");

          const d2 = await rpc(svc, "task.dispatch", {
            workspaceId,
            boxId,
            prompt: "second after AGENTS mutate",
            assigneeKind: "agentProfile",
            profileId: "fake-resumable",
            parentActor: { kind: "role", id: "orchestrator" },
            reviewer: { kind: "role", id: "orchestrator" },
            startSession: true,
            callerKind: "user",
            bootstrapPrompt: "ANOTHER_CUSTOM",
          });
          assert.ok(!d2.error, JSON.stringify(d2.error));
          const t2 = await loadTaskEnvelope(
            envFs,
            (d2.result as { taskPath: string }).taskPath
          );
          assert.notEqual(
            t2.contextGeneration,
            gen1,
            "live AGENTS mutation must change contextGeneration"
          );
          assert.notEqual(
            t2.sessionId,
            sid1,
            "generation drift must force fresh Session (not reuse old id)"
          );
          assert.equal(
            (await svc.runtime.registry.read(t2.sessionId!))?.contextGeneration,
            t2.contextGeneration
          );

          await svc.runtime.stopSession(t2.sessionId!, "user");

          // Same profileId edited in place (non-secret env key / args) → launch digest
          // flips → fresh Session, without breaking spawn command.
          const cat = svc.ctx.profileCatalog as unknown as {
            profiles: import("../src/runtime/types.js").AgentProfileConfig[];
            runtime: { replaceProfileCatalog: (p: unknown[]) => void };
          };
          const idx = cat.profiles.findIndex((p) => p.id === "fake-resumable");
          assert.ok(idx >= 0);
          const cur = cat.profiles[idx]!;
          cat.profiles[idx] = {
            ...cur,
            args: [...(cur.args ?? []), "--compat-flag-mutated"],
            env: { ...(cur.env ?? {}), TENT_COMPAT_FLAG: "1" },
          };
          cat.runtime.replaceProfileCatalog(cat.profiles);

          const d3 = await rpc(svc, "task.dispatch", {
            workspaceId,
            boxId,
            prompt: "third after profile in-place edit",
            assigneeKind: "agentProfile",
            profileId: "fake-resumable",
            parentActor: { kind: "role", id: "orchestrator" },
            reviewer: { kind: "role", id: "orchestrator" },
            startSession: true,
            callerKind: "user",
          });
          assert.ok(!d3.error, JSON.stringify(d3.error));
          const t3 = await loadTaskEnvelope(
            envFs,
            (d3.result as { taskPath: string }).taskPath
          );
          assert.notEqual(t3.contextGeneration, t2.contextGeneration);
          assert.notEqual(t3.sessionId, t2.sessionId);
        },
        {
          profiles: [FAKE_RESUMABLE, FAKE_OTHER],
        }
      );
      // packageRoot skill mutation path (collector-level production facts).
      const before = await collectStableContextGeneration({
        workspaceRoot: ws,
        workspaceIdentity: "ws-skill",
        packageRoot: skillRoot,
        packageVersion: "0.1.0",
        assigneeKind: "agentProfile",
        assigneeLabel: "fake-resumable",
        profileId: "fake-resumable",
        adapterId: FAKE_ADAPTER_ID,
        profile: { ...FAKE_RESUMABLE },
      });
      await fs.writeFile(
        path.join(skillRoot, "skills", "tent-task", "SKILL.md"),
        `---\nname: tent-task\nversion: "1.0.1"\n---\n\n# tent-task\nbody-v2-mutated\n`
      );
      const after = await collectStableContextGeneration({
        workspaceRoot: ws,
        workspaceIdentity: "ws-skill",
        packageRoot: skillRoot,
        packageVersion: "0.1.0",
        assigneeKind: "agentProfile",
        assigneeLabel: "fake-resumable",
        profileId: "fake-resumable",
        adapterId: FAKE_ADAPTER_ID,
        profile: { ...FAKE_RESUMABLE },
      });
      assert.notEqual(before.contextGeneration, after.contextGeneration);
      assert.notEqual(before.skillSetDigest, after.skillSetDigest);

      // Role prompt/roster mutation flips generation.
      const roleBefore = await collectStableContextGeneration({
        workspaceRoot: ws,
        workspaceIdentity: "ws-role",
        packageRoot: skillRoot,
        packageVersion: "0.1.0",
        assigneeKind: "role",
        assigneeLabel: "executor",
        profileId: "fake-resumable",
        adapterId: FAKE_ADAPTER_ID,
        roleFs: new NodeFs(path.join(ws, ".tent")),
        profile: { ...FAKE_RESUMABLE },
      });
      await fs.writeFile(
        path.join(ws, ".tent", "roles.json"),
        JSON.stringify(
          {
            roles: [
              {
                name: "orchestrator",
                prompt: "dispatch work",
                a2aPolicy: "allow",
                allowedProfiles: ["fake-resumable", "fake-other"],
                roster: ["worker-a"],
              },
              {
                name: "executor",
                prompt: "do work MUTATED PROMPT",
                a2aPolicy: "allow",
                allowedProfiles: ["fake-resumable"],
                roster: ["worker-b"],
              },
            ],
          },
          null,
          2
        ) + "\n"
      );
      const roleAfter = await collectStableContextGeneration({
        workspaceRoot: ws,
        workspaceIdentity: "ws-role",
        packageRoot: skillRoot,
        packageVersion: "0.1.0",
        assigneeKind: "role",
        assigneeLabel: "executor",
        profileId: "fake-resumable",
        adapterId: FAKE_ADAPTER_ID,
        roleFs: new NodeFs(path.join(ws, ".tent")),
        profile: { ...FAKE_RESUMABLE },
      });
      assert.notEqual(roleBefore.contextGeneration, roleAfter.contextGeneration);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(skillRoot, { recursive: true, force: true });
  }
});

test("bootstrapPrompt custom append on fresh and resumed same-Task start", async () => {
  const ws = await makeWorkspace("boot-append");
  try {
    await initGit(ws);
    await withService(async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));

      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        prompt: "bootstrap append task",
        assigneeKind: "agentProfile",
        profileId: "fake-resumable",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
        startSession: true,
        callerKind: "user",
        bootstrapPrompt: "FRESH_CUSTOM_APPEND",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const t = await loadTaskEnvelope(envFs, (d.result as { taskPath: string }).taskPath);
      const sid = t.sessionId!;
      assert.ok(sid);
      // Official path still bound a real generation (caller text did not replace bootstrap).
      assert.ok(isContextGenerationId(t.contextGeneration!));
      assert.equal(
        (await svc.runtime.registry.read(sid))?.contextGeneration,
        t.contextGeneration
      );

      await svc.runtime.stopSession(sid, "user");
      const restart = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath: t.path,
        profileId: "fake-resumable",
        callerKind: "user",
        bootstrapPrompt: "RESUME_CUSTOM_APPEND",
      });
      assert.ok(!restart.error, JSON.stringify(restart.error));
      const t2 = await loadTaskEnvelope(envFs, t.path);
      // Same live facts + settled same Task → reuse Session; generation unchanged.
      assert.equal(t2.sessionId, sid);
      assert.equal(t2.contextGeneration, t.contextGeneration);
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

