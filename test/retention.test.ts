/**
 * Core operational retention (task-api §6 MVP).
 * Layer: pure selection + FsAdapter purge; no service/RPC.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { createDelivery } from "../src/core/delivery.js";
import {
  DEFAULT_KEEP_TERMINAL_DAYS,
  MAX_KEEP_TERMINAL_DAYS,
  normalizeKeepTerminalTasksDays,
  previewOperationalRetention,
  purgeOperationalRetention,
  RetentionError,
} from "../src/core/retention.js";
import { writeTaskEnvelope, loadTaskEnvelope, patchTaskEnvelope } from "../src/core/task.js";
import { makeTent } from "./helpers.js";

const NOW = "2026-07-16T12:00:00.000Z";
const OLD = "2026-06-01T12:00:00.000Z"; // > 30 days before NOW
const RECENT = "2026-07-10T12:00:00.000Z"; // < 30 days before NOW

function clock(iso: string) {
  return { now: () => iso };
}

class FailTaskRemoveFs extends NodeFs {
  constructor(root: string, private readonly failPath: string) {
    super(root);
  }

  override async remove(path: string): Promise<void> {
    if (path === this.failPath) throw new Error("injected task remove failure");
    await super.remove(path);
  }
}

async function writeTerminalTask(
  fs: NodeFs,
  opts: {
    role?: string;
    state: "accepted" | "rejected" | "interrupted" | "failed";
    id?: string;
    createdAt?: string;
    updatedAt?: string;
    claimId?: string;
  }
) {
  const role = opts.role ?? "executor";
  const path = await writeTaskEnvelope(fs, clock(opts.createdAt ?? OLD), {

    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },role,
    claims: [{ id: opts.claimId ?? "bx-p1", path: "prompt/表达式任务书" }],
    manifestPath: "temp/executor/manifests/m.md",
    userPrompt: "retention fixture",
    id: opts.id,
  });
  await patchTaskEnvelope(fs, path, {
    state: opts.state,
    updatedAt: opts.updatedAt ?? opts.createdAt ?? OLD,
  });
  // writeTaskEnvelope stamps createdAt from clock; ensure both old when needed
  const raw = await fs.readFile(path);
  const patched = raw
    .replace(/createdAt: .*/, `createdAt: ${opts.createdAt ?? OLD}`)
    .replace(/updatedAt: .*/, `updatedAt: ${opts.updatedAt ?? opts.createdAt ?? OLD}`);
  await fs.writeFile(path, patched);
  return loadTaskEnvelope(fs, path);
}

test("normalizeKeepTerminalTasksDays: default 30, 0 allowed, rejects invalid", () => {
  assert.equal(normalizeKeepTerminalTasksDays(undefined), DEFAULT_KEEP_TERMINAL_DAYS);
  assert.equal(normalizeKeepTerminalTasksDays(0), 0);
  assert.equal(normalizeKeepTerminalTasksDays(7), 7);
  assert.equal(normalizeKeepTerminalTasksDays(MAX_KEEP_TERMINAL_DAYS), MAX_KEEP_TERMINAL_DAYS);
  assert.throws(
    () => normalizeKeepTerminalTasksDays(-1),
    (e: unknown) => e instanceof RetentionError && e.code === "INVALID_KEEP_DAYS"
  );
  assert.throws(
    () => normalizeKeepTerminalTasksDays(1.5),
    (e: unknown) => e instanceof RetentionError
  );
  assert.throws(
    () => normalizeKeepTerminalTasksDays(MAX_KEEP_TERMINAL_DAYS + 1),
    (e: unknown) => e instanceof RetentionError
  );
  assert.throws(
    () => normalizeKeepTerminalTasksDays("30" as unknown),
    (e: unknown) => e instanceof RetentionError
  );
});

test("preview: never selects active tasks or ready deliveries", async () => {
  const dir = await makeTent();
  const fs = new NodeFs(dir);

  const activePath = await writeTaskEnvelope(fs, clock(OLD), {

    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },role: "executor",
    claims: [{ id: "bx-p1", path: "prompt/表达式任务书" }],
    manifestPath: "temp/executor/manifests/m.md",
    userPrompt: "still running work",
    id: "tk-active01",
  });
  // Force old timestamps but keep queued (active)
  await fs.writeFile(
    activePath,
    (await fs.readFile(activePath))
      .replace(/createdAt: .*/, `createdAt: ${OLD}`)
      .replace(/updatedAt: .*/, `updatedAt: ${OLD}`)
  );

  await writeTerminalTask(fs, { state: "accepted", id: "tk-oldacc1" });

  const ready = await createDelivery(fs, clock(OLD), {
    taskId: "tk-missing",
    boxId: "bx-p1",
    role: "executor",
    summary: "awaiting review",
    status: "ready",
  });
  await fs.writeFile(
    ready.path,
    (await fs.readFile(ready.path))
      .replace(/createdAt: .*/, `createdAt: ${OLD}`)
      .replace(/updatedAt: .*/, `updatedAt: ${OLD}`)
  );

  const preview = await previewOperationalRetention(fs, {
    keepTerminalTasksDays: 30,
    now: NOW,
  });

  assert.ok(preview.candidates.every((c) => c.taskPath !== activePath));
  assert.ok(preview.candidates.every((c) => !c.deliveryPaths.includes(ready.path)));
  assert.ok(preview.candidates.some((c) => c.taskId === "tk-oldacc1"));
  assert.equal(await fs.exists(activePath), true);
  assert.equal(await fs.exists(ready.path), true);
});

test("preview: terminal task past retention is a task-group candidate", async () => {
  const dir = await makeTent();
  const fs = new NodeFs(dir);
  const task = await writeTerminalTask(fs, { state: "failed", id: "tk-failold" });
  const delivery = await createDelivery(fs, clock(OLD), {
    taskId: "tk-failold",
    boxId: "bx-p1",
    role: "executor",
    summary: "historical delivery",
    status: "rejected",
  });
  await fs.writeFile(
    delivery.path,
    (await fs.readFile(delivery.path))
      .replace(/createdAt: .*/, `createdAt: ${OLD}`)
      .replace(/updatedAt: .*/, `updatedAt: ${OLD}`)
  );

  const preview = await previewOperationalRetention(fs, {
    keepTerminalTasksDays: 30,
    now: NOW,
  });
  const group = preview.candidates.find((c) => c.kind === "task-group" && c.taskId === "tk-failold");
  assert.ok(group);
  assert.equal(group!.taskPath, task.path);
  assert.ok(group!.deliveryPaths.includes(delivery.path));
  assert.equal(preview.candidateTaskCount, 1);
  assert.equal(preview.candidateDeliveryCount, 1);
});

test("preview: recent terminal task within 30 days is not a candidate", async () => {
  const dir = await makeTent();
  const fs = new NodeFs(dir);
  await writeTerminalTask(fs, {
    state: "accepted",
    id: "tk-recent1",
    createdAt: RECENT,
    updatedAt: RECENT,
  });

  const preview = await previewOperationalRetention(fs, {
    keepTerminalTasksDays: 30,
    now: NOW,
  });
  assert.ok(!preview.candidates.some((c) => c.taskId === "tk-recent1"));
});

test("preview: recent related delivery keeps the whole terminal task group hot", async () => {
  const dir = await makeTent();
  const fs = new NodeFs(dir);
  const task = await writeTerminalTask(fs, { state: "accepted", id: "tk-hotgroup" });
  await createDelivery(fs, clock(RECENT), {
    taskId: "tk-hotgroup",
    boxId: "bx-p1",
    role: "executor",
    summary: "recent accepted delivery",
    status: "accepted",
  });

  const preview = await previewOperationalRetention(fs, {
    keepTerminalTasksDays: 30,
    now: NOW,
  });
  assert.ok(!preview.candidates.some((candidate) => candidate.taskPath === task.path));
});

test("preview: duplicate task ids are reported and never selected", async () => {
  const dir = await makeTent();
  const fs = new NodeFs(dir);
  const first = await writeTerminalTask(fs, {
    state: "accepted",
    id: "tk-duplicate",
    claimId: "bx-p1",
  });
  const second = await writeTerminalTask(fs, {
    state: "failed",
    id: "tk-duplicate",
    claimId: "bx-p2",
  });

  const preview = await previewOperationalRetention(fs, {
    keepTerminalTasksDays: 0,
    now: NOW,
  });
  assert.ok(!preview.candidates.some((candidate) => candidate.taskId === "tk-duplicate"));
  assert.ok(preview.skipped.some((item) => item.path === first.path));
  assert.ok(preview.skipped.some((item) => item.path === second.path));
  assert.ok(preview.warnings.some((warning) => warning.includes("duplicate task id")));
});

test("preview/purge: keepTerminalTasksDays=0 makes terminal immediately eligible", async () => {
  const dir = await makeTent();
  const fs = new NodeFs(dir);
  const task = await writeTerminalTask(fs, {
    state: "interrupted",
    id: "tk-imm0",
    createdAt: RECENT,
    updatedAt: RECENT,
  });

  const preview = await previewOperationalRetention(fs, {
    keepTerminalTasksDays: 0,
    now: NOW,
  });
  assert.ok(preview.candidates.some((c) => c.taskPath === task.path));

  const purged = await purgeOperationalRetention(fs, {
    keepTerminalTasksDays: 0,
    now: NOW,
  });
  assert.ok(purged.purged.taskPaths.includes(task.path));
  assert.equal(await fs.exists(task.path), false);
  assert.ok(purged.deletedCount >= 1);
});

test("purge: deletes task + deliveries as a group; leaves active work", async () => {
  const dir = await makeTent();
  const fs = new NodeFs(dir);

  const oldTask = await writeTerminalTask(fs, { state: "accepted", id: "tk-group1" });
  const oldDelivery = await createDelivery(fs, clock(OLD), {
    taskId: "tk-group1",
    boxId: "bx-p1",
    role: "executor",
    summary: "old accepted summary",
    status: "accepted",
  });
  await fs.writeFile(
    oldDelivery.path,
    (await fs.readFile(oldDelivery.path))
      .replace(/createdAt: .*/, `createdAt: ${OLD}`)
      .replace(/updatedAt: .*/, `updatedAt: ${OLD}`)
  );

  const activePath = await writeTaskEnvelope(fs, clock(NOW), {

    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },role: "executor",
    claims: [{ id: "bx-p2", path: "prompt/表达式任务书/草稿" }],
    manifestPath: "temp/executor/manifests/m2.md",
    userPrompt: "do not purge me",
    id: "tk-live01",
  });
  await patchTaskEnvelope(fs, activePath, { state: "running", updatedAt: NOW });

  const result = await purgeOperationalRetention(fs, {
    keepTerminalTasksDays: 30,
    now: NOW,
  });

  assert.ok(result.purged.taskPaths.includes(oldTask.path));
  assert.ok(result.purged.deliveryPaths.includes(oldDelivery.path));
  assert.equal(await fs.exists(oldTask.path), false);
  assert.equal(await fs.exists(oldDelivery.path), false);
  assert.equal(await fs.exists(activePath), true);
  assert.equal((await loadTaskEnvelope(fs, activePath)).state, "running");
});

test("purge: task removal failure preserves all related deliveries", async () => {
  const dir = await makeTent();
  const seedFs = new NodeFs(dir);
  const task = await writeTerminalTask(seedFs, { state: "accepted", id: "tk-failrm1" });
  const delivery = await createDelivery(seedFs, clock(OLD), {
    taskId: "tk-failrm1",
    boxId: "bx-p1",
    role: "executor",
    summary: "must survive parent delete failure",
    status: "accepted",
  });
  const failingFs = new FailTaskRemoveFs(dir, task.path);

  const result = await purgeOperationalRetention(failingFs, {
    keepTerminalTasksDays: 0,
    now: NOW,
  });

  assert.equal(await seedFs.exists(task.path), true);
  assert.equal(await seedFs.exists(delivery.path), true);
  assert.ok(!result.purged.taskPaths.includes(task.path));
  assert.ok(!result.purged.deliveryPaths.includes(delivery.path));
  assert.ok(result.warnings.some((warning) => warning.includes("injected task remove failure")));
});

test("purge: orphan terminal delivery is cleaned independently", async () => {
  const dir = await makeTent();
  const fs = new NodeFs(dir);
  const orphan = await createDelivery(fs, clock(OLD), {
    taskId: "tk-gonegone",
    boxId: "bx-p1",
    role: "executor",
    summary: "orphan rejected",
    status: "rejected",
  });
  await fs.writeFile(
    orphan.path,
    (await fs.readFile(orphan.path))
      .replace(/createdAt: .*/, `createdAt: ${OLD}`)
      .replace(/updatedAt: .*/, `updatedAt: ${OLD}`)
  );

  const result = await purgeOperationalRetention(fs, {
    keepTerminalTasksDays: 30,
    now: NOW,
  });
  assert.ok(result.candidates.some((c) => c.kind === "orphan-delivery"));
  assert.ok(result.purged.deliveryPaths.includes(orphan.path));
  assert.equal(await fs.exists(orphan.path), false);
});

test("preview: bad operational files stay on disk and appear in skipped/warnings", async () => {
  const dir = await makeTent();
  const fs = new NodeFs(dir);
  const badTask = "temp/executor/tasks/broken-task.md";
  const badDelivery = "temp/executor/deliveries/broken-dl.md";
  await fs.mkdir("temp/executor/tasks");
  await fs.mkdir("temp/executor/deliveries");
  await fs.writeFile(badTask, "---\ntype: task\n---\nnot a valid envelope\n");
  await fs.writeFile(badDelivery, "---\ntype: note\n---\nnot a delivery\n");

  const preview = await previewOperationalRetention(fs, {
    keepTerminalTasksDays: 0,
    now: NOW,
  });
  assert.ok(preview.skipped.some((s) => s.path === badTask));
  assert.ok(preview.skipped.some((s) => s.path === badDelivery));
  assert.ok(preview.warnings.some((w) => w.includes(badTask)));
  assert.ok(preview.warnings.some((w) => w.includes(badDelivery)));
  assert.equal(await fs.exists(badTask), true);
  assert.equal(await fs.exists(badDelivery), true);

  const purged = await purgeOperationalRetention(fs, {
    keepTerminalTasksDays: 0,
    now: NOW,
  });
  assert.equal(await fs.exists(badTask), true);
  assert.equal(await fs.exists(badDelivery), true);
  assert.ok(purged.skipped.some((s) => s.path === badTask));
});

test("preview: refuses task-group when a related delivery is draft or ready", async () => {
  const dir = await makeTent();
  const fs = new NodeFs(dir);
  const task = await writeTerminalTask(fs, { state: "rejected", id: "tk-readyblk" });
  // Terminal rejected task but still has a ready delivery (inconsistent / review pending)
  const ready = await createDelivery(fs, clock(OLD), {
    taskId: "tk-readyblk",
    boxId: "bx-p1",
    role: "executor",
    summary: "still ready",
    status: "ready",
  });
  await fs.writeFile(
    ready.path,
    (await fs.readFile(ready.path))
      .replace(/createdAt: .*/, `createdAt: ${OLD}`)
      .replace(/updatedAt: .*/, `updatedAt: ${OLD}`)
  );

  const preview = await previewOperationalRetention(fs, {
    keepTerminalTasksDays: 0,
    now: NOW,
  });
  assert.ok(!preview.candidates.some((c) => c.taskPath === task.path));
  assert.ok(preview.warnings.some((w) => w.includes("non-terminal delivery")));
  assert.equal(await fs.exists(task.path), true);
  assert.equal(await fs.exists(ready.path), true);

  const draft = await createDelivery(fs, clock(OLD), {
    taskId: "tk-orphan-draft",
    boxId: "bx-p1",
    role: "executor",
    summary: "unfinished draft",
    status: "draft",
  });
  const draftPreview = await previewOperationalRetention(fs, {
    keepTerminalTasksDays: 0,
    now: NOW,
  });
  assert.ok(!draftPreview.candidates.some((c) => c.deliveryPaths.includes(draft.path)));
  assert.equal(await fs.exists(draft.path), true);
});

test("preview is read-only (purge is the only mutator)", async () => {
  const dir = await makeTent();
  const fs = new NodeFs(dir);
  const task = await writeTerminalTask(fs, { state: "accepted", id: "tk-roonly" });
  await previewOperationalRetention(fs, { keepTerminalTasksDays: 0, now: NOW });
  assert.equal(await fs.exists(task.path), true);
});
