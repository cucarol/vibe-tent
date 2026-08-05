import { FsAdapter, withTentMutation } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { Node } from "./types.js";
import { nodeNotePath, dirName, join, loadTent } from "./tree.js";
import { buildNodeIndex, resolveNode, type OkfNode } from "./okf-index.js";

export { buildNodeIndex, resolveNode, type OkfNode } from "./okf-index.js";

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
  const index = buildNodeIndex(concepts);
  const generatedFiles = await writeIndexes(fs, concepts);
  const projection = await projectWikiLinks(fs, concepts, index);
  return { generatedFiles, ...projection };
}

export function projectMarkdownLinks(
  body: string,
  fromNotePath: string,
  index: Map<string, OkfNode[]>
): { body: string; unresolved: string[]; changed: boolean } {
  const unresolved: string[] = [];
  let changed = false;
  const next = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (full, rawTarget: string, rawLabel: string | undefined, offset: number) => {
    if (offset > 0 && body[offset - 1] === "!") return full;
    const target = rawTarget.trim();
    const concept = resolveNode(index, target);
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
  nodes: Node[],
  index: Map<string, OkfNode[]>
): Promise<OkfProjectionResult> {
  const projectedFiles: string[] = [];
  const unresolved: { file: string; target: string }[] = [];
  for (const node of nodes) {
    const notePath = nodeNotePath(node.path);
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

async function writeIndexes(fs: FsAdapter, nodes: Node[]): Promise<string[]> {
  const generated = new Set<string>();
  const byDir = new Map<string, Node[]>();
  for (const node of nodes) {
    const dir = dirName(nodeNotePath(node.path));
    const list = byDir.get(dir) ?? [];
    list.push(node);
    byDir.set(dir, list);
  }

  const roots = nodes.filter((node) => !node.parent);
  await fs.writeFile(
    "index.md",
    serializeFrontmatter(
      { type: "index", okf_version: "0.1" },
      "# Index\n\n" + roots.map((node) => `- [${node.name}](${markdownLinkDestination(nodeNotePath(node.path))})`).join("\n") + "\n"
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
        "# Index\n\n" + siblings.map((node) => `- [${node.name}](${markdownLinkDestination(`${node.name}.md`)})`).join("\n") + "\n"
      )
    );
    generated.add(indexPath);
  }

  await fs.writeFile("log.md", serializeFrontmatter({ type: "log" }, "# Log\n\n_No log entries._\n"));
  generated.add("log.md");

  return [...generated].sort();
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
