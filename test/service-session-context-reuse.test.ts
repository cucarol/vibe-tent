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
import { loadTaskEnvelope, writeTaskEnvelope } from "../src/core/task.js";
import { SystemClock } from "../src/fs/node-fs.js";
import {
  computeContextGeneration,
  isContextGenerationId,
} from "../src/core/task-context-card.js";
import {
  assertDurableContextCardRefsResolved,
  collectStableContextGeneration,
} from "../src/service/session-context-generation.js";
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

      // Durable Role cross-Task: shared tent-role lane → Session reuse when facts match.
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
      assert.ok(tr1.sessionId);
      const roleSessionId = tr1.sessionId!;
      await svc.runtime.stopSession(roleSessionId, "user");

      const roleB = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "Role task two different objective",
        assigneeKind: "role",
        profileId: "fake-resumable",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        startSession: true,
        callerKind: "user",
      });
      assert.ok(!roleB.error, JSON.stringify(roleB.error));
      const tr2 = await loadTaskEnvelope(
        envFs,
        (roleB.result as { taskPath: string }).taskPath
      );
      assert.equal(
        tr1.contextGeneration,
        tr2.contextGeneration,
        "Role Tasks share contextGeneration across objectives"
      );
      assert.equal(
        tr2.sessionId,
        roleSessionId,
        "compatible Role cross-Task must reuse shared-lane Session"
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
      const { patchTaskEnvelope } = await import("../src/core/task.js");
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
