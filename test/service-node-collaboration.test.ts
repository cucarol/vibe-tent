/** V0.2: workspace.collaboration is the only public collaboration projection. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("hard cut: retired node.collaboration RPCs have no direct Service/client surface", async () => {
  const [handlers, client, types] = await Promise.all([
    fs.readFile(path.join(root, "src", "service", "handlers.ts"), "utf8"),
    fs.readFile(path.join(root, "src", "service", "client.ts"), "utf8"),
    fs.readFile(path.join(root, "src", "service", "types.ts"), "utf8"),
  ]);
  for (const source of [handlers, client, types]) {
    assert.doesNotMatch(source, /node\.collaboration(?:s)?/);
    assert.doesNotMatch(source, /NodeCollaboration/);
  }
  assert.match(handlers, /workspace\.collaboration/);
});
