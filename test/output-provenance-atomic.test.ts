/**
 * P1 atomicity for Output provenance bind on task.accept:
 * - Multi-Output write uses raw snapshots + compensating rollback
 * - Injected second-write failure leaves every Output/Task/Delivery unchanged
 * - Delivery/Task persistence failure after Output writes rolls everything back
 * - Retention pin scan fails closed (no destructive selection without pin knowledge)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { boxNotePath, loadTent } from "../src/core/tree.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { createBox, dispatch } from "../src/core/ops.js";
import { loadTaskEnvelope } from "../src/core/task.js";
import { loadDeliveries, loadDelivery } from "../src/core/delivery.js";
import {
  bindOutputsToDeliveryUnlocked,
  readOutputDeliveryId,
} from "../src/core/output.js";
import {
  previewOperationalRetention,
  purgeOperationalRetention,
  RetentionError,
} from "../src/core/retention.js";
import { taskAccept, taskClaim, taskDeliver } from "../src/core/task-lifecycle.js";
import { makeTent } from "./helpers.js";

function env(dir: string) {
  return {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-07-12T10:00:00.000Z" },
    tentName: "wqb",
    tentRoot: dir,
  };
}

async function createOutputBox(
  e: ReturnType<typeof env>,
  name: string
): Promise<{ id: string; path: string }> {
  const id = await createBox(e as any, {
    parentPath: "output",
    name,
    type: "output",
  });
  const tent = await loadTent(e.fs);
  const box = tent.byId.get(id);
  assert.ok(box, `created output ${id}`);
  return { id, path: box.path };
}

async function readyAcceptFixture(dir: string) {
  const e = env(dir);
  const result = await dispatch(e as any, "bx-p1", "executor", {
    userPrompt: "atomic provenance fixture",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  await taskClaim(e as any, result.taskPath, { sessionId: "ss-atomic1" });
  const delivered = await taskDeliver(e as any, result.taskPath, {
    summary: "ready for accept bind",
  });
  return { e, result, delivery: delivered.delivery, taskPath: result.taskPath };
}

function assertUnbound(raw: string): void {
  const { data } = parseFrontmatter(raw);
  assert.equal(readOutputDeliveryId(data), undefined);
  assert.equal(data.deliveryId, undefined);
}

test("multi-output bind: second write failure rolls back first Output; Task/Delivery unchanged", async () => {
  const dir = await makeTent();
  const base = env(dir);
  const outA = await createOutputBox(base, "atomic-a");
  const outB = await createOutputBox(base, "atomic-b");
  const { result, delivery, taskPath } = await readyAcceptFixture(dir);

  const noteA = boxNotePath(outA.path);
  const noteB = boxNotePath(outB.path);
  const rawABefore = await base.fs.readFile(noteA);
  const rawBBefore = await base.fs.readFile(noteB);
  const taskBefore = await base.fs.readFile(taskPath);
  const deliveryBefore = await base.fs.readFile(delivery.path);

  // Fail on the second Output note write (first bind succeeds, second injects failure).
  let outputNoteWrites = 0;
  class FailSecondOutputFs extends NodeFs {
    override async writeFile(path: string, content: string): Promise<void> {
      if (path === noteA || path === noteB) {
        outputNoteWrites += 1;
        if (outputNoteWrites === 2) {
          throw new Error("injected second output bind write failure");
        }
      }
      await super.writeFile(path, content);
    }
  }
  const failFs = new FailSecondOutputFs(dir);
  const failEnv = { ...base, fs: failFs };

  await assert.rejects(
    () =>
      taskAccept(failEnv as any, taskPath, {
        actor: "user",
        outputNodeIds: [outA.id, outB.id],
      }),
    (err: unknown) =>
      err instanceof Error && /injected second output bind write failure/i.test(err.message)
  );

  // Every Output/Task/Delivery file byte-identical to pre-accept.
  assert.equal(await base.fs.readFile(noteA), rawABefore);
  assert.equal(await base.fs.readFile(noteB), rawBBefore);
  assert.equal(await base.fs.readFile(taskPath), taskBefore);
  assert.equal(await base.fs.readFile(delivery.path), deliveryBefore);

  assertUnbound(await base.fs.readFile(noteA));
  assertUnbound(await base.fs.readFile(noteB));

  const task = await loadTaskEnvelope(base.fs, taskPath);
  assert.equal(task.state, "delivered");
  const liveD = await loadDelivery(base.fs, delivery.path);
  assert.equal(liveD.status, "ready");
  assert.equal(liveD.id, delivery.id);

  // Successful accept still works after rollback.
  const accepted = await taskAccept(base as any, taskPath, {
    actor: "user",
    outputNodeIds: [outA.id, outB.id],
  });
  assert.equal(accepted.task.state, "accepted");
  assert.deepEqual(accepted.boundOutputIds.sort(), [outA.id, outB.id].sort());
  assert.equal(
    readOutputDeliveryId(parseFrontmatter(await base.fs.readFile(noteA)).data),
    delivery.id
  );
  assert.equal(
    readOutputDeliveryId(parseFrontmatter(await base.fs.readFile(noteB)).data),
    delivery.id
  );
});

test("accept: delivery/task snapshot read failure before Output write leaves all byte-identical", async () => {
  const dir = await makeTent();
  const base = env(dir);
  const outA = await createOutputBox(base, "snap-fail-a");
  const outB = await createOutputBox(base, "snap-fail-b");
  const { delivery, taskPath } = await readyAcceptFixture(dir);

  const noteA = boxNotePath(outA.path);
  const noteB = boxNotePath(outB.path);
  const rawABefore = await base.fs.readFile(noteA);
  const rawBBefore = await base.fs.readFile(noteB);
  const taskBefore = await base.fs.readFile(taskPath);
  const deliveryBefore = await base.fs.readFile(delivery.path);

  // Fail the pre-bind Delivery raw snapshot.
  // delivery.path reads during taskAccept: (1) prepared requireActiveReadyDelivery,
  // (2) final-mutation requireActiveReadyDelivery, (3) pre-bind snapshot — fail on (3).
  // Outputs must never be written if this fails.
  class FailDeliverySnapshotReadFs extends NodeFs {
    private deliveryReads = 0;
    override async readFile(path: string): Promise<string> {
      if (path === delivery.path) {
        this.deliveryReads += 1;
        if (this.deliveryReads >= 3) {
          throw new Error("injected delivery snapshot read failure");
        }
      }
      return super.readFile(path);
    }
  }

  const failEnv = { ...base, fs: new FailDeliverySnapshotReadFs(dir) };
  await assert.rejects(
    () =>
      taskAccept(failEnv as any, taskPath, {
        actor: "user",
        outputNodeIds: [outA.id, outB.id],
      }),
    (err: unknown) =>
      err instanceof Error && /injected delivery snapshot read failure/i.test(err.message)
  );

  assert.equal(await base.fs.readFile(noteA), rawABefore);
  assert.equal(await base.fs.readFile(noteB), rawBBefore);
  assert.equal(await base.fs.readFile(taskPath), taskBefore);
  assert.equal(await base.fs.readFile(delivery.path), deliveryBefore);
  assertUnbound(await base.fs.readFile(noteA));
  assertUnbound(await base.fs.readFile(noteB));
  assert.equal((await loadTaskEnvelope(base.fs, taskPath)).state, "delivered");
  assert.equal((await loadDelivery(base.fs, delivery.path)).status, "ready");
});

test("accept: task snapshot read failure before Output write leaves all byte-identical", async () => {
  const dir = await makeTent();
  const base = env(dir);
  const out = await createOutputBox(base, "snap-task-fail");
  const { delivery, taskPath } = await readyAcceptFixture(dir);

  const notePath = boxNotePath(out.path);
  const rawOutBefore = await base.fs.readFile(notePath);
  const taskBefore = await base.fs.readFile(taskPath);
  const deliveryBefore = await base.fs.readFile(delivery.path);

  // Delivery snapshot succeeds; task snapshot read fails — still before any Output write.
  class FailTaskSnapshotReadFs extends NodeFs {
    override async readFile(path: string): Promise<string> {
      if (path === taskPath) {
        // loadTaskEnvelope at start of mutation also reads taskPath — allow that,
        // fail only the second read (pre-bind snapshot after revalidation).
        // Heuristic: if content would be returned, track calls.
        return super.readFile(path).then((raw) => {
          // Use a side channel on the instance.
          const self = this as FailTaskSnapshotReadFs & { _taskReads?: number };
          self._taskReads = (self._taskReads ?? 0) + 1;
          if (self._taskReads >= 2) {
            throw new Error("injected task snapshot read failure");
          }
          return raw;
        });
      }
      return super.readFile(path);
    }
  }

  const failEnv = { ...base, fs: new FailTaskSnapshotReadFs(dir) };
  await assert.rejects(
    () =>
      taskAccept(failEnv as any, taskPath, {
        actor: "user",
        outputNodeIds: [out.id],
      }),
    (err: unknown) =>
      err instanceof Error && /injected task snapshot read failure/i.test(err.message)
  );

  assert.equal(await base.fs.readFile(notePath), rawOutBefore);
  assert.equal(await base.fs.readFile(taskPath), taskBefore);
  assert.equal(await base.fs.readFile(delivery.path), deliveryBefore);
  assertUnbound(await base.fs.readFile(notePath));
  assert.equal((await loadTaskEnvelope(base.fs, taskPath)).state, "delivered");
  assert.equal((await loadDelivery(base.fs, delivery.path)).status, "ready");
});

test("accept: delivery write failure after Output binds rolls Outputs + keeps Task delivered/ready", async () => {
  const dir = await makeTent();
  const base = env(dir);
  const outA = await createOutputBox(base, "del-fail-a");
  const outB = await createOutputBox(base, "del-fail-b");
  const { delivery, taskPath } = await readyAcceptFixture(dir);

  const noteA = boxNotePath(outA.path);
  const noteB = boxNotePath(outB.path);
  const rawABefore = await base.fs.readFile(noteA);
  const rawBBefore = await base.fs.readFile(noteB);
  const taskBefore = await base.fs.readFile(taskPath);
  const deliveryBefore = await base.fs.readFile(delivery.path);

  class FailDeliveryWriteFs extends NodeFs {
    override async writeFile(path: string, content: string): Promise<void> {
      // Allow Output binds and task raw snapshot reads; fail when writing Delivery accepted.
      if (path === delivery.path) {
        // First write is still the pre-accept state? writeDelivery always rewrites path.
        // After Output binds, writeDelivery is the first write to delivery.path in this mutation
        // (snapshot was a read). Fail that write.
        const parsed = parseFrontmatter(content);
        if (parsed.data.status === "accepted") {
          throw new Error("injected delivery accepted write failure");
        }
      }
      await super.writeFile(path, content);
    }
  }

  const failEnv = { ...base, fs: new FailDeliveryWriteFs(dir) };
  await assert.rejects(
    () =>
      taskAccept(failEnv as any, taskPath, {
        actor: "user",
        outputNodeIds: [outA.id, outB.id],
      }),
    (err: unknown) =>
      err instanceof Error && /injected delivery accepted write failure/i.test(err.message)
  );

  assert.equal(await base.fs.readFile(noteA), rawABefore);
  assert.equal(await base.fs.readFile(noteB), rawBBefore);
  assert.equal(await base.fs.readFile(taskPath), taskBefore);
  assert.equal(await base.fs.readFile(delivery.path), deliveryBefore);
  assertUnbound(await base.fs.readFile(noteA));
  assertUnbound(await base.fs.readFile(noteB));
  assert.equal((await loadTaskEnvelope(base.fs, taskPath)).state, "delivered");
  assert.equal((await loadDelivery(base.fs, delivery.path)).status, "ready");
});

test("accept: task envelope write failure after Delivery accepted restores Delivery+Outputs", async () => {
  const dir = await makeTent();
  const base = env(dir);
  const out = await createOutputBox(base, "task-fail-out");
  const { delivery, taskPath } = await readyAcceptFixture(dir);

  const notePath = boxNotePath(out.path);
  const rawOutBefore = await base.fs.readFile(notePath);
  const taskBefore = await base.fs.readFile(taskPath);
  const deliveryBefore = await base.fs.readFile(delivery.path);

  class FailTaskAcceptedFs extends NodeFs {
    override async writeFile(path: string, content: string): Promise<void> {
      if (path === taskPath) {
        const parsed = parseFrontmatter(content);
        if (parsed.data.state === "accepted") {
          throw new Error("injected task accepted write failure");
        }
      }
      await super.writeFile(path, content);
    }
  }

  const failEnv = { ...base, fs: new FailTaskAcceptedFs(dir) };
  await assert.rejects(
    () =>
      taskAccept(failEnv as any, taskPath, {
        actor: "user",
        outputNodeIds: [out.id],
      }),
    (err: unknown) =>
      err instanceof Error && /injected task accepted write failure/i.test(err.message)
  );

  assert.equal(await base.fs.readFile(notePath), rawOutBefore);
  assert.equal(await base.fs.readFile(taskPath), taskBefore);
  assert.equal(await base.fs.readFile(delivery.path), deliveryBefore);
  assertUnbound(await base.fs.readFile(notePath));
  assert.equal((await loadTaskEnvelope(base.fs, taskPath)).state, "delivered");
  assert.equal((await loadDelivery(base.fs, delivery.path)).status, "ready");
  // No accepted delivery left behind
  const all = await loadDeliveries(base.fs, { taskId: (await loadTaskEnvelope(base.fs, taskPath)).id });
  assert.ok(all.every((d) => d.status !== "accepted" || d.id !== delivery.id));
  assert.equal((await loadDelivery(base.fs, delivery.path)).status, "ready");
});

test("bindOutputsToDeliveryUnlocked: direct second-write failure restores first snapshot", async () => {
  const dir = await makeTent();
  const base = env(dir);
  const outA = await createOutputBox(base, "direct-a");
  const outB = await createOutputBox(base, "direct-b");
  const tent = await loadTent(base.fs);
  const noteA = boxNotePath(outA.path);
  const noteB = boxNotePath(outB.path);
  const rawA = await base.fs.readFile(noteA);
  const rawB = await base.fs.readFile(noteB);

  let hits = 0;
  class FailSecondFs extends NodeFs {
    override async writeFile(path: string, content: string): Promise<void> {
      if (path === noteA || path === noteB) {
        hits += 1;
        if (hits === 2) throw new Error("injected bind write #2");
      }
      await super.writeFile(path, content);
    }
  }
  const fs = new FailSecondFs(dir);
  await assert.rejects(
    () =>
      bindOutputsToDeliveryUnlocked(fs, tent, [outA.id, outB.id], "dl-testdl01"),
    /injected bind write #2/
  );
  assert.equal(await base.fs.readFile(noteA), rawA);
  assert.equal(await base.fs.readFile(noteB), rawB);
});

test("retention pin scan fails closed: preview and purge refuse when loadTent breaks", async () => {
  const dir = await makeTent();
  const base = new NodeFs(dir);
  // Seed an old terminal task that would otherwise be purgeable.
  const { writeTaskEnvelope, patchTaskEnvelope } = await import("../src/core/task.js");
  const OLD = "2026-06-01T12:00:00.000Z";
  const clock = { now: () => OLD };
  const taskPath = await writeTaskEnvelope(base, clock, {
    
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },role: "executor",
    claims: [{ id: "bx-p1", path: "prompt/表达式任务书" }],
    manifestPath: "temp/executor/manifests/m.md",
    userPrompt: "old terminal",
    id: "tk-failscan1",
  });
  await patchTaskEnvelope(base, taskPath, { state: "accepted", updatedAt: OLD });
  await base.writeFile(
    taskPath,
    (await base.readFile(taskPath))
      .replace(/createdAt: .*/, `createdAt: ${OLD}`)
      .replace(/updatedAt: .*/, `updatedAt: ${OLD}`)
  );

  class BrokenTentFs extends NodeFs {
    override async readFile(path: string): Promise<string> {
      // Break concept tree load (types or root notes) used by loadTent.
      if (path === "types.json" || path.endsWith("/types.json")) {
        throw new Error("injected types.json read failure");
      }
      return super.readFile(path);
    }
    override async listDir(dirPath: string): Promise<{ name: string; isDir: boolean }[]> {
      // Also break if loadTent lists roots after types — keep types path primary.
      return super.listDir(dirPath);
    }
  }

  const broken = new BrokenTentFs(dir);
  await assert.rejects(
    () =>
      previewOperationalRetention(broken, {
        keepTerminalTasksDays: 0,
        now: "2026-07-16T12:00:00.000Z",
      }),
    (err: unknown) =>
      err instanceof RetentionError &&
      err.code === "PROVENANCE_PIN_SCAN_FAILED" &&
      /pin scan failed/i.test(err.message)
  );

  await assert.rejects(
    () =>
      purgeOperationalRetention(broken, {
        keepTerminalTasksDays: 0,
        now: "2026-07-16T12:00:00.000Z",
      }),
    (err: unknown) =>
      err instanceof RetentionError && err.code === "PROVENANCE_PIN_SCAN_FAILED"
  );

  // Destructive purge did not run — terminal task still on disk.
  assert.equal(await base.exists(taskPath), true);
});

test("retention pin scan fails closed when RULES/tree is unreadable mid-scan", async () => {
  const dir = await makeTent();
  const base = new NodeFs(dir);

  class BrokenListFs extends NodeFs {
    override async listDir(dirPath: string): Promise<{ name: string; isDir: boolean }[]> {
      // loadTent lists "" for roots after loading types — fail closed there.
      if (dirPath === "" || dirPath === ".") {
        throw new Error("injected root listDir failure");
      }
      return super.listDir(dirPath);
    }
  }

  await assert.rejects(
    () =>
      previewOperationalRetention(new BrokenListFs(dir), {
        keepTerminalTasksDays: 0,
        now: "2026-07-16T12:00:00.000Z",
      }),
    (err: unknown) =>
      err instanceof RetentionError && err.code === "PROVENANCE_PIN_SCAN_FAILED"
  );
});
