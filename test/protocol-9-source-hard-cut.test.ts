import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
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
