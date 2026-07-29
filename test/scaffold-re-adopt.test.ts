/**
 * Focused Core tests for one-shot orphan `.tent/` re-adopt (cx-b9bf58 / tk-xwmtvh1v).
 * Uses only synthetic generic fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import type { FsAdapter } from "../src/core/adapter.js";
import {
  ensureWorkspaceGitignore,
  isValidTentIndexMarker,
  reAdoptOrphanTent,
  scaffoldInWorkspace,
  tentIndexMarker,
} from "../src/core/scaffold.js";
import {
  ATTACHMENTS_DIR,
  INDEX_PATH,
  TEMP_DIR,
  TENT_SYSTEM_DIR,
} from "../src/core/paths.js";
import { TYPE_REGISTRY_PATH, DEFAULT_TYPE_REGISTRY } from "../src/core/typeRegistry.js";
import { ROLES_REGISTRY_PATH } from "../src/core/skillRoleRegistry.js";
import { TAGS_REGISTRY_PATH, DEFAULT_TAG_REGISTRY } from "../src/core/tags.js";

const ORPHAN_NODE_PATH = path.join("topic", "topic.md");
const ORPHAN_NODE_BYTES =
  "---\nid: cx-orphan1\ntype: prompt\n---\n# Orphan topic\npreserved body bytes\n";
const CUSTOM_TYPES_BYTES =
  JSON.stringify({ goal: { tier: "base" }, prompt: { tier: "base" }, custom: { tier: "modifier" } }, null, 2) +
  "\n";
const CUSTOM_ROLES_BYTES =
  JSON.stringify(
    {
      roles: [
        {
          id: "rl-keepme",
          name: "keeper",
          displayName: "Keeper",
          prompt: "do not rewrite",
        },
      ],
    },
    null,
    2
  ) + "\n";
const CUSTOM_TAGS_BYTES = JSON.stringify({ tags: ["keep-tag"] }, null, 2) + "\n";
const TEMP_HISTORY_BYTES = "temp history must survive\n";

async function mkWorkspace(): Promise<{ workspace: string; fsa: NodeFs }> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-readopt-"));
  return { workspace, fsa: new NodeFs(workspace) };
}

/** Synthetic orphan Tent: `.tent/` present, no index, durable Node + partial registries. */
async function writeOrphanTentFixture(
  workspace: string,
  options: {
    withNode?: boolean;
    withTypes?: boolean;
    withRoles?: boolean;
    withTags?: boolean;
    withTempHistory?: boolean;
    withAttachmentsDir?: boolean;
    indexContent?: string | null;
    extraRootFile?: { name: string; body: string };
  } = {}
): Promise<Record<string, string>> {
  const {
    withNode = true,
    withTypes = true,
    withRoles = true,
    withTags = false,
    withTempHistory = true,
    withAttachmentsDir = false,
    indexContent = null,
    extraRootFile,
  } = options;

  const system = path.join(workspace, TENT_SYSTEM_DIR);
  await fs.mkdir(system, { recursive: true });

  const snap: Record<string, string> = {};

  if (withNode) {
    const abs = path.join(system, ORPHAN_NODE_PATH);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, ORPHAN_NODE_BYTES, "utf8");
    snap[`.tent/${ORPHAN_NODE_PATH.replace(/\\/g, "/")}`] = ORPHAN_NODE_BYTES;
  }
  if (withTypes) {
    const abs = path.join(system, TYPE_REGISTRY_PATH);
    await fs.writeFile(abs, CUSTOM_TYPES_BYTES, "utf8");
    snap[`.tent/${TYPE_REGISTRY_PATH}`] = CUSTOM_TYPES_BYTES;
  }
  if (withRoles) {
    const abs = path.join(system, ROLES_REGISTRY_PATH);
    await fs.writeFile(abs, CUSTOM_ROLES_BYTES, "utf8");
    snap[`.tent/${ROLES_REGISTRY_PATH}`] = CUSTOM_ROLES_BYTES;
  }
  if (withTags) {
    const abs = path.join(system, TAGS_REGISTRY_PATH);
    await fs.writeFile(abs, CUSTOM_TAGS_BYTES, "utf8");
    snap[`.tent/${TAGS_REGISTRY_PATH}`] = CUSTOM_TAGS_BYTES;
  }
  if (withTempHistory) {
    const abs = path.join(system, TEMP_DIR, "history.txt");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, TEMP_HISTORY_BYTES, "utf8");
    snap[`.tent/${TEMP_DIR}/history.txt`] = TEMP_HISTORY_BYTES;
  }
  if (withAttachmentsDir) {
    await fs.mkdir(path.join(system, ATTACHMENTS_DIR), { recursive: true });
  }
  if (indexContent !== null) {
    const abs = path.join(system, INDEX_PATH);
    await fs.writeFile(abs, indexContent, "utf8");
    snap[`.tent/${INDEX_PATH}`] = indexContent;
  }
  if (extraRootFile) {
    const abs = path.join(system, extraRootFile.name);
    await fs.writeFile(abs, extraRootFile.body, "utf8");
    snap[`.tent/${extraRootFile.name}`] = extraRootFile.body;
  }

  return snap;
}

async function snapshotExistingFiles(
  workspace: string,
  relativePaths: string[]
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of relativePaths) {
    const abs = path.join(workspace, ...rel.split("/"));
    out[rel] = await fs.readFile(abs, "utf8");
  }
  return out;
}

async function assertBytesUnchanged(
  workspace: string,
  before: Record<string, string>
): Promise<void> {
  for (const [rel, expected] of Object.entries(before)) {
    const abs = path.join(workspace, ...rel.split("/"));
    const after = await fs.readFile(abs, "utf8");
    assert.equal(after, expected, `bytes must be preserved for ${rel}`);
  }
}

/** Wrap workspace FsAdapter to record write/mkdir/remove/move after a gate flips. */
class WriteProbeFs implements FsAdapter {
  writes = 0;
  mkdirs = 0;
  removes = 0;
  moves = 0;
  private armed = false;

  constructor(private readonly inner: FsAdapter) {}

  arm(): void {
    this.armed = true;
  }

  get mutationCount(): number {
    return this.writes + this.mkdirs + this.removes + this.moves;
  }

  listDir(dir: string) {
    return this.inner.listDir(dir);
  }
  readFile(p: string) {
    return this.inner.readFile(p);
  }
  async writeFile(p: string, content: string) {
    if (this.armed) this.writes += 1;
    return this.inner.writeFile(p, content);
  }
  readBinary(p: string) {
    return this.inner.readBinary(p);
  }
  async writeBinary(p: string, data: Uint8Array) {
    if (this.armed) this.writes += 1;
    return this.inner.writeBinary(p, data);
  }
  exists(p: string) {
    return this.inner.exists(p);
  }
  async mkdir(p: string) {
    if (this.armed) this.mkdirs += 1;
    return this.inner.mkdir(p);
  }
  async move(from: string, to: string) {
    if (this.armed) this.moves += 1;
    return this.inner.move(from, to);
  }
  async remove(p: string) {
    if (this.armed) this.removes += 1;
    return this.inner.remove(p);
  }
}

test("reAdoptOrphanTent: success preserves existing Node/registry/temp bytes and fills gaps", async () => {
  const { workspace, fsa } = await mkWorkspace();
  const before = await writeOrphanTentFixture(workspace, {
    withNode: true,
    withTypes: true,
    withRoles: true,
    withTags: false,
    withTempHistory: true,
    withAttachmentsDir: false,
  });
  // Pre-existing .gitignore without .tent/ entry.
  await fs.writeFile(path.join(workspace, ".gitignore"), "node_modules/\n", "utf8");
  before[".gitignore"] = "node_modules/\n";

  const result = await reAdoptOrphanTent(fsa);

  assert.equal(result.systemRootRelative, TENT_SYSTEM_DIR);
  assert.equal(result.createdIndex, true);
  assert.deepEqual(result.createdDirs.sort(), [ATTACHMENTS_DIR].sort());
  assert.deepEqual(result.createdRegistries, [TAGS_REGISTRY_PATH]);
  assert.equal(result.gitignoreUpdated, true);

  await assertBytesUnchanged(workspace, {
    [`.tent/${ORPHAN_NODE_PATH.replace(/\\/g, "/")}`]: ORPHAN_NODE_BYTES,
    [`.tent/${TYPE_REGISTRY_PATH}`]: CUSTOM_TYPES_BYTES,
    [`.tent/${ROLES_REGISTRY_PATH}`]: CUSTOM_ROLES_BYTES,
    [`.tent/${TEMP_DIR}/history.txt`]: TEMP_HISTORY_BYTES,
  });

  const indexRaw = await fsa.readFile(`${TENT_SYSTEM_DIR}/${INDEX_PATH}`);
  assert.equal(indexRaw, tentIndexMarker());
  assert.equal(isValidTentIndexMarker(indexRaw), true);

  assert.equal(await fsa.exists(`${TENT_SYSTEM_DIR}/${TEMP_DIR}`), true);
  assert.equal(await fsa.exists(`${TENT_SYSTEM_DIR}/${ATTACHMENTS_DIR}`), true);

  const tags = await fsa.readFile(`${TENT_SYSTEM_DIR}/${TAGS_REGISTRY_PATH}`);
  assert.equal(tags, JSON.stringify(DEFAULT_TAG_REGISTRY, null, 2) + "\n");

  const gitignore = await fsa.readFile(".gitignore");
  assert.match(gitignore, /node_modules\//);
  assert.match(gitignore, /\.tent\//);
  // Original prefix preserved (append only).
  assert.ok(gitignore.startsWith("node_modules/\n"));
});

test("reAdoptOrphanTent: evidence via registry alone (no Node) still succeeds", async () => {
  const { workspace, fsa } = await mkWorkspace();
  await writeOrphanTentFixture(workspace, {
    withNode: false,
    withTypes: true,
    withRoles: false,
    withTags: false,
    withTempHistory: false,
  });

  const beforeTypes = await fs.readFile(
    path.join(workspace, TENT_SYSTEM_DIR, TYPE_REGISTRY_PATH),
    "utf8"
  );

  const result = await reAdoptOrphanTent(fsa);
  assert.equal(result.createdIndex, true);
  assert.ok(result.createdRegistries.includes(ROLES_REGISTRY_PATH));
  assert.ok(result.createdRegistries.includes(TAGS_REGISTRY_PATH));
  assert.ok(result.createdDirs.includes(TEMP_DIR));
  assert.ok(result.createdDirs.includes(ATTACHMENTS_DIR));

  const afterTypes = await fs.readFile(
    path.join(workspace, TENT_SYSTEM_DIR, TYPE_REGISTRY_PATH),
    "utf8"
  );
  assert.equal(afterTypes, beforeTypes);

  assert.equal(
    await fsa.readFile(`${TENT_SYSTEM_DIR}/${TYPE_REGISTRY_PATH}`),
    CUSTOM_TYPES_BYTES
  );
  assert.equal(
    await fsa.readFile(`${TENT_SYSTEM_DIR}/${ROLES_REGISTRY_PATH}`),
    JSON.stringify({ roles: [] }, null, 2) + "\n"
  );
});

test("reAdoptOrphanTent: evidence via durable cx- Node alone (no registry) still succeeds", async () => {
  const { workspace, fsa } = await mkWorkspace();
  await writeOrphanTentFixture(workspace, {
    withNode: true,
    withTypes: false,
    withRoles: false,
    withTags: false,
    withTempHistory: false,
  });

  const beforeNode = await fs.readFile(
    path.join(workspace, TENT_SYSTEM_DIR, ORPHAN_NODE_PATH),
    "utf8"
  );

  const result = await reAdoptOrphanTent(fsa);
  assert.equal(result.createdIndex, true);
  assert.deepEqual(
    result.createdRegistries.sort(),
    [TYPE_REGISTRY_PATH, ROLES_REGISTRY_PATH, TAGS_REGISTRY_PATH].sort()
  );

  assert.equal(
    await fs.readFile(path.join(workspace, TENT_SYSTEM_DIR, ORPHAN_NODE_PATH), "utf8"),
    beforeNode
  );
  assert.equal(
    await fsa.readFile(`${TENT_SYSTEM_DIR}/${TYPE_REGISTRY_PATH}`),
    JSON.stringify(DEFAULT_TYPE_REGISTRY, null, 2) + "\n"
  );
});

test("reAdoptOrphanTent: fail-closed empty/unrecognized .tent with zero writes", async () => {
  const { workspace, fsa } = await mkWorkspace();
  await fs.mkdir(path.join(workspace, TENT_SYSTEM_DIR), { recursive: true });
  // Unrecognized junk only — no registry, no cx- node.
  await fs.writeFile(
    path.join(workspace, TENT_SYSTEM_DIR, "notes.txt"),
    "not tent evidence\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(workspace, TENT_SYSTEM_DIR, "random.md"),
    "---\ntitle: hello\n---\nno cx id\n",
    "utf8"
  );

  const probe = new WriteProbeFs(fsa);
  probe.arm();
  await assert.rejects(
    () => reAdoptOrphanTent(probe),
    /no recognized Tent evidence/
  );
  assert.equal(probe.mutationCount, 0, "precondition failure must not write");

  assert.equal(await fsa.exists(`${TENT_SYSTEM_DIR}/${INDEX_PATH}`), false);
  assert.equal(await fsa.exists(`${TENT_SYSTEM_DIR}/${TYPE_REGISTRY_PATH}`), false);
  assert.equal(await fsa.exists(".gitignore"), false);
});

test("reAdoptOrphanTent: cx- ids only under temp/attachments/nested .tent are not evidence (zero writes)", async () => {
  const { workspace, fsa } = await mkWorkspace();
  const system = path.join(workspace, TENT_SYSTEM_DIR);
  await fs.mkdir(system, { recursive: true });

  const spoof =
    "---\nid: cx-tempfake\ntype: task\n---\n# Historical task envelope — not a Node\n";

  // Operational history that must never count as durable Node evidence.
  const tempTask = path.join(system, TEMP_DIR, "history", "task-old.md");
  await fs.mkdir(path.dirname(tempTask), { recursive: true });
  await fs.writeFile(tempTask, spoof, "utf8");

  const attachNote = path.join(system, ATTACHMENTS_DIR, "cx-attach.md");
  await fs.mkdir(path.dirname(attachNote), { recursive: true });
  await fs.writeFile(attachNote, spoof, "utf8");

  const nestedTent = path.join(system, TENT_SYSTEM_DIR, "topic", "topic.md");
  await fs.mkdir(path.dirname(nestedTent), { recursive: true });
  await fs.writeFile(nestedTent, spoof, "utf8");

  // Non-evidence root junk so the tree is non-empty.
  await fs.writeFile(path.join(system, "notes.txt"), "noise\n", "utf8");

  const before = await snapshotExistingFiles(workspace, [
    `.tent/${TEMP_DIR}/history/task-old.md`,
    `.tent/${ATTACHMENTS_DIR}/cx-attach.md`,
    `.tent/${TENT_SYSTEM_DIR}/topic/topic.md`,
    ".tent/notes.txt",
  ]);

  const probe = new WriteProbeFs(fsa);
  probe.arm();
  await assert.rejects(
    () => reAdoptOrphanTent(probe),
    /no recognized Tent evidence/
  );
  assert.equal(probe.mutationCount, 0, "operational-only cx- must not re-adopt");
  await assertBytesUnchanged(workspace, before);
  assert.equal(await fsa.exists(`${TENT_SYSTEM_DIR}/${INDEX_PATH}`), false);
});

test("reAdoptOrphanTent: real content folders still count as Node evidence", async () => {
  const { workspace, fsa } = await mkWorkspace();
  const system = path.join(workspace, TENT_SYSTEM_DIR);
  // Arbitrary nested real content (not operational top-level).
  const deep = path.join(system, "area", "sub", "leaf", "leaf.md");
  await fs.mkdir(path.dirname(deep), { recursive: true });
  const body = "---\nid: cx-deep01\ntype: prompt\n---\n# Deep real node\n";
  await fs.writeFile(deep, body, "utf8");
  // Also plant operational spoof that must be ignored when real evidence exists.
  const spoofPath = path.join(system, TEMP_DIR, "spoof.md");
  await fs.mkdir(path.dirname(spoofPath), { recursive: true });
  await fs.writeFile(
    spoofPath,
    "---\nid: cx-spoof1\ntype: task\n---\nspoof\n",
    "utf8"
  );

  const result = await reAdoptOrphanTent(fsa);
  assert.equal(result.createdIndex, true);
  assert.equal(
    await fs.readFile(deep, "utf8"),
    body,
    "deep real Node bytes preserved"
  );
  assert.equal(
    await fs.readFile(spoofPath, "utf8"),
    "---\nid: cx-spoof1\ntype: task\n---\nspoof\n"
  );
});

test("reAdoptOrphanTent: fail-closed when already a valid Tent (zero writes)", async () => {
  const { workspace, fsa } = await mkWorkspace();
  await scaffoldInWorkspace(fsa, {
    name: "valid",
    boxes: [{ name: "root", type: "goal", id: "cx-valid1" }],
  });

  const paths = [
    `.tent/${INDEX_PATH}`,
    `.tent/${TYPE_REGISTRY_PATH}`,
    `.tent/${ROLES_REGISTRY_PATH}`,
    `.tent/${TAGS_REGISTRY_PATH}`,
    ".tent/root/root.md",
    ".gitignore",
  ];
  const before = await snapshotExistingFiles(workspace, paths);

  const probe = new WriteProbeFs(fsa);
  probe.arm();
  await assert.rejects(
    () => reAdoptOrphanTent(probe),
    /already marks a valid Tent/
  );
  assert.equal(probe.mutationCount, 0);
  await assertBytesUnchanged(workspace, before);
});

test("reAdoptOrphanTent: fail-closed when index.md exists but is invalid/non-index", async () => {
  const { workspace, fsa } = await mkWorkspace();
  const badIndex = "# User notes — not an index\nkeep me\n";
  const before = await writeOrphanTentFixture(workspace, {
    withNode: true,
    withTypes: true,
    indexContent: badIndex,
  });

  const probe = new WriteProbeFs(fsa);
  probe.arm();
  await assert.rejects(
    () => reAdoptOrphanTent(probe),
    /exists but is not a valid Tent index marker/
  );
  assert.equal(probe.mutationCount, 0);
  await assertBytesUnchanged(workspace, before);
  assert.equal(
    await fs.readFile(path.join(workspace, TENT_SYSTEM_DIR, INDEX_PATH), "utf8"),
    badIndex
  );
});

test("reAdoptOrphanTent: fail-closed when .tent is missing", async () => {
  const { fsa } = await mkWorkspace();
  const probe = new WriteProbeFs(fsa);
  probe.arm();
  await assert.rejects(
    () => reAdoptOrphanTent(probe),
    /no \.tent\/ system directory/
  );
  assert.equal(probe.mutationCount, 0);
});

test("reAdoptOrphanTent: success is not silently re-runnable once index exists (idempotent fail-closed)", async () => {
  const { workspace, fsa } = await mkWorkspace();
  await writeOrphanTentFixture(workspace, {
    withNode: true,
    withTypes: true,
    withRoles: true,
  });

  const first = await reAdoptOrphanTent(fsa);
  assert.equal(first.createdIndex, true);

  const paths = [
    `.tent/${INDEX_PATH}`,
    `.tent/${TYPE_REGISTRY_PATH}`,
    `.tent/${ROLES_REGISTRY_PATH}`,
    `.tent/${TAGS_REGISTRY_PATH}`,
    `.tent/${ORPHAN_NODE_PATH.replace(/\\/g, "/")}`,
    `.tent/${TEMP_DIR}/history.txt`,
  ];
  const afterFirst = await snapshotExistingFiles(workspace, paths);

  const probe = new WriteProbeFs(fsa);
  probe.arm();
  await assert.rejects(
    () => reAdoptOrphanTent(probe),
    /already marks a valid Tent/
  );
  assert.equal(probe.mutationCount, 0);
  await assertBytesUnchanged(workspace, afterFirst);
});

test("reAdoptOrphanTent: does not invent roster or rewrite existing roles registry", async () => {
  const { workspace, fsa } = await mkWorkspace();
  await writeOrphanTentFixture(workspace, {
    withNode: true,
    withTypes: true,
    withRoles: true,
    withTags: true,
  });

  await reAdoptOrphanTent(fsa);

  assert.equal(
    await fs.readFile(path.join(workspace, TENT_SYSTEM_DIR, ROLES_REGISTRY_PATH), "utf8"),
    CUSTOM_ROLES_BYTES
  );
  assert.equal(
    await fs.readFile(path.join(workspace, TENT_SYSTEM_DIR, TAGS_REGISTRY_PATH), "utf8"),
    CUSTOM_TAGS_BYTES
  );
  // No extra role files / agent definitions invented at system root.
  const top = await fsa.listDir(TENT_SYSTEM_DIR);
  const names = top.map((e) => e.name).sort();
  assert.ok(!names.includes("agent-definitions.json"));
  assert.ok(!names.includes("RULES.md"));
  assert.ok(!names.includes("AGENTS.md"));
});

test("isValidTentIndexMarker: accepts type index only", () => {
  assert.equal(isValidTentIndexMarker(tentIndexMarker()), true);
  assert.equal(isValidTentIndexMarker("---\ntype: index\n---\n"), true);
  assert.equal(isValidTentIndexMarker("---\ntype: concept\n---\n"), false);
  assert.equal(isValidTentIndexMarker("# bare markdown\n"), false);
  assert.equal(isValidTentIndexMarker(""), false);
});

test("ensureWorkspaceGitignore: re-adopt path leaves covered workspaces untouched", async () => {
  const { workspace, fsa } = await mkWorkspace();
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n", "utf8");
  await writeOrphanTentFixture(workspace, { withNode: true, withTypes: true });

  const result = await reAdoptOrphanTent(fsa);
  assert.equal(result.gitignoreUpdated, false);
  assert.equal(await fsa.readFile(".gitignore"), ".tent/\n");
});
