/**
 * UserAskStore: machine-local A2U business asks (not chat, not tool permission).
 * Store is machine-global; pending uniqueness is (workspaceId, taskPath).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  UserAskStore,
  formatUserAskAnswerPrompt,
  makeUserAskId,
  type UserAskRecord,
} from "../src/service/user-ask-store.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function pending(
  partial: Partial<UserAskRecord> & {
    id: string;
    workspaceId: string;
    taskPath: string;
  }
): UserAskRecord {
  const now = new Date().toISOString();
  return {
    question: "Ship v1 or v2?",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

test("user ask store: one pending per task; reply/deny terminal", async () => {
  const dataDir = await tempDir("tent-user-ask-");
  const store = new UserAskStore(dataDir);
  const id = makeUserAskId(() => 0.11);
  await store.add(
    pending({
      id,
      workspaceId: "ws-1",
      taskPath: "temp/r/tasks/t1.md",
      choices: [
        { id: "v1", label: "Ship v1" },
        { id: "v2", label: "Ship v2" },
      ],
    })
  );

  await assert.rejects(
    () =>
      store.add(
        pending({
          id: makeUserAskId(() => 0.22),
          workspaceId: "ws-1",
          taskPath: "temp/r/tasks/t1.md",
        })
      ),
    /already has a pending UserAsk/
  );

  const answered = await store.reply(id, {
    answer: "Prefer v1",
    choiceId: "v1",
    resolvedBy: "user",
  });
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "Prefer v1");
  assert.equal(answered.choiceId, "v1");

  await assert.rejects(
    () => store.reply(id, { answer: "late", resolvedBy: "user" }),
    /already answered/
  );

  const prompt = formatUserAskAnswerPrompt(answered);
  assert.match(prompt, /## User Answer/);
  assert.match(prompt, /askId: /);
  assert.match(prompt, /choiceId: v1/);
  assert.match(prompt, /answer: Prefer v1/);
});

test("user ask store: two workspaces may share the same relative taskPath", async () => {
  const dataDir = await tempDir("tent-user-ask-ws-");
  const store = new UserAskStore(dataDir);
  const sharedPath = "temp/executor/tasks/task-shared.md";
  const a = makeUserAskId(() => 0.11);
  const b = makeUserAskId(() => 0.22);

  await store.add(
    pending({
      id: a,
      workspaceId: "ws-alpha",
      taskPath: sharedPath,
      question: "Alpha decision?",
    })
  );
  // Same relative path in another workspace must not collide.
  await store.add(
    pending({
      id: b,
      workspaceId: "ws-beta",
      taskPath: sharedPath,
      question: "Beta decision?",
    })
  );

  const pendingAlpha = await store.getPendingForTask("ws-alpha", sharedPath);
  const pendingBeta = await store.getPendingForTask("ws-beta", sharedPath);
  assert.ok(pendingAlpha);
  assert.ok(pendingBeta);
  assert.equal(pendingAlpha!.id, a);
  assert.equal(pendingBeta!.id, b);
  assert.equal(pendingAlpha!.question, "Alpha decision?");
  assert.equal(pendingBeta!.question, "Beta decision?");

  // Uniqueness still holds inside one workspace.
  await assert.rejects(
    () =>
      store.add(
        pending({
          id: makeUserAskId(() => 0.33),
          workspaceId: "ws-alpha",
          taskPath: sharedPath,
        })
      ),
    /already has a pending UserAsk/
  );

  // cancelTask scopes by workspace — beta remains pending.
  const cancelled = await store.cancelTask(
    "ws-alpha",
    sharedPath,
    "task.interrupt"
  );
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]!.id, a);
  assert.equal((await store.get(a))!.status, "cancelled");
  assert.equal((await store.get(b))!.status, "pending");
  assert.equal(
    (await store.getPendingForTask("ws-beta", sharedPath))!.id,
    b
  );
});

test("user ask store: cancelTask and cancelSession clear pending", async () => {
  const dataDir = await tempDir("tent-user-ask-cancel-");
  const store = new UserAskStore(dataDir);
  const a = makeUserAskId(() => 0.31);
  const b = makeUserAskId(() => 0.63);
  await store.add(
    pending({
      id: a,
      workspaceId: "ws-1",
      taskPath: "temp/r/tasks/t1.md",
      sessionId: "ss-1",
    })
  );
  await store.add(
    pending({
      id: b,
      workspaceId: "ws-1",
      taskPath: "temp/r/tasks/t2.md",
      sessionId: "ss-1",
    })
  );

  const cancelledTask = await store.cancelTask(
    "ws-1",
    "temp/r/tasks/t1.md",
    "task.interrupt"
  );
  assert.equal(cancelledTask.length, 1);
  assert.equal(cancelledTask[0]!.status, "cancelled");
  assert.equal((await store.get(a))!.status, "cancelled");
  assert.equal((await store.get(b))!.status, "pending");

  const cancelledSession = await store.cancelSession("ss-1", "session.failed");
  assert.equal(cancelledSession.length, 1);
  assert.equal((await store.get(b))!.status, "cancelled");
});

test("user ask store: pending survives reload (unlike tool approvals)", async () => {
  const dataDir = await tempDir("tent-user-ask-reload-");
  const id = makeUserAskId(() => 0.41);
  const first = new UserAskStore(dataDir);
  await first.add(
    pending({
      id,
      workspaceId: "ws-1",
      taskPath: "temp/r/tasks/t1.md",
      question: "Continue?",
    })
  );

  const second = new UserAskStore(dataDir);
  const item = await second.get(id);
  assert.ok(item);
  assert.equal(item!.status, "pending");
  assert.equal(item!.question, "Continue?");
});
