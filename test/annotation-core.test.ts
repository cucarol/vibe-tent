/**
 * Core Node Markdown underline annotations (.tent/annotations.json).
 * Layer: persist, validate range/quote, project relocate, no body rewrite.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import {
  ANNOTATIONS_PATH,
  isSystemNoteName,
  SYSTEM_REGISTRY_FILES,
} from "../src/core/paths.js";
import {
  AnnotationError,
  createAnnotation,
  deleteAnnotation,
  findQuoteOccurrences,
  getAnnotationRecord,
  listAnnotationRecords,
  loadAnnotations,
  projectAnnotation,
  reopenAnnotation,
  resolveAnnotation,
  validateAnnotationAnchor,
  type AnnotationRecord,
} from "../src/core/annotation.js";

async function makeSystemRoot(): Promise<{ root: string; fsa: NodeFs }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ann-core-"));
  const fsa = new NodeFs(root);
  return { root, fsa };
}

const BODY = "alpha beta gamma beta omega\n";

test("annotations.json is registered as a system file", () => {
  assert.equal(ANNOTATIONS_PATH, "annotations.json");
  assert.ok(SYSTEM_REGISTRY_FILES.has(ANNOTATIONS_PATH));
  assert.ok(isSystemNoteName(ANNOTATIONS_PATH));
});

test("validateAnnotationAnchor: empty / OOB / mismatch", () => {
  assert.throws(
    () => validateAnnotationAnchor(BODY, "", 0, 0),
    (e: unknown) => e instanceof AnnotationError && e.code === "INVALID_INPUT"
  );
  assert.throws(
    () => validateAnnotationAnchor(BODY, "alpha", -1, 5),
    (e: unknown) => e instanceof AnnotationError && e.code === "RANGE"
  );
  assert.throws(
    () => validateAnnotationAnchor(BODY, "alpha", 0, 999),
    (e: unknown) => e instanceof AnnotationError && e.code === "RANGE"
  );
  assert.throws(
    () => validateAnnotationAnchor(BODY, "ALPHA", 0, 5),
    (e: unknown) => e instanceof AnnotationError && e.code === "QUOTE_MISMATCH"
  );
  validateAnnotationAnchor(BODY, "alpha", 0, 5);
});

test("projectAnnotation: anchored / relocated / orphan reasons", () => {
  const base: AnnotationRecord = {
    id: "an-test01",
    nodeId: "cx-node01",
    quote: "beta",
    start: 6,
    end: 10,
    documentEtag: "etag1",
    body: "note",
    author: "user",
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  // Original offsets still match.
  const a = projectAnnotation(base, BODY);
  assert.equal(a.anchorState, "anchored");
  assert.equal(a.currentStart, 6);
  assert.equal(a.currentEnd, 10);

  // Body shifted: unique quote → relocated.
  const shifted = "prefix " + BODY;
  const r = projectAnnotation(base, shifted);
  assert.equal(r.anchorState, "relocated");
  assert.equal(r.currentStart, shifted.indexOf("beta"));
  assert.equal(shifted.slice(r.currentStart!, r.currentEnd!), "beta");
  // Persistent anchor unchanged on the record projection fields.
  assert.equal(r.start, 6);
  assert.equal(r.end, 10);

  // Missing quote → orphan/quote-mismatch.
  const gone = projectAnnotation(base, "no match here");
  assert.equal(gone.anchorState, "orphan");
  assert.equal(gone.orphanReason, "quote-mismatch");

  // Missing node body → orphan/missing-node.
  const missing = projectAnnotation(base, null);
  assert.equal(missing.anchorState, "orphan");
  assert.equal(missing.orphanReason, "missing-node");

  // Two equally near hits → ambiguous orphan.
  // original start=6; body with "beta" at 0 and 12 (equal dist to 6).
  const ambBody = "beta------beta";
  assert.deepEqual(findQuoteOccurrences(ambBody, "beta"), [0, 10]);
  // distances: |0-6|=6, |10-6|=4 → unique nearest is 10
  const nearest = projectAnnotation({ ...base, start: 6, end: 10 }, ambBody);
  assert.equal(nearest.anchorState, "relocated");
  assert.equal(nearest.currentStart, 10);

  // Equal distance: start=5, hits at 0 and 10 → both dist 5.
  const amb = projectAnnotation({ ...base, start: 5, end: 9 }, ambBody);
  assert.equal(amb.anchorState, "orphan");
  assert.equal(amb.orphanReason, "ambiguous");
});

test("create / list / resolve / reopen / delete persistence", async () => {
  const { fsa } = await makeSystemRoot();
  const quote = "beta";
  const start = BODY.indexOf(quote);
  const end = start + quote.length;

  const created = await createAnnotation(
    fsa,
    {
      nodeId: "cx-node01",
      quote,
      start,
      end,
      documentEtag: "abc123",
      body: "  first comment  ",
      documentBody: BODY,
    },
    {
      clock: { now: () => "2026-07-23T12:00:00.000Z" },
      rand: () => 0.1,
    }
  );
  assert.ok(created.id.startsWith("an-"));
  assert.equal(created.author, "user");
  assert.equal(created.status, "open");
  assert.equal(created.body, "first comment");
  assert.equal(created.nodeId, "cx-node01");
  assert.equal(await fsa.exists(ANNOTATIONS_PATH), true);

  const listed = await listAnnotationRecords(fsa, "cx-node01");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, created.id);

  const other = await listAnnotationRecords(fsa, "cx-other");
  assert.equal(other.length, 0);

  const resolved = await resolveAnnotation(fsa, created.id, {
    clock: { now: () => "2026-07-23T12:01:00.000Z" },
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedAt, "2026-07-23T12:01:00.000Z");

  const reopened = await reopenAnnotation(fsa, created.id, {
    clock: { now: () => "2026-07-23T12:02:00.000Z" },
  });
  assert.equal(reopened.status, "open");
  assert.equal(reopened.resolvedAt, undefined);

  const removed = await deleteAnnotation(fsa, created.id);
  assert.ok(removed);
  assert.equal(await getAnnotationRecord(fsa, created.id), null);
  assert.equal((await loadAnnotations(fsa)).annotations.length, 0);
});

test("create rejects empty body and bad range without writing", async () => {
  const { fsa } = await makeSystemRoot();
  await assert.rejects(
    () =>
      createAnnotation(fsa, {
        nodeId: "cx-n",
        quote: "alpha",
        start: 0,
        end: 5,
        documentEtag: "e",
        body: "   ",
        documentBody: BODY,
      }),
    (e: unknown) => e instanceof AnnotationError && e.code === "INVALID_INPUT"
  );
  await assert.rejects(
    () =>
      createAnnotation(fsa, {
        nodeId: "cx-n",
        quote: "nope",
        start: 0,
        end: 4,
        documentEtag: "e",
        body: "x",
        documentBody: BODY,
      }),
    (e: unknown) => e instanceof AnnotationError && e.code === "QUOTE_MISMATCH"
  );
  assert.equal(await fsa.exists(ANNOTATIONS_PATH), false);
});

test("corrupt annotations.json is backed up and reset", async () => {
  const { fsa } = await makeSystemRoot();
  await fsa.writeFile(ANNOTATIONS_PATH, "{not-json");
  const file = await loadAnnotations(fsa);
  assert.deepEqual(file.annotations, []);
  // backup sibling should exist (registry recovery convention)
  const names = await fsa.listDir(".");
  assert.ok(
    names.some((n) => n.name.startsWith("annotations.json") && n.name !== "annotations.json") ||
      names.some((n) => n.name.includes("backup") || n.name.includes("corrupt")),
    `expected backup among ${names.map((n) => n.name).join(",")}`
  );
});
