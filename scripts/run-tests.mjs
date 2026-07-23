#!/usr/bin/env node
// Tent test runner: auto-discovers test/**/*.test.ts and partitions by mode.
// Modes:
//   full         — every discovered *.test.ts once (default npm test gate)
//   fast         — full minus the explicit integration list (daily loop)
//   integration  — only the explicit slow/integration list
// New *.test.ts files are included in full (and fast) by default.
// Live e2e files (*.e2e.ts) are intentionally out of scope.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Explicit slow / packaging / portability suite. Keep this list short. */
export const INTEGRATION_TEST_FILES = Object.freeze([
  "test/package.test.ts",
  "test/open-source.test.ts",
]);

export const MODES = Object.freeze(["full", "fast", "integration"]);

const DEFAULT_CONCURRENCY = 4;

/**
 * @param {string} repoRoot
 * @param {string} [testDirName="test"]
 * @returns {string[]} repo-relative posix paths, sorted
 */
export function discoverTestFiles(repoRoot, testDirName = "test") {
  const testRoot = path.join(repoRoot, testDirName);
  if (!fs.existsSync(testRoot)) {
    throw new Error(`test directory not found: ${path.relative(repoRoot, testRoot) || testDirName}`);
  }
  /** @type {string[]} */
  const found = [];
  walk(testRoot, (abs) => {
    if (!abs.endsWith(".test.ts")) return;
    const rel = toPosix(path.relative(repoRoot, abs));
    found.push(rel);
  });
  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return found;
}

/**
 * @param {string[]} allFiles repo-relative posix paths
 * @param {readonly string[]} integrationFiles
 * @param {"full"|"fast"|"integration"} mode
 * @returns {{ files: string[], integration: string[], fast: string[] }}
 */
export function planTestFiles(allFiles, integrationFiles, mode) {
  const allSet = new Set(allFiles);
  const integration = [];
  for (const rel of integrationFiles) {
    const normalized = toPosix(rel);
    if (!allSet.has(normalized)) {
      throw new Error(
        `integration list entry missing from discovered tests: ${normalized}`
      );
    }
    integration.push(normalized);
  }
  const integrationSet = new Set(integration);
  if (integrationSet.size !== integration.length) {
    throw new Error("integration list contains duplicates");
  }
  const fast = allFiles.filter((f) => !integrationSet.has(f));

  // Invariants: partition of the full set, no silent leaks.
  if (fast.length + integration.length !== allFiles.length) {
    throw new Error(
      `partition size mismatch: fast(${fast.length})+integration(${integration.length}) !== all(${allFiles.length})`
    );
  }

  switch (mode) {
    case "full":
      return { files: [...allFiles], integration, fast };
    case "fast":
      return { files: [...fast], integration, fast };
    case "integration":
      return { files: [...integration], integration, fast };
    default:
      throw new Error(`unknown mode: ${mode}`);
  }
}

/**
 * @param {string[]} argv process.argv slice after node + script
 * @returns {{ mode: "full"|"fast"|"integration", listOnly: boolean, concurrency: number, help: boolean }}
 */
export function parseArgs(argv) {
  /** @type {"full"|"fast"|"integration"} */
  let mode = "full";
  let listOnly = false;
  let concurrency = DEFAULT_CONCURRENCY;
  let help = false;
  let modeSet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--list") {
      listOnly = true;
      continue;
    }
    if (arg === "--mode") {
      const value = argv[++i];
      if (!value || !MODES.includes(value)) {
        throw new Error(`--mode requires one of: ${MODES.join(", ")}`);
      }
      if (modeSet) throw new Error("mode specified more than once");
      mode = /** @type {"full"|"fast"|"integration"} */ (value);
      modeSet = true;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (!MODES.includes(value)) {
        throw new Error(`--mode requires one of: ${MODES.join(", ")}`);
      }
      if (modeSet) throw new Error("mode specified more than once");
      mode = /** @type {"full"|"fast"|"integration"} */ (value);
      modeSet = true;
      continue;
    }
    if (arg === "--concurrency") {
      const value = argv[++i];
      concurrency = parseConcurrency(value);
      continue;
    }
    if (arg.startsWith("--concurrency=")) {
      concurrency = parseConcurrency(arg.slice("--concurrency=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (MODES.includes(arg)) {
      if (modeSet) throw new Error("mode specified more than once");
      mode = /** @type {"full"|"fast"|"integration"} */ (arg);
      modeSet = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { mode, listOnly, concurrency, help };
}

/**
 * @param {string} repoRoot
 * @param {{ mode: "full"|"fast"|"integration", listOnly?: boolean, concurrency?: number }} options
 * @returns {{ files: string[], status: number, stdout?: string, stderr?: string }}
 */
export function runTests(repoRoot, options) {
  const all = discoverTestFiles(repoRoot);
  const plan = planTestFiles(all, INTEGRATION_TEST_FILES, options.mode);
  const files = plan.files;

  if (options.listOnly) {
    for (const f of files) process.stdout.write(`${f}\n`);
    return { files, status: 0 };
  }

  if (files.length === 0) {
    process.stderr.write(`No test files for mode=${options.mode}\n`);
    return { files, status: 1 };
  }

  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const args = [
    "--test",
    `--test-concurrency=${concurrency}`,
    "--import",
    "tsx",
    ...files,
  ];

  // Agent/CI shells sometimes set both FORCE_COLOR and NO_COLOR; Node then prints
  // a warning on every child stderr and breaks tests that assert clean CLI stderr.
  const env = sanitizeTestEnv(process.env);

  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    env,
    windowsHide: true,
  });

  if (result.error) {
    process.stderr.write(String(result.error) + "\n");
    return { files, status: 1 };
  }
  return { files, status: result.status ?? 1 };
}

function parseConcurrency(value) {
  if (value == null || value === "") {
    throw new Error("--concurrency requires a positive integer");
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`invalid --concurrency: ${value}`);
  }
  return n;
}

/**
 * @param {NodeJS.ProcessEnv} source
 * @returns {NodeJS.ProcessEnv}
 */
export function sanitizeTestEnv(source) {
  const env = { ...source };
  if (env.FORCE_COLOR != null && env.NO_COLOR != null) {
    delete env.FORCE_COLOR;
  }
  return env;
}

/**
 * @param {string} dir
 * @param {(abs: string) => void} onFile
 */
function walk(dir, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read ${dir}: ${err}`);
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip nested package trees if any appear under test/
      if (entry.name === "node_modules" || entry.name === "fixtures") continue;
      walk(abs, onFile);
    } else if (entry.isFile()) {
      onFile(abs);
    }
  }
}

/** @param {string} p */
function toPosix(p) {
  return p.split(path.sep).join("/");
}

function printUsage() {
  process.stdout.write(`Usage: node scripts/run-tests.mjs [full|fast|integration] [options]

Modes:
  full          All test/**/*.test.ts (default; complete regression gate)
  fast          full minus explicit integration list
  integration   Only the explicit slow/integration list

Options:
  --mode <m>           Same as positional mode
  --list               Print selected files and exit 0
  --concurrency <n>    node --test concurrency (default ${DEFAULT_CONCURRENCY})
  -h, --help           Show this help

Integration list (explicit):
${INTEGRATION_TEST_FILES.map((f) => `  - ${f}`).join("\n")}
`);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    printUsage();
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    printUsage();
    process.exitCode = 0;
    return;
  }

  try {
    const { status } = runTests(repoRoot, options);
    process.exitCode = status;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  }
}

if (isMain()) {
  main();
}
