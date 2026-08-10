import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function generated(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

async function assertGeneratedFile(relativePath: string): Promise<void> {
  const stat = await fs.stat(path.join(repoRoot, relativePath));
  assert.equal(stat.isFile(), true, `${relativePath} must be a generated file`);
  assert.ok(stat.size > 0, `${relativePath} must not be empty`);
}

test("generated release artifacts require protocol 5 delivery-bound review", async () => {
  const [cli, service, desktopMain, desktopRenderer] = await Promise.all([
    generated("cli.mjs"),
    generated("service.mjs"),
    generated("desktop/dist/main/index.cjs"),
    generated("desktop/dist/renderer-next/main.js"),
  ]);

  assert.match(cli, /TENT_SERVICE_PROTOCOL_VERSION = 5/);
  assert.match(service, /TENT_SERVICE_PROTOCOL_VERSION = 5/);
  assert.match(cli, /tent task accept <taskPath> --delivery-id <deliveryId>/);
  assert.match(cli, /tent task reject <taskPath> --delivery-id <deliveryId>/);
  assert.doesNotMatch(cli, /--expected-delivery-id/);

  assert.match(
    service,
    /new Set\(\["workspaceId", "taskPath", "deliveryId", "actor", "outputNodeIds"\]\)/
  );
  assert.match(
    service,
    /new Set\(\["workspaceId", "taskPath", "deliveryId", "actor", "note", "resume"\]\)/
  );
  assert.doesNotMatch(service, /expectedDeliveryId/);

  assert.match(desktopMain, /TENT_SERVICE_PROTOCOL_VERSION = 5/);
  assert.match(desktopMain, /task\.accept/);
  assert.match(desktopMain, /task\.reject/);
  assert.match(desktopMain, /deliveryId/);
  assert.doesNotMatch(desktopMain, /expectedDeliveryId/);

  assert.match(desktopRenderer, /protocolVersion!==5/);
  assert.match(desktopRenderer, /acceptDelivery/);
  assert.match(desktopRenderer, /rejectDelivery/);
  assert.match(desktopRenderer, /deliveryId/);
  assert.doesNotMatch(desktopRenderer, /expectedDeliveryId/);
});

test("generated renderer-next dependency closure is complete", async () => {
  const rendererRoot = "desktop/dist/renderer-next";
  const html = await generated(`${rendererRoot}/index.html`);
  const css = await generated(`${rendererRoot}/main.css`);

  const htmlRefs = [...html.matchAll(/(?:href|src)="\.\/([^"#?]+)"/g)].map(
    (match) => match[1]!
  );
  assert.deepEqual(
    htmlRefs.sort(),
    [
      "excalidraw-asset-bootstrap.js",
      "main.css",
      "main.js",
      "styles/shell.css",
      "styles/tokens.css",
    ].sort()
  );
  for (const ref of htmlRefs) await assertGeneratedFile(`${rendererRoot}/${ref}`);

  const cssRefs = [...css.matchAll(/url\((?:"|')?(\.\/[^"')]+)(?:"|')?\)/g)].map(
    (match) => match[1]!.slice(2)
  );
  assert.deepEqual(
    cssRefs.sort(),
    [
      "Assistant-Bold-ZDZZ6JHA.woff2",
      "Assistant-Medium-DZ25RZU3.woff2",
      "Assistant-Regular-PLF2XOGW.woff2",
      "Assistant-SemiBold-CZ5MX6FK.woff2",
    ].sort()
  );
  for (const ref of cssRefs) await assertGeneratedFile(`${rendererRoot}/${ref}`);

  for (const ref of [
    "excalidraw-assets/index.css",
    "excalidraw-assets/subset-worker.chunk.js",
    "excalidraw-assets/subset-shared.chunk.js",
    "excalidraw-assets/fonts/Assistant/Assistant-Regular.woff2",
    "excalidraw-assets/locales/zh-CN-LNUGB5OW.js",
  ]) {
    await assertGeneratedFile(`${rendererRoot}/${ref}`);
  }
  const chunks = (await fs.readdir(path.join(repoRoot, rendererRoot, "excalidraw-assets"))).filter(
    (name) => name.startsWith("chunk-") && name.endsWith(".js")
  );
  assert.ok(chunks.length > 0, "Excalidraw worker sibling chunks must be packaged");
});

test("generated floating renderer directory contains the float window only", async () => {
  const rendererRoot = path.join(repoRoot, "desktop", "dist", "renderer");
  const files = (await fs.readdir(rendererRoot)).sort();
  assert.deepEqual(files, ["float-ui.js", "float-ui.js.map", "float.css", "float.html"]);
  for (const name of files) await assertGeneratedFile(`desktop/dist/renderer/${name}`);
});
