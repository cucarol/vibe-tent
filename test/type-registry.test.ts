import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import type { FsAdapter } from "../src/core/adapter.js";
import { loadTent } from "../src/core/tree.js";
import {
  assertValidNodeType,
  CANONICAL_PRIMARY_TYPES,
  DEFAULT_TYPE_REGISTRY,
  isCanonicalPrimary,
  isValidNodeType,
  loadTypeRegistry,
  normalizeRegistry,
  typeExists,
} from "../src/core/typeRegistry.js";
import {
  createSecondaryType,
  createType,
  deleteCustomType,
  retypeAfterMarkerRemoval,
} from "../src/core/typeManagement.js";
import { createNode, patchNode } from "../src/core/ops.js";
import { scaffoldTent } from "../src/core/scaffold.js";
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

  const goal = tent.byId.get("cx-g2")!;
  assert.equal(goal.type, "goal");
  assert.equal(goal.invalid, false);
  assert.equal(goal.archived, false);
  assert.equal(goal.mode, "editable");
  assert.equal("coordination" in goal, false);
  assert.equal("readable" in goal, false);
  assert.equal("writable" in goal, false);

  const out = tent.byId.get("cx-o1")!;
  assert.equal(out.type, "output");
  assert.ok(isValidNodeType("output", tent.typeRegistry));
  assert.ok(isValidNodeType("prompt-asset", tent.typeRegistry));
  assert.equal(typeExists("note", tent.typeRegistry), false);
  assert.equal(typeExists("artifact", tent.typeRegistry), false);
  assert.equal(isValidNodeType("asset", tent.typeRegistry), false);
  assert.equal(isValidNodeType("reference", tent.typeRegistry), false);
});

test("normalizeRegistry hard-cut: reject legacy buckets and invalid roots", () => {
  assert.throws(
    () => normalizeRegistry({ primary: {}, secondary: {} }),
    /Legacy primary\/secondary/
  );
  assert.throws(() => normalizeRegistry(null), /root must be an object/);
  assert.throws(() => normalizeRegistry([]), /root must be an object/);

  const flat = normalizeRegistry({
    goal: { tier: "base", readable: true, writable: false, coordination: true, color: "red" },
    note: { tier: "base" },
    artifact: { tier: "base" },
    open: { tier: "modifier" },
    sealed: { tier: "modifier" },
    reference: { tier: "modifier", readable: true, color: "blue" },
    asset: { tier: "modifier", writable: true },
    snippet: { tier: "modifier" },
    repo: { tier: "base" },
  });
  assert.equal(flat.note, undefined);
  assert.equal(flat.artifact, undefined);
  assert.equal(flat.open, undefined);
  assert.equal(flat.sealed, undefined);
  assert.equal(flat.repo, undefined, "custom primary bases are dropped");
  assert.ok(flat.snippet);
  assert.deepEqual(flat.goal, { tier: "base" });
  assert.deepEqual(flat.reference, { tier: "modifier" });
});

test("cannot create primary; can create custom secondary; no rename API", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await assert.rejects(
    () => createType(fsa, "repo", { tier: "base" }),
    /only allows creating custom secondary|primaries are fixed/
  );
  await assert.rejects(
    () => createType(fsa, "goal", { tier: "modifier" }),
    /Built-in primary/
  );
  await createSecondaryType(fsa, "snippet", {});
  const registry = await loadTypeRegistry(fsa);
  assert.equal(registry.snippet?.tier, "modifier");
  await deleteCustomType(fsa, "type", "snippet", "snippet");
  assert.equal((await loadTypeRegistry(fsa)).snippet, undefined);
});

test("deleteCustomType atomically rewrites primary-marker Nodes to primary", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await createSecondaryType(fsa, "snippet", {});
  const before = await loadTent(fsa);
  const box = before.byId.get("cx-p1");
  assert.ok(box);
  const note = path.join(dir, box.path, `${box.name}.md`);
  const raw = await fs.readFile(note, "utf8");
  await fs.writeFile(note, raw.replace(/^type:.*$/m, "type: prompt-snippet"), "utf8");

  // Builtin secondary still blocked.
  await assert.rejects(
    () => deleteCustomType(fsa, "type", "asset", "asset"),
    /Built-in types cannot be deleted/
  );

  // Marker delete rewrites compound usages then removes registry entry.
  await deleteCustomType(fsa, "type", "snippet", "snippet");
  assert.equal((await loadTypeRegistry(fsa)).snippet, undefined);
  const after = await loadTent(fsa);
  const rewritten = after.byId.get("cx-p1")!;
  assert.equal(rewritten.type, "prompt");
  assert.equal(rewritten.invalid, false);
  const disk = await fs.readFile(note, "utf8");
  assert.match(disk, /^type:\s*prompt\s*$/m);
});

test("deleteCustomType rolls back every Node when a mid-rewrite write fails", async () => {
  const dir = await makeTent();
  const base = new NodeFs(dir);
  await createSecondaryType(base, "snippet", {});
  const tent = await loadTent(base);
  const nodes = [tent.byId.get("cx-p1")!, tent.byId.get("cx-p2")!];
  for (const node of nodes) {
    const file = path.join(dir, node.path, `${path.basename(node.path)}.md`);
    const raw = await fs.readFile(file, "utf8");
    await fs.writeFile(file, raw.replace(/^type:.*$/m, "type: prompt-snippet"), "utf8");
  }
  const before = await snapshotTypeFiles(dir, nodes.map((node) => node.path));

  await assert.rejects(
    () => deleteCustomType(new FailOnceNodeFs(dir, 2), "type", "snippet", "snippet"),
    /injected write failure/
  );
  assert.deepEqual(await snapshotTypeFiles(dir, nodes.map((node) => node.path)), before);
});

test("deleteCustomType rolls back Nodes when the registry write fails", async () => {
  const dir = await makeTent();
  const base = new NodeFs(dir);
  await createSecondaryType(base, "snippet", {});
  const tent = await loadTent(base);
  const nodes = [tent.byId.get("cx-p1")!, tent.byId.get("cx-p2")!];
  for (const node of nodes) {
    const file = path.join(dir, node.path, `${path.basename(node.path)}.md`);
    const raw = await fs.readFile(file, "utf8");
    await fs.writeFile(file, raw.replace(/^type:.*$/m, "type: prompt-snippet"), "utf8");
  }
  const before = await snapshotTypeFiles(dir, nodes.map((node) => node.path));

  await assert.rejects(
    () => deleteCustomType(new FailOnceNodeFs(dir, 3), "type", "snippet", "snippet"),
    /injected write failure/
  );
  assert.deepEqual(await snapshotTypeFiles(dir, nodes.map((node) => node.path)), before);
});

class FailOnceNodeFs extends NodeFs implements FsAdapter {
  private writes = 0;
  constructor(root: string, private readonly failAt: number) {
    super(root);
  }
  override async writeFile(file: string, content: string): Promise<void> {
    this.writes += 1;
    if (this.writes === this.failAt) throw new Error("injected write failure");
    await super.writeFile(file, content);
  }
}

async function snapshotTypeFiles(
  dir: string,
  nodePaths: string[]
): Promise<Record<string, string>> {
  const out: Record<string, string> = {
    "types.json": await fs.readFile(path.join(dir, "types.json"), "utf8"),
  };
  for (const nodePath of nodePaths) {
    const file = path.join(dir, nodePath, `${path.basename(nodePath)}.md`);
    out[nodePath] = await fs.readFile(file, "utf8");
  }
  return out;
}

test("retypeAfterMarkerRemoval helper", () => {
  assert.equal(retypeAfterMarkerRemoval("prompt-snippet", "snippet"), "prompt");
  assert.equal(retypeAfterMarkerRemoval("goal-asset", "asset"), "goal");
  assert.equal(retypeAfterMarkerRemoval("prompt", "snippet"), "prompt");
  assert.equal(retypeAfterMarkerRemoval("snippet", "snippet"), null);
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

test("compound type validity: write strict, lifecycle lenient for unknown marker", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const tent = await loadTent(fsa);
  const assetNode = tent.byId.get("cx-a1")!;
  assert.equal(assetNode.type, "prompt-asset");
  assert.ok(typeExists("prompt-asset", tent.typeRegistry));
  assert.ok(isValidNodeType("goal-reference", tent.typeRegistry));

  // Bare marker never valid for write or lifecycle as a Node type.
  assert.equal(isValidNodeType("asset", tent.typeRegistry), false);
  assert.equal(typeExists("asset", tent.typeRegistry), false);
  assert.throws(() => assertValidNodeType("asset", tent.typeRegistry), /bare markers|Invalid node type/);
  assert.throws(() => assertValidNodeType("prompt-open", tent.typeRegistry), /Unknown type marker/);

  // Historical unknown marker on disk: lifecycle must not break (typeExists true, not invalid).
  const note = path.join(dir, "prompt", "旧站资料", "旧站资料.md");
  await fs.writeFile(note, "---\nid: cx-a1\ntype: prompt-open\n---\n");
  const after = await loadTent(fsa);
  const historical = after.byId.get("cx-a1")!;
  assert.equal(historical.type, "prompt-open");
  assert.equal(typeExists("prompt-open", after.typeRegistry), true);
  assert.equal(isValidNodeType("prompt-open", after.typeRegistry), false);
  assert.equal(historical.invalid, false);
});

test("ops createNode/patchNode reject bare marker and unknown marker", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = { fs: fsa, rand: () => 0.42 };

  await assert.rejects(
    () => createNode(env as any, { parentPath: "", name: "BareMarker", type: "asset" as any }),
    /bare markers|Invalid node type/
  );
  await assert.rejects(
    () => createNode(env as any, { parentPath: "", name: "UnknownMark", type: "prompt-nope" as any }),
    /Unknown type marker/
  );

  const id = await createNode(env as any, { parentPath: "", name: "ValidGoal", type: "goal" });
  assert.ok(id.startsWith("cx-"));

  await assert.rejects(
    () => patchNode(env as any, "ValidGoal", { type: "reference" }),
    /bare markers|Invalid node type/
  );
  await assert.rejects(
    () => patchNode(env as any, "ValidGoal", { type: "goal-missing" }),
    /Unknown type marker/
  );
  await patchNode(env as any, "ValidGoal", { type: "goal-asset" });
  const tent = await loadTent(fsa);
  assert.equal(tent.byPath.get("ValidGoal")?.type, "goal-asset");
});

test("scaffoldTent rejects bare marker Node types", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tent-scaffold-"));
  const fsa = new NodeFs(root);
  await assert.rejects(
    () =>
      scaffoldTent(fsa, {
        name: "bad",
        nodes: [{ name: "OnlyMarker", type: "asset" }],
      }),
    /bare markers|Invalid node type/
  );
  await scaffoldTent(fsa, {
    name: "ok",
    nodes: [{ name: "RootGoal", type: "goal" }],
  });
  const tent = await loadTent(fsa);
  assert.ok([...tent.byId.values()].some((n) => n.type === "goal"));
});
