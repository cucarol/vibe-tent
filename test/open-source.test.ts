import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
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
  assert.equal(pkg.bin.tent, "./cli.mjs");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.author, manifest.author);
  assert.equal(pkg.repository.url, "git+https://github.com/cucarol/tent.git");
  assert.equal(pkg.bugs.url, "https://github.com/cucarol/tent/issues");
  assert.equal(pkg.homepage, "https://github.com/cucarol/tent#readme");
  assert.equal(pkg.version, manifest.version, "npm 与 Obsidian 插件版本保持一致");
  assert.equal(
    versions[manifest.version],
    manifest.minAppVersion,
    "versions.json 记录当前插件所需的最低 Obsidian 版本"
  );
  assert.ok(pkg.files.includes("versions.json"), "npm 发布包包含 Obsidian 版本映射");
  assert.equal(await exists(path.join(repoRoot, "LICENSE")), true);
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
