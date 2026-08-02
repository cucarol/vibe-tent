import { withTentMutation, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { makeUniqueNodeId } from "./id.js";
import { loadOrder, ROOT_KEY, saveOrder } from "./order.js";
import type { OpsEnv } from "./ops-context.js";
import { type Node } from "./types.js";
import { assertContentMutable, baseName, nodeNotePath, dirName, isUsableNode, join, loadTent } from "./tree.js";

export async function forkNode(env: OpsEnv, nodeId: string): Promise<string> {
  return withTentMutation(env.fs, async () => forkNodeUnlocked(env, nodeId));
}

async function forkNodeUnlocked(env: OpsEnv, nodeId: string): Promise<string> {
  const tent = await loadTent(env.fs);
  if (tent.duplicateIds.has(nodeId)) throw new Error(`Duplicate node id '${nodeId}' found; repair or fork the duplicate nodes before using this id.`);
  const source = tent.byId.get(nodeId);
  if (!source) throw new Error(`Node not found: ${nodeId}.`);
  if (!isUsableNode(source)) throw new Error("Invalid or archived nodes cannot be forked.");
  assertContentMutable(source, "forked");

  const parentPath = dirName(source.path);
  const forkPath = await uniqueSiblingPath(env.fs, parentPath, `${source.name} (fork)`);
  await copyTree(env.fs, source.path, forkPath);

  const sourceNodes = collectSubtree(source);
  const usedIds = new Set(tent.byId.keys());
  const idMap = new Map<string, string>();
  for (const node of sourceNodes) {
    const nextId = makeUniqueNodeId(usedIds, env.rand);
    usedIds.add(nextId);
    idMap.set(node.id, nextId);
  }

  const forkRootId = idMap.get(source.id)!;
  for (const node of sourceNodes) {
    const rel = relativePath(source.path, node.path);
    const nextPath = rel ? join(forkPath, rel) : forkPath;
    const notePath = nodeNotePath(nextPath);
    await ensureIdentityFileName(env.fs, nextPath, node.path);
    const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(notePath));
    data.id = idMap.get(node.id)!;
    delete data.owner;
    delete data.status;
    delete data.forkOf;
    delete data.forkBase;
    await env.fs.writeFile(notePath, serializeFrontmatter(data, body, keyOrder));
  }

  const order = await loadOrder(env.fs);
  const parentKey = source.parent ? source.parent.id : ROOT_KEY;
  const siblings = (source.parent ? source.parent.children : tent.roots).map((node) => node.id);
  const idx = siblings.indexOf(source.id);
  siblings.splice(idx === -1 ? siblings.length : idx + 1, 0, forkRootId);
  order[parentKey] = siblings;
  for (const node of sourceNodes) {
    const oldChildren = order[node.id];
    const newId = idMap.get(node.id);
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
export async function adoptCopiedSubtree(env: OpsEnv, nodePath: string): Promise<string[]> {
  return withTentMutation(env.fs, async () => {
    await normalizeCopiedRootIdentity(env.fs, nodePath);
    const tent = await loadTent(env.fs);
    const root = tent.byPath.get(nodePath);
    if (!root) throw new Error(`Copied node not found: ${nodePath}.`);
    const copied = collectSubtree(root);
    const copiedPaths = new Set(copied.map((node) => node.path));
    const outsideIds = new Set(
      [...tent.byPath.values()]
        .filter((node) => !copiedPaths.has(node.path) && node.id)
        .map((node) => node.id)
    );
    const hasDuplicate = copied.some((node) => outsideIds.has(node.id));
    if (!hasDuplicate) return [];

    const idMap = new Map<string, string>();
    for (const node of copied) {
      const next = makeUniqueNodeId(outsideIds, env.rand);
      outsideIds.add(next);
      idMap.set(node.id, next);
    }
    for (const node of copied) {
      const path = nodeNotePath(node.path);
      const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(path));
      data.id = idMap.get(node.id)!;
      delete data.owner;
      delete data.status;
      delete data.forkOf;
      delete data.forkBase;
      await env.fs.writeFile(path, serializeFrontmatter(data, body, keyOrder));
    }

    const order = await loadOrder(env.fs);
    for (const node of copied) {
      const children = order[node.id];
      const nextId = idMap.get(node.id);
      if (children && nextId) {
        order[nextId] = children.map((id) => idMap.get(id)).filter((id): id is string => !!id);
      }
    }
    await saveOrder(env.fs, order);
    return copied.map((node) => idMap.get(node.id)!);
  });
}

async function normalizeCopiedRootIdentity(fs: FsAdapter, nodePath: string): Promise<void> {
  const expected = nodeNotePath(nodePath);
  if (await fs.exists(expected) || !(await fs.exists(nodePath))) return;
  const candidates: string[] = [];
  for (const entry of await fs.listDir(nodePath)) {
    if (entry.isDir || !entry.name.endsWith(".md") || entry.name === "index.md") continue;
    const candidate = join(nodePath, entry.name);
    const { data } = parseFrontmatter(await fs.readFile(candidate));
    if (
      typeof data.id === "string" &&
      data.id.startsWith("cx-") &&
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

function collectSubtree(node: Node, out: Node[] = []): Node[] {
  out.push(node);
  for (const child of node.children) collectSubtree(child, out);
  return out;
}

function relativePath(root: string, child: string): string {
  if (child === root) return "";
  return child.slice(root.length + 1);
}

async function ensureIdentityFileName(fs: FsAdapter, newNodePath: string, oldNodePath: string): Promise<void> {
  const expected = nodeNotePath(newNodePath);
  if (await fs.exists(expected)) return;
  const oldName = `${baseName(oldNodePath)}.md`;
  const copied = join(newNodePath, oldName);
  if (await fs.exists(copied)) await fs.move(copied, expected);
}
