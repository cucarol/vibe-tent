#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const validator = path.join(repoRoot, "vendor", "okf-conformance", "validator", "okf-validate.mjs");
const strict = process.argv.includes("--strict") || process.env.TENT_OKF_STRICT === "1";
const bundle = resolveBundle();

const args = [validator, bundle, "--json"];
if (strict) args.push("--strict");

const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });
if (result.status === 2) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const rel = path.relative(repoRoot, bundle) || ".";
console.log(
  `OKF conformance: ${rel} (${report.strict ? "strict" : "must"}) ` +
    `${report.summary.errors} error(s), ${report.summary.warnings} warning(s)`
);

if (!report.conformant) {
  for (const item of report.errors) console.error(`x [${item.rule}] ${item.file}: ${item.message}`);
  if (report.strict) {
    for (const item of report.warnings) console.error(`! [${item.rule}] ${item.file}: ${item.message}`);
  }
  process.exit(1);
}

function resolveBundle() {
  if (process.env.TENT_OKF_BUNDLE) return path.resolve(process.env.TENT_OKF_BUNDLE);

const localTentDev = path.join(os.homedir(), "Documents", "Obsidian Vault", "_tents", "tent-dev");
  if (fs.existsSync(localTentDev)) return localTentDev;

  const fixture = path.join(repoRoot, "test", "fixtures", "okf-bundle");
  if (fs.existsSync(fixture)) return fixture;

  const generated = fs.mkdtempSync(path.join(os.tmpdir(), "tent-okf-fixture-"));
  fs.writeFileSync(path.join(generated, "index.md"), "---\ntype: index\n---\n# Index\n\n- [Concept](concept.md)\n");
  fs.writeFileSync(path.join(generated, "concept.md"), "---\ntype: concept\n---\n# Concept\n\nLinked from [Index](index.md).\n");
  return generated;
}
