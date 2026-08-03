import assert from "node:assert/strict";
import test from "node:test";
import { createDelivery, loadDelivery, writeDelivery } from "../src/core/delivery.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { makeTent } from "./helpers.js";

import {
  ArtifactRefError,
  artifactRefIdentity,
  normalizeArtifactRef,
  normalizeArtifactRefs,
} from "../src/core/artifact.js";

test("artifact refs canonicalize the four hard-cut kinds", () => {
  assert.deepEqual(normalizeArtifactRef({ kind: "path", target: ".\\dist\\app.js" }), {
    kind: "path",
    target: "dist/app.js",
  });
  assert.deepEqual(normalizeArtifactRef({ kind: "directory", target: "dist//assets/" }), {
    kind: "directory",
    target: "dist/assets",
  });
  assert.deepEqual(
    normalizeArtifactRef({ kind: "commit", target: "A".repeat(40), label: " build " }),
    { kind: "commit", target: "a".repeat(40), label: "build" }
  );
  assert.deepEqual(normalizeArtifactRef({ kind: "url", target: "HTTPS://EXAMPLE.COM/a" }), {
    kind: "url",
    target: "https://example.com/a",
  });
});

test("artifact refs reject retired kinds, unknown fields, and malformed targets", () => {
  const invalid: unknown[] = [
    { kind: "dir", target: "dist" },
    { kind: "other", target: "anything" },
    { kind: "path", target: "../secret" },
    { kind: "path", target: "public/../secret" },
    { kind: "path", target: "C:relative-but-drive-bound" },
    { kind: "path", target: "\\rooted-on-current-drive" },
    { kind: "path", target: "C:\\secret" },
    { kind: "directory", target: "\\\\server\\share" },
    { kind: "commit", target: "abc123" },
    { kind: "commit", target: "a".repeat(39) },
    { kind: "commit", target: "a".repeat(41) },
    { kind: "commit", target: "g".repeat(40) },
    { kind: "url", target: "file:///tmp/a" },
    { kind: "url", target: "https://user:secret@example.com/a" },
    { kind: "path", target: "dist/a", extra: true },
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeArtifactRef(value), ArtifactRefError);
  }
});

test("artifact ref arrays dedupe and sort deterministically", () => {
  const refs = normalizeArtifactRefs([
    { kind: "url", target: "https://example.com/z" },
    { kind: "path", target: "dist/b.js" },
    { kind: "path", target: "dist/a.js" },
    { kind: "path", target: "dist/a.js/" },
    { kind: "path", target: "dist/a.js" },
  ]);
  assert.deepEqual(refs, [
    { kind: "path", target: "dist/a.js" },
    { kind: "path", target: "dist/b.js" },
    { kind: "url", target: "https://example.com/z" },
  ]);
  assert.equal(artifactRefIdentity(refs[0]!), '["path","dist/a.js"]');
});

test("artifact identity is the canonical target, while conflicting labels fail loud", () => {
  const withFragment = artifactRefIdentity({
    kind: "url",
    target: "https://example.com/result#proof",
  });
  const withLabel = artifactRefIdentity({
    kind: "url",
    target: "https://example.com/result",
    label: "proof",
  });
  assert.notEqual(withFragment, withLabel);
  assert.equal(
    artifactRefIdentity({ kind: "path", target: "dist/app.js", label: "App" }),
    artifactRefIdentity({ kind: "path", target: "dist/app.js", label: "Bundle" })
  );
  assert.throws(
    () =>
      normalizeArtifactRefs([
        { kind: "path", target: "dist/app.js", label: "App" },
        { kind: "path", target: "dist/app.js", label: "Bundle" },
      ]),
    /conflicting labels/
  );
});

test("Delivery uses the strict ArtifactRef contract at create, write, and load boundaries", async () => {
  const root = await makeTent();
  const fs = new NodeFs(root);
  const clock = { now: () => "2026-08-03T00:00:00.000Z" };

  await assert.rejects(
    () =>
      createDelivery(fs, clock, {
        taskId: "tk-artifacts",
        sourceNodeId: "cx-p1",
        summary: "invalid",
        artifactRefs: [{ kind: "dir", target: "dist" } as never],
        deliveriesDir: "temp/sessions/ss-artifacts/deliveries",
      }),
    ArtifactRefError
  );

  const delivery = await createDelivery(fs, clock, {
    taskId: "tk-artifacts",
    sourceNodeId: "cx-p1",
    summary: "valid",
    artifactRefs: [{ kind: "directory", target: "dist/" }],
    deliveriesDir: "temp/sessions/ss-artifacts/deliveries",
  });
  assert.deepEqual((await loadDelivery(fs, delivery.path)).artifactRefs, [
    { kind: "directory", target: "dist" },
  ]);

  delivery.artifactRefs = [{ kind: "other", target: "opaque" } as never];
  await assert.rejects(() => writeDelivery(fs, delivery), ArtifactRefError);

  const raw = await fs.readFile(delivery.path);
  await fs.writeFile(delivery.path, raw.replace('\\"directory\\"', '\\"dir\\"'));
  await assert.rejects(() => loadDelivery(fs, delivery.path), /Invalid delivery artifact refs/);
});
