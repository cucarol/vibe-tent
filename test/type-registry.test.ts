import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { normalizeOptionalNodeType } from "../src/core/node-type.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { loadTent } from "../src/core/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";

test("Node type is one optional trimmed direct marker", () => {
  assert.equal(normalizeOptionalNodeType(undefined), undefined);
  assert.equal(normalizeOptionalNodeType("  research-note  "), "research-note");
  assert.equal(normalizeOptionalNodeType("goal-asset"), "goal-asset");
  assert.throws(() => normalizeOptionalNodeType("   "), /non-empty/);
  assert.throws(() => normalizeOptionalNodeType(["goal"]), /must be a string/);
});

test("Node loading accepts absent and arbitrary direct type without registry authority", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-node-type-"));
  const adapter = new NodeFs(dir);
  await adapter.mkdir("Untyped");
  await adapter.writeFile("Untyped/Untyped.md", "---\nid: cx-untyped\n---\n# Untyped\n");
  await adapter.mkdir("Typed");
  await adapter.writeFile(
    "Typed/Typed.md",
    "---\nid: cx-typed\ntype: \"  any direct marker  \"\n---\n# Typed\n"
  );
  // A retired registry file is inert user/system-root inventory, not authority.
  await adapter.writeFile("types.json", "{ this is not valid json }");

  const tent = await loadTent(adapter);
  assert.equal(tent.byId.get("cx-untyped")?.type, undefined);
  assert.equal(tent.byId.get("cx-untyped")?.invalid, false);
  assert.equal(tent.byId.get("cx-typed")?.type, "any direct marker");
  assert.equal(tent.byId.get("cx-typed")?.invalid, false);
  assert.equal(("type" + "Registry") in tent, false);
});

test("present empty or non-string Node type is invalid and repairable by path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-node-type-invalid-"));
  const adapter = new NodeFs(dir);
  await adapter.mkdir("Empty");
  await adapter.writeFile("Empty/Empty.md", "---\nid: cx-empty\ntype: \"   \"\n---\n");
  await adapter.mkdir("Array");
  await adapter.writeFile("Array/Array.md", "---\nid: cx-array\ntype: [goal]\n---\n");

  const tent = await loadTent(adapter);
  for (const [nodePath, id] of [["Empty", "cx-empty"], ["Array", "cx-array"]] as const) {
    const node = tent.byPath.get(nodePath);
    assert.ok(node);
    assert.equal(node.invalid, true);
    assert.equal(node.type, undefined);
    assert.equal(tent.byId.has(id), false);
  }
  assert.match(tent.byPath.get("Empty")?.invalidReason ?? "", /non-empty/);
  assert.match(tent.byPath.get("Array")?.invalidReason ?? "", /must be a string/);
});

test("scaffold writes only an optional direct type and no type registry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-node-type-scaffold-"));
  const adapter = new NodeFs(dir);
  await scaffoldTent(adapter, {
    name: "single-type",
    nodes: [
      { name: "Untyped" },
      { name: "Typed", type: "  experiment  " },
    ],
  });

  assert.equal(await adapter.exists("types.json"), false);
  const tent = await loadTent(adapter);
  assert.equal(tent.byPath.get("Untyped")?.type, undefined);
  assert.equal(tent.byPath.get("Typed")?.type, "experiment");
  assert.doesNotMatch(await adapter.readFile("Untyped/Untyped.md"), /^type:/m);
  assert.match(await adapter.readFile("Typed/Typed.md"), /^type:\s*experiment$/m);
});
