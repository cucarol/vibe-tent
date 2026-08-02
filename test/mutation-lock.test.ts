import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import {
  mayReclaimLock,
  readMutationLockRecord,
  releaseMutationLockIfOwned,
  withFileMutationLock,
} from "../src/fs/mutation-lock.js";
import { loadDeliveries } from "../src/core/delivery.js";
import { dispatch } from "../src/core/ops.js";
import { loadTaskEnvelope } from "../src/core/task.js";
import { taskAccept, taskClaim, taskDeliver } from "../src/core/task-lifecycle.js";
import { loadTent } from "../src/core/tree.js";
import { makeTent } from "./helpers.js";

async function tempRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function env(dir: string) {
  return {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-07-12T10:00:00.000Z" },
    tentName: "wqb",
    tentRoot: dir,
  };
}

async function seedExecutorRole(e: ReturnType<typeof env>): Promise<void> {
  await e.fs.writeFile(
    "roles.json",
    JSON.stringify({ roles: [{ id: "rl-executor", name: "executor", displayName: "executor" }] }, null, 2) + "\n"
  );
}

test("mutation lock: release is ownership-safe after stale reclaim", async () => {
  const dir = await tempRoot("tent-mlock-own-");
  const lockPath = path.join(dir, "mutation.lock");
  const firstToken = "owner-first";
  const secondToken = "owner-second";

  await withFileMutationLock(
    lockPath,
    async () => {
      // Simulate stale reclaim: another process quarantines our lock and installs its own.
      const replacement = {
        ownerToken: secondToken,
        pid: 99999,
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(lockPath, JSON.stringify(replacement), "utf8");
    },
    {
      busyMessage: "busy",
      acquireFailedMessage: "acquire failed",
      makeOwnerToken: () => firstToken,
    }
  );

  // First holder's finally must not delete the second owner's lock.
  const still = await readMutationLockRecord(lockPath);
  assert.ok(still);
  assert.equal(still!.ownerToken, secondToken);

  // Explicit API: wrong token is a no-op.
  assert.equal(await releaseMutationLockIfOwned(lockPath, firstToken), false);
  assert.equal((await readMutationLockRecord(lockPath))?.ownerToken, secondToken);

  assert.equal(await releaseMutationLockIfOwned(lockPath, secondToken), true);
  assert.equal(await readMutationLockRecord(lockPath), null);
});

test("mutation lock: concurrent holders are mutual exclusive; lock carries ownerToken", async () => {
  const dir = await tempRoot("tent-mlock-race-");
  const a = new NodeFs(dir);
  const b = new NodeFs(dir);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const active = a.withLock!("mutation.lock", async () => held);
  while (!(await a.exists("mutation.lock"))) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const body = JSON.parse(await a.readFile("mutation.lock")) as {
    ownerToken: string;
    pid: number;
  };
  assert.ok(body.ownerToken);
  assert.equal(body.pid, process.pid);

  await assert.rejects(
    () => b.withLock!("mutation.lock", async () => undefined),
    /already running another write operation/
  );

  release();
  await active;
  assert.equal(await a.exists("mutation.lock"), false);
  await b.withLock!("mutation.lock", async () => undefined);
});

test("mutation lock: aged lock with live process.pid stays busy (no age-only reclaim)", async () => {
  const dir = await tempRoot("tent-mlock-live-pid-");
  const lockPath = path.join(dir, "mutation.lock");
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      ownerToken: "still-alive-owner",
      pid: process.pid,
      createdAt: "2000-01-01T00:00:00.000Z",
    }),
    "utf8"
  );
  const ancient = new Date(Date.now() - 180_000);
  await fs.utimes(lockPath, ancient, ancient);

  assert.equal(await mayReclaimLock(lockPath), false);

  await assert.rejects(
    () =>
      withFileMutationLock(lockPath, async () => undefined, {
        busyMessage: "Tent is already running another write operation; try again later.",
        acquireFailedMessage: "Cannot acquire the Tent mutation lock.",
      }),
    /already running another write operation/
  );

  const still = await readMutationLockRecord(lockPath);
  assert.ok(still);
  assert.equal(still!.ownerToken, "still-alive-owner");
  assert.equal(still!.pid, process.pid);
});

test("mutation lock: aged lock with dead PID is reclaimed", async () => {
  const dir = await tempRoot("tent-mlock-dead-pid-");
  const lockPath = path.join(dir, "mutation.lock");
  const deadPid = 1_000_000 + Math.floor(Math.random() * 1_000_000);
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      ownerToken: "ancient-dead",
      pid: deadPid,
      createdAt: "2000-01-01T00:00:00.000Z",
    }),
    "utf8"
  );
  const ancient = new Date(Date.now() - 180_000);
  await fs.utimes(lockPath, ancient, ancient);

  assert.equal(
    await mayReclaimLock(lockPath, Date.now, 120_000, () => false),
    true
  );

  await withFileMutationLock(
    lockPath,
    async () => {
      const rec = await readMutationLockRecord(lockPath);
      assert.ok(rec);
      assert.notEqual(rec!.ownerToken, "ancient-dead");
    },
    {
      busyMessage: "busy",
      acquireFailedMessage: "acquire failed",
      isProcessAlive: () => false,
    }
  );
  assert.equal(await readMutationLockRecord(lockPath), null);
});

test("mutation lock: stale dead-pid lock reclaimed via NodeFs then exclusive again", async () => {
  const dir = await tempRoot("tent-mlock-stale-");
  const lockPath = path.join(dir, "mutation.lock");
  // Use an unusable/absent pid so real processIsAlive allows reclaim on any OS.
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      ownerToken: "ancient",
      pid: -1,
      createdAt: "2000-01-01T00:00:00.000Z",
    }),
    "utf8"
  );
  const ancient = new Date(Date.now() - 180_000);
  await fs.utimes(lockPath, ancient, ancient);

  const fsAdapter = new NodeFs(dir);
  await fsAdapter.withLock!("mutation.lock", async () => {
    const rec = JSON.parse(await fsAdapter.readFile("mutation.lock")) as {
      ownerToken: string;
    };
    assert.notEqual(rec.ownerToken, "ancient");
  });
  assert.equal(await fsAdapter.exists("mutation.lock"), false);
});

test("lifecycle: auto-integrate runs outside mutation.lock and failure leaves no delivery", async () => {
  const dir = await makeTent();
  const e = env(dir);
  await seedExecutorRole(e);
  const result = await dispatch(e as any, "cx-p1", {
    roleId: "rl-executor",
    userPrompt: "bypass integrate outside lock",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    deliveryPolicy: "bypass",
  });
  await taskClaim(e as any, result.taskPath);

  let sawLockDuringIntegrate = true;
  await assert.rejects(
    () =>
      taskDeliver(e as any, result.taskPath, {
        summary: "will fail after proving lock free",
        commits: ["abc"],
        integrate: async () => {
          sawLockDuringIntegrate = await e.fs.exists("mutation.lock");
          throw new Error("Workspace integration conflicted and was rolled back");
        },
      }),
    /Workspace integration conflicted/
  );

  assert.equal(
    sawLockDuringIntegrate,
    false,
    "Git integrate must not hold cross-process mutation.lock"
  );
  const task = await loadTaskEnvelope(e.fs, result.taskPath);
  assert.equal(task.state, "running");
  assert.equal((await loadDeliveries(e.fs)).length, 0);
  const box = (await loadTent(e.fs)).byId.get("cx-p1")!;
  assert.equal(box.fm.owner, undefined);
  assert.equal(box.fm.status, undefined);
});

test("lifecycle: accept integrate runs outside mutation.lock; failure keeps delivered", async () => {
  const dir = await makeTent();
  const e = env(dir);
  await seedExecutorRole(e);
  const result = await dispatch(e as any, "cx-p1", {
    roleId: "rl-executor",
    userPrompt: "manual accept outside lock",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  await taskClaim(e as any, result.taskPath);
  await taskDeliver(e as any, result.taskPath, {
    summary: "ready",
    commits: ["abc1234"],
  });

  let sawLockDuringIntegrate = true;
  await assert.rejects(
    () =>
      taskAccept(e as any, result.taskPath, {
        actor: "user",
        integrate: async () => {
          sawLockDuringIntegrate = await e.fs.exists("mutation.lock");
          throw new Error("Workspace integration conflicted and was rolled back");
        },
      }),
    /Workspace integration conflicted/
  );

  assert.equal(
    sawLockDuringIntegrate,
    false,
    "accept integrate must not hold cross-process mutation.lock"
  );
  const task = await loadTaskEnvelope(e.fs, result.taskPath);
  assert.equal(task.state, "delivered");
  const ready = (await loadDeliveries(e.fs)).find((d) => d.status === "ready");
  assert.ok(ready);
  const box = (await loadTent(e.fs)).byId.get("cx-p1")!;
  assert.equal(box.fm.owner, undefined);
  assert.equal(box.fm.status, undefined);
});

test("lifecycle: successful auto-integrate still accepts atomically after unlock", async () => {
  const dir = await makeTent();
  const e = env(dir);
  await seedExecutorRole(e);
  const result = await dispatch(e as any, "cx-p1", {
    roleId: "rl-executor",
    userPrompt: "agent decide",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
    deliveryPolicy: "agent-decide",
  });
  await taskClaim(e as any, result.taskPath);

  let lockFree = false;
  const out = await taskDeliver(e as any, result.taskPath, {
    summary: "ok",
    commits: ["deadbee"],
    decision: "integrate",
    integrate: async () => {
      lockFree = !(await e.fs.exists("mutation.lock"));
    },
  });
  assert.equal(lockFree, true);
  assert.equal(out.autoIntegrated, true);
  assert.equal(out.task.state, "accepted");
  assert.equal(out.delivery.status, "accepted");
  const box = (await loadTent(e.fs)).byId.get("cx-p1")!;
  assert.equal(box.fm.status, undefined);
  assert.equal(box.fm.owner, undefined);
});
