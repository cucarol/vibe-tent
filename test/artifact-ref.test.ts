import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskResultRecord,
  createTaskResult,
  loadTaskResult,
  loadTaskResults,
  writeTaskResult,
} from "../src/core/task-result.js";
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

test("TaskResult uses the strict ArtifactRef contract at create, write, and load boundaries", async () => {
  const root = await makeTent();
  const fs = new NodeFs(root);
  const clock = { now: () => "2026-08-03T00:00:00.000Z" };

  await assert.rejects(
    () =>
      createTaskResult(fs, clock, {
        taskId: "tk-artifacts",
        report: "invalid",
        artifactRefs: [{ kind: "dir", target: "dist" } as never],
        resultsDir: "temp/sessions/ss-artifacts/results",
      }),
    ArtifactRefError
  );

  const result = await createTaskResult(fs, clock, {
    taskId: "tk-artifacts",
    report: "valid",
    artifactRefs: [{ kind: "directory", target: "dist/" }],
    resultsDir: "temp/sessions/ss-artifacts/results",
  });
  assert.deepEqual((await loadTaskResult(fs, result.path)).artifactRefs, [
    { kind: "directory", target: "dist" },
  ]);

  result.artifactRefs = [{ kind: "other", target: "opaque" } as never];
  await assert.rejects(() => writeTaskResult(fs, result), ArtifactRefError);

  const raw = await fs.readFile(result.path);
  await fs.writeFile(result.path, raw.replace('\\"directory\\"', '\\"dir\\"'));
  await assert.rejects(() => loadTaskResult(fs, result.path), /Invalid Task Result artifact refs/);
});

test("TaskResult immutable payload and review projection fail loud on malformed records", async () => {
  const root = await makeTent();
  const fs = new NodeFs(root);
  const clock = { now: () => "2026-08-13T00:00:00.000Z" };
  const resultsDir = "temp/sessions/ss-resultstrict/results";

  assert.throws(
    () => buildTaskResultRecord(clock, {
      id: "rs-BAD",
      taskId: "tk-resultstrict",
      report: "x",
      resultsDir,
    }),
    /id must be canonical/
  );
  assert.throws(
    () => buildTaskResultRecord(clock, {
      taskId: "tk-result-strict",
      report: "x",
      resultsDir,
    }),
    /taskId must be canonical/
  );
  assert.throws(
    () => buildTaskResultRecord({ now: () => "not-a-time" }, {
      taskId: "tk-resultstrict",
      report: "x",
      resultsDir,
    }),
    /createdAt/
  );

  const record = await createTaskResult(fs, clock, {
    id: "rs-resultstrict",
    taskId: "tk-resultstrict",
    report: "audit fact",
    checks: [{ name: "typecheck", command: "npm run typecheck", exitCode: 0 }],
    resultsDir,
  });
  const sha256Record = buildTaskResultRecord(clock, {
    id: "rs-resultsha256",
    taskId: "tk-resultstrict",
    report: "sha256 audit fact",
    commits: ["a".repeat(64)],
    targetHead: "b".repeat(64),
    resultsDir,
  });
  assert.deepEqual(sha256Record.commits, ["a".repeat(64)]);
  assert.throws(
    () => buildTaskResultRecord(clock, {
      id: "rs-resultmissinghead",
      taskId: "tk-resultstrict",
      report: "missing target",
      commits: ["a".repeat(40)],
      resultsDir,
    }),
    /requires a canonical targetHead/
  );
  assert.throws(
    () => buildTaskResultRecord(clock, {
      id: "rs-resultbadhead",
      taskId: "tk-resultstrict",
      report: "bad target",
      commits: ["a".repeat(40)],
      targetHead: "short",
      resultsDir,
    }),
    /targetHead must be a canonical/
  );
  assert.throws(
    () => buildTaskResultRecord(clock, {
      id: "rs-resultzerohead",
      taskId: "tk-resultstrict",
      report: "zero target",
      targetHead: "b".repeat(40),
      resultsDir,
    }),
    /Zero-commit Task Result cannot carry targetHead/
  );
  const canonical = await fs.readFile(record.path);
  const malformed = [
    canonical.replace(/(\n---\n)[\s\S]*$/, "$1"),
    canonical.replace('createdAt: "2026-08-13T00:00:00.000Z"', "createdAt: not-a-time"),
    canonical.replace("status: ready", "status: accepted"),
    canonical.replace(
      "status: ready",
      "status: ready\nreviewer: user\nreviewAt: 2026-08-13T00:00:00.000Z"
    ),
    canonical.replace(/checksJson: .*\n/, "checksJson: not-json\n"),
    canonical.replace(
      /checksJson: .*\n/,
      'checksJson: "[{\\"name\\":\\"typecheck\\",\\"command\\":3,\\"exitCode\\":0}]"\n'
    ),
  ];
  for (const [index, raw] of malformed.entries()) {
    await fs.writeFile(record.path, raw);
    await assert.rejects(() => loadTaskResult(fs, record.path), `malformed record ${index}`);
    await assert.rejects(() => loadTaskResults(fs), `malformed inventory record ${index}`);
  }

  await fs.writeFile(
    record.path,
    canonical
      .replace("status: ready", "status: accepted")
      .replace(
        'createdAt: "2026-08-13T00:00:00.000Z"',
        'reviewer: user\nreviewAt: not-a-time\ncreatedAt: "2026-08-13T00:00:00.000Z"'
      )
  );
  await assert.rejects(() => loadTaskResult(fs, record.path), /reviewAt/);

  await fs.writeFile(record.path, canonical);
  const loaded = await loadTaskResult(fs, record.path);
  loaded.status = "accepted";
  await assert.rejects(() => writeTaskResult(fs, loaded), /requires a reviewer/);

  const commitResult = await createTaskResult(fs, clock, {
    id: "rs-resultheadread",
    taskId: "tk-resultstrict",
    report: "commit target",
    commits: ["a".repeat(40)],
    targetHead: "b".repeat(40),
    resultsDir,
  });
  const commitRaw = await fs.readFile(commitResult.path);
  await fs.writeFile(commitResult.path, commitRaw.replace(/targetHead:.*\n/, ""));
  await assert.rejects(() => loadTaskResult(fs, commitResult.path), /requires a canonical targetHead/);
  await fs.writeFile(
    commitResult.path,
    commitRaw.replace(`targetHead: ${"b".repeat(40)}`, "targetHead: malformed")
  );
  await assert.rejects(() => loadTaskResult(fs, commitResult.path), /targetHead must be a canonical/);
  await fs.writeFile(
    record.path,
    canonical.replace("status: ready", `status: ready\ntargetHead: ${"b".repeat(40)}`)
  );
  await assert.rejects(() => loadTaskResult(fs, record.path), /Zero-commit Task Result cannot carry/);
});
