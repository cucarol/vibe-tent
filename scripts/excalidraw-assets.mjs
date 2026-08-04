/**
 * Copy official @excalidraw/excalidraw dist/prod static assets into the
 * desktop renderer-next output tree for offline Electron packaging.
 *
 * Public artifacts only (fonts, locales, subset workers, index.css).
 * Does not rewrite package source; consumers set EXCALIDRAW_ASSET_PATH.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Directory name under desktop/dist/renderer-next/ */
export const EXCALIDRAW_ASSETS_DIRNAME = "excalidraw-assets";

/** Files/dirs to copy from dist/prod (exact public layout). */
export const EXCALIDRAW_PROD_ASSET_ENTRIES = Object.freeze([
  "fonts",
  "locales",
  "subset-worker.chunk.js",
  "subset-shared.chunk.js",
  "index.css",
]);

/**
 * Resolve installed package root for @excalidraw/excalidraw.
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function resolveExcalidrawPackageRoot(repoRoot) {
  const root =
    repoRoot ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    return path.dirname(
      require.resolve("@excalidraw/excalidraw/package.json", { paths: [root] })
    );
  } catch {
    const fallback = path.join(root, "node_modules", "@excalidraw", "excalidraw");
    return fallback;
  }
}

/**
 * @param {string} pkgRoot
 * @returns {string}
 */
export function resolveExcalidrawProdDir(pkgRoot) {
  return path.join(pkgRoot, "dist", "prod");
}

/**
 * Recursive copy (Node without fs.cp on very old runtimes still OK via walk).
 * @param {string} src
 * @param {string} dest
 */
async function copyRecursive(src, dest) {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    for (const name of await fs.readdir(src)) {
      await copyRecursive(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

/**
 * Copy prod static assets into renderer-next/excalidraw-assets.
 * @param {{
 *   repoRoot: string,
 *   rendererNextOutDir: string,
 *   packageRoot?: string,
 * }} opts
 * @returns {Promise<{
 *   ok: true,
 *   destDir: string,
 *   packageRoot: string,
 *   prodDir: string,
 *   copied: string[],
 * } | {
 *   ok: false,
 *   reason: string,
 *   packageRoot?: string,
 *   prodDir?: string,
 * }>}
 */
export async function copyExcalidrawProdAssets(opts) {
  const packageRoot =
    opts.packageRoot ?? resolveExcalidrawPackageRoot(opts.repoRoot);
  const prodDir = resolveExcalidrawProdDir(packageRoot);
  const destDir = path.join(opts.rendererNextOutDir, EXCALIDRAW_ASSETS_DIRNAME);

  try {
    await fs.access(path.join(packageRoot, "package.json"));
  } catch {
    return {
      ok: false,
      reason: `@excalidraw/excalidraw package not found at ${packageRoot}`,
      packageRoot,
      prodDir,
    };
  }

  try {
    await fs.access(prodDir);
  } catch {
    return {
      ok: false,
      reason: `Excalidraw dist/prod missing at ${prodDir}`,
      packageRoot,
      prodDir,
    };
  }

  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(destDir, { recursive: true });

  const copied = [];
  for (const entry of EXCALIDRAW_PROD_ASSET_ENTRIES) {
    const src = path.join(prodDir, entry);
    try {
      await fs.access(src);
    } catch {
      return {
        ok: false,
        reason: `required Excalidraw prod asset missing: ${entry}`,
        packageRoot,
        prodDir,
      };
    }
    await copyRecursive(src, path.join(destDir, entry));
    copied.push(entry);
  }

  // Worker chunks import sibling prod JS (chunk-*.js). Copy those too so
  // module workers can load under file:// without CDN.
  for (const name of await fs.readdir(prodDir)) {
    if (!name.startsWith("chunk-") || !name.endsWith(".js")) continue;
    await copyRecursive(path.join(prodDir, name), path.join(destDir, name));
    copied.push(name);
  }

  return {
    ok: true,
    destDir,
    packageRoot,
    prodDir,
    copied,
  };
}

/**
 * Relative paths that must exist under renderer-next (and inside app.asar)
 * for offline Excalidraw assets. Used by package smoke.
 * @returns {readonly string[]}
 */
export function requiredExcalidrawAsarPaths(prefix = "desktop/dist/renderer-next") {
  const base = `${prefix}/${EXCALIDRAW_ASSETS_DIRNAME}`;
  return Object.freeze([
    `${base}/index.css`,
    `${base}/subset-worker.chunk.js`,
    `${base}/subset-shared.chunk.js`,
    // Representative locale + font samples (full trees are large; smoke checks markers).
    `${base}/locales/zh-CN-LNUGB5OW.js`,
    `${base}/fonts/Assistant/Assistant-Regular.woff2`,
  ]);
}
