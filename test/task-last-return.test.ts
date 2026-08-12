import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createDelivery, loadDelivery } from "../src/core/delivery.js";
import { contentEtag } from "../src/core/etag.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import {
  loadTaskEnvelope,
  parseTaskLastReturn,
  patchTaskEnvelope,
  TASK_LAST_RETURN_ERROR_MAX_BYTES,
  TASK_LAST_RETURN_REPORT_MAX_BYTES,
  writeTaskEnvelope,
} from "../src/core/task.js";
import { NodeFs, SystemClock } from "../src/fs/node-fs.js";

test("Task lastReturn parser enforces exact bounded formal-return wire", () => {
  assert.deepEqual(parseTaskLastReturn({
    kind: "failed",
    report: "formal report",
    error: "formal error",
    code: "TASK_FAILED",
    at: "2026-08-13T00:00:00.000Z",
    sessionId: "SS-ABC",
  }), {
    kind: "failed",
    report: "formal report",
    error: "formal error",
    code: "TASK_FAILED",
    at: "2026-08-13T00:00:00.000Z",
    sessionId: "SS-ABC",
  });
  assert.doesNotThrow(() => parseTaskLastReturn({
    kind: "blocked",
    report: "a".repeat(TASK_LAST_RETURN_REPORT_MAX_BYTES),
  }));
  assert.throws(() => parseTaskLastReturn({
    kind: "blocked",
    report: "a".repeat(TASK_LAST_RETURN_REPORT_MAX_BYTES + 1),
  }), /exceeds 65536 UTF-8 bytes/);
  assert.throws(() => parseTaskLastReturn({
    kind: "failed",
    error: "a".repeat(TASK_LAST_RETURN_ERROR_MAX_BYTES + 1),
  }), /exceeds 8192 UTF-8 bytes/);
  assert.throws(() => parseTaskLastReturn({ kind: "failed" }), /requires report or error/);
  assert.throws(
    () => parseTaskLastReturn({ kind: "failed", error: "x", extra: true }),
    /unknown fields/
  );
});

test("retired raw Task and Delivery outcome keys remain inert typed data", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-last-return-wire-"));
  const adapter = new NodeFs(dir);
  const clock = new SystemClock();
  await adapter.mkdir("temp/roles/rl-test/tasks");
  const taskPath = await writeTaskEnvelope(adapter, clock, {
    roleId: "rl-test",
    workNodeIds: ["cx-work"],
    contextNodeIds: [],
    nodeSnapshots: [{
      id: "cx-work",
      path: "work.md",
      type: "prompt",
      tags: [],
      body: "# work\n",
      etag: contentEtag("# work\n"),
    }],
    manifestPath: "temp/roles/rl-test/manifest.yml",
    userPrompt: "work",
    parentActor: { kind: "user", id: "user" },
  });
  const retiredTaskKey = ["last", "Outcome"].join("");
  const taskRaw = parseFrontmatter(await adapter.readFile(taskPath));
  taskRaw.data[retiredTaskKey] = "delivered";
  await adapter.writeFile(
    taskPath,
    serializeFrontmatter(taskRaw.data, taskRaw.body, taskRaw.keyOrder)
  );
  const loadedTask = await loadTaskEnvelope(adapter, taskPath);
  assert.equal((loadedTask as unknown as Record<string, unknown>)[retiredTaskKey], undefined);
  await patchTaskEnvelope(adapter, taskPath, { updatedAt: clock.now() });
  assert.equal(
    parseFrontmatter(await adapter.readFile(taskPath)).data[retiredTaskKey],
    "delivered",
    "generic Task frontmatter preservation remains raw and inert"
  );

  const delivery = await createDelivery(adapter, clock, {
    taskId: loadedTask.id!,
    sourceNodeId: "cx-work",
    deliveriesDir: "temp/roles/rl-test/deliveries",
    summary: "formal Delivery",
    status: "ready",
  });
  const retiredDeliveryKey = ["task", "Last", "Outcome"].join("");
  const deliveryRaw = parseFrontmatter(await adapter.readFile(delivery.path));
  deliveryRaw.data[retiredDeliveryKey] = "delivered";
  await adapter.writeFile(
    delivery.path,
    serializeFrontmatter(deliveryRaw.data, deliveryRaw.body, deliveryRaw.keyOrder)
  );
  const loadedDelivery = await loadDelivery(adapter, delivery.path);
  assert.equal(
    (loadedDelivery as unknown as Record<string, unknown>)[retiredDeliveryKey],
    undefined
  );
});
