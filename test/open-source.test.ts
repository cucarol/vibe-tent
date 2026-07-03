import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

test("开源可移植性:发布源文件不含开发者机器绝对路径", async () => {
  const roots = [
    "README.md",
    "package.json",
    "scripts",
    "skills",
    "src",
    "docs/SPEC.md",
  ];
  const files = (
    await Promise.all(roots.map((entry) => collectFiles(path.join(repoRoot, entry))))
  ).flat();
  const forbidden = [/C:\/cucarol/i, /C:\\Users\\/i, /\/Users\/[^/]+\//i];
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        raw,
        pattern,
        `${path.relative(repoRoot, file)} 包含本机绑定路径`
      );
    }
  }

  const pkg = JSON.parse(
    await fs.readFile(path.join(repoRoot, "package.json"), "utf8")
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(repoRoot, "manifest.json"), "utf8")
  );
  const versions = JSON.parse(
    await fs.readFile(path.join(repoRoot, "versions.json"), "utf8")
  );
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
  const spec = await fs.readFile(path.join(repoRoot, "docs", "SPEC.md"), "utf8");
  const roleSkill = await fs.readFile(path.join(repoRoot, "skills", "tent-role", "SKILL.md"), "utf8");
  const pluginMain = await fs.readFile(path.join(repoRoot, "src", "plugin", "main.ts"), "utf8");
  const pluginSettings = await fs.readFile(path.join(repoRoot, "src", "plugin", "settings.ts"), "utf8");
  assert.equal(pkg.bin.tent, "./cli.mjs");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.author, manifest.author);
  assert.equal(pkg.repository.url, "git+https://github.com/cucarol/tent.git");
  assert.equal(pkg.bugs.url, "https://github.com/cucarol/tent/issues");
  assert.equal(pkg.homepage, "https://github.com/cucarol/tent#readme");
  assert.equal(pkg.version, manifest.version, "npm 与 Obsidian 插件版本保持一致");
  assert.match(pkg.description, /^[\x20-\x7E]+\.$/, "npm description 使用完整英文句子");
  for (const keyword of ["obsidian", "cli", "okf", "coding-agents"]) {
    assert.ok(pkg.keywords.includes(keyword), `npm keywords 包含 ${keyword}`);
  }
  assert.equal(manifest.name, "Tent");
  assert.equal(manifest.authorUrl, "https://github.com/cucarol");
  assert.equal(
    manifest.description,
    "Manage intent, context, and delegated tasks with coding agents: a draggable box tree, frontmatter controls, and dispatch/approval workflows."
  );
  assert.ok(manifest.description.length <= 250);
  assert.match(manifest.description, /\.$/);
  assert.match(pluginMain, /addRibbonIcon\("tent", "Open Tent panel"/);
  assert.match(pluginMain, /id: "open-panel"/);
  assert.match(pluginMain, /id: "open-board-experimental"/);
  assert.doesNotMatch(
    pluginMain,
    /id: "open-tent-/,
    "Obsidian command ids should not repeat the plugin id"
  );
  assert.match(pluginMain, /name: "Open panel"/);
  assert.match(pluginMain, /name: "Open or refresh experimental board"/);
  assert.doesNotMatch(
    pluginMain,
    /name: "[^"]*Tent[^"]*"/,
    "Obsidian command names should not repeat the plugin name"
  );
  assert.doesNotMatch(pluginMain, /name: "打开/);
  assert.doesNotMatch(
    pluginSettings,
    /createEl\("h[1-4]"/,
    "plugin settings should use Obsidian Setting headings instead of raw h1-h4 elements"
  );
  assert.match(pluginSettings, /\.setHeading\(\)/);
  assert.equal(
    versions[manifest.version],
    manifest.minAppVersion,
    "versions.json 记录当前插件所需的最低 Obsidian 版本"
  );
  assert.ok(pkg.files.includes("versions.json"), "npm 发布包包含 Obsidian 版本映射");
  assert.equal(await exists(path.join(repoRoot, "LICENSE")), true);
  assert.match(readme, /tent skill-install \[--target claude\] \[--force\]/);
  assert.match(readme, /idempotent `tent migrate-\*` commands/);
  assert.match(spec, /Overlay Format Migrations/);
  assert.match(spec, /Any breaking overlay format change must ship with an idempotent/);
  assert.match(spec, /`tent migrate-\*` command/);
  assert.match(spec, /`cli\.command` is required when `cli` exists/);
  assert.match(spec, /The task envelope is the machine delivery state/);
  assert.match(spec, /`--require-check` is a user-supplied mechanical gate/);
  assert.doesNotMatch(spec, /handoff/i);
  assert.match(roleSkill, /内容住 box，状态住 envelope/);
  assert.match(roleSkill, /编排者手册/);
  assert.match(roleSkill, /dispatch -> spawn\/唤醒 -> receive report -> review -> complete/);
  assert.doesNotMatch(roleSkill, /tent handoff/i);
});

test("OKF validator:angle-bracket markdown links may target filenames with spaces", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-okf-space-"));
  await fs.writeFile(
    path.join(dir, "index.md"),
    "---\ntype: index\n---\n# Index\n\n- [Space Concept](<space concept.md>)\n",
  );
  await fs.writeFile(
    path.join(dir, "space concept.md"),
    "---\ntype: concept\n---\n# Space Concept\n\nLinked from [Index](index.md).\n",
  );

  const validator = path.join(repoRoot, "vendor", "okf-conformance", "validator", "okf-validate.mjs");
  const result = spawnSync(process.execPath, [validator, dir, "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.summary.warnings, 0);
});

test("vendored OKF deviations and upstream proposal are documented", async () => {
  const localPatches = await fs.readFile(
    path.join(repoRoot, "vendor", "okf-conformance", "LOCAL-PATCHES.md"),
    "utf8",
  );
  assert.match(localPatches, /0116946/);
  assert.match(localPatches, /okf-validate\.mjs/);
  assert.match(localPatches, /okf-graph\.mjs/);
  assert.match(localPatches, /GoogleCloudPlatform\/knowledge-catalog/);
  assert.match(localPatches, /source provenance/i);

  const upstreamDraft = await fs.readFile(
    path.join(repoRoot, "docs", "upstream", "okf-commonmark-link-destination.md"),
    "utf8",
  );
  assert.match(upstreamDraft, /CommonMark angle-bracket link destinations/);
  assert.match(upstreamDraft, /space concept\.md/);
  assert.match(upstreamDraft, /reference_agent\/viewer\/generator\.py/);
  assert.match(upstreamDraft, /pull\/125/);
});

test("Tent OKF wrapper excludes the root temp pipeline from strict validation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-okf-wrapper-"));
  await fs.mkdir(path.join(dir, "temp", "role", "tasks"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "index.md"),
    "---\ntype: index\n---\n# Index\n\n- [Concept](concept.md)\n",
  );
  await fs.writeFile(
    path.join(dir, "concept.md"),
    "---\ntype: concept\n---\n# Concept\n\nLinked from [Index](index.md).\n",
  );
  await fs.writeFile(
    path.join(dir, "temp", "role", "tasks", "task.md"),
    "---\ntype: task\n---\n# Runtime task\n",
  );

  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "okf-check.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TENT_OKF_BUNDLE: dir,
      TENT_OKF_STRICT: "1",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\(strict\) 0 error\(s\), 0 warning\(s\)/);
});

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(target: string): Promise<string[]> {
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];
  const entries = await fs.readdir(target, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => collectFiles(path.join(target, entry.name)))
  );
  return nested.flat();
}
