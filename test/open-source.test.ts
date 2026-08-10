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
  const tracked = gitTrackedFiles();
  for (const retiredRoot of [".tent/", "output/"]) {
    assert.equal(
      tracked.some((entry) => entry === retiredRoot.slice(0, -1) || entry.startsWith(retiredRoot)),
      false,
      `${retiredRoot} is machine-local output and must not be Git-tracked`,
    );
  }

  const localRoots = [repoRoot, os.homedir()].flatMap((entry) => [entry, entry.replaceAll("\\", "/")]);
  const forbidden = [
    ...localRoots.map((entry) => new RegExp(escapeRegExp(entry), "i")),
    new RegExp(`C:[\\\\/]+${"cuca" + "rol"}[\\\\/]+_code[\\\\/]+Tent`, "i"),
  ];
  for (const entry of tracked) {
    const file = path.join(repoRoot, entry);
    if (!(await exists(file))) continue;
    const buffer = await fs.readFile(file);
    if (buffer.includes(0)) continue;
    const raw = buffer.toString("utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        raw,
        pattern,
        `${entry} 包含本机绑定路径`
      );
    }
  }

  const pkg = JSON.parse(
    await fs.readFile(path.join(repoRoot, "package.json"), "utf8")
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(repoRoot, "manifest.json"), "utf8")
  );
  const releaseWorkflow = await fs.readFile(
    path.join(repoRoot, ".github", "workflows", "release.yml"),
    "utf8"
  );
  const desktopBuilder = await fs.readFile(
    path.join(repoRoot, "electron-builder.yml"),
    "utf8",
  );
  const spec = await fs.readFile(path.join(repoRoot, "docs", "SPEC.md"), "utf8");
  const roleSkill = await fs.readFile(path.join(repoRoot, "skills", "tent-role", "SKILL.md"), "utf8");
  const taskSkill = await fs.readFile(path.join(repoRoot, "skills", "tent-task", "SKILL.md"), "utf8");
  const taskPaths = await fs.readFile(
    path.join(repoRoot, "skills", "tent-task", "references", "paths.md"),
    "utf8"
  );
  const taskCli = await fs.readFile(
    path.join(repoRoot, "skills", "tent-task", "references", "task-cli.md"),
    "utf8"
  );
  const taskSession = await fs.readFile(
    path.join(repoRoot, "skills", "tent-task", "references", "session-boundaries.md"),
    "utf8"
  );
  const publicDesktopContracts = await Promise.all(
    [
      "architecture.md",
      "agent-runtime.md",
      "cli-service.md",
      "node-model.md",
      "task-api.md",
      "grok-acp-provider.md",
    ].map((name) => fs.readFile(path.join(repoRoot, "docs", "desktop", name), "utf8"))
  );
  assert.equal(pkg.bin.tent, "./cli.mjs");
  assert.equal(pkg.bin["tent-service"], "./service.mjs");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.author, "cucarol");
  assert.equal(pkg.author, manifest.author);
  assert.equal(manifest.name, "Vibe Tent");
  assert.equal(manifest.minAppVersion, undefined, "release manifest has no Obsidian compatibility axis");
  assert.equal(manifest.isDesktopOnly, undefined, "release manifest has no Obsidian plugin flag");
  assert.equal(pkg.repository.url, "git+https://github.com/cucarol/vibe-tent.git");
  assert.equal(pkg.bugs.url, "https://github.com/cucarol/vibe-tent/issues");
  assert.equal(pkg.homepage, "https://github.com/cucarol/vibe-tent#readme");
  assert.equal(pkg.version, manifest.version, "npm package version matches release manifest");
  assert.match(pkg.description, /^[\x20-\x7E]+\.$/, "npm description 使用完整英文句子");
  for (const keyword of ["cli", "okf", "coding-agents", "desktop"]) {
    assert.ok(pkg.keywords.includes(keyword), `npm keywords 包含 ${keyword}`);
  }
  assert.equal(pkg.keywords.includes("obsidian"), false, "Obsidian plugin keywords are retired");
  assert.equal(pkg.keywords.includes("obsidian-plugin"), false, "Obsidian plugin keywords are retired");
  assert.equal(pkg.devDependencies?.obsidian, undefined, "obsidian devDependency is retired");
  assert.equal(pkg.scripts?.["build:plugin"], undefined, "build:plugin script is retired");
  assert.equal(pkg.files.includes("main.js"), false, "npm package no longer ships plugin main.js");
  assert.equal(await exists(path.join(repoRoot, "main.js")), false, "retired root plugin bundle is deleted");
  assert.equal(pkg.files.includes("styles.css"), false, "npm package no longer ships plugin styles.css");
  assert.equal(pkg.files.includes("versions.json"), false, "npm package no longer ships Obsidian versions.json");
  assert.match(releaseWorkflow, /npm pack --ignore-scripts/);
  assert.match(releaseWorkflow, /npm run desktop:package/);
  assert.match(releaseWorkflow, /release\/\*-portable\.exe/);
  assert.doesNotMatch(releaseWorkflow, /styles\.css|versions\.json/);
  assert.match(desktopBuilder, /^\s*-\s+LICENSE\s*$/m, "Desktop package includes the project MIT LICENSE");
  assert.equal(await exists(path.join(repoRoot, "src", "plugin")), false, "src/plugin production source is retired");
  assert.equal(
    await exists(path.join(repoRoot, "src", "desktop", "renderer", "main-ui.ts")),
    false,
    "retired Desktop main renderer source is deleted"
  );
  assert.equal(
    await exists(path.join(repoRoot, "src", "desktop", "renderer", "index.html")),
    false,
    "retired Desktop main renderer HTML is deleted"
  );
  assert.equal(
    await exists(path.join(repoRoot, "src", "desktop", "renderer", "float-ui.ts")),
    true,
    "floating renderer remains supported"
  );
  assert.equal(await exists(path.join(repoRoot, "versions.json")), false, "versions.json is retired");
  assert.equal(await exists(path.join(repoRoot, "test", "plugin.test.ts")), false, "plugin-only tests are retired");
  assert.ok(pkg.files.includes("skills/"), "npm 发布包包含 bundled skills/");
  assert.ok(pkg.files.includes("cli.mjs"), "npm 发布包包含 CLI bundle");
  assert.ok(pkg.files.includes("service.mjs"), "npm 发布包包含 Service bundle");
  assert.equal(await exists(path.join(repoRoot, "LICENSE")), true);
  assert.equal(await exists(path.join(repoRoot, "skills", "tent-role", "SKILL.md")), true);
  assert.equal(await exists(path.join(repoRoot, "skills", "tent-task", "SKILL.md")), true);
  assert.equal(await exists(path.join(repoRoot, "skills", "tent-agent", "SKILL.md")), false);
  assert.equal(await exists(path.join(repoRoot, "skills", "tent-genesis", "SKILL.md")), false);
  assert.match(spec, /Role and Session are different/);
  assert.match(spec, /A Task is one work package and one review unit/);
  assert.match(spec, /A Delivery is an executor's formal result for one Task/);
  assert.match(spec, /Task, Session, and any Output Node/);
  assert.match(spec, /another Task cannot acquire the same work\s+Node/);
  assert.match(spec, /role:<roleId>/);
  assert.match(spec, /connection:<connectionId>/);
  assert.match(spec, /natural ACP final report defaults to a Delivery/i);
  assert.match(spec, /Retired public commands\s+are removed rather than kept as aliases/);
  assert.match(spec, /Project instructions live in the\s+workspace `AGENTS\.md`/);
  assert.doesNotMatch(spec, /temp\/<role>\/reports\//);
  assert.doesNotMatch(spec, /## 6\. Proposal, Report, And Fork/);
  // Two composable contracts: every Task executor uses tent-task; durable Roles add tent-role.
  assert.match(roleSkill, /name: tent-role/);
  assert.match(roleSkill, /tent role-init <role>/);
  assert.match(roleSkill, /\.tent\/temp\/<role>\/init\.md/);
  assert.match(roleSkill, /also apply `tent-task`/i);
  assert.match(roleSkill, /Role prompt/);
  assert.match(roleSkill, /downstream/i);
  assert.match(roleSkill, /immutable Connection snapshot/i);
  assert.match(roleSkill, /task claim --work-node/i);
  assert.match(roleSkill, /task dispatch --target connection:/i);
  assert.ok(roleSkill.length < 6000, "tent-role SKILL.md should stay compact");

  assert.match(taskSkill, /name: tent-task/);
  assert.match(taskSkill, /tent task request-decision/);
  assert.match(taskSkill, /task-input/i);
  assert.match(taskSkill, /Delivery is never acceptance/i);
  assert.match(taskSkill, /Work refs are occupied/i);
  assert.match(taskSkill, /natural, non-empty managed ACP final report is deliverable by default/i);
  assert.match(taskSkill, /preserves every non-empty final\s+report as a durable draft/i);
  assert.match(taskSkill, /outcome: blocked/);
  assert.match(taskSkill, /outcome: needs-input/);
  assert.match(taskSkill, /Context Card/i);
  assert.match(taskSkill, /references\//);
  assert.match(
    taskSkill,
    /Never send input to the same Task as its executor|same Task as its executor/i
  );
  assert.match(taskSkill, /dispatcher/i);
  assert.doesNotMatch(taskSkill, /Agents never call `tent task send-input`/i);
  assert.doesNotMatch(taskSkill, /honor contract|manifest-writable|Honor manifest readable/i);
  assert.ok(taskSkill.length < 6000, "tent-task SKILL.md should stay compact");

  assert.match(taskPaths, /system root/i);
  assert.match(taskPaths, /\.tent\/temp/);
  assert.match(taskPaths, /workNodeIds|Context Card/i);
  assert.doesNotMatch(taskPaths, /honor contract/i);
  assert.match(taskCli, /tent task deliver/);
  assert.match(taskCli, /tent task request-decision/);
  assert.match(taskCli, /tent task send-input/);
  assert.match(taskCli, /tent task task-input list/);
  assert.match(taskCli, /tent task task-input ack/);
  assert.match(taskCli, /self-`send-input`|same.*task you are currently executing/i);
  assert.match(taskCli, /dispatcher/i);
  assert.match(taskCli, /--target role:<roleId>\|connection:<connectionId>/);
  assert.match(taskCli, /preserves every non-empty final report as a durable draft/i);
  assert.match(taskCli, /publishes natural report content as Delivery/i);
  assert.match(taskCli, /schedules exactly one durable report-draft retry/i);
  assert.doesNotMatch(taskCli, /Agents never call|There is \*\*no\*\* `tent agent/i);
  assert.match(taskSession, /Temporary managed ACP Session boundaries/i);
  assert.match(taskSession, /immutable Connection snapshot/i);
  assert.match(taskSession, /waiting\(session_unavailable\)/i);
  assert.match(taskSession, /Context Card/i);
  assert.doesNotMatch(`${roleSkill}\n${taskSkill}`, /name: tent-agent|tent handoff/i);

  const canonicalPublicContracts = [
    spec,
    roleSkill,
    taskSkill,
    taskCli,
    taskSession,
    ...publicDesktopContracts,
  ].join("\n");
  for (const retired of [
    /agent:<agentId>/i,
    /AgentDefinition/i,
    /LaunchProfile/i,
    /AgentProfile/i,
    /agent-profiles/i,
    /standing roster/i,
    /roster authorization/i,
    /out-of-roster/i,
    /authorized Agent roster/i,
    /\basSub\b/i,
    /concept\.(changed|removed)/i,
    /\bboxId\b/i,
    /\bUserAsk\b/i,
    /task\.askUser/i,
    /Settings route/i,
    /route:<routeId>/i,
  ]) {
    assert.doesNotMatch(canonicalPublicContracts, retired);
  }
  assert.doesNotMatch(taskSkill, /Finish with one structured outcome/i);
  assert.doesNotMatch(taskSkill, /Lead the terminal report with exactly one/i);
});

test("docs/skill drift: in-workspace Node/Task/Delivery model and retired type axes", async () => {
  const spec = await fs.readFile(path.join(repoRoot, "docs", "SPEC.md"), "utf8");
  const taskPaths = await fs.readFile(
    path.join(repoRoot, "skills", "tent-task", "references", "paths.md"),
    "utf8"
  );

  // SPEC: in-workspace root, fixed Node semantics, WorkspaceLane; no live workspacePointer axis.
  assert.match(spec, /in-workspace/i);
  assert.match(spec, /WorkspaceLane/);
  assert.match(spec, /goal \| prompt \| output/);
  assert.match(spec, /Task, Session, and Delivery/);
  assert.match(spec, /coordination flags are presentation or retired concerns/);
  assert.match(spec, /does not publish a\s+permanent migration API/i);
  assert.doesNotMatch(
    spec,
    /Base type definitions may set optional `workspacePointer: true`/
  );
  assert.doesNotMatch(spec, /Built-in `output` enables the flag/);
  assert.doesNotMatch(spec, /multiple workspace pointer nodes/);
  assert.doesNotMatch(spec, /workspacePointer/);

  // tent-task keeps the automatic lane naming contract in its path reference.
  assert.match(taskPaths, /WorkspaceLane/);
  assert.match(taskPaths, /tent-role\/<role>/);
  assert.match(taskPaths, /tent-task\/<taskId>/);
  assert.doesNotMatch(
    taskPaths,
    /types\.json` 开启了 `workspacePointer`/
  );
  assert.doesNotMatch(
    taskPaths,
    /从 Tent 唯一的 workspace 指针框解析 workspace/
  );

  // Obsidian plugin production source is retired; no plugin UI to reintroduce workspacePointer.
  assert.equal(await exists(path.join(repoRoot, "src", "plugin")), false);

  // Retired direct-write commands are removed from the public CLI surface.
  const tentCli = await fs.readFile(path.join(repoRoot, "src", "cli", "tent.ts"), "utf8");
  assert.doesNotMatch(tentCli, /requires a workspace pointer/);
  assert.doesNotMatch(tentCli, /has no workspace pointer/);
  assert.doesNotMatch(tentCli, /require-check requires a workspace root/);
  assert.doesNotMatch(tentCli, /case "(?:complete|stamp|grant-readable)"/);
  assert.doesNotMatch(tentCli, /\bcomplete\|stamp\b|\bgrant-readable\b/);
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

function gitTrackedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "buffer",
  });
  assert.equal(result.status, 0, result.stderr?.toString("utf8"));
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
