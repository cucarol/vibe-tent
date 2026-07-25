import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBacklinkIndex,
  extractOutLinks,
  extractOutLinksDetailed,
  normalizeTarget,
  resolveOutLink,
} from "../src/markdown/links.js";
import type { OkfConcept } from "../src/core/okf.js";

function conceptIndex(
  concepts: Array<Pick<OkfConcept, "id" | "path" | "notePath" | "name">>
): Map<string, OkfConcept[]> {
  const index = new Map<string, OkfConcept[]>();
  const add = (key: string, c: OkfConcept) => {
    if (!key) return;
    const list = index.get(key) ?? [];
    if (!list.some((x) => x.id === c.id)) list.push(c);
    index.set(key, list);
    const all = index.get("__all__") ?? [];
    if (!all.some((x) => x.id === c.id)) all.push(c);
    index.set("__all__", all);
  };
  for (const c of concepts) {
    const full: OkfConcept = { ...c, boxId: c.id, type: "prompt" };
    add(full.id, full);
    add(full.path, full);
    add(full.notePath, full);
    add(full.name, full);
  }
  return index;
}

test("extractOutLinks: wiki, md, and external artifact", () => {
  const links = extractOutLinks(
    "See [[Alpha]] and [Beta](beta/beta.md) plus [ext](https://x.test)"
  );
  assert.equal(links.some((l) => l.kind === "wiki" && l.raw === "Alpha"), true);
  assert.equal(links.some((l) => l.kind === "md" && l.raw.includes("beta")), true);
  assert.equal(links.some((l) => l.kind === "artifact" && l.raw.startsWith("https:")), true);
});

test("extractOutLinks: angle-bracket destinations with spaces and titles", () => {
  const links = extractOutLinksDetailed(
    [
      `[Space](<space concept.md>)`,
      `[Titled](<nested/note.md> "Hello title")`,
      `[Paren title](./other.md (title text))`,
      `[Query](./other.md?x=1#frag)`,
    ].join("\n")
  );
  assert.ok(links.some((l) => l.kind === "md" && l.raw === "space concept.md"));
  assert.ok(links.some((l) => l.kind === "md" && l.conceptTarget === "nested/note.md"));
  assert.ok(links.some((l) => l.kind === "md" && l.raw.startsWith("./other.md") && l.fragment === "frag"));
  const q = links.find((l) => l.raw.includes("?x=1"));
  assert.equal(q?.conceptTarget, "./other.md");
});

test("extractOutLinks: resolves full, collapsed, and shortcut reference links", () => {
  const links = extractOutLinks([
    "[Alpha][a] [Beta][] [Gamma]",
    "",
    "[a]: ./alpha.md",
    "[Beta]: <nested/beta note.md> 'title'",
    "[Gamma]: ./gamma.md",
  ].join("\n"));
  assert.deepEqual(
    links.map((link) => link.raw),
    ["./alpha.md", "nested/beta note.md", "./gamma.md"]
  );
});

test("extractOutLinks: balanced and escaped parentheses in destination", () => {
  const links = extractOutLinks(`See [A](./foo(bar).md) and [B](./baz\\).md)`);
  assert.ok(links.some((l) => l.raw === "./foo(bar).md"));
  assert.ok(links.some((l) => l.raw === "./baz).md" || l.raw.includes("baz")));
});

test("extractOutLinks: percent-encoded destinations decode for conceptTarget path form", () => {
  const links = extractOutLinksDetailed(`[P](./my%20note.md)`);
  assert.equal(links[0]?.kind, "md");
  assert.equal(links[0]?.raw, "./my%20note.md");
  // normalizeTarget decodes when resolving; conceptTarget keeps pathPart of href
  assert.equal(normalizeTarget(links[0]!.conceptTarget!, "folder/a.md"), "folder/my note");
  assert.equal(normalizeTarget("./%E4%B8%AD%E6%96%87.md", "folder/a.md"), "folder/中文");
});

test("extractOutLinks: wiki labels and heading/block suffixes", () => {
  const links = extractOutLinksDetailed(
    `[[Alpha|Display]] [[Beta#Heading]] [[Gamma^blockid]] [[Delta#H^b]]`
  );
  const labeled = links.find((l) => l.raw === "Alpha");
  assert.equal(labeled?.label, "Display");
  assert.equal(labeled?.kind, "wiki");

  const headed = links.find((l) => l.raw === "Beta#Heading");
  assert.equal(headed?.conceptTarget, "Beta");
  assert.equal(headed?.fragment, "Heading");

  const blocked = links.find((l) => l.raw === "Gamma^blockid");
  assert.equal(blocked?.conceptTarget, "Gamma");
  assert.equal(blocked?.blockRef, "blockid");

  const both = links.find((l) => l.raw === "Delta#H^b");
  assert.equal(both?.conceptTarget, "Delta");
  assert.equal(both?.fragment, "H");
  assert.equal(both?.blockRef, "b");
});

test("extractOutLinks: ignores fenced code, indented code, inline code", () => {
  const body = [
    "Prose [[Keep]]",
    "",
    "```md",
    "[[SkipFence]] and [Skip](skip.md)",
    "```",
    "",
    "    [[SkipIndent]]",
    "    [Also](indented.md)",
    "",
    "Inline `[[SkipInline]]` and `[no](code.md)` done",
    "",
    "~~~",
    "[[SkipTilde]]",
    "~~~",
  ].join("\n");
  const links = extractOutLinks(body);
  assert.deepEqual(
    links.map((l) => l.raw),
    ["Keep"]
  );
});

test("extractOutLinks: ignores raw HTML script/style and HTML blocks", () => {
  const body = [
    "Before [[Keep]]",
    "<script>",
    `document.write('[[SkipScript]]')`,
    "</script>",
    "<style>",
    `/* [[SkipStyle]] */`,
    "</style>",
    "<div>",
    "[[SkipDiv]]",
    "",
    "After [[AlsoKeep]]",
  ].join("\n");
  const links = extractOutLinks(body);
  const raws = links.map((l) => l.raw).sort();
  assert.deepEqual(raws, ["AlsoKeep", "Keep"]);
});

test("extractOutLinks: ignores escaped syntax", () => {
  const links = extractOutLinks(String.raw`\[[NotWiki]] and \[not](./no.md) but [[Real]]`);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.raw, "Real");
});

test("extractOutLinks: images and wiki embeds are not concept edges", () => {
  const body = [
    "![alt](./concept.md)",
    "![[EmbedNote]]",
    "![pic](../attachments/cx-x/a.png)",
    "Real [[Concept]] and [Md](./other.md)",
  ].join("\n");
  const links = extractOutLinks(body);
  assert.equal(links.some((l) => l.raw === "EmbedNote"), false);
  assert.equal(links.some((l) => l.raw.includes("concept.md")), false);
  assert.equal(links.some((l) => l.raw.includes("attachments")), false);
  assert.ok(links.some((l) => l.raw === "Concept"));
  assert.ok(links.some((l) => l.raw === "./other.md"));
});

test("extractOutLinks: pure anchors and attachment paths skipped", () => {
  const links = extractOutLinks(
    [
      "[a](#section)",
      "[b](attachments/cx-1/file.png)",
      "[c](../attachments/cx-1/file.png)",
      "[[#only-anchor]]",
      "See [[Ok]]",
    ].join("\n")
  );
  assert.deepEqual(
    links.map((l) => l.raw),
    ["Ok"]
  );
});

test("extractOutLinks: external schemes are artifacts not concept md", () => {
  const links = extractOutLinks(
    `[a](https://ex.test/x) [b](mailto:a@b.c) [c](tent-artifact:foo) [d](ftp://h/x) [e](//cdn.test/x)`
  );
  assert.ok(links.every((l) => l.kind === "artifact"));
  assert.equal(links.length, 5);
});

test("extractOutLinks: duplicate links collapsed", () => {
  const links = extractOutLinks(`[[A]] [[A]] [B](b.md) [B](b.md) [[A|L]] [[A|L]]`);
  const wikiA = links.filter((l) => l.kind === "wiki" && l.raw === "A" && !l.label);
  const wikiAL = links.filter((l) => l.kind === "wiki" && l.raw === "A" && l.label === "L");
  const mdB = links.filter((l) => l.kind === "md" && l.raw === "b.md");
  assert.equal(wikiA.length, 1);
  assert.equal(wikiAL.length, 1);
  assert.equal(mdB.length, 1);
});

test("normalizeTarget: nested relative paths from source note", () => {
  assert.equal(
    normalizeTarget("../sibling/note.md", "folder/child/child.md"),
    "folder/sibling/note"
  );
  assert.equal(normalizeTarget("./local.md", "a/b/c.md"), "a/b/local");
  assert.equal(normalizeTarget("abs/path.md"), "abs/path");
  assert.equal(normalizeTarget("<space name.md>", "x/y.md"), "space name");
  assert.equal(normalizeTarget("./n.md#frag?q=1", "r/a.md"), "r/n");
});

test("resolveOutLink: relative md and wiki with fragment", () => {
  const index = conceptIndex([
    { id: "cx-alpha", path: "alpha", notePath: "alpha/alpha.md", name: "alpha" },
    {
      id: "cx-beta",
      path: "nest/beta",
      notePath: "nest/beta/beta.md",
      name: "beta",
    },
  ]);

  const from = "nest/gamma/gamma.md";
  const rel = resolveOutLink(
    index,
    { raw: "../beta/beta.md", kind: "md" },
    from
  );
  assert.equal(rel.kind, "md");
  assert.equal(rel.targetCx, "cx-beta");

  const wiki = resolveOutLink(
    index,
    {
      raw: "alpha#Heading",
      kind: "wiki",
      conceptTarget: "alpha",
      fragment: "Heading",
    } as any,
    from
  );
  assert.equal(wiki.targetCx, "cx-alpha");
  assert.equal(wiki.raw, "alpha#Heading");

  const missing = resolveOutLink(index, { raw: "nope", kind: "wiki" }, from);
  assert.equal(missing.kind, "unresolved");
});

test("resolveOutLink: attachments and anchors unresolved (no concept edge)", () => {
  const index = conceptIndex([
    { id: "cx-a", path: "a", notePath: "a/a.md", name: "a" },
  ]);
  assert.equal(
    resolveOutLink(index, { raw: "#frag", kind: "md" }, "a/a.md").kind,
    "unresolved"
  );
  assert.equal(
    resolveOutLink(
      index,
      { raw: "../attachments/cx-a/x.png", kind: "md", conceptTarget: "../attachments/cx-a/x.png" } as any,
      "a/a.md"
    ).kind,
    "unresolved"
  );
});

test("buildBacklinkIndex: wiki/md edges, skips images and duplicates resolve once", () => {
  const concepts = [
    {
      id: "cx-a",
      path: "a",
      name: "a",
      notePath: "a/a.md",
      body: "# A\n",
    },
    {
      id: "cx-b",
      path: "b",
      name: "b",
      notePath: "b/b.md",
      body: [
        "see [[a]] and [[a]]",
        "[again](../a/a.md)",
        "![not](../a/a.md)",
        "![[a]]",
        "code:",
        "```",
        "[[a]]",
        "```",
      ].join("\n"),
    },
    {
      id: "cx-c",
      path: "c",
      name: "c",
      notePath: "c/c.md",
      body: "unresolved [[zzz]] and [ext](https://x.test)\n",
    },
  ];
  const reverse = buildBacklinkIndex(concepts);
  const hits = reverse.get("cx-a") ?? [];
  assert.ok(hits.some((h) => h.fromCx === "cx-b" && h.kind === "wiki"));
  assert.ok(hits.some((h) => h.fromCx === "cx-b" && h.kind === "md"));
  // image/embed/code must not add extra from c
  assert.equal(
    hits.filter((h) => h.fromCx === "cx-c").length,
    0
  );
  // unresolved target has no reverse entry
  assert.equal(reverse.has("zzz"), false);
  // duplicates: wiki [[a]] collapsed to one outbound, md separate
  assert.equal(hits.filter((h) => h.fromCx === "cx-b" && h.kind === "wiki").length, 1);
  assert.equal(hits.filter((h) => h.fromCx === "cx-b" && h.kind === "md").length, 1);
});
