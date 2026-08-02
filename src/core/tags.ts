import { FsAdapter, withTentMutation } from "./adapter.js";
import { NODE_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { assertContentMutable, nodeNotePath, isUsableNode, loadTent } from "./tree.js";
import { backupCorruptRegistry, warnRegistryRecovered } from "./registryRecovery.js";
import type { Node } from "./types.js";

import { TAGS_REGISTRY_PATH } from "./paths.js";
export { TAGS_REGISTRY_PATH };
export const DEFAULT_TAG_REGISTRY: TagRegistry = { tags: [] };

export interface TagRegistry {
  tags: string[];
}

/** 正常路径只读扁平 tags.json；嵌套 `.tent/tags.json` 由一次性迁移搬迁。 */
export async function loadTagRegistry(fs: FsAdapter): Promise<TagRegistry> {
  if (!(await fs.exists(TAGS_REGISTRY_PATH))) return { tags: [] };
  try {
    return normalizeRegistry(JSON.parse(await fs.readFile(TAGS_REGISTRY_PATH)));
  } catch {
    const backupPath = await backupCorruptRegistry(fs, TAGS_REGISTRY_PATH);
    const recovered = await recoverTagRegistryFromNodes(fs);
    await saveTagRegistryUnlocked(fs, recovered);
    warnRegistryRecovered(TAGS_REGISTRY_PATH, backupPath, "recovered");
    return recovered;
  }
}

export async function saveTagRegistry(fs: FsAdapter, registry: TagRegistry): Promise<void> {
  await withTentMutation(fs, async () => saveTagRegistryUnlocked(fs, registry));
}

async function saveTagRegistryUnlocked(fs: FsAdapter, registry: TagRegistry): Promise<void> {
  await fs.writeFile(TAGS_REGISTRY_PATH, JSON.stringify(normalizeRegistry(registry), null, 2) + "\n");
}

export async function addRegistryTag(fs: FsAdapter, name: string): Promise<void> {
  await withTentMutation(fs, async () => addRegistryTagUnlocked(fs, name));
}

async function addRegistryTagUnlocked(fs: FsAdapter, name: string): Promise<void> {
  const tag = normalizeTagName(name);
  const registry = await loadTagRegistry(fs);
  if (!registry.tags.includes(tag)) {
    registry.tags.push(tag);
    await saveTagRegistryUnlocked(fs, registry);
  }
}

export async function addTag(fs: FsAdapter, nodeId: string, name: string): Promise<void> {
  await withTentMutation(fs, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs);
    if (tent.duplicateIds.has(nodeId)) throw new Error(`Duplicate node id '${nodeId}' found; repair or fork the duplicate nodes before using this id.`);
    const node = tent.byId.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}.`);
    if (!isUsableNode(node)) throw new Error("Invalid or archived nodes cannot be tagged.");
    assertContentMutable(node, "tagged");
    await addRegistryTagUnlocked(fs, tag);
    const tags = uniqueSorted([...node.tags, tag]);
    await writeNodeTags(fs, node, tags);
  });
}

export async function removeTag(fs: FsAdapter, nodeId: string, name: string): Promise<void> {
  await withTentMutation(fs, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs);
    if (tent.duplicateIds.has(nodeId)) throw new Error(`Duplicate node id '${nodeId}' found; repair or fork the duplicate nodes before using this id.`);
    const node = tent.byId.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}.`);
    if (!isUsableNode(node)) throw new Error("Invalid or archived nodes cannot be tagged.");
    assertContentMutable(node, "tagged");
    await writeNodeTags(fs, node, node.tags.filter((item) => item !== tag));
  });
}

export async function removeRegistryTag(fs: FsAdapter, name: string): Promise<void> {
  await withTentMutation(fs, async () => {
    const tag = normalizeTagName(name);
    const registry = await loadTagRegistry(fs);
    await saveTagRegistryUnlocked(fs, { tags: registry.tags.filter((item) => item !== tag) });
    const tent = await loadTent(fs);
    for (const node of tent.byId.values()) {
      if (node.tags.includes(tag)) {
        await writeNodeTags(fs, node, node.tags.filter((item) => item !== tag));
      }
    }
  });
}

/**
 * After one node's frontmatter tags change (patchNode / docs.write / raw write),
 * auto-register any newly used tags into tags.json so the pick-list grows.
 *
 * Does **not** prune the registry when a Node drops a tag — same contract as
 * `removeTag`: Node detach only. Global delete + cascade remains explicit
 * `removeRegistryTag`. No other-Node scan is required.
 *
 * Caller that already holds the mutation lock must use the Unlocked form.
 */
export async function syncTagRegistryAfterNodeTagsChange(
  fs: FsAdapter,
  previousTags: readonly string[],
  nextTags: readonly string[]
): Promise<void> {
  await withTentMutation(fs, async () => {
    await syncTagRegistryAfterNodeTagsChangeUnlocked(fs, previousTags, nextTags);
  });
}

/** Mutation-lock-free form for nested Core writers (patchNodeUnlocked, etc.). */
export async function syncTagRegistryAfterNodeTagsChangeUnlocked(
  fs: FsAdapter,
  previousTags: readonly string[],
  nextTags: readonly string[]
): Promise<void> {
  const previous = new Set(normalizeTagList(previousTags));
  const next = normalizeTagList(nextTags);
  const added = next.filter((tag) => !previous.has(tag));
  for (const tag of added) {
    await addRegistryTagUnlocked(fs, tag);
  }
}

export function findNodesByTag(tent: { byId: Map<string, Node> }, name: string): Node[] {
  const tag = normalizeTagName(name);
  return [...tent.byId.values()]
    .filter((node) => node.tags.includes(tag))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function normalizeTagName(name: string): string {
  const tag = name.trim();
  if (!tag) throw new Error("Tag name cannot be empty.");
  if (/[\/\\\r\n]/.test(tag)) throw new Error("Tag name cannot contain path separators or newlines.");
  return tag;
}

async function writeNodeTags(fs: FsAdapter, node: Node, tags: string[]): Promise<void> {
  const path = nodeNotePath(node.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs.readFile(path));
  const next = uniqueSorted(tags);
  if (next.length === 0) delete data.tags;
  else data.tags = next;
  await fs.writeFile(path, serializeFrontmatter(data, body, nodeKeyOrder(keyOrder)));
}

function normalizeRegistry(value: unknown): TagRegistry {
  if (!isRecord(value) || !Array.isArray(value.tags)) return { tags: [] };
  const tags: string[] = [];
  for (const valueTag of value.tags) {
    if (typeof valueTag !== "string") continue;
    try {
      tags.push(normalizeTagName(valueTag));
    } catch {
      // tag registry 不是承重件;忽略坏条目而不是让整顶帐 fail-loud。
    }
  }
  return { tags: uniqueSorted(tags) };
}

async function recoverTagRegistryFromNodes(fs: FsAdapter): Promise<TagRegistry> {
  const tent = await loadTent(fs);
  const tags: string[] = [];
  for (const node of tent.byPath.values()) {
    tags.push(...node.tags);
  }
  return { tags: uniqueSorted(tags) };
}

function normalizeTagList(values: readonly string[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    try {
      const tag = normalizeTagName(value);
      if (!tags.includes(tag)) tags.push(tag);
    } catch {
      // ignore invalid names; writers normalize before persist
    }
  }
  return uniqueSorted(tags);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function nodeKeyOrder(existing: string[]): string[] {
  return [
    ...NODE_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !NODE_FRONTMATTER_KEY_ORDER.includes(key)),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
