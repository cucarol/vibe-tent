import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

type DesktopBuildContract = {
  canonicalBuildOptions(root: string): esbuild.BuildOptions;
  assertCanonicalMetafile(
    label: string,
    metafile: esbuild.Metafile,
    singletonPackages?: string[]
  ): void;
  assertCanonicalDesktopArtifacts(root: string, outRoot: string): Promise<void>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadContract(): Promise<DesktopBuildContract> {
  return (await import(
    pathToFileURL(path.join(repoRoot, "scripts", "build-desktop.mjs")).href
  )) as DesktopBuildContract;
}

async function writeFixtureSource(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "helper.ts"),
    'import singleton from "singleton-package";\nexport { singleton };\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "src", "entry.ts"),
    [
      'import direct from "singleton-package";',
      'import { singleton as indirect } from "./helper.js";',
      'if (direct !== indirect) throw new Error("duplicate singleton");',
      'console.log("singleton-ok");',
      "",
    ].join("\n"),
    "utf8"
  );
}

async function writePhysicalPackage(root: string): Promise<void> {
  const packageRoot = path.join(root, "node_modules", "singleton-package");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "singleton-package", version: "1.0.0", main: "index.js" }),
    "utf8"
  );
  await fs.writeFile(path.join(packageRoot, "index.js"), "export default {};\n", "utf8");
}

async function buildFixture(
  root: string,
  contract: DesktopBuildContract,
  preserveSymlinks: boolean
): Promise<esbuild.BuildResult<esbuild.BuildOptions>> {
  const outRoot = path.join(root, "desktop", "dist");
  await fs.mkdir(outRoot, { recursive: true });
  const result = await esbuild.build({
    ...contract.canonicalBuildOptions(root),
    preserveSymlinks,
    entryPoints: ["src/entry.ts"],
    outfile: path.join(outRoot, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    sourcemap: true,
    metafile: true,
    logLevel: "silent",
  });
  return result;
}

test("desktop esbuild inputs are canonical across physical and junction node_modules", async () => {
  const contract = await loadContract();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tent-desktop-build-"));
  const physicalRoot = path.join(tempRoot, "physical");
  const junctionRoot = path.join(tempRoot, "junction");
  const junctionModules = path.join(junctionRoot, "node_modules");

  try {
    await writeFixtureSource(physicalRoot);
    await writePhysicalPackage(physicalRoot);
    await writeFixtureSource(junctionRoot);
    await fs.symlink(
      path.join(physicalRoot, "node_modules"),
      junctionModules,
      process.platform === "win32" ? "junction" : "dir"
    );

    const physical = await buildFixture(physicalRoot, contract, true);
    const junction = await buildFixture(junctionRoot, contract, true);
    contract.assertCanonicalMetafile("physical", physical.metafile!, [
      "singleton-package",
    ]);
    contract.assertCanonicalMetafile("junction", junction.metafile!, [
      "singleton-package",
    ]);

    const artifactNames = ["main.cjs", "main.cjs.map"];
    for (const name of artifactNames) {
      const [physicalBytes, junctionBytes] = await Promise.all([
        fs.readFile(path.join(physicalRoot, "desktop", "dist", name)),
        fs.readFile(path.join(junctionRoot, "desktop", "dist", name)),
      ]);
      assert.deepEqual(junctionBytes, physicalBytes, `${name} must be byte-identical`);
    }
    await contract.assertCanonicalDesktopArtifacts(
      physicalRoot,
      path.join(physicalRoot, "desktop", "dist")
    );
    await contract.assertCanonicalDesktopArtifacts(
      junctionRoot,
      path.join(junctionRoot, "desktop", "dist")
    );

    const runtime = spawnSync(process.execPath, [path.join(junctionRoot, "desktop", "dist", "main.cjs")], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(runtime.status, 0, runtime.stderr);
    assert.equal(runtime.stdout.trim(), "singleton-ok");

    const nonCanonical = await buildFixture(junctionRoot, contract, false);
    assert.throws(
      () => contract.assertCanonicalMetafile("junction-default", nonCanonical.metafile!),
      /non-canonical esbuild input/
    );
  } finally {
    await fs.unlink(junctionModules).catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
