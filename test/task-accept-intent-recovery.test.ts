import assert from "node:assert/strict";
import { test } from "node:test";
import type { FsAdapter } from "../src/core/adapter.js";
import {
  deliveryAcceptCandidateDigest,
  loadDelivery,
  writeDelivery,
} from "../src/core/delivery.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { createNode, dispatch } from "../src/core/ops.js";
import { readOutputDeliveryId } from "../src/core/output.js";
import {
  taskAccept,
  taskClaim,
  taskDeliver,
  taskReject,
  taskWait,
  type TaskAcceptOptions,
} from "../src/core/task-lifecycle.js";
import { loadTaskEnvelope, patchTaskEnvelope } from "../src/core/task.js";
import { loadTent, nodeNotePath } from "../src/core/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { makeTent } from "./helpers.js";

type CrashRule = {
  operation: "writeFile" | "remove";
  path: (path: string) => boolean;
  timing: "before" | "after";
  occurrence?: number;
};

class CrashFs extends NodeFs {
  private crashed = false;
  private matches = 0;

  constructor(root: string, private readonly rule: CrashRule) {
    super(root);
  }

  private trip(operation: CrashRule["operation"], path: string, timing: CrashRule["timing"]): void {
    if (this.crashed) throw new Error("simulated process is no longer writable");
    if (operation !== this.rule.operation || timing !== this.rule.timing || !this.rule.path(path)) {
      return;
    }
    if (timing === "before") this.matches += 1;
    const occurrence = this.rule.occurrence ?? 1;
    if (this.matches !== occurrence) return;
    this.crashed = true;
    throw new Error(`simulated process crash ${timing} ${operation}:${path}`);
  }

  override async writeFile(path: string, content: string): Promise<void> {
    this.trip("writeFile", path, "before");
    await super.writeFile(path, content);
    if (this.rule.operation === "writeFile" && this.rule.timing === "after" && this.rule.path(path)) {
      this.matches += 1;
    }
    this.trip("writeFile", path, "after");
  }

  override async remove(path: string): Promise<void> {
    this.trip("remove", path, "before");
    await super.remove(path);
    if (this.rule.operation === "remove" && this.rule.timing === "after" && this.rule.path(path)) {
      this.matches += 1;
    }
    this.trip("remove", path, "after");
  }
}

function lifecycleEnv(root: string, fs: FsAdapter = new NodeFs(root)) {
  return {
    fs,
    clock: { now: () => "2026-08-10T09:30:00.000Z" },
    tentName: "accept-intent-recovery",
    tentRoot: root,
  };
}

function acceptIntentPath(taskPath: string): string {
  return `${taskPath.slice(0, -3)}.delivery-accept-intent.json`;
}

function rejectIntentPath(taskPath: string): string {
  return `${taskPath.slice(0, -3)}.delivery-reject-intent.json`;
}

async function outputDeliveryId(fs: FsAdapter, outputPath: string): Promise<string | undefined> {
  const { data } = parseFrontmatter(await fs.readFile(nodeNotePath(outputPath)));
  return readOutputDeliveryId(data);
}

async function fixture() {
  const root = await makeTent();
  const baseFs = new NodeFs(root);
  const env = lifecycleEnv(root, baseFs);
  const outputIds: string[] = [];
  const outputPaths: string[] = [];
  for (const name of ["accept-a", "accept-b", "accept-extra"]) {
    const id = await createNode(env as never, {
      parentPath: "output",
      name,
      type: "output",
    });
    const tent = await loadTent(baseFs);
    const node = tent.byId.get(id);
    assert.ok(node);
    outputIds.push(id);
    outputPaths.push(node.path);
  }
  const dispatched = await dispatch(env as never, "cx-p1", {
    sessionId: "ss-executor",
    workNodeIds: ["cx-p1"],
    contextNodeIds: [],
    userPrompt: "manual accept recovery",
    parentActor: { kind: "user", id: "user" },
    acceptMode: "review-required",
  });
  await taskClaim(env as never, dispatched.taskPath);
  const delivered = await taskDeliver(env as never, dispatched.taskPath, {
    summary: "ready for exact accept",
  });
  const options: TaskAcceptOptions = {
    actor: "user",
    deliveryId: delivered.delivery.id,
    // Deliberately reverse and duplicate to prove canonical intent persistence.
    outputNodeIds: [outputIds[1]!, outputIds[0]!, outputIds[1]!],
  };
  return {
    root,
    baseFs,
    env,
    taskPath: dispatched.taskPath,
    deliveryPath: delivered.delivery.path,
    deliveryId: delivered.delivery.id,
    outputIds,
    outputPaths,
    options,
  };
}

async function assertAccepted(
  f: Awaited<ReturnType<typeof fixture>>,
  expectedBound = f.outputIds.slice(0, 2)
): Promise<void> {
  const task = await loadTaskEnvelope(f.baseFs, f.taskPath);
  const delivery = await loadDelivery(f.baseFs, f.deliveryPath);
  assert.equal(task.state, "accepted");
  assert.equal(delivery.status, "accepted");
  assert.equal(delivery.integrationMode, "manual-accept");
  assert.deepEqual(delivery.review, { by: "user", decision: "accept", note: undefined });
  for (let index = 0; index < f.outputPaths.length; index += 1) {
    const expected = expectedBound.includes(f.outputIds[index]!) ? f.deliveryId : undefined;
    assert.equal(await outputDeliveryId(f.baseFs, f.outputPaths[index]!), expected);
  }
}

async function crashAndRecover(
  f: Awaited<ReturnType<typeof fixture>>,
  rule: CrashRule
): Promise<void> {
  const crashEnv = lifecycleEnv(f.root, new CrashFs(f.root, rule));
  await assert.rejects(() => taskAccept(crashEnv as never, f.taskPath, f.options), /simulated process|roll back/i);
  const recovered = await taskAccept(f.env as never, f.taskPath, f.options);
  assert.equal(recovered.delivery.id, f.deliveryId);
  assert.deepEqual([...recovered.boundOutputIds].sort(), f.outputIds.slice(0, 2).sort());
  assert.equal(await f.baseFs.exists(acceptIntentPath(f.taskPath)), false);
  await assertAccepted(f);
}

async function acceptLeavingFinalIntent(
  f: Awaited<ReturnType<typeof fixture>>
): Promise<void> {
  const crashEnv = lifecycleEnv(f.root, new CrashFs(f.root, {
    operation: "remove",
    path: (path) => path === acceptIntentPath(f.taskPath),
    timing: "before",
  }));
  await assert.rejects(() => taskAccept(crashEnv as never, f.taskPath, f.options));
  assert.equal(await f.baseFs.exists(acceptIntentPath(f.taskPath)), true);
  await assertAccepted(f);
}

async function authorityBytes(f: Awaited<ReturnType<typeof fixture>>): Promise<string[]> {
  return Promise.all([
    f.baseFs.readFile(f.taskPath),
    f.baseFs.readFile(f.deliveryPath),
    f.baseFs.readFile(acceptIntentPath(f.taskPath)),
    ...f.outputPaths.map((path) => f.baseFs.readFile(nodeNotePath(path))),
  ]);
}

for (const timing of ["before", "after"] as const) {
  test(`accept intent write ${timing} crash recovers exactly`, async () => {
    const f = await fixture();
    await crashAndRecover(f, {
      operation: "writeFile",
      path: (path) => path === acceptIntentPath(f.taskPath),
      timing,
    });
  });
}

for (const occurrence of [1, 2]) {
  test(`accept Output write ${occurrence} crash resumes the complete canonical set`, async () => {
    const f = await fixture();
    const outputNotes = new Set(f.outputPaths.slice(0, 2).map(nodeNotePath));
    await crashAndRecover(f, {
      operation: "writeFile",
      path: (path) => outputNotes.has(path),
      timing: "after",
      occurrence,
    });
  });
}

for (const [name, pathFor] of [
  ["Delivery", (f: Awaited<ReturnType<typeof fixture>>) => f.deliveryPath],
  ["Task", (f: Awaited<ReturnType<typeof fixture>>) => f.taskPath],
] as const) {
  for (const timing of ["before", "after"] as const) {
    test(`accept ${name} write ${timing} crash recovers exactly`, async () => {
      const f = await fixture();
      await crashAndRecover(f, {
        operation: "writeFile",
        path: (path) => path === pathFor(f),
        timing,
      });
    });
  }
}

test("accept intent remove-before crash is forward-recovered", async () => {
  const f = await fixture();
  await crashAndRecover(f, {
    operation: "remove",
    path: (path) => path === acceptIntentPath(f.taskPath),
    timing: "before",
  });
});

test("accept intent remove-after crash leaves one legal accepted state", async () => {
  const f = await fixture();
  const crashEnv = lifecycleEnv(f.root, new CrashFs(f.root, {
    operation: "remove",
    path: (path) => path === acceptIntentPath(f.taskPath),
    timing: "after",
  }));
  await assert.rejects(() => taskAccept(crashEnv as never, f.taskPath, f.options), /simulated process crash/);
  assert.equal(await f.baseFs.exists(acceptIntentPath(f.taskPath)), false);
  await assertAccepted(f);
  await assert.rejects(
    () => taskWait(f.env as never, f.taskPath, { reason: "external", summary: "must stay accepted" }),
    /Invalid task transition/
  );
  await assertAccepted(f);
});

test("zero-Output accept intent recovers without inventing provenance", async () => {
  const f = await fixture();
  const options: TaskAcceptOptions = {
    actor: "user",
    deliveryId: f.deliveryId,
  };
  const crashEnv = lifecycleEnv(f.root, new CrashFs(f.root, {
    operation: "writeFile",
    path: (path) => path === acceptIntentPath(f.taskPath),
    timing: "after",
  }));
  await assert.rejects(() => taskAccept(crashEnv as never, f.taskPath, options));
  const intent = JSON.parse(await f.baseFs.readFile(acceptIntentPath(f.taskPath))) as {
    commits: string[];
    outputNodeIds: string[];
  };
  assert.deepEqual(intent.commits, []);
  assert.deepEqual(intent.outputNodeIds, []);
  await taskAccept(f.env as never, f.taskPath, options);
  await assertAccepted(f, []);
});

test("accept canonicalizes actor and preserves first-seen Output order through recovery", async () => {
  const f = await fixture();
  const options = { ...f.options, actor: "  user  " };
  const crashEnv = lifecycleEnv(f.root, new CrashFs(f.root, {
    operation: "writeFile",
    path: (path) => path === acceptIntentPath(f.taskPath),
    timing: "after",
  }));
  await assert.rejects(() => taskAccept(crashEnv as never, f.taskPath, options));
  const intent = JSON.parse(await f.baseFs.readFile(acceptIntentPath(f.taskPath))) as {
    actor: string;
    outputNodeIds: string[];
  };
  assert.equal(intent.actor, "user");
  assert.deepEqual(intent.outputNodeIds, [f.outputIds[1], f.outputIds[0]]);

  const recovered = await taskAccept(f.env as never, f.taskPath, options);
  assert.deepEqual(recovered.boundOutputIds, [f.outputIds[1], f.outputIds[0]]);
  assert.deepEqual(recovered.changedOutputIds, [f.outputIds[1], f.outputIds[0]]);
  await assertAccepted(f);
});

test("invalid accept clock fails before WAL or authority mutation", async () => {
  const f = await fixture();
  const before = await Promise.all([
    f.baseFs.readFile(f.taskPath),
    f.baseFs.readFile(f.deliveryPath),
    ...f.outputPaths.map((path) => f.baseFs.readFile(nodeNotePath(path))),
  ]);
  const invalidClockEnv = {
    ...f.env,
    clock: { now: () => "not-an-instant" },
  };

  await assert.rejects(
    () => taskAccept(invalidClockEnv as never, f.taskPath, f.options),
    /Task accept intent updatedAt/
  );
  assert.equal(await f.baseFs.exists(acceptIntentPath(f.taskPath)), false);
  assert.deepEqual(
    await Promise.all([
      f.baseFs.readFile(f.taskPath),
      f.baseFs.readFile(f.deliveryPath),
      ...f.outputPaths.map((path) => f.baseFs.readFile(nodeNotePath(path))),
    ]),
    before
  );
});

test("reject after a partial accept converges accept first and never rejects bound Outputs", async () => {
  const f = await fixture();
  const firstOutput = nodeNotePath(f.outputPaths[0]!);
  const crashEnv = lifecycleEnv(f.root, new CrashFs(f.root, {
    operation: "writeFile",
    path: (path) => path === firstOutput,
    timing: "after",
  }));
  await assert.rejects(() => taskAccept(crashEnv as never, f.taskPath, f.options));

  await assert.rejects(
    () => taskReject(f.env as never, f.taskPath, {
      actor: "user",
      deliveryId: f.deliveryId,
      note: "must not override committed accept",
      resume: true,
    }),
    /Invalid task transition/
  );
  await assertAccepted(f);
});

for (const mismatch of ["actor", "delivery", "outputs"] as const) {
  test(`mismatched accept retry (${mismatch}) converges prior intent without extra binding`, async () => {
    const f = await fixture();
    const crashEnv = lifecycleEnv(f.root, new CrashFs(f.root, {
      operation: "writeFile",
      path: (path) => path === acceptIntentPath(f.taskPath),
      timing: "after",
    }));
    await assert.rejects(() => taskAccept(crashEnv as never, f.taskPath, f.options));
    const retry: TaskAcceptOptions = {
      ...f.options,
      ...(mismatch === "actor" ? { actor: "rl-reviewer" } : {}),
      ...(mismatch === "delivery" ? { deliveryId: "dl-other" } : {}),
      ...(mismatch === "outputs"
        ? { outputNodeIds: [f.outputIds[0]!, f.outputIds[2]!] }
        : {}),
    };

    await assert.rejects(
      () => taskAccept(f.env as never, f.taskPath, retry),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "DELIVERY_CHANGED"
    );
    await assertAccepted(f);
  });
}

test("corrupt or mismatched accept intent fails closed with zero authority mutation", async () => {
  for (const mutation of [
    (raw: Record<string, unknown>) => ({ ...raw, taskId: "tk-wrong" }),
    (raw: Record<string, unknown>) => ({ ...raw, unexpected: true }),
    (raw: Record<string, unknown>) => ({ ...raw, updatedAt: "not-an-instant" }),
    (raw: Record<string, unknown>) => {
      const { outputNodeIds: _missing, ...rest } = raw;
      return rest;
    },
  ]) {
    const f = await fixture();
    const taskBefore = await f.baseFs.readFile(f.taskPath);
    const deliveryBefore = await f.baseFs.readFile(f.deliveryPath);
    const outputBefore = await Promise.all(f.outputPaths.map((path) => f.baseFs.readFile(nodeNotePath(path))));
    const raw = mutation({
      type: "task-delivery-accept-intent",
      version: 1,
      taskId: (await loadTaskEnvelope(f.baseFs, f.taskPath)).id,
      deliveryId: f.deliveryId,
      deliveryPath: f.deliveryPath,
      candidateDigest: deliveryAcceptCandidateDigest(
        await loadDelivery(f.baseFs, f.deliveryPath)
      ),
      actor: "user",
      commits: [],
      outputNodeIds: [f.outputIds[1]!, f.outputIds[0]!],
      updatedAt: "2026-08-10T09:30:00.000Z",
    });
    await f.baseFs.writeFile(acceptIntentPath(f.taskPath), JSON.stringify(raw, null, 2) + "\n");
    await assert.rejects(
      () => taskWait(f.env as never, f.taskPath, { reason: "external", summary: "must not mutate" }),
      /accept recovery intent/
    );
    assert.equal(await f.baseFs.readFile(f.taskPath), taskBefore);
    assert.equal(await f.baseFs.readFile(f.deliveryPath), deliveryBefore);
    assert.deepEqual(
      await Promise.all(f.outputPaths.map((path) => f.baseFs.readFile(nodeNotePath(path)))),
      outputBefore
    );
  }
});

test("accept intent refuses Delivery candidate drift before any recovery write", async () => {
  for (const field of ["commits", "summary"] as const) {
    const f = await fixture();
    const crashEnv = lifecycleEnv(f.root, new CrashFs(f.root, {
      operation: "writeFile",
      path: (path) => path === acceptIntentPath(f.taskPath),
      timing: "after",
    }));
    await assert.rejects(() => taskAccept(crashEnv as never, f.taskPath, f.options));

    const corrupted = await loadDelivery(f.baseFs, f.deliveryPath);
    if (field === "commits") corrupted.commits = ["a".repeat(40)];
    else corrupted.summary = "semantic drift after intent";
    await writeDelivery(f.baseFs, corrupted);
    const taskBefore = await f.baseFs.readFile(f.taskPath);
    const deliveryBefore = await f.baseFs.readFile(f.deliveryPath);
    const outputBefore = await Promise.all(
      f.outputPaths.map((path) => f.baseFs.readFile(nodeNotePath(path)))
    );

    await assert.rejects(
      () => taskWait(f.env as never, f.taskPath, { reason: "external", summary: "must not mutate" }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "DELIVERY_CHANGED"
    );
    assert.equal(await f.baseFs.readFile(f.taskPath), taskBefore);
    assert.equal(await f.baseFs.readFile(f.deliveryPath), deliveryBefore);
    assert.deepEqual(
      await Promise.all(f.outputPaths.map((path) => f.baseFs.readFile(nodeNotePath(path)))),
      outputBefore
    );
  }
});

for (const drift of [
  "delivery timestamp",
  "delivery review note",
  "task timestamp",
  "task wait",
] as const) {
  test(`accepted-state recovery rejects ${drift} and retains intent without mutation`, async () => {
    const f = await fixture();
    await acceptLeavingFinalIntent(f);

    if (drift === "delivery timestamp" || drift === "delivery review note") {
      const delivery = await loadDelivery(f.baseFs, f.deliveryPath);
      if (drift === "delivery timestamp") {
        delivery.updatedAt = "2026-08-10T09:30:00.001Z";
      } else {
        delivery.review = { by: "user", decision: "accept", note: "must not survive" };
      }
      await writeDelivery(f.baseFs, delivery);
    } else if (drift === "task timestamp") {
      await patchTaskEnvelope(f.baseFs, f.taskPath, {
        updatedAt: "2026-08-10T09:30:00.001Z",
      });
    } else {
      await patchTaskEnvelope(f.baseFs, f.taskPath, {
        wait: { reason: "external", summary: "accepted Task must not wait" },
      });
    }
    const before = await authorityBytes(f);

    await assert.rejects(
      () => taskWait(f.env as never, f.taskPath, { reason: "external", summary: "must fail closed" }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "DELIVERY_CHANGED"
    );
    assert.deepEqual(await authorityBytes(f), before);
    assert.equal(await f.baseFs.exists(acceptIntentPath(f.taskPath)), true);
  });
}

test("simultaneous accept and reject intents fail loud before either decision mutates", async () => {
  const f = await fixture();
  const crashEnv = lifecycleEnv(f.root, new CrashFs(f.root, {
    operation: "writeFile",
    path: (path) => path === acceptIntentPath(f.taskPath),
    timing: "after",
  }));
  await assert.rejects(() => taskAccept(crashEnv as never, f.taskPath, f.options));
  const task = await loadTaskEnvelope(f.baseFs, f.taskPath);
  await f.baseFs.writeFile(rejectIntentPath(f.taskPath), JSON.stringify({
    type: "task-delivery-reject-intent",
    version: 1,
    taskId: task.id,
    deliveryId: f.deliveryId,
    to: "running",
    actor: "user",
    note: "conflicting review",
    updatedAt: "2026-08-10T09:30:00.000Z",
  }, null, 2) + "\n");
  const taskBefore = await f.baseFs.readFile(f.taskPath);
  const deliveryBefore = await f.baseFs.readFile(f.deliveryPath);
  await assert.rejects(
    () => taskWait(f.env as never, f.taskPath, { reason: "external", summary: "must conflict" }),
    /Conflicting exact-Task accept and reject recovery intents/
  );
  assert.equal(await f.baseFs.readFile(f.taskPath), taskBefore);
  assert.equal(await f.baseFs.readFile(f.deliveryPath), deliveryBefore);
  for (const path of f.outputPaths) assert.equal(await outputDeliveryId(f.baseFs, path), undefined);
});
