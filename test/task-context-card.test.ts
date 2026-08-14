/**
 * P0 Core/Runtime: Task Context Card v2 + prompt assembly + Session reuse gate
 * (Node cx-5q6za6).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  assembleManagedPrompt,
  buildTaskContextCard,
  canonicalJson,
  computeContextGeneration,
  formatContextGeneration,
  formatTaskPackage,
  formatTaskContextCardPrompt,
  isContextGenerationId,
  loadTaskContextCardFromFrontmatter,
  MANAGED_BOOTSTRAP_INVARIANT,
  parseTaskContextCard,
  connectionAdapterCompatibilityDigest,
  serializeTaskContextCardForFrontmatter,
  sha256Hex,
  shouldInjectStablePrefix,
  decideStablePrefixInjection,
  TaskContextCardError,
  assertOrdinaryExecutorLaneHistory,
  ExecutorLaneHistoryError,
  projectExecutionLaneFromTask,
  deriveIntegrationAuthority,
  assertIntegrationAuthorityMatchesParent,
  type TaskContextCard,
} from "../src/core/task-context-card.js";
import { taskPackageForTask } from "../src/core/task.js";
import { assertOrdinaryExecutorLaneHistoryInGit } from "../src/core/workspace.js";
import { spawnSync } from "node:child_process";

function sampleGeneration(extra?: string): string {
  return computeContextGeneration({
    workspaceIdentity: "ws-test",
    agentsPointerDigest: "agents-d1",
    tentRoleDigest: "role-skill-d1",
    rolePrompt: "Stay in scope.",
    tentTaskDigest: "task-skill-d1",
    connectionAdapterCompatibility: connectionAdapterCompatibilityDigest({
      connectionId: "grok-core-worker",
      adapterId: "grok-acp",
    }),
    extraStable: extra ? { note: extra } : undefined,
  });
}

function sampleCard(
  overrides?: Partial<Parameters<typeof buildTaskContextCard>[0]>
): TaskContextCard {
  const contextGeneration = overrides?.contextGeneration ?? sampleGeneration();
  const base: Parameters<typeof buildTaskContextCard>[0] = {
    workNodeIds: ["cx-5q6za6"],
    contextNodeIds: ["cx-context"],
    nodeSnapshots: [
      {
        id: "cx-5q6za6",
        path: "Agent/Context Card",
        type: "prompt",
        tags: ["core"],
        body: "Implement the Context Card core seam.",
        etag: "a".repeat(24),
      },
      {
        id: "cx-context",
        path: "Agent/Context",
        type: "reference",
        tags: ["context"],
        body: "Core is authoritative.",
        etag: "b".repeat(24),
      },
    ],
    contextGeneration,
  };
  return buildTaskContextCard({
    ...base,
    ...overrides,
    contextGeneration: overrides?.contextGeneration ?? contextGeneration,
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
  const rolePromptChange = computeContextGeneration({
    workspaceIdentity: "ws-test",
    agentsPointerDigest: "agents-d1",
    rolePrompt: "Stay in scope, precisely.",
    tentTaskDigest: "task-skill-d1",
    connectionAdapterCompatibility: connectionAdapterCompatibilityDigest({
      connectionId: "grok-core-worker",
      adapterId: "grok-acp",
    }),
  });
  const rulesChange = sampleGeneration("rules-bump");
  assert.notEqual(base, rolePromptChange);
  assert.notEqual(base, rulesChange);
});

test("contextGeneration excludes taskId/objective and strips forbidden extraStable keys", () => {
  const a = computeContextGeneration({
    workspaceIdentity: "ws-test",
    agentsPointerDigest: "agents-d1",
    tentTaskDigest: "task-skill-d1",
    connectionAdapterCompatibility: connectionAdapterCompatibilityDigest({
      connectionId: "p",
      adapterId: "a",
    }),
    extraStable: { executionKind: "session", note: "stable" },
  });
  const b = computeContextGeneration({
    workspaceIdentity: "ws-test",
    agentsPointerDigest: "agents-d1",
    tentTaskDigest: "task-skill-d1",
    connectionAdapterCompatibility: connectionAdapterCompatibilityDigest({
      connectionId: "p",
      adapterId: "a",
    }),
    extraStable: {
      executionKind: "session",
      note: "stable",
      taskId: "tk-different",
      objective: "should not matter",
      acceptance: "nope",
      taskPath: "temp/x.md",
    },
  });
  assert.equal(a, b, "taskId/objective must not affect contextGeneration");
});

test("contextGeneration changes when a skill version changes", () => {
  const base = computeContextGeneration({
    workspaceIdentity: "ws",
    agentsPointerDigest: "ag",
    tentTaskDigest: "body",
    tentTaskVersion: "0.1.0",
  });
  const versionBump = computeContextGeneration({
    workspaceIdentity: "ws",
    agentsPointerDigest: "ag",
    tentTaskDigest: "body",
    tentTaskVersion: "0.2.0",
  });
  assert.notEqual(base, versionBump);
});

test("canonicalJson sorts object keys for stable hashing", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 2 }, b: 1 })
  );
  assert.equal(sha256Hex("x"), formatContextGeneration("x").slice("cg-v1-".length));
});

test("buildTaskContextCard requires Node context and rejects retired v1 fields", () => {
  const gen = sampleGeneration();
  const card = sampleCard({ contextGeneration: gen });
  assert.deepEqual(card.workNodeIds, ["cx-5q6za6"]);
  assert.deepEqual(card.contextNodeIds, ["cx-context"]);
  assert.throws(
    () => buildTaskContextCard({
      ...(card as unknown as Record<string, unknown>),
      objective: "retired",
    } as never),
    (err: unknown) => err instanceof TaskContextCardError && err.code === "INVALID_CARD"
  );
  assert.throws(
    () => buildTaskContextCard({
      workNodeIds: card.workNodeIds,
      contextNodeIds: card.contextNodeIds,
      nodeSnapshots: card.nodeSnapshots,
      contextGeneration: "bad",
    }),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "INVALID_GENERATION"
  );
});

test("parseTaskContextCard rejects retired v1 mirrors and malformed snapshots", () => {
  assert.throws(
    () => parseTaskContextCard({ ...sampleCard(), objective: "retired" }),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "INVALID_CARD"
  );
  assert.throws(
    () => parseTaskContextCard({ ...sampleCard(), nodeSnapshots: [] }),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "INVALID_CARD"
  );
});

test("parseTaskContextCard round-trips serialize shape", () => {
  const card = sampleCard();
  const wire = serializeTaskContextCardForFrontmatter(card);
  const parsed = parseTaskContextCard(wire);
  assert.deepEqual(parsed.workNodeIds, card.workNodeIds);
  assert.deepEqual(parsed.nodeSnapshots, card.nodeSnapshots);
  assert.equal(parsed.contextGeneration, card.contextGeneration);
  assert.equal("objective" in wire, false);
  assert.equal("acceptance" in wire, false);
  assert.equal("refs" in wire, false);
});

test("loadTaskContextCardFromFrontmatter reads only the nested card wire", () => {
  assert.equal(loadTaskContextCardFromFrontmatter({ type: "task", role: "r" }), null);
  // Flat mirrors do not force or supplement a full card.
  assert.equal(
    loadTaskContextCardFromFrontmatter({
      contextGeneration: sampleGeneration(),
      taskDeltaDigest: "a".repeat(64),
    }),
    null
  );
  assert.equal(
    loadTaskContextCardFromFrontmatter({ objective: "flat mirror is ignored" }),
    null
  );
  const card = sampleCard();
  const loaded = loadTaskContextCardFromFrontmatter({
    contextCard: serializeTaskContextCardForFrontmatter(card),
  });
  assert.equal(loaded?.contextGeneration, card.contextGeneration);
  assert.deepEqual(loaded?.workNodeIds, card.workNodeIds);
});

// ---- prompt ordering / cache ----

test("assembleManagedPrompt order: invariant → project → role → task → card → delta", () => {
  const card = sampleCard();
  const taskPackage = formatTaskPackage({
    contextCard: card,
    taskPointers: "Task record: temp/x.md",
    prompt: "Implement the seam",
  });
  const assembled = assembleManagedPrompt({
    workspaceRoot: "C:/ws",
    systemRoot: "C:/ws/.tent",
    agentsPointer: "AGENTS.md#d1",
    tentRoleSection: "## Built-in skill: tent-role\n\nrole contract body",
    rolePromptSection: "## Role prompt\n\nStay sharp.",
    tentTaskSection: "## Built-in skill: tent-task\n\ntask contract body",
    contextGeneration: sampleGeneration(),
    taskPackage,
    dynamicWrapper: "## Review Feedback\ntext: tighten tests",
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
  const iCard = idx("Tent Task Context Card v2");
  const iUser = idx("## Prompt");
  const iReview = idx("## Review Feedback");
  assert.ok(iInv < iProj);
  assert.ok(iProj < iRoleSkill);
  assert.ok(iRoleSkill < iRolePrompt);
  assert.ok(iRolePrompt < iTaskSkill);
  assert.ok(iTaskSkill < iCard);
  assert.ok(iCard < iUser);
  assert.ok(iUser < iReview);
  assert.equal(assembled.taskPackage, taskPackage);
  assert.doesNotMatch(text, /contextGeneration: cg-v1-/);
  assert.match(formatTaskContextCardPrompt(card), /Work Node cx-5q6za6/);
});

test("stable prefix injected once per generation; later Tasks append delta only", () => {
  const gen = sampleGeneration();
  const card = sampleCard({ contextGeneration: gen });
  assert.equal(
    shouldInjectStablePrefix({
      sessionContextGeneration: null,
      currentContextGeneration: gen,
    }),
    true
  );
  assert.equal(
    shouldInjectStablePrefix({
      sessionContextGeneration: gen,
      currentContextGeneration: gen,
    }),
    false
  );
  assert.equal(
    shouldInjectStablePrefix({
      sessionContextGeneration: gen,
      currentContextGeneration: sampleGeneration("other"),
    }),
    true
  );

  const full = assembleManagedPrompt({
    workspaceRoot: "/w",
    systemRoot: "/w/.tent",
    agentsPointer: "a",
    tentTaskSection: "## Built-in skill: tent-task\n\nbody",
    contextGeneration: gen,
    taskPackage: formatTaskPackage({
      contextCard: card,
      prompt: "first",
    }),
    includeStablePrefix: true,
  });
  const delta = assembleManagedPrompt({
    workspaceRoot: "/w",
    systemRoot: "/w/.tent",
    agentsPointer: "a",
    tentTaskSection: "## Built-in skill: tent-task\n\nbody",
    contextGeneration: gen,
    taskPackage: formatTaskPackage({
      contextCard: card,
      prompt: "second task",
    }),
    includeStablePrefix: false,
  });
  assert.ok(full.text.includes(MANAGED_BOOTSTRAP_INVARIANT));
  assert.ok(full.text.includes("## Built-in skill: tent-task"));
  assert.equal(delta.includedStablePrefix, false);
  assert.equal(delta.stablePrefix, "");
  assert.doesNotMatch(delta.text, new RegExp(MANAGED_BOOTSTRAP_INVARIANT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(delta.text, /## Built-in skill: tent-task/);
  assert.match(delta.text, /second task/);
  assert.match(delta.text, /Tent Task Context Card v2/);
  // Identical stable prefix bytes across two full assemblies with same generation inputs
  const full2 = assembleManagedPrompt({
    workspaceRoot: "/w",
    systemRoot: "/w/.tent",
    agentsPointer: "a",
    tentTaskSection: "## Built-in skill: tent-task\n\nbody",
    contextGeneration: gen,
    taskPackage: formatTaskPackage({
      contextCard: card,
      prompt: "other user text",
    }),
    includeStablePrefix: true,
  });
  assert.equal(full.stablePrefix, full2.stablePrefix);
});

test("prompt-only managed context emits the immutable user prompt once", () => {
  const marker = "PROMPT_ONLY_MARKER";
  const card = sampleCard({ contextGeneration: sampleGeneration() });
  const assembled = assembleManagedPrompt({
    workspaceRoot: "/w",
    systemRoot: "/w/.tent",
    agentsPointer: "AGENTS.md",
    contextGeneration: sampleGeneration(),
    taskPackage: formatTaskPackage({
      contextCard: card,
      prompt: marker,
    }),
  });
  assert.equal(assembled.text.split(marker).length - 1, 1);
  assert.match(assembled.dynamicDelta, /workNodeIds: cx-5q6za6/);
  assert.doesNotMatch(assembled.dynamicDelta, /^objective:/m);
  assert.doesNotMatch(assembled.dynamicDelta, /^acceptance:/m);
});

test("canonical Task Package bytes are deterministic and preserve work-then-context snapshot order", () => {
  const workA = {
    id: "cx-worka",
    path: "Work/A",
    type: "prompt",
    tags: ["work"],
    body: "WORK_A",
    etag: "1".repeat(24),
  };
  const workB = {
    id: "cx-workb",
    path: "Work/B",
    type: "prompt",
    tags: ["work"],
    body: "WORK_B",
    etag: "2".repeat(24),
  };
  const ctxA = {
    id: "cx-contexta",
    path: "Context/A",
    type: "reference",
    tags: ["context"],
    body: "CTX_A",
    etag: "3".repeat(24),
  };
  const ctxB = {
    id: "cx-contextb",
    path: "Context/B",
    type: "reference",
    tags: ["context"],
    body: "CTX_B",
    etag: "4".repeat(24),
  };
  const prompt = "Ship the exact package";
  const orderedCard = buildTaskContextCard({
    workNodeIds: [workB.id, workA.id],
    contextNodeIds: [ctxB.id, ctxA.id],
    nodeSnapshots: [workB, workA, ctxB, ctxA],
    contextGeneration: sampleGeneration("ordered"),
  });
  const taskBase = {
    path: "temp/roles/rl-reviewer/tasks/task.md",
    manifest: "temp/roles/rl-reviewer/manifests/tk-demo.yml",
    acceptMode: "review-required" as const,
    requester: { kind: "user" as const, id: "user" },
    state: "queued" as const,
    assigneeRoleId: "rl-reviewer",
    workNodeIds: [workB.id, workA.id],
    contextNodeIds: [ctxB.id, ctxA.id],
    nodeSnapshots: [workB, workA, ctxB, ctxA],
    contextCard: orderedCard,
    prompt,
  };
  const sameBytesA = taskPackageForTask(taskBase);
  const sameBytesB = taskPackageForTask({ ...taskBase });
  assert.equal(sameBytesA, sameBytesB);
  const workBIndex = sameBytesA.indexOf("Work/B");
  const workAIndex = sameBytesA.indexOf("Work/A");
  const ctxBIndex = sameBytesA.indexOf("Context/B");
  const ctxAIndex = sameBytesA.indexOf("Context/A");
  assert.ok(workBIndex >= 0 && workAIndex >= 0 && ctxBIndex >= 0 && ctxAIndex >= 0);
  assert.ok(workBIndex < workAIndex, "work snapshots must keep supplied work order");
  assert.ok(workAIndex < ctxBIndex, "all work snapshots must precede context snapshots");
  assert.ok(ctxBIndex < ctxAIndex, "context snapshots must keep supplied context order");

  const swappedOrderCard = buildTaskContextCard({
    workNodeIds: [workA.id, workB.id],
    contextNodeIds: [ctxA.id, ctxB.id],
    nodeSnapshots: [workA, workB, ctxA, ctxB],
    contextGeneration: sampleGeneration("ordered"),
  });
  const swapped = taskPackageForTask({
    ...taskBase,
    workNodeIds: [workA.id, workB.id],
    contextNodeIds: [ctxA.id, ctxB.id],
    nodeSnapshots: [workA, workB, ctxA, ctxB],
    contextCard: swappedOrderCard,
  });
  assert.notEqual(swapped, sameBytesA);

  const differentGeneration = taskPackageForTask({
    ...taskBase,
    contextCard: buildTaskContextCard({
      workNodeIds: [workB.id, workA.id],
      contextNodeIds: [ctxB.id, ctxA.id],
      nodeSnapshots: [workB, workA, ctxB, ctxA],
      contextGeneration: sampleGeneration("different-generation-only"),
    }),
  });
  assert.equal(
    differentGeneration,
    sameBytesA,
    "contextGeneration is host compatibility metadata and must not affect canonical package bytes"
  );
});

test("managed assembly preserves exact canonical Task Package bytes and keeps delta outside it", () => {
  const taskPackage = "--- Tent Task Package ---\nTask record: temp/x.md\n\n## Prompt\n\nship exact bytes\n";
  const assembled = assembleManagedPrompt({
    workspaceRoot: "/w",
    systemRoot: "/w/.tent",
    agentsPointer: "AGENTS.md",
    contextGeneration: sampleGeneration(),
    taskPackage,
    dynamicWrapper: "## Review Feedback\ntext: keep outside package",
    includeStablePrefix: false,
  });
  assert.equal(assembled.taskPackage, taskPackage);
  assert.ok(assembled.dynamicDelta.startsWith(taskPackage));
  assert.ok(assembled.dynamicDelta.includes("## Review Feedback"));
});

// ---- envelope persistence ----


// ---- stable prefix decision (no prompt-memory) ----

test("decideStablePrefixInjection omits only on exact valid generation match", () => {
  const gen = sampleGeneration();
  assert.equal(
    decideStablePrefixInjection({ currentContextGeneration: gen }).includeStablePrefix,
    true
  );
  assert.equal(
    decideStablePrefixInjection({
      sessionContextGeneration: gen,
      currentContextGeneration: gen,
    }).includeStablePrefix,
    false
  );
  assert.equal(
    decideStablePrefixInjection({
      sessionContextGeneration: "not-a-generation",
      currentContextGeneration: gen,
    }).includeStablePrefix,
    true
  );
  assert.equal(
    shouldInjectStablePrefix({
      sessionContextGeneration: gen,
      currentContextGeneration: gen,
    }),
    false
  );
});

test("projectExecutionLaneFromTask uses exact baseCommit only; derives authority from requester", () => {
  const lane = projectExecutionLaneFromTask({
    baseCommit: "abc123base",
    targetBranch: "tent-role/规划",
    branch: "tent-task/tk-x",
    worktree: "C:/wt",
    requester: { kind: "role", id: "规划" },
  });
  assert.equal(lane?.baseCommit, "abc123base");
  assert.equal(lane?.targetBranch, "tent-role/规划");
  assert.equal(lane?.integrationAuthority?.mutator, "service");
  assert.equal(lane?.integrationAuthority?.actor.id, "规划");
  // roleBranchBase is not a baseCommit substitute — omitted baseCommit stays empty.
  const noBase = projectExecutionLaneFromTask({
    targetBranch: "tent-role/规划",
    branch: "tent-task/tk-x",
    requester: { kind: "role", id: "规划" },
  });
  assert.equal(noBase?.baseCommit, undefined);
  assert.equal(noBase?.integrationAuthority?.mutator, "service");
  assert.deepEqual(
    deriveIntegrationAuthority({
      requester: { kind: "user", id: "user" },
    }),
    { actor: { kind: "user", id: "user" }, mutator: "service" }
  );
});

test("projectExecutionLaneFromTask fails loud on invalid requester", () => {
  assert.throws(
    () =>
      projectExecutionLaneFromTask({
        baseCommit: "abc",
        requester: { kind: "user", id: "not-user" },
      }),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "INVALID_ACTOR"
  );
});

test("assertIntegrationAuthorityMatchesParent rejects arbitrary Task-supplied authority", () => {
  const parent = { kind: "role" as const, id: "规划" };
  assert.doesNotThrow(() =>
    assertIntegrationAuthorityMatchesParent(
      { actor: parent, mutator: "service" },
      parent
    )
  );
  assert.throws(
    () =>
      assertIntegrationAuthorityMatchesParent(
        { actor: { kind: "role", id: "forged" }, mutator: "service" },
        parent
      ),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "INVALID_ACTOR"
  );
  assert.throws(
    () =>
      assertIntegrationAuthorityMatchesParent(
        { actor: parent, mutator: "executor" },
        parent
      ),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "INVALID_ACTOR"
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

// ---- real git: executor merges parent must fail TaskResult history gate ----

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
        // multi-parent commit — both must refuse ready TaskResult (no allowMerge).
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
