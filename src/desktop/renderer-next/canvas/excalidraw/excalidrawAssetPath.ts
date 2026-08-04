/**
 * Pre-lazy EXCALIDRAW_ASSET_PATH bootstrap for packaged offline Electron.
 *
 * Official @excalidraw/excalidraw resolves fonts/locales/workers from:
 *   1. window.EXCALIDRAW_ASSET_PATH (string | string[])
 *   2. hard CDN fallback (esm.sh) — blocked offline + CSP
 *
 * Call {@link ensureExcalidrawAssetPath} once before any dynamic import of
 * `@excalidraw/excalidraw` so relative `./fonts`, `./locales`, and
 * `subset-worker.chunk.js` resolve under the packaged asset tree.
 *
 * Build copies `dist/prod/{fonts,locales,subset-*.chunk.js,index.css}` to
 * `desktop/dist/renderer-next/excalidraw-assets/` (same layout as prod).
 */

/** Packaged relative directory under renderer-next (trailing slash required). */
export const EXCALIDRAW_ASSETS_DIR = "excalidraw-assets/";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

/**
 * Resolve a base URL for Excalidraw static assets next to the renderer entry.
 * Prefer document base / current module location so file:// and asar loadFile work.
 */
export function resolveExcalidrawAssetPathBase(
  baseHref: string = typeof document !== "undefined" ? document.baseURI : ""
): string {
  const href = baseHref || "file:///";
  // new URL with trailing-slash relative path → directory URL
  const url = new URL(EXCALIDRAW_ASSETS_DIR, href);
  let hrefOut = url.href;
  if (!hrefOut.endsWith("/")) hrefOut += "/";
  return hrefOut;
}

/**
 * Set window.EXCALIDRAW_ASSET_PATH if unset. Idempotent; does not overwrite
 * an explicit host/test value.
 */
export function ensureExcalidrawAssetPath(
  baseHref?: string
): string | string[] | undefined {
  if (typeof window === "undefined") return undefined;
  const existing = window.EXCALIDRAW_ASSET_PATH;
  if (typeof existing === "string" && existing.length > 0) return existing;
  if (Array.isArray(existing) && existing.length > 0) return existing;
  const resolved = resolveExcalidrawAssetPathBase(baseHref);
  window.EXCALIDRAW_ASSET_PATH = resolved;
  return resolved;
}
