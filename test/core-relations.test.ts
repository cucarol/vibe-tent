/**
 * Core first-class semantic relations + frontmatter object-array round-trip.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import {
  assertRawRelationsCanonicalForMutation,
  createRelation,
  deleteRelation,
  isRelationId,
  listRelationsForNode,
  normalizeRelationsList,
  parseRelationRecord,
  RelationError,
  updateRelation,
} from "../src/core/relations.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { boxNotePath, loadTent } from "../src/core/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";

async function makeSystemRoot(): Promise<{ workspace: string; systemFs: NodeFs }> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-core-rel-ws-"));
  const workspaceFs = new NodeFs(workspace);
  await scaffoldInWorkspace(workspaceFs, {
    name: "rel-core",
    rules: "# RULES\n\ncore relations\n",
    boxes: [
      { name: "Alpha", type: "prompt", body: "# Alpha\n" },
      { name: "Beta", type: "prompt", body: "# Beta\n" },
    ],
  });
  return { workspace, systemFs: new NodeFs(path.join(workspace, ".tent")) };
}

test("frontmatter: object-array relations round-trip (block sequence of flow maps)", () => {
  const raw = `---
id: cx-aaaaaa
type: prompt
relations:
  - {id: rl-11111111, kind: related, direction: directed, nodeId: cx-bbbbbb}
  - {id: rl-22222222, kind: blocks, direction: bidirectional, label: maybe, unresolved: Ghost}
---
# Body
`;
  const parsed = parseFrontmatter(raw);
  assert.ok(Array.isArray(parsed.data.relations));
  const relations = parsed.data.relations as Record<string, unknown>[];
  assert.equal(relations.length, 2);
  assert.equal(relations[0]!.id, "rl-11111111");
  assert.equal(relations[0]!.nodeId, "cx-bbbbbb");
  assert.equal(relations[1]!.unresolved, "Ghost");
  assert.equal(relations[1]!.label, "maybe");

  const out = serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
  const reparsed = parseFrontmatter(out);
  assert.deepEqual(reparsed.data.relations, parsed.data.relations);

  const multiLine = `---
id: cx-aaaaaa
type: prompt
relations:
  - id: rl-33333333
    kind: depends-on
    direction: directed
    nodeId: cx-bbbbbb
---
`;
  const ml = parseFrontmatter(multiLine);
  const mlRels = ml.data.relations as Record<string, unknown>[];
  assert.equal(mlRels.length, 1);
  assert.equal(mlRels[0]!.id, "rl-33333333");
  assert.equal(mlRels[0]!.kind, "depends-on");
  assert.equal(mlRels[0]!.nodeId, "cx-bbbbbb");
});

test("parseRelationRecord: accepts nested target or flat nodeId/unresolved; skips corrupt", () => {
  const okFlat = parseRelationRecord({
    id: "rl-abcdef01",
    kind: "related",
    direction: "directed",
    nodeId: "cx-target1",
  });
  assert.ok(okFlat);
  assert.ok("nodeId" in okFlat!.target);
  assert.equal(
    "nodeId" in okFlat!.target ? okFlat!.target.nodeId : null,
    "cx-target1"
  );

  const okNested = parseRelationRecord({
    id: "rl-abcdef02",
    kind: "related",
    direction: "bidirectional",
    target: { unresolved: "Future" },
  });
  assert.ok(okNested);
  assert.ok("unresolved" in okNested!.target);
  assert.equal(
    "unresolved" in okNested!.target ? okNested!.target.unresolved : null,
    "Future"
  );

  assert.equal(parseRelationRecord({ id: "bad", kind: "x", direction: "directed" }), null);
  assert.equal(
    parseRelationRecord({
      id: "rl-abcdef03",
      kind: "x",
      direction: "directed",
      nodeId: "cx-a",
      unresolved: "both",
    }),
    null
  );

  const list = normalizeRelationsList([
    okFlat,
    { id: "not-a-relation", kind: "x", direction: "directed", nodeId: "cx-a" },
    okFlat, // duplicate id dropped
  ]);
  assert.equal(list.length, 1);
});

test("create/list/update/delete relations; stable rl- ids; incoming projection", async () => {
  const { systemFs } = await makeSystemRoot();
  let tent = await loadTent(systemFs);
  const alpha = [...tent.byId.values()].find((b) => b.name === "Alpha");
  const beta = [...tent.byId.values()].find((b) => b.name === "Beta");
  assert.ok(alpha && beta);

  const created = await createRelation(systemFs, alpha!.id, {
    kind: "depends-on",
    direction: "directed",
    label: "needs",
    target: { nodeId: beta!.id },
  });
  assert.ok(isRelationId(created.id));
  assert.equal(created.kind, "depends-on");
  assert.equal(created.label, "needs");
  assert.deepEqual(created.target, { nodeId: beta!.id });

  tent = await loadTent(systemFs);
  const fromDisk = tent.byId.get(alpha!.id)!;
  assert.equal(fromDisk.relations.length, 1);
  assert.equal(fromDisk.relations[0]!.id, created.id);

  const listedOnBeta = listRelationsForNode(tent, beta!.id);
  assert.equal(listedOnBeta.outgoing.length, 0);
  assert.equal(listedOnBeta.incoming.length, 1);
  assert.equal(listedOnBeta.incoming[0]!.sourceId, alpha!.id);
  assert.equal(listedOnBeta.incoming[0]!.id, created.id);

  const updated = await updateRelation(systemFs, alpha!.id, created.id, {
    kind: "blocks",
    label: null,
    target: { unresolved: "LaterNote" },
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.kind, "blocks");
  assert.equal(updated.label, undefined);
  assert.deepEqual(updated.target, { unresolved: "LaterNote" });

  tent = await loadTent(systemFs);
  assert.equal(listRelationsForNode(tent, beta!.id).incoming.length, 0);

  const deleted = await deleteRelation(systemFs, alpha!.id, created.id);
  assert.equal(deleted.deleted, created.id);
  tent = await loadTent(systemFs);
  assert.equal(tent.byId.get(alpha!.id)!.relations.length, 0);

  // Missing id fails loud
  await assert.rejects(
    () => deleteRelation(systemFs, alpha!.id, created.id),
    /Relation not found/
  );
});

test("createRelation rejects missing/unusable resolved targets and empty unresolved", async () => {
  const { systemFs } = await makeSystemRoot();
  const tent = await loadTent(systemFs);
  const alpha = [...tent.byId.values()].find((b) => b.name === "Alpha")!;

  await assert.rejects(
    () =>
      createRelation(systemFs, alpha.id, {
        kind: "related",
        direction: "directed",
        target: { nodeId: "cx-missing" },
      }),
    /not found/i
  );

  await assert.rejects(
    () =>
      createRelation(systemFs, alpha.id, {
        kind: "related",
        direction: "directed",
        target: { unresolved: "  " },
      }),
    /unresolved/i
  );

  // unresolved non-empty is allowed without a live target
  const open = await createRelation(systemFs, alpha.id, {
    kind: "related",
    direction: "bidirectional",
    target: { unresolved: "Someday" },
  });
  assert.deepEqual(open.target, { unresolved: "Someday" });
});

test("loadTent loads relations; body wiki links stay out of relations array", async () => {
  const { systemFs } = await makeSystemRoot();
  const tent0 = await loadTent(systemFs);
  const alpha = [...tent0.byId.values()].find((b) => b.name === "Alpha")!;
  const beta = [...tent0.byId.values()].find((b) => b.name === "Beta")!;

  await createRelation(systemFs, alpha.id, {
    kind: "related",
    direction: "directed",
    target: { nodeId: beta.id },
  });

  // Body wiki link is independent
  const notePath = boxNotePath(alpha.path);
  const raw = await systemFs.readFile(notePath);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  await systemFs.writeFile(
    notePath,
    serializeFrontmatter(data, `${body}\n[[Beta]]\n`, keyOrder)
  );

  const tent = await loadTent(systemFs);
  const loaded = tent.byId.get(alpha.id)!;
  assert.equal(loaded.relations.length, 1);
  assert.ok(loaded.body.includes("[[Beta]]"));
  // relations array still only the explicit semantic record
  assert.equal(loaded.relations[0]!.kind, "related");
});

test("read projection tolerates corrupt rows; mutation refuses and leaves disk unchanged", async () => {
  const { systemFs } = await makeSystemRoot();
  const tent0 = await loadTent(systemFs);
  const alpha = [...tent0.byId.values()].find((b) => b.name === "Alpha")!;
  const beta = [...tent0.byId.values()].find((b) => b.name === "Beta")!;

  const good = await createRelation(systemFs, alpha.id, {
    kind: "related",
    direction: "directed",
    target: { nodeId: beta.id },
  });

  const notePath = boxNotePath(alpha.path);
  const beforeRaw = await systemFs.readFile(notePath);
  const { data, body, keyOrder } = parseFrontmatter(beforeRaw);
  // Plant: (1) future-format extra field (2) truly corrupt id — both must block mutation.
  data.relations = [
    ...(Array.isArray(data.relations) ? (data.relations as unknown[]) : []),
    {
      id: "rl-future01",
      kind: "related",
      direction: "directed",
      nodeId: beta.id,
      schemaVersion: 99,
    },
    {
      id: "not-a-relation-id",
      kind: "related",
      direction: "directed",
      nodeId: beta.id,
    },
  ];
  const planted = serializeFrontmatter(data, body, keyOrder);
  await systemFs.writeFile(notePath, planted);

  // Read projection is migration-tolerant: drops non-parseable; may still project
  // future-format rows that have a valid canonical core (extra keys stripped in memory).
  const tent = await loadTent(systemFs);
  const projected = tent.byId.get(alpha.id)!.relations;
  assert.ok(projected.some((r) => r.id === good.id));
  assert.equal(
    projected.some((r) => r.id === "not-a-relation-id"),
    false,
    "corrupt id dropped on read"
  );
  // future-format core still projects (schemaVersion not part of RelationRecord)
  assert.ok(projected.some((r) => r.id === "rl-future01"));

  // Mutation gate fails loud on either unrecognized fields or non-canonical rows.
  assert.throws(
    () =>
      assertRawRelationsCanonicalForMutation([
        { id: good.id, kind: "related", direction: "directed", nodeId: beta.id },
        {
          id: "rl-future01",
          kind: "related",
          direction: "directed",
          nodeId: beta.id,
          schemaVersion: 99,
        },
      ]),
    (err: unknown) => err instanceof RelationError && err.code === "CORRUPT"
  );
  assert.throws(
    () =>
      assertRawRelationsCanonicalForMutation([
        { id: good.id, kind: "related", direction: "directed", nodeId: beta.id },
        {
          id: "not-a-relation-id",
          kind: "related",
          direction: "directed",
          nodeId: beta.id,
        },
      ]),
    (err: unknown) => err instanceof RelationError && err.code === "CORRUPT"
  );

  await assert.rejects(
    () =>
      createRelation(systemFs, alpha.id, {
        kind: "other",
        direction: "directed",
        target: { unresolved: "x" },
      }),
    (err: unknown) => err instanceof RelationError && err.code === "CORRUPT"
  );
  await assert.rejects(
    () =>
      updateRelation(systemFs, alpha.id, good.id, {
        kind: "blocks",
      }),
    (err: unknown) => err instanceof RelationError && err.code === "CORRUPT"
  );
  await assert.rejects(
    () => deleteRelation(systemFs, alpha.id, good.id),
    (err: unknown) => err instanceof RelationError && err.code === "CORRUPT"
  );

  // Disk bytes unchanged after failed mutations.
  const afterRaw = await systemFs.readFile(notePath);
  assert.equal(afterRaw, planted);

  // Duplicate ids also refuse mutation.
  assert.throws(
    () =>
      assertRawRelationsCanonicalForMutation([
        { id: "rl-dup00001", kind: "a", direction: "directed", nodeId: "cx-a" },
        { id: "rl-dup00001", kind: "b", direction: "directed", nodeId: "cx-b" },
      ]),
    /duplicate id/i
  );
});
