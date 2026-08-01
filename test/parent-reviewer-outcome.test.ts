/**
 * V0.2 parent-reviewer wire + explicit Task outcome (cx-484qdb).
 * Focused pure + store tests; service integration covered by existing suites.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SystemClock } from "../src/fs/node-fs.js";
import { NodeFs } from "../src/fs/node-fs.js";
import {
  assertReviewAuthority,
  mayElevateDeliveryPolicy,
  migrateParentReviewerFromLegacy,
  parseTaskOutcomeReport,
  roleTaskActors,
  TaskLifecycleError,
  userTaskActors,
} from "../src/core/task-model.js";
import {
  loadTaskEnvelope,
  migrateParentReviewerEnvelopes,
  writeTaskEnvelope,
} from "../src/core/task.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";

test("parseTaskOutcomeReport: valid control headers parse; missing or malformed return null", () => {
  assert.deepEqual(parseTaskOutcomeReport("outcome: delivered\n\nAll good"), {
    outcome: "delivered",
    report: "All good",
  });
  assert.deepEqual(
    parseTaskOutcomeReport("---\noutcome: blocked\n---\nCannot proceed"),
    { outcome: "blocked", report: "Cannot proceed" }
  );
  assert.deepEqual(parseTaskOutcomeReport("outcome: needs-input\nWhich API?"), {
    outcome: "needs-input",
    report: "Which API?",
  });
  assert.equal(parseTaskOutcomeReport("Just a free-form report"), null);
  assert.equal(parseTaskOutcomeReport("outcome: weird\nnope"), null);
  assert.equal(parseTaskOutcomeReport(""), null);
});

test("migrateParentReviewerFromLegacy: durable dispatcher → role; else user", () => {
  assert.deepEqual(migrateParentReviewerFromLegacy({ dispatchedBy: "user" }), userTaskActors());
  assert.deepEqual(migrateParentReviewerFromLegacy({}), userTaskActors());
  assert.deepEqual(
    migrateParentReviewerFromLegacy({ asSub: true, dispatchedBy: "规划" }),
    roleTaskActors("规划")
  );
  assert.deepEqual(
    migrateParentReviewerFromLegacy({ asSub: false, dispatchedBy: "orchestrator" }),
    roleTaskActors("orchestrator")
  );
});

test("mayElevateDeliveryPolicy: only durable Role user-facing", () => {
  assert.equal(
    mayElevateDeliveryPolicy({
      parentActor: { kind: "user", id: "user" },
      assigneeKind: "role",
    }),
    true
  );
  assert.equal(
    mayElevateDeliveryPolicy({
      parentActor: { kind: "user", id: "user" },
      assigneeKind: "agentProfile",
    }),
    false
  );
  assert.equal(
    mayElevateDeliveryPolicy({
      parentActor: { kind: "role", id: "规划" },
      assigneeKind: "agentProfile",
    }),
    false
  );
  assert.equal(
    mayElevateDeliveryPolicy({
      parentActor: { kind: "role", id: "规划" },
      assigneeKind: "role",
    }),
    false
  );
});

test("assertReviewAuthority: missing reviewer fails loud", () => {
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "user",
        submitterRole: "helper",
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );
});

test("writeTaskEnvelope persists parentActor/reviewer; strips dispatchedBy", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-wire-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  const clock = new SystemClock();
  const p = await writeTaskEnvelope(fsa, clock, {
    role: "helper",
    claims: [{ id: "cx-1", path: "a.md" }],
    manifestPath: "temp/helper/manifest.yml",
    userPrompt: "do it",
    parentActor: { kind: "role", id: "orchestrator" },
    reviewer: { kind: "role", id: "orchestrator" },
    asSub: true,
  });
  const raw = await fsa.readFile(p);
  assert.match(raw, /parentActor:/);
  assert.match(raw, /reviewer:/);
  assert.doesNotMatch(raw, /^dispatchedBy:/m);
  const task = await loadTaskEnvelope(fsa, p);
  assert.equal(task.parentActor?.id, "orchestrator");
  assert.equal(task.reviewer?.kind, "role");
  assert.equal(task.asSub, true);
});

test("writeTaskEnvelope refuses elevated policy for downstream Task Agent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-policy-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  const clock = new SystemClock();
  await assert.rejects(
    () =>
      writeTaskEnvelope(fsa, clock, {
        role: "helper",
        claims: [{ id: "cx-1", path: "a.md" }],
        manifestPath: "temp/helper/manifest.yml",
        userPrompt: "do it",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "orchestrator" },
        deliveryPolicy: "bypass",
      }),
    /only legal for a durable Role's user-facing delivery|must use review/i
  );
});

test("migrateParentReviewerEnvelopes: one-time rewrite strips dispatchedBy", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-mig-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  // Legacy envelope without parentActor.
  await fsa.writeFile(
    "temp/helper/tasks/task-legacy.md",
    [
      "---",
      "type: task",
      "id: tk-legacy01",
      "status: pending",
      "state: queued",
      "role: helper",
      "dispatchedBy: orchestrator",
      "asSub: true",
      "claims: [cx-1]",
      "manifest: temp/helper/manifest.yml",
      "deliveryPolicy: review",
      "---",
      "# Task",
      "",
      "## User Prompt",
      "",
      "legacy",
      "",
    ].join("\n")
  );
  const clock = new SystemClock();
  const report = await migrateParentReviewerEnvelopes(fsa, clock);
  assert.equal(report.rewritten.length, 1);
  const raw = await fsa.readFile("temp/helper/tasks/task-legacy.md");
  const { data } = parseFrontmatter(raw);
  assert.equal((data.parentActor as { id: string }).id, "orchestrator");
  assert.equal((data.reviewer as { id: string }).id, "orchestrator");
  assert.equal(data.dispatchedBy, undefined);
  assert.equal(data.asSub, true);
  // Idempotent second pass.
  const again = await migrateParentReviewerEnvelopes(fsa, clock);
  assert.equal(again.rewritten.length, 0);
  const task = await loadTaskEnvelope(fsa, "temp/helper/tasks/task-legacy.md");
  assert.equal(task.parentActor?.id, "orchestrator");
  assert.equal(task.reviewer?.id, "orchestrator");
});

test("resolveDispatchActors / writeTaskEnvelope refuse missing actors and dispatchedBy create path", async () => {
  const { resolveDispatchActors } = await import("../src/core/task.js");
  assert.throws(
    () => resolveDispatchActors({} as never),
    /requires explicit parentActor/i
  );
  // Omitted reviewer is derived equal to parentActor.
  assert.deepEqual(
    resolveDispatchActors({
      parentActor: { kind: "user", id: "user" },
    }),
    userTaskActors()
  );
  assert.deepEqual(
    resolveDispatchActors({
      parentActor: { kind: "role", id: "规划" },
      reviewer: { kind: "role", id: "规划" },
    }),
    roleTaskActors("规划")
  );

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-req-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  const clock = new SystemClock();
  await assert.rejects(
    () =>
      writeTaskEnvelope(fsa, clock, {
        role: "helper",
        claims: [{ id: "cx-1", path: "a.md" }],
        manifestPath: "temp/helper/manifest.yml",
        userPrompt: "missing actors",
      } as never),
    /parentActor|reviewer/i
  );
});

test("Core+Service: parentActor/reviewer mismatch rejected at write, load, migration, and RPC", async () => {
  const { resolveDispatchActors, migrateParentReviewerEnvelopes } = await import(
    "../src/core/task.js"
  );
  const {
    assertParentReviewerEqual,
    resolveParentReviewerPair,
    TaskLifecycleError: TLE,
  } = await import("../src/core/task-model.js");

  // Shared pair resolver is the single equality gate for all three boundaries.
  assert.throws(
    () =>
      resolveParentReviewerPair({
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "planner" },
      }),
    (err: unknown) =>
      err instanceof TLE &&
      err.code === "INVALID_ACTOR" &&
      /must equal parentActor|no arbitrary delegation/i.test(String(err.message))
  );
  assert.deepEqual(
    resolveParentReviewerPair({
      parentActor: { kind: "role", id: "orchestrator" },
    }),
    {
      parentActor: { kind: "role", id: "orchestrator" },
      reviewer: { kind: "role", id: "orchestrator" },
    }
  );

  assert.throws(
    () =>
      assertParentReviewerEqual(
        { kind: "role", id: "orchestrator" },
        { kind: "role", id: "planner" }
      ),
    (err: unknown) => err instanceof TLE && err.code === "INVALID_ACTOR"
  );

  // Core new-write boundary (resolveDispatchActors → resolveParentReviewerPair).
  assert.throws(
    () =>
      resolveDispatchActors({
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "planner" },
      }),
    /must equal parentActor|no arbitrary delegation/i
  );

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-mismatch-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  const clock = new SystemClock();

  // Core writeTaskEnvelope boundary.
  await assert.rejects(
    () =>
      writeTaskEnvelope(fsa, clock, {
        role: "helper",
        claims: [{ id: "cx-1", path: "a.md" }],
        manifestPath: "temp/helper/manifest.yml",
        userPrompt: "mismatch",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "planner" },
      }),
    /must equal parentActor|no arbitrary delegation/i
  );

  // Persisted mismatched pair fails loud on load (resolveActorsFromDisk).
  // Use inline maps — Tent frontmatter does not nest block maps under keys.
  await fsa.writeFile(
    "temp/helper/tasks/task-mismatch.md",
    [
      "---",
      "type: task",
      "id: tk-mis0001",
      "status: pending",
      "state: queued",
      "role: helper",
      "parentActor: { kind: role, id: orchestrator }",
      "reviewer: { kind: role, id: planner }",
      "claims: [cx-1]",
      "manifest: temp/helper/manifest.yml",
      "deliveryPolicy: review",
      "---",
      "# Task",
      "",
      "## User Prompt",
      "",
      "bad pair",
      "",
    ].join("\n")
  );
  await assert.rejects(
    () => loadTaskEnvelope(fsa, "temp/helper/tasks/task-mismatch.md"),
    /must equal parentActor|no arbitrary delegation/i
  );

  // Migration records mismatch as warning; does not rewrite to invent equality.
  const report = await migrateParentReviewerEnvelopes(fsa, clock);
  assert.ok(
    report.warnings.some((w) => /must equal parentActor|no arbitrary delegation/i.test(w)),
    `expected mismatch warning, got ${JSON.stringify(report.warnings)}`
  );
  assert.equal(report.rewritten.length, 0);
  const raw = await fsa.readFile("temp/helper/tasks/task-mismatch.md");
  assert.match(raw, /id:\s*planner/);
});

test("assertReviewAuthority: exact reviewer only — user cannot accept/reject role:X", () => {
  const roleReviewer = { kind: "role" as const, id: "规划" };
  for (const action of ["accept", "reject"] as const) {
    assert.throws(
      () =>
        assertReviewAuthority({
          actor: "user",
          submitterRole: "helper",
          reviewer: roleReviewer,
          action,
        }),
      (err: unknown) =>
        err instanceof TaskLifecycleError &&
        err.code === "REVIEW_FORBIDDEN" &&
        /reviewer role \(规划\)/i.test(String((err as Error).message))
    );
  }
  assert.doesNotThrow(() =>
    assertReviewAuthority({
      actor: "规划",
      submitterRole: "helper",
      reviewer: roleReviewer,
      action: "accept",
    })
  );
  assert.doesNotThrow(() =>
    assertReviewAuthority({
      actor: "规划",
      submitterRole: "helper",
      reviewer: roleReviewer,
      action: "reject",
    })
  );
  // user-reviewed still allows only user (not a peer role).
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "规划",
        submitterRole: "helper",
        reviewer: { kind: "user", id: "user" },
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );
  assert.doesNotThrow(() =>
    assertReviewAuthority({
      actor: "user",
      submitterRole: "helper",
      reviewer: { kind: "user", id: "user" },
      action: "accept",
    })
  );
});

test("task.dispatch RPC rejects legacy dispatchedBy and missing parentActor/reviewer", async () => {
  const { scaffoldInWorkspace } = await import("../src/core/scaffold.js");
  const { startLocalTentService } = await import("../src/service/service.js");
  const { rpcCall } = await import("../src/service/http-server.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-rpc-"));
  const fsa = new NodeFs(dir);
  await scaffoldInWorkspace(fsa, {
    name: "parent-rpc",
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-rpc-data-"));
  const svc = await startLocalTentService({
    dataDir,
    host: "127.0.0.1",
    port: 0,
  });
  try {
    const mount = await rpcCall(
      svc.url,
      "workspace.mount",
      { workspaceRoot: dir },
      { token: svc.token }
    );
    assert.ok(!mount.error, JSON.stringify(mount.error));
    const workspaceId = (mount.result as { workspaceId: string }).workspaceId;
    const created = await rpcCall(
      svc.url,
      "docs.createNote",
      { workspaceId, name: "p0-box", type: "prompt" },
      { token: svc.token }
    );
    assert.ok(!created.error, JSON.stringify(created.error));
    const boxId = (created.result as { id: string }).id;

    const legacy = await rpcCall(
      svc.url,
      "task.dispatch",
      {
        workspaceId,
        nodeIds: [boxId],
        role: "executor",
        prompt: "legacy wire",
        // Even with explicit actors present, dispatchedBy must be rejected.
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        dispatchedBy: "user",
      },
      { token: svc.token }
    );
    assert.ok(legacy.error);
    assert.equal(legacy.error!.code, -32602);
    assert.match(String(legacy.error!.message), /dispatchedBy is retired/i);

    const missing = await rpcCall(
      svc.url,
      "task.dispatch",
      {
        workspaceId,
        nodeIds: [boxId],
        role: "executor",
        prompt: "missing actors",
      },
      { token: svc.token }
    );
    assert.ok(missing.error);
    assert.equal(missing.error!.code, -32602);
    assert.match(String(missing.error!.message), /parentActor|reviewer/i);

    // Role A cannot assign reviewer Role B.
    const mismatched = await rpcCall(
      svc.url,
      "task.dispatch",
      {
        workspaceId,
        nodeIds: [boxId],
        role: "executor",
        prompt: "mismatch pair",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "planner" },
      },
      { token: svc.token }
    );
    assert.ok(mismatched.error);
    assert.equal(mismatched.error!.code, -32602);
    assert.match(
      String(mismatched.error!.message),
      /must equal parentActor|no arbitrary delegation/i
    );

    // Omitted reviewer is derived equal to parentActor and both are persisted.
    const derived = await rpcCall(
      svc.url,
      "task.dispatch",
      {
        workspaceId,
        nodeIds: [boxId],
        role: "executor",
        prompt: "derived reviewer",
        parentActor: { kind: "user", id: "user" },
      },
      { token: svc.token }
    );
    assert.ok(!derived.error, JSON.stringify(derived.error));
    const derivedPath = (derived.result as { taskPath: string }).taskPath;
    const derivedTask = await loadTaskEnvelope(
      new NodeFs(path.join(dir, ".tent")),
      derivedPath
    );
    assert.equal(derivedTask.parentActor?.kind, "user");
    assert.equal(derivedTask.reviewer?.id, "user");
    assert.deepEqual(derivedTask.parentActor, derivedTask.reviewer);
    const derivedRaw = await fs.readFile(path.join(dir, ".tent", derivedPath), "utf8");
    assert.doesNotMatch(derivedRaw, /^dispatchedBy:/m);
    const projected = derived.result as {
      parentActor?: { kind: string; id: string };
      reviewer?: { kind: string; id: string };
      dispatchedBy?: string;
    };
    assert.equal(projected.dispatchedBy, undefined);
    assert.equal(projected.parentActor?.id, "user");
    assert.equal(projected.reviewer?.id, "user");

    // Cancel so a second explicit-pair dispatch can reuse the free box.
    const cancelled = await rpcCall(
      svc.url,
      "task.cancel",
      { workspaceId, taskPath: derivedPath },
      { token: svc.token }
    );
    assert.ok(!cancelled.error, JSON.stringify(cancelled.error));

    const ok = await rpcCall(
      svc.url,
      "task.dispatch",
      {
        workspaceId,
        nodeIds: [boxId],
        role: "executor",
        prompt: "explicit actors",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
      },
      { token: svc.token }
    );
    assert.ok(!ok.error, JSON.stringify(ok.error));
    const taskPath = (ok.result as { taskPath: string }).taskPath;
    const task = await loadTaskEnvelope(new NodeFs(path.join(dir, ".tent")), taskPath);
    assert.equal(task.parentActor?.kind, "user");
    assert.equal(task.reviewer?.id, "user");
    assert.deepEqual(task.parentActor, task.reviewer);
    const raw = await fs.readFile(path.join(dir, ".tent", taskPath), "utf8");
    assert.doesNotMatch(raw, /^dispatchedBy:/m);
  } finally {
    await svc.stop();
  }
});

test("loadTaskEnvelope: refuses unmigrated legacy dispatchedBy (migrator-only read)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-load-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  await fsa.writeFile(
    "temp/helper/tasks/task-mem.md",
    [
      "---",
      "type: task",
      "id: tk-mem0001",
      "status: taken",
      "state: running",
      "role: helper",
      "dispatchedBy: user",
      "claims: [cx-2]",
      "manifest: temp/helper/manifest.yml",
      "---",
      "# Task",
      "",
      "## User Prompt",
      "",
      "x",
      "",
    ].join("\n")
  );
  // Load must not dual-read dispatchedBy; only migrateParentReviewerEnvelopes may.
  await assert.rejects(
    () => loadTaskEnvelope(fsa, "temp/helper/tasks/task-mem.md"),
    /legacy dispatchedBy|migrateParentReviewerEnvelopes|missing parentActor/i
  );
  const raw = await fsa.readFile("temp/helper/tasks/task-mem.md");
  assert.match(raw, /dispatchedBy:\s*user/);
  // After one-time migration, load succeeds and dispatchedBy is gone.
  const clock = new SystemClock();
  const report = await migrateParentReviewerEnvelopes(fsa, clock);
  assert.equal(report.rewritten.length, 1);
  const task = await loadTaskEnvelope(fsa, "temp/helper/tasks/task-mem.md");
  assert.equal(task.parentActor?.kind, "user");
  assert.equal(task.reviewer?.id, "user");
  const after = await fsa.readFile("temp/helper/tasks/task-mem.md");
  assert.doesNotMatch(after, /^dispatchedBy:/m);
});
