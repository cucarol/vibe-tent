import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createNode } from "../src/core/ops.js";
import { scaffoldInWorkspace, scaffoldTent } from "../src/core/scaffold.js";
import { nodeNotePath, loadTent } from "../src/core/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { EventBus } from "../src/service/events.js";
import { WorkspaceHost } from "../src/service/workspace-host.js";
import {
  extractAttachmentReferences,
  resolveAttachmentPath,
} from "../src/markdown/attachment-refs.js";
import {
  ATTACHMENT_GC_STATE_PATH,
  sweepAttachmentGc,
} from "../src/markdown/attachment-gc.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T31 = "2026-02-01T00:00:01.000Z";

async function makeEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-asset-gc-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "asset-gc" });
  let seq = 0.1;
  const env = {
    fs: fsa,
    clock: { now: () => T0 },
    tentName: "asset-gc",
    rand: () => (seq += 0.1),
  };
  return { dir, fsa, env };
}

test("attachment refs normalize Markdown links, reference links and wiki embeds", () => {
  const body = [
    "![image](../../attachments/cx-a/one.png)",
    "[file][asset]",
    "![[../../attachments/cx-c/three.png]]",
    "",
    "[asset]: <../../attachments/cx-b/two file.pdf>",
  ].join("\n");
  const refs = extractAttachmentReferences(body, "parent/child/child.md");
  assert.deepEqual(
    refs.map((ref) => ref.path).sort(),
    [
      "attachments/cx-a/one.png",
      "attachments/cx-b/two file.pdf",
      "attachments/cx-c/three.png",
    ]
  );
  assert.equal(resolveAttachmentPath("https://example.test/a.png", "x/x.md"), undefined);
  assert.equal(resolveAttachmentPath("../../outside.png", "x/x.md"), undefined);
});

test("attachment GC retains every file owned by a live or archived concept", async () => {
  const { fsa, env } = await makeEnv();
  const id = await createNode(env as never, { parentPath: "", name: "owner", type: "prompt" });
  const tent = await loadTent(fsa);
  const owner = tent.byId.get(id)!;
  const raw = await fsa.readFile(nodeNotePath(owner.path));
  await fsa.writeFile(nodeNotePath(owner.path), raw.replace("type: prompt", "type: prompt\nmode: archived"));
  const attachment = `attachments/${id}/unused.png`;
  await fsa.writeBinary(attachment, new Uint8Array([1, 2, 3]));

  const result = await sweepAttachmentGc(fsa, { now: T31, graceDays: 0 });
  assert.equal(result.retainedByOwner, 1);
  assert.equal(result.deleted.length, 0);
  assert.equal(await fsa.exists(attachment), true);
});

test("attachment GC gives an unreferenced orphan a full first-seen grace period", async () => {
  const { fsa } = await makeEnv();
  const attachment = "attachments/cx-gone/orphan.bin";
  await fsa.writeBinary(attachment, new Uint8Array([9]));

  const first = await sweepAttachmentGc(fsa, { now: T0 });
  assert.equal(first.deleted.length, 0);
  assert.equal(first.candidates, 1);
  assert.equal(await fsa.exists(attachment), true);

  const second = await sweepAttachmentGc(fsa, { now: T31 });
  assert.deepEqual(second.deleted, [attachment]);
  assert.equal(await fsa.exists(attachment), false);
  assert.equal(await fsa.exists("attachments/cx-gone"), false);
});

test("cross-concept and operational references retain orphan-owner attachments", async () => {
  const { fsa, env } = await makeEnv();
  const conceptAttachment = "attachments/cx-old/concept.png";
  const taskAttachment = "attachments/cx-task/task.png";
  await fsa.writeBinary(conceptAttachment, new Uint8Array([1]));
  await fsa.writeBinary(taskAttachment, new Uint8Array([2]));

  const keeperId = await createNode(env as never, { parentPath: "", name: "keeper", type: "prompt" });
  const keeper = (await loadTent(fsa)).byId.get(keeperId)!;
  const notePath = nodeNotePath(keeper.path);
  await fsa.writeFile(
    notePath,
    (await fsa.readFile(notePath)) + `\n![](../${conceptAttachment})\n`
  );
  await fsa.mkdir("temp/role/tasks");
  await fsa.writeFile(
    "temp/role/tasks/task.md",
    `---\ntype: task\n---\nreview ![](../../../${taskAttachment})\n`
  );

  await sweepAttachmentGc(fsa, { now: T0 });
  const result = await sweepAttachmentGc(fsa, { now: T31 });
  assert.equal(result.retainedByReference, 2);
  assert.equal(result.deleted.length, 0);
});

test("a restored reference clears candidacy and starts a new grace window if removed", async () => {
  const { fsa, env } = await makeEnv();
  const attachment = "attachments/cx-old/restored.png";
  await fsa.writeBinary(attachment, new Uint8Array([3]));
  await sweepAttachmentGc(fsa, { now: T0 });

  const keeperId = await createNode(env as never, { parentPath: "", name: "keeper", type: "prompt" });
  const keeper = (await loadTent(fsa)).byId.get(keeperId)!;
  const notePath = nodeNotePath(keeper.path);
  const original = await fsa.readFile(notePath);
  await fsa.writeFile(notePath, original + `\n![](../${attachment})\n`);
  const retained = await sweepAttachmentGc(fsa, { now: T31 });
  assert.equal(retained.retainedByReference, 1);

  await fsa.writeFile(notePath, original);
  const orphanAgain = await sweepAttachmentGc(fsa, { now: "2026-02-02T00:00:00.000Z" });
  assert.equal(orphanAgain.deleted.length, 0);
  assert.equal(orphanAgain.candidates, 1);
});

test("corrupt GC state resets candidates and never deletes on that sweep", async () => {
  const { fsa } = await makeEnv();
  const attachment = "attachments/cx-gone/safe.bin";
  await fsa.writeBinary(attachment, new Uint8Array([4]));
  await fsa.writeFile(ATTACHMENT_GC_STATE_PATH, "{broken");

  const result = await sweepAttachmentGc(fsa, { now: T31, graceDays: 0 });
  assert.equal(result.deleted.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("state reset")));
  assert.equal(await fsa.exists(attachment), true);
});

test("workspace housekeeping runs invisibly after mount and disposes its timer", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-housekeeper-"));
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "housekeeper" });
  let resolveRun!: () => void;
  const ran = new Promise<void>((resolve) => (resolveRun = resolve));
  let calls = 0;
  const host = new WorkspaceHost({
    events: new EventBus(),
    housekeepingInitialDelayMs: 0,
    housekeepingIntervalMs: 60_000,
    housekeeper: async () => {
      calls += 1;
      resolveRun();
    },
  });
  try {
    await host.mount(workspace);
    await Promise.race([
      ran,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("housekeeper did not run")), 1_000)
      ),
    ]);
    assert.equal(calls, 1);
  } finally {
    await host.dispose();
  }
});
