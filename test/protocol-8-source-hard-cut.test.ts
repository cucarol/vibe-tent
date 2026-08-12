import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

test("source and release-facing documentation hard-cut the next runtime to protocol 8", async () => {
  const [protocol, rendererBridge, architecture, cliService, packagedE2e] =
    await Promise.all([
      source("src/service/protocol.ts"),
      source("src/desktop/renderer-next/gateway/desktop-bridge.ts"),
      source("docs/desktop/architecture.md"),
      source("docs/desktop/cli-service.md"),
      source("scripts/test-renderer-next-canvas-e2e.mjs"),
    ]);

  assert.match(protocol, /TENT_SERVICE_PROTOCOL_VERSION = 8 as const/);
  assert.doesNotMatch(protocol, /TENT_SERVICE_PROTOCOL_VERSION = 7 as const/);
  assert.match(rendererBridge, /health\.protocolVersion !== 8/);
  assert.match(rendererBridge, /protocolVersion: 8/);
  assert.doesNotMatch(rendererBridge, /protocolVersion !== 7/);
  assert.match(architecture, /protocolVersion=8/);
  assert.match(cliService, /protocolVersion=8/);
  assert.doesNotMatch(`${architecture}\n${cliService}`, /protocolVersion=7/);
  assert.match(packagedE2e, /assert\.equal\(health\.protocolVersion, 8\)/);
  assert.match(packagedE2e, /assert\.equal\(recoveredHealth\.protocolVersion, 8\)/);
});
