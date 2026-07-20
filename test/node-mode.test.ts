import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent, boxNotePath, isContentMutable, isUsableBox } from "../src/core/tree.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { migrateLegacySchema } from "../src/core/migration.js";
import { makeTent } from "./helpers.js";

function envFor(dir: string) {
  return {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "x",
  };
}

test("mode matrix: editable keeps type/self R/W; read-only forces W only; archived forces R/W", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const { setNodeMode, patchBody, patchBox } = await import("../src/core/ops.js");
  const env = envFor(dir);

  // goal base: R true W false under editable (type honor, not mutation gate)
  let tent = await loadTent(fsa);
  const goal = tent.byId.get("bx-g2")!;
  assert.equal(goal.mode, "editable");
  assert.equal(goal.writable.value, false);
  assert.equal(goal.writable.source, "type");
  assert.equal(isContentMutable(goal), true, "type W=false must not hard-deny content mutation");
  await patchBody(env as any, goal.path, "goal body ok\n");

  // prompt with self writable true
  const draft = tent.byId.get("bx-p2")!;
  assert.equal(draft.writable.source, "self");
  assert.equal(draft.writable.value, true);

  await setNodeMode(env as any, draft.id, "read-only");
  tent = await loadTent(fsa);
  const ro = tent.byId.get(draft.id)!;
  assert.equal(ro.mode, "read-only");
  assert.equal(ro.archived, false);
  assert.equal(ro.readable.value, true, "read-only preserves readable");
  assert.equal(ro.writable.value, false);
  assert.equal(ro.writable.source, "mode");
  assert.equal(isUsableBox(ro), true, "read-only stays in normal collab usable set");
  assert.equal(isContentMutable(ro), false);
  await assert.rejects(() => patchBody(env as any, ro.path, "nope\n"), /Read-only/);
  await assert.rejects(() => patchBox(env as any, ro.path, { tags: ["x"] }), /Read-only|reserved|cannot/i);

  // child of read-only parent remains editable (no cascade)
  const parentPath = ro.path;
  const childId = tent.byPath.get(parentPath)?.children[0]?.id;
  if (childId) {
    const child = tent.byId.get(childId)!;
    assert.equal(child.mode, "editable");
    assert.notEqual(child.mode, "read-only");
  }

  await setNodeMode(env as any, ro.id, "editable");
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get(ro.id)!.mode, "editable");
  assert.equal(tent.byId.get(ro.id)!.writable.value, true);

  await setNodeMode(env as any, "bx-p1", "archived");
  tent = await loadTent(fsa);
  const archRoot = tent.byId.get("bx-p1")!;
  const archChild = tent.byId.get("bx-p2")!;
  assert.equal(archRoot.mode, "archived");
  assert.equal(archChild.mode, "archived");
  assert.equal(archRoot.readable.value, false);
  assert.equal(archRoot.writable.value, false);
  assert.equal(archChild.readable.source, "archived");
  assert.equal(isUsableBox(archRoot), false);
  assert.equal(isContentMutable(archRoot), false);
});

test("sealed type under editable still honor R/W false; mode still gates mutations only via mode", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  // Ensure a sealed compound type exists on a node via frontmatter rewrite
  const note = path.join(dir, "prompt", "旧站资料", "旧站资料.md");
  const raw = await fs.readFile(note, "utf8");
  const { data, body, keyOrder } = parseFrontmatter(raw);
  data.type = "goal-sealed";
  await fs.writeFile(note, serializeFrontmatter(data, body, keyOrder));

  let tent = await loadTent(fsa);
  const box = tent.byPath.get("prompt/旧站资料")!;
  assert.equal(box.mode, "editable");
  assert.equal(box.readable.value, false);
  assert.equal(box.writable.value, false);
  assert.equal(box.writable.source, "type");
  assert.equal(isContentMutable(box), true, "sealed type W=false is honor, not Core ACL");

  const { patchBody, setNodeMode } = await import("../src/core/ops.js");
  const env = envFor(dir);
  await patchBody(env as any, box.path, "sealed still body-editable under Core\n");

  await setNodeMode(env as any, box.id, "read-only");
  tent = await loadTent(fsa);
  const ro = tent.byId.get(box.id)!;
  assert.equal(ro.readable.value, false, "type R=false still applies under read-only");
  assert.equal(ro.writable.value, false);
  assert.equal(ro.writable.source, "mode");
  await assert.rejects(() => patchBody(env as any, ro.path, "x\n"), /Read-only/);
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
  // Child derived without disk mode (lookup by path — migrate also remaps bx-→cx-)
  const child = tent.byPath.get("prompt/表达式任务书/草稿")!;
  assert.ok(child);
  assert.equal(child.mode, "archived");
  const childDisk = parseFrontmatter(await fsa.readFile(boxNotePath(child.path))).data;
  assert.equal("mode" in childDisk, false);
});

test("patchBox / setNodeMode reserved path; restore/delete key off explicit mode", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = envFor(dir);
  const { patchBox, setNodeMode, restoreBox, deleteArchivedBox, archiveBox } = await import(
    "../src/core/ops.js"
  );

  await assert.rejects(
    () => patchBox(env as any, "prompt/表达式任务书", { mode: "read-only" }),
    /Reserved fields/
  );

  await setNodeMode(env as any, "bx-p1", "read-only");
  let tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-p1")!.mode, "read-only");
  // read-only does not cascade
  assert.equal(tent.byId.get("bx-p2")!.mode, "editable");

  await setNodeMode(env as any, "bx-p1", "archived");
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-p1")!.fm.mode, "archived");
  assert.equal(tent.byId.get("bx-p2")!.archived, true);

  await restoreBox(env as any, "bx-p1");
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-p1")!.mode, "editable");

  await archiveBox(env as any, "bx-p1");
  await deleteArchivedBox(env as any, "bx-p1");
  tent = await loadTent(fsa);
  assert.equal(tent.byId.has("bx-p1"), false);
});
