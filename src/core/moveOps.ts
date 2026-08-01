// Atomic concept move / reparent: keep cx- stable, reorder or reparent under DropPosition,
// rewrite path links only when the folder path changes, roll back on post-move failure.

import { withTentMutation, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { buildConceptIndex } from "./okf.js";
import type { OpsEnv } from "./ops-context.js";
import { loadOrder, saveOrder, ROOT_KEY } from "./order.js";
import { isOperationalPath } from "./paths.js";
import {
  assertNoActiveTaskRefsInSubtree,
  rewriteConceptLinks,
  type RewriteConceptLinksOptions,
} from "./renameOps.js";
import type { Box } from "./types.js";
import {
  boxNotePath,
  dirName,
  assertContentMutable,
  isUsableBox,
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
 * Move or reorder a concept by stable `cx-`.
 * - `cx-` / frontmatter id never change; folder stem (display name) is preserved
 * - reparent: move directory tree, rewrite path-based links, roll back on failure
 * - same-parent reorder: order.json only — no link rewrite
 * - structural occupation: an active ref anywhere in the moved subtree blocks
 *   the move; destination-parent occupation alone does not
 */
export async function moveNode(
  env: OpsEnv,
  conceptId: string,
  newParentId: string | null,
  position: MovePosition
): Promise<MoveNodeResult> {
  return withTentMutation(env.fs, async () =>
    moveNodeUnlocked(env, conceptId, newParentId, position)
  );
}

async function moveNodeUnlocked(
  env: OpsEnv,
  conceptId: string,
  newParentId: string | null,
  position: MovePosition
): Promise<MoveNodeResult> {
  const id = conceptId.trim();
  if (!id) throw new Error("Concept id is required for move.");

  const tent = await loadTent(env.fs);
  const moved = tent.byId.get(id);
  if (!moved) throw new Error(`Concept not found: ${id}.`);
  if (!isUsableBox(moved)) throw new Error("Invalid or archived boxes cannot be moved.");
  assertContentMutable(moved, "moved");
  if (moved.invalid || moved.archived) {
    throw new Error("Invalid or archived boxes cannot be moved.");
  }
  assertNotOperationalPath(moved.path);

  await assertNoActiveTaskRefsInSubtree(env, moved, "move");

  const parentBox = resolveNewParent(tent, newParentId);
  if (parentBox) {
    if (!isUsableBox(parentBox)) throw new Error("Target parent box is invalid or archived.");
    assertContentMutable(parentBox, "used as move parent");
    assertNotOperationalPath(parentBox.path);
  }

  const newParentPath = parentBox ? parentBox.path : "";
  if (newParentPath === moved.path || newParentPath.startsWith(moved.path + "/")) {
    throw new Error("Cannot move a box into its own subtree.");
  }

  // Validate before/after sibling belongs under the destination parent.
  if (position.mode !== "inside") {
    const sibling = tent.byId.get(position.siblingId);
    if (!sibling) throw new Error(`Sibling not found: ${position.siblingId}.`);
    const siblingParentId = sibling.parent ? sibling.parent.id : null;
    const destParentId = parentBox ? parentBox.id : null;
    if (siblingParentId !== destParentId) {
      throw new Error("before/after sibling must be under the destination parent.");
    }
    if (sibling.id === moved.id) {
      throw new Error("Cannot position a box relative to itself.");
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
    const destSiblings = parentBox ? parentBox.children : tent.roots;
    if (destSiblings.some((box) => box.id !== moved.id && box.name === movedName)) {
      throw new Error(`A sibling concept already uses the name: ${movedName}.`);
    }
  }

  const parentKey = parentBox ? parentBox.id : ROOT_KEY;
  const oldParentKey = moved.parent ? moved.parent.id : ROOT_KEY;

  const siblings = (parentBox ? parentBox.children : tent.roots)
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
    for (const box of collectSubtree(moved)) {
      identityMap[box.path] = box.path;
      identityMap[boxNotePath(box.path).replace(/\.md$/i, "")] = boxNotePath(box.path).replace(
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
  for (const box of subtree) {
    const rel = relativePath(oldPath, box.path);
    const nextBoxPath = rel ? join(destination, rel) : destination;
    pathMap.set(box.path, nextBoxPath);
    pathMap.set(
      boxNotePath(box.path).replace(/\.md$/i, ""),
      boxNotePath(nextBoxPath).replace(/\.md$/i, "")
    );
  }

  const conceptIndex = buildConceptIndex(tent.byPath.values());
  const rewriteOpts: RewriteConceptLinksOptions = {
    renameBoxId: moved.id,
    conceptIndex,
  };

  // Display name unchanged on reparent — path links rewrite; bare names stay.
  // Resolve relatives against pre-move note path; restyle from post-move path so depth changes stay valid.
  const plannedWrites: PlannedWrite[] = [];
  const rewrittenNotes: string[] = [];
  for (const box of tent.byPath.values()) {
    const notePath = boxNotePath(box.path);
    if (!(await env.fs.exists(notePath))) continue;
    const raw = await env.fs.readFile(notePath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    if (typeof data.id === "string" && data.id !== box.id) {
      throw new Error(`Refuse move: frontmatter id drift on ${box.path}.`);
    }
    const afterBoxPath = pathMap.get(box.path) ?? box.path;
    const restyleFromNotePath = boxNotePath(afterBoxPath);
    const rewritten = rewriteConceptLinks(body, notePath, pathMap, movedName, movedName, {
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
    rewrittenNotes.push(afterBoxPath);
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

function resolveNewParent(tent: LoadedTent, newParentId: string | null): Box | null {
  if (newParentId === null || newParentId === undefined || newParentId === "") {
    return null;
  }
  const parent = tent.byId.get(newParentId.trim());
  if (!parent) throw new Error(`Target parent not found: ${newParentId}.`);
  return parent;
}

function assertNotOperationalPath(path: string): void {
  if (isOperationalPath(path) || path === "temp" || path.startsWith("temp/")) {
    throw new Error("temp/ and other system pipelines cannot be moved as concepts.");
  }
  const top = path.split("/")[0] ?? "";
  if (top === "attachments" || top === ".tent") {
    throw new Error("System directories cannot be moved as concepts.");
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
