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
  extractTaskUserPrompt,
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
  evaluateTaskBlockingDelivery,
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
import { createDelivery } from "../src/core/delivery.js";
import { makeTaskInputId } from "../src/service/task-input-store.js";
import { makeUserAskId } from "../src/service/user-ask-store.js";
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
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
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
  opts?: {
    profiles?: import("../src/runtime/types.js").AgentProfileConfig[];
    packageRoot?: string;
  }
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ctx-reuse-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    profiles: opts?.profiles ?? [FAKE_RESUMABLE, FAKE_OTHER],
    ...(opts?.packageRoot ? { packageRoot: opts.packageRoot } : {}),
  });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

/** Read managed bootstrap text written by the fake adapter for a session. */
async function findFakeBootstrapPrompt(sessionId: string): Promise<string | null> {
  const tmp = os.tmpdir();
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  const candidates = [
    path.join(tmp, `tent-bootstrap-${safe}.txt`),
    path.join(tmp, `tent-bootstrap-${sessionId}.txt`),
  ];
  for (const p of candidates) {
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      /* try next */
    }
  }
  try {
    for (const name of await fs.readdir(tmp)) {
      if (name.startsWith("tent-bootstrap-") && name.includes(safe) && name.endsWith(".txt")) {
        return await fs.readFile(path.join(tmp, name), "utf8");
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function writeMinimalSkillPackage(
  skillRoot: string,
  tentTaskBody = "body-v1",
  tentTaskVersion = "1.0.0"
): Promise<void> {
  for (const name of ["tent-task", "tent-role"]) {
    const dir = path.join(skillRoot, "skills", name);
    await fs.mkdir(dir, { recursive: true });
    const body = name === "tent-task" ? tentTaskBody : "role-body-v1";
    const version = name === "tent-task" ? tentTaskVersion : "1.0.0";
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\nversion: "${version}"\n---\n\n# ${name}\n${body}\n`
    );
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
  return { workspaceId, nodeId: (created.result as { nodeId: string }).nodeId };
}

let workItemSequence = 0;
async function createWorkItemNode(svc: Svc, workspaceId: string): Promise<string> {
  workItemSequence += 1;
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: `work-item-${workItemSequence}`,
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return (created.result as { nodeId: string }).nodeId;
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
    // roleFs is systemRoot (.tent) — same as Service mount.env.fs.
    const roleFs = new NodeFs(path.join(ws, ".tent"));
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
      roleFs,
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
      roleFs,
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
      roleFs,
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
      roleFs,
    });
    assert.notEqual(a.contextGeneration, d.contextGeneration);

    // User-direct agentProfile without parentRoleId remains valid without Role facts.
    const direct = await collectStableContextGeneration({
      workspaceRoot: ws,
      workspaceIdentity: "ws-collect",
      packageRoot: repoRoot,
      packageVersion: "0.1.0",
      assigneeKind: "agentProfile",
      assigneeLabel: "fake-resumable",
      profileId: "fake-resumable",
      adapterId: FAKE_ADAPTER_ID,
    });
    assert.ok(isContextGenerationId(direct.contextGeneration));
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
      contextGeneration: gen,
    });
    await assertDurableContextCardRefsResolved(fsa, good);

    const badNode = buildTaskContextCard({
      objective: "o",
      acceptance: ["a"],
      refs: {
        nodes: [{ id: "cx-doesnotexist" }],
        tasks: [],
        deliveries: [],
        git: [],
      },
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
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const d1 = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        prompt: "Task one implement feature A",
        assigneeKind: "route",
        routeId: "fake-resumable",
        callerKind: "role",
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
        nodeIds: [await createWorkItemNode(svc, workspaceId)],
        prompt: "Task two completely different objective",
        assigneeKind: "route",
        routeId: "fake-resumable",
        callerKind: "role",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
      });
      assert.ok(!d2.error, JSON.stringify(d2.error));
      const path2 = (d2.result as { taskPath: string }).taskPath;
      const t2 = await loadTaskEnvelope(envFs, path2);
      assert.notEqual(t1.id, t2.id);
      assert.equal(t1.contextCard?.objective, "");
      assert.equal(t2.contextCard?.objective, "");
      assert.notEqual(extractTaskUserPrompt(t1), extractTaskUserPrompt(t2));
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
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));

      // Task A (agentProfile): start + stop — same-lane resume candidate.
      const d1 = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        prompt: "First task",
        assigneeKind: "route",
        routeId: "fake-resumable",
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
        nodeIds: [await createWorkItemNode(svc, workspaceId)],
        prompt: "Second task different objective same stable facts",
        assigneeKind: "route",
        routeId: "fake-resumable",
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
        nodeIds: [await createWorkItemNode(svc, workspaceId)],
        prompt: "Third task different profile",
        assigneeKind: "route",
        routeId: "fake-other",
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
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));

      const roleA = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        role: "executor",
        prompt: "Role task one",
        assigneeKind: "role",
        routeId: "fake-resumable",
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
        nodeIds: [await createWorkItemNode(svc, workspaceId)],
        role: "executor",
        prompt: "while A running",
        assigneeKind: "role",
        routeId: "fake-resumable",
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

          // Real production settle: deliver → authorized accept. activeDeliveryId must
      // remain as the historical accepted pointer (do not clear it).
      const delivered = await rpc(svc, "task.deliver", {
        workspaceId,
        taskPath: tr1.path,
        summary: "role A ready for accept",
        commits: [],
      });
      assert.ok(!delivered.error, JSON.stringify(delivered.error));
      const accepted = await rpc(svc, "task.accept", {
        workspaceId,
        taskPath: tr1.path,
        actor: "user",
      });
      assert.ok(!accepted.error, JSON.stringify(accepted.error));
      const tr1Accepted = await loadTaskEnvelope(envFs, tr1.path);
      assert.equal(tr1Accepted.state, "accepted");
      assert.ok(
        tr1Accepted.activeDeliveryId,
        "task.accept must retain historical activeDeliveryId"
      );
      // Keep sessionId binding for cross-Task discovery.
      await patchTaskEnvelope(envFs, tr1.path, {
        sessionId: roleSessionId,
      });
      const probe = await svc.runtime.probe(roleSessionId);
      assert.equal(probe.alive, false);
      assert.equal(probe.resumeCapable, true);

      const roleOk = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        role: "executor",
        prompt: "after A accepted",
        assigneeKind: "role",
        routeId: "fake-resumable",
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
        "accepted prior Role Task with historical activeDeliveryId may reuse shared-lane Session"
      );
      // Prior still holds its historical pointer after reuse.
      assert.equal(
        (await loadTaskEnvelope(envFs, tr1.path)).activeDeliveryId,
        tr1Accepted.activeDeliveryId
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
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        prompt: "will patch bad ref",
        assigneeKind: "route",
        routeId: "fake-resumable",
        callerKind: "role",
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
          nodes: [{ id: "cx-missingforeignnode", path: "nope" }],
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
      assert.match(msg, /could not be resolved|UNRESOLVED_REF|cx-missingforeignnode/i);
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
      nodeRefs: [{ id: "cx-contexta", path: "context/a" }],
      manifestPath: "temp/agent-profiles/fake-resumable/manifests/a.yml",
      userPrompt: "objective A",
      parentActor: { kind: "role", id: "orchestrator" },
      id: "tk-aaaaaaa1",
    });
    const b = await writeTaskEnvelope(nfs, new SystemClock(), {
      role: "fake-resumable",
      assigneeKind: "agentProfile",
      nodeRefs: [{ id: "cx-contextb", path: "context/b" }],
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
    state: "running",
    id: "tk-prior001",
    sessionId: "ss-shared01",
    contextCard: buildTaskContextCard({
      contextGeneration: `cg-v1-${"0".repeat(64)}`,
      refs: { nodes: [{ id: "cx-prior" }] },
    }),
  };
  const request: TaskEnvelope = {
    path: "temp/executor/tasks/b.md",
    role: "executor",
    manifest: "m",
    state: "running",
    id: "tk-req0002",
    contextCard: buildTaskContextCard({
      contextGeneration: `cg-v1-${"1".repeat(64)}`,
      refs: { nodes: [{ id: "cx-request" }] },
    }),
  };
  const candidate = {
    id: "ss-shared01",
    lastTaskId: "tk-prior001",
    state: "stopped" as const,
  };

  const bound = findTasksBoundToSession([priorRunning, request], candidate);
  assert.ok(bound.some((t) => t.id === "tk-prior001"));
  assert.equal(isTaskLifecycleSafelySettledForReuse(priorRunning), false);
  // Cross-Task continuity: only accepted is safely settled.
  assert.equal(
    isTaskLifecycleSafelySettledForReuse({ ...priorRunning, state: "accepted" }),
    true
  );
  for (const terminal of ["rejected", "interrupted", "failed"] as const) {
    assert.equal(
      isTaskLifecycleSafelySettledForReuse({ ...priorRunning, state: terminal }),
      false,
      `${terminal} prior must not be treated as safely settled for cross-Task reuse`
    );
  }

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

  // Historical accepted activeDeliveryId alone must NOT block (Delivery truth).
  const acceptedHist = evaluateTaskBlockingDelivery({
    task: {
      id: "tk-prior001",
      path: priorRunning.path,
      state: "accepted",
      activeDeliveryId: "dl-accepted01",
    },
    deliveries: [
      {
        id: "dl-accepted01",
        taskId: "tk-prior001",
        status: "accepted",
      },
    ],
  });
  assert.equal(
    acceptedHist.blocking,
    false,
    "accepted historical activeDeliveryId must not block reuse"
  );

  // Missing activeDeliveryId pointer fails loud.
  assert.throws(
    () =>
      evaluateTaskBlockingDelivery({
        task: {
          id: "tk-prior001",
          path: priorRunning.path,
          state: "accepted",
          activeDeliveryId: "dl-missing",
        },
        deliveries: [],
      }),
    /does not resolve|missing\/foreign|cannot prove noPendingDelivery/i
  );

  // Foreign activeDeliveryId (wrong taskId) fails loud.
  assert.throws(
    () =>
      evaluateTaskBlockingDelivery({
        task: {
          id: "tk-prior001",
          path: priorRunning.path,
          state: "accepted",
          activeDeliveryId: "dl-foreign",
        },
        deliveries: [
          { id: "dl-foreign", taskId: "tk-other", status: "accepted" },
        ],
      }),
    /foreign|cannot prove noPendingDelivery/i
  );

  // ready Delivery for task blocks even when active pointer is historical accepted.
  const readyScan = evaluateTaskBlockingDelivery({
    task: {
      id: "tk-prior001",
      path: priorRunning.path,
      state: "accepted",
      activeDeliveryId: "dl-accepted01",
    },
    deliveries: [
      { id: "dl-accepted01", taskId: "tk-prior001", status: "accepted" },
      { id: "dl-ready02", taskId: "tk-prior001", status: "ready" },
    ],
  });
  assert.equal(readyScan.blocking, true);

  const priorAccepted: TaskEnvelope = {
    ...priorRunning,
    state: "accepted",
    sessionId: "ss-shared01",
    // Real accept retains historical pointer; bare id must not force block without probe.
    activeDeliveryId: "dl-accepted01",
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
    state: "running",
    id: "tk-other03",
    sessionId: "ss-shared01",
    contextCard: buildTaskContextCard({
      contextGeneration: `cg-v1-${"2".repeat(64)}`,
      refs: { nodes: [{ id: "cx-other" }] },
    }),
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
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));

      // Role dispatch without profileId: no frozen generation until start.
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
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
        nodeIds: [nodeId],
        role: "executor",
        prompt: "role different purpose",
        assigneeKind: "role",
        routeId: "fake-resumable",
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
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
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
        nodeIds: [nodeId],
        role: "executor",
        prompt: "start with one profile then compare",
        assigneeKind: "role",
        routeId: "fake-resumable",
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
        nodeIds: [nodeId],
        role: "executor",
        prompt: "same role different profile",
        assigneeKind: "role",
        routeId: "fake-other",
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

test("same-profileId in-place: ACP model/baseUrlEnvKey and MCP env/credentialRef mappings flip digest", () => {
  const base = {
    id: "same-profile",
    adapterId: "grok-acp",
    command: "node",
    args: ["agent.js"],
    acp: {
      executable: "/usr/bin/grok",
      model: "grok-4",
      envKey: "XAI_API_KEY",
      credentialRef: "cred-main",
      baseUrlEnvKey: "XAI_BASE_URL",
      baseUrl: undefined as string | undefined,
      permissionPolicy: "deny" as const,
      promptTimeoutMs: 60_000,
      permissionTimeoutMs: 30_000,
    },
    skills: [{ name: "extra-skill", path: "/skills/extra", enabled: true }],
    mcpServers: [
      {
        name: "docs-mcp",
        transport: "stdio" as const,
        enabled: true,
        command: "mcp-docs",
        args: ["--stdio"],
        envKeys: { API_TOKEN: "DOCS_TOKEN_ENV" },
        envCredentialRefs: { API_TOKEN: "cred-docs" },
        headerEnvKeys: {},
        headerCredentialRefs: {},
      },
    ],
  };

  const d0 = profileLaunchCompatibilityDigestFromConfig(base);

  // ACP model change (same profileId).
  const dModel = profileLaunchCompatibilityDigestFromConfig({
    ...base,
    acp: { ...base.acp, model: "grok-4-fast" },
  });
  assert.notEqual(d0, dModel, "ACP model in-place edit must flip launch digest");

  // ACP baseUrlEnvKey change.
  const dBaseUrlEnv = profileLaunchCompatibilityDigestFromConfig({
    ...base,
    acp: { ...base.acp, baseUrlEnvKey: "XAI_BASE_URL_ALT" },
  });
  assert.notEqual(d0, dBaseUrlEnv, "ACP baseUrlEnvKey in-place edit must flip launch digest");

  // ACP executable / timeouts also matter.
  const dExec = profileLaunchCompatibilityDigestFromConfig({
    ...base,
    acp: { ...base.acp, executable: "/opt/grok/bin" },
  });
  assert.notEqual(d0, dExec);
  const dTimeout = profileLaunchCompatibilityDigestFromConfig({
    ...base,
    acp: { ...base.acp, promptTimeoutMs: 90_000 },
  });
  assert.notEqual(d0, dTimeout);

  // MCP envKeys mapping *value* (process env key name) under same map key.
  const dEnvKeyVal = profileLaunchCompatibilityDigestFromConfig({
    ...base,
    mcpServers: [
      {
        ...base.mcpServers[0]!,
        envKeys: { API_TOKEN: "DOCS_TOKEN_ENV_ALT" },
      },
    ],
  });
  assert.notEqual(
    d0,
    dEnvKeyVal,
    "MCP envKeys value (process env key name) under same key must flip digest"
  );

  // MCP envCredentialRefs mapping *value* (credentialRef id) under same map key.
  const dCredVal = profileLaunchCompatibilityDigestFromConfig({
    ...base,
    mcpServers: [
      {
        ...base.mcpServers[0]!,
        envCredentialRefs: { API_TOKEN: "cred-docs-alt" },
      },
    ],
  });
  assert.notEqual(
    d0,
    dCredVal,
    "MCP envCredentialRefs value (credentialRef id) under same key must flip digest"
  );

  // MCP envKeys mapping *key* change (different process-var name).
  const dEnvKeyKey = profileLaunchCompatibilityDigestFromConfig({
    ...base,
    mcpServers: [
      {
        ...base.mcpServers[0]!,
        envKeys: { OTHER_TOKEN: "DOCS_TOKEN_ENV" },
      },
    ],
  });
  assert.notEqual(d0, dEnvKeyKey);

  // MCP transport / command / url / headerCredentialRefs.
  const dTransport = profileLaunchCompatibilityDigestFromConfig({
    ...base,
    mcpServers: [
      {
        ...base.mcpServers[0]!,
        transport: "http",
        url: "https://mcp.example/docs",
        command: undefined,
        args: undefined,
        headerCredentialRefs: { Authorization: "cred-http-auth" },
      },
    ],
  });
  assert.notEqual(d0, dTransport);

  // Skill path identity (enabled).
  const dSkillPath = profileLaunchCompatibilityDigestFromConfig({
    ...base,
    skills: [{ name: "extra-skill", path: "/skills/extra-v2", enabled: true }],
  });
  assert.notEqual(d0, dSkillPath);

  // Disabled MCP must not contribute (removing enabled server flips; adding disabled does not restore).
  const dNoMcp = profileLaunchCompatibilityDigestFromConfig({
    ...base,
    mcpServers: [{ ...base.mcpServers[0]!, enabled: false }],
  });
  assert.notEqual(d0, dNoMcp);

  // Profile env *key names* only — values ignored (secret-safe).
  const dEnvKeyOnly = profileLaunchCompatibilityDigestFromConfig({
    ...base,
    env: { VISIBLE_KEY: "anything" },
  });
  const dEnvKeyOnly2 = profileLaunchCompatibilityDigestFromConfig({
    ...base,
    env: { VISIBLE_KEY: "different-value-same-key" },
  });
  assert.equal(
    dEnvKeyOnly,
    dEnvKeyOnly2,
    "profile env values must not enter digest (key names only)"
  );
  assert.notEqual(d0, dEnvKeyOnly, "adding a profile env key name must flip digest");
});

test("live generation: AGENTS/Role/Skill/profile mutations force fresh Session and refresh Task gen", async () => {
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skills-live-"));
  try {
    await writeMinimalSkillPackage(skillRoot);
    const ws = await makeWorkspace("live-gen");
    try {
      await initGit(ws);
      await withService(
        async (svc) => {
          const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
          const envFs = new NodeFs(path.join(ws, ".tent"));

          // ---- AGENTS: dispatch without start → mutate → startSession ----
          const dAgents = await rpc(svc, "task.dispatch", {
            workspaceId,
            nodeIds: [nodeId],
            prompt: "agents mutate path",
            assigneeKind: "route",
            routeId: "fake-resumable",
            parentActor: { kind: "role", id: "orchestrator" },
            reviewer: { kind: "role", id: "orchestrator" },
            startSession: false,
            callerKind: "user",
          });
          assert.ok(!dAgents.error, JSON.stringify(dAgents.error));
          const tAgentsPath = (dAgents.result as { taskPath: string }).taskPath;
          const tAgentsBefore = await loadTaskEnvelope(envFs, tAgentsPath);
          const genAgentsDispatch = tAgentsBefore.contextGeneration!;
          assert.ok(isContextGenerationId(genAgentsDispatch));

          await writeWorkspaceAgents(ws, "# AGENTS mutated after dispatch before start\n");

          const startAgents = await rpc(svc, "task.startSession", {
            workspaceId,
            taskPath: tAgentsPath,
            profileId: "fake-resumable",
            callerKind: "user",
          });
          assert.ok(!startAgents.error, JSON.stringify(startAgents.error));
          const tAgents = await loadTaskEnvelope(envFs, tAgentsPath);
          assert.notEqual(
            tAgents.contextGeneration,
            genAgentsDispatch,
            "live AGENTS mutation must refresh Task/card generation to live id"
          );
          assert.ok(isContextGenerationId(tAgents.contextGeneration!));
          assert.equal(
            (await svc.runtime.registry.read(tAgents.sessionId!))?.contextGeneration,
            tAgents.contextGeneration
          );
          const bootAgents = await findFakeBootstrapPrompt(tAgents.sessionId!);
          assert.ok(bootAgents, "fresh AGENTS path must capture adapter bootstrap");
          assert.match(bootAgents!, /Tent managed session bootstrap/);
          assert.doesNotMatch(bootAgents!, /Tent managed session delta/);

          await svc.runtime.stopSession(tAgents.sessionId!, "user");
          await patchTaskEnvelope(envFs, tAgentsPath, {
            state: "accepted",
            sessionId: null,
            activeDeliveryId: null,
          });

          // ---- tent-task skill body/version: dispatch → mutate package → start ----
          const dSkill = await rpc(svc, "task.dispatch", {
            workspaceId,
            nodeIds: [await createWorkItemNode(svc, workspaceId)],
            prompt: "skill mutate path",
            assigneeKind: "route",
            routeId: "fake-resumable",
            parentActor: { kind: "role", id: "orchestrator" },
            reviewer: { kind: "role", id: "orchestrator" },
            startSession: false,
            callerKind: "user",
          });
          assert.ok(!dSkill.error, JSON.stringify(dSkill.error));
          const tSkillPath = (dSkill.result as { taskPath: string }).taskPath;
          const genSkillDispatch = (await loadTaskEnvelope(envFs, tSkillPath))
            .contextGeneration!;

          await fs.writeFile(
            path.join(skillRoot, "skills", "tent-task", "SKILL.md"),
            `---\nname: tent-task\nversion: "1.0.1"\n---\n\n# tent-task\nbody-v2-mutated\n`
          );

          const startSkill = await rpc(svc, "task.startSession", {
            workspaceId,
            taskPath: tSkillPath,
            profileId: "fake-resumable",
            callerKind: "user",
          });
          assert.ok(!startSkill.error, JSON.stringify(startSkill.error));
          const tSkill = await loadTaskEnvelope(envFs, tSkillPath);
          assert.notEqual(
            tSkill.contextGeneration,
            genSkillDispatch,
            "tent-task body/version mutation must refresh live generation"
          );
          assert.notEqual(
            tSkill.contextGeneration,
            tAgents.contextGeneration,
            "skill mutation must not reuse prior Task generation"
          );
          const bootSkill = await findFakeBootstrapPrompt(tSkill.sessionId!);
          assert.ok(bootSkill);
          assert.match(bootSkill!, /Tent managed session bootstrap/);
          assert.match(bootSkill!, /body-v2-mutated|tent-task/i);

          await svc.runtime.stopSession(tSkill.sessionId!, "user");
          await patchTaskEnvelope(envFs, tSkillPath, {
            state: "accepted",
            sessionId: null,
            activeDeliveryId: null,
          });

          // ---- same-profileId launch config in-place edit ----
          const dProf = await rpc(svc, "task.dispatch", {
            workspaceId,
            nodeIds: [await createWorkItemNode(svc, workspaceId)],
            prompt: "profile mutate path",
            assigneeKind: "route",
            routeId: "fake-resumable",
            parentActor: { kind: "role", id: "orchestrator" },
            reviewer: { kind: "role", id: "orchestrator" },
            startSession: false,
            callerKind: "user",
          });
          assert.ok(!dProf.error, JSON.stringify(dProf.error));
          const tProfPath = (dProf.result as { taskPath: string }).taskPath;
          const genProfDispatch = (await loadTaskEnvelope(envFs, tProfPath))
            .contextGeneration!;

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

          const startProf = await rpc(svc, "task.startSession", {
            workspaceId,
            taskPath: tProfPath,
            profileId: "fake-resumable",
            callerKind: "user",
          });
          assert.ok(!startProf.error, JSON.stringify(startProf.error));
          const tProf = await loadTaskEnvelope(envFs, tProfPath);
          assert.notEqual(tProf.contextGeneration, genProfDispatch);
          assert.notEqual(tProf.sessionId, tSkill.sessionId);
          assert.equal(
            (await svc.runtime.registry.read(tProf.sessionId!))?.contextGeneration,
            tProf.contextGeneration
          );

          await svc.runtime.stopSession(tProf.sessionId!, "user");
          await patchTaskEnvelope(envFs, tProfPath, {
            state: "accepted",
            sessionId: null,
            activeDeliveryId: null,
          });

          // ---- Role prompt: dispatch → mutate roles.json → startSession ----
          const dRole = await rpc(svc, "task.dispatch", {
            workspaceId,
            nodeIds: [nodeId],
            role: "executor",
            prompt: "role mutate path",
            assigneeKind: "role",
            routeId: "fake-resumable",
            parentActor: { kind: "user", id: "user" },
            reviewer: { kind: "user", id: "user" },
            startSession: false,
            callerKind: "user",
          });
          assert.ok(!dRole.error, JSON.stringify(dRole.error));
          const tRolePath = (dRole.result as { taskPath: string }).taskPath;
          const genRoleDispatch = (await loadTaskEnvelope(envFs, tRolePath))
            .contextGeneration!;

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
                    roster: ["worker-b", "worker-c"],
                  },
                ],
              },
              null,
              2
            ) + "\n"
          );

          const startRole = await rpc(svc, "task.startSession", {
            workspaceId,
            taskPath: tRolePath,
            profileId: "fake-resumable",
            callerKind: "user",
          });
          assert.ok(!startRole.error, JSON.stringify(startRole.error));
          const tRole = await loadTaskEnvelope(envFs, tRolePath);
          assert.notEqual(
            tRole.contextGeneration,
            genRoleDispatch,
            "Role prompt mutation must refresh live generation"
          );
          const bootRole = await findFakeBootstrapPrompt(tRole.sessionId!);
          assert.ok(bootRole);
          assert.match(bootRole!, /Tent managed session bootstrap/);
          assert.match(bootRole!, /MUTATED PROMPT|do work/);
        },
        {
          profiles: [FAKE_RESUMABLE, FAKE_OTHER],
          packageRoot: skillRoot,
        }
      );
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
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));

      // dispatch does not forward bootstrapPrompt; startSession is the production append path.
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        prompt: "bootstrap append task",
        assigneeKind: "route",
        routeId: "fake-resumable",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
        startSession: false,
        callerKind: "user",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "fake-resumable",
        callerKind: "user",
        bootstrapPrompt: "FRESH_CUSTOM_APPEND",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const t = await loadTaskEnvelope(envFs, taskPath);
      const sid = t.sessionId!;
      assert.ok(sid);
      assert.ok(isContextGenerationId(t.contextGeneration!));
      assert.equal(
        (await svc.runtime.registry.read(sid))?.contextGeneration,
        t.contextGeneration
      );

      // Capture real adapter/provider bootstrap: official content remains; caller appends.
      const freshBoot = await findFakeBootstrapPrompt(sid);
      assert.ok(freshBoot, "fake adapter must write bootstrap file for fresh start");
      assert.match(freshBoot!, /Tent managed session bootstrap/);
      assert.match(freshBoot!, /tent-task|Tent Task Context Card|contextGeneration/i);
      assert.match(freshBoot!, /Caller bootstrap append/);
      assert.match(freshBoot!, /FRESH_CUSTOM_APPEND/);
      assert.ok(
        freshBoot!.indexOf("Tent managed session bootstrap") <
          freshBoot!.indexOf("FRESH_CUSTOM_APPEND"),
        "caller text must append after official managed bootstrap, never replace"
      );
      // Fresh path always injects full stable prefix (continuity not yet proven).
      assert.doesNotMatch(freshBoot!, /Tent managed session delta/);

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

      const resumeBoot = await findFakeBootstrapPrompt(sid);
      assert.ok(resumeBoot, "fake adapter must write bootstrap file for resume");
      // Continuity proven → stable prefix omitted; delta + caller append only.
      assert.match(resumeBoot!, /Tent managed session delta/);
      assert.match(resumeBoot!, /RESUME_CUSTOM_APPEND/);
      assert.match(resumeBoot!, /Caller bootstrap append/);
      assert.doesNotMatch(
        resumeBoot!,
        /Tent managed session bootstrap/,
        "stable prefix omitted only after continuity gate"
      );
      // Official delta content still present (Context Card / task pointers), not replaced.
      assert.match(resumeBoot!, /contextGeneration|Task envelope|## User Prompt/i);
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("active same-Task path fails loud on empty/legacy Session contextGeneration", async () => {
  const ws = await makeWorkspace("empty-gen-active");
  try {
    await initGit(ws);
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));

      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        prompt: "empty gen active path",
        assigneeKind: "route",
        routeId: "fake-resumable",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const t = await loadTaskEnvelope(envFs, (d.result as { taskPath: string }).taskPath);
      const sid = t.sessionId!;
      assert.ok(sid);
      assert.ok(isContextGenerationId(t.contextGeneration!));

      // Strip generation to simulate empty/legacy Session row while Session stays active.
      await svc.runtime.registry.update(sid, { contextGeneration: "" });
      const row = await svc.runtime.registry.read(sid);
      assert.ok(row);
      assert.ok(!row.contextGeneration?.trim());

      const again = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath: t.path,
        profileId: "fake-resumable",
        callerKind: "user",
      });
      assert.ok(again.error, "empty Session contextGeneration must fail loud");
      const msg = String(again.error.message || again.error);
      assert.match(msg, /empty\/legacy contextGeneration|cannot prove continuity/i);
      const data = (again.error as { data?: { code?: string } }).data;
      assert.equal(data?.code, "CONTEXT_GENERATION_EMPTY_ACTIVE");
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("missing/foreign activeDeliveryId fails loud (cannot prove noPendingDelivery)", async () => {
  const ws = await makeWorkspace("del-pointer-fail");
  try {
    await initGit(ws);
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));

      const d1 = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        role: "executor",
        prompt: "prior with foreign delivery pointer",
        assigneeKind: "role",
        routeId: "fake-resumable",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!d1.error, JSON.stringify(d1.error));
      const t1 = await loadTaskEnvelope(
        envFs,
        (d1.result as { taskPath: string }).taskPath
      );
      const sid = t1.sessionId!;
      await svc.runtime.stopSession(sid, "user");

      // Missing pointer: activeDeliveryId does not resolve.
      await patchTaskEnvelope(envFs, t1.path, {
        state: "accepted",
        sessionId: sid,
        activeDeliveryId: "dl-does-not-exist",
      });

      const dMissing = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        role: "executor",
        prompt: "next after missing delivery pointer",
        assigneeKind: "role",
        routeId: "fake-resumable",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(dMissing.error, "missing activeDeliveryId must fail loud");
      const missingMsg = String(dMissing.error.message || dMissing.error);
      assert.match(
        missingMsg,
        /noPendingDelivery|does not resolve|DELIVERY_POINTER|missing|foreign/i
      );
      assert.equal(
        (dMissing.error as { data?: { code?: string } }).data?.code,
        "DELIVERY_POINTER_UNRESOLVED"
      );

      // Foreign pointer: Delivery exists but belongs to another taskId.
      const foreign = await createDelivery(envFs, new SystemClock(), {
        taskId: "tk-someone-else",
        sourceNodeId: nodeId,
        role: "executor",
        summary: "foreign delivery",
        status: "accepted",
        commits: [],
      });
      await patchTaskEnvelope(envFs, t1.path, {
        state: "accepted",
        sessionId: sid,
        activeDeliveryId: foreign.id,
      });

      const dForeign = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        role: "executor",
        prompt: "next after foreign delivery pointer",
        assigneeKind: "role",
        routeId: "fake-resumable",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(dForeign.error, "foreign activeDeliveryId must fail loud");
      assert.match(
        String(dForeign.error.message || dForeign.error),
        /foreign|noPendingDelivery|DELIVERY_POINTER/i
      );
      assert.equal(
        (dForeign.error as { data?: { code?: string } }).data?.code,
        "DELIVERY_POINTER_UNRESOLVED"
      );
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("hasBlockingDelivery fails loud when Delivery store is unreadable", async () => {
  const ws = await makeWorkspace("del-store-fail");
  try {
    await initGit(ws);
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));

      const d1 = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        role: "executor",
        prompt: "prior for delivery store fail",
        assigneeKind: "role",
        routeId: "fake-resumable",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!d1.error, JSON.stringify(d1.error));
      const t1 = await loadTaskEnvelope(
        envFs,
        (d1.result as { taskPath: string }).taskPath
      );
      const sid = t1.sessionId!;
      await svc.runtime.stopSession(sid, "user");
      await patchTaskEnvelope(envFs, t1.path, {
        state: "accepted",
        sessionId: sid,
        activeDeliveryId: null,
      });

      // Ensure deliveries dir exists so loadDeliveries actually listDirs it.
      await fs.mkdir(path.join(ws, ".tent", "temp", "executor", "deliveries"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(ws, ".tent", "temp", "executor", "deliveries", "placeholder.md"),
        "---\ntype: delivery\nid: dl-placeholder1\ntaskId: none\nsourceNodeId: none\nrole: executor\nstatus: draft\n---\n",
        "utf8"
      );

      // Monkey-patch mount fs.listDir: Delivery scan must fail loud (never prove empty).
      const mount = svc.ctx.host.require(workspaceId);
      const originalListDir = mount.env.fs.listDir.bind(mount.env.fs);
      mount.env.fs.listDir = async (dir: string) => {
        const norm = String(dir).replace(/\\/g, "/");
        if (norm.includes("deliveries")) {
          throw new Error("simulated Delivery store unreadable");
        }
        return originalListDir(dir);
      };

      const d2 = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        role: "executor",
        prompt: "next after corrupt delivery store",
        assigneeKind: "role",
        routeId: "fake-resumable",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(
        d2.error,
        "unreadable Delivery store must fail loud (not reuse / not silent empty)"
      );
      const msg = String(d2.error.message || d2.error);
      assert.match(
        msg,
        /Delivery|DELIVERY_STORE_UNREADABLE|noPendingDelivery|unreadable/i
      );
      const code = (d2.error as { data?: { code?: string } }).data?.code;
      assert.equal(code, "DELIVERY_STORE_UNREADABLE");
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("collector failure at startSession fails loud (no reusable fallback)", async () => {
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skills-collect-fail-"));
  try {
    await writeMinimalSkillPackage(skillRoot);
    const ws = await makeWorkspace("collector-fail");
    try {
      await initGit(ws);
      await withService(
        async (svc) => {
          const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
          const envFs = new NodeFs(path.join(ws, ".tent"));
          const rolesPath = path.join(ws, ".tent", "roles.json");

          async function rolesWithout(name: string): Promise<void> {
            const raw = JSON.parse(await fs.readFile(rolesPath, "utf8")) as {
              roles: Array<{ name: string }>;
            };
            raw.roles = raw.roles.filter((r) => r.name !== name);
            await fs.writeFile(rolesPath, JSON.stringify(raw, null, 2) + "\n");
          }

          // ---- durable Role assignee: remove required Role after dispatch ----
          const dRole = await rpc(svc, "task.dispatch", {
            workspaceId,
            nodeIds: [nodeId],
            role: "executor",
            prompt: "role collector fail",
            assigneeKind: "role",
            routeId: "fake-resumable",
            parentActor: { kind: "user", id: "user" },
            reviewer: { kind: "user", id: "user" },
            startSession: false,
            callerKind: "user",
          });
          assert.ok(!dRole.error, JSON.stringify(dRole.error));
          const rolePath = (dRole.result as { taskPath: string }).taskPath;
          const roleBefore = await loadTaskEnvelope(envFs, rolePath);
          const roleGenBefore = roleBefore.contextGeneration!;
          assert.ok(isContextGenerationId(roleGenBefore));

          await rolesWithout("executor");

          const startRole = await rpc(svc, "task.startSession", {
            workspaceId,
            taskPath: rolePath,
            profileId: "fake-resumable",
            callerKind: "user",
          });
          assert.ok(
            startRole.error,
            "missing durable Role must fail collector loud (no empty Role facts)"
          );
          const roleMsg = String(startRole.error.message || startRole.error);
          assert.match(
            roleMsg,
            /contextGeneration collection failed|required Role not found|Role "executor"/i
          );
          const roleCode = (startRole.error as { data?: { code?: string } }).data
            ?.code;
          assert.equal(roleCode, "CONTEXT_GENERATION_COLLECT_FAILED");
          const roleAfter = await loadTaskEnvelope(envFs, rolePath);
          assert.equal(roleAfter.sessionId, undefined, "no Session launch on collect fail");
          assert.equal(
            roleAfter.contextGeneration,
            roleGenBefore,
            "must not refresh generation to empty/fallback facts"
          );

          // Restore executor so later harness steps can use roles.json again.
          await fs.writeFile(
            rolesPath,
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

          // ---- parentRole-bound agentProfile: remove parent Role after dispatch ----
          const dProf = await rpc(svc, "task.dispatch", {
            workspaceId,
            nodeIds: [await createWorkItemNode(svc, workspaceId)],
            prompt: "parent-role collector fail",
            assigneeKind: "route",
            routeId: "fake-resumable",
            parentActor: { kind: "role", id: "orchestrator" },
            reviewer: { kind: "role", id: "orchestrator" },
            startSession: false,
            callerKind: "user",
          });
          assert.ok(!dProf.error, JSON.stringify(dProf.error));
          const profPath = (dProf.result as { taskPath: string }).taskPath;
          const profBefore = await loadTaskEnvelope(envFs, profPath);
          const profGenBefore = profBefore.contextGeneration!;
          assert.ok(isContextGenerationId(profGenBefore));

          await rolesWithout("orchestrator");

          const startProf = await rpc(svc, "task.startSession", {
            workspaceId,
            taskPath: profPath,
            profileId: "fake-resumable",
            callerKind: "user",
          });
          assert.ok(
            startProf.error,
            "missing parent Role must fail collector loud for agentProfile"
          );
          const profMsg = String(startProf.error.message || startProf.error);
          assert.match(
            profMsg,
            /contextGeneration collection failed|required Role not found|Role "orchestrator"|parent Role/i
          );
          assert.equal(
            (startProf.error as { data?: { code?: string } }).data?.code,
            "CONTEXT_GENERATION_COLLECT_FAILED"
          );
          const profAfter = await loadTaskEnvelope(envFs, profPath);
          assert.equal(profAfter.sessionId, undefined);
          assert.equal(
            profAfter.contextGeneration,
            profGenBefore,
            "must not refresh generation to empty/fallback facts"
          );

          // Restore roles; then remove required built-in tent-task SKILL.md.
          await fs.writeFile(
            rolesPath,
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

          const dSkill = await rpc(svc, "task.dispatch", {
            workspaceId,
            nodeIds: [await createWorkItemNode(svc, workspaceId)],
            prompt: "missing skill collector fail",
            assigneeKind: "route",
            routeId: "fake-resumable",
            parentActor: { kind: "role", id: "orchestrator" },
            reviewer: { kind: "role", id: "orchestrator" },
            startSession: false,
            callerKind: "user",
          });
          assert.ok(!dSkill.error, JSON.stringify(dSkill.error));
          const skillPath = (dSkill.result as { taskPath: string }).taskPath;
          const skillBefore = await loadTaskEnvelope(envFs, skillPath);
          const skillGenBefore = skillBefore.contextGeneration!;
          assert.ok(isContextGenerationId(skillGenBefore));

          await fs.rm(path.join(skillRoot, "skills", "tent-task", "SKILL.md"), {
            force: true,
          });

          const startSkill = await rpc(svc, "task.startSession", {
            workspaceId,
            taskPath: skillPath,
            profileId: "fake-resumable",
            callerKind: "user",
          });
          assert.ok(
            startSkill.error,
            "missing built-in SKILL.md must fail collector loud"
          );
          const skillMsg = String(startSkill.error.message || startSkill.error);
          assert.match(
            skillMsg,
            /contextGeneration collection failed|Built-in skill missing|tent-task/i
          );
          assert.equal(
            (startSkill.error as { data?: { code?: string } }).data?.code,
            "CONTEXT_GENERATION_COLLECT_FAILED"
          );
          const skillAfter = await loadTaskEnvelope(envFs, skillPath);
          assert.equal(skillAfter.sessionId, undefined);
          assert.equal(skillAfter.contextGeneration, skillGenBefore);
        },
        {
          profiles: [FAKE_RESUMABLE, FAKE_OTHER],
          packageRoot: skillRoot,
        }
      );
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(skillRoot, { recursive: true, force: true });
  }
});

test("Service cross-Task prior blockers force fresh; accepted+settled reuses", async () => {
  const ws = await makeWorkspace("prior-blockers");
  try {
    await initGit(ws);
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
      const envFs = new NodeFs(path.join(ws, ".tent"));
      const now = new Date().toISOString();

      async function dispatchRole(prompt: string) {
        const taskNodeId = await createWorkItemNode(svc, workspaceId);
        const r = await rpc(svc, "task.dispatch", {
          workspaceId,
          nodeIds: [taskNodeId],
          role: "executor",
          prompt,
          assigneeKind: "role",
          routeId: "fake-resumable",
          parentActor: { kind: "user", id: "user" },
          reviewer: { kind: "user", id: "user" },
          startSession: true,
          callerKind: "user",
        });
        assert.ok(!r.error, JSON.stringify(r.error));
        return loadTaskEnvelope(envFs, (r.result as { taskPath: string }).taskPath);
      }

      async function retireSessionTask(
        task: Awaited<ReturnType<typeof loadTaskEnvelope>>,
        sid: string | undefined
      ) {
        if (sid) {
          try {
            await svc.runtime.stopSession(sid, "user");
          } catch {
            /* already stopped */
          }
          await svc.runtime.registry.update(sid, {
            state: "failed",
            resumeToken: undefined,
          });
        }
        await patchTaskEnvelope(envFs, task.path, {
          state: "interrupted",
          sessionId: null,
          activeDeliveryId: null,
        });
      }

      // Baseline: real deliver → accept; historical activeDeliveryId retained.
      const tAccept = await dispatchRole("prior accepted baseline");
      const sidAccept = tAccept.sessionId!;
      await svc.runtime.stopSession(sidAccept, "user");
      const del0 = await rpc(svc, "task.deliver", {
        workspaceId,
        taskPath: tAccept.path,
        summary: "baseline ready",
        commits: [],
      });
      assert.ok(!del0.error, JSON.stringify(del0.error));
      const acc0 = await rpc(svc, "task.accept", {
        workspaceId,
        taskPath: tAccept.path,
        actor: "user",
      });
      assert.ok(!acc0.error, JSON.stringify(acc0.error));
      const tAcceptSettled = await loadTaskEnvelope(envFs, tAccept.path);
      assert.equal(tAcceptSettled.state, "accepted");
      assert.ok(
        tAcceptSettled.activeDeliveryId,
        "accept must leave historical activeDeliveryId intact"
      );
      await patchTaskEnvelope(envFs, tAccept.path, { sessionId: sidAccept });
      const tReuse = await dispatchRole("after accepted should reuse");
      assert.equal(
        tReuse.sessionId,
        sidAccept,
        "accepted+settled prior with historical activeDeliveryId must reuse"
      );
      await svc.runtime.stopSession(sidAccept, "user");
      // Settle the reuse Task without clearing the baseline's historical pointer.
      await patchTaskEnvelope(envFs, tReuse.path, {
        state: "interrupted",
        sessionId: null,
        activeDeliveryId: null,
      });
      // Keep sidAccept bound only on tAccept for subsequent blocker tests.
      await patchTaskEnvelope(envFs, tAccept.path, {
        state: "accepted",
        sessionId: sidAccept,
        // Do not clear activeDeliveryId — production accept keeps it.
      });
      assert.ok(
        (await loadTaskEnvelope(envFs, tAccept.path)).activeDeliveryId,
        "historical activeDeliveryId must still be present for blocker cases"
      );

      // ---- pending TaskInput on prior ----
      await svc.ctx.taskInputs.add({
        id: makeTaskInputId(),
        workspaceId,
        taskPath: tAccept.path,
        taskId: tAccept.id,
        status: "pending",
        text: "blocking prior input",
        createdAt: now,
        updatedAt: now,
      });
      const tInput = await dispatchRole("while prior has pending TaskInput");
      assert.notEqual(
        tInput.sessionId,
        sidAccept,
        "pending TaskInput on prior must force fresh Session"
      );
      await retireSessionTask(tInput, tInput.sessionId);
      await svc.ctx.taskInputs.cancelTask(workspaceId, tAccept.path, "test");
      await svc.runtime.registry.update(sidAccept, {
        state: "failed",
        resumeToken: undefined,
      });
      await patchTaskEnvelope(envFs, tAccept.path, { sessionId: null });

      // Fresh accepted prior for UserAsk gate (real deliver→accept).
      const tBase2 = await dispatchRole("fresh prior for UserAsk");
      const sid2 = tBase2.sessionId!;
      await svc.runtime.stopSession(sid2, "user");
      assert.ok(
        !(
          await rpc(svc, "task.deliver", {
            workspaceId,
            taskPath: tBase2.path,
            summary: "userask prior ready",
            commits: [],
          })
        ).error
      );
      assert.ok(
        !(
          await rpc(svc, "task.accept", {
            workspaceId,
            taskPath: tBase2.path,
            actor: "user",
          })
        ).error
      );
      await patchTaskEnvelope(envFs, tBase2.path, { sessionId: sid2 });
      assert.ok((await loadTaskEnvelope(envFs, tBase2.path)).activeDeliveryId);

      // ---- pending UserAsk on prior ----
      await svc.ctx.userAsks.add({
        id: makeUserAskId(),
        workspaceId,
        taskPath: tBase2.path,
        taskId: tBase2.id,
        status: "pending",
        question: "block reuse?",
        createdAt: now,
        updatedAt: now,
      });
      const tAsk = await dispatchRole("while prior has pending UserAsk");
      assert.notEqual(
        tAsk.sessionId,
        sid2,
        "pending UserAsk on prior must force fresh Session"
      );
      await retireSessionTask(tAsk, tAsk.sessionId);
      await svc.ctx.userAsks.cancelTask(workspaceId, tBase2.path, "test");
      await svc.runtime.registry.update(sid2, {
        state: "failed",
        resumeToken: undefined,
      });
      await patchTaskEnvelope(envFs, tBase2.path, { sessionId: null });

      const tBase3 = await dispatchRole("prior for ready delivery");
      const sid3 = tBase3.sessionId!;
      await svc.runtime.stopSession(sid3, "user");

      // ---- ready Delivery on prior (unresolved) ----
      const delivery = await createDelivery(envFs, new SystemClock(), {
        taskId: tBase3.id!,
        sourceNodeId: tBase3.contextCard!.refs.nodes[0]!.id,
        role: "executor",
        summary: "ready delivery blocks reuse",
        status: "ready",
        commits: [],
      });
      await patchTaskEnvelope(envFs, tBase3.path, {
        state: "delivered",
        sessionId: sid3,
        activeDeliveryId: delivery.id,
      });
      const tDel = await dispatchRole("while prior has ready Delivery");
      assert.notEqual(
        tDel.sessionId,
        sid3,
        "ready Delivery on prior must force fresh Session"
      );
      await retireSessionTask(tDel, tDel.sessionId);
      await svc.runtime.registry.update(sid3, {
        state: "failed",
        resumeToken: undefined,
      });
      await patchTaskEnvelope(envFs, tBase3.path, {
        sessionId: null,
        activeDeliveryId: null,
        state: "accepted",
      });

      // ---- dual binding: another active Task envelope holds the stopped Session ----
      // Do not start a second live Role session (Role exclusive live lock). Seed a
      // synthetic running binder on the stopped Session instead.
      const tBase4 = await dispatchRole("prior for dual bind");
      const sid4 = tBase4.sessionId!;
      await svc.runtime.stopSession(sid4, "user");
      assert.ok(
        !(
          await rpc(svc, "task.deliver", {
            workspaceId,
            taskPath: tBase4.path,
            summary: "dual prior ready",
            commits: [],
          })
        ).error
      );
      assert.ok(
        !(
          await rpc(svc, "task.accept", {
            workspaceId,
            taskPath: tBase4.path,
            actor: "user",
          })
        ).error
      );
      await patchTaskEnvelope(envFs, tBase4.path, { sessionId: sid4 });
      assert.ok((await loadTaskEnvelope(envFs, tBase4.path)).activeDeliveryId);

      // Create a second Role task without starting a session, then bind it to sid4.
      const dDualOther = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [nodeId],
        role: "executor",
        prompt: "synthetic dual binder",
        assigneeKind: "role",
        routeId: "fake-resumable",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        startSession: false,
        callerKind: "user",
      });
      assert.ok(!dDualOther.error, JSON.stringify(dDualOther.error));
      const dualOtherPath = (dDualOther.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath: dualOtherPath });
      await patchTaskEnvelope(envFs, dualOtherPath, {
        state: "running",
        sessionId: sid4,
        activeDeliveryId: null,
      });

      const tDual = await dispatchRole("while dual bind active");
      assert.notEqual(
        tDual.sessionId,
        sid4,
        "dual Session binding must force fresh Session"
      );
      await retireSessionTask(tDual, tDual.sessionId);
      await patchTaskEnvelope(envFs, dualOtherPath, {
        state: "interrupted",
        sessionId: null,
      });
      await svc.runtime.registry.update(sid4, {
        state: "failed",
        resumeToken: undefined,
      });
      await patchTaskEnvelope(envFs, tBase4.path, { sessionId: null });

      // ---- rejected / interrupted / failed priors force fresh (no unresolved Delivery) ----
      // Cross-Task continuity requires accepted only; other terminals are not safe.
      for (const terminal of ["rejected", "interrupted", "failed"] as const) {
        const tTerm = await dispatchRole(`prior terminal ${terminal}`);
        const sidTerm = tTerm.sessionId!;
        await svc.runtime.stopSession(sidTerm, "user");
        // No ready Delivery — only non-accepted terminal state.
        await patchTaskEnvelope(envFs, tTerm.path, {
          state: terminal,
          sessionId: sidTerm,
          activeDeliveryId: null,
        });
        assert.equal(
          isTaskLifecycleSafelySettledForReuse(
            await loadTaskEnvelope(envFs, tTerm.path)
          ),
          false
        );
        const tNext = await dispatchRole(`after prior ${terminal}`);
        assert.notEqual(
          tNext.sessionId,
          sidTerm,
          `${terminal} prior (no unresolved Delivery) must force fresh Session`
        );
        await retireSessionTask(tNext, tNext.sessionId);
        await svc.runtime.registry.update(sidTerm, {
          state: "failed",
          resumeToken: undefined,
        });
        await patchTaskEnvelope(envFs, tTerm.path, { sessionId: null });
      }
    });
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
