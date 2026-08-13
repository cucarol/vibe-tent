import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

async function filesUnder(relativeRoot: string): Promise<string[]> {
  const root = path.join(repoRoot, relativeRoot);
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else out.push(path.relative(repoRoot, file).replaceAll("\\", "/"));
    }
  }
  await walk(root);
  return out;
}

test("source hard-cuts the next runtime to protocol 9", async () => {
  const [protocol, rendererBridge] = await Promise.all([
    source("src/service/protocol.ts"),
    source("src/desktop/renderer-next/gateway/desktop-bridge.ts"),
  ]);

  assert.match(protocol, /TENT_SERVICE_PROTOCOL_VERSION = 9 as const/);
  assert.doesNotMatch(protocol, /TENT_SERVICE_PROTOCOL_VERSION = 8 as const/);
  assert.match(rendererBridge, /health\.protocolVersion !== 9/);
  assert.match(rendererBridge, /protocolVersion: 9/);
  assert.doesNotMatch(rendererBridge, /protocolVersion !== 8/);
});

test("Protocol 9 public contracts expose only current product vocabulary", async () => {
  const experimentFiles = (await filesUnder("experiments")).filter((file) =>
    /\.(?:html|js|json|jsx|md|mjs|ts|tsx|yaml|yml)$/.test(file),
  );
  const publicFiles = [
    "README.md",
    ...(await filesUnder("docs")).filter((file) => file.endsWith(".md")),
    ...(await filesUnder("skills")).filter((file) => /(?:SKILL\.md|\.yaml|references\/.*\.md)$/.test(file)),
    ...experimentFiles,
  ];
  const publicText = (await Promise.all(publicFiles.map(source))).join("\n");
  for (const stale of [
    /\bDelivery\b/i,
    /\bdeliveryId\b/i,
    /task\.deliver/i,
    /\bBox\b/i,
    /\bboxId\b/i,
    /\bSettingsRoute\b/i,
    /\bAgentDefinition\b/i,
    /\broster\b/i,
    /\bparentActor\b/i,
    /\bactiveDeliveryId\b/i,
    /\blastReturn\b/i,
    /\bProtocol[- ]?[2-8]\b/i,
  ]) {
    assert.doesNotMatch(publicText, stale);
  }
  assert.match(publicText, /TaskResult/);
  assert.match(publicText, /task\.submit/);
  assert.match(publicText, /\bresultId\b/);
  assert.match(publicText, /Protocol 9/);
});

test("Protocol 9 source and test names hard-cut Result publication vocabulary", async () => {
  const sourceFiles = (await filesUnder("src")).filter((file) => file.endsWith(".ts"));
  const sourceText = (await Promise.all(sourceFiles.map(source))).join("\n");
  for (const stale of [
    /managedAutoDeliver/,
    /deliverManagedTaskInput/,
    /ForDeliver\b/,
    /listBlockingForDeliver/,
    /assertNoDeliverableDraftBeforeManagedSessionResume/,
    /handleManagedNonDeliveredOutcome/,
    /seal_before_deliver/,
    /stop_after_deliver/,
    /outcome\s*===\s*["']needs-input["']/,
  ]) {
    assert.doesNotMatch(sourceText, stale);
  }

  const testFiles = await filesUnder("test");
  for (const retiredName of [
    /delivery/i,
    /profile/i,
    /last-return/i,
    /parent-actor/i,
    /(?:^|-)b[256](?:-|\.)/i,
  ]) {
    assert.equal(
      testFiles.some((file) => retiredName.test(path.basename(file))),
      false,
      `retired test filename remains: ${retiredName}`,
    );
  }
});

test("V0.2 package metadata and Protocol-8 rejection fixture stay exact", async () => {
  const [pkg, manifest, service, releaseContract, attachProtocol] = await Promise.all([
    source("package.json").then(JSON.parse),
    source("manifest.json").then(JSON.parse),
    source("src/service/service.ts"),
    source("test/release-generated-contract.test.ts"),
    source("test/acp-child-isolation-protocol.test.ts"),
  ]);
  assert.equal(pkg.version, "0.2.0");
  assert.equal(manifest.version, "0.2.0");
  assert.match(service, /SERVICE_VERSION = "0\.2\.0"/);
  assert.match(releaseContract, /TENT_SERVICE_PROTOCOL_VERSION = 9/);
  assert.match(attachProtocol, /healthy protocol 8 fails after the protocol 9 hard cut/);
});
