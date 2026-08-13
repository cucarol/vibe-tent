import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { dispatch } from "../src/core/ops.js";
import { loadTaskRecord, patchTaskRecord } from "../src/core/task.js";
import { loadTaskResults, writeTaskResult } from "../src/core/task-result.js";
import {
  finalizeTaskAccept,
  finalizeTaskSubmitAuto,
  findActiveTaskForNode,
  prepareTaskAccept,
  prepareTaskSubmit,
  taskAccept,
  taskCancel,
  taskClaim,
  taskSubmit,
  taskFail,
  taskInterrupt,
  taskReject,
  taskResume,
  taskWait,
} from "../src/core/task-lifecycle.js";
import { TaskLifecycleError } from "../src/core/task-model.js";
import {
  nodeContextCard,
  resultContextCard,
  parseContextCardText,
  taskContextCard,
} from "../src/core/context-card.js";
import { makeTent } from "./helpers.js";

/** Node FM must not carry owner/status after collab ops. */
function assertNoFmCollab(box: { fm: Record<string, unknown> }): void {
  assert.equal(box.fm.owner, undefined);
  assert.equal(box.fm.status, undefined);
  assert.equal(box.fm.acceptedBy, undefined);
}

function env(dir: string) {
  return {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-07-12T10:00:00.000Z" },
    tentName: "wqb",
    tentRoot: dir,
  };
}

async function dispatchToRole(env: any, nodeId: string, roleName: string, input: string | Record<string, unknown>) {
  const roleId = `rl-${roleName.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const registry = await env.fs.exists("roles.json")
    ? JSON.parse(await env.fs.readFile("roles.json")) as { roles?: Array<Record<string, unknown>> }
    : { roles: [] as Array<Record<string, unknown>> };
  if (!(registry.roles ?? []).some((role) => role.id === roleId)) {
    registry.roles = [...(registry.roles ?? []), { id: roleId, name: roleName, displayName: roleName }];
    await env.fs.writeFile("roles.json", JSON.stringify(registry, null, 2) + "\n");
  }
  return dispatch(env, nodeId, {
    assigneeRoleId: roleId,
    workNodeIds: [nodeId],
    contextNodeIds: [],
    requester: { kind: "user", id: "user" },
    ...(typeof input === "string" ? { prompt: input } : input),
  });
}

async function dispatchOnFreeNode(dir: string, role = "executor") {
  const e = env(dir);
  // cx-p1 is free (no owner) in makeTent fixture
  const result = await dispatchToRole(e as any, "cx-p1", role, {
    prompt: "Implement the lifecycle slice",
    requester: { kind: "user", id: "user" },
  });
  return { e, result };
}

test("lifecycle: first Role claim atomically binds the exact caller Session", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, result.taskPath, {
    claimWrite: { executionSessionId: "ss-caller" },
  });
  const task = await loadTaskRecord(e.fs, result.taskPath);
  assert.equal(task.state, "running");
  assert.equal(task.assigneeRoleId, "rl-executor");
  assert.equal(task.executionSessionId, "ss-caller");
});

test("lifecycle: queued Task cannot replace an already-bound Session during claim", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const result = await dispatch(e as any, "cx-p1", {
    executionSessionId: "ss-bounda",
    workNodeIds: ["cx-p1"],
    contextNodeIds: [],
    prompt: "Keep the exact pre-bound Session",
    requester: { kind: "user", id: "user" },
  });
  const before = await e.fs.readFile(result.taskPath);

  await assert.rejects(
    () =>
      taskClaim(e as any, result.taskPath, {
        claimWrite: { executionSessionId: "ss-boundb" },
      }),
    /different Session/
  );

  assert.equal(await e.fs.readFile(result.taskPath), before, "failed claim must be zero-mutation");
  const task = await loadTaskRecord(e.fs, result.taskPath);
  assert.equal(task.state, "queued");
  assert.equal(task.executionSessionId, "ss-bounda");
});

test("lifecycle: dispatch → claim → wait → resume → submit → accept", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  let task = await loadTaskRecord(e.fs, result.taskPath);
  assert.equal(task.state, "queued");
  assert.ok(task.id?.startsWith("tk-"));
  assert.equal(task.acceptMode, "review-required");

  task = await taskClaim(e as any, result.taskPath);
  assert.equal(task.state, "running");
  assert.equal(task.executionSessionId, undefined, "claim must not bind a Session");
  assert.ok(await findActiveTaskForNode(e.fs, "cx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);

  task = await taskWait(e as any, result.taskPath, {
    reason: "user-input",
    summary: "Need clarification on acceptance criteria",
  });
  assert.equal(task.state, "waiting");
  assert.equal(task.wait?.reason, "user-input");

  task = await taskResume(e as any, result.taskPath);
  assert.equal(task.state, "running");
  assert.equal(task.wait, undefined);

  const delivered = await taskSubmit(e as any, result.taskPath, {
    report: "Done with tests",
    commits: ["a".repeat(40)],
    targetHead: "f".repeat(40),
  });
  assert.equal(delivered.autoIntegrated, false);
  assert.equal(delivered.task.state, "submitted");
  assert.equal(delivered.result.status, "ready");
  assert.ok(delivered.result.id.startsWith("rs-"));

  let integrated: string[] = [];
  const accepted = await taskAccept(e as any, result.taskPath, {
    actor: "user",
    resultId: delivered.result.id,
    integrate: async (commits) => {
      integrated = commits;
    },
  });
  assert.deepEqual(integrated, ["a".repeat(40)]);
  assert.equal(accepted.task.state, "accepted");
  assert.equal(accepted.result.status, "accepted");
  assert.equal(accepted.result.review?.reviewer, "user");
  assert.equal(accepted.result.integrationMode, null);

  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);
});

test("task.wait formal return requires its exact authoritative Session binding", async () => {
  for (const binding of [undefined, "ss-current"] as const) {
    const dir = await makeTent();
    const { e, result } = await dispatchOnFreeNode(dir);
    await taskClaim(e as any, result.taskPath, binding
      ? { claimWrite: { executionSessionId: binding } }
      : undefined);
    const before = await e.fs.readFile(result.taskPath);
    await assert.rejects(
      () => taskWait(e as any, result.taskPath, {
        reason: "external",
        summary: "must remain running",
        statusDetail: {
          kind: "blocked",
          report: "retired completion",
          executionSessionId: "ss-stale",
        },
      }),
      /Task wait return Session mismatch/
    );
    assert.equal(await e.fs.readFile(result.taskPath), before);
  }

  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, result.taskPath, { claimWrite: { executionSessionId: "ss-current" } });
  const waited = await taskWait(e as any, result.taskPath, {
    reason: "external",
    summary: "exact bound return",
    statusDetail: {
      kind: "blocked",
      report: "exact completion",
      executionSessionId: "ss-current",
    },
  });
  assert.equal(waited.state, "waiting");
  assert.equal(waited.statusDetail?.executionSessionId, "ss-current");
});

test("lifecycle: finalize rejects a ready TaskResult commit-list drift without mutation", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, result.taskPath);
  const delivered = await taskSubmit(e as any, result.taskPath, {
    report: "ready",
    commits: ["a".repeat(40)],
    targetHead: "f".repeat(40),
  });

  const acceptOptions = { actor: "user", resultId: delivered.result.id };
  const prepared = await prepareTaskAccept(e as any, result.taskPath, acceptOptions);
  assert.deepEqual(prepared.commits, ["a".repeat(40)]);
  const preparedResult = (await loadTaskResults(e.fs)).find((row) => row.id === prepared.resultId);
  assert.ok(preparedResult);
  const originalRaw = await e.fs.readFile(preparedResult.path);
  preparedResult.commits = ["b".repeat(40)];
  await assert.rejects(
    () => writeTaskResult(e.fs, preparedResult),
    /payload is immutable after creation/
  );
  assert.equal(await e.fs.readFile(preparedResult.path), originalRaw);
  await e.fs.writeFile(preparedResult.path, originalRaw.replace("a".repeat(40), "b".repeat(40)));

  await assert.rejects(
    () => finalizeTaskAccept(e as any, result.taskPath, acceptOptions, prepared),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "RESULT_CHANGED"
  );
  const task = await loadTaskRecord(e.fs, result.taskPath);
  assert.equal(task.state, "submitted");
  const current = (await loadTaskResults(e.fs)).find((row) => row.id === prepared.resultId);
  assert.equal(current?.status, "ready");
  assert.deepEqual(current?.commits, ["b".repeat(40)]);
});

test("lifecycle: zero-commit ready TaskResult remains legal to accept", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, result.taskPath);
  const delivered = await taskSubmit(e as any, result.taskPath, {
    report: "non-code result",
    commits: [],
  });

  const accepted = await taskAccept(e as any, result.taskPath, {
    actor: "user",
    resultId: delivered.result.id,
  });
  assert.equal(accepted.task.state, "accepted");
  assert.equal(accepted.result.status, "accepted");
  assert.deepEqual(accepted.result.commits, []);
});

test("lifecycle: self-accept is hard-forbidden", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, result.taskPath);
  const delivered = await taskSubmit(e as any, result.taskPath, { report: "ship it", commits: [] });

  await assert.rejects(
    () => taskAccept(e as any, result.taskPath, {
      actor: "rl-executor",
      resultId: delivered.result.id,
    }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "SELF_ACCEPT_FORBIDDEN"
  );
});

test("lifecycle: agent-decide integrate records requester review authority", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const result = await dispatchToRole(e as any, "cx-p1", "executor", {
    prompt: "auto path",
    requester: { kind: "user", id: "user" },
    acceptMode: "agent-decide",
  });
  await taskClaim(e as any, result.taskPath);
  let integrated: string[] = [];
  const out = await taskSubmit(e as any, result.taskPath, {
    report: "agent chose integrate",
    commits: ["d".repeat(40)],
    targetHead: "f".repeat(40),
    decision: "integrate",
    integrate: async (c) => {
      integrated = c;
    },
  });
  assert.equal(out.autoIntegrated, true);
  assert.equal(out.task.state, "accepted");
  assert.equal(out.result.integrationMode, "agent-decided-integrate");
  assert.deepEqual(out.result.review, { reviewer: "user", at: "2026-07-12T10:00:00.000Z" });
  assert.deepEqual(integrated, ["d".repeat(40)]);
});

test("lifecycle: auto-accept persists ready TaskResult before integration and preserves it on failure", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const result = await dispatchToRole(e as any, "cx-p1", "executor", {
    prompt: "auto-accept failure",
    requester: { kind: "user", id: "user" },
    acceptMode: "auto-accept",
  });
  await taskClaim(e as any, result.taskPath);
  await assert.rejects(
    () =>
      taskSubmit(e as any, result.taskPath, {
        report: "will fail integrate",
        commits: ["a".repeat(40)],
        targetHead: "f".repeat(40),
        integrate: async () => {
          const during = await loadTaskRecord(e.fs, result.taskPath);
          assert.equal(during.state, "submitted");
          const readyDuring = (await loadTaskResults(e.fs)).find((d) => d.status === "ready");
          assert.ok(readyDuring, "durable TaskResult must exist before Git integration");
          throw new Error("Workspace integration conflicted and was rolled back");
        },
      }),
    /Workspace integration conflicted/
  );
  const task = await loadTaskRecord(e.fs, result.taskPath);
  assert.equal(task.state, "submitted");
  const results = await loadTaskResults(e.fs);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.status, "ready");
  assert.equal(results[0]!.integrationMode, "auto-accept");
  assert.ok(await findActiveTaskForNode(e.fs, "cx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);
});

test("lifecycle: auto-accept finalize rejects TaskResult commit drift", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const result = await dispatchToRole(e as any, "cx-p1", "executor", {
    prompt: "auto candidate drift",
    requester: { kind: "user", id: "user" },
    acceptMode: "auto-accept",
  });
  await taskClaim(e as any, result.taskPath);
  const options = { report: "ready", commits: ["a".repeat(40)], targetHead: "f".repeat(40) };
  const prepared = await prepareTaskSubmit(e as any, result.taskPath, options);
  assert.equal(prepared.kind, "auto");
  if (prepared.kind !== "auto") return;
  const preparedResult = (await loadTaskResults(e.fs)).find((d) => d.id === prepared.resultId);
  assert.ok(preparedResult);
  const originalRaw = await e.fs.readFile(preparedResult.path);
  await e.fs.writeFile(preparedResult.path, originalRaw.replace("a".repeat(40), "b".repeat(40)));
  await assert.rejects(
    () => finalizeTaskSubmitAuto(e as any, result.taskPath, options, prepared),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "RESULT_CHANGED"
  );
  await e.fs.writeFile(
    preparedResult.path,
    originalRaw.replace("f".repeat(40), "e".repeat(40))
  );
  await assert.rejects(
    () => finalizeTaskSubmitAuto(e as any, result.taskPath, options, prepared),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "RESULT_CHANGED"
  );
  assert.equal((await loadTaskRecord(e.fs, result.taskPath)).state, "submitted");
});

test("lifecycle: acceptMode is frozen at Task creation", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const result = await dispatchToRole(e as any, "cx-p1", "executor", {
    prompt: "freeze acceptance mode",
    acceptMode: "review-required",
  });
  await assert.rejects(
    () =>
      patchTaskRecord(e.fs, result.taskPath, {
        acceptMode: "auto-accept",
      } as never),
    /acceptMode is frozen at creation/
  );
  assert.equal((await loadTaskRecord(e.fs, result.taskPath)).acceptMode, "review-required");
});

test("lifecycle: manual accept integrate failure keeps submitted + occupation", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, result.taskPath);
  const delivered = await taskSubmit(e as any, result.taskPath, {
    report: "ready",
    commits: ["a".repeat(40)],
    targetHead: "f".repeat(40),
  });
  await assert.rejects(
    () =>
      taskAccept(e as any, result.taskPath, {
        actor: "user",
        resultId: delivered.result.id,
        integrate: async () => {
          throw new Error("Workspace integration conflicted and was rolled back");
        },
      }),
    /Workspace integration conflicted/
  );
  const task = await loadTaskRecord(e.fs, result.taskPath);
  assert.equal(task.state, "submitted");
  assert.ok(await findActiveTaskForNode(e.fs, "cx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);
  const ready = (await loadTaskResults(e.fs)).find((d) => d.status === "ready");
  assert.ok(ready, "result stays ready for retry after integrate failure");
});

test("lifecycle: agent-decide without decision fails; review forbids integrate", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const r1 = await dispatchToRole(e as any, "cx-p1", "executor", {
    prompt: "need decision",
    requester: { kind: "user", id: "user" },
    acceptMode: "agent-decide",
  });
  await taskClaim(e as any, r1.taskPath);
  await assert.rejects(
    () => taskSubmit(e as any, r1.taskPath, { report: "x" }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "DECISION_REQUIRED"
  );
  await taskInterrupt(e as any, r1.taskPath);

  const r2 = await dispatchToRole(e as any, "cx-p1", "executor", {
    prompt: "review only",
    requester: { kind: "user", id: "user" },
    acceptMode: "review-required",
  });
  await taskClaim(e as any, r2.taskPath);
  await assert.rejects(
    () =>
      taskSubmit(e as any, r2.taskPath, {
        report: "nope",
        decision: "integrate",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "POLICY_FORBIDS_AUTO_INTEGRATE"
  );
});

test("lifecycle: reject(resume) returns to running; resubmit works", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, result.taskPath);
  const delivered = await taskSubmit(e as any, result.taskPath, { report: "first try" });
  const rejected = await taskReject(e as any, result.taskPath, {
    actor: "user",
    resultId: delivered.result.id,
    note: "add tests",
    resume: true,
  });
  assert.equal(rejected.task.state, "running");
  assert.equal(rejected.result.status, "rejected");
  assert.ok(await findActiveTaskForNode(e.fs, "cx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);

  const second = await taskSubmit(e as any, result.taskPath, { report: "second try with tests" });
  assert.equal(second.task.state, "submitted");
  assert.equal(second.result.status, "ready");
  const all = await loadTaskResults(e.fs);
  const taskId = (await loadTaskRecord(e.fs, result.taskPath)).id;
  assert.ok(all.filter((d) => d.taskId === taskId).length >= 2);
});

test("lifecycle: cancel queued; interrupt running clears occupation", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  await taskCancel(e as any, result.taskPath);
  assert.equal(await e.fs.exists(result.taskPath), false);

  const r2 = await dispatchToRole(e as any, "cx-p1", "executor", {
    prompt: "again",
    requester: { kind: "user", id: "user" },
  });
  await taskClaim(e as any, r2.taskPath);
  await taskInterrupt(e as any, r2.taskPath);
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);
  const task = await loadTaskRecord(e.fs, r2.taskPath);
  assert.equal(task.state, "interrupted");
});

test("lifecycle: published TaskResult wins over interrupt and remains reviewable", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, result.taskPath);
  await taskWait(e as any, result.taskPath, {
    reason: "external",
    summary: "blocked before publish",
    statusDetail: { kind: "blocked", report: "blocked before publish" },
  });
  await taskResume(e as any, result.taskPath);
  const delivered = await taskSubmit(e as any, result.taskPath, {
    report: "published before interrupt",
  });

  await assert.rejects(
    () => taskInterrupt(e as any, result.taskPath),
    (err: unknown) =>
      err instanceof TaskLifecycleError &&
      err.code === "INVALID_TRANSITION"
  );

  const task = await loadTaskRecord(e.fs, result.taskPath);
  assert.equal(task.state, "submitted");
  assert.equal(task.statusDetail, undefined, "published TaskResult clears the prior return slot");
  assert.equal(task.currentResultId, delivered.result.id);
  const results = await loadTaskResults(e.fs, { taskId: task.id });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, delivered.result.id);
  assert.equal(results[0]!.status, "ready");
});

test("lifecycle: repeated interrupt preserves a corrupt Result pointer for explicit diagnosis", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, result.taskPath);
  await taskInterrupt(e as any, result.taskPath);

  await patchTaskRecord(e.fs, result.taskPath, {
    currentResultId: "rs-missing",
    statusDetail: { kind: "failed", error: "preserve interruption context" },
  });
  const repaired = await taskInterrupt(e as any, result.taskPath);

  assert.equal(repaired.state, "interrupted");
  assert.equal(repaired.currentResultId, "rs-missing");
  assert.deepEqual(repaired.statusDetail, {
    kind: "failed",
    error: "preserve interruption context",
  });

  const beforeInvalidPatch = await e.fs.readFile(result.taskPath);
  await assert.rejects(
    () => patchTaskRecord(e.fs, result.taskPath, { currentResultId: "rs-UPPER" }),
    /Invalid Task currentResultId/
  );
  assert.equal(await e.fs.readFile(result.taskPath), beforeInvalidPatch);
  await e.fs.writeFile(result.taskPath, beforeInvalidPatch.replace("rs-missing", "rs-UPPER"));
  await assert.rejects(() => loadTaskRecord(e.fs, result.taskPath), /Invalid Task currentResultId/);
});

test("lifecycle: persisted uppercase Task identity fails the canonical read boundary", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  const task = await loadTaskRecord(e.fs, result.taskPath);
  const raw = await e.fs.readFile(result.taskPath);
  await e.fs.writeFile(result.taskPath, raw.replace(`id: ${task.id}`, `id: ${task.id!.toUpperCase()}`));
  await assert.rejects(() => loadTaskRecord(e.fs, result.taskPath), /canonical task id is required/);
});

test("lifecycle: persisted Task requires a non-empty prompt body", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  const raw = await e.fs.readFile(result.taskPath);
  await e.fs.writeFile(result.taskPath, raw.replace(/(\n---\n)[\s\S]*$/, "$1"));
  await assert.rejects(() => loadTaskRecord(e.fs, result.taskPath), /non-empty prompt is required/);
});

test("lifecycle: Task owner namespace is exact for Role Tasks and stable for replaceable Session execution", async () => {
  const roleRoot = await makeTent();
  const roleFixture = await dispatchOnFreeNode(roleRoot);
  const roleRaw = await roleFixture.e.fs.readFile(roleFixture.result.taskPath);
  await roleFixture.e.fs.writeFile(
    roleFixture.result.taskPath,
    roleRaw.replace("assigneeRoleId: rl-executor", "assigneeRoleId: rl-other")
  );
  await assert.rejects(
    () => loadTaskRecord(roleFixture.e.fs, roleFixture.result.taskPath),
    /owner namespace/
  );

  const sessionRoot = await makeTent();
  const sessionEnv = env(sessionRoot);
  const sessionFixture = await dispatch(sessionEnv as any, "cx-p1", {
    workNodeIds: ["cx-p1"],
    contextNodeIds: [],
    prompt: "session namespace",
    requester: { kind: "user", id: "user" },
    executionSessionId: "ss-executor",
  });
  const sessionRaw = await sessionEnv.fs.readFile(sessionFixture.taskPath);
  await sessionEnv.fs.writeFile(
    sessionFixture.taskPath,
    sessionRaw.replace("executionSessionId: ss-executor", "executionSessionId: ss-other")
  );
  assert.equal(
    (await loadTaskRecord(sessionEnv.fs, sessionFixture.taskPath)).executionSessionId,
    "ss-other"
  );
  const invalidOwnerPath = sessionFixture.taskPath.replace(
    "temp/sessions/ss-executor/",
    "temp/sessions/not-a-session/"
  );
  await sessionEnv.fs.mkdir("temp/sessions/not-a-session/tasks");
  await sessionEnv.fs.writeFile(invalidOwnerPath, sessionRaw);
  await assert.rejects(
    () => loadTaskRecord(sessionEnv.fs, invalidOwnerPath),
    /owner namespace/
  );
});

test("lifecycle: exact Node occupation blocks peers but not parent, child, or sibling", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const r1 = await dispatchToRole(e as any, "cx-p1", "executor", {
    prompt: "first",
    requester: { kind: "user", id: "user" },
  });
  assert.equal((await loadTaskRecord(e.fs, r1.taskPath)).state, "queued");
  await assert.rejects(
    () => dispatchToRole(e as any, "cx-p1", "reviewer", {
      prompt: "overlap",
      requester: { kind: "user", id: "user" },
    }),
    /occupied by active task/,
  );
  const child = await dispatchToRole(e as any, "cx-p2", "reviewer", {
    prompt: "child",
    requester: { kind: "user", id: "user" },
  });
  assert.ok(child.taskPath);
  const parent = await dispatchToRole(e as any, "cx-promptzone", "reviewer", {
    prompt: "parent",
    requester: { kind: "user", id: "user" },
  });
  assert.ok(parent.taskPath);
  const r2 = await dispatchToRole(e as any, "cx-o1", "reviewer", {
    prompt: "sibling",
    requester: { kind: "user", id: "user" },
  });
  assert.ok(r2.taskPath);
  const active = await findActiveTaskForNode(e.fs, "cx-p1");
  assert.ok(active);
});

test("lifecycle: every terminal state releases exact Node occupation", async () => {
  const dir = await makeTent();
  const e = env(dir);

  const rejected = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, rejected.result.taskPath);
  const rejectedTaskResult = await taskSubmit(e as any, rejected.result.taskPath, { report: "reject me" });
  const rejectedResult = await taskReject(e as any, rejected.result.taskPath, {
    actor: "user",
    resultId: rejectedTaskResult.result.id,
    note: "not accepted",
    resume: false,
  });
  assert.equal(rejectedResult.task.state, "rejected");
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);

  const interrupted = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, interrupted.result.taskPath);
  const interruptedTask = await taskInterrupt(e as any, interrupted.result.taskPath);
  assert.equal(interruptedTask.state, "interrupted");
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);

  const failed = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, failed.result.taskPath);
  const failedTask = await taskFail(e as any, failed.result.taskPath, { summary: "provider failed" });
  assert.equal(failedTask.state, "failed");
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);

  const accepted = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, accepted.result.taskPath);
  const acceptedTaskResult = await taskSubmit(e as any, accepted.result.taskPath, { report: "accept me", commits: [] });
  const acceptedResult = await taskAccept(e as any, accepted.result.taskPath, {
    actor: "user",
    resultId: acceptedTaskResult.result.id,
  });
  assert.equal(acceptedResult.task.state, "accepted");
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);
});

test("lifecycle: taskFail releases exact Node occupation; idempotent re-dispatch", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, result.taskPath);
  assert.ok(await findActiveTaskForNode(e.fs, "cx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);

  const failed = await taskFail(e as any, result.taskPath, { summary: "provider crash" });
  assert.equal(failed.state, "failed");
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);

  // Idempotent second fail — no throw, occupation stays clear.
  const again = await taskFail(e as any, result.taskPath);
  assert.equal(again.state, "failed");
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);

  // Same box can be re-dispatched without fork / manual frontmatter edit.
  const r2 = await dispatchToRole(e as any, "cx-p1", "executor", {
    prompt: "retry after fail",
    requester: { kind: "user", id: "user" },
  });
  await taskClaim(e as any, r2.taskPath);
  assert.ok(await findActiveTaskForNode(e.fs, "cx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);
});

test("lifecycle: taskFail from waiting also clears occupation", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeNode(dir);
  await taskClaim(e as any, result.taskPath);
  await taskWait(e as any, result.taskPath, {
    reason: "user-input",
    summary: "await tool approval",
  });
  const failed = await taskFail(e as any, result.taskPath);
  assert.equal(failed.state, "failed");
  assert.ok(failed.wait == null, "wait must be cleared");
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);
});

test("contextCard: stable prompt template + parse round-trip", () => {
  const card = nodeContextCard("cx-abc123", "goal/demo", { tentRootHint: "/tents/demo" });
  assert.equal(card.templateVersion, "v1");
  assert.match(card.prompt, /Tent contextCard v1/);
  assert.match(card.prompt, /contextRef: node\/cx-abc123/);
  assert.match(card.prompt, /path: goal\/demo/);
  assert.match(card.prompt, /systemRoot: \/tents\/demo/);
  assert.match(card.prompt, /tentRoot: \/tents\/demo/);
  assert.match(card.prompt, /fileRead: \.tent\/goal\/demo/);
  assert.match(card.prompt, /Do not resolve operational files as <workspaceRoot>\/temp/);
  assert.doesNotMatch(card.prompt, /docs API|CLI aliases/i);
  const parsed = parseContextCardText(card.prompt);
  assert.deepEqual(parsed, {
    kind: "node",
    id: "cx-abc123",
    path: "goal/demo",
    fragment: undefined,
  });

  const dual = taskContextCard("tk-zzzz", {
    path: "temp/r/tasks/a.md",
    workspaceRoot: "/ws",
    systemRoot: "/ws/.tent",
  });
  assert.match(dual.prompt, /workspaceRoot: \/ws/);
  assert.match(dual.prompt, /systemRoot: \/ws\/\.tent/);
  assert.match(dual.prompt, /fileRead: \.tent\/temp\/r\/tasks\/a\.md/);
  assert.match(dual.prompt, /run tent from workspaceRoot/);

  const tCard = taskContextCard("tk-zzzz");
  assert.match(tCard.prompt, /task\/tk-zzzz/);
  const dCard = resultContextCard("rs-yyyy");
  assert.match(dCard.prompt, /result\/rs-yyyy/);
});
