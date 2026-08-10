import assert from "node:assert/strict";
import { test } from "node:test";
import type { FsAdapter } from "../src/core/adapter.js";
import { createDelivery, loadDeliveries, writeDelivery, type DeliveryRecord } from "../src/core/delivery.js";
import { dispatch } from "../src/core/ops.js";
import {
  finalizeTaskAccept,
  finalizeTaskDeliverAuto,
  prepareTaskAccept,
  prepareTaskDeliver,
  taskCancel,
  taskClaim,
  taskAccept,
  taskDeliver,
  taskFail,
  taskInterrupt,
  taskReject,
  taskResume,
  taskWait,
  type TaskDeliverOptions,
} from "../src/core/task-lifecycle.js";
import { loadTaskEnvelope, patchTaskEnvelope, type TaskEnvelope } from "../src/core/task.js";
import type { AcceptMode } from "../src/core/task-model.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { makeTent } from "./helpers.js";

type FaultRule = {
  operation: "writeFile" | "remove";
  path: (path: string) => boolean;
  timing: "before" | "after";
};

function faultInject(base: FsAdapter): { fs: FsAdapter; arm(rule: FaultRule): void } {
  let fault: FaultRule | undefined;
  const trip = (operation: FaultRule["operation"], path: string, timing: FaultRule["timing"]): void => {
    if (!fault || fault.operation !== operation || fault.timing !== timing || !fault.path(path)) return;
    fault = undefined;
    throw new Error(`fault ${timing} ${operation}:${path}`);
  };
  const fs = new Proxy(base, {
    get(target, property) {
      if (property === "writeFile") {
        return async (path: string, content: string): Promise<void> => {
          trip("writeFile", path, "before");
          await target.writeFile(path, content);
          trip("writeFile", path, "after");
        };
      }
      if (property === "remove") {
        return async (path: string): Promise<void> => {
          trip("remove", path, "before");
          await target.remove(path);
          trip("remove", path, "after");
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as FsAdapter;
  return {
    fs,
    arm(rule) {
      assert.equal(fault, undefined, "one fault at a time");
      fault = rule;
    },
  };
}

const isDeliveryPath = (path: string): boolean => /[\\/]deliveries[\\/].+\.md$/.test(path);
const isRejectIntentPath = (path: string): boolean => path.endsWith(".delivery-reject-intent.json");

async function runningTask(
  acceptMode: AcceptMode,
  owner: "role" | "session" = "role",
  nodeId = "cx-p1"
) {
  const dir = await makeTent();
  const base = new NodeFs(dir);
  await base.writeFile(
    "roles.json",
    JSON.stringify({ roles: [{ id: "rl-executor", name: "executor", displayName: "executor" }] }, null, 2) + "\n"
  );
  const env = {
    fs: base as FsAdapter,
    clock: { now: () => "2026-08-10T01:00:00.000Z" },
    tentName: "recovery",
    tentRoot: dir,
  };
  const dispatched = await dispatch(env as never, nodeId, {
    ...(owner === "role" ? { roleId: "rl-executor" } : { sessionId: "ss-recovery" }),
    workNodeIds: [nodeId],
    contextNodeIds: [],
    userPrompt: "fault-injected lifecycle",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    acceptMode,
  });
  await taskClaim(env as never, dispatched.taskPath);
  const injected = faultInject(base);
  env.fs = injected.fs;
  return { base, env, taskPath: dispatched.taskPath, ...injected };
}

const richOptions: TaskDeliverOptions = {
  summary: "one durable candidate",
  commits: ["a".repeat(40)],
  targetHead: "b".repeat(40),
  checks: [{ name: "focused", command: "npm test", exitCode: 0 }],
  artifactRefs: [
    { kind: "path", target: "dist/result.txt", label: "result" },
    { kind: "url", target: "https://example.invalid/evidence", label: "evidence" },
  ],
};

async function taskAndDeliveries(base: NodeFs, taskPath: string): Promise<{
  task: TaskEnvelope;
  deliveries: DeliveryRecord[];
}> {
  const task = await loadTaskEnvelope(base, taskPath);
  return { task, deliveries: await loadDeliveries(base, { taskId: task.id || task.path }) };
}

async function hasRejectIntent(base: NodeFs, taskPath: string): Promise<boolean> {
  const taskDir = taskPath.slice(0, taskPath.lastIndexOf("/"));
  return (await base.listDir(taskDir)).some((entry) =>
    entry.name.endsWith(".delivery-reject-intent.json")
  );
}

for (const target of ["delivery", "task"] as const) {
  for (const timing of ["before", "after"] as const) {
    test(`prepareTaskDeliver recovers ${target} write ${timing} without duplicate publication`, async () => {
      const { base, env, taskPath, arm } = await runningTask("review-required");
      arm({
        operation: "writeFile",
        path: target === "delivery" ? isDeliveryPath : (path) => path === taskPath,
        timing,
      });
      await assert.rejects(() => taskDeliver(env as never, taskPath, richOptions), /fault/);

      const recovered = await taskDeliver(env as never, taskPath, richOptions);
      const state = await taskAndDeliveries(base, taskPath);
      assert.equal(recovered.task.state, "delivered");
      assert.equal(state.deliveries.length, 1);
      assert.equal(recovered.delivery.id, state.deliveries[0]!.id);
    });
  }
}

for (const target of ["delivery", "task"] as const) {
  for (const timing of ["before", "after"] as const) {
    test(`finalizeTaskDeliverAuto recovers ${target} write ${timing}`, async () => {
      const { base, env, taskPath, arm } = await runningTask("auto-accept");
      const options = { ...richOptions, commits: [], targetHead: undefined };
      const prepared = await prepareTaskDeliver(env as never, taskPath, options);
      assert.equal(prepared.kind, "auto");
      if (prepared.kind !== "auto") return;
      arm({
        operation: "writeFile",
        path: target === "delivery" ? isDeliveryPath : (path) => path === taskPath,
        timing,
      });
      await assert.rejects(
        () => finalizeTaskDeliverAuto(env as never, taskPath, options, prepared),
        /fault/
      );

      const recovered = await finalizeTaskDeliverAuto(env as never, taskPath, options, prepared);
      const state = await taskAndDeliveries(base, taskPath);
      assert.equal(recovered.task.state, "accepted");
      assert.equal(recovered.delivery.status, "accepted");
      assert.equal(state.deliveries.length, 1);
    });
  }
}

const rejectBoundaries = [
  { name: "intent write", operation: "writeFile" as const, path: isRejectIntentPath },
  { name: "Delivery write", operation: "writeFile" as const, path: isDeliveryPath },
  { name: "Task write", operation: "writeFile" as const, path: (_path: string, taskPath: string) => _path === taskPath },
  { name: "intent remove", operation: "remove" as const, path: isRejectIntentPath },
];

for (const resume of [true, false] as const) {
  for (const boundary of rejectBoundaries) {
    for (const timing of ["before", "after"] as const) {
      test(`taskReject ${resume ? "resume" : "terminal"} recovers ${boundary.name} ${timing}`, async () => {
        const { base, env, taskPath, arm } = await runningTask("review-required");
        const delivered = await taskDeliver(env as never, taskPath, { summary: "review me" });
        const options = {
          actor: "user",
          deliveryId: delivered.delivery.id,
          note: resume ? "revise" : "close",
          resume,
        };
        arm({
          operation: boundary.operation,
          path: (path) => boundary.path(path, taskPath),
          timing,
        });
        await assert.rejects(() => taskReject(env as never, taskPath, options), /fault/);

        const recovered = await taskReject(env as never, taskPath, options);
        const state = await taskAndDeliveries(base, taskPath);
        assert.equal(recovered.task.state, resume ? "running" : "rejected");
        assert.equal(recovered.delivery.review?.note, options.note);
        assert.equal(state.deliveries.length, 1);
        assert.equal(
          (await base.listDir(taskPath.slice(0, taskPath.lastIndexOf("/")))).some((entry) =>
            entry.name.endsWith(".delivery-reject-intent.json")
          ),
          false
        );
      });
    }
  }
}

test("post-WAL task.deliver recovery converges prior candidate then rejects a mismatched retry", async () => {
  const { base, env, taskPath, arm } = await runningTask("review-required");
  arm({ operation: "writeFile", path: (path) => path === taskPath, timing: "before" });
  await assert.rejects(() => taskDeliver(env as never, taskPath, richOptions), /fault/);
  const before = await taskAndDeliveries(base, taskPath);
  assert.equal(before.task.state, "running");
  assert.equal(before.deliveries.length, 1);
  const deliveryRaw = await base.readFile(before.deliveries[0]!.path);

  await assert.rejects(
    () => taskDeliver(env as never, taskPath, { ...richOptions, summary: "different retry" }),
    (error: unknown) => (error as { code?: string }).code === "DELIVERY_CHANGED"
  );
  const after = await taskAndDeliveries(base, taskPath);
  assert.equal(after.task.state, "delivered", "the prior committed WAL must converge first");
  assert.equal(after.deliveries.length, 1);
  assert.equal(await base.readFile(after.deliveries[0]!.path), deliveryRaw);
});

for (const originalOutcome of ["delivered", undefined] as const) {
  test(`ready Delivery WAL preserves ${originalOutcome ?? "absent"} lastOutcome against mismatched retry`, async () => {
    const { base, env, taskPath, arm } = await runningTask("review-required");
    const original: TaskDeliverOptions = {
      summary: "outcome WAL",
      ...(originalOutcome ? { lastOutcome: originalOutcome } : {}),
    };
    arm({ operation: "writeFile", path: (path) => path === taskPath, timing: "before" });
    await assert.rejects(() => taskDeliver(env as never, taskPath, original), /fault/);

    const mismatch: TaskDeliverOptions = {
      summary: original.summary,
      ...(originalOutcome ? {} : { lastOutcome: "delivered" }),
    };
    await assert.rejects(
      () => taskDeliver(env as never, taskPath, mismatch),
      (error: unknown) => (error as { code?: string }).code === "DELIVERY_CHANGED"
    );
    const task = await loadTaskEnvelope(base, taskPath);
    assert.equal(task.state, "delivered");
    assert.equal(task.lastOutcome, originalOutcome);
  });
}

test("accepted auto-delivery WAL repairs Task before rejecting mismatched finalize args", async () => {
  const { base, env, taskPath, arm } = await runningTask("auto-accept");
  const options: TaskDeliverOptions = { summary: "auto WAL", checks: [{ name: "ok", command: "check", exitCode: 0 }] };
  const prepared = await prepareTaskDeliver(env as never, taskPath, options);
  assert.equal(prepared.kind, "auto");
  if (prepared.kind !== "auto") return;
  arm({ operation: "writeFile", path: (path) => path === taskPath, timing: "before" });
  await assert.rejects(() => finalizeTaskDeliverAuto(env as never, taskPath, options, prepared), /fault/);

  await assert.rejects(
    () => finalizeTaskDeliverAuto(env as never, taskPath, { ...options, summary: "new request" }, prepared),
    (error: unknown) => (error as { code?: string }).code === "DELIVERY_CHANGED"
  );
  assert.equal((await loadTaskEnvelope(base, taskPath)).state, "accepted");
  const exact = await finalizeTaskDeliverAuto(env as never, taskPath, options, prepared);
  assert.equal(exact.task.state, "accepted");
  assert.equal((await loadDeliveries(base)).length, 1);
});

for (const originalOutcome of ["delivered", undefined] as const) {
  test(`accepted Delivery WAL preserves ${originalOutcome ?? "absent"} lastOutcome against mismatched finalize`, async () => {
    const { base, env, taskPath, arm } = await runningTask("auto-accept");
    const original: TaskDeliverOptions = {
      summary: "accepted outcome WAL",
      ...(originalOutcome ? { lastOutcome: originalOutcome } : {}),
    };
    const prepared = await prepareTaskDeliver(env as never, taskPath, original);
    assert.equal(prepared.kind, "auto");
    if (prepared.kind !== "auto") return;
    arm({ operation: "writeFile", path: (path) => path === taskPath, timing: "before" });
    await assert.rejects(() => finalizeTaskDeliverAuto(env as never, taskPath, original, prepared), /fault/);

    const mismatch: TaskDeliverOptions = {
      summary: original.summary,
      ...(originalOutcome ? {} : { lastOutcome: "delivered" }),
    };
    await assert.rejects(
      () => finalizeTaskDeliverAuto(env as never, taskPath, mismatch, prepared),
      (error: unknown) => (error as { code?: string }).code === "DELIVERY_CHANGED"
    );
    const task = await loadTaskEnvelope(base, taskPath);
    assert.equal(task.state, "accepted");
    assert.equal(task.lastOutcome, originalOutcome);
  });
}

test("checks compare field-wise and artifact refs compare after canonical normalization", async () => {
  const { base, env, taskPath, arm } = await runningTask("review-required");
  arm({ operation: "writeFile", path: (path) => path === taskPath, timing: "before" });
  await assert.rejects(() => taskDeliver(env as never, taskPath, richOptions), /fault/);

  const equivalent = {
    ...richOptions,
    checks: [{ command: "npm test", exitCode: 0, name: "focused" }],
    artifactRefs: [...(richOptions.artifactRefs ?? [])].reverse(),
  };
  const recovered = await taskDeliver(env as never, taskPath, equivalent);
  assert.equal(recovered.task.state, "delivered");

  const rawBefore = await base.readFile(recovered.delivery.path);
  await assert.rejects(
    () => taskDeliver(env as never, taskPath, {
      ...equivalent,
      checks: [{ name: "focused", command: "npm test", exitCode: 1 }],
    }),
    (error: unknown) => (error as { code?: string }).code === "DELIVERY_CHANGED"
  );
  assert.equal(await base.readFile(recovered.delivery.path), rawBefore);
});

test("post-intent task.reject converges the committed request then rejects mismatched current args", async () => {
  const { base, env, taskPath, arm } = await runningTask("review-required");
  const delivered = await taskDeliver(env as never, taskPath, { summary: "review me" });
  const original = { actor: "user", deliveryId: delivered.delivery.id, note: "original", resume: true };
  arm({ operation: "writeFile", path: isRejectIntentPath, timing: "after" });
  await assert.rejects(() => taskReject(env as never, taskPath, original), /fault/);

  await assert.rejects(
    () => taskReject(env as never, taskPath, { ...original, note: "different", resume: false }),
    (error: unknown) => (error as { code?: string }).code === "DELIVERY_CHANGED"
  );
  const state = await taskAndDeliveries(base, taskPath);
  assert.equal(state.task.state, "running");
  assert.equal(state.deliveries[0]!.status, "rejected");
  assert.equal(state.deliveries[0]!.review?.note, "original");
});

test("prepareTaskAccept reconciles a committed reject WAL before review authority can accept", async () => {
  const { base, env, taskPath, arm } = await runningTask("review-required");
  const delivered = await taskDeliver(env as never, taskPath, { summary: "review me" });
  const accept = { actor: "user", deliveryId: delivered.delivery.id };
  arm({ operation: "writeFile", path: isRejectIntentPath, timing: "after" });
  await assert.rejects(
    () => taskReject(env as never, taskPath, { ...accept, note: "reject wins", resume: true }),
    /fault/
  );

  await assert.rejects(() => prepareTaskAccept(env as never, taskPath, accept), /Invalid task transition/);
  const state = await taskAndDeliveries(base, taskPath);
  assert.equal(state.task.state, "running");
  assert.equal(state.deliveries[0]!.status, "rejected");
  assert.equal(state.deliveries[0]!.review?.note, "reject wins");
});

test("finalizeTaskAccept reconciles a reject WAL committed after accept preparation", async () => {
  const { base, env, taskPath, arm } = await runningTask("review-required");
  const delivered = await taskDeliver(env as never, taskPath, { summary: "review me" });
  const accept = { actor: "user", deliveryId: delivered.delivery.id };
  const prepared = await prepareTaskAccept(env as never, taskPath, accept);
  arm({ operation: "writeFile", path: isRejectIntentPath, timing: "after" });
  await assert.rejects(
    () => taskReject(env as never, taskPath, { ...accept, note: "reject after prepare", resume: true }),
    /fault/
  );

  await assert.rejects(
    () => finalizeTaskAccept(env as never, taskPath, accept, prepared),
    /Invalid task transition/
  );
  const state = await taskAndDeliveries(base, taskPath);
  assert.equal(state.task.state, "running");
  assert.equal(state.deliveries[0]!.status, "rejected");
  assert.equal(state.deliveries[0]!.review?.note, "reject after prepare");
});

test("pre-WAL reject failure leaves Task and Delivery bytes unchanged", async () => {
  const { base, env, taskPath, arm } = await runningTask("review-required");
  const delivered = await taskDeliver(env as never, taskPath, { summary: "review me" });
  const taskRaw = await base.readFile(taskPath);
  const deliveryRaw = await base.readFile(delivered.delivery.path);
  arm({ operation: "writeFile", path: isRejectIntentPath, timing: "before" });
  await assert.rejects(
    () => taskReject(env as never, taskPath, {
      actor: "user",
      deliveryId: delivered.delivery.id,
      note: "never committed",
      resume: true,
    }),
    /fault/
  );
  assert.equal(await base.readFile(taskPath), taskRaw);
  assert.equal(await base.readFile(delivered.delivery.path), deliveryRaw);
});

test("completed reject is exact-request idempotent and all mismatches are zero-write conflicts", async () => {
  const { base, env, taskPath } = await runningTask("review-required");
  const delivered = await taskDeliver(env as never, taskPath, { summary: "review me" });
  const original = { actor: "user", deliveryId: delivered.delivery.id, note: "revise", resume: true };
  const completed = await taskReject(env as never, taskPath, original);
  const taskRaw = await base.readFile(taskPath);
  const deliveryRaw = await base.readFile(completed.delivery.path);

  for (const mismatch of [
    { ...original, actor: "rl-other" },
    { ...original, note: "other note" },
    { ...original, resume: false },
    { ...original, deliveryId: "dl-other" },
  ]) {
    await assert.rejects(
      () => taskReject(env as never, taskPath, mismatch),
      (error: unknown) => (error as { code?: string }).code === "DELIVERY_CHANGED"
    );
    assert.equal(await base.readFile(taskPath), taskRaw);
    assert.equal(await base.readFile(completed.delivery.path), deliveryRaw);
  }
});

const postRejectOperations = ["claim", "wait", "resume", "interrupt", "fail"] as const;

function invokePostRejectOperation(
  operation: (typeof postRejectOperations)[number],
  env: unknown,
  taskPath: string
): Promise<unknown> {
  switch (operation) {
    case "claim": return taskClaim(env as never, taskPath);
    case "wait": return taskWait(env as never, taskPath, { reason: "external", summary: "after reject" });
    case "resume": return taskResume(env as never, taskPath);
    case "interrupt": return taskInterrupt(env as never, taskPath);
    case "fail": return taskFail(env as never, taskPath);
  }
}

for (const timing of ["before", "after"] as const) {
  for (const operation of postRejectOperations) {
    test(`reject-resume remove ${timing} preflights before ${operation}`, async () => {
      const { base, env, taskPath, arm } = await runningTask("review-required");
      const delivered = await taskDeliver(env as never, taskPath, { summary: "review me" });
      arm({ operation: "remove", path: isRejectIntentPath, timing });
      await assert.rejects(
        () => taskReject(env as never, taskPath, {
          actor: "user",
          deliveryId: delivered.delivery.id,
          note: "resume committed",
          resume: true,
        }),
        /fault/
      );

      const result = await invokePostRejectOperation(operation, env, taskPath) as TaskEnvelope;
      const expected = operation === "wait"
        ? "waiting"
        : operation === "interrupt"
          ? "interrupted"
          : operation === "fail"
            ? "failed"
            : "running";
      assert.equal(result.state, expected);
      assert.equal(await hasRejectIntent(base, taskPath), false);
    });

    test(`terminal reject remove ${timing} preflights before invalid ${operation}`, async () => {
      const { base, env, taskPath, arm } = await runningTask("review-required");
      const delivered = await taskDeliver(env as never, taskPath, { summary: "review me" });
      arm({ operation: "remove", path: isRejectIntentPath, timing });
      await assert.rejects(
        () => taskReject(env as never, taskPath, {
          actor: "user",
          deliveryId: delivered.delivery.id,
          note: "terminal committed",
          resume: false,
        }),
        /fault/
      );

      await assert.rejects(
        () => invokePostRejectOperation(operation, env, taskPath),
        /Invalid task transition/
      );
      assert.equal((await loadTaskEnvelope(base, taskPath)).state, "rejected");
      assert.equal(await hasRejectIntent(base, taskPath), false);
    });
  }
}

for (const operation of ["claim", "wait", "resume", "interrupt", "fail", "cancel"] as const) {
  test(`${operation} reconciles a committed ready Delivery before evaluating its own transition`, async () => {
    const { base, env, taskPath, arm } = await runningTask("review-required");
    arm({ operation: "writeFile", path: (path) => path === taskPath, timing: "before" });
    await assert.rejects(
      () => taskDeliver(env as never, taskPath, { summary: "committed before competing op", lastOutcome: "delivered" }),
      /fault/
    );
    const committed = (await loadDeliveries(base))[0]!;

    const invoke = (): Promise<unknown> => {
      switch (operation) {
        case "claim": return taskClaim(env as never, taskPath);
        case "wait": return taskWait(env as never, taskPath, { reason: "external", summary: "wait" });
        case "resume": return taskResume(env as never, taskPath);
        case "interrupt": return taskInterrupt(env as never, taskPath);
        case "fail": return taskFail(env as never, taskPath);
        case "cancel": return taskCancel(env as never, taskPath);
      }
    };
    await assert.rejects(invoke, /Invalid task transition/);
    const task = await loadTaskEnvelope(base, taskPath);
    assert.equal(task.state, "delivered");
    assert.equal(task.activeDeliveryId, committed.id);
    assert.equal(task.lastOutcome, "delivered");
    assert.equal((await loadDeliveries(base))[0]!.status, "ready");
  });
}

for (const malformed of ["source", "policy"] as const) {
  test(`committed-delivery preflight rejects a cross-${malformed} candidate without Task mutation`, async () => {
    const { base, env, taskPath } = await runningTask("review-required");
    const task = await loadTaskEnvelope(base, taskPath);
    await createDelivery(base, env.clock, {
      taskId: task.id!,
      sourceNodeId: malformed === "source" ? "cx-p2" : "cx-p1",
      deliveriesDir: "temp/roles/rl-executor/deliveries",
      summary: "malformed candidate",
      status: "ready",
      integrationMode: malformed === "policy" ? "auto-accept" : null,
    });
    const taskRaw = await base.readFile(taskPath);
    await assert.rejects(
      () => taskWait(env as never, taskPath, { reason: "external", summary: "must not win" }),
      (error: unknown) => (error as { code?: string }).code === "DELIVERY_CHANGED"
    );
    assert.equal(await base.readFile(taskPath), taskRaw);
  });
}

test("normal manually accepted Task passes lifecycle preflight without mutation", async () => {
  const { base, env, taskPath } = await runningTask("review-required");
  const delivered = await taskDeliver(env as never, taskPath, { summary: "manual accept" });
  await taskAccept(env as never, taskPath, { actor: "user", deliveryId: delivered.delivery.id });
  const taskRaw = await base.readFile(taskPath);
  const deliveryRaw = await base.readFile(delivered.delivery.path);
  await assert.rejects(() => taskClaim(env as never, taskPath), /Invalid task transition/);
  assert.equal(await base.readFile(taskPath), taskRaw);
  assert.equal(await base.readFile(delivered.delivery.path), deliveryRaw);
});

test("accepted manual Delivery WAL repairs a still-delivered Task before current mutation", async () => {
  const { base, env, taskPath } = await runningTask("auto-accept");
  const options: TaskDeliverOptions = { summary: "manual recovery after auto attempt" };
  const prepared = await prepareTaskDeliver(env as never, taskPath, options);
  assert.equal(prepared.kind, "auto");
  if (prepared.kind !== "auto") return;
  const delivery = (await loadDeliveries(base))[0]!;
  delivery.status = "accepted";
  delivery.integrationMode = "manual-accept";
  await writeDelivery(base, delivery);

  await assert.rejects(
    () => taskWait(env as never, taskPath, { reason: "external", summary: "must see accepted" }),
    /Invalid task transition/
  );
  const task = await loadTaskEnvelope(base, taskPath);
  assert.equal(task.state, "accepted");
  assert.equal(task.activeDeliveryId, delivery.id);
});

for (const illegalState of ["interrupted", "failed"] as const) {
  test(`${illegalState} Task with committed ready Delivery fails closed without deleting WAL`, async () => {
    const { base, env, taskPath, arm } = await runningTask("review-required");
    arm({ operation: "writeFile", path: (path) => path === taskPath, timing: "before" });
    await assert.rejects(() => taskDeliver(env as never, taskPath, { summary: "committed WAL" }), /fault/);
    const delivery = (await loadDeliveries(base))[0]!;
    await patchTaskEnvelope(base, taskPath, { state: illegalState, updatedAt: env.clock.now() });
    const taskRaw = await base.readFile(taskPath);
    const deliveryRaw = await base.readFile(delivery.path);

    const invoke = illegalState === "interrupted"
      ? () => taskInterrupt(env as never, taskPath)
      : () => taskFail(env as never, taskPath);
    await assert.rejects(
      invoke,
      (error: unknown) => (error as { code?: string }).code === "DELIVERY_CHANGED"
    );
    assert.equal(await base.readFile(taskPath), taskRaw);
    assert.equal(await base.readFile(delivery.path), deliveryRaw);
  });
}

test("reject-resume then taskFail removes rejected Delivery and clears terminal projection", async () => {
  const { base, env, taskPath } = await runningTask("review-required");
  const delivered = await taskDeliver(env as never, taskPath, {
    summary: "review me",
    lastOutcome: "delivered",
  });
  await taskReject(env as never, taskPath, {
    actor: "user",
    deliveryId: delivered.delivery.id,
    note: "resume",
    resume: true,
  });
  const failed = await taskFail(env as never, taskPath);
  assert.equal(failed.state, "failed");
  assert.equal(failed.activeDeliveryId, undefined);
  assert.equal(failed.lastOutcome, undefined);
  assert.equal(await base.exists(delivered.delivery.path), false);
});

test("idempotent taskFail repairs a legacy dangling rejected Delivery projection", async () => {
  const { base, env, taskPath } = await runningTask("review-required");
  const delivered = await taskDeliver(env as never, taskPath, {
    summary: "review me",
    lastOutcome: "delivered",
  });
  await taskReject(env as never, taskPath, {
    actor: "user",
    deliveryId: delivered.delivery.id,
    note: "resume",
    resume: true,
  });
  await patchTaskEnvelope(base, taskPath, { state: "failed", updatedAt: env.clock.now() });

  const repaired = await taskFail(env as never, taskPath);
  assert.equal(repaired.state, "failed");
  assert.equal(repaired.activeDeliveryId, undefined);
  assert.equal(repaired.lastOutcome, undefined);
  assert.equal(await base.exists(delivered.delivery.path), false);
});

test("session-owned Task recovers only its exact Delivery namespace", async () => {
  const { base, env, taskPath, arm } = await runningTask("review-required", "session");
  arm({ operation: "writeFile", path: (path) => path === taskPath, timing: "before" });
  await assert.rejects(() => taskDeliver(env as never, taskPath, { summary: "session candidate" }), /fault/);
  const recovered = await taskDeliver(env as never, taskPath, { summary: "session candidate" });
  assert.equal(recovered.task.sessionId, "ss-recovery");
  assert.match(recovered.delivery.path, /temp[\\/]sessions[\\/]ss-recovery[\\/]deliveries/);
  assert.equal((await loadDeliveries(base, { taskId: recovered.task.id })).length, 1);
});

test("recovery ignores another Task's Delivery in the same Role namespace", async () => {
  const fixture = await runningTask("review-required");
  const { base, env, taskPath, arm } = fixture;
  arm({ operation: "writeFile", path: (path) => path === taskPath, timing: "before" });
  await assert.rejects(() => taskDeliver(env as never, taskPath, { summary: "first" }), /fault/);
  const second = await dispatch(env as never, "cx-p2", {
    roleId: "rl-executor",
    workNodeIds: ["cx-p2"],
    contextNodeIds: [],
    userPrompt: "second task",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    acceptMode: "review-required",
  });
  await taskClaim(env as never, second.taskPath);
  await taskDeliver(env as never, second.taskPath, { summary: "second" });

  const recovered = await taskDeliver(env as never, taskPath, { summary: "first" });
  assert.equal(recovered.delivery.taskId, recovered.task.id);
  assert.equal((await loadDeliveries(base)).length, 2);
});

test("agent-decide integrate recovery preserves the exact committed decision", async () => {
  const { base, env, taskPath, arm } = await runningTask("agent-decide");
  const options: TaskDeliverOptions = { summary: "agent decision", decision: "integrate" };
  const prepared = await prepareTaskDeliver(env as never, taskPath, options);
  assert.equal(prepared.kind, "auto");
  if (prepared.kind !== "auto") return;
  arm({ operation: "writeFile", path: (path) => path === taskPath, timing: "before" });
  await assert.rejects(() => finalizeTaskDeliverAuto(env as never, taskPath, options, prepared), /fault/);
  const recovered = await finalizeTaskDeliverAuto(env as never, taskPath, options, prepared);
  assert.equal(recovered.delivery.integrationMode, "agent-decided-integrate");
  assert.equal(recovered.task.state, "accepted");
  assert.equal((await loadDeliveries(base)).length, 1);
});
