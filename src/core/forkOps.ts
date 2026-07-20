import { withTentMutation, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { makeUniqueConceptId } from "./id.js";
import { loadOrder, ROOT_KEY, saveOrder } from "./order.js";
import type { OpsEnv } from "./ops-context.js";
import { type Box } from "./types.js";
import { assertContentMutable, baseName, boxNotePath, dirName, isUsableBox, join, loadTent } from "./tree.js";

export async function forkNode(env: OpsEnv, boxId: string): Promise<string> {
  return withTentMutation(env.fs, async () => forkNodeUnlocked(env, boxId));
}

async function forkNodeUnlocked(env: OpsEnv, boxId: string): Promise<string> {
  const tent = await loadTent(env.fs);
  if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  const source = tent.byId.get(boxId);
  if (!source) throw new Error(`Box not found: ${boxId}.`);
  if (!isUsableBox(source)) throw new Error("Invalid or archived boxes cannot be forked.");
  assertContentMutable(source, "forked");

  const parentPath = dirName(source.path);
  const forkPath = await uniqueSiblingPath(env.fs, parentPath, `${source.name} (fork)`);
  await copyTree(env.fs, source.path, forkPath);

  const sourceBoxes = collectSubtree(source);
  const usedIds = new Set(tent.byId.keys());
  const idMap = new Map<string, string>();
  for (const box of sourceBoxes) {
    const nextId = makeUniqueConceptId(usedIds, env.rand);
    usedIds.add(nextId);
    idMap.set(box.id, nextId);
  }

  const forkRootId = idMap.get(source.id)!;
  for (const box of sourceBoxes) {
    const rel = relativePath(source.path, box.path);
    const nextPath = rel ? join(forkPath, rel) : forkPath;
    const notePath = boxNotePath(nextPath);
    await ensureIdentityFileName(env.fs, nextPath, box.path);
    const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(notePath));
    data.id = idMap.get(box.id)!;
    delete data.owner;
    delete data.status;
    delete data.forkOf;
    delete data.forkBase;
    await env.fs.writeFile(notePath, serializeFrontmatter(data, body, keyOrder));
  }

  const order = await loadOrder(env.fs);
  const parentKey = source.parent ? source.parent.id : ROOT_KEY;
  const siblings = (source.parent ? source.parent.children : tent.roots).map((box) => box.id);
  const idx = siblings.indexOf(source.id);
  siblings.splice(idx === -1 ? siblings.length : idx + 1, 0, forkRootId);
  order[parentKey] = siblings;
  for (const box of sourceBoxes) {
    const oldChildren = order[box.id];
    const newId = idMap.get(box.id);
    if (oldChildren && newId) {
      order[newId] = oldChildren
        .map((id) => idMap.get(id))
        .filter((id): id is string => !!id);
    }
  }
  await saveOrder(env.fs, order);

  return forkRootId;
}

/** Obsidian 原生复制后的收编：复制树保留名字/内容，重发 id 并清 owner/status。 */
export async function adoptCopiedSubtree(env: OpsEnv, boxPath: string): Promise<string[]> {
  return withTentMutation(env.fs, async () => {
    await normalizeCopiedRootIdentity(env.fs, boxPath);
    const tent = await loadTent(env.fs);
    const root = tent.byPath.get(boxPath);
    if (!root) throw new Error(`Copied box not found: ${boxPath}.`);
    const copied = collectSubtree(root);
    const copiedPaths = new Set(copied.map((box) => box.path));
    const outsideIds = new Set(
      [...tent.byPath.values()]
        .filter((box) => !copiedPaths.has(box.path) && box.id)
        .map((box) => box.id)
    );
    const hasDuplicate = copied.some((box) => outsideIds.has(box.id));
    if (!hasDuplicate) return [];

    const idMap = new Map<string, string>();
    for (const box of copied) {
      const next = makeUniqueConceptId(outsideIds, env.rand);
      outsideIds.add(next);
      idMap.set(box.id, next);
    }
    for (const box of copied) {
      const path = boxNotePath(box.path);
      const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(path));
      data.id = idMap.get(box.id)!;
      delete data.owner;
      delete data.status;
      delete data.forkOf;
      delete data.forkBase;
      await env.fs.writeFile(path, serializeFrontmatter(data, body, keyOrder));
    }

    const order = await loadOrder(env.fs);
    for (const box of copied) {
      const children = order[box.id];
      const nextId = idMap.get(box.id);
      if (children && nextId) {
        order[nextId] = children.map((id) => idMap.get(id)).filter((id): id is string => !!id);
      }
    }
    await saveOrder(env.fs, order);
    return copied.map((box) => idMap.get(box.id)!);
  });
}

async function normalizeCopiedRootIdentity(fs: FsAdapter, boxPath: string): Promise<void> {
  const expected = boxNotePath(boxPath);
  if (await fs.exists(expected) || !(await fs.exists(boxPath))) return;
  const candidates: string[] = [];
  for (const entry of await fs.listDir(boxPath)) {
    if (entry.isDir || !entry.name.endsWith(".md") || entry.name === "index.md") continue;
    const candidate = join(boxPath, entry.name);
    const { data } = parseFrontmatter(await fs.readFile(candidate));
    if (
      typeof data.id === "string" &&
      (data.id.startsWith("bx-") || data.id.startsWith("cx-")) &&
      typeof data.type === "string"
    ) {
      candidates.push(candidate);
    }
  }
  if (candidates.length === 1) await fs.move(candidates[0], expected);
}

async function uniqueSiblingPath(fs: FsAdapter, parentPath: string, base: string): Promise<string> {
  let n = 1;
  while (true) {
    const name = n === 1 ? base : `${base.replace(/\s\(fork\)$/, "")} (fork ${n})`;
    const candidate = join(parentPath, name);
    if (!(await fs.exists(candidate))) return candidate;
    n += 1;
  }
}

async function copyTree(fs: FsAdapter, from: string, to: string): Promise<void> {
  await fs.mkdir(to);
  for (const entry of await fs.listDir(from)) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDir) await copyTree(fs, src, dst);
    else await fs.writeFile(dst, await fs.readFile(src));
  }
}

function collectSubtree(box: Box, out: Box[] = []): Box[] {
  out.push(box);
  for (const child of box.children) collectSubtree(child, out);
  return out;
}

function relativePath(root: string, child: string): string {
  if (child === root) return "";
  return child.slice(root.length + 1);
}

async function ensureIdentityFileName(fs: FsAdapter, newBoxPath: string, oldBoxPath: string): Promise<void> {
  const expected = boxNotePath(newBoxPath);
  if (await fs.exists(expected)) return;
  const oldName = `${baseName(oldBoxPath)}.md`;
  const copied = join(newBoxPath, oldName);
  if (await fs.exists(copied)) await fs.move(copied, expected);
}
