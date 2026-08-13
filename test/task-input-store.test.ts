/**
 * TaskInputStore: machine-local U2A one-shot inputs.
 * Focus: pending-only cancel + durable processing serialization across inject races.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  TaskInputStore,
  formatTaskInputPrompt,
  isTaskInputTaskResultBlockingStatus,
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

test("task input store: result-blocking includes uncertain but retryability does not", () => {
  assert.equal(isTaskInputTaskResultBlockingStatus("pending"), true);
  assert.equal(isTaskInputTaskResultBlockingStatus("processing"), true);
  assert.equal(isTaskInputTaskResultBlockingStatus("failed"), true);
  assert.equal(isTaskInputTaskResultBlockingStatus("uncertain"), true);
  assert.equal(isTaskInputTaskResultBlockingStatus("delivered"), false);
  assert.equal(isTaskInputTaskResultBlockingStatus("consumed"), false);
  assert.equal(isTaskInputTaskResultBlockingStatus("cancelled"), false);
});

test("task input store: listBlockingForDeliver includes uncertain and excludes terminal", async () => {
  const dataDir = await tempDir("tent-ti-block-");
  const store = new TaskInputStore(dataDir);
  const workspaceId = "ws-block";
  const taskPath = "temp/r/tasks/block.md";
  const now = new Date().toISOString();

  await store.add(
    pending({
      id: "ti-pending",
      workspaceId,
      taskPath,
      text: "pending row",
      createdAt: now,
    })
  );
  await store.add(
    pending({
      id: "ti-processing",
      workspaceId,
      taskPath,
      text: "processing row",
      createdAt: now,
    })
  );
  await store.markProcessing("ti-processing");
  await store.add(
    pending({
      id: "ti-failed",
      workspaceId,
      taskPath,
      text: "failed row",
      createdAt: now,
    })
  );
  await store.markFailed("ti-failed", "inject failed");
  await store.add(
    pending({
      id: "ti-delivered",
      workspaceId,
      taskPath,
      text: "delivered row",
      createdAt: now,
    })
  );
  await store.markDelivered("ti-delivered");
  await store.add(
    pending({
      id: "ti-uncertain",
      workspaceId,
      taskPath,
      text: "uncertain row",
      createdAt: now,
    })
  );
  await store.markUncertain("ti-uncertain", "confirm failed");
  // Cancel only a dedicated row (do not bulk-cancel other open blockers).
  await store.add(
    pending({
      id: "ti-cancelled",
      workspaceId,
      taskPath: "temp/r/tasks/other.md",
      text: "other task cancel",
      createdAt: now,
    })
  );
  await store.cancelTask(workspaceId, "temp/r/tasks/other.md", "cleanup");

  // Seed a cancelled row on the target task without touching open blockers:
  // use cancelSession on a dedicated session-bound pending.
  await store.add(
    pending({
      id: "ti-cancel-target",
      workspaceId,
      taskPath,
      sessionId: "ss-only-cancel",
      text: "cancel me",
      createdAt: now,
    })
  );
  await store.cancelSession("ss-only-cancel", "cleanup");
  const cancelled = await store.get("ti-cancel-target", workspaceId, taskPath);
  assert.equal(cancelled?.status, "cancelled");

  const blockers = await store.listBlockingForDeliver(workspaceId, taskPath);
  const ids = blockers.map((b) => b.id).sort();
  assert.deepEqual(
    ids,
    ["ti-failed", "ti-pending", "ti-processing", "ti-uncertain"].sort()
  );
  assert.ok(blockers.every((b) => isTaskInputTaskResultBlockingStatus(b.status)));
  assert.equal(
    blockers.some(
      (b) =>
        b.status === "delivered" ||
        b.status === "cancelled"
    ),
    false
  );

  // Other task's open rows must not appear.
  assert.equal(
    blockers.some((b) => b.taskPath !== taskPath),
    false
  );
});

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

test("task input store: markProcessing and cancel serialize on durable status", async () => {
  const dataDir = await tempDir("tent-ti-processing-cancel-");
  const store = new TaskInputStore(dataDir);
  const cancelFirstId = "ti-cancel-first";
  const processingFirstId = "ti-processing-first";
  const workspaceId = "ws-processing-cancel";
  const cancelFirstTaskPath = "temp/r/tasks/cancel-first.md";
  const processingFirstTaskPath = "temp/r/tasks/processing-first.md";
  const cancelFirstSessionId = "ss-cancel-first";
  const processingFirstSessionId = "ss-processing-first";

  await store.add(
    pending({
      id: cancelFirstId,
      workspaceId,
      taskPath: cancelFirstTaskPath,
      sessionId: cancelFirstSessionId,
      text: "cancel wins",
    })
  );
  await store.add(
    pending({
      id: processingFirstId,
      workspaceId,
      taskPath: processingFirstTaskPath,
      sessionId: processingFirstSessionId,
      text: "processing wins",
    })
  );

  const cancelWins = store.cancelTask(workspaceId, cancelFirstTaskPath, "cancel-first");
  const lateProcessing = store.markProcessing(cancelFirstId);
  const cancelled = await cancelWins;
  assert.equal(cancelled.some((item) => item.id === cancelFirstId), true);
  await assert.rejects(lateProcessing, /requires pending or failed/);
  assert.equal(
    (await store.get(cancelFirstId, workspaceId, cancelFirstTaskPath))?.status,
    "cancelled"
  );

  const processingWins = store.markProcessing(processingFirstId);
  const lateCancel = store.cancelSession(processingFirstSessionId, "processing-first");
  assert.equal((await processingWins).status, "processing");
  assert.equal((await lateCancel).some((item) => item.id === processingFirstId), false);
  assert.equal(
    (await store.get(processingFirstId, workspaceId, processingFirstTaskPath))?.status,
    "processing"
  );
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
    /pending, failed, or processing status/
  );
});

test("task input store: rebindOpenSessions is atomic (all-or-none on persist failure)", async () => {
  const dataDir = await tempDir("tent-ti-rebind-batch-");
  const store = new TaskInputStore(dataDir);
  const workspaceId = "ws-batch";
  const taskPath = "temp/r/tasks/batch.md";
  const now = new Date().toISOString();
  await store.add(
    pending({
      id: "ti-a",
      workspaceId,
      taskPath,
      sessionId: "ss-old",
      text: "A",
      createdAt: now,
      updatedAt: now,
    })
  );
  await store.add(
    pending({
      id: "ti-b",
      workspaceId,
      taskPath,
      sessionId: "ss-old",
      text: "B",
      createdAt: now,
      updatedAt: now,
    })
  );

  store.setNextPersistErrorForTests(new Error("injected persist fail"));
  await assert.rejects(
    () => store.rebindOpenSessions(workspaceId, taskPath, "ss-new"),
    /injected persist fail/
  );
  for (const id of ["ti-a", "ti-b"]) {
    const row = await store.get(id, workspaceId, taskPath);
    assert.equal(row?.sessionId, "ss-old");
    assert.equal(row?.status, "pending");
  }

  const rebound = await store.rebindOpenSessions(workspaceId, taskPath, "ss-new");
  assert.equal(rebound.length, 2);
  assert.ok(rebound.every((r) => r.sessionId === "ss-new"));
});

test("task input store: uncertain is at-most-once (no listPending, no cancel, no retry, survives restart)", async () => {
  const dataDir = await tempDir("tent-ti-uncertain-");
  const store = new TaskInputStore(dataDir);
  const id = makeTaskInputId(() => 0.66);
  const workspaceId = "ws-unc";
  const taskPath = "temp/r/tasks/unc.md";
  const sessionId = "ss-unc";

  await store.add(
    pending({
      id,
      workspaceId,
      taskPath,
      sessionId,
      text: "already sent",
    })
  );
  await store.markProcessing(id);

  const uncertain = await store.markUncertain(
    id,
    "managed inject ok but markDelivered failed: disk full",
    "service",
    { sessionId }
  );
  assert.equal(uncertain.status, "uncertain");
  assert.equal(
    uncertain.lastError,
    "managed inject ok but markDelivered failed: disk full"
  );
  assert.ok(uncertain.uncertainAt);
  assert.equal(uncertain.sessionId, sessionId);
  assert.equal(uncertain.failedAt, undefined);

  const open = await store.listRetryableForTask(workspaceId, taskPath);
  assert.equal(open.length, 0, "uncertain must not appear as retryable open");
  const retryable = await store.listRetryableForTask(workspaceId, taskPath);
  assert.equal(retryable.length, 0, "uncertain must never enter retry source");
  const attention = await store.listAttentionForTask(workspaceId, taskPath);
  assert.equal(attention.length, 1);
  assert.equal(attention[0]!.id, id);
  assert.equal(attention[0]!.status, "uncertain");
  assert.ok(attention[0]!.uncertainAt);
  assert.match(attention[0]!.lastError ?? "", /markDelivered failed/);

  const cancelled = await store.cancelTask(workspaceId, taskPath, "interrupt");
  assert.equal(cancelled.length, 0, "uncertain is not cancel-eligible");
  const still = await store.get(id, workspaceId, taskPath);
  assert.equal(still?.status, "uncertain");

  await assert.rejects(
    () => store.markPendingForRetry(id, workspaceId, taskPath),
    /uncertain \(at-most-once/
  );
  await assert.rejects(
    () => store.markProcessing(id),
    /pending or failed/
  );

  // Restart: uncertain must not reload as pending (would risk double inject).
  const reloaded = new TaskInputStore(dataDir);
  const afterReload = await reloaded.get(id, workspaceId, taskPath);
  assert.equal(afterReload?.status, "uncertain");
  assert.ok(afterReload?.uncertainAt);
  assert.match(afterReload?.lastError ?? "", /markDelivered failed/);

  // Ack is cleanup only — does not re-inject.
  const consumed = await reloaded.ack(id, workspaceId, taskPath, "executor");
  assert.equal(consumed.status, "consumed");
});

test("task input store: processing reloads uncertain; true inject failure stays retryable", async () => {
  const dataDir = await tempDir("tent-ti-proc-");
  const store = new TaskInputStore(dataDir);
  const id = makeTaskInputId(() => 0.77);
  const workspaceId = "ws-proc";
  const taskPath = "temp/r/tasks/proc.md";
  const sessionId = "ss-proc";

  await store.add(
    pending({
      id,
      workspaceId,
      taskPath,
      sessionId,
      text: "in flight",
    })
  );

  const processing = await store.markProcessing(id);
  assert.equal(processing.status, "processing");

  const pendingList = await store.listRetryableForTask(workspaceId, taskPath);
  assert.equal(
    pendingList.length,
    0,
    "processing must not appear in listPending"
  );

  const cancelledWhileProc = await store.cancelTask(
    workspaceId,
    taskPath,
    "interrupt"
  );
  assert.equal(
    cancelledWhileProc.length,
    0,
    "cancel must skip processing rows"
  );

  // The provider boundary is unknowable after a crash: never silently re-inject.
  const reloaded = new TaskInputStore(dataDir);
  const afterReload = await reloaded.get(id, workspaceId, taskPath);
  assert.equal(afterReload?.status, "uncertain");
  assert.ok(afterReload?.uncertainAt);
  await assert.rejects(() => reloaded.markProcessing(id), /pending or failed/);

  const failedId = makeTaskInputId(() => 0.25);
  await reloaded.add(
    pending({
      id: failedId,
      workspaceId,
      taskPath,
      sessionId,
      text: "fails before provider accept",
    })
  );
  await reloaded.markProcessing(failedId);
  const failed = await reloaded.markFailed(failedId, "inject blew up", "service");
  assert.equal(failed.status, "failed");
  assert.equal(failed.lastError, "inject blew up");
  assert.ok(failed.failedAt);

  const open = await reloaded.listRetryableForTask(workspaceId, taskPath);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.status, "failed");

  // Failed is cancel-eligible.
  const cancelled = await reloaded.cancelTask(workspaceId, taskPath, "cleanup");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]!.status, "cancelled");
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

test("task input store: pending still cancels (lifecycle interrupt)", async () => {
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
