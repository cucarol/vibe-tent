import { FsAdapter, withTentMutation } from "./adapter.js";
import { BOX_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { assertContentMutable, boxNotePath, isUsableBox, loadTent } from "./tree.js";
import { backupCorruptRegistry, warnRegistryRecovered } from "./registryRecovery.js";
import type { Box } from "./types.js";

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
    const recovered = await recoverTagRegistryFromBoxes(fs);
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

export async function addTag(fs: FsAdapter, boxId: string, name: string): Promise<void> {
  await withTentMutation(fs, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs);
    if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be tagged.");
    assertContentMutable(box, "tagged");
    await addRegistryTagUnlocked(fs, tag);
    const tags = uniqueSorted([...box.tags, tag]);
    await writeBoxTags(fs, box, tags);
  });
}

export async function removeTag(fs: FsAdapter, boxId: string, name: string): Promise<void> {
  await withTentMutation(fs, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs);
    if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be tagged.");
    assertContentMutable(box, "tagged");
    await writeBoxTags(fs, box, box.tags.filter((item) => item !== tag));
  });
}

export async function removeRegistryTag(fs: FsAdapter, name: string): Promise<void> {
  await withTentMutation(fs, async () => {
    const tag = normalizeTagName(name);
    const registry = await loadTagRegistry(fs);
    await saveTagRegistryUnlocked(fs, { tags: registry.tags.filter((item) => item !== tag) });
    const tent = await loadTent(fs);
    for (const box of tent.byId.values()) {
      if (box.tags.includes(tag)) {
        await writeBoxTags(fs, box, box.tags.filter((item) => item !== tag));
      }
    }
  });
}

/**
 * After one box's frontmatter tags change (patchBox / docs.write / raw write), keep
 * tags.json aligned with Node facts without a second Service-side registry writer.
 *
 * - Newly used tags are auto-registered (pick-list).
 * - Removed tags are pruned only when no other usable box still carries them.
 * - Registry-only tags (tag-new, never on a Node) are left alone.
 *
 * Caller that already holds the mutation lock must use the Unlocked form.
 */
export async function syncTagRegistryAfterBoxTagsChange(
  fs: FsAdapter,
  previousTags: readonly string[],
  nextTags: readonly string[],
  usage: { excludeBoxId: string; tent: { byId: Map<string, Box> } }
): Promise<void> {
  await withTentMutation(fs, async () => {
    await syncTagRegistryAfterBoxTagsChangeUnlocked(fs, previousTags, nextTags, usage);
  });
}

/** Mutation-lock-free form for nested Core writers (patchBoxUnlocked, etc.). */
export async function syncTagRegistryAfterBoxTagsChangeUnlocked(
  fs: FsAdapter,
  previousTags: readonly string[],
  nextTags: readonly string[],
  usage: { excludeBoxId: string; tent: { byId: Map<string, Box> } }
): Promise<void> {
  const previous = new Set(normalizeTagList(previousTags));
  const next = new Set(normalizeTagList(nextTags));
  const added = [...next].filter((tag) => !previous.has(tag));
  const removed = [...previous].filter((tag) => !next.has(tag));
  if (added.length === 0 && removed.length === 0) return;

  for (const tag of added) {
    await addRegistryTagUnlocked(fs, tag);
  }

  if (removed.length === 0) return;

  const stillUsed = new Set<string>();
  for (const tag of next) stillUsed.add(tag);
  for (const box of usage.tent.byId.values()) {
    if (box.id === usage.excludeBoxId) continue;
    for (const tag of box.tags) {
      if (removed.includes(tag)) stillUsed.add(tag);
    }
  }

  const toPrune = removed.filter((tag) => !stillUsed.has(tag));
  if (toPrune.length === 0) return;

  const registry = await loadTagRegistry(fs);
  const pruned = registry.tags.filter((tag) => !toPrune.includes(tag));
  if (pruned.length !== registry.tags.length) {
    await saveTagRegistryUnlocked(fs, { tags: pruned });
  }
}

export function findBoxesByTag(tent: { byId: Map<string, Box> }, name: string): Box[] {
  const tag = normalizeTagName(name);
  return [...tent.byId.values()]
    .filter((box) => box.tags.includes(tag))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function normalizeTagName(name: string): string {
  const tag = name.trim();
  if (!tag) throw new Error("Tag name cannot be empty.");
  if (/[\/\\\r\n]/.test(tag)) throw new Error("Tag name cannot contain path separators or newlines.");
  return tag;
}

async function writeBoxTags(fs: FsAdapter, box: Box, tags: string[]): Promise<void> {
  const path = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs.readFile(path));
  const next = uniqueSorted(tags);
  if (next.length === 0) delete data.tags;
  else data.tags = next;
  await fs.writeFile(path, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
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

async function recoverTagRegistryFromBoxes(fs: FsAdapter): Promise<TagRegistry> {
  const tent = await loadTent(fs);
  const tags: string[] = [];
  for (const box of tent.byPath.values()) {
    tags.push(...box.tags);
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

function boxKeyOrder(existing: string[]): string[] {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key)),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
