import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import {
  migrateLegacySchema,
  migrateTypeRegistryJson,
  rewriteCanonicalConceptType,
} from "../src/core/migration.js";
import { makeTent } from "./helpers.js";

test("rewriteCanonicalConceptType: note→prompt, artifact→output, open/sealed drop", () => {
  assert.equal(rewriteCanonicalConceptType("note"), "prompt");
  assert.equal(rewriteCanonicalConceptType("note-reference"), "prompt-reference");
  assert.equal(rewriteCanonicalConceptType("artifact"), "output");
  assert.equal(rewriteCanonicalConceptType("artifact-asset"), "output-asset");
  assert.equal(rewriteCanonicalConceptType("output"), undefined);
  assert.equal(rewriteCanonicalConceptType("output-asset"), undefined);
  assert.equal(rewriteCanonicalConceptType("goal-open"), "goal");
  assert.equal(rewriteCanonicalConceptType("prompt-sealed"), "prompt");
  assert.equal(rewriteCanonicalConceptType("goal"), undefined);
});

test("migrateTypeRegistryJson is idempotent and V0.2-shaped", () => {
  const first = migrateTypeRegistryJson({
    note: { tier: "base", readable: true, writable: true, coordination: false },
    goal: { tier: "base", readable: true, writable: false, coordination: true, color: "blue" },
    artifact: { tier: "base", readable: true, writable: true, workspacePointer: true },
    open: { tier: "modifier" },
    asset: { tier: "modifier", writable: true },
  });
  assert.ok(first.registry.prompt);
  assert.ok(first.registry.output);
  assert.equal(first.registry.note, undefined);
  assert.equal(first.registry.artifact, undefined);
  assert.equal(first.registry.open, undefined);
  assert.deepEqual(first.registry.goal, { tier: "base" });

  const second = migrateTypeRegistryJson(first.registry);
  assert.deepEqual(Object.keys(second.registry).sort(), Object.keys(first.registry).sort());
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.registry.goal, { tier: "base" });
});

test("migrateLegacySchema rewrites node types and strips R/W; idempotent", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);

  // Inject legacy types on disk
  await fs.writeFile(
    path.join(dir, "types.json"),
    JSON.stringify(
      {
        note: { tier: "base", readable: true, writable: true, coordination: false },
        goal: { tier: "base", readable: true, writable: false, coordination: true },
        prompt: { tier: "base", readable: true, writable: true, coordination: true },
        artifact: { tier: "base", readable: true, writable: true, coordination: true },
        open: { tier: "modifier" },
        reference: { tier: "modifier" },
        asset: { tier: "modifier" },
      },
      null,
      2
    )
  );

  const noteBox = path.join(dir, "prompt", "表达式任务书", "草稿", "草稿.md");
  let raw = await fs.readFile(noteBox, "utf8");
  let parsed = parseFrontmatter(raw);
  parsed.data.type = "note";
  parsed.data.writable = true;
  await fs.writeFile(noteBox, serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder));

  const outBox = path.join(dir, "output", "alpha仓库指针", "alpha仓库指针.md");
  raw = await fs.readFile(outBox, "utf8");
  parsed = parseFrontmatter(raw);
  parsed.data.type = "artifact-asset";
  await fs.writeFile(outBox, serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder));

  const report1 = await migrateLegacySchema(fsa, { rewriteOperationalRefs: false });
  assert.ok(report1.typeRewrites.some((e) => e.from === "note" && e.to === "prompt"));
  assert.ok(report1.typeRewrites.some((e) => e.from === "artifact-asset" && e.to === "output-asset"));

  const afterNote = parseFrontmatter(await fsa.readFile("prompt/表达式任务书/草稿/草稿.md")).data;
  assert.equal(afterNote.type, "prompt");
  assert.equal("writable" in afterNote, false);

  const afterOut = parseFrontmatter(await fsa.readFile("output/alpha仓库指针/alpha仓库指针.md")).data;
  assert.equal(afterOut.type, "output-asset");

  const registryText = await fsa.readFile("types.json");
  const registry = JSON.parse(registryText);
  assert.equal(registry.note, undefined);
  assert.equal(registry.artifact, undefined);
  assert.ok(registry.output);
  assert.ok(registry.prompt);

  const tent = await loadTent(fsa);
  assert.equal(tent.byPath.get("prompt/表达式任务书/草稿")!.type, "prompt");
  assert.equal(tent.byPath.get("output/alpha仓库指针")!.type, "output-asset");
  assert.equal(tent.byPath.get("output/alpha仓库指针")!.invalid, false);

  const report2 = await migrateLegacySchema(fsa, { rewriteOperationalRefs: false });
  assert.equal(report2.typeRewrites.length, 0);
  // Second pass must not re-normalize an already-slim types.json.
  assert.equal(
    report2.registryChanges.filter((c) => /normalized|stripped|mapped|seeded/i.test(c)).length,
    0
  );
  const registryText2 = await fsa.readFile("types.json");
  assert.equal(registryText2, registryText);
});
