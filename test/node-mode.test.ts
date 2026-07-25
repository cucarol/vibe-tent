import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent, boxNotePath, isContentMutable, isUsableBox } from "../src/core/tree.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { migrateLegacySchema } from "../src/core/migration.js";
import {
  archiveBox,
  deleteArchivedBox,
  patchBody,
  patchBox,
  restoreBox,
  setNodeMode,
} from "../src/core/ops.js";
import { makeTent } from "./helpers.js";

function envFor(dir: string) {
  return {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "x",
  };
}

test("mode matrix: editable mutates; archived freezes; no read-only", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = envFor(dir);

  let tent = await loadTent(fsa);
  const goal = tent.byId.get("bx-g2")!;
  assert.equal(goal.mode, "editable");
  assert.equal(isContentMutable(goal), true);
  await patchBody(env as any, goal.path, "goal body ok\n");

  const draft = tent.byId.get("bx-p2")!;
  assert.equal(draft.mode, "editable");
  assert.equal(isContentMutable(draft), true);

  await assert.rejects(
    () => setNodeMode(env as any, draft.id, "read-only" as any),
    /read-only mode is retired/
  );

  await setNodeMode(env as any, "bx-p1", "archived");
  tent = await loadTent(fsa);
  const archRoot = tent.byId.get("bx-p1")!;
  const archChild = tent.byId.get("bx-p2")!;
  assert.equal(archRoot.mode, "archived");
  assert.equal(archChild.mode, "archived");
  assert.equal(archRoot.archived, true);
  assert.equal("readable" in archRoot, false);
  assert.equal("writable" in archRoot, false);
  assert.equal(isUsableBox(archRoot), false);
  assert.equal(isContentMutable(archRoot), false);
  await assert.rejects(() => patchBody(env as any, archRoot.path, "nope\n"), /archived/i);
  await assert.rejects(() => patchBox(env as any, archRoot.path, { tags: ["x"] }), /archived|restored/i);
});

test("one-shot migration archived:true → mode:archived; no dual-read leftover", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const notePath = "prompt/表达式任务书/表达式任务书.md";
  const full = path.join(dir, ...notePath.split("/"));
  const raw = await fs.readFile(full, "utf8");
  const { data, body, keyOrder } = parseFrontmatter(raw);
  data.archived = true;
  delete data.mode;
  await fs.writeFile(full, serializeFrontmatter(data, body, keyOrder));

  const report = await migrateLegacySchema(fsa, { rewriteOperationalRefs: false });
  assert.ok(report.registryChanges.some((c) => c.includes("archived→mode")));

  const after = parseFrontmatter(await fsa.readFile(notePath)).data;
  assert.equal(after.mode, "archived");
  assert.equal("archived" in after, false);

  const tent = await loadTent(fsa);
  const box = tent.byPath.get("prompt/表达式任务书")!;
  assert.ok(box, "archive root still indexed after migration");
  assert.equal(box.mode, "archived");
  assert.equal(box.archived, true);
  const child = tent.byPath.get("prompt/表达式任务书/草稿")!;
  assert.ok(child);
  assert.equal(child.mode, "archived");
  const childDisk = parseFrontmatter(await fsa.readFile(boxNotePath(child.path))).data;
  assert.equal("mode" in childDisk, false);
});

test("migration clears read-only mode and R/W frontmatter", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const notePath = "prompt/表达式任务书/草稿/草稿.md";
  const full = path.join(dir, ...notePath.split("/"));
  const raw = await fs.readFile(full, "utf8");
  const { data, body, keyOrder } = parseFrontmatter(raw);
  data.mode = "read-only";
  data.readable = false;
  data.writable = true;
  await fs.writeFile(full, serializeFrontmatter(data, body, keyOrder));

  await migrateLegacySchema(fsa, { rewriteOperationalRefs: false });
  const after = parseFrontmatter(await fsa.readFile(notePath)).data;
  assert.equal("mode" in after, false);
  assert.equal("readable" in after, false);
  assert.equal("writable" in after, false);

  const tent = await loadTent(fsa);
  const box = tent.byPath.get("prompt/表达式任务书/草稿")!;
  assert.equal(box.mode, "editable");
  assert.equal(isContentMutable(box), true);
});

test("patchBox / setNodeMode reserved path; restore/delete key off explicit mode", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = envFor(dir);

  await assert.rejects(
    () => patchBox(env as any, "prompt/表达式任务书", { mode: "archived" }),
    /Reserved/
  );
  await assert.rejects(
    () => patchBox(env as any, "prompt/表达式任务书", { readable: true }),
    /Reserved|retired/i
  );

  await archiveBox(env as any, "bx-p1");
  let tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-p1")!.mode, "archived");

  await restoreBox(env as any, "bx-p1");
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-p1")!.mode, "editable");

  await setNodeMode(env as any, "bx-p1", "archived");
  await deleteArchivedBox(env as any, "bx-p1");
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-p1"), undefined);
});
