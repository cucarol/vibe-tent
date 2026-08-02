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
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import {
  assertReviewAuthority,
  allowsNonReviewAcceptMode,
  parseTaskOutcomeReport,
  roleTaskActors,
  TaskLifecycleError,
  userTaskActors,
} from "../src/core/task-model.js";
import {
  loadTaskEnvelope,
  writeTaskEnvelope,
} from "../src/core/task.js";

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

test("allowsNonReviewAcceptMode: user-facing Task regardless of Role/Session executor", () => {
  assert.equal(
    allowsNonReviewAcceptMode({
      parentActor: { kind: "user", id: "user" },
    }),
    true
  );
  assert.equal(
    allowsNonReviewAcceptMode({
      parentActor: { kind: "user", id: "user" },
    }),
    true
  );
  assert.equal(
    allowsNonReviewAcceptMode({
      parentActor: { kind: "role", id: "rl-planner" },
    }),
    false
  );
  assert.equal(
    allowsNonReviewAcceptMode({
      parentActor: { kind: "role", id: "rl-planner" },
    }),
    false
  );
});

test("assertReviewAuthority: missing reviewer fails loud", () => {
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "user",
        executorRoleId: "rl-helper",
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );
});

test("writeTaskEnvelope persists canonical parentActor/reviewer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-wire-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  const clock = new SystemClock();
  const p = await writeTaskEnvelope(fsa, clock, {
    roleId: "rl-helper",
    nodeRefs: [{ id: "cx-1", path: "a.md" }],
    manifestPath: "temp/helper/manifest.yml",
    userPrompt: "do it",
    parentActor: { kind: "role", id: "rl-orchestrator" },
    reviewer: { kind: "role", id: "rl-orchestrator" },
    asSub: true,
  });
  const raw = await fsa.readFile(p);
  assert.match(raw, /parentActor:/);
  assert.match(raw, /reviewer:/);
  const task = await loadTaskEnvelope(fsa, p);
  assert.equal(task.parentActor?.id, "rl-orchestrator");
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
        roleId: "rl-helper",
        nodeRefs: [{ id: "cx-1", path: "a.md" }],
        manifestPath: "temp/helper/manifest.yml",
        userPrompt: "do it",
        parentActor: { kind: "role", id: "rl-orchestrator" },
        reviewer: { kind: "role", id: "rl-orchestrator" },
        acceptMode: "auto-accept",
      }),
    /only legal for a user-facing Task|must use review-required/i
  );
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
      parentActor: { kind: "role", id: "rl-planner" },
      reviewer: { kind: "role", id: "rl-planner" },
    }),
    roleTaskActors("rl-planner")
  );

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-req-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  const clock = new SystemClock();
  await assert.rejects(
    () =>
      writeTaskEnvelope(fsa, clock, {
        roleId: "rl-helper",
        nodeRefs: [{ id: "cx-1", path: "a.md" }],
        manifestPath: "temp/helper/manifest.yml",
        userPrompt: "missing actors",
      } as never),
    /parentActor|reviewer/i
  );
});

test("Core+Service: parentActor/reviewer mismatch rejected at write, load, and RPC", async () => {
  const { resolveDispatchActors } = await import("../src/core/task.js");
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
        roleId: "rl-helper",
        nodeRefs: [{ id: "cx-1", path: "a.md" }],
        manifestPath: "temp/helper/manifest.yml",
        userPrompt: "mismatch",
        parentActor: { kind: "role", id: "orchestrator" },
        reviewer: { kind: "role", id: "planner" },
      }),
    /must equal parentActor|no arbitrary delegation/i
  );

  // Persisted mismatched pair fails loud on load (resolveActorsFromDisk).
  const mismatchPath = await writeTaskEnvelope(fsa, clock, {
    roleId: "rl-helper",
    nodeRefs: [{ id: "cx-1", path: "a.md" }],
    manifestPath: "temp/helper/manifest.yml",
    userPrompt: "bad pair",
    parentActor: { kind: "role", id: "orchestrator" },
    reviewer: { kind: "role", id: "orchestrator" },
  });
  const persisted = parseFrontmatter(await fsa.readFile(mismatchPath));
  persisted.data.reviewer = { kind: "role", id: "planner" };
  await fsa.writeFile(
    mismatchPath,
    serializeFrontmatter(persisted.data, persisted.body, persisted.keyOrder)
  );
  await assert.rejects(
    () => loadTaskEnvelope(fsa, mismatchPath),
    /must equal parentActor|no arbitrary delegation/i
  );

  // Invalid persisted data remains untouched; runtime does not ship a migrator.
  const raw = await fsa.readFile(mismatchPath);
  assert.match(raw, /id:\s*planner/);
});

test("assertReviewAuthority: exact reviewer only — user cannot accept/reject role:X", () => {
  const roleReviewer = { kind: "role" as const, id: "rl-planner" };
  for (const action of ["accept", "reject"] as const) {
    assert.throws(
      () =>
        assertReviewAuthority({
          actor: "user",
          executorRoleId: "rl-helper",
          reviewer: roleReviewer,
          action,
        }),
      (err: unknown) =>
        err instanceof TaskLifecycleError &&
        err.code === "REVIEW_FORBIDDEN" &&
        /reviewer role \(rl-planner\)/i.test(String((err as Error).message))
    );
  }
  assert.doesNotThrow(() =>
    assertReviewAuthority({
      actor: "rl-planner",
      executorRoleId: "rl-helper",
      reviewer: roleReviewer,
      action: "accept",
    })
  );
  assert.doesNotThrow(() =>
    assertReviewAuthority({
      actor: "rl-planner",
      executorRoleId: "rl-helper",
      reviewer: roleReviewer,
      action: "reject",
    })
  );
  // user-reviewed still allows only user (not a peer role).
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "rl-planner",
        executorRoleId: "rl-helper",
        reviewer: { kind: "user", id: "user" },
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );
  assert.doesNotThrow(() =>
    assertReviewAuthority({
      actor: "user",
      executorRoleId: "rl-helper",
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
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [{ id: "rl-executor", name: "executor", prompt: "do work" }] }, null, 2) + "\n"
  );
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
    const nodeId = (created.result as { nodeId: string }).nodeId;

    const legacy = await rpcCall(
      svc.url,
      "task.dispatch",
      {
        workspaceId,
        nodeIds: [nodeId],
        roleId: "rl-executor",
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
    assert.match(String(legacy.error!.message), /unknown parameter.*dispatchedBy/i);

    const missing = await rpcCall(
      svc.url,
      "task.dispatch",
      {
        workspaceId,
        nodeIds: [nodeId],
        roleId: "rl-executor",
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
        nodeIds: [nodeId],
        roleId: "rl-executor",
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
        nodeIds: [nodeId],
        roleId: "rl-executor",
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
        nodeIds: [nodeId],
        roleId: "rl-executor",
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

test("loadTaskEnvelope ignores unknown dispatchedBy without rewriting or using it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-load-"));
  const fsa = new NodeFs(dir);
  const taskPath = await writeTaskEnvelope(fsa, new SystemClock(), {
    roleId: "rl-helper",
    nodeRefs: [{ id: "cx-2", path: "b.md" }],
    manifestPath: "temp/helper/manifest.yml",
    userPrompt: "x",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  const persisted = parseFrontmatter(await fsa.readFile(taskPath));
  persisted.data.dispatchedBy = "user";
  await fsa.writeFile(
    taskPath,
    serializeFrontmatter(persisted.data, persisted.body, persisted.keyOrder)
  );
  // Load must not dual-read or rewrite the unknown responsibility field.
  const loaded = await loadTaskEnvelope(fsa, taskPath);
  assert.deepEqual(loaded.parentActor, { kind: "user", id: "user" });
  assert.deepEqual(loaded.reviewer, { kind: "user", id: "user" });
  const raw = await fsa.readFile(taskPath);
  assert.match(raw, /dispatchedBy:\s*user/);
});
