/**
 * TaskInputStore: machine-local U2A one-shot inputs.
 * Focus: pending-only cancel + managed-inject pin across markDelivered race.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  TaskInputStore,
  formatTaskInputPrompt,
  makeTaskInputId,
  normalizeTaskInputKind,
  type TaskInputRecord,
} from "../src/service/task-input-store.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function pending(
  partial: Partial<TaskInputRecord> & {
    id: string;
    workspaceId: string;
    taskPath: string;
  }
): TaskInputRecord {
  const now = new Date().toISOString();
  return {
    status: "pending",
    createdAt: now,
    updatedAt: now,
    text: "append",
    ...partial,
  };
}

test("task input store: cancel is pending-only; delivered survives cancelTask/Session", async () => {
  const dataDir = await tempDir("tent-ti-store-");
  const store = new TaskInputStore(dataDir);
  const id = makeTaskInputId(() => 0.11);
  const workspaceId = "ws-1";
  const taskPath = "temp/r/tasks/t1.md";
  const sessionId = "ss-1";

  await store.add(
    pending({
      id,
      workspaceId,
      taskPath,
      sessionId,
      role: "executor",
    })
  );

  const delivered = await store.markDelivered(id, "service");
  assert.equal(delivered.status, "delivered");
  assert.ok(delivered.deliveredAt);

  const cancelledTask = await store.cancelTask(workspaceId, taskPath, "cleanup");
  assert.equal(cancelledTask.length, 0);
  const afterTask = await store.get(id, workspaceId, taskPath);
  assert.equal(afterTask?.status, "delivered");

  const cancelledSession = await store.cancelSession(sessionId, "cleanup");
  assert.equal(cancelledSession.length, 0);
  const afterSession = await store.get(id, workspaceId, taskPath);
  assert.equal(afterSession?.status, "delivered");
});

test("task input store: managed-inject pin blocks cancel until markDelivered (race)", async () => {
  const dataDir = await tempDir("tent-ti-pin-");
  const store = new TaskInputStore(dataDir);
  const id = makeTaskInputId(() => 0.33);
  const workspaceId = "ws-pin";
  const taskPath = "temp/r/tasks/pin.md";
  const sessionId = "ss-pin";

  await store.add(
    pending({
      id,
      workspaceId,
      taskPath,
      sessionId,
      text: "Use the tighter plan",
    })
  );

  // Simulate taskSendInputRpc: pin before inject, cancel races before markDelivered.
  store.beginManagedInject(id);
  assert.equal(store.isManagedInjectInFlight(id), true);

  // Delivery/session cleanup must not rewrite pinned pending → cancelled.
  const raced = await store.cancelSession(sessionId, "session.stop_after_deliver");
  assert.equal(
    raced.length,
    0,
    "cancelSession must skip managed-inject-in-flight pending rows"
  );
  const racedTask = await store.cancelTask(
    workspaceId,
    taskPath,
    "session.stop_after_deliver"
  );
  assert.equal(racedTask.length, 0);

  const stillPending = await store.get(id, workspaceId, taskPath);
  assert.equal(stillPending?.status, "pending");

  const delivered = await store.markDelivered(id, "service");
  assert.equal(delivered.status, "delivered");
  store.endManagedInject(id);
  assert.equal(store.isManagedInjectInFlight(id), false);

  // After pin release, delivered still survives cancel (pending-only).
  const after = await store.cancelSession(sessionId, "late-cleanup");
  assert.equal(after.length, 0);
  const final = await store.get(id, workspaceId, taskPath);
  assert.equal(final?.status, "delivered");
  assert.ok(final?.deliveredAt);

  const prompt = formatTaskInputPrompt(final!);
  assert.match(prompt, /## User Input/);
  assert.match(prompt, /Use the tighter plan/);
});

test("task input store: rebindSession updates pending session; cancel old id leaves row; markDelivered can persist inject session", async () => {
  const dataDir = await tempDir("tent-ti-rebind-");
  const store = new TaskInputStore(dataDir);
  const id = makeTaskInputId(() => 0.44);
  const workspaceId = "ws-rebind";
  const taskPath = "temp/r/tasks/rebind.md";
  const oldSession = "ss-old";
  const newSession = "ss-new";

  await store.add(
    pending({
      id,
      workspaceId,
      taskPath,
      sessionId: oldSession,
      kind: "review-feedback",
      text: "  rework note  ",
    })
  );

  const rebound = await store.rebindSession(
    id,
    workspaceId,
    taskPath,
    newSession
  );
  assert.equal(rebound.status, "pending");
  assert.equal(rebound.sessionId, newSession);
  assert.equal(rebound.text, "  rework note  ");

  // Idempotent rebind to same target.
  const same = await store.rebindSession(
    id,
    workspaceId,
    taskPath,
    newSession
  );
  assert.equal(same.sessionId, newSession);

  // cancelSession on the prior id must not touch the rebound pending row.
  const cancelledOld = await store.cancelSession(oldSession, "session.exited");
  assert.equal(cancelledOld.length, 0);
  const still = await store.get(id, workspaceId, taskPath);
  assert.equal(still?.status, "pending");
  assert.equal(still?.sessionId, newSession);

  // markDelivered can also persist the inject session (override path).
  const delivered = await store.markDelivered(id, "service", {
    sessionId: newSession,
  });
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.sessionId, newSession);

  await assert.rejects(
    () => store.rebindSession(id, workspaceId, taskPath, "ss-later"),
    /pending status/
  );
});

test("task input store: review-feedback preserves exact note and formats ## Review Feedback", async () => {
  const dataDir = await tempDir("tent-ti-review-");
  const store = new TaskInputStore(dataDir);
  const id = makeTaskInputId(() => 0.11);
  const workspaceId = "ws-review";
  const taskPath = "temp/r/tasks/review.md";
  // Exact note including leading/trailing whitespace — must not be trimmed.
  const exactNote = "  please fix tests\nline2  ";

  await store.add({
    id,
    workspaceId,
    taskPath,
    sessionId: "ss-review",
    kind: "review-feedback",
    text: exactNote,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const got = await store.get(id, workspaceId, taskPath);
  assert.equal(got?.kind, "review-feedback");
  assert.equal(got?.text, exactNote);
  assert.equal(normalizeTaskInputKind(got?.kind), "review-feedback");

  const prompt = formatTaskInputPrompt(got!);
  assert.match(prompt, /## Review Feedback/);
  assert.match(prompt, /kind: review-feedback/);
  assert.ok(prompt.includes(`text: ${exactNote}`));
  assert.doesNotMatch(prompt, /## User Input/);

  // Empty review note is still valid.
  const emptyId = makeTaskInputId(() => 0.91);
  await store.add({
    id: emptyId,
    workspaceId,
    taskPath: "temp/r/tasks/empty-note.md",
    kind: "review-feedback",
    text: "",
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const empty = await store.get(emptyId, workspaceId, "temp/r/tasks/empty-note.md");
  assert.equal(empty?.text, "");
  assert.match(formatTaskInputPrompt(empty!), /text: \n|text: $/m);
});

test("task input store: unpinned pending still cancels (lifecycle interrupt)", async () => {
  const dataDir = await tempDir("tent-ti-cancel-");
  const store = new TaskInputStore(dataDir);
  const id = makeTaskInputId(() => 0.55);
  const workspaceId = "ws-c";
  const taskPath = "temp/r/tasks/c.md";

  await store.add(
    pending({
      id,
      workspaceId,
      taskPath,
      sessionId: "ss-c",
    })
  );

  const cancelled = await store.cancelTask(workspaceId, taskPath, "task.interrupt");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]!.status, "cancelled");
  const got = await store.get(id, workspaceId, taskPath);
  assert.equal(got?.status, "cancelled");
});
