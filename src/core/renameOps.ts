// Atomic concept rename: keep cx- stable, move folder + identity note, rewrite path links.
// On any post-move failure: restore every completed note write, then restore the tree.

import { withTentMutation, type FsAdapter } from "./adapter.js";
import { envelopeIsActiveOccupation, isFrozen } from "./claim.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { buildConceptIndex, resolveConcept, type OkfConcept } from "./okf.js";
import { normalizeTarget } from "../markdown/links.js";
import type { OpsEnv } from "./ops-context.js";
import { isOperationalPath } from "./paths.js";
import { validateBoxName } from "./scaffold.js";
import { loadTaskEnvelopes } from "./task.js";
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

export interface RenameNodeResult {
  id: string;
  oldPath: string;
  path: string;
  name: string;
  /** Full old→new path map for the moved subtree (root + descendants). */
  pathMap: Record<string, string>;
  rewrittenNotes: string[];
}

type PlannedWrite = {
  /** Path written after the tree move (mapped if note is in the moved subtree). */
  writePath: string;
  /** Original note path before the tree move. */
  originalPath: string;
  /** Byte-for-byte original file content (frontmatter + body). */
  originalContent: string;
  /** Full rewritten content to write after the move. */
  newContent: string;
};

/**
 * Rename a concept folder (and its same-named identity note).
 * - `cx-` / frontmatter id never change
 * - entire directory tree moves; child relative structure preserved
 * - path-based Markdown / wiki links rewritten in the same mutation
 * - unqualified wiki/name targets rewrite only when Tent resolution uniquely hits this node
 * - refuses target collision, illegal names, operational paths, occupancy
 * - on post-move failure: restore every touched note + tree
 */
export async function renameNode(
  env: OpsEnv,
  conceptIdOrPath: string,
  newNameRaw: string
): Promise<RenameNodeResult> {
  return withTentMutation(env.fs, async () => renameNodeUnlocked(env, conceptIdOrPath, newNameRaw));
}

async function renameNodeUnlocked(
  env: OpsEnv,
  conceptIdOrPath: string,
  newNameRaw: string
): Promise<RenameNodeResult> {
  const newName = validateBoxName(newNameRaw);
  const tent = await loadTent(env.fs);
  const target = resolveRenameTarget(tent, conceptIdOrPath);
  if (!isUsableBox(target)) {
    throw new Error("Invalid or archived boxes cannot be renamed.");
  }
  assertContentMutable(target, "renamed");
  if (isFrozen(target)) {
    throw new Error("Invalid or archived boxes cannot be renamed.");
  }
  await assertRenameOccupationAllowed(env, tent, target);

  const oldPath = target.path;
  const oldName = target.name;
  if (newName === oldName) {
    return {
      id: target.id,
      oldPath,
      path: oldPath,
      name: oldName,
      pathMap: { [oldPath]: oldPath },
      rewrittenNotes: [],
    };
  }

  const parentPath = dirName(oldPath);
  const newPath = join(parentPath, newName);
  assertNotOperationalPath(oldPath);
  assertNotOperationalPath(newPath);
  if (await env.fs.exists(newPath)) {
    throw new Error(`Rename target already exists: ${newPath}.`);
  }
  const siblings = target.parent ? target.parent.children : tent.roots;
  if (siblings.some((box) => box.id !== target.id && box.name === newName)) {
    throw new Error(`A sibling concept already uses the name: ${newName}.`);
  }

  const subtree = collectSubtree(target);
  const pathMap = new Map<string, string>();
  for (const box of subtree) {
    const rel = relativePath(oldPath, box.path);
    const nextBoxPath = rel ? join(newPath, rel) : newPath;
    // Concept path (folder) and identity-note path stem (folder/Name) both appear in links.
    pathMap.set(box.path, nextBoxPath);
    pathMap.set(
      boxNotePath(box.path).replace(/\.md$/i, ""),
      boxNotePath(nextBoxPath).replace(/\.md$/i, "")
    );
  }

  const conceptIndex = buildConceptIndex(tent.byPath.values());
  const rewriteOpts: RewriteConceptLinksOptions = {
    renameBoxId: target.id,
    conceptIndex,
  };

  // Plan rewrites against pre-move paths; snapshot original bytes for every touched note.
  const plannedWrites: PlannedWrite[] = [];
  const rewrittenNotes: string[] = [];
  for (const box of tent.byPath.values()) {
    const notePath = boxNotePath(box.path);
    if (!(await env.fs.exists(notePath))) continue;
    const raw = await env.fs.readFile(notePath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    if (typeof data.id === "string" && data.id !== box.id) {
      throw new Error(`Refuse rename: frontmatter id drift on ${box.path}.`);
    }
    const rewritten = rewriteConceptLinks(body, notePath, pathMap, oldName, newName, rewriteOpts);
    if (!rewritten.changed) continue;
    const afterPath = pathMap.get(box.path) ?? box.path;
    plannedWrites.push({
      writePath: boxNotePath(afterPath),
      originalPath: notePath,
      originalContent: raw,
      newContent: serializeFrontmatter(data, rewritten.body, keyOrder),
    });
    rewrittenNotes.push(afterPath);
  }

  await env.fs.move(oldPath, newPath);

  let identityRenamed = false;
  const completedWrites: PlannedWrite[] = [];
  try {
    identityRenamed = await ensureIdentityFileName(env.fs, newPath, oldName);
    for (const write of plannedWrites) {
      await env.fs.writeFile(write.writePath, write.newContent);
      completedWrites.push(write);
    }
  } catch (error) {
    await rollbackRename(env.fs, {
      oldPath,
      newPath,
      oldName,
      identityRenamed,
      completedWrites,
    });
    throw error;
  }

  // order.json is id-keyed — no path rewrite. Attachments are cx-keyed and stay put.

  const pathMapRecord: Record<string, string> = {};
  for (const [from, to] of pathMap) pathMapRecord[from] = to;

  return {
    id: target.id,
    oldPath,
    path: newPath,
    name: newName,
    pathMap: pathMapRecord,
    rewrittenNotes: rewrittenNotes.sort(),
  };
}

/**
 * Restore every completed note write (reverse order), reverse identity rename if needed,
 * then move the folder tree back to oldPath.
 */
async function rollbackRename(
  fs: FsAdapter,
  args: {
    oldPath: string;
    newPath: string;
    oldName: string;
    identityRenamed: boolean;
    completedWrites: PlannedWrite[];
  }
): Promise<void> {
  const { oldPath, newPath, oldName, identityRenamed, completedWrites } = args;
  const restoreErrors: string[] = [];

  // 1) Restore note bodies at their post-move write paths (reverse order).
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

  // 2) Reverse identity-note rename if we renamed Old→New under newPath.
  try {
    const expectedNew = boxNotePath(newPath);
    const legacyAfterMove = join(newPath, `${oldName}.md`);
    if (
      (identityRenamed || (await fs.exists(expectedNew))) &&
      (await fs.exists(expectedNew)) &&
      !(await fs.exists(legacyAfterMove))
    ) {
      await fs.move(expectedNew, legacyAfterMove);
    }
  } catch (err) {
    restoreErrors.push(`identity: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) Move the tree back.
  try {
    if ((await fs.exists(newPath)) && !(await fs.exists(oldPath))) {
      const expectedNew = boxNotePath(newPath);
      const legacyAfterMove = join(newPath, `${oldName}.md`);
      if (!(await fs.exists(legacyAfterMove)) && (await fs.exists(expectedNew))) {
        try {
          await fs.move(expectedNew, legacyAfterMove);
        } catch {
          // best-effort before folder move
        }
      }
      await fs.move(newPath, oldPath);
    }
  } catch (err) {
    restoreErrors.push(`tree: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (restoreErrors.length > 0) {
    throw new Error(
      `Rename failed after filesystem move, and rollback also failed: ${restoreErrors.join("; ")}`
    );
  }
}

function resolveRenameTarget(tent: LoadedTent, conceptIdOrPath: string): Box {
  const key = conceptIdOrPath.trim().replace(/\\/g, "/");
  const byId = tent.byId.get(key);
  if (byId) return byId;
  const byPath = tent.byPath.get(key);
  if (byPath) return byPath;
  throw new Error(`Concept not found: ${conceptIdOrPath}.`);
}

async function assertRenameOccupationAllowed(
  env: OpsEnv,
  tent: LoadedTent,
  concept: Box
): Promise<void> {
  // Occupation oracle = active task envelopes only (stale owner is not a rename lock).
  const tasks = await loadTaskEnvelopes(env.fs);
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.claims.includes(concept.id) || task.claims.includes("root")) {
      throw new Error(
        `Cannot rename ${concept.name}: active task ${task.path} occupies this concept.`
      );
    }
    for (const claimId of task.claims) {
      const claimed = tent.byId.get(claimId);
      if (!claimed) continue;
      if (isAncestorPath(claimed.path, concept.path) || isAncestorPath(concept.path, claimed.path)) {
        throw new Error(
          `Cannot rename ${concept.name}: overlapping active task ${task.path} occupies this range.`
        );
      }
    }
  }
}

function isAncestorPath(ancestor: string, child: string): boolean {
  if (!ancestor) return true;
  return child === ancestor || child.startsWith(ancestor + "/");
}

function assertNotOperationalPath(path: string): void {
  if (isOperationalPath(path) || path === "temp" || path.startsWith("temp/")) {
    throw new Error("temp/ and other system pipelines cannot be renamed as concepts.");
  }
  const top = path.split("/")[0] ?? "";
  if (top === "attachments" || top === ".tent") {
    throw new Error("System directories cannot be renamed as concepts.");
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

/**
 * Ensure identity note is `New/New.md` after folder move.
 * @returns true when a rename of the identity file occurred.
 */
async function ensureIdentityFileName(
  fs: FsAdapter,
  newBoxPath: string,
  oldName: string
): Promise<boolean> {
  const expected = boxNotePath(newBoxPath);
  if (await fs.exists(expected)) return false;
  const legacy = join(newBoxPath, `${oldName}.md`);
  if (await fs.exists(legacy)) {
    await fs.move(legacy, expected);
    return true;
  }
  const entries = await fs.listDir(newBoxPath);
  const candidates = entries
    .filter((e) => !e.isDir && e.name.endsWith(".md") && e.name !== "index.md")
    .map((e) => join(newBoxPath, e.name));
  if (candidates.length === 1) {
    await fs.move(candidates[0]!, expected);
    return true;
  }
  throw new Error(`Identity note missing after rename: expected ${expected}.`);
}

export type RewriteConceptLinksOptions = {
  /** Immutable cx- of the node being renamed. */
  renameBoxId: string;
  /** Pre-rename concept index (name resolution uses Tent's unique-match rules). */
  conceptIndex: Map<string, OkfConcept[]>;
};

/**
 * Rewrite Markdown / wiki destinations that targeted a moved path.
 * Unqualified wiki/name targets rewrite only when resolution uniquely targets the renamed node.
 */
export function rewriteConceptLinks(
  body: string,
  fromNotePath: string,
  pathMap: Map<string, string>,
  oldName: string,
  newName: string,
  opts?: RewriteConceptLinksOptions
): { body: string; changed: boolean } {
  if (pathMap.size === 0) return { body, changed: false };
  const oldPaths = [...pathMap.keys()].sort((a, b) => b.length - a.length);
  let next = body;
  let changed = false;

  // Markdown inline links: [label](dest) / [label](<dest>)
  next = next.replace(/\[([^\]]*)\]\((<[^>\n]+>|[^)\n]+)\)/g, (full, label: string, destRaw: string) => {
    const angled = destRaw.startsWith("<") && destRaw.endsWith(">");
    const inner = angled ? destRaw.slice(1, -1) : destRaw;
    const { url, titleTail } = splitMdUrlAndTitle(inner);
    if (!url || isExternalOrAnchor(url)) return full;
    const mapped = mapLinkTarget(url, fromNotePath, pathMap, oldPaths, oldName, newName, opts);
    if (!mapped) return full;
    changed = true;
    const dest = angled ? `<${mapped}${titleTail}>` : `${mapped}${titleTail}`;
    return `[${label}](${dest})`;
  });

  // Wiki links (not image embeds).
  next = next.replace(
    /(^|[^!])\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (full, prefix: string, rawTarget: string, rawLabel: string | undefined) => {
      const target = rawTarget.trim();
      if (!target) return full;
      const { head, suffix } = splitWikiTarget(target);
      if (!head || isExternalOrAnchor(head)) return full;

      const nextHead = mapLinkTarget(head, fromNotePath, pathMap, oldPaths, oldName, newName, opts);
      if (!nextHead || nextHead === head) return full;
      changed = true;
      const labelPart = rawLabel !== undefined ? `|${rawLabel}` : "";
      return `${prefix}[[${nextHead}${suffix}${labelPart}]]`;
    }
  );

  return { body: next, changed };
}

/**
 * Map a link destination to its post-rename form.
 * - Path-like targets (/, ./, ../, multi-segment): rewrite via pathMap only.
 * - Unqualified bare names: rewrite only when Tent resolveConcept uniquely hits renameBoxId.
 */
function mapLinkTarget(
  raw: string,
  fromNotePath: string,
  pathMap: Map<string, string>,
  oldPaths: string[],
  oldName: string,
  newName: string,
  opts?: RewriteConceptLinksOptions
): string | undefined {
  const { pathPart, tail } = splitDestTail(raw);
  if (!pathPart) return undefined;

  if (isUnqualifiedName(pathPart)) {
    return mapUnqualifiedName(pathPart, tail, oldName, newName, opts);
  }

  const normalized = normalizeTarget(pathPart, fromNotePath);
  const newAbs = resolveMappedPath(normalized, pathMap, oldPaths);
  if (!newAbs) return undefined;

  const sourceHadMd = /\.md$/i.test(pathPart.split(/[?#]/)[0] ?? pathPart);
  const absTarget = sourceHadMd
    ? newAbs.endsWith(".md")
      ? newAbs
      : `${newAbs}.md`
    : newAbs.replace(/\.md$/i, "");
  const styled = restyleRelative(pathPart, fromNotePath, absTarget, sourceHadMd);
  return styled + tail;
}

function mapUnqualifiedName(
  pathPart: string,
  tail: string,
  oldName: string,
  newName: string,
  opts?: RewriteConceptLinksOptions
): string | undefined {
  if (!opts || oldName === newName) return undefined;
  const bare = pathPart.replace(/\.md$/i, "");
  const resolved = resolveConcept(opts.conceptIndex, bare);
  if (!resolved || resolved.boxId !== opts.renameBoxId) return undefined;

  const sourceHadMd = /\.md$/i.test(pathPart);
  // Authors used a bare name form; keep bare name form with the new display name.
  // Only rewrite when the resolved target is uniquely this node (resolveConcept guarantee).
  const nextBare =
    bare === oldName || normalizeLookupLoose(bare) === normalizeLookupLoose(oldName)
      ? newName
      : newName;
  return (sourceHadMd ? `${nextBare}.md` : nextBare) + tail;
}

function resolveMappedPath(
  normalized: string,
  pathMap: Map<string, string>,
  oldPaths: string[]
): string | undefined {
  const clean = normalized.replace(/\\/g, "/").replace(/^\.\//, "");
  if (pathMap.has(clean)) return pathMap.get(clean);
  const noMd = clean.replace(/\.md$/i, "");
  if (pathMap.has(noMd)) return pathMap.get(noMd);
  for (const oldPath of oldPaths) {
    if (clean === oldPath || noMd === oldPath || clean === `${oldPath}.md`) {
      return pathMap.get(oldPath);
    }
  }
  return undefined;
}

function isUnqualifiedName(raw: string): boolean {
  const t = raw.trim().replace(/\\/g, "/");
  if (!t || t.includes("/") || t.startsWith(".")) return false;
  return true;
}

function normalizeLookupLoose(value: string): string {
  return value.toLowerCase().replace(/[\s、，,。:：;；/\\_\-.()[\]（）【】"'`]+/g, "");
}

function splitMdUrlAndTitle(inner: string): { url: string; titleTail: string } {
  const t = inner.trim();
  const m = t.match(/^(\S+?)(\s+(".*"|'.*'|\(.*\)))\s*$/);
  if (m) return { url: m[1]!, titleTail: m[2] ?? "" };
  return { url: t, titleTail: "" };
}

function splitWikiTarget(raw: string): { head: string; suffix: string } {
  const t = raw.trim();
  const caret = t.lastIndexOf("^");
  if (caret > 0) {
    const before = t.slice(0, caret);
    const hash = before.indexOf("#");
    if (hash >= 0) {
      return { head: before.slice(0, hash).trim(), suffix: before.slice(hash) + t.slice(caret) };
    }
    return { head: before.trim(), suffix: t.slice(caret) };
  }
  const hash = t.indexOf("#");
  if (hash >= 0) return { head: t.slice(0, hash).trim(), suffix: t.slice(hash) };
  return { head: t, suffix: "" };
}

function splitDestTail(dest: string): { pathPart: string; tail: string } {
  const t = dest.trim();
  const hash = t.indexOf("#");
  const query = t.indexOf("?");
  let cut = -1;
  if (hash >= 0 && query >= 0) cut = Math.min(hash, query);
  else if (hash >= 0) cut = hash;
  else if (query >= 0) cut = query;
  if (cut < 0) return { pathPart: t, tail: "" };
  return { pathPart: t.slice(0, cut), tail: t.slice(cut) };
}

function isExternalOrAnchor(dest: string): boolean {
  const t = dest.trim();
  if (!t || t.startsWith("#")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(t);
}

function restyleRelative(
  originalPathPart: string,
  fromNotePath: string,
  absoluteNext: string,
  keepMd: boolean
): string {
  const orig = originalPathPart.replace(/\\/g, "/");
  if (orig.startsWith("./") || orig.startsWith("../")) {
    const toNote = absoluteNext.endsWith(".md") ? absoluteNext : `${absoluteNext}.md`;
    let rel = relativeMarkdownPath(fromNotePath, toNote);
    if (!keepMd) rel = rel.replace(/\.md$/i, "");
    return rel;
  }
  // Absolute-from-system-root style path
  if (!keepMd && absoluteNext.endsWith(".md")) return absoluteNext.replace(/\.md$/i, "");
  return absoluteNext;
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
