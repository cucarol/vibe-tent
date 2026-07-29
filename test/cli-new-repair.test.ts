/**
 * CLI filesystem tests for `tent new <target> --repair-existing` (cx-b9bf58).
 * Generic synthetic fixtures only — exercises public wiring of Core reAdoptOrphanTent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tentIndexMarker } from "../src/core/scaffold.js";
import { INDEX_PATH, TENT_SYSTEM_DIR, TEMP_DIR, ATTACHMENTS_DIR } from "../src/core/paths.js";
import { TYPE_REGISTRY_PATH } from "../src/core/typeRegistry.js";
import { ROLES_REGISTRY_PATH } from "../src/core/skillRoleRegistry.js";
import { TAGS_REGISTRY_PATH } from "../src/core/tags.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliSource = path.join(repoRoot, "src", "cli", "tent.ts");
const tsxImport = import.meta.resolve("tsx");

const ORPHAN_NODE_BYTES =
  "---\nid: cx-orphan1\ntype: prompt\n---\n# Orphan topic\npreserved body bytes\n";
const CUSTOM_TYPES_BYTES =
  JSON.stringify({ goal: { tier: "base" }, prompt: { tier: "base" } }, null, 2) + "\n";
const TEMP_HISTORY_BYTES = "temp history must survive\n";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, ...args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsxImport, cliSource, ...args], {
      cwd,
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function mkWorkspace(prefix = "tent-cli-repair-"): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

/** Orphan `.tent/`: present, no index, durable evidence. */
async function writeOrphan(
  workspace: string,
  options: {
    withNode?: boolean;
    withTypes?: boolean;
    withTemp?: boolean;
    indexContent?: string | null;
  } = {}
): Promise<void> {
  const {
    withNode = true,
    withTypes = true,
    withTemp = true,
    indexContent = null,
  } = options;
  const system = path.join(workspace, TENT_SYSTEM_DIR);
  await fs.mkdir(system, { recursive: true });
  if (withNode) {
    const nodeDir = path.join(system, "topic");
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(path.join(nodeDir, "topic.md"), ORPHAN_NODE_BYTES, "utf8");
  }
  if (withTypes) {
    await fs.writeFile(path.join(system, TYPE_REGISTRY_PATH), CUSTOM_TYPES_BYTES, "utf8");
  }
  if (withTemp) {
    await fs.mkdir(path.join(system, TEMP_DIR), { recursive: true });
    await fs.writeFile(path.join(system, TEMP_DIR, "history.txt"), TEMP_HISTORY_BYTES, "utf8");
  }
  if (indexContent !== null) {
    await fs.writeFile(path.join(system, INDEX_PATH), indexContent, "utf8");
  }
}

async function snapshotBytes(workspace: string, rels: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of rels) {
    out[rel] = await fs.readFile(path.join(workspace, rel), "utf8");
  }
  return out;
}

test("tent new --repair-existing: success preserves bytes and reports created pieces", async () => {
  const workspace = await mkWorkspace();
  await writeOrphan(workspace, { withNode: true, withTypes: true, withTemp: true });
  await fs.writeFile(path.join(workspace, "README.md"), "# keep project\n", "utf8");
  await fs.writeFile(path.join(workspace, ".gitignore"), "node_modules/\n", "utf8");

  const preservedRels = [
    path.join(".tent", "topic", "topic.md"),
    path.join(".tent", TYPE_REGISTRY_PATH),
    path.join(".tent", TEMP_DIR, "history.txt"),
    "README.md",
  ];
  const before = await snapshotBytes(workspace, preservedRels);

  const result = await runCli(workspace, "new", ".", "--repair-existing");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Re-adopted orphan Tent/i);
  assert.match(result.stdout, /index\.md/);
  assert.match(result.stdout, /Created structural pieces/i);

  for (const [rel, body] of Object.entries(before)) {
    assert.equal(await fs.readFile(path.join(workspace, rel), "utf8"), body, rel);
  }

  const indexRaw = await fs.readFile(path.join(workspace, ".tent", INDEX_PATH), "utf8");
  assert.equal(indexRaw, tentIndexMarker());
  assert.equal(await exists(path.join(workspace, ".tent", ATTACHMENTS_DIR)), true);
  assert.equal(await exists(path.join(workspace, ".tent", ROLES_REGISTRY_PATH)), true);
  assert.equal(await exists(path.join(workspace, ".tent", TAGS_REGISTRY_PATH)), true);
  assert.match(await fs.readFile(path.join(workspace, ".gitignore"), "utf8"), /\.tent\//);
});

test("tent new --repair-existing: flag order after target (canonical form)", async () => {
  const workspace = await mkWorkspace();
  await writeOrphan(workspace, { withNode: false, withTypes: true, withTemp: false });
  const result = await runCli(workspace, "new", workspace, "--repair-existing");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Re-adopted orphan Tent/i);
  assert.equal(await exists(path.join(workspace, ".tent", INDEX_PATH)), true);
});

test("tent new without --repair-existing still refuses existing .tent", async () => {
  const workspace = await mkWorkspace();
  await writeOrphan(workspace, { withNode: true, withTypes: true });
  const result = await runCli(workspace, "new", ".");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /already a Tent/i);
  assert.equal(await exists(path.join(workspace, ".tent", INDEX_PATH)), false);
});

test("tent new --repair-existing: fail-closed empty/unrecognized .tent (zero writes)", async () => {
  const workspace = await mkWorkspace();
  const system = path.join(workspace, TENT_SYSTEM_DIR);
  await fs.mkdir(system, { recursive: true });
  await fs.writeFile(path.join(system, "noise.txt"), "not tent evidence\n", "utf8");
  const beforeNoise = await fs.readFile(path.join(system, "noise.txt"), "utf8");

  const result = await runCli(workspace, "new", ".", "--repair-existing");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no recognized Tent evidence/i);
  assert.equal(await exists(path.join(system, INDEX_PATH)), false);
  assert.equal(await fs.readFile(path.join(system, "noise.txt"), "utf8"), beforeNoise);
  assert.equal(await exists(path.join(system, TYPE_REGISTRY_PATH)), false);
});

test("tent new --repair-existing: fail-closed already valid Tent (zero writes)", async () => {
  const workspace = await mkWorkspace();
  // Normal genesis path.
  const created = await runCli(workspace, "new", ".");
  assert.equal(created.code, 0, created.stderr);
  const indexBefore = await fs.readFile(path.join(workspace, ".tent", INDEX_PATH), "utf8");
  const typesBefore = await fs.readFile(path.join(workspace, ".tent", TYPE_REGISTRY_PATH), "utf8");

  const result = await runCli(workspace, "new", ".", "--repair-existing");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /already marks a valid Tent/i);
  assert.equal(await fs.readFile(path.join(workspace, ".tent", INDEX_PATH), "utf8"), indexBefore);
  assert.equal(await fs.readFile(path.join(workspace, ".tent", TYPE_REGISTRY_PATH), "utf8"), typesBefore);
});

test("tent new --repair-existing: fail-closed invalid index (zero writes)", async () => {
  const workspace = await mkWorkspace();
  const badIndex = "---\ntype: not-index\n---\n# ambiguous\n";
  await writeOrphan(workspace, {
    withNode: true,
    withTypes: true,
    indexContent: badIndex,
  });
  const nodeBefore = await fs.readFile(path.join(workspace, ".tent", "topic", "topic.md"), "utf8");

  const result = await runCli(workspace, "new", ".", "--repair-existing");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not a valid Tent index marker|refusing to overwrite/i);
  assert.equal(await fs.readFile(path.join(workspace, ".tent", INDEX_PATH), "utf8"), badIndex);
  assert.equal(await fs.readFile(path.join(workspace, ".tent", "topic", "topic.md"), "utf8"), nodeBefore);
});

test("tent new --repair-existing: fail-closed missing target/.tent", async () => {
  const workspace = await mkWorkspace();
  await fs.writeFile(path.join(workspace, "README.md"), "# bare\n", "utf8");

  const result = await runCli(workspace, "new", ".", "--repair-existing");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no .* system directory|no \.tent/i);
  assert.equal(await exists(path.join(workspace, ".tent")), false);
  assert.equal(await fs.readFile(path.join(workspace, "README.md"), "utf8"), "# bare\n");
});

test("tent new --repair-existing never scaffolds a second workspace", async () => {
  const primary = await mkWorkspace("tent-cli-repair-p-");
  const other = await mkWorkspace("tent-cli-repair-o-");
  await writeOrphan(primary, { withTypes: true, withNode: false });
  await fs.mkdir(path.join(other, "keep"), { recursive: true });

  const result = await runCli(primary, "new", primary, "--repair-existing");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await exists(path.join(other, ".tent")), false);
  assert.equal(await exists(path.join(primary, ".tent", INDEX_PATH)), true);
});

test("CLI help documents canonical tent new <path> --repair-existing", async () => {
  const help = await runCli(repoRoot, "--help");
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /--repair-existing/);
  assert.match(help.stdout, /new <workspace-path> --repair-existing/);
});

test("old public tent agent session-* routing is rejected after Session rename", async () => {
  for (const sub of ["session-start", "session-status", "session-end", "enter", "status", "leave"] as const) {
    const result = await runCli(repoRoot, "agent", sub, "--host", "claude");
    assert.notEqual(result.code, 0, `tent agent ${sub} must be rejected`);
    // tent agent is logical AgentDefinition only; Session lifecycle is tent session.
    assert.match(result.stderr, /Unknown agent-definition subcommand/);
  }
});

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
