/**
 * V0.2 parent-reviewer wire + explicit Task outcome (cx-484qdb).
 * Focused pure + store tests; service integration covered by existing suites.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SystemClock } from "../src/fs/node-fs.js";
import { NodeFs } from "../src/fs/node-fs.js";
import {
  assertReviewAuthority,
  mayElevateDeliveryPolicy,
  migrateParentReviewerFromLegacy,
  parseTaskOutcomeReport,
  roleTaskActors,
  TaskLifecycleError,
  userTaskActors,
} from "../src/core/task-model.js";
import {
  loadTaskEnvelope,
  migrateParentReviewerEnvelopes,
  writeTaskEnvelope,
} from "../src/core/task.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";

test("parseTaskOutcomeReport: delivered / blocked / needs-input / missing", () => {
  assert.deepEqual(parseTaskOutcomeReport("outcome: delivered\n\nAll good"), {
    outcome: "delivered",
    report: "All good",
  });
  assert.deepEqual(
    parseTaskOutcomeReport("---\noutcome: blocked\n---\nCannot proceed"),
    { outcome: "blocked", report: "Cannot proceed" }
  );
  assert.deepEqual(parseTaskOutcomeReport("outcome: needs-input\nWhich API?"), {
    outcome: "needs-input",
    report: "Which API?",
  });
  assert.equal(parseTaskOutcomeReport("Just a free-form report"), null);
  assert.equal(parseTaskOutcomeReport("outcome: weird\nnope"), null);
  assert.equal(parseTaskOutcomeReport(""), null);
});

test("migrateParentReviewerFromLegacy: durable dispatcher → role; else user", () => {
  assert.deepEqual(migrateParentReviewerFromLegacy({ dispatchedBy: "user" }), userTaskActors());
  assert.deepEqual(migrateParentReviewerFromLegacy({}), userTaskActors());
  assert.deepEqual(
    migrateParentReviewerFromLegacy({ asSub: true, dispatchedBy: "规划" }),
    roleTaskActors("规划")
  );
  assert.deepEqual(
    migrateParentReviewerFromLegacy({ asSub: false, dispatchedBy: "orchestrator" }),
    roleTaskActors("orchestrator")
  );
});

test("mayElevateDeliveryPolicy: only durable Role user-facing", () => {
  assert.equal(
    mayElevateDeliveryPolicy({
      parentActor: { kind: "user", id: "user" },
      assigneeKind: "role",
    }),
    true
  );
  assert.equal(
    mayElevateDeliveryPolicy({
      parentActor: { kind: "user", id: "user" },
      assigneeKind: "agentProfile",
    }),
    false
  );
  assert.equal(
    mayElevateDeliveryPolicy({
      parentActor: { kind: "role", id: "规划" },
      assigneeKind: "agentProfile",
    }),
    false
  );
  assert.equal(
    mayElevateDeliveryPolicy({
      parentActor: { kind: "role", id: "规划" },
      assigneeKind: "role",
    }),
    false
  );
});

test("assertReviewAuthority: missing reviewer fails loud", () => {
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "user",
        submitterRole: "helper",
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );
});

test("writeTaskEnvelope persists parentActor/reviewer; strips dispatchedBy", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-wire-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  const clock = new SystemClock();
  const p = await writeTaskEnvelope(fsa, clock, {
    role: "helper",
    claims: [{ id: "cx-1", path: "a.md" }],
    manifestPath: "temp/helper/manifest.yml",
    userPrompt: "do it",
    parentActor: { kind: "role", id: "orchestrator" },
    reviewer: { kind: "role", id: "orchestrator" },
    asSub: true,
  });
  const raw = await fsa.readFile(p);
  assert.match(raw, /parentActor:/);
  assert.match(raw, /reviewer:/);
  assert.doesNotMatch(raw, /^dispatchedBy:/m);
  const task = await loadTaskEnvelope(fsa, p);
  assert.equal(task.parentActor?.id, "orchestrator");
  assert.equal(task.reviewer?.kind, "role");
  assert.equal(task.asSub, true);
});

test("writeTaskEnvelope refuses elevated policy for downstream Task Agent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-policy-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  const clock = new SystemClock();
  await assert.rejects(
    () =>
      writeTaskEnvelope(fsa, clock, {
        role: "helper",
        claims: [{ id: "cx-1", path: "a.md" }],
        manifestPath: "temp/helper/manifest.yml",
        userPrompt: "do it",
        parentActor: { kind: "role", id: "orchestrator" },
        deliveryPolicy: "bypass",
      }),
    /only legal for a durable Role's user-facing delivery|must use review/i
  );
});

test("migrateParentReviewerEnvelopes: one-time rewrite strips dispatchedBy", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-mig-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  // Legacy envelope without parentActor.
  await fsa.writeFile(
    "temp/helper/tasks/task-legacy.md",
    [
      "---",
      "type: task",
      "id: tk-legacy01",
      "status: pending",
      "state: queued",
      "role: helper",
      "dispatchedBy: orchestrator",
      "asSub: true",
      "claims: [cx-1]",
      "manifest: temp/helper/manifest.yml",
      "deliveryPolicy: review",
      "---",
      "# Task",
      "",
      "## User Prompt",
      "",
      "legacy",
      "",
    ].join("\n")
  );
  const clock = new SystemClock();
  const report = await migrateParentReviewerEnvelopes(fsa, clock);
  assert.equal(report.rewritten.length, 1);
  const raw = await fsa.readFile("temp/helper/tasks/task-legacy.md");
  const { data } = parseFrontmatter(raw);
  assert.equal((data.parentActor as { id: string }).id, "orchestrator");
  assert.equal((data.reviewer as { id: string }).id, "orchestrator");
  assert.equal(data.dispatchedBy, undefined);
  assert.equal(data.asSub, true);
  // Idempotent second pass.
  const again = await migrateParentReviewerEnvelopes(fsa, clock);
  assert.equal(again.rewritten.length, 0);
  const task = await loadTaskEnvelope(fsa, "temp/helper/tasks/task-legacy.md");
  assert.equal(task.parentActor?.id, "orchestrator");
  assert.equal(task.reviewer?.id, "orchestrator");
});

test("loadTaskEnvelope: in-memory migrate when disk still has legacy only", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-load-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  await fsa.writeFile(
    "temp/helper/tasks/task-mem.md",
    [
      "---",
      "type: task",
      "id: tk-mem0001",
      "status: taken",
      "state: running",
      "role: helper",
      "dispatchedBy: user",
      "claims: [cx-2]",
      "manifest: temp/helper/manifest.yml",
      "---",
      "# Task",
      "",
      "## User Prompt",
      "",
      "x",
      "",
    ].join("\n")
  );
  const task = await loadTaskEnvelope(fsa, "temp/helper/tasks/task-mem.md");
  assert.equal(task.parentActor?.kind, "user");
  assert.equal(task.reviewer?.id, "user");
  // Disk still has legacy until migrate runs — no permanent dual-write on load.
  const raw = await fsa.readFile("temp/helper/tasks/task-mem.md");
  assert.match(raw, /dispatchedBy:\s*user/);
});
