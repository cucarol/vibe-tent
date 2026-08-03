import esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

export function canonicalBuildOptions(buildRoot) {
  return {
    absWorkingDir: path.resolve(buildRoot),
    // Role/Task worktrees junction node_modules to the shared checkout. Keep
    // esbuild module identity at the logical worktree root so bundle labels do
    // not depend on the junction's physical target.
    preserveSymlinks: true,
  };
}

function slash(value) {
  return value.replaceAll("\\", "/");
}

export function assertCanonicalMetafile(label, metafile, singletonPackages = []) {
  const inputs = Object.keys(metafile.inputs).map(slash);
  for (const input of inputs) {
    if (
      path.isAbsolute(input) ||
      input.startsWith("../") ||
      input.includes("/../") ||
      /Tent-worktrees/i.test(input)
    ) {
      throw new Error(`${label}: non-canonical esbuild input ${input}`);
    }
    if (!input.startsWith("src/") && !input.startsWith("node_modules/")) {
      throw new Error(`${label}: input is outside src/ or node_modules/: ${input}`);
    }
  }

  for (const packageName of singletonPackages) {
    const marker = `node_modules/${packageName}/`;
    const roots = new Set(
      inputs
        .filter((input) => input.includes(marker))
        .map((input) => input.slice(0, input.indexOf(marker) + marker.length - 1))
    );
    if (roots.size !== 1) {
      throw new Error(
        `${label}: expected exactly one ${packageName} module root, found ${[
          ...roots,
        ].join(", ") || "none"}`
      );
    }
  }
}

export async function assertCanonicalRootArtifacts(buildRoot, artifactNames) {
  for (const name of artifactNames) {
    const file = path.join(path.resolve(buildRoot), name);
    const text = await fs.readFile(file, "utf8");
    const portable = slash(text);
    if (
      /(?:^|[^A-Za-z])[A-Za-z]:[\\/](?![\\/])/.test(text) ||
      portable.includes("../../Tent/node_modules/") ||
      /Tent-worktrees/i.test(portable)
    ) {
      throw new Error(`${name}: contains a machine- or lane-specific path`);
    }
  }
}

function rootBundleOptions(buildRoot) {
  const absoluteRoot = path.resolve(buildRoot);
  const shared = {
    ...canonicalBuildOptions(absoluteRoot),
    bundle: true,
    external: ["node:*"],
    format: "esm",
    target: "es2021",
    logLevel: "info",
    sourcemap: false,
    treeShaking: true,
    platform: "node",
    metafile: true,
  };
  return [
    {
      label: "root-cli",
      artifact: "cli.mjs",
      options: {
        ...shared,
        entryPoints: ["src/cli/tent.ts"],
        outfile: path.join(absoluteRoot, "cli.mjs"),
      },
    },
    {
      label: "root-service",
      artifact: "service.mjs",
      options: {
        ...shared,
        entryPoints: ["src/service/cli.ts"],
        outfile: path.join(absoluteRoot, "service.mjs"),
        banner: { js: "#!/usr/bin/env node\n" },
      },
    },
  ];
}

export async function build(buildRoot = root, production = false) {
  const bundles = rootBundleOptions(buildRoot);
  if (production) {
    for (const bundle of bundles) {
      const result = await esbuild.build(bundle.options);
      assertCanonicalMetafile(bundle.label, result.metafile);
    }
    await assertCanonicalRootArtifacts(
      buildRoot,
      bundles.map((bundle) => bundle.artifact)
    );
    return;
  }

  for (const bundle of bundles) {
    const context = await esbuild.context(bundle.options);
    await context.watch();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  build(root, process.argv[2] === "production").catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
