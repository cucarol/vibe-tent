import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { dispatch } from "../src/core/ops.js";
import { loadTaskEnvelope } from "../src/core/task.js";
import { loadDeliveries } from "../src/core/delivery.js";
import {
  assertA2AAllow,
  boxProjectionOf,
  findActiveTaskForBox,
  gateStartSession,
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
  boxContextCard,
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

async function dispatchOnFreeBox(dir: string, role = "executor") {
  const e = env(dir);
  // bx-p1 is free (no owner) in makeTent fixture
  const result = await dispatch(e as any, "bx-p1", role, {
    userPrompt: "Implement the lifecycle slice",
  });
  return { e, result };
}

test("lifecycle: dispatch → claim → wait → resume → deliver → accept", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  let task = await loadTaskEnvelope(e.fs, result.taskPath);
  assert.equal(task.state, "queued");
  assert.equal(task.status, "pending");
  assert.ok(task.id?.startsWith("tk-"));
  assert.equal(task.deliveryPolicy, "review");

  task = await taskClaim(e as any, result.taskPath, { sessionId: "ss-test1" });
  assert.equal(task.state, "running");
  assert.equal(task.status, "taken");
  assert.equal(task.sessionId, "ss-test1");
  assert.ok(await findActiveTaskForBox(e.fs, "bx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("bx-p1")!);

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

  assert.equal(await findActiveTaskForBox(e.fs, "bx-p1"), undefined);
  assertNoFmCollab((await loadTent(e.fs)).byId.get("bx-p1")!);
});

test("lifecycle: self-accept is hard-forbidden", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, result.taskPath);
  await taskDeliver(e as any, result.taskPath, { summary: "ship it", commits: [] });

  await assert.rejects(
    () => taskAccept(e as any, result.taskPath, { actor: "executor" }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "SELF_ACCEPT_FORBIDDEN"
  );
});

test("lifecycle: agent-decide integrate auto-integrates without review.by=submitter", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const result = await dispatch(e as any, "bx-p1", "executor", {
    userPrompt: "auto path",
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
  const result = await dispatch(e as any, "bx-p1", "executor", {
    userPrompt: "bypass fail",
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
  assert.ok(await findActiveTaskForBox(e.fs, "bx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("bx-p1")!);
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
  assert.ok(await findActiveTaskForBox(e.fs, "bx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("bx-p1")!);
  const ready = (await loadDeliveries(e.fs)).find((d) => d.status === "ready");
  assert.ok(ready, "delivery stays ready for retry after integrate failure");
});

test("lifecycle: agent-decide without decision fails; review forbids integrate", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const r1 = await dispatch(e as any, "bx-p1", "executor", {
    userPrompt: "need decision",
    deliveryPolicy: "agent-decide",
  });
  await taskClaim(e as any, r1.taskPath);
  await assert.rejects(
    () => taskDeliver(e as any, r1.taskPath, { summary: "x" }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "DECISION_REQUIRED"
  );
  await taskInterrupt(e as any, r1.taskPath);

  const r2 = await dispatch(e as any, "bx-p1", "executor", {
    userPrompt: "review only",
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
  assert.ok(await findActiveTaskForBox(e.fs, "bx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("bx-p1")!);

  const second = await taskDeliver(e as any, result.taskPath, { summary: "second try with tests" });
  assert.equal(second.task.state, "delivered");
  assert.equal(second.delivery.status, "ready");
  const all = await loadDeliveries(e.fs);
  assert.ok(all.filter((d) => d.boxId === "bx-p1").length >= 2);
});

test("lifecycle: cancel queued; interrupt running clears occupation", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  await taskCancel(e as any, result.taskPath);
  assert.equal(await e.fs.exists(result.taskPath), false);

  const r2 = await dispatch(e as any, "bx-p1", "executor", { userPrompt: "again" });
  await taskClaim(e as any, r2.taskPath);
  await taskInterrupt(e as any, r2.taskPath);
  assert.equal(await findActiveTaskForBox(e.fs, "bx-p1"), undefined);
  assertNoFmCollab((await loadTent(e.fs)).byId.get("bx-p1")!);
  const task = await loadTaskEnvelope(e.fs, r2.taskPath);
  assert.equal(task.state, "interrupted");
});

test("lifecycle: residual disk owner/status is stripped on load and does not block claim", async () => {
  const dir = await makeTent();
  const e = env(dir);
  // Write residual owner/status on disk — loadTent strips from memory; claim ignores them.
  const note = "goal/挖新alpha/写表达式/写表达式.md";
  const raw = await e.fs.readFile(note);
  await e.fs.writeFile(note, raw.replace("type: goal", "type: goal\nowner: executor\nstatus: doing"));
  const r = await dispatch(e as any, "bx-g2", "reviewer", {
    userPrompt: "reclaim after orphan owner",
  });
  assert.ok(r.taskPath);
  const claimed = await taskClaim(e as any, r.taskPath);
  assert.equal(claimed.state, "running");
  assertNoFmCollab((await loadTent(e.fs)).byId.get("bx-g2")!);
  const active = await findActiveTaskForBox(e.fs, "bx-g2");
  assert.ok(active);
  assert.equal(active!.role, "reviewer");
});

test("lifecycle: second active task on same box is rejected (envelope oracle)", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const r1 = await dispatch(e as any, "bx-p1", "executor", { userPrompt: "first" });
  assert.equal((await loadTaskEnvelope(e.fs, r1.taskPath)).state, "queued");
  await assert.rejects(
    () => dispatch(e as any, "bx-p1", "reviewer", { userPrompt: "overlap" }),
    /already occupied by active task|Cannot dispatch/
  );
  // Peer claim of a different free box still works (bx-o1 is outside p1 subtree).
  const r2 = await dispatch(e as any, "bx-o1", "reviewer", { userPrompt: "other box" });
  assert.ok(r2.taskPath);
});

test("lifecycle: active root claim blocks box dispatch (root-vs-box)", async () => {
  const dir = await makeTent();
  const e = env(dir);
  await e.fs.writeFile(
    "temp/executor/tasks/task-root-active.md",
    [
      "---",
      "type: task",
      "id: tk-root1",
      "status: taken",
      "state: running",
      "role: executor",
      "claims: [root]",
      "manifest: temp/executor/manifest.yml",
      "---",
      "# root occupation",
      "",
    ].join("\n")
  );
  await assert.rejects(
    () => dispatch(e as any, "bx-p1", "reviewer", { userPrompt: "blocked by root" }),
    /Tent root is occupied by active task|Cannot dispatch/
  );
  await assert.rejects(
    () => dispatch(e as any, "bx-o1", "reviewer", { userPrompt: "also blocked" }),
    /Tent root is occupied by active task|Cannot dispatch/
  );
});

test("lifecycle: asSub cannot bypass active root occupation", async () => {
  const dir = await makeTent();
  const e = env(dir);
  await e.fs.writeFile(
    "temp/architect/tasks/task-root-arch.md",
    [
      "---",
      "type: task",
      "id: tk-rootarch",
      "status: taken",
      "state: running",
      "role: architect",
      "claims: [root]",
      "manifest: temp/architect/manifest.yml",
      "---",
      "# root by architect",
      "",
    ].join("\n")
  );
  // asSub under the root holder still must not open a child box — root is tent-wide.
  await assert.rejects(
    () =>
      dispatch(e as any, "bx-p1", "helper", {
        userPrompt: "sub under root holder",
        asSub: true,
        dispatchedBy: "architect",
      }),
    /Tent root is occupied by active task|Cannot dispatch/
  );
});

test("lifecycle: legacy envelope without state still occupies via status", async () => {
  const dir = await makeTent();
  const e = env(dir);
  await e.fs.writeFile(
    "temp/executor/tasks/task-legacy-only.md",
    [
      "---",
      "type: task",
      "id: tk-legacy1",
      "status: pending",
      "role: executor",
      "claims: [bx-p1]",
      "manifest: temp/executor/manifest.yml",
      "---",
      "# legacy",
      "",
    ].join("\n")
  );
  // loadTaskEnvelope normalizes state from legacy status when missing.
  const legacy = await loadTaskEnvelope(e.fs, "temp/executor/tasks/task-legacy-only.md");
  assert.equal(legacy.state, "queued");
  await assert.rejects(
    () => dispatch(e as any, "bx-p1", "reviewer", { userPrompt: "blocked by legacy" }),
    /already occupied by active task|Cannot dispatch/
  );
  const proj = boxProjectionOf(legacy);
  assert.equal(proj.status, "doing");
  assert.equal(proj.assignee, "executor");
  assert.ok(proj.activeTaskId);
});

test("lifecycle: taskFail releases occupation; idempotent; re-dispatch same box", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  await taskClaim(e as any, result.taskPath);
  assert.ok(await findActiveTaskForBox(e.fs, "bx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("bx-p1")!);

  const failed = await taskFail(e as any, result.taskPath, { summary: "provider crash" });
  assert.equal(failed.state, "failed");
  assert.equal(await findActiveTaskForBox(e.fs, "bx-p1"), undefined);
  assertNoFmCollab((await loadTent(e.fs)).byId.get("bx-p1")!);

  // Idempotent second fail — no throw, occupation stays clear.
  const again = await taskFail(e as any, result.taskPath);
  assert.equal(again.state, "failed");
  assert.equal(await findActiveTaskForBox(e.fs, "bx-p1"), undefined);
  assertNoFmCollab((await loadTent(e.fs)).byId.get("bx-p1")!);

  // Same box can be re-dispatched without fork / manual frontmatter edit.
  const r2 = await dispatch(e as any, "bx-p1", "executor", { userPrompt: "retry after fail" });
  await taskClaim(e as any, r2.taskPath);
  assert.ok(await findActiveTaskForBox(e.fs, "bx-p1"));
  assertNoFmCollab((await loadTent(e.fs)).byId.get("bx-p1")!);
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
  assert.equal(await findActiveTaskForBox(e.fs, "bx-p1"), undefined);
  assertNoFmCollab((await loadTent(e.fs)).byId.get("bx-p1")!);
});

test("lifecycle: A2A gate deny/ask/allow", () => {
  assert.equal(gateStartSession({ callerKind: "user" }), "allow");
  assert.equal(gateStartSession({ callerKind: "role", policy: "deny" }), "deny");
  assert.equal(gateStartSession({ callerKind: "role", policy: "ask" }), "ask");
  assert.equal(
    gateStartSession({ callerKind: "role", policy: "allow", profileAllowed: true }),
    "allow"
  );
  assert.equal(
    gateStartSession({ callerKind: "role", policy: "allow", profileAllowed: false }),
    "deny"
  );
  assert.throws(
    () => assertA2AAllow({ callerKind: "role", policy: "deny" }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "A2A_DENIED"
  );
});

test("lifecycle: box projection + findActiveTaskForBox", async () => {
  const dir = await makeTent();
  const { e, result } = await dispatchOnFreeBox(dir);
  assert.equal(boxProjectionOf(undefined).status, "todo");
  let task = await loadTaskEnvelope(e.fs, result.taskPath);
  assert.equal(boxProjectionOf(task).status, "doing");
  assert.equal(boxProjectionOf(task).assignee, "executor");
  await taskClaim(e as any, result.taskPath);
  const active = await findActiveTaskForBox(e.fs, "bx-p1");
  assert.ok(active);
  assert.equal(active!.state, "running");
});

test("contextCard: stable prompt template + parse round-trip", () => {
  const card = boxContextCard("cx-abc123", "goal/demo", { tentRootHint: "/tents/demo" });
  assert.equal(card.templateVersion, "v1");
  assert.match(card.prompt, /Tent contextCard v1/);
  assert.match(card.prompt, /contextRef: box\/cx-abc123/);
  assert.match(card.prompt, /path: goal\/demo/);
  assert.match(card.prompt, /systemRoot: \/tents\/demo/);
  assert.match(card.prompt, /tentRoot: \/tents\/demo/);
  assert.match(card.prompt, /fileRead: \.tent\/goal\/demo/);
  assert.match(card.prompt, /Do not resolve operational files as <workspaceRoot>\/temp/);
  assert.doesNotMatch(card.prompt, /docs API|CLI aliases/i);
  const parsed = parseContextCardText(card.prompt);
  assert.deepEqual(parsed, {
    kind: "box",
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
