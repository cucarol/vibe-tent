import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { createNode, dispatch, taskAck } from "../src/core/ops.js";
import { loadTent } from "../src/core/tree.js";
import { contentEtag } from "../src/markdown/etag.js";
import { CoreDocsClient } from "../src/markdown/core-docs-client.js";
import {
  MAX_ATTACHMENT_BYTES,
  decodeBase64Strict,
  sanitizeAttachmentFileName,
} from "../src/markdown/attachments.js";
import {
  buildBacklinkIndex,
  extractOutLinks,
  extractOutLinksDetailed,
} from "../src/markdown/links.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { renderMarkdownToHtml } from "../src/markdown/render.js";
import { WorkspaceController } from "../src/markdown/workspace-controller.js";
import { startMarkdownPreviewServer } from "../src/markdown/preview-server.js";
import { nodeNotePath } from "../src/core/tree.js";

async function makeEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-md-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "md" });
  const env = {
    fs: fsa,
    clock: { now: () => "2026-07-12T00:00:00.000Z" },
    tentName: "md",
    rand: () => 0.42,
  };
  return { dir, env, fsa };
}

test("contentEtag: stable hash slice", () => {
  assert.equal(contentEtag("abc"), contentEtag("abc"));
  assert.notEqual(contentEtag("abc"), contentEtag("abd"));
  assert.equal(contentEtag("x").length, 24);
});

test("extractOutLinks: wiki and md", () => {
  const links = extractOutLinks("See [[Alpha]] and [Beta](beta/beta.md) plus https skip [ext](https://x.test)");
  assert.equal(links.some((l) => l.kind === "wiki" && l.raw === "Alpha"), true);
  assert.equal(links.some((l) => l.kind === "md" && l.raw.includes("beta")), true);
  assert.equal(links.some((l) => l.kind === "artifact"), true);
});

test("renderMarkdownToHtml: headings and wiki links only", () => {
  const html = renderMarkdownToHtml("# Hi\n\n[[Note]]", {
    resolveWikiHref: () => "#open=Note",
  });
  assert.match(html, /<h1>Hi<\/h1>/);
  assert.match(html, /wiki-link/);
  assert.doesNotMatch(html, /artifact-chip|Artifact references/);
});

test("Docs typed reads retain custom artifactRefs only as raw frontmatter", async () => {
  const { env } = await makeEnv();
  const docs = new CoreDocsClient(env as any);
  const created = await docs.createNote({ name: "custom-artifacts", type: "output", body: "# result\n" });
  const initial = await docs.readForEdit(created.nodeId);
  const raw = initial.raw.replace(
    /^---\n/,
    '---\nartifactRefs: [{"kind":"path","target":"legacy.bin"}]\n'
  );
  const written = await docs.write({ nodeId: created.nodeId, baseEtag: initial.etag, raw });
  assert.equal(written.ok, true);

  const edit = await docs.readForEdit(created.nodeId);
  assert.equal("artifactRefs" in edit, false);
  assert.equal(Array.isArray(edit.frontmatter.artifactRefs), true);
  assert.match(edit.raw, /artifactRefs:[\s\S]*legacy\.bin/);
  const projection = await docs.get(created.nodeId);
  assert.equal("artifactRefs" in (projection ?? {}), false);

  const controller = new WorkspaceController(docs);
  await controller.openNode(created.nodeId);
  controller.setMode(created.nodeId, "preview");
  assert.doesNotMatch(controller.previewHtml(created.nodeId), /artifact-chip|legacy\.bin/);
});

test("CoreDocsClient: list excludes temp; create/read/write/search", async () => {
  const { env, fsa } = await makeEnv();
  const docs = new CoreDocsClient(env as any);

  await fsa.mkdir("temp/role/notes");
  await fsa.writeFile("temp/role/notes/private.md", "secret\n");

  const note = await docs.createNote({ name: "ideas", type: "prompt", body: "# ideas\nlink [[ideas]]\n" });
  assert.match(note.nodeId, /^cx-/);

  const tree = await docs.list();
  assert.equal(tree.some((n) => n.path === "ideas"), true);
  assert.equal(tree.some((n) => n.path.startsWith("temp")), false);

  const edit = await docs.readForEdit(note.nodeId);
  assert.equal(edit.nodeId, note.nodeId);
  assert.ok(edit.etag);

  const bad = await docs.write({
    nodeId: note.nodeId,
    baseEtag: "deadbeefdeadbeefdeadbeef",
    body: "nope",
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "etag_conflict");

  const nextRaw = edit.raw.replace("# ideas", "# ideas v2");
  const ok = await docs.write({ nodeId: note.nodeId, baseEtag: edit.etag, raw: nextRaw });
  assert.equal(ok.ok, true);

  const hits = await docs.search("ideas v2");
  assert.ok(hits.some((h) => h.nodeId === note.nodeId));

  const after = await docs.get(note.nodeId);
  assert.equal(after?.type, "prompt");
  assert.equal(after?.invalid, false);
  assert.equal(after?.archived, false);
  assert.equal("coordination" in (after ?? {}), false);
});

test("CoreDocsClient: active task protects collab fields on write", async () => {
  const { env, fsa } = await makeEnv();
  // roles registry needed for dispatch
  await fsa.writeFile(
    "roles.json",
    JSON.stringify({ roles: [{ id: "rl-executor", name: "executor" }] }, null, 2) + "\n"
  );
  const nodeId = await createNode(env as any, { parentPath: "", name: "work", type: "goal" });
  const dispatched = await dispatch(env as any, nodeId, {
    roleId: "rl-executor",
    workNodeIds: [nodeId],
    contextNodeIds: [],
    userPrompt: "do the work",
    parentActor: { kind: "user", id: "user" },
  });
  await taskAck(env as any, dispatched.taskPath);

  const docs = new CoreDocsClient(env as any);
  const edit = await docs.readForEdit(nodeId);
  const { parseFrontmatter, serializeFrontmatter, NODE_FRONTMATTER_KEY_ORDER } = await import(
    "../src/core/frontmatter.js"
  );
  const { data, body, keyOrder } = parseFrontmatter(edit.raw);
  data.status = "done";
  const raw = serializeFrontmatter(data, body, keyOrder.length ? keyOrder : NODE_FRONTMATTER_KEY_ORDER);
  const result = await docs.write({ nodeId: nodeId, baseEtag: edit.etag, raw });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "collab_field_protected");

  // body-only write still allowed
  const edit2 = await docs.readForEdit(nodeId);
  const bodyOnly = await docs.write({
    nodeId: nodeId,
    baseEtag: edit2.etag,
    body: edit2.body + "\nmore\n",
  });
  assert.equal(bodyOnly.ok, true);
});

test("backlinks index from wiki links", async () => {
  const { env } = await makeEnv();
  const docs = new CoreDocsClient(env as any);
  const a = await docs.createNote({ name: "alpha", body: "# A\n" });
  const b = await docs.createNote({ name: "beta", body: "# B\nsee [[alpha]]\n" });
  const tent = await loadTent(env.fs);
  const concepts = [...tent.byId.values()].map((node) => ({
    id: node.id,
    path: node.path,
    name: node.name,
    body: node.body,
    notePath: nodeNotePath(node.path),
  }));
  const reverse = buildBacklinkIndex(concepts);
  const hits = reverse.get(a.nodeId) ?? [];
  assert.ok(hits.some((h) => h.fromNodeId === b.nodeId));
  const apiHits = await docs.backlinks(a.nodeId);
  assert.ok(apiHits.some((h) => h.fromNodeId === b.nodeId));
});

test("WorkspaceController: tabs dirty conflict and save", async () => {
  const { env, fsa } = await makeEnv();
  const docs = new CoreDocsClient(env as any);
  const created = await docs.createNote({ name: "page", body: "# page\n" });
  const ctl = new WorkspaceController(docs);
  await ctl.refreshTree();
  await ctl.openNode(created.nodeId);
  const tab = ctl.getActiveTab()!;
  assert.equal(tab.dirty, false);

  ctl.updateBuffer(tab.nodeId, tab.buffer + "\nedit\n");
  assert.equal(ctl.getActiveTab()!.dirty, true);

  // external change on disk
  const notePath = nodeNotePath("page");
  const disk = await fsa.readFile(notePath);
  await fsa.writeFile(notePath, disk + "\nexternal\n");

  const saved = await ctl.save(tab.nodeId);
  assert.equal(saved, false);
  assert.ok(ctl.getActiveTab()!.conflict);

  const overwritten = await ctl.overwriteWithMine(tab.nodeId);
  assert.equal(overwritten, true);
  assert.equal(ctl.getActiveTab()!.dirty, false);
  assert.equal(ctl.getActiveTab()!.conflict, null);
});

test("WorkspaceController: tree has no operational paths", async () => {
  const { env, fsa } = await makeEnv();
  await fsa.mkdir("temp/x");
  await fsa.writeFile("temp/x/x.md", "---\nid: cx-temp\ntype: prompt\n---\n");
  const docs = new CoreDocsClient(env as any);
  await docs.createNote({ name: "real", body: "# r\n" });
  const ctl = new WorkspaceController(docs);
  await ctl.refreshTree();
  const snap = ctl.getSnapshot();
  assert.equal(snap.tree.some((n) => n.name === "real"), true);
  assert.equal(snap.tree.some((n) => n.name === "temp" || n.path.startsWith("temp")), false);
});

test("preview server: serves tree and opens concept", async () => {
  const { dir, env } = await makeEnv();
  const docs = new CoreDocsClient(env as any);
  const created = await docs.createNote({ name: "hello", body: "# Hello workspace\n" });

  const handle = await startMarkdownPreviewServer({ systemRoot: dir, port: 0 });
  try {
    const treeRes = await httpGet(`${handle.url}api/tree`);
    assert.equal(treeRes.status, 200);
    assert.match(treeRes.body, /hello/);

    const page = await httpGet(`${handle.url}?open=${encodeURIComponent(created.nodeId)}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /Hello workspace|hello/);
    assert.match(page.body, /Nodes/);
    assert.doesNotMatch(page.body, /workspace source tree browser/i);
  } finally {
    await handle.close();
  }
});

test("NodeFs binary read/write: exact bytes including NUL and non-UTF8", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-bin-"));
  const fsa = new NodeFs(dir);
  const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x01, 0x00, 0x80, 0x7f]);
  await fsa.writeBinary("attachments/cx-x/raw.bin", bytes);
  const round = await fsa.readBinary("attachments/cx-x/raw.bin");
  assert.deepEqual([...round], [...bytes]);
  // No path escape
  await assert.rejects(() => fsa.writeBinary("../outside.bin", bytes), /escapes Tent root/i);
  await assert.rejects(() => fsa.readBinary("..\\..\\windows\\system32\\drivers\\etc\\hosts"), /escapes Tent root/i);
});

test("sanitizeAttachmentFileName: rejects traversal and neutralizes Windows-invalid names", () => {
  assert.throws(() => sanitizeAttachmentFileName("../../etc/passwd"), /single path segment/);
  assert.throws(() => sanitizeAttachmentFileName("a\\b\\c.png"), /single path segment/);
  assert.equal(sanitizeAttachmentFileName("CON"), "file-CON");
  assert.equal(sanitizeAttachmentFileName("nul.txt"), "file-nul.txt");
  assert.ok(!sanitizeAttachmentFileName("foo:bar*.png").includes(":"));
  assert.ok(!sanitizeAttachmentFileName("foo:bar*.png").includes("*"));
  // Double-dot inside a stem is a valid filename segment (not traversal).
  assert.equal(sanitizeAttachmentFileName("draft..final.png"), "draft..final.png");
});

test("decodeBase64Strict: rejects invalid encodings", () => {
  assert.deepEqual([...decodeBase64Strict("AQID")], [1, 2, 3]);
  assert.throws(() => decodeBase64Strict("@@@"), /Invalid base64/);
  assert.throws(() => decodeBase64Strict("A"), /Invalid base64/);
  assert.throws(() => decodeBase64Strict("===="), /Invalid base64/);
});

test("CoreDocsClient.importAttachment: binary roundtrip, no .b64 marker, idempotent", async () => {
  const { env, fsa, dir } = await makeEnv();
  const docs = new CoreDocsClient(env as any);
  const note = await docs.createNote({ name: "with-pic", type: "prompt", body: "# pic\n" });

  const payload = new Uint8Array([0x00, 0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
  const first = await docs.importAttachment(note.nodeId, "shot.png", payload);
  assert.match(first.relativePath, new RegExp(`^attachments/${note.nodeId}/shot-[0-9a-f]{12}\\.png$`));
  assert.equal(first.markdown, `![](../${first.relativePath})`);
  assert.equal("artifactRef" in first, false);

  // Disk is exact bytes — not a .b64 companion or text marker.
  const onDisk = await fsa.readBinary(first.relativePath);
  assert.deepEqual([...onDisk], [...payload]);
  assert.equal(await fsa.exists(first.relativePath + ".b64"), false);
  const abs = path.join(dir, first.relativePath);
  const nodeBytes = await fs.readFile(abs);
  assert.deepEqual([...nodeBytes], [...payload]);

  // Identical re-import is deterministic and does not create a second file.
  const second = await docs.importAttachment(note.nodeId, "shot.png", payload);
  assert.equal(second.relativePath, first.relativePath);
  const listing = await fsa.listDir(`attachments/${note.nodeId}`);
  assert.equal(listing.filter((e) => !e.isDir).length, 1);

  await assert.rejects(
    () => docs.importAttachment(note.nodeId, "../../evil/../../x.bin", payload),
    /single path segment/
  );

  // Empty binary files are valid attachments.
  const empty = await docs.importAttachment(note.nodeId, "empty.bin", new Uint8Array());
  assert.equal((await fsa.readBinary(empty.relativePath)).byteLength, 0);

  // Size limit
  const huge = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  await assert.rejects(
    () => docs.importAttachment(note.nodeId, "huge.bin", huge),
    /exceeds max size/i
  );

  // Unknown concept
  await assert.rejects(
    () => docs.importAttachment("cx-missing", "a.png", payload),
    /Node not found/
  );
});

test("storeAttachmentBytes: draft..final.png stores; spaces/parens use angle-bracket destinations", async () => {
  const { env, fsa } = await makeEnv();
  const docs = new CoreDocsClient(env as any);
  const note = await docs.createNote({ name: "attach-names", type: "prompt", body: "# names\n" });
  const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

  // Filename with embedded ".." must not be false-rejected by path guards.
  const dotted = await docs.importAttachment(note.nodeId, "draft..final.png", payload);
  assert.match(dotted.relativePath, new RegExp(`^attachments/${note.nodeId}/draft\\.\\.final-[0-9a-f]{12}\\.png$`));
  assert.equal(dotted.markdown, `![](../${dotted.relativePath})`);
  assert.deepEqual([...(await fsa.readBinary(dotted.relativePath))], [...payload]);

  // Whitespace / parentheses → CommonMark angle-bracket destinations; plain targets stay bare.
  const spaced = await docs.importAttachment(note.nodeId, "my shot.png", payload);
  assert.match(spaced.relativePath, /\/my shot-[0-9a-f]{12}\.png$/);
  assert.equal(spaced.markdown, `![](<../${spaced.relativePath}>)`);

  const parens = await docs.importAttachment(note.nodeId, "file(1).bin", payload);
  assert.match(parens.relativePath, /\/file\(1\)-[0-9a-f]{12}\.bin$/);
  assert.equal(parens.markdown, `![](<../${parens.relativePath}>)`);

  // mdast parses the generated image destinations intact (not truncated at space/paren).
  for (const result of [dotted, spaced, parens]) {
    const tree = fromMarkdown(result.markdown);
    const image = tree.children[0] && "children" in tree.children[0]
      ? (tree.children[0].children as { type: string; url?: string }[]).find((n) => n.type === "image")
      : undefined;
    assert.ok(image, `mdast image missing for ${result.markdown}`);
    assert.equal(image!.url, `../${result.relativePath}`);
  }

  // extractOutLinks treats attachment paths as non-concept (skipped), not broken md edges.
  const body = [dotted, spaced, parens].map((r) => r.markdown).join("\n") + "\nSee [[RealConcept]]\n";
  const links = extractOutLinks(body);
  assert.equal(links.some((l) => l.raw.includes("attachments") || l.raw.includes("draft")), false);
  assert.ok(links.some((l) => l.kind === "wiki" && l.raw === "RealConcept"));

  // Non-image markdown with the same destinations still resolves as attachment paths (not concept md).
  const asLinks = [
    `[a](../${dotted.relativePath})`,
    `[b](<../${spaced.relativePath}>)`,
    `[c](<../${parens.relativePath}>)`,
  ].join("\n");
  const detailed = extractOutLinksDetailed(asLinks);
  assert.equal(detailed.length, 0, "attachment destinations must not become concept out-links");

  // Traversal / multi-segment names remain rejected.
  await assert.rejects(
    () => docs.importAttachment(note.nodeId, "../../evil.png", payload),
    /single path segment/
  );
  await assert.rejects(
    () => docs.importAttachment(note.nodeId, "a/b.png", payload),
    /single path segment/
  );
  assert.throws(() => sanitizeAttachmentFileName(".."), /single path segment/);
  assert.throws(() => sanitizeAttachmentFileName("."), /single path segment/);

});

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") })
        );
      })
      .on("error", reject);
  });
}
