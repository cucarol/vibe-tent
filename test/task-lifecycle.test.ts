import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { dispatch } from "../src/core/ops.js";
import { loadTaskEnvelope, patchTaskEnvelope } from "../src/core/task.js";
import { loadDeliveries, writeDelivery } from "../src/core/delivery.js";
import {
  finalizeTaskAccept,
  findActiveTaskForNode,
  prepareTaskAccept,
  taskAccept,
  taskCancel,
  taskClaim,
  taskDeliver,
  taskFail,
  taskInterrupt,
  taskReject,
  taskResume,
  taskWait,
} from "../src/core/task-lifecycle.js";
import { TaskLifecycleError } from "../src/core/task-model.js";
import {
  nodeContextCard,
  deliveryContextCard,
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
    roleId,
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    ...(typeof input === "string" ? { userPrompt: input } : input),
  });
}

async function dispatchOnFreeBox(dir: string, role = "executor") {
  const e = env(dir);
  // cx-p1 is free (no owner) in makeTent fixture
  const result = await dispatchToRole(e as any, "cx-p1", role, {
    userPrompt: "Implement the lifecycle slice",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  return { e, result };
}

test("lifecycle: first Role claim atomically binds the exact caller Session", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, result.taskPath, {
    claimWrite: { sessionId: "ss-caller" },
  });
  const task = await loadTaskEnvelope(e.fs, result.taskPath);
  assert.equal(task.state, "running");
  assert.equal(task.roleId, "rl-executor");
  assert.equal(task.sessionId, "ss-caller");
});

test("lifecycle: queued Task cannot replace an already-bound Session during claim", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const result = await dispatch(e as any, "cx-p1", {
    sessionId: "ss-bounda",
    userPrompt: "Keep the exact pre-bound Session",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  const before = await e.fs.readFile(result.taskPath);

  await assert.rejects(
    () =>
      taskClaim(e as any, result.taskPath, {
        claimWrite: { sessionId: "ss-boundb" },
      }),
    /different Session/
  );

  assert.equal(await e.fs.readFile(result.taskPath), before, "failed claim must be zero-mutation");
  const task = await loadTaskEnvelope(e.fs, result.taskPath);
  assert.equal(task.state, "queued");
  assert.equal(task.sessionId, "ss-bounda");
});

test("lifecycle: dispatch → claim → wait → resume → deliver → accept", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  let task = await loadTaskEnvelope(e.fs, result.taskPath);
  assert.equal(task.state, "queued");
  assert.ok(task.id?.startsWith("tk-"));
  assert.equal(task.deliveryPolicy, "review");

  task = await taskClaim(e as any, result.taskPath);
  assert.equal(task.state, "running");
  assert.equal(task.sessionId, undefined, "claim must not bind a Session");
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

  const delivered = await taskDeliver(e as any, result.taskPath, {
    summary: "Done with tests",
    commits: ["abc1234"],
  });
  assert.equal(delivered.autoIntegrated, false);
  assert.equal(delivered.task.state, "delivered");
  assert.equal(delivered.delivery.status, "ready");
  assert.ok(delivered.delivery.id.startsWith("dl-"));

  let integrated: string[] = [];
  const accepted = await taskAccept(e as any, result.taskPath, {
    actor: "user",
    integrate: async (commits) => {
      integrated = commits;
    },
  });
  assert.deepEqual(integrated, ["abc1234"]);
  assert.equal(accepted.task.state, "accepted");
  assert.equal(accepted.delivery.status, "accepted");
  assert.equal(accepted.delivery.review?.by, "user");
  assert.equal(accepted.delivery.integrationMode, "manual-accept");

  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);
});

test("lifecycle: finalize rejects a ready Delivery commit-list drift without mutation", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, result.taskPath);
  await taskDeliver(e as any, result.taskPath, {
    summary: "ready",
    commits: ["aaa1111"],
  });

  const prepared = await prepareTaskAccept(e as any, result.taskPath, { actor: "user" });
  assert.deepEqual(prepared.commits, ["aaa1111"]);
  const delivery = (await loadDeliveries(e.fs)).find((row) => row.id === prepared.deliveryId);
  assert.ok(delivery);
  delivery.commits = ["bbb2222"];
  await writeDelivery(e.fs, delivery);

  await assert.rejects(
    () => finalizeTaskAccept(e as any, result.taskPath, { actor: "user" }, prepared),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "DELIVERY_CHANGED"
  );
  const task = await loadTaskEnvelope(e.fs, result.taskPath);
  assert.equal(task.state, "delivered");
  const current = (await loadDeliveries(e.fs)).find((row) => row.id === prepared.deliveryId);
  assert.equal(current?.status, "ready");
  assert.deepEqual(current?.commits, ["bbb2222"]);
});

test("lifecycle: zero-commit ready Delivery remains legal to accept", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, result.taskPath);
  await taskDeliver(e as any, result.taskPath, {
    summary: "non-code result",
    commits: [],
  });

  const accepted = await taskAccept(e as any, result.taskPath, { actor: "user" });
  assert.equal(accepted.task.state, "accepted");
  assert.equal(accepted.delivery.status, "accepted");
  assert.deepEqual(accepted.delivery.commits, []);
});

test("lifecycle: self-accept is hard-forbidden", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, result.taskPath);
  await taskDeliver(e as any, result.taskPath, { summary: "ship it", commits: [] });

  await assert.rejects(
    () => taskAccept(e as any, result.taskPath, { actor: "rl-executor" }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "SELF_ACCEPT_FORBIDDEN"
  );
});

test("lifecycle: agent-decide integrate auto-integrates without review.by=submitter", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const result = await dispatchToRole(e as any, "cx-p1", "executor", {
    userPrompt: "auto path",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    deliveryPolicy: "agent-decide",
  });
  await taskClaim(e as any, result.taskPath);
  let integrated: string[] = [];
  const out = await taskDeliver(e as any, result.taskPath, {
    summary: "agent chose integrate",
    commits: ["deadbee"],
    decision: "integrate",
    integrate: async (c) => {
      integrated = c;
    },
  });
  assert.equal(out.autoIntegrated, true);
  assert.equal(out.task.state, "accepted");
  assert.equal(out.delivery.integrationMode, "agent-decided-integrate");
  assert.equal(out.delivery.review, undefined);
  assert.deepEqual(integrated, ["deadbee"]);
});

test("lifecycle: auto-integrate failure keeps running, no delivery, occupation held", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const result = await dispatchToRole(e as any, "cx-p1", "executor", {
    userPrompt: "bypass fail",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    deliveryPolicy: "bypass",
  });
  await taskClaim(e as any, result.taskPath);
  await assert.rejects(
    () =>
      taskDeliver(e as any, result.taskPath, {
        summary: "will fail integrate",
        commits: ["abc"],
        integrate: async () => {
          throw new Error("Workspace integration conflicted and was rolled back");
        },
      }),
    /Workspace integration conflicted/
  );
  const task = await loadTaskEnvelope(e.fs, result.taskPath);
  assert.equal(task.state, "running");
  assert.equal((await loadDeliveries(e.fs)).length, 0);
  assert.ok(await findActiveTaskForNode(e.fs, "cx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);
});

test("lifecycle: manual accept integrate failure keeps delivered + occupation", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, result.taskPath);
  await taskDeliver(e as any, result.taskPath, {
    summary: "ready",
    commits: ["abc1234"],
  });
  await assert.rejects(
    () =>
      taskAccept(e as any, result.taskPath, {
        actor: "user",
        integrate: async () => {
          throw new Error("Workspace integration conflicted and was rolled back");
        },
      }),
    /Workspace integration conflicted/
  );
  const task = await loadTaskEnvelope(e.fs, result.taskPath);
  assert.equal(task.state, "delivered");
  assert.ok(await findActiveTaskForNode(e.fs, "cx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);
  const ready = (await loadDeliveries(e.fs)).find((d) => d.status === "ready");
  assert.ok(ready, "delivery stays ready for retry after integrate failure");
});

test("lifecycle: agent-decide without decision fails; review forbids integrate", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const r1 = await dispatchToRole(e as any, "cx-p1", "executor", {
    userPrompt: "need decision",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    deliveryPolicy: "agent-decide",
  });
  await taskClaim(e as any, r1.taskPath);
  await assert.rejects(
    () => taskDeliver(e as any, r1.taskPath, { summary: "x" }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "DECISION_REQUIRED"
  );
  await taskInterrupt(e as any, r1.taskPath);

  const r2 = await dispatchToRole(e as any, "cx-p1", "executor", {
    userPrompt: "review only",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    deliveryPolicy: "review",
  });
  await taskClaim(e as any, r2.taskPath);
  await assert.rejects(
    () =>
      taskDeliver(e as any, r2.taskPath, {
        summary: "nope",
        decision: "integrate",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "POLICY_FORBIDS_AUTO_INTEGRATE"
  );
});

test("lifecycle: reject(resume) returns to running; re-deliver works", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, result.taskPath);
  await taskDeliver(e as any, result.taskPath, { summary: "first try" });
  const rejected = await taskReject(e as any, result.taskPath, {
    actor: "user",
    note: "add tests",
    resume: true,
  });
  assert.equal(rejected.task.state, "running");
  assert.equal(rejected.delivery.status, "rejected");
  assert.ok(await findActiveTaskForNode(e.fs, "cx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);

  const second = await taskDeliver(e as any, result.taskPath, { summary: "second try with tests" });
  assert.equal(second.task.state, "delivered");
  assert.equal(second.delivery.status, "ready");
  const all = await loadDeliveries(e.fs);
  assert.ok(all.filter((d) => d.sourceNodeId === "cx-p1").length >= 2);
});

test("lifecycle: cancel queued; interrupt running clears occupation", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  await taskCancel(e as any, result.taskPath);
  assert.equal(await e.fs.exists(result.taskPath), false);

  const r2 = await dispatchToRole(e as any, "cx-p1", "executor", {
    userPrompt: "again",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  await taskClaim(e as any, r2.taskPath);
  await taskInterrupt(e as any, r2.taskPath);
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);
  const task = await loadTaskEnvelope(e.fs, r2.taskPath);
  assert.equal(task.state, "interrupted");
});

test("lifecycle: published Delivery wins over interrupt and remains reviewable", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, result.taskPath);
  const delivered = await taskDeliver(e as any, result.taskPath, {
    summary: "published before interrupt",
    lastOutcome: "delivered",
  });

  await assert.rejects(
    () => taskInterrupt(e as any, result.taskPath),
    (err: unknown) =>
      err instanceof TaskLifecycleError &&
      err.code === "INVALID_TRANSITION"
  );

  const task = await loadTaskEnvelope(e.fs, result.taskPath);
  assert.equal(task.state, "delivered");
  assert.equal(task.lastOutcome, "delivered");
  assert.equal(task.activeDeliveryId, delivered.delivery.id);
  const deliveries = await loadDeliveries(e.fs, { taskId: task.id });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.id, delivered.delivery.id);
  assert.equal(deliveries[0]!.status, "ready");
});

test("lifecycle: repeated interrupt repairs dangling Delivery projection", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, result.taskPath);
  await taskInterrupt(e as any, result.taskPath);

  await patchTaskEnvelope(e.fs, result.taskPath, {
    activeDeliveryId: "dl-missing",
    lastOutcome: "delivered",
  });
  const repaired = await taskInterrupt(e as any, result.taskPath);

  assert.equal(repaired.state, "interrupted");
  assert.equal(repaired.activeDeliveryId, undefined);
  assert.equal(repaired.lastOutcome, undefined);
});

test("lifecycle: exact Node occupation blocks peers but not parent, child, or sibling", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const r1 = await dispatchToRole(e as any, "cx-p1", "executor", {
    userPrompt: "first",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  assert.equal((await loadTaskEnvelope(e.fs, r1.taskPath)).state, "queued");
  await assert.rejects(
    () => dispatchToRole(e as any, "cx-p1", "reviewer", {
      userPrompt: "overlap",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    }),
    /occupied by active task/,
  );
  const child = await dispatchToRole(e as any, "cx-p2", "reviewer", {
    userPrompt: "child",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  assert.ok(child.taskPath);
  const parent = await dispatchToRole(e as any, "cx-promptzone", "reviewer", {
    userPrompt: "parent",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  assert.ok(parent.taskPath);
  const r2 = await dispatchToRole(e as any, "cx-o1", "reviewer", {
    userPrompt: "sibling",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  assert.ok(r2.taskPath);
  const active = await findActiveTaskForNode(e.fs, "cx-p1");
  assert.ok(active);
});

test("lifecycle: every terminal state releases exact Node occupation", async () => {
  const dir = await makeTent();
  const e = env(dir);

  const rejected = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, rejected.result.taskPath);
  await taskDeliver(e as any, rejected.result.taskPath, { summary: "reject me" });
  const rejectedResult = await taskReject(e as any, rejected.result.taskPath, {
    actor: "user",
    note: "not accepted",
    resume: false,
  });
  assert.equal(rejectedResult.task.state, "rejected");
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);

  const interrupted = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, interrupted.result.taskPath);
  const interruptedTask = await taskInterrupt(e as any, interrupted.result.taskPath);
  assert.equal(interruptedTask.state, "interrupted");
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);

  const failed = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, failed.result.taskPath);
  const failedTask = await taskFail(e as any, failed.result.taskPath, { summary: "provider failed" });
  assert.equal(failedTask.state, "failed");
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);

  const accepted = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, accepted.result.taskPath);
  await taskDeliver(e as any, accepted.result.taskPath, { summary: "accept me", commits: [] });
  const acceptedResult = await taskAccept(e as any, accepted.result.taskPath, { actor: "user" });
  assert.equal(acceptedResult.task.state, "accepted");
  assert.equal(await findActiveTaskForNode(e.fs, "cx-p1"), undefined);
});

test("lifecycle: taskFail releases exact Node occupation; idempotent re-dispatch", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
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
    userPrompt: "retry after fail",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  await taskClaim(e as any, r2.taskPath);
  assert.ok(await findActiveTaskForNode(e.fs, "cx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("cx-p1")!);
});

test("lifecycle: taskFail from waiting also clears occupation", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
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
  const dCard = deliveryContextCard("dl-yyyy");
  assert.match(dCard.prompt, /delivery\/dl-yyyy/);
});
