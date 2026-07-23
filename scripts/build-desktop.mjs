// Build Electron desktop shell into desktop/dist/
import * as esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(root, "desktop", "dist");

async function clean() {
  await fs.rm(outRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(outRoot, "main"), { recursive: true });
  await fs.mkdir(path.join(outRoot, "preload"), { recursive: true });
  await fs.mkdir(path.join(outRoot, "renderer"), { recursive: true });
  await fs.mkdir(path.join(outRoot, "renderer-next"), { recursive: true });
}

async function copyRendererStatic() {
  const srcDir = path.join(root, "src", "desktop", "renderer");
  for (const name of ["index.html", "float.html", "styles.css"]) {
    await fs.copyFile(path.join(srcDir, name), path.join(outRoot, "renderer", name));
  }
  // Layered CSS parts referenced by styles.css @import (file:// / asar relative).
  const stylesSrc = path.join(srcDir, "styles");
  const stylesOut = path.join(outRoot, "renderer", "styles");
  await fs.mkdir(stylesOut, { recursive: true });
  for (const name of await fs.readdir(stylesSrc)) {
    if (!name.endsWith(".css")) continue;
    await fs.copyFile(path.join(stylesSrc, name), path.join(stylesOut, name));
  }
}

/** Isolated React next renderer — not the default Electron load path. */
async function copyRendererNextStatic() {
  const srcDir = path.join(root, "src", "desktop", "renderer-next");
  const outDir = path.join(outRoot, "renderer-next");
  await fs.copyFile(path.join(srcDir, "index.html"), path.join(outDir, "index.html"));
  const stylesSrc = path.join(srcDir, "styles");
  const stylesOut = path.join(outDir, "styles");
  await fs.mkdir(stylesOut, { recursive: true });
  for (const name of await fs.readdir(stylesSrc)) {
    if (!name.endsWith(".css")) continue;
    await fs.copyFile(path.join(stylesSrc, name), path.join(stylesOut, name));
  }
}

async function build() {
  await clean();

  // Main process (node + electron)
  await esbuild.build({
    entryPoints: [path.join(root, "src/desktop/main/index.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: path.join(outRoot, "main", "index.cjs"),
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  });

  // Preload must be CJS for Electron contextBridge
  await esbuild.build({
    entryPoints: [path.join(root, "src/desktop/preload/preload.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: path.join(outRoot, "preload", "preload.cjs"),
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  });

  // Renderer modules (browser) — current default workbench
  await esbuild.build({
    entryPoints: [
      path.join(root, "src/desktop/renderer/main-ui.ts"),
      path.join(root, "src/desktop/renderer/float-ui.ts"),
    ],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outdir: path.join(outRoot, "renderer"),
    entryNames: "[name]",
    sourcemap: true,
    logLevel: "info",
  });

  // Isolated next renderer (React). Output only under renderer-next/;
  // Electron default mainHtml still points at desktop/dist/renderer/index.html.
  await esbuild.build({
    entryPoints: [path.join(root, "src/desktop/renderer-next/main.tsx")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outfile: path.join(outRoot, "renderer-next", "main.js"),
    sourcemap: true,
    logLevel: "info",
    loader: {
      ".tsx": "tsx",
      ".ts": "ts",
      ".css": "css",
    },
    jsx: "automatic",
  });

  await copyRendererStatic();
  await copyRendererNextStatic();

  // Package entry for electron .
  await fs.writeFile(
    path.join(root, "desktop", "package.json"),
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

  console.log("Desktop build complete → desktop/dist (renderer + renderer-next)");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
