import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createTaskResult, loadTaskResult } from "../src/core/task-result.js";
import { contentEtag } from "../src/core/etag.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import {
  loadTaskRecord,
  parseTaskStatusDetail,
  patchTaskRecord,
  TASK_STATUS_DETAIL_ERROR_MAX_BYTES,
  TASK_STATUS_DETAIL_REPORT_MAX_BYTES,
  writeTaskRecord,
} from "../src/core/task.js";
import { NodeFs, SystemClock } from "../src/fs/node-fs.js";

test("Task statusDetail parser enforces exact bounded formal-return wire", () => {
  assert.deepEqual(parseTaskStatusDetail({
    kind: "failed",
    report: "formal report",
    error: "formal error",
    code: "TASK_FAILED",
    at: "2026-08-13T00:00:00.000Z",
    executionSessionId: "SS-ABC",
  }), {
    kind: "failed",
    report: "formal report",
    error: "formal error",
    code: "TASK_FAILED",
    at: "2026-08-13T00:00:00.000Z",
    executionSessionId: "SS-ABC",
  });
  assert.doesNotThrow(() => parseTaskStatusDetail({
    kind: "blocked",
    report: "a".repeat(TASK_STATUS_DETAIL_REPORT_MAX_BYTES),
  }));
  assert.throws(() => parseTaskStatusDetail({
    kind: "blocked",
    report: "a".repeat(TASK_STATUS_DETAIL_REPORT_MAX_BYTES + 1),
  }), /exceeds 65536 UTF-8 bytes/);
  assert.throws(() => parseTaskStatusDetail({
    kind: "failed",
    error: "a".repeat(TASK_STATUS_DETAIL_ERROR_MAX_BYTES + 1),
  }), /exceeds 8192 UTF-8 bytes/);
  assert.throws(() => parseTaskStatusDetail({ kind: "failed" }), /requires report or error/);
  assert.throws(
    () => parseTaskStatusDetail({ kind: "failed", error: "x", extra: true }),
    /unknown fields/
  );
});

test("retired raw Task and TaskResult outcome keys remain inert typed data", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-last-return-wire-"));
  const adapter = new NodeFs(dir);
  const clock = new SystemClock();
  await adapter.mkdir("temp/roles/rl-test/tasks");
  const taskPath = await writeTaskRecord(adapter, clock, {
    assigneeRoleId: "rl-test",
    nodeIds: ["cx-work"],
    nodeSnapshots: [{
      id: "cx-work",
      path: "work.md",
      type: "prompt",
      archived: false,
      tags: [],
      body: "# work\n",
      etag: contentEtag("# work\n"),
    }],
    manifestPath: "temp/roles/rl-test/manifest.yml",
    prompt: "work",
    requester: { kind: "user", id: "user" },
  });
  const retiredTaskKey = ["last", "Outcome"].join("");
  const taskRaw = parseFrontmatter(await adapter.readFile(taskPath));
  taskRaw.data[retiredTaskKey] = "delivered";
  await adapter.writeFile(
    taskPath,
    serializeFrontmatter(taskRaw.data, taskRaw.body, taskRaw.keyOrder)
  );
  const loadedTask = await loadTaskRecord(adapter, taskPath);
  assert.equal((loadedTask as unknown as Record<string, unknown>)[retiredTaskKey], undefined);
  await patchTaskRecord(adapter, taskPath, { updatedAt: clock.now() });
  assert.equal(
    parseFrontmatter(await adapter.readFile(taskPath)).data[retiredTaskKey],
    "delivered",
    "generic Task frontmatter preservation remains raw and inert"
  );

  const result = await createTaskResult(adapter, clock, {
    taskId: loadedTask.id!,
    resultsDir: "temp/roles/rl-test/results",
    report: "formal TaskResult",
    status: "ready",
  });
  const retiredTaskResultKey = ["task", "Last", "Outcome"].join("");
  const resultRaw = parseFrontmatter(await adapter.readFile(result.path));
  resultRaw.data[retiredTaskResultKey] = "delivered";
  await adapter.writeFile(
    result.path,
    serializeFrontmatter(resultRaw.data, resultRaw.body, resultRaw.keyOrder)
  );
  const loadedTaskResult = await loadTaskResult(adapter, result.path);
  assert.equal(
    (loadedTaskResult as unknown as Record<string, unknown>)[retiredTaskResultKey],
    undefined
  );
});
