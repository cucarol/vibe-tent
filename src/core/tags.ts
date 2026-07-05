import { FsAdapter, withTentMutation } from "./adapter.js";
import { BOX_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { boxNotePath, isUsableBox, loadTent } from "./tree.js";
import { backupCorruptRegistry, warnRegistryRecovered } from "./registryRecovery.js";
import type { Box } from "./types.js";

export const TAGS_REGISTRY_PATH = ".tent/tags.json";
export const DEFAULT_TAG_REGISTRY: TagRegistry = { tags: ["decision"] };

export interface TagRegistry {
  tags: string[];
}

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
  if (!(await fs.exists(".tent"))) await fs.mkdir(".tent");
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
