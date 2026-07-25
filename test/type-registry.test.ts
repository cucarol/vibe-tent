import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import {
  CANONICAL_PRIMARY_TYPES,
  DEFAULT_TYPE_REGISTRY,
  isCanonicalPrimary,
  isValidConceptType,
  loadTypeRegistry,
  normalizeRegistry,
  typeExists,
} from "../src/core/typeRegistry.js";
import {
  createPrimaryType,
  createSecondaryType,
  deleteCustomType,
} from "../src/core/typeManagement.js";
import { makeTent } from "./helpers.js";

test("V0.2 defaults: goal|prompt|output + reference|asset only", async () => {
  const dir = await makeTent();
  const tent = await loadTent(new NodeFs(dir));

  assert.deepEqual(
    Object.keys(tent.typeRegistry).sort(),
    ["asset", "goal", "output", "prompt", "reference"].sort()
  );
  for (const p of CANONICAL_PRIMARY_TYPES) {
    assert.equal(tent.typeRegistry[p]?.tier ?? "base", "base");
    assert.ok(isCanonicalPrimary(p));
  }
  assert.equal(tent.typeRegistry.reference?.tier, "modifier");
  assert.equal(tent.typeRegistry.asset?.tier, "modifier");
  assert.equal(tent.typeRegistry.note, undefined);
  assert.equal(tent.typeRegistry.artifact, undefined);

  const goal = tent.byId.get("bx-g2")!;
  assert.equal(goal.type, "goal");
  assert.equal(goal.invalid, false);
  assert.equal(goal.archived, false);
  assert.equal(goal.mode, "editable");
  assert.equal("coordination" in goal, false);
  assert.equal("readable" in goal, false);
  assert.equal("writable" in goal, false);

  const out = tent.byId.get("bx-o1")!;
  assert.equal(out.type, "output");
  assert.ok(isValidConceptType("output", tent.typeRegistry));
  assert.ok(isValidConceptType("prompt-asset", tent.typeRegistry));
  assert.equal(typeExists("note", tent.typeRegistry), false);
  assert.equal(typeExists("artifact", tent.typeRegistry), false);
});

test("normalizeRegistry maps note→prompt, artifact→output and strips chrome", () => {
  const legacy = normalizeRegistry({
    note: { tier: "base", readable: true, writable: true, coordination: false, color: "gray" },
    goal: { tier: "base", readable: true, writable: false, coordination: true },
    prompt: { tier: "base", readable: true, writable: true },
    artifact: { tier: "base", readable: true, writable: true, coordination: true, description: "old" },
    open: { tier: "modifier", readable: true },
    sealed: { tier: "modifier", readable: false, writable: false },
    reference: { tier: "modifier", readable: true, color: "blue" },
    asset: { tier: "modifier", writable: true },
  });
  assert.equal(legacy.note, undefined);
  assert.equal(legacy.artifact, undefined);
  assert.equal(legacy.open, undefined);
  assert.equal(legacy.sealed, undefined);
  assert.ok(legacy.prompt);
  assert.ok(legacy.output);
  assert.equal(legacy.output.tier ?? "base", "base");
  // slim objects: only tier
  assert.deepEqual(legacy.goal, { tier: "base" });
  assert.deepEqual(legacy.reference, { tier: "modifier" });
});

test("legacy {primary,secondary} flattens to V0.2", () => {
  const registry = normalizeRegistry({
    primary: {
      goal: { readable: true, writable: false },
      artifact: { readable: true, writable: true, workspacePointer: true },
    },
    secondary: { asset: { writable: true, color: "purple" }, open: { readable: true } },
  });
  assert.ok(registry.output);
  assert.equal(registry.artifact, undefined);
  assert.equal(registry.open, undefined);
  assert.ok(registry.asset);
});

test("cannot create primary; can create custom secondary", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await assert.rejects(() => createPrimaryType(fsa, "repo", { tier: "base" }), /fixed to goal\|prompt\|output/);
  await createSecondaryType(fsa, "snippet", {});
  const registry = await loadTypeRegistry(fsa);
  assert.equal(registry.snippet?.tier, "modifier");
  await deleteCustomType(fsa, "type", "snippet", "snippet");
  assert.equal((await loadTypeRegistry(fsa)).snippet, undefined);
});

test("deleteCustomType fails loud when nodes still reference the type", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await createSecondaryType(fsa, "snippet", {});
  // Attach custom secondary via identity note (resolve path by id — fixture names vary by locale).
  const before = await loadTent(fsa);
  const box = before.byId.get("bx-p1");
  assert.ok(box);
  const note = path.join(dir, box.path, `${box.name}.md`);
  const raw = await fs.readFile(note, "utf8");
  await fs.writeFile(note, raw.replace(/^type:.*$/m, "type: prompt-snippet"), "utf8");

  await assert.rejects(
    () => deleteCustomType(fsa, "type", "snippet", "snippet"),
    /still in use/
  );
  assert.equal((await loadTypeRegistry(fsa)).snippet?.tier, "modifier");

  // Builtin secondary also blocked.
  await assert.rejects(
    () => deleteCustomType(fsa, "type", "asset", "asset"),
    /Built-in types cannot be deleted/
  );

  // Clear usage then delete succeeds.
  await fs.writeFile(note, raw.replace(/^type:.*$/m, "type: prompt"), "utf8");
  await deleteCustomType(fsa, "type", "snippet", "snippet");
  assert.equal((await loadTypeRegistry(fsa)).snippet, undefined);
});

test("DEFAULT_TYPE_REGISTRY matches product contract", () => {
  assert.deepEqual(Object.keys(DEFAULT_TYPE_REGISTRY).sort(), [
    "asset",
    "goal",
    "output",
    "prompt",
    "reference",
  ]);
});

test("compound type validity", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  // legacy compound under prompt-asset fixture
  const tent = await loadTent(fsa);
  const assetNode = tent.byId.get("bx-a1")!;
  assert.equal(assetNode.type, "prompt-asset");
  assert.ok(typeExists("prompt-asset", tent.typeRegistry));
  assert.ok(isValidConceptType("goal-reference", tent.typeRegistry));

  // write unknown secondary → invalid
  const note = path.join(dir, "prompt", "旧站资料", "旧站资料.md");
  await fs.writeFile(note, "---\nid: bx-a1\ntype: prompt-open\n---\n");
  const after = await loadTent(fsa);
  const bad = after.byId.get("bx-a1")!;
  assert.equal(bad.invalid, true);
  assert.match(bad.invalidReason || "", /Unknown type/);
});
