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
  formatContextGeneration,
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
  type TaskContextCardV1,
} from "../src/core/task-context-card.js";
import {
  loadTaskEnvelope,
  patchTaskEnvelope,
  writeTaskEnvelope,
  workspaceLaneOf,
} from "../src/core/task.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
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

test("buildTaskContextCard keeps objective and acceptance optional", () => {
  const gen = sampleGeneration();
  const card = buildTaskContextCard({ contextGeneration: gen });
  assert.equal(card.objective, "");
  assert.deepEqual(card.acceptance, []);
  assert.throws(
    () => buildTaskContextCard({ contextGeneration: "bad" }),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "INVALID_GENERATION"
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
  assert.equal("parentActor" in wire, false);
  assert.equal("reviewer" in wire, false);
  assert.equal("assignee" in wire, false);
});

test("loadTaskContextCardFromFrontmatter reads only the nested card wire", () => {
  assert.equal(loadTaskContextCardFromFrontmatter({ type: "task", role: "r" }), null);
  // generation-only mirrors do not force a full card
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
});

// ---- prompt ordering / cache ----

test("assembleManagedPrompt order: invariant → project → role → task → card → delta → checkpoint", () => {
  const card = sampleCard();
  const assembled = assembleManagedPrompt({
    workspaceRoot: "C:/ws",
    systemRoot: "C:/ws/.tent",
    agentsPointer: "AGENTS.md#d1",
    tentRoleSection: "## Built-in skill: tent-role\n\nrole contract body",
    rolePromptSection: "## Role prompt\n\nStay sharp.",
    tentTaskSection: "## Built-in skill: tent-task\n\ntask contract body",
    contextCard: card,
    contextGeneration: sampleGeneration(),
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
    contextCard: card,
    contextGeneration: gen,
    userPrompt: "first",
    includeStablePrefix: true,
  });
  const delta = assembleManagedPrompt({
    workspaceRoot: "/w",
    systemRoot: "/w/.tent",
    agentsPointer: "a",
    tentTaskSection: "## Built-in skill: tent-task\n\nbody",
    contextCard: card,
    contextGeneration: gen,
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
    agentsPointer: "a",
    tentTaskSection: "## Built-in skill: tent-task\n\nbody",
    contextCard: card,
    contextGeneration: gen,
    userPrompt: "other user text",
    includeStablePrefix: true,
  });
  assert.equal(full.stablePrefix, full2.stablePrefix);
});

test("prompt-only managed context emits the immutable user prompt once", () => {
  const marker = "PROMPT_ONLY_MARKER";
  const card = buildTaskContextCard({ contextGeneration: sampleGeneration() });
  const assembled = assembleManagedPrompt({
    workspaceRoot: "/w",
    systemRoot: "/w/.tent",
    agentsPointer: "AGENTS.md",
    contextCard: card,
    contextGeneration: sampleGeneration(),
    userPrompt: marker,
  });
  assert.equal(assembled.text.split(marker).length - 1, 1);
  assert.doesNotMatch(assembled.dynamicDelta, /^objective:/m);
  assert.doesNotMatch(assembled.dynamicDelta, /^acceptance:/m);
});

// ---- envelope persistence ----

test("Task envelope persists and reloads contextCard + digests", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cc-"));
  try {
    const nfs = new NodeFs(dir);
    const card = sampleCard();
    const taskPath = await writeTaskEnvelope(nfs, new SystemClock(), {
      sessionId: "ss-grokcoreworker",
      nodeRefs: [{ id: "cx-5q6za6", path: "n" }],
      manifestPath: "temp/sessions/ss-grokcoreworker/manifests/tk-x.yml",
      userPrompt: "Implement Context Card",
      parentActor: { kind: "role", id: "规划" },
    });
    const initial = parseFrontmatter(await nfs.readFile(taskPath));
    const initialCard = initial.data.contextCard as Record<string, unknown>;
    assert.equal(initial.data.contextGeneration, undefined);
    assert.equal(initial.data.taskDeltaDigest, undefined);
    assert.equal(initialCard.parentActor, undefined);
    assert.equal(initialCard.reviewer, undefined);
    assert.equal(initialCard.assignee, undefined);
    assert.equal(initialCard.objective, "");
    assert.deepEqual(initialCard.acceptance, []);
    assert.equal(initial.body.split("Implement Context Card").length - 1, 1);
    await patchTaskEnvelope(nfs, taskPath, { contextCard: card });
    const patched = parseFrontmatter(await nfs.readFile(taskPath));
    assert.equal(patched.data.contextGeneration, undefined);
    assert.equal(patched.data.taskDeltaDigest, undefined);
    const loaded = await loadTaskEnvelope(nfs, taskPath);
    assert.ok(loaded.contextCard);
    assert.equal(loaded.contextCard?.objective, card.objective);
    assert.equal(loaded.taskDeltaDigest, card.taskDeltaDigest);
    assert.deepEqual(loaded.parentActor, { kind: "role", id: "规划" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Task sessionId is canonical at write and load boundaries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-session-binding-"));
  try {
    const nfs = new NodeFs(dir);
    await assert.rejects(
      () =>
        writeTaskEnvelope(nfs, new SystemClock(), {
          sessionId: "Bad Session",
          nodeRefs: [{ id: "cx-5q6za6", path: "n" }],
          manifestPath: "temp/sessions/bad/manifests/tk-x.yml",
          userPrompt: "invalid Session binding",
          parentActor: { kind: "user", id: "user" },
        }),
      /sessionId/i
    );

    const taskPath = await writeTaskEnvelope(nfs, new SystemClock(), {
      sessionId: "ss-grokcoreworker",
      nodeRefs: [{ id: "cx-5q6za6", path: "n" }],
      manifestPath: "temp/sessions/ss-grokcoreworker/manifests/tk-x.yml",
      userPrompt: "tamper Session binding",
      parentActor: { kind: "user", id: "user" },
    });
    const raw = await nfs.readFile(taskPath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    data.sessionId = "bad/session";
    await nfs.writeFile(taskPath, serializeFrontmatter(data, body, keyOrder));
    await assert.rejects(
      () => loadTaskEnvelope(nfs, taskPath),
      /sessionId/i
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("missing nested contextCard fails loud even when flat mirrors exist", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cc-bad-"));
  try {
    const nfs = new NodeFs(dir);
    const taskPath = await writeTaskEnvelope(nfs, new SystemClock(), {
      roleId: "rl-analyst",
      nodeRefs: [{ id: "cx-1", path: "p" }],
      manifestPath: "temp/roles/rl-analyst/manifest.yml",
      userPrompt: "x",
      parentActor: { kind: "user", id: "user" },
    });
    // Corrupt: strip the sole nested wire and leave a retired flat mirror.
    const raw = await nfs.readFile(taskPath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    delete data.contextCard;
    delete data.contextGeneration;
    delete data.taskDeltaDigest;
    data.objective = "half card only";
    await nfs.writeFile(taskPath, serializeFrontmatter(data, body, keyOrder));
    await assert.rejects(
      () => loadTaskEnvelope(nfs, taskPath),
      /missing Task\.contextCard\.refs\.nodes/i
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * P0 persistence: recorded lane truth for baseCommit + integrationAuthority.
 * - Missing on-disk authority must NOT invent an in-memory phantom on load
 *   (so ensureTaskWorkspaceLane can detect absence and persist).
 * - Explicit backfill writes canonical bag; reload retains/validates.
 * - Tampered actor/mutator fails loud.
 * - Context projection may still derive without inventing envelope truth.
 */
test("lane authority: no phantom on load; persist/reload/tamper/backfill", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-lane-auth-"));
  try {
    const nfs = new NodeFs(dir);
    await nfs.mkdir("temp/sessions/ss-grokcoreworker/tasks");
    const parent = { kind: "role" as const, id: "规划" };
    const taskPath = await writeTaskEnvelope(nfs, new SystemClock(), {
      sessionId: "ss-grokcoreworker",
      nodeRefs: [{ id: "cx-5q6za6", path: "n" }],
      manifestPath: "temp/sessions/ss-grokcoreworker/manifests/tk-x.yml",
      userPrompt: "lane authority",
      parentActor: parent,
      reviewer: parent,
    });

    // Fresh write has parent/reviewer but no recorded baseCommit / integrationAuthority.
    const raw0 = await nfs.readFile(taskPath);
    const fm0 = parseFrontmatter(raw0);
    assert.equal(fm0.data.integrationAuthority, undefined);
    assert.equal(fm0.data.baseCommit, undefined);

    const loaded0 = await loadTaskEnvelope(nfs, taskPath);
    // No in-memory phantom — absence must stay absent for backfill detection.
    assert.equal(loaded0.integrationAuthority, undefined);
    assert.equal(loaded0.baseCommit, undefined);
    // Context / workspaceLane projection may derive without inventing envelope field.
    const projected = workspaceLaneOf({
      ...loaded0,
      workspace: "C:/ws",
      worktree: "C:/wt",
      branch: "tent-task/tk-x",
      targetBranch: "tent-role/规划",
    });
    assert.equal(projected?.integrationAuthority?.mutator, "service");
    assert.equal(projected?.integrationAuthority?.actor.id, "规划");
    // Envelope field still unset after projection helper.
    assert.equal(loaded0.integrationAuthority, undefined);

    // Explicit managed-lane backfill (same writes ensureTaskWorkspaceLane performs).
    const baseSha = "a".repeat(40);
    const authority = deriveIntegrationAuthority({
      parentActor: parent,
      reviewer: parent,
    });
    const afterBind = await patchTaskEnvelope(nfs, taskPath, {
      workspace: "C:/ws",
      worktree: "C:/wt",
      branch: "tent-task/tk-x",
      targetBranch: "tent-role/规划",
      baseCommit: baseSha,
      integrationAuthority: authority,
    });
    assert.equal(afterBind.baseCommit, baseSha);
    assert.ok(afterBind.integrationAuthority);
    assert.equal(afterBind.integrationAuthority?.mutator, "service");
    assert.equal(afterBind.integrationAuthority?.actor.id, "规划");

    // Raw frontmatter must record both fields (restart audit truth).
    const raw1 = await nfs.readFile(taskPath);
    const fm1 = parseFrontmatter(raw1);
    assert.equal(fm1.data.baseCommit, baseSha);
    assert.ok(fm1.data.integrationAuthority);
    const bag = fm1.data.integrationAuthority as {
      actor: { kind: string; id: string };
      mutator: string;
    };
    assert.equal(bag.mutator, "service");
    assert.equal(bag.actor.id, "规划");

    // Reload retains and validates recorded bag.
    const reloaded = await loadTaskEnvelope(nfs, taskPath);
    assert.equal(reloaded.baseCommit, baseSha);
    assert.equal(reloaded.integrationAuthority?.mutator, "service");
    assert.equal(reloaded.integrationAuthority?.actor.kind, "role");
    assert.equal(reloaded.integrationAuthority?.actor.id, "规划");

    const { serializeFrontmatter } = await import("../src/core/frontmatter.js");

    // Tampered actor on disk fails loud at load.
    const fmTamper = parseFrontmatter(raw1);
    fmTamper.data.integrationAuthority = {
      actor: { kind: "role", id: "forged-actor" },
      mutator: "service",
    };
    await nfs.writeFile(
      taskPath,
      serializeFrontmatter(fmTamper.data, fmTamper.body, fmTamper.keyOrder)
    );
    await assert.rejects(
      () => loadTaskEnvelope(nfs, taskPath),
      (err: unknown) =>
        err instanceof TaskContextCardError && err.code === "INVALID_ACTOR"
    );

    // Tampered mutator fails loud.
    fmTamper.data.integrationAuthority = {
      actor: { kind: "role", id: "规划" },
      mutator: "executor",
    };
    await nfs.writeFile(
      taskPath,
      serializeFrontmatter(fmTamper.data, fmTamper.body, fmTamper.keyOrder)
    );
    await assert.rejects(
      () => loadTaskEnvelope(nfs, taskPath),
      (err: unknown) =>
        err instanceof TaskContextCardError && err.code === "INVALID_ACTOR"
    );

    // Missing legacy authority: strip bag → load stays absent (explicit backfill path).
    const withoutAuth = Object.fromEntries(
      Object.entries(fmTamper.data).filter(([k]) => k !== "integrationAuthority")
    );
    await nfs.writeFile(
      taskPath,
      serializeFrontmatter(
        withoutAuth,
        fmTamper.body,
        fmTamper.keyOrder.filter((k) => k !== "integrationAuthority")
      )
    );
    const legacy = await loadTaskEnvelope(nfs, taskPath);
    assert.equal(
      legacy.integrationAuthority,
      undefined,
      "legacy missing authority stays absent (no phantom)"
    );
    assert.equal(legacy.baseCommit, baseSha);
    // Explicit backfill (same as ensureTaskWorkspaceLane) persists canonical bag.
    const backfilled = await patchTaskEnvelope(nfs, taskPath, {
      integrationAuthority: deriveIntegrationAuthority({
        parentActor: legacy.parentActor!,
        reviewer: legacy.reviewer!,
      }),
    });
    assert.equal(backfilled.integrationAuthority?.mutator, "service");
    const rawBack = await nfs.readFile(taskPath);
    assert.match(rawBack, /integrationAuthority:/);
    assert.match(rawBack, /mutator: service/);
    const finalLoad = await loadTaskEnvelope(nfs, taskPath);
    assert.equal(finalLoad.integrationAuthority?.actor.id, "规划");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


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

test("projectExecutionLaneFromTask uses exact baseCommit only; derives authority from parent/reviewer", () => {
  const lane = projectExecutionLaneFromTask({
    baseCommit: "abc123base",
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
  // roleBranchBase is not a baseCommit substitute — omitted baseCommit stays empty.
  const noBase = projectExecutionLaneFromTask({
    targetBranch: "tent-role/规划",
    branch: "tent-task/tk-x",
    parentActor: { kind: "role", id: "规划" },
    reviewer: { kind: "role", id: "规划" },
  });
  assert.equal(noBase?.baseCommit, undefined);
  assert.equal(noBase?.integrationAuthority?.mutator, "service");
  assert.deepEqual(
    deriveIntegrationAuthority({
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    }),
    { actor: { kind: "user", id: "user" }, mutator: "service" }
  );
});

test("projectExecutionLaneFromTask fails loud on parent/reviewer mismatch", () => {
  assert.throws(
    () =>
      projectExecutionLaneFromTask({
        baseCommit: "abc",
        parentActor: { kind: "role", id: "规划" },
        reviewer: { kind: "role", id: "other" },
      }),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "INVALID_ACTOR"
  );
});

test("assertIntegrationAuthorityMatchesParent rejects arbitrary Task-supplied authority", () => {
  const parent = { kind: "role" as const, id: "规划" };
  const reviewer = { kind: "role" as const, id: "规划" };
  assert.doesNotThrow(() =>
    assertIntegrationAuthorityMatchesParent(
      { actor: parent, mutator: "service" },
      parent,
      reviewer
    )
  );
  assert.throws(
    () =>
      assertIntegrationAuthorityMatchesParent(
        { actor: { kind: "role", id: "forged" }, mutator: "service" },
        parent,
        reviewer
      ),
    (err: unknown) =>
      err instanceof TaskContextCardError && err.code === "INVALID_ACTOR"
  );
  assert.throws(
    () =>
      assertIntegrationAuthorityMatchesParent(
        { actor: parent, mutator: "executor" },
        parent,
        reviewer
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
