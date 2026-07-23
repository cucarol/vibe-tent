import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  INTEGRATION_TEST_FILES,
  discoverTestFiles,
  parseArgs,
  planTestFiles,
  sanitizeTestEnv,
} from "../scripts/run-tests.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const runnerPath = path.join(repoRoot, "scripts", "run-tests.mjs");

test("discoverTestFiles finds all *.test.ts under test/ (posix, sorted)", () => {
  const files = discoverTestFiles(repoRoot);
  assert.ok(files.length >= 60, `expected many tests, got ${files.length}`);
  assert.ok(files.every((f) => f.startsWith("test/") && f.endsWith(".test.ts")));
  assert.ok(files.every((f) => !f.includes("\\")), "paths must be posix");
  const sorted = [...files].sort();
  assert.deepEqual(files, sorted);
  // e2e files are not *.test.ts and must stay out
  assert.ok(!files.some((f) => f.endsWith(".e2e.ts")));
  // fixtures must not contribute even if present
  assert.ok(!files.some((f) => f.includes("/fixtures/")));
  // previously omitted from the hand-written list
  for (const required of [
    "test/acp-image-prompt.test.ts",
    "test/desktop-box-projection-ui.test.ts",
    "test/desktop-pending-interactions.test.ts",
    "test/node-mode.test.ts",
    "test/service-interaction-pending.test.ts",
    "test/task-input-store.test.ts",
    "test/test-runner.test.ts",
  ]) {
    assert.ok(files.includes(required), `missing discovered file: ${required}`);
  }
});

test("planTestFiles: integration is explicit; fast+integration partition full without overlap", () => {
  const all = discoverTestFiles(repoRoot);
  const full = planTestFiles(all, INTEGRATION_TEST_FILES, "full");
  const fast = planTestFiles(all, INTEGRATION_TEST_FILES, "fast");
  const integration = planTestFiles(all, INTEGRATION_TEST_FILES, "integration");

  assert.deepEqual(full.files, all);
  assert.deepEqual(integration.files, [...INTEGRATION_TEST_FILES]);
  assert.equal(fast.files.length + integration.files.length, all.length);
  assert.equal(full.files.length, all.length);

  const fastSet = new Set(fast.files);
  const intSet = new Set(integration.files);
  for (const f of integration.files) {
    assert.ok(!fastSet.has(f), `integration file leaked into fast: ${f}`);
  }
  for (const f of fast.files) {
    assert.ok(!intSet.has(f), `fast file leaked into integration: ${f}`);
  }
  // full is exactly the union, each file once
  const union = new Set([...fast.files, ...integration.files]);
  assert.equal(union.size, all.length);
  assert.deepEqual([...union].sort(), [...all].sort());
});

test("planTestFiles: new *.test.ts defaults into full and fast, not integration", () => {
  const syntheticAll = [
    "test/a.test.ts",
    "test/b.test.ts",
    "test/package.test.ts",
    "test/open-source.test.ts",
    "test/brand-new-feature.test.ts",
  ];
  const plan = planTestFiles(syntheticAll, INTEGRATION_TEST_FILES, "full");
  assert.ok(plan.files.includes("test/brand-new-feature.test.ts"));
  assert.ok(plan.fast.includes("test/brand-new-feature.test.ts"));
  assert.ok(!plan.integration.includes("test/brand-new-feature.test.ts"));

  const fastPlan = planTestFiles(syntheticAll, INTEGRATION_TEST_FILES, "fast");
  assert.ok(fastPlan.files.includes("test/brand-new-feature.test.ts"));
});

test("planTestFiles fails when integration list entry is missing from discovery", () => {
  assert.throws(
    () => planTestFiles(["test/a.test.ts"], ["test/missing.test.ts"], "full"),
    /integration list entry missing/
  );
});

test("parseArgs: modes, defaults, unknown flags fail", () => {
  assert.deepEqual(parseArgs([]), {
    mode: "full",
    listOnly: false,
    concurrency: 4,
    help: false,
  });
  assert.equal(parseArgs(["fast"]).mode, "fast");
  assert.equal(parseArgs(["--mode", "integration"]).mode, "integration");
  assert.equal(parseArgs(["--mode=fast"]).mode, "fast");
  assert.equal(parseArgs(["--list"]).listOnly, true);
  assert.equal(parseArgs(["--concurrency", "2"]).concurrency, 2);
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/);
  assert.throws(() => parseArgs(["bogus"]), /unknown argument/);
  assert.throws(() => parseArgs(["--mode", "turbo"]), /--mode requires/);
  assert.throws(() => parseArgs(["fast", "full"]), /mode specified more than once/);
});

test("CLI --list full covers discovery; fast and integration are disjoint and union to full", () => {
  const runList = (mode: string) => {
    const result = spawnSync(process.execPath, [runnerPath, mode, "--list"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  };

  const full = runList("full");
  const fast = runList("fast");
  const integration = runList("integration");
  const discovered = discoverTestFiles(repoRoot);

  assert.deepEqual(full, discovered);
  assert.deepEqual(integration, [...INTEGRATION_TEST_FILES]);
  assert.equal(fast.length + integration.length, full.length);

  const seen = new Set<string>();
  for (const f of [...fast, ...integration]) {
    assert.ok(!seen.has(f), `duplicate across fast/integration: ${f}`);
    seen.add(f);
  }
  assert.equal(seen.size, full.length);
});

test("CLI rejects unknown arguments with non-zero exit", () => {
  const result = spawnSync(process.execPath, [runnerPath, "--not-a-real-flag"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown option/);
});

test("CLI discovery includes a newly created *.test.ts by default (full+fast)", () => {
  const tmpName = `test/_tmp-runner-discovery-${process.pid}.test.ts`;
  const abs = path.join(repoRoot, tmpName);
  try {
    fs.writeFileSync(
      abs,
      `import { test } from "node:test";\ntest("tmp", () => {});\n`,
      "utf8"
    );
    const result = spawnSync(process.execPath, [runnerPath, "full", "--list"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const listed = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    assert.ok(listed.includes(tmpName.replace(/\\/g, "/")), "new file must appear in full");

    const fastResult = spawnSync(process.execPath, [runnerPath, "fast", "--list"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(fastResult.status, 0, fastResult.stderr);
    const fastListed = fastResult.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    assert.ok(fastListed.includes(tmpName.replace(/\\/g, "/")), "new file defaults into fast");

    const intResult = spawnSync(
      process.execPath,
      [runnerPath, "integration", "--list"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      }
    );
    assert.equal(intResult.status, 0, intResult.stderr);
    const intListed = intResult.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    assert.ok(
      !intListed.includes(tmpName.replace(/\\/g, "/")),
      "new file must not silently enter integration"
    );
  } finally {
    try {
      fs.unlinkSync(abs);
    } catch {
      /* ignore */
    }
  }
});

test("sanitizeTestEnv drops FORCE_COLOR when NO_COLOR is also set", () => {
  const cleaned = sanitizeTestEnv({
    PATH: "/bin",
    FORCE_COLOR: "1",
    NO_COLOR: "1",
    KEEP: "yes",
  });
  assert.equal(cleaned.FORCE_COLOR, undefined);
  assert.equal(cleaned.NO_COLOR, "1");
  assert.equal(cleaned.KEEP, "yes");
  assert.equal(sanitizeTestEnv({ FORCE_COLOR: "1" }).FORCE_COLOR, "1");
});

test("run-tests.mjs is importable as ESM module (exports stable)", async () => {
  const mod = await import(pathToFileURL(runnerPath).href);
  assert.equal(typeof mod.discoverTestFiles, "function");
  assert.equal(typeof mod.planTestFiles, "function");
  assert.equal(typeof mod.parseArgs, "function");
  assert.equal(typeof mod.sanitizeTestEnv, "function");
  assert.ok(Array.isArray(mod.INTEGRATION_TEST_FILES));
  // touch os so unused import stays meaningful if we expand isolation later
  assert.ok(os.tmpdir());
});
