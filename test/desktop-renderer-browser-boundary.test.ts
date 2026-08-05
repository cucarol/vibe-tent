import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("legacy desktop renderer graph stays browser-safe", async () => {
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    preserveSymlinks: true,
    entryPoints: [
      "src/desktop/renderer/main-ui.ts",
      "src/desktop/renderer/float-ui.ts",
    ],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outdir: "desktop/dist-test/renderer",
    write: false,
    metafile: true,
    logLevel: "silent",
  });

  const inputs = Object.keys(result.metafile.inputs).map((input) =>
    input.replaceAll("\\", "/")
  );
  assert.equal(
    inputs.some((input) => input.endsWith("/src/core/etag.ts") || input === "src/core/etag.ts"),
    false,
    "browser renderer must not import the Node-only content etag module"
  );
  assert.ok(inputs.some((input) => input.endsWith("src/core/okf-index.ts")));
});
