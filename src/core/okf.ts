import { FsAdapter, withTentMutation } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { Box } from "./types.js";
import { boxNotePath, dirName, join, loadTent } from "./tree.js";

export interface OkfConcept {
  id: string;
  boxId: string;
  path: string;
  notePath: string;
  name: string;
  type: string;
}

export interface OkfProjectionResult {
  projectedFiles: string[];
  unresolved: { file: string; target: string }[];
}

export interface OkfSyncResult extends OkfProjectionResult {
  generatedFiles: string[];
}

export async function syncOkfBundle(fs: FsAdapter): Promise<OkfSyncResult> {
  return withTentMutation(fs, async () => syncOkfBundleUnlocked(fs));
}

async function syncOkfBundleUnlocked(fs: FsAdapter): Promise<OkfSyncResult> {
  const tent = await loadTent(fs);
  const concepts = [...tent.byPath.values()];
  const index = buildConceptIndex(concepts);
  const generatedFiles = await writeIndexes(fs, concepts);
  const projection = await projectWikiLinks(fs, concepts, index);
  return { generatedFiles, ...projection };
}

export function buildConceptIndex(boxes: Iterable<Box>): Map<string, OkfConcept[]> {
  const index = new Map<string, OkfConcept[]>();
  for (const box of boxes) {
    const concept = toConcept(box);
    addIndex(index, concept.boxId, concept);
    addIndex(index, concept.id, concept);
    addIndex(index, concept.path, concept);
    addIndex(index, concept.notePath, concept);
    addIndex(index, concept.name, concept);
  }
  return index;
}

export function resolveConcept(index: Map<string, OkfConcept[]>, target: string): OkfConcept | undefined {
  const clean = target.trim().replace(/^\.\//, "").replace(/\.md$/i, "");
  const matches = index.get(clean) ?? index.get(`${clean}.md`) ?? index.get(normalizeLookupKey(clean));
  if (matches?.length === 1) return matches[0];

  const normalized = normalizeLookupKey(clean);
  if (normalized.length >= 4) {
    const all = index.get("__all__") ?? [];
    const fuzzy = all.filter((concept) => normalizeLookupKey(concept.name).includes(normalized));
    if (fuzzy.length === 1) return fuzzy[0];
  }
  return matches?.length === 1 ? matches[0] : undefined;
}

export function projectMarkdownLinks(
  body: string,
  fromNotePath: string,
  index: Map<string, OkfConcept[]>
): { body: string; unresolved: string[]; changed: boolean } {
  const unresolved: string[] = [];
  let changed = false;
  const next = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (full, rawTarget: string, rawLabel: string | undefined, offset: number) => {
    if (offset > 0 && body[offset - 1] === "!") return full;
    const target = rawTarget.trim();
    const concept = resolveConcept(index, target);
    if (!concept) {
      unresolved.push(target);
      return full;
    }
    const label = (rawLabel ?? concept.name).trim();
    const href = relativeMarkdownPath(fromNotePath, concept.notePath);
    changed = true;
    return `[${label}](${markdownLinkDestination(href)})`;
  });
  return { body: next, unresolved, changed };
}

async function projectWikiLinks(
  fs: FsAdapter,
  boxes: Box[],
  index: Map<string, OkfConcept[]>
): Promise<OkfProjectionResult> {
  const projectedFiles: string[] = [];
  const unresolved: { file: string; target: string }[] = [];
  for (const box of boxes) {
    const notePath = boxNotePath(box.path);
    const { data, body, keyOrder } = parseFrontmatter(await fs.readFile(notePath));
    const projected = projectMarkdownLinks(body, notePath, index);
    if (projected.unresolved.length > 0) {
      unresolved.push(...projected.unresolved.map((target) => ({ file: notePath, target })));
    }
    if (!projected.changed) continue;
    await fs.writeFile(notePath, serializeFrontmatter(data, projected.body, keyOrder));
    projectedFiles.push(notePath);
  }
  return { projectedFiles, unresolved };
}

async function writeIndexes(fs: FsAdapter, boxes: Box[]): Promise<string[]> {
  const generated = new Set<string>();
  const byDir = new Map<string, Box[]>();
  for (const box of boxes) {
    const dir = dirName(boxNotePath(box.path));
    const list = byDir.get(dir) ?? [];
    list.push(box);
    byDir.set(dir, list);
  }

  const roots = boxes.filter((box) => !box.parent);
  await fs.writeFile(
    "index.md",
    serializeFrontmatter(
      { type: "index", okf_version: "0.1" },
      "# Index\n\n" + roots.map((box) => `- [${box.name}](${markdownLinkDestination(boxNotePath(box.path))})`).join("\n") + "\n"
    )
  );
  generated.add("index.md");

  for (const [dir, siblings] of byDir.entries()) {
    if (!dir) continue;
    const indexPath = join(dir, "index.md");
    await fs.writeFile(
      indexPath,
      serializeFrontmatter(
        { type: "index" },
        "# Index\n\n" + siblings.map((box) => `- [${box.name}](${markdownLinkDestination(`${box.name}.md`)})`).join("\n") + "\n"
      )
    );
    generated.add(indexPath);
  }

  await fs.writeFile("log.md", serializeFrontmatter({ type: "log" }, "# Log\n\n_No log entries._\n"));
  generated.add("log.md");

  return [...generated].sort();
}

function toConcept(box: Box): OkfConcept {
  const notePath = boxNotePath(box.path);
  const id = notePath.replace(/\.md$/i, "");
  return {
    id,
    boxId: box.id,
    path: box.path,
    notePath,
    name: box.name,
    type: box.type,
  };
}

function addIndex(index: Map<string, OkfConcept[]>, key: string, concept: OkfConcept): void {
  const clean = key.trim();
  if (!clean) return;
  addRawIndex(index, clean, concept);
  addRawIndex(index, normalizeLookupKey(clean), concept);
  addRawIndex(index, "__all__", concept);
}

function addRawIndex(index: Map<string, OkfConcept[]>, key: string, concept: OkfConcept): void {
  if (!key) return;
  const list = index.get(key) ?? [];
  if (!list.some((item) => item.id === concept.id)) list.push(concept);
  index.set(key, list);
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[\s、，,。:：;；/\\_\-.()[\]（）【】"'`]+/g, "");
}

function relativeMarkdownPath(fromNotePath: string, toNotePath: string): string {
  const fromParts = dirName(fromNotePath).split("/").filter(Boolean);
  const toParts = toNotePath.split("/").filter(Boolean);
  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  const up = fromParts.map(() => "..");
  const rel = [...up, ...toParts].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function markdownLinkDestination(destination: string): string {
  if (!/[\s<>()]/.test(destination)) return destination;
  return `<${destination.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
}
