// Build Electron desktop shell into desktop/dist/
import * as esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyExcalidrawProdAssets } from "./excalidraw-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function canonicalBuildOptions(buildRoot) {
  return {
    absWorkingDir: path.resolve(buildRoot),
    // Task/Role worktrees intentionally junction node_modules to the shared
    // checkout. Keep esbuild's module identity at the logical repository path
    // so source identifiers and package roots do not depend on the junction's
    // physical target.
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

async function buildBundle(buildRoot, label, options, singletonPackages = []) {
  const result = await esbuild.build({
    ...canonicalBuildOptions(buildRoot),
    ...options,
    metafile: true,
  });
  assertCanonicalMetafile(label, result.metafile, singletonPackages);
}

async function listFiles(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute)));
    if (entry.isFile()) files.push(absolute);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export async function assertCanonicalDesktopArtifacts(buildRoot, buildOutRoot) {
  const absoluteRoot = path.resolve(buildRoot);
  const files = await listFiles(buildOutRoot);
  const textExtensions = new Set([
    ".cjs",
    ".css",
    ".html",
    ".js",
    ".json",
    ".map",
    ".mjs",
    ".svg",
    ".txt",
  ]);
  for (const file of files) {
    // Font and image bytes can coincidentally decode to a Windows-looking
    // sequence. Canonical path checks apply only to textual artifacts.
    if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
    const text = await fs.readFile(file, "utf8");
    if (file.endsWith(".map")) {
      const sourceMap = JSON.parse(text);
      const sourceRoot =
        typeof sourceMap.sourceRoot === "string" ? sourceMap.sourceRoot : "";
      for (const source of sourceMap.sources ?? []) {
        const resolved = path.resolve(path.dirname(file), sourceRoot, source);
        const relative = slash(path.relative(absoluteRoot, resolved));
        if (
          relative.startsWith("../") ||
          path.isAbsolute(relative) ||
          (!relative.startsWith("src/") && !relative.startsWith("node_modules/"))
        ) {
          throw new Error(
            `${slash(path.relative(absoluteRoot, file))}: non-repository source ${source}`
          );
        }
      }
      continue;
    }
    const portable = slash(text);
    if (
      /(?:^|[\s"'`(=])[A-Za-z]:[\\/](?![\\/])/.test(text) ||
      portable.includes("../../Tent") ||
      /Tent-worktrees/i.test(portable)
    ) {
      throw new Error(
        `${slash(path.relative(absoluteRoot, file))}: contains a machine- or lane-specific path`
      );
    }
  }
}

async function clean(buildOutRoot) {
  await fs.rm(buildOutRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(buildOutRoot, "main"), { recursive: true });
  await fs.mkdir(path.join(buildOutRoot, "preload"), { recursive: true });
  await fs.mkdir(path.join(buildOutRoot, "renderer"), { recursive: true });
  await fs.mkdir(path.join(buildOutRoot, "renderer-next"), { recursive: true });
}

async function copyFloatStatic(buildRoot, buildOutRoot) {
  const srcDir = path.join(buildRoot, "src", "desktop", "renderer");
  for (const name of ["float.html", "float.css"]) {
    await fs.copyFile(path.join(srcDir, name), path.join(buildOutRoot, "renderer", name));
  }
}

/** Production React renderer loaded by the main Electron window. */
async function copyRendererNextStatic(buildRoot, buildOutRoot) {
  const srcDir = path.join(buildRoot, "src", "desktop", "renderer-next");
  const outDir = path.join(buildOutRoot, "renderer-next");
  await fs.copyFile(path.join(srcDir, "index.html"), path.join(outDir, "index.html"));
  const stylesSrc = path.join(srcDir, "styles");
  const stylesOut = path.join(outDir, "styles");
  await fs.mkdir(stylesOut, { recursive: true });
  for (const name of await fs.readdir(stylesSrc)) {
    if (!name.endsWith(".css")) continue;
    await fs.copyFile(path.join(stylesSrc, name), path.join(stylesOut, name));
  }
  // tokens.css imports the primitive layer by this exact relative path.
  const uiOut = path.join(outDir, "ui");
  await fs.mkdir(uiOut, { recursive: true });
  await fs.copyFile(
    path.join(srcDir, "ui", "primitives.css"),
    path.join(uiOut, "primitives.css")
  );
}

async function copyExcalidrawAssets(buildRoot, buildOutRoot) {
  const result = await copyExcalidrawProdAssets({
    repoRoot: buildRoot,
    rendererNextOutDir: path.join(buildOutRoot, "renderer-next"),
  });
  if (!result.ok) {
    throw new Error(
      `Excalidraw offline asset copy failed: ${result.reason}\n` +
        "Install @excalidraw/excalidraw and re-run build:desktop."
    );
  }
}

export async function build(buildRoot = root) {
  const absoluteRoot = path.resolve(buildRoot);
  const buildOutRoot = path.join(absoluteRoot, "desktop", "dist");
  await clean(buildOutRoot);

  // Main process (node + electron)
  await buildBundle(absoluteRoot, "desktop-main", {
    entryPoints: ["src/desktop/main/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: path.join(buildOutRoot, "main", "index.cjs"),
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  });

  // Preload must be CJS for Electron contextBridge
  await buildBundle(absoluteRoot, "desktop-preload", {
    entryPoints: ["src/desktop/preload/preload.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: path.join(buildOutRoot, "preload", "preload.cjs"),
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  });

  // Floating control renderer (browser). The production main window is the
  // React renderer-next bundle below.
  await buildBundle(absoluteRoot, "desktop-float-renderer", {
    entryPoints: ["src/desktop/renderer/float-ui.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outdir: path.join(buildOutRoot, "renderer"),
    entryNames: "[name]",
    sourcemap: true,
    logLevel: "info",
  });

  // Always emit a production React build (minify + NODE_ENV) so the tracked
  // dist artifact stays lean and never ships react-dom.development.js.
  await buildBundle(absoluteRoot, "desktop-renderer-next-asset-bootstrap", {
    entryPoints: [
      "src/desktop/renderer-next/canvas/excalidraw/excalidrawAssetPath.ts",
    ],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    outfile: path.join(
      buildOutRoot,
      "renderer-next",
      "excalidraw-asset-bootstrap.js"
    ),
    minify: true,
    logLevel: "info",
  });

  await buildBundle(absoluteRoot, "desktop-renderer-next", {
    entryPoints: ["src/desktop/renderer-next/main.tsx"],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outfile: path.join(buildOutRoot, "renderer-next", "main.js"),
    sourcemap: true,
    minify: true,
    logLevel: "info",
    conditions: ["production"],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    loader: {
      ".tsx": "tsx",
      ".ts": "ts",
      ".css": "css",
      ".woff2": "file",
      ".woff": "file",
      ".ttf": "file",
      ".otf": "file",
    },
    jsx: "automatic",
  }, ["react", "react-dom", "scheduler"]);

  await copyFloatStatic(absoluteRoot, buildOutRoot);
  await copyRendererNextStatic(absoluteRoot, buildOutRoot);
  await copyExcalidrawAssets(absoluteRoot, buildOutRoot);

  // Package entry for electron .
  await fs.writeFile(
    path.join(absoluteRoot, "desktop", "package.json"),
    JSON.stringify(
      {
        name: "tent-desktop",
        private: true,
        main: "dist/main/index.cjs",
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await assertCanonicalDesktopArtifacts(absoluteRoot, buildOutRoot);

  console.log("Desktop build complete → desktop/dist (renderer-next + float)");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  build().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
