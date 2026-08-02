// Atomic Node move / reparent: keep cx- stable, reorder or reparent under DropPosition,
// rewrite path links only when the folder path changes, roll back on post-move failure.

import { withTentMutation, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { buildNodeIndex } from "./okf.js";
import type { OpsEnv } from "./ops-context.js";
import { loadOrder, saveOrder, ROOT_KEY } from "./order.js";
import { isOperationalPath } from "./paths.js";
import {
  assertNoActiveTaskRefsInSubtree,
  rewriteNodeLinks,
  type RewriteNodeLinksOptions,
} from "./renameOps.js";
import type { Node } from "./types.js";
import {
  nodeNotePath,
  dirName,
  assertContentMutable,
  isUsableNode,
  join,
  loadTent,
  type LoadedTent,
} from "./tree.js";

/** Drop position: become child of target (inside) or insert before/after a sibling. */
export type MovePosition =
  | { mode: "inside" }
  | { mode: "before"; siblingId: string }
  | { mode: "after"; siblingId: string };

export interface MoveNodeResult {
  id: string;
  oldPath: string;
  path: string;
  /** Full old→new path map for the moved subtree (root + descendants). Identity map when reorder-only. */
  pathMap: Record<string, string>;
  rewrittenNotes: string[];
}

type PlannedWrite = {
  writePath: string;
  originalPath: string;
  originalContent: string;
  newContent: string;
};

/**
 * Move or reorder a Node by stable `cx-`.
 * - `cx-` / frontmatter id never change; folder stem (display name) is preserved
 * - reparent: move directory tree, rewrite path-based links, roll back on failure
 * - same-parent reorder: order.json only — no link rewrite
 * - structural occupation: an active ref anywhere in the moved subtree blocks
 *   the move; destination-parent occupation alone does not
 */
export async function moveNode(
  env: OpsEnv,
  nodeId: string,
  newParentId: string | null,
  position: MovePosition
): Promise<MoveNodeResult> {
  return withTentMutation(env.fs, async () =>
    moveNodeUnlocked(env, nodeId, newParentId, position)
  );
}

async function moveNodeUnlocked(
  env: OpsEnv,
  nodeId: string,
  newParentId: string | null,
  position: MovePosition
): Promise<MoveNodeResult> {
  const id = nodeId.trim();
  if (!id) throw new Error("Node id is required for move.");

  const tent = await loadTent(env.fs);
  const moved = tent.byId.get(id);
  if (!moved) throw new Error(`Node not found: ${id}.`);
  if (!isUsableNode(moved)) throw new Error("Invalid or archived nodes cannot be moved.");
  assertContentMutable(moved, "moved");
  if (moved.invalid || moved.archived) {
    throw new Error("Invalid or archived nodes cannot be moved.");
  }
  assertNotOperationalPath(moved.path);

  await assertNoActiveTaskRefsInSubtree(env, moved, "move");

  const parentNode = resolveNewParent(tent, newParentId);
  if (parentNode) {
    if (!isUsableNode(parentNode)) throw new Error("Target parent node is invalid or archived.");
    assertContentMutable(parentNode, "used as move parent");
    assertNotOperationalPath(parentNode.path);
  }

  const newParentPath = parentNode ? parentNode.path : "";
  if (newParentPath === moved.path || newParentPath.startsWith(moved.path + "/")) {
    throw new Error("Cannot move a node into its own subtree.");
  }

  // Validate before/after sibling belongs under the destination parent.
  if (position.mode !== "inside") {
    const sibling = tent.byId.get(position.siblingId);
    if (!sibling) throw new Error(`Sibling not found: ${position.siblingId}.`);
    const siblingParentId = sibling.parent ? sibling.parent.id : null;
    const destParentId = parentNode ? parentNode.id : null;
    if (siblingParentId !== destParentId) {
      throw new Error("before/after sibling must be under the destination parent.");
    }
    if (sibling.id === moved.id) {
      throw new Error("Cannot position a node relative to itself.");
    }
  }

  const oldPath = moved.path;
  const movedName = moved.name;
  const destination = join(newParentPath, movedName);
  const parentChanged = dirName(oldPath) !== newParentPath;

  if (parentChanged) {
    if (await env.fs.exists(destination)) {
      throw new Error(`Move target already exists: ${destination}.`);
    }
    // Name collision among destination siblings (tree may lag FS in edge cases).
    const destSiblings = parentNode ? parentNode.children : tent.roots;
    if (destSiblings.some((node) => node.id !== moved.id && node.name === movedName)) {
      throw new Error(`A sibling Node already uses the name: ${movedName}.`);
    }
  }

  const parentKey = parentNode ? parentNode.id : ROOT_KEY;
  const oldParentKey = moved.parent ? moved.parent.id : ROOT_KEY;

  const siblings = (parentNode ? parentNode.children : tent.roots)
    .filter((b) => b.id !== moved.id)
    .map((b) => b.id);

  let insertAt: number;
  if (position.mode === "inside") {
    insertAt = siblings.length;
  } else {
    const idx = siblings.indexOf(position.siblingId);
    insertAt = idx === -1 ? siblings.length : position.mode === "before" ? idx : idx + 1;
  }
  siblings.splice(insertAt, 0, moved.id);

  // Same-parent reorder: order only — no pathMap rewrite, no FS move.
  if (!parentChanged) {
    const order = await loadOrder(env.fs);
    order[parentKey] = siblings;
    await saveOrder(env.fs, order);
    const identityMap: Record<string, string> = {};
    for (const node of collectSubtree(moved)) {
      identityMap[node.path] = node.path;
      identityMap[nodeNotePath(node.path).replace(/\.md$/i, "")] = nodeNotePath(node.path).replace(
        /\.md$/i,
        ""
      );
    }
    return {
      id: moved.id,
      oldPath,
      path: oldPath,
      pathMap: identityMap,
      rewrittenNotes: [],
    };
  }

  // ---- Reparent: pathMap + link rewrite + FS move + order + rollback ----
  const subtree = collectSubtree(moved);
  const pathMap = new Map<string, string>();
  for (const node of subtree) {
    const rel = relativePath(oldPath, node.path);
    const nextNodePath = rel ? join(destination, rel) : destination;
    pathMap.set(node.path, nextNodePath);
    pathMap.set(
      nodeNotePath(node.path).replace(/\.md$/i, ""),
      nodeNotePath(nextNodePath).replace(/\.md$/i, "")
    );
  }

  const conceptIndex = buildNodeIndex(tent.byPath.values());
  const rewriteOpts: RewriteNodeLinksOptions = {
    renameNodeId: moved.id,
    conceptIndex,
  };

  // Display name unchanged on reparent — path links rewrite; bare names stay.
  // Resolve relatives against pre-move note path; restyle from post-move path so depth changes stay valid.
  const plannedWrites: PlannedWrite[] = [];
  const rewrittenNotes: string[] = [];
  for (const node of tent.byPath.values()) {
    const notePath = nodeNotePath(node.path);
    if (!(await env.fs.exists(notePath))) continue;
    const raw = await env.fs.readFile(notePath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    if (typeof data.id === "string" && data.id !== node.id) {
      throw new Error(`Refuse move: frontmatter id drift on ${node.path}.`);
    }
    const afterNodePath = pathMap.get(node.path) ?? node.path;
    const restyleFromNotePath = nodeNotePath(afterNodePath);
    const rewritten = rewriteNodeLinks(body, notePath, pathMap, movedName, movedName, {
      ...rewriteOpts,
      restyleFromNotePath,
    });
    if (!rewritten.changed) continue;
    plannedWrites.push({
      writePath: restyleFromNotePath,
      originalPath: notePath,
      originalContent: raw,
      newContent: serializeFrontmatter(data, rewritten.body, keyOrder),
    });
    rewrittenNotes.push(afterNodePath);
  }

  const orderBefore = await loadOrder(env.fs);
  const orderSnapshot = JSON.stringify(orderBefore);

  await env.fs.move(oldPath, destination);

  const completedWrites: PlannedWrite[] = [];
  try {
    for (const write of plannedWrites) {
      await env.fs.writeFile(write.writePath, write.newContent);
      completedWrites.push(write);
    }
    const order = JSON.parse(orderSnapshot) as Record<string, string[]>;
    if (order[oldParentKey]) {
      order[oldParentKey] = order[oldParentKey]!.filter((sid) => sid !== moved.id);
    }
    order[parentKey] = siblings;
    await saveOrder(env.fs, order);
  } catch (error) {
    await rollbackMove(env.fs, {
      oldPath,
      newPath: destination,
      completedWrites,
      orderSnapshot,
    });
    throw error;
  }

  const pathMapRecord: Record<string, string> = {};
  for (const [from, to] of pathMap) pathMapRecord[from] = to;

  return {
    id: moved.id,
    oldPath,
    path: destination,
    pathMap: pathMapRecord,
    rewrittenNotes: rewrittenNotes.sort(),
  };
}

/**
 * Restore completed note writes, move tree back, restore order.json snapshot.
 */
async function rollbackMove(
  fs: FsAdapter,
  args: {
    oldPath: string;
    newPath: string;
    completedWrites: PlannedWrite[];
    orderSnapshot: string;
  }
): Promise<void> {
  const { oldPath, newPath, completedWrites, orderSnapshot } = args;
  const restoreErrors: string[] = [];

  for (let i = completedWrites.length - 1; i >= 0; i--) {
    const write = completedWrites[i]!;
    try {
      await fs.writeFile(write.writePath, write.originalContent);
    } catch (err) {
      restoreErrors.push(
        `note ${write.writePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  try {
    if ((await fs.exists(newPath)) && !(await fs.exists(oldPath))) {
      await fs.move(newPath, oldPath);
    }
  } catch (err) {
    restoreErrors.push(`tree: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await saveOrder(fs, JSON.parse(orderSnapshot) as Record<string, string[]>);
  } catch (err) {
    restoreErrors.push(`order: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (restoreErrors.length > 0) {
    throw new Error(
      `Move failed after filesystem move, and rollback also failed: ${restoreErrors.join("; ")}`
    );
  }
}

function resolveNewParent(tent: LoadedTent, newParentId: string | null): Node | null {
  if (newParentId === null || newParentId === undefined || newParentId === "") {
    return null;
  }
  const parent = tent.byId.get(newParentId.trim());
  if (!parent) throw new Error(`Target parent not found: ${newParentId}.`);
  return parent;
}

function assertNotOperationalPath(path: string): void {
  if (isOperationalPath(path) || path === "temp" || path.startsWith("temp/")) {
    throw new Error("temp/ and other system pipelines cannot be moved as Nodes.");
  }
  const top = path.split("/")[0] ?? "";
  if (top === "attachments" || top === ".tent") {
    throw new Error("System directories cannot be moved as Nodes.");
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
