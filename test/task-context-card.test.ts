/**
 * P0 Core/Runtime: Task Context Card v1 + prompt assembly + Session reuse gate
 * (Node cx-5q6za6).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs, SystemClock } from "../src/fs/node-fs.js";
import {
  assembleManagedPrompt,
  assertRefsResolved,
  buildTaskContextCard,
  canonicalJson,
  computeContextGeneration,
  computeTaskDeltaDigest,
  evaluateSessionReuseCompatibility,
  formatContextGeneration,
  formatTaskContextCardPrompt,
  isContextGenerationId,
  loadTaskContextCardFromFrontmatter,
  MANAGED_BOOTSTRAP_INVARIANT,
  parseTaskContextCard,
  profileAdapterCompatibilityDigest,
  projectAssigneeFromTask,
  serializeTaskContextCardForFrontmatter,
  sha256Hex,
  shouldInjectStablePrefix,
  decideStablePrefixInjection,
  skillsCompatibilityDigest,
  TaskContextCardError,
  assertOrdinaryExecutorLaneHistory,
  ExecutorLaneHistoryError,
  projectExecutionLaneFromTask,
  buildIntegrationAuthority,
  type TaskContextCardV1,
} from "../src/core/task-context-card.js";
import {
  loadTaskEnvelope,
  patchTaskEnvelope,
  writeTaskEnvelope,
} from "../src/core/task.js";
import { assertOrdinaryExecutorLaneHistoryInGit } from "../src/core/workspace.js";
import { spawnSync } from "node:child_process";

function sampleGeneration(extra?: string): string {
  return computeContextGeneration({
    workspaceIdentity: "ws-test",
    rulesPointerDigest: "rules-d1",
    agentsPointerDigest: "agents-d1",
    tentRoleDigest: "role-skill-d1",
    rolePrompt: "Stay in scope.",
    rosterAgentIds: ["coder", "reviewer"],
    tentTaskDigest: "task-skill-d1",
    profileAdapterCompatibility: profileAdapterCompatibilityDigest({
      profileId: "grok-core-worker",
      adapterId: "grok-acp",
    }),
    extraStable: extra ? { note: extra } : undefined,
  });
}

function sampleCard(
  overrides?: Partial<Parameters<typeof buildTaskContextCard>[0]>
): TaskContextCardV1 {
  const contextGeneration = overrides?.contextGeneration ?? sampleGeneration();
  const base: Parameters<typeof buildTaskContextCard>[0] = {
    objective: "Implement Context Card v1 Core seam",
    frozenDecisions: ["No new lifecycle entity", "Core is authoritative"],
    scope: {
      include: ["src/core/task-context-card.ts", "tests"],
      exclude: ["skills/", "UI"],
    },
    acceptance: [
      "Schema + digests + fail-loud tests",
      "Stable prefix once per generation",
    ],
    refs: {
      nodes: [{ id: "cx-5q6za6", path: "Agent/Context Card" }],
      tasks: [],
      deliveries: [],
      git: [{ id: "HEAD", revision: "abc123" }],
    },
    parentActor: { kind: "role", id: "规划" },
    reviewer: { kind: "role", id: "规划" },
    assignee: { kind: "agentId", id: "grok-core-worker" },
    contextGeneration,
  };
  return buildTaskContextCard({
    ...base,
    ...overrides,
    contextGeneration: overrides?.contextGeneration ?? contextGeneration,
    refs: overrides?.refs ?? base.refs,
    scope: overrides?.scope ?? base.scope,
  });
}

// ---- schema / digests ----

test("contextGeneration is cg-v1-<sha256> and stable for identical inputs", () => {
  const a = sampleGeneration();
  const b = sampleGeneration();
  assert.equal(a, b);
  assert.ok(isContextGenerationId(a));
  assert.match(a, /^cg-v1-[a-f0-9]{64}$/);
});

test("contextGeneration changes when stable compatibility inputs change", () => {
  const base = sampleGeneration();
  const rosterChange = computeContextGeneration({
    workspaceIdentity: "ws-test",
    rulesPointerDigest: "rules-d1",
    agentsPointerDigest: "agents-d1",
    rolePrompt: "Stay in scope.",
    rosterAgentIds: ["coder", "reviewer", "new-agent"],
    tentTaskDigest: "task-skill-d1",
    profileAdapterCompatibility: profileAdapterCompatibilityDigest({
      profileId: "grok-core-worker",
      adapterId: "grok-acp",
    }),
  });
  const rulesChange = sampleGeneration("rules-bump");
  assert.notEqual(base, rosterChange);
  assert.notEqual(base, rulesChange);
});

test("taskDeltaDigest is independent of contextGeneration and tracks card+delta", () => {
  const card = sampleCard();
  const d1 = computeTaskDeltaDigest({ card, userPrompt: "do the work" });
  const d2 = computeTaskDeltaDigest({ card, userPrompt: "do the work" });
  const d3 = computeTaskDeltaDigest({
    card,
    userPrompt: "do the work",
    taskInputDelta: "## Review Feedback\nfix: fix tests",
  });
  assert.equal(d1, d2);
  assert.notEqual(d1, d3);
  assert.equal(d1.length, 64);
  assert.equal(card.taskDeltaDigest.length, 64);
});

test("canonicalJson sorts object keys for stable hashing", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 2 }, b: 1 })
  );
  assert.equal(sha256Hex("x"), formatContextGeneration("x").slice("cg-v1-".length));
});

test("buildTaskContextCard fail-loud: missing objective / acceptance / parent / reviewer", () => {
  const gen = sampleGeneration();
  assert.throws(
    () =>
      buildTaskContextCard({
        objective: "  ",
        acceptance: ["ok"],
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        assignee: { kind: "role", id: "r" },
        contextGeneration: gen,
      }),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "MISSING_OBJECTIVE"
  );
  assert.throws(
    () =>
      buildTaskContextCard({
        objective: "x",
        acceptance: [],
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        assignee: { kind: "role", id: "r" },
        contextGeneration: gen,
      }),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "MISSING_ACCEPTANCE"
  );
  assert.throws(
    () =>
      buildTaskContextCard({
        objective: "x",
        acceptance: ["a"],
        parentActor: undefined as never,
        reviewer: { kind: "user", id: "user" },
        assignee: { kind: "role", id: "r" },
        contextGeneration: gen,
      }),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "MISSING_PARENT_ACTOR"
  );
  assert.throws(
    () =>
      buildTaskContextCard({
        objective: "x",
        acceptance: ["a"],
        parentActor: { kind: "user", id: "user" },
        reviewer: undefined as never,
        assignee: { kind: "role", id: "r" },
        contextGeneration: gen,
      }),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "MISSING_REVIEWER"
  );
});

test("assertRefsResolved fail-loud on unresolved declared refs", () => {
  const card = sampleCard({
    refs: {
      nodes: [{ id: "cx-missing" }],
      tasks: [],
      deliveries: [],
      git: [],
    },
  });
  assert.throws(
    () =>
      assertRefsResolved(card, (kind, ref) => kind === "nodes" && ref.id === "cx-ok"),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "UNRESOLVED_REF"
  );
  assert.doesNotThrow(() =>
    assertRefsResolved(card, (kind, ref) => kind === "nodes" && ref.id === "cx-missing")
  );
});

test("parseTaskContextCard round-trips serialize shape", () => {
  const card = sampleCard();
  const wire = serializeTaskContextCardForFrontmatter(card);
  const parsed = parseTaskContextCard(wire);
  assert.equal(parsed.objective, card.objective);
  assert.equal(parsed.contextGeneration, card.contextGeneration);
  assert.deepEqual(parsed.frozenDecisions, card.frozenDecisions);
  assert.deepEqual(parsed.parentActor, card.parentActor);
  assert.deepEqual(parsed.assignee, card.assignee);
});

test("loadTaskContextCardFromFrontmatter: legacy null; partial fails; nested ok", () => {
  assert.equal(loadTaskContextCardFromFrontmatter({ type: "task", role: "r" }), null);
  // generation-only mirrors do not force a full card
  assert.equal(
    loadTaskContextCardFromFrontmatter({
      contextGeneration: sampleGeneration(),
      taskDeltaDigest: "a".repeat(64),
    }),
    null
  );
  assert.throws(
    () =>
      loadTaskContextCardFromFrontmatter({
        objective: "only objective",
      }),
    (err: unknown) => err instanceof TaskContextCardError
  );
  const card = sampleCard();
  const loaded = loadTaskContextCardFromFrontmatter({
    contextCard: serializeTaskContextCardForFrontmatter(card),
  });
  assert.equal(loaded?.contextGeneration, card.contextGeneration);
});

// ---- prompt ordering / cache ----

test("assembleManagedPrompt order: invariant → project → role → task → card → delta → checkpoint", () => {
  const card = sampleCard();
  const assembled = assembleManagedPrompt({
    workspaceRoot: "C:/ws",
    systemRoot: "C:/ws/.tent",
    rulesPointer: "RULES.md#d1",
    agentsPointer: "AGENTS.md#d1",
    tentRoleSection: "## Built-in skill: tent-role\n\nrole contract body",
    rolePromptRosterSection: "## Role prompt\n\nStay sharp.\n\n## Role roster\n\n- coder",
    tentTaskSection: "## Built-in skill: tent-task\n\ntask contract body",
    contextCard: card,
    taskPointers: "Task envelope: temp/x.md",
    userPrompt: "Implement the seam",
    taskInputDelta: "## Review Feedback\ntext: tighten tests",
    checkpoint: "Next: commit",
    includeStablePrefix: true,
  });

  assert.equal(assembled.includedStablePrefix, true);
  const text = assembled.text;
  const idx = (s: string) => {
    const i = text.indexOf(s);
    assert.ok(i >= 0, `missing section: ${s}`);
    return i;
  };
  const iInv = idx(MANAGED_BOOTSTRAP_INVARIANT);
  const iProj = idx("Tent stable project context v1");
  const iRoleSkill = idx("## Built-in skill: tent-role");
  const iRolePrompt = idx("## Role prompt");
  const iTaskSkill = idx("## Built-in skill: tent-task");
  const iCard = idx("Tent Task Context Card v1");
  const iUser = idx("## User Prompt");
  const iReview = idx("## Review Feedback");
  const iCp = idx("--- Role Checkpoint ---");
  assert.ok(iInv < iProj);
  assert.ok(iProj < iRoleSkill);
  assert.ok(iRoleSkill < iRolePrompt);
  assert.ok(iRolePrompt < iTaskSkill);
  assert.ok(iTaskSkill < iCard);
  assert.ok(iCard < iUser);
  assert.ok(iUser < iReview);
  assert.ok(iReview < iCp);
  assert.match(text, /contextGeneration: cg-v1-/);
  assert.match(formatTaskContextCardPrompt(card), /Core is authoritative/);
});

test("stable prefix injected once per generation; later Tasks append delta only", () => {
  const card = sampleCard();
  const gen = card.contextGeneration;
  assert.equal(
    shouldInjectStablePrefix({
      sessionContextGeneration: null,
      taskContextGeneration: gen,
    }),
    true
  );
  assert.equal(
    shouldInjectStablePrefix({
      sessionContextGeneration: gen,
      taskContextGeneration: gen,
    }),
    false
  );
  assert.equal(
    shouldInjectStablePrefix({
      sessionContextGeneration: gen,
      taskContextGeneration: sampleGeneration("other"),
    }),
    true
  );

  const full = assembleManagedPrompt({
    workspaceRoot: "/w",
    systemRoot: "/w/.tent",
    rulesPointer: "r",
    agentsPointer: "a",
    tentTaskSection: "## Built-in skill: tent-task\n\nbody",
    contextCard: card,
    userPrompt: "first",
    includeStablePrefix: true,
  });
  const delta = assembleManagedPrompt({
    workspaceRoot: "/w",
    systemRoot: "/w/.tent",
    rulesPointer: "r",
    agentsPointer: "a",
    tentTaskSection: "## Built-in skill: tent-task\n\nbody",
    contextCard: card,
    userPrompt: "second task",
    includeStablePrefix: false,
  });
  assert.ok(full.text.includes(MANAGED_BOOTSTRAP_INVARIANT));
  assert.ok(full.text.includes("## Built-in skill: tent-task"));
  assert.equal(delta.includedStablePrefix, false);
  assert.equal(delta.stablePrefix, "");
  assert.doesNotMatch(delta.text, new RegExp(MANAGED_BOOTSTRAP_INVARIANT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(delta.text, /## Built-in skill: tent-task/);
  assert.match(delta.text, /second task/);
  assert.match(delta.text, /Tent Task Context Card v1/);
  // Identical stable prefix bytes across two full assemblies with same generation inputs
  const full2 = assembleManagedPrompt({
    workspaceRoot: "/w",
    systemRoot: "/w/.tent",
    rulesPointer: "r",
    agentsPointer: "a",
    tentTaskSection: "## Built-in skill: tent-task\n\nbody",
    contextCard: card,
    userPrompt: "other user text",
    includeStablePrefix: true,
  });
  assert.equal(full.stablePrefix, full2.stablePrefix);
});

// ---- Session reuse gate (fail closed) ----

test("evaluateSessionReuseCompatibility allows only when all gates match", () => {
  const gen = sampleGeneration();
  const skills = skillsCompatibilityDigest(["tent-task", "tent-role"]);
  const base = {
    workspaceId: "ws-1",
    parentRoleId: "规划",
    agentId: "grok-core-worker",
    purpose: "implement",
    skillsDigest: skills,
    profileId: "grok-core-worker",
    adapterId: "grok-acp",
    contextGeneration: gen,
    worktree: "C:/wt/task-a",
  };
  const runtimeOk = {
    previousTurnSettled: true,
    noPendingInput: true,
    noPendingDelivery: true,
    exclusiveLease: true,
  };
  const ok = evaluateSessionReuseCompatibility({
    request: base,
    candidate: { ...base },
    runtime: runtimeOk,
  });
  assert.equal(ok.allowed, true);
  assert.deepEqual(ok.reasons, []);

  const genMismatch = evaluateSessionReuseCompatibility({
    request: base,
    candidate: { ...base, contextGeneration: sampleGeneration("x") },
    runtime: runtimeOk,
  });
  assert.equal(genMismatch.allowed, false);
  assert.ok(genMismatch.reasons.includes("context_generation_mismatch"));

  const busy = evaluateSessionReuseCompatibility({
    request: base,
    candidate: { ...base },
    runtime: { ...runtimeOk, previousTurnSettled: false, noPendingInput: false },
  });
  assert.equal(busy.allowed, false);
  assert.ok(busy.reasons.includes("previous_turn_not_settled"));
  assert.ok(busy.reasons.includes("pending_input"));

  const worktree = evaluateSessionReuseCompatibility({
    request: base,
    candidate: { ...base, worktree: "C:/wt/other" },
    runtime: runtimeOk,
  });
  assert.equal(worktree.allowed, false);
  assert.ok(worktree.reasons.includes("worktree_mismatch"));
});

test("projectAssigneeFromTask maps role vs agentProfile", () => {
  assert.deepEqual(projectAssigneeFromTask({ role: "规划", assigneeKind: "role" }), {
    kind: "role",
    id: "规划",
  });
  assert.deepEqual(
    projectAssigneeFromTask({ role: "grok-core-worker", assigneeKind: "agentProfile" }),
    { kind: "agentId", id: "grok-core-worker" }
  );
});

// ---- envelope persistence ----

test("Task envelope persists and reloads contextCard + digests", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cc-"));
  try {
    const nfs = new NodeFs(dir);
    const card = sampleCard();
    const taskPath = await writeTaskEnvelope(nfs, new SystemClock(), {
      role: "grok-core-worker",
      assigneeKind: "agentProfile",
      claims: [{ id: "cx-5q6za6", path: "n" }],
      manifestPath: "temp/agent-profiles/grok-core-worker/manifests/tk-x.yml",
      userPrompt: "Implement Context Card",
      parentActor: { kind: "role", id: "规划" },
    });
    await patchTaskEnvelope(nfs, taskPath, { contextCard: card });
    const loaded = await loadTaskEnvelope(nfs, taskPath);
    assert.ok(loaded.contextCard);
    assert.equal(loaded.contextCard?.objective, card.objective);
    assert.equal(loaded.contextGeneration, card.contextGeneration);
    assert.equal(loaded.taskDeltaDigest, card.taskDeltaDigest);
    assert.equal(loaded.contextCard?.parentActor.id, "规划");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("partial context card body on disk fails loud at load", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cc-bad-"));
  try {
    const nfs = new NodeFs(dir);
    const taskPath = await writeTaskEnvelope(nfs, new SystemClock(), {
      role: "analyst",
      claims: [{ id: "bx-1", path: "p" }],
      manifestPath: "temp/analyst/manifest.yml",
      userPrompt: "x",
      parentActor: { kind: "user", id: "user" },
    });
    // Corrupt: objective without full card
    const raw = await nfs.readFile(taskPath);
    const broken = raw.replace(
      "deliveryPolicy: review",
      "deliveryPolicy: review\nobjective: half card only"
    );
    await nfs.writeFile(taskPath, broken);
    await assert.rejects(
      () => loadTaskEnvelope(nfs, taskPath),
      (err: unknown) => err instanceof TaskContextCardError
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


// ---- stable prefix decision (no prompt-memory) ----

test("decideStablePrefixInjection omits only on exact valid generation match", () => {
  const gen = sampleGeneration();
  assert.equal(
    decideStablePrefixInjection({ taskContextGeneration: gen }).includeStablePrefix,
    true
  );
  assert.equal(
    decideStablePrefixInjection({
      sessionContextGeneration: gen,
      taskContextGeneration: gen,
    }).includeStablePrefix,
    false
  );
  assert.equal(
    decideStablePrefixInjection({
      sessionContextGeneration: "not-a-generation",
      taskContextGeneration: gen,
    }).includeStablePrefix,
    true
  );
  assert.equal(
    shouldInjectStablePrefix({
      sessionContextGeneration: gen,
      taskContextGeneration: gen,
    }),
    false
  );
});

test("projectAssigneeFromTask prefers logical agentId over profile label", () => {
  assert.deepEqual(
    projectAssigneeFromTask({
      role: "grok-core-worker",
      assigneeKind: "agentProfile",
      agentId: "coder",
    }),
    { kind: "agentId", id: "coder" }
  );
});

test("projectExecutionLaneFromTask derives from Task truth", () => {
  const lane = projectExecutionLaneFromTask({
    roleBranchBase: "abc123base",
    targetBranch: "tent-role/规划",
    branch: "tent-task/tk-x",
    worktree: "C:/wt",
    parentActor: { kind: "role", id: "规划" },
    reviewer: { kind: "role", id: "规划" },
  });
  assert.equal(lane?.baseCommit, "abc123base");
  assert.equal(lane?.targetBranch, "tent-role/规划");
  assert.equal(lane?.integrationAuthority?.mutator, "service");
  assert.equal(lane?.integrationAuthority?.actor.id, "规划");
  assert.deepEqual(
    buildIntegrationAuthority({ kind: "user", id: "user" }),
    { actor: { kind: "user", id: "user" }, mutator: "service" }
  );
});

// ---- pure history gate ----

test("assertOrdinaryExecutorLaneHistory accepts linear single-parent range", () => {
  assert.doesNotThrow(() =>
    assertOrdinaryExecutorLaneHistory({
      baseCommit: "base",
      tipCommit: "c2",
      commits: [
        { sha: "c1", parents: ["base"] },
        { sha: "c2", parents: ["c1"] },
      ],
    })
  );
  assert.doesNotThrow(() =>
    assertOrdinaryExecutorLaneHistory({
      baseCommit: "base",
      tipCommit: "base",
      commits: [],
    })
  );
});

test("assertOrdinaryExecutorLaneHistory fails loud on merge commit (executor-merges-parent)", () => {
  assert.throws(
    () =>
      assertOrdinaryExecutorLaneHistory({
        baseCommit: "base",
        tipCommit: "merge",
        commits: [
          { sha: "c1", parents: ["base"] },
          // Executor merged parent branch into task tip — unauthorized.
          { sha: "merge", parents: ["c1", "parent-tip"] },
        ],
      }),
    (err) =>
      err instanceof ExecutorLaneHistoryError && err.code === "MERGE_COMMIT"
  );
});

test("assertOrdinaryExecutorLaneHistory fails when base is not first parent", () => {
  assert.throws(
    () =>
      assertOrdinaryExecutorLaneHistory({
        baseCommit: "recorded-base",
        tipCommit: "c1",
        commits: [{ sha: "c1", parents: ["other-parent"] }],
      }),
    (err) =>
      err instanceof ExecutorLaneHistoryError &&
      err.code === "BASE_NOT_FIRST_PARENT"
  );
});

// ---- real git: executor merges parent must fail Delivery history gate ----

function gitRun(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || args.join(" "));
  return (r.stdout || "").trim();
}

test("real git: executor-merges-parent regression fails history gate", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-hist-gate-"));
  try {
    gitRun(dir, ["init"]);
    gitRun(dir, ["config", "user.email", "test@tent.local"]);
    gitRun(dir, ["config", "user.name", "Tent Test"]);
    await fs.writeFile(path.join(dir, "README.md"), "base\n".replace("\\n", "\n"));
    gitRun(dir, ["add", "README.md"]);
    gitRun(dir, ["commit", "-m", "base"]);
    const base = gitRun(dir, ["rev-parse", "HEAD"]);
    gitRun(dir, ["branch", "-M", "main"]);
    gitRun(dir, ["branch", "tent-role/parent"]);
    gitRun(dir, ["checkout", "-b", "tent-task/tk-hist"]);
    await fs.writeFile(path.join(dir, "task.txt"), "work\n".replace("\\n", "\n"));
    gitRun(dir, ["add", "task.txt"]);
    gitRun(dir, ["commit", "-m", "task work"]);
    gitRun(dir, ["checkout", "tent-role/parent"]);
    await fs.writeFile(path.join(dir, "parent.txt"), "parent advance\n".replace("\\n", "\n"));
    gitRun(dir, ["add", "parent.txt"]);
    gitRun(dir, ["commit", "-m", "parent advance"]);
    gitRun(dir, ["checkout", "tent-task/tk-hist"]);
    const merge = spawnSync(
      "git",
      ["merge", "--no-ff", "-m", "executor merges parent", "tent-role/parent"],
      { cwd: dir, encoding: "utf8", windowsHide: true }
    );
    if (merge.status !== 0) throw new Error(merge.stderr || merge.stdout || "merge failed");
    const tip = gitRun(dir, ["rev-parse", "HEAD"]);
    const parentCount =
      gitRun(dir, ["rev-list", "--parents", "-n", "1", tip]).split(/\s+/).length - 1;
    assert.ok(parentCount >= 2, "tip must be merge commit");
    await assert.rejects(
      () =>
        assertOrdinaryExecutorLaneHistoryInGit({
          workspace: dir,
          baseCommit: base,
          tipCommit: tip,
          branch: "tent-task/tk-hist",
        }),
      (err: unknown) =>
        // Merge tip brings foreign parent-branch commits into base..tip and/or a
        // multi-parent commit — both must refuse ready Delivery (no allowMerge).
        err instanceof ExecutorLaneHistoryError &&
        (err.code === "MERGE_COMMIT" || err.code === "FOREIGN_ANCESTRY")
    );
    gitRun(dir, ["checkout", "-b", "tent-task/tk-linear", base]);
    await fs.writeFile(path.join(dir, "linear.txt"), "ok\n".replace("\\n", "\n"));
    gitRun(dir, ["add", "linear.txt"]);
    gitRun(dir, ["commit", "-m", "linear task"]);
    const linearTip = gitRun(dir, ["rev-parse", "HEAD"]);
    await assert.doesNotReject(() =>
      assertOrdinaryExecutorLaneHistoryInGit({
        workspace: dir,
        baseCommit: base,
        tipCommit: linearTip,
      })
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
