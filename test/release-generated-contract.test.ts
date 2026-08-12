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

function generatedWindow(text: string, marker: string, radius = 500): string {
  const index = text.indexOf(marker);
  assert.notEqual(index, -1, `generated artifact must contain ${marker}`);
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius));
}

function generatedCall(text: string, marker: string): string {
  const index = text.indexOf(marker);
  assert.notEqual(index, -1, `generated artifact must contain ${marker}`);
  const end = text.indexOf("});", index);
  assert.notEqual(end, -1, `generated call must close after ${marker}`);
  return text.slice(index, end + 3);
}

test("generated release artifacts require protocol 7 id-only review and Decision mutation", async () => {
  const [cli, service, desktopMain, desktopRenderer] = await Promise.all([
    generated("cli.mjs"),
    generated("service.mjs"),
    generated("desktop/dist/main/index.cjs"),
    generated("desktop/dist/renderer-next/main.js"),
  ]);

  assert.match(cli, /TENT_SERVICE_PROTOCOL_VERSION = 7/);
  assert.match(service, /TENT_SERVICE_PROTOCOL_VERSION = 7/);
  assert.match(cli, /tent task accept <deliveryId> --actor <user\|role>/);
  assert.match(cli, /tent task reject <deliveryId> --actor <user\|role>/);
  assert.match(cli, /tent task decision respond <requestId>/);
  assert.doesNotMatch(cli, /task accept <taskPath>/);
  assert.doesNotMatch(cli, /task reject <taskPath>/);
  assert.doesNotMatch(cli, /--delivery-id/);

  assert.match(
    service,
    /new Set\(\["workspaceId", "deliveryId", "actor", "outputNodeIds"\]\)/
  );
  assert.match(
    service,
    /new Set\(\["workspaceId", "deliveryId", "actor", "note", "resume"\]\)/
  );
  assert.match(
    service,
    /new Set\(\["workspaceId", "requestId", "response"\]\)/
  );
  assert.doesNotMatch(
    service,
    /new Set\(\["workspaceId", "taskPath", "deliveryId", "actor"/
  );
  assert.doesNotMatch(
    service,
    /new Set\(\["workspaceId", "taskPath", "requestId", "response"\]\)/
  );

  assert.match(desktopMain, /TENT_SERVICE_PROTOCOL_VERSION = 7/);
  assert.match(desktopMain, /task\.accept/);
  assert.match(desktopMain, /task\.reject/);
  assert.match(desktopMain, /decisionRequest\.respond/);
  assert.match(desktopMain, /deliveryId/);
  assert.match(desktopMain, /requestId/);
  assert.doesNotMatch(desktopMain, /expectedDeliveryId/);
  for (const marker of [
    'client.call("task.accept"',
    'client.call("task.reject"',
    'client.call("decisionRequest.respond"',
  ]) {
    const mutation = generatedCall(desktopMain, marker);
    assert.doesNotMatch(mutation, /taskPath|taskId/);
  }

  assert.match(desktopRenderer, /protocolVersion!==7/);
  assert.match(desktopRenderer, /acceptDelivery/);
  assert.match(desktopRenderer, /rejectDelivery/);
  assert.match(desktopRenderer, /respondDecision/);
  assert.match(desktopRenderer, /deliveryId/);
  assert.match(desktopRenderer, /requestId/);
  assert.doesNotMatch(desktopRenderer, /expectedDeliveryId/);
  assert.doesNotMatch(generatedWindow(desktopRenderer, "acceptDelivery", 240), /taskPath|taskId/);
  assert.doesNotMatch(generatedWindow(desktopRenderer, "rejectDelivery", 240), /taskPath|taskId/);
  assert.doesNotMatch(generatedWindow(desktopRenderer, "respondDecision", 240), /taskPath|taskId/);

  for (const artifact of [cli, service, desktopMain, desktopRenderer]) {
    assert.doesNotMatch(artifact, /taskDeltaDigest/);
    assert.doesNotMatch(artifact, /Role checkpoint/i);
  }
  assert.doesNotMatch(cli, /role-checkpoint/);
  for (const artifact of [cli, service]) {
    assert.doesNotMatch(artifact, /role\.checkpoint/);
    assert.doesNotMatch(artifact, /role\.cli must be an object/);
    assert.doesNotMatch(artifact, /role\.cli\.command must be a non-empty string/);
  }
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
