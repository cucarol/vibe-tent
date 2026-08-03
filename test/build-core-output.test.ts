/**
 * Regression: `npm run build:core` must emit only under dist-core/ with the
 * flat module layout (rootDir=src/core). It must not emit JS/d.ts siblings into
 * src/fs or src/markdown, and must not nest dist-core/fs or dist-core/markdown.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distCore = path.join(repoRoot, "dist-core");

function runBuildCore(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, "scripts", "build-core.mjs")],
      {
        cwd: repoRoot,
        env: process.env,
        windowsHide: true,
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function listRelativeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, rel: string) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs, childRel);
      else out.push(childRel.replace(/\\/g, "/"));
    }
  }
  await walk(dir, "");
  return out.sort();
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test("build:core succeeds with flat dist-core layout and no src sibling emissions", async () => {
  // Capture any pre-existing accidental siblings so we can distinguish build pollution.
  const fsBefore = await listRelativeFiles(path.join(repoRoot, "src", "fs"));
  const mdBefore = await listRelativeFiles(path.join(repoRoot, "src", "markdown"));
  const fsJsDtsBefore = new Set(
    fsBefore.filter((f) => f.endsWith(".js") || f.endsWith(".d.ts") || f.endsWith(".js.map") || f.endsWith(".d.ts.map"))
  );
  const mdJsDtsBefore = new Set(
    mdBefore.filter((f) => f.endsWith(".js") || f.endsWith(".d.ts") || f.endsWith(".js.map") || f.endsWith(".d.ts.map"))
  );

  const result = await runBuildCore();
  assert.equal(
    result.code,
    0,
    `build:core failed:\n${result.stdout}\n${result.stderr}`
  );
  assert.doesNotMatch(result.stdout + result.stderr, /TS6059/);

  assert.equal(await exists(distCore), true, "dist-core must exist after build:core");
  assert.equal(await exists(path.join(distCore, "index.js")), true);
  assert.equal(await exists(path.join(distCore, "index.d.ts")), true);
  assert.equal(await exists(path.join(distCore, "migration.js")), false);
  assert.equal(await exists(path.join(distCore, "status.js")), true);
  assert.equal(await exists(path.join(distCore, "renameOps.js")), true);
  assert.equal(await exists(path.join(distCore, "link-target.js")), true);

  // Supported layout is flat under dist-core/ (mirrors src/core), not nested package trees.
  assert.equal(await exists(path.join(distCore, "fs")), false, "must not emit dist-core/fs");
  assert.equal(await exists(path.join(distCore, "markdown")), false, "must not emit dist-core/markdown");
  assert.equal(await exists(path.join(distCore, "core")), false, "must not nest under dist-core/core");

  const emitted = await listRelativeFiles(distCore);
  assert.ok(emitted.length > 0, "dist-core should contain emitted modules");
  for (const rel of emitted) {
    assert.doesNotMatch(rel, /^(fs|markdown|core)\//, `unexpected nested emit: ${rel}`);
    // Flat modules only (no path segments other than optional maps under same basename).
    assert.ok(!rel.includes("/") || rel.endsWith(".map") === false || !rel.split("/")[0]!.includes("."), `flat layout only: ${rel}`);
  }
  // Stronger: every emit path is a single path segment (file at dist-core root).
  for (const rel of emitted) {
    assert.equal(rel.includes("/"), false, `dist-core must stay flat, got nested: ${rel}`);
  }

  // Core modules must not reach outside rootDir via relative imports in emit.
  for (const name of ["status.js", "renameOps.js"]) {
    const text = await fs.readFile(path.join(distCore, name), "utf8");
    assert.doesNotMatch(text, /from ["']\.\.\/fs\//, `${name} must not import ../fs/`);
    assert.doesNotMatch(text, /from ["']\.\.\/markdown\//, `${name} must not import ../markdown/`);
  }

  // No new JS/d.ts siblings under src/fs or src/markdown from this build.
  const fsAfter = await listRelativeFiles(path.join(repoRoot, "src", "fs"));
  const mdAfter = await listRelativeFiles(path.join(repoRoot, "src", "markdown"));
  for (const f of fsAfter) {
    if (f.endsWith(".js") || f.endsWith(".d.ts") || f.endsWith(".js.map") || f.endsWith(".d.ts.map")) {
      assert.ok(
        fsJsDtsBefore.has(f),
        `build:core must not emit new sibling under src/fs: ${f}`
      );
    }
  }
  for (const f of mdAfter) {
    if (f.endsWith(".js") || f.endsWith(".d.ts") || f.endsWith(".js.map") || f.endsWith(".d.ts.map")) {
      assert.ok(
        mdJsDtsBefore.has(f),
        `build:core must not emit new sibling under src/markdown: ${f}`
      );
    }
  }
});
