// Tent 状态动作的统一入口，供 CLI 与插件共同调用。

import { FsAdapter, withTentMutation } from "./adapter.js";
import { loadTent, join, dirName, boxNotePath, LoadedTent } from "./tree.js";
import { buildManifest, manifestToYaml, DispatchInput } from "./manifest.js";
import { makeUniqueBoxId } from "./id.js";
import { BOX_FRONTMATTER_KEY_ORDER, serializeFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { loadOrder, saveOrder, ROOT_KEY } from "./order.js";
import { Box, BoxType } from "./types.js";
import { canClaim, isFrozen, occupiedBoxes } from "./claim.js";
import { isUsableBox } from "./tree.js";
import { addRegistryTag, addTag, removeRegistryTag, removeTag, normalizeTagName } from "./tags.js";
import { typeExists } from "./typeRegistry.js";
import { loadRolesRegistry } from "./skillRoleRegistry.js";
import { ensureRoleInit, relayPromptForTask, RoleWorkspaceContract, writeTaskEnvelope } from "./task.js";
import { loadReport, removeReportsForBox } from "./report.js";
import { validateBoxName } from "./scaffold.js";
import type { OpsEnv } from "./ops-context.js";

export type { OpsEnv } from "./ops-context.js";
export { adoptCopiedSubtree, forkNode } from "./forkOps.js";

// ---- dispatch ----

export interface DispatchResult {
  manifestPath: string;
  manifestYaml: string;
  initPath: string;
  taskPath: string;
  relayPrompt: string;
}

export interface DispatchOptions {
  userPrompt?: string;
  workspace?: RoleWorkspaceContract;
  dispatchedBy?: string;
}

export async function dispatch(
  env: OpsEnv,
  claimId: string,
  role: string,
  promptOrOptions: string | DispatchOptions
): Promise<DispatchResult> {
  return withMutation(env.fs, async () => dispatchUnlocked(env, claimId, role, promptOrOptions));
}

async function dispatchUnlocked(
  env: OpsEnv,
  claimId: string,
  role: string,
  promptOrOptions: string | DispatchOptions
): Promise<DispatchResult> {
  const tent = await loadTent(env.fs);
  const roleName = assertRoleName(role);
  const claim = resolveDispatchClaim(tent, claimId, env.tentName);
  const options: DispatchOptions = typeof promptOrOptions === "string"
    ? { userPrompt: promptOrOptions }
    : promptOrOptions;
  const userPrompt = options.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");
  const previousOwner = claim.root ? undefined : claim.box.fm.owner;
  const previousStatus = claim.root ? undefined : claim.box.fm.status;
  const previousAcceptedBy = claim.root ? undefined : claim.box.fm.acceptedBy;
  const roleTempPath = join("temp", roleName);
  const roleTempExisted = await env.fs.exists(roleTempPath);
  if (claim.root) {
    const occupied = occupiedBoxes(tent);
    if (occupied.length > 0) {
      throw new Error(`Cannot dispatch: Tent root already has an active claim ${occupied[0].name} (${occupied[0].fm.owner}).`);
    }
  } else {
    const existingOwner = ownerCovering(claim.box);
    if (existingOwner) {
      throw new Error(`Cannot dispatch: ${existingOwner.name} is already claimed by ${existingOwner.fm.owner}.`);
    }
    const claimable = canClaim(claim.box);
    if (!claimable.ok) throw new Error(`Cannot dispatch: ${claimable.reason || "box cannot be claimed"}`);
    await setOwner(env.fs, claim.box, roleName, "doing");
    claim.box.fm.owner = roleName;
    claim.box.fm.status = "doing";
  }

  try {
    const ownedClaims = claim.root
      ? []
      : [...tent.byPath.values()].filter((box) => box.fm.owner === roleName);
    const input: DispatchInput = claim.root
      ? { tentName: env.tentName, role: roleName, claimRoot: true, ...options.workspace }
      : { tentName: env.tentName, role: roleName, claimBoxes: ownedClaims, ...options.workspace };
    const manifest = buildManifest(tent, input);
    const yaml = manifestToYaml(manifest);

    // manifest 是 role 当前全部 claims 的动态合同；task 文档不可变。
    const manifestPath = join("temp", roleName, "manifest.yml");
    await ensureDir(env.fs, dirName(manifestPath));
    await env.fs.writeFile(manifestPath, yaml);
    const registry = await loadRolesRegistry(env.fs);
    const roleDefinition = registry.roles.find((item) => item.name === roleName) ?? { name: roleName };
    const initPath = await ensureRoleInit(env.fs, roleDefinition, env.tentName);
    const taskClaims = claim.root
      ? [{ id: "root", path: "./" }]
      : [{ id: claim.box.id, path: claim.box.path }];
    const taskPath = await writeTaskEnvelope(env.fs, env.clock, {
      role: roleName,
      claims: taskClaims,
      manifestPath,
      userPrompt,
      workspace: options.workspace,
      dispatchedBy: options.dispatchedBy,
    });

    const relayPrompt = relayPromptForTask(
      {
        path: taskPath,
        role: roleName,
        claims: taskClaims.map((taskClaim) => taskClaim.id),
        manifest: manifestPath,
        status: "pending",
      },
      env.tentRoot || env.tentName
    );
    return { manifestPath, manifestYaml: yaml, initPath, taskPath, relayPrompt };
  } catch (error) {
    if (!claim.root) {
      await restoreOwnerState(env.fs, claim.box, previousOwner, previousStatus, previousAcceptedBy);
      claim.box.fm.owner = previousOwner;
      claim.box.fm.status = previousStatus;
      claim.box.fm.acceptedBy = previousAcceptedBy;
    }
    if (!roleTempExisted && await env.fs.exists(roleTempPath)) {
      await env.fs.remove(roleTempPath);
    }
    throw error;
  }
}

type DispatchClaim =
  | { root: true; id: "root"; name: string }
  | { root: false; id: string; name: string; box: Box };

function resolveDispatchClaim(tent: LoadedTent, claimId: string, tentName: string): DispatchClaim {
  const id = claimId.trim();
  if (id === "." || id === "root" || id === tentName) {
    throw new Error("Cannot dispatch the whole Tent directly; dispatch a specific box (claimId cannot be ., root, or the Tent name).");
  }
  const box = tent.byId.get(id);
  if (!box) throw new Error(`Box not found: ${claimId}.`);
  return { root: false, id: box.id, name: box.name, box };
}

// ---- stamp(盖章 = 验收)----

export async function stamp(env: OpsEnv, boxId: string, acceptedBy = "user"): Promise<void> {
  await completeClaim(env, boxId, undefined, acceptedBy);
}

/** 验收动作：可先合入 workspace commits；合入失败时不改变 Tent 状态。 */
export async function completeClaim(
  env: OpsEnv,
  boxId: string,
  integrate?: () => Promise<void>,
  acceptedBy = "user"
): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (integrate) await integrate();
    await setOwner(env.fs, box, undefined, "done", acceptedBy);
  });
}

/** 采纳一份完整 report：全部 commits 成功合入后才完成并清理临时 report。 */
export interface AcceptReportOptions {
  commits?: string[];
  integrate?: (commits: string[]) => Promise<void>;
  acceptedBy?: string;
}

export async function acceptReport(
  env: OpsEnv,
  reportPath: string,
  options: AcceptReportOptions = {}
): Promise<void> {
  await withMutation(env.fs, async () => {
    const report = await loadReport(env.fs, reportPath);
    if (report.status !== "ready") throw new Error("Only ready reports can be confirmed.");
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(report.boxId);
    if (!box) throw new Error(`Box not found: ${report.boxId}.`);
    if (box.fm.owner !== report.role) throw new Error("Report role does not match the current owner.");
    const commits = options.commits ?? report.commits;
    if (commits.length > 0) {
      if (!options.integrate) throw new Error("Report contains commits; workspace integration is required.");
      await options.integrate(commits);
    }
    await setOwner(env.fs, box, undefined, "done", options.acceptedBy ?? "user");
    await env.fs.remove(report.path);
  });
}

/** 翻可读:批准 asset 请求时顺手把目标框 readable 改 true(无需二段落地)。 */
export async function grantReadable(env: OpsEnv, boxId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be made readable.");
    await patchFrontmatter(env.fs, box, { readable: true });
  });
}

// ---- clean-temp ----

export async function cleanTemp(env: OpsEnv, role?: string): Promise<void> {
  const roleName = role === undefined ? undefined : assertRoleName(role);
  await withMutation(env.fs, async () => {
    const target = roleName ? join("temp", roleName) : "temp";
    if (await env.fs.exists(target)) {
      await env.fs.remove(target);
    }
    if (!roleName) await ensureDir(env.fs, "temp");
  });
}

// ---- 强清卡死 owner ----

export async function forceRelease(env: OpsEnv, boxId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!box.fm.owner) throw new Error("Only claim roots with a direct owner can be force-released.");
    await setOwner(env.fs, box, undefined, "todo");
    await removeReportsForBox(env.fs, box.id);
  });
}

// ---- tags ----

export async function tagBox(env: OpsEnv, boxId: string, name: string): Promise<void> {
  await addTag(env.fs, boxId, normalizeTagName(name));
}

export async function untagBox(env: OpsEnv, boxId: string, name: string): Promise<void> {
  await removeTag(env.fs, boxId, normalizeTagName(name));
}

export async function createTag(env: OpsEnv, name: string): Promise<void> {
  await addRegistryTag(env.fs, normalizeTagName(name));
}

export async function deleteTag(env: OpsEnv, name: string): Promise<void> {
  await removeRegistryTag(env.fs, normalizeTagName(name));
}

// ---- 结构编辑(建框/移动/改属性)----
// 这些是 user 的即时编辑；Tent 本身不使用 Git。

export interface NewBoxInput {
  parentPath: string; // "" = 顶层
  name: string;
  type: BoxType;
}

export async function createBox(env: OpsEnv, input: NewBoxInput): Promise<string> {
  return withMutation(env.fs, async () => createBoxUnlocked(env, input));
}

async function createBoxUnlocked(env: OpsEnv, input: NewBoxInput): Promise<string> {
  assertNotTempPath(input.parentPath);
  const name = validateBoxName(input.name);
  const tent = await loadTent(env.fs);
  if (!typeExists(input.type, tent.typeRegistry)) throw new Error(`Unknown type: ${input.type}.`);
  if (input.parentPath) {
    const parent = tent.byPath.get(input.parentPath);
    if (!parent || !isUsableBox(parent)) throw new Error("Target parent box is invalid or archived.");
  }
  const existing = new Set(tent.byId.keys());
  const id = makeUniqueBoxId(existing, env.rand);
  const path = join(input.parentPath, name);
  assertNotTempPath(path);
  await ensureDir(env.fs, path);
  const fm = { id, type: input.type };
  const content = serializeFrontmatter(fm, `\n# ${name}\n`, BOX_FRONTMATTER_KEY_ORDER);
  await env.fs.writeFile(boxNotePath(path), content);
  const parent = input.parentPath ? tent.byPath.get(input.parentPath) : undefined;
  const parentKey = parent ? parent.id : ROOT_KEY;
  try {
    const order = await loadOrder(env.fs);
    const siblings = order[parentKey] ?? [];
    order[parentKey] = siblings.includes(id) ? siblings : [...siblings, id];
    await saveOrder(env.fs, order);
  } catch (error) {
    await env.fs.remove(path);
    throw error;
  }
  return id;
}

/** 落点:成为某框子框(inside)/ 插到某兄弟之前(before)/ 之后(after)。 */
export type DropPosition =
  | { mode: "inside" }
  | { mode: "before"; siblingId: string }
  | { mode: "after"; siblingId: string };

// 统一的换爹 + 换序:把 fromPath 放到 newParentPath 下的指定位置。
// 顺序记进隐藏的 .tent/order.json(对 user 不显式),不碰任何框身份文件 frontmatter。
export async function placeBox(
  env: OpsEnv,
  fromPath: string,
  newParentPath: string,
  position: DropPosition
): Promise<void> {
  await withMutation(env.fs, async () => placeBoxUnlocked(env, fromPath, newParentPath, position));
}

async function placeBoxUnlocked(
  env: OpsEnv,
  fromPath: string,
  newParentPath: string,
  position: DropPosition
): Promise<void> {
  assertNotTempPath(newParentPath);
  const before = await loadTent(env.fs);
  const moved = before.byPath.get(fromPath);
  if (!moved) throw new Error(`Box not found: ${fromPath}.`);
  if (!isUsableBox(moved)) throw new Error("Invalid or archived boxes cannot be moved.");
  if (isFrozen(moved)) throw new Error("Claimed ranges cannot be moved; stamp or force-release the owner first.");
  const movedId = moved.id;
  const movedName = fromPath.slice(fromPath.lastIndexOf("/") + 1);

  const parentBox = newParentPath ? before.byPath.get(newParentPath) : null;
  if (newParentPath && (!parentBox || !isUsableBox(parentBox))) throw new Error("Target parent box is invalid or archived.");
  if (parentBox && isFrozen(parentBox)) throw new Error("Cannot move into a claimed range; stamp or force-release the owner first.");
  if (newParentPath === fromPath || newParentPath.startsWith(fromPath + "/")) {
    throw new Error("Cannot move a box into its own subtree.");
  }
  const parentKey = parentBox ? parentBox.id : ROOT_KEY;
  const oldParentKey = moved.parent ? moved.parent.id : ROOT_KEY;

  // 目标父级现有子框(已按当前 order 排好),排除被移动者 → 期望 id 序列
  const siblings = (parentBox ? parentBox.children : before.roots)
    .filter((b) => b.id !== movedId)
    .map((b) => b.id);

  let insertAt: number;
  if (position.mode === "inside") {
    insertAt = siblings.length; // 追加到目标框子级末尾
  } else {
    const idx = siblings.indexOf(position.siblingId);
    insertAt = idx === -1 ? siblings.length : position.mode === "before" ? idx : idx + 1;
  }
  siblings.splice(insertAt, 0, movedId);

  const order = await loadOrder(env.fs);

  // 父级变了才动文件夹,并把 moved 从旧父级顺序里摘掉
  if (dirName(fromPath) !== newParentPath) {
    const destination = join(newParentPath, movedName);
    await env.fs.move(fromPath, destination);
    if (order[oldParentKey]) order[oldParentKey] = order[oldParentKey].filter((id) => id !== movedId);
    try {
      order[parentKey] = siblings;
      await saveOrder(env.fs, order);
    } catch (error) {
      try {
        await env.fs.move(destination, fromPath);
      } catch {
        throw new Error(`Failed to save order after move, and rollback also failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
    return;
  }

  order[parentKey] = siblings;
  await saveOrder(env.fs, order);
}

export async function patchBox(
  env: OpsEnv,
  boxPath: string,
  patch: Record<string, unknown>,
  loadedTent?: LoadedTent
): Promise<void> {
  await withMutation(env.fs, async () => patchBoxUnlocked(env, boxPath, patch, loadedTent));
}

async function patchBoxUnlocked(
  env: OpsEnv,
  boxPath: string,
  patch: Record<string, unknown>,
  loadedTent?: LoadedTent
): Promise<void> {
  const tent = loadedTent ?? await loadTent(env.fs);
  const box = tent.byPath.get(boxPath);
  if (!box) throw new Error(`Box not found: ${boxPath}.`);
  const reserved = ["id", "owner", "archived", "kind"].filter((key) => key in patch);
  if (reserved.length > 0) throw new Error(`Reserved fields must use dedicated core APIs: ${reserved.join(", ")}.`);
  if (box.archived) throw new Error("Archived boxes can only be restored or permanently deleted.");
  if (box.invalid) {
    const keys = Object.keys(patch);
    if (box.id !== box.invalidRootId || keys.some((key) => key !== "type")) {
      throw new Error("Invalid subtrees can only be rescued by changing type at the invalid root.");
    }
  }
  if ("type" in patch) {
    if (typeof patch.type !== "string" || !patch.type) throw new Error("Primary type cannot be cleared.");
    if (!typeExists(patch.type, tent.typeRegistry)) throw new Error(`Unknown type: ${patch.type}.`);
  }
  if ("status" in patch) {
    if (box.fm.owner) throw new Error("Status for claimed boxes can only be changed by completing or force-releasing.");
    if (patch.status !== undefined && !["todo", "doing", "done"].includes(String(patch.status))) {
      throw new Error("status must be todo, doing, or done.");
    }
  }
  if ("tags" in patch) {
    patch = { ...patch, tags: normalizeTagPatch(patch.tags) };
  }
  const boxFile = boxNotePath(boxPath);
  const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete data[k];
    else data[k] = v;
  }
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
}

/** 改框正文(note)。保留 frontmatter 原样。 */
export async function patchBody(
  env: OpsEnv,
  boxPath: string,
  newBody: string,
  loadedTent?: LoadedTent
): Promise<void> {
  await withMutation(env.fs, async () => patchBodyUnlocked(env, boxPath, newBody, loadedTent));
}

async function patchBodyUnlocked(
  env: OpsEnv,
  boxPath: string,
  newBody: string,
  loadedTent?: LoadedTent
): Promise<void> {
  const tent = loadedTent ?? await loadTent(env.fs);
  const box = tent.byPath.get(boxPath);
  if (!box || !isUsableBox(box)) throw new Error("Invalid or archived boxes cannot have their body edited.");
  const boxFile = boxNotePath(boxPath);
  const { data, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, newBody, keyOrder));
}

export async function archiveBox(env: OpsEnv, boxId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!isUsableBox(box)) throw new Error("Invalid or already archived boxes cannot be archived.");
    if (isFrozen(box)) throw new Error("Claimed ranges cannot be archived; stamp or force-release the owner first.");
    await patchFrontmatter(env.fs, box, { archived: true });
  });
}

export async function restoreBox(env: OpsEnv, boxId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (box.fm.archived !== true) throw new Error("Only an explicit archive root can restore the subtree.");
    await patchFrontmatter(env.fs, box, { archived: undefined });
  });
}

export async function deleteArchivedBox(env: OpsEnv, boxId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (box.fm.archived !== true) throw new Error("Node must be archived before permanent deletion.");
    if (hasOwnerInSubtree(box)) throw new Error("Archived subtree still has an owner and cannot be deleted.");

    const removedIds = collectSubtreeIds(box);
    await env.fs.remove(box.path);
    const order = await loadOrder(env.fs);
    for (const key of Object.keys(order)) {
      if (removedIds.has(key)) delete order[key];
      else order[key] = order[key].filter((id) => !removedIds.has(id));
    }
    await saveOrder(env.fs, order);
  });
}

// ---- 内部工具 ----

async function setOwner(
  fs: FsAdapter,
  box: Box,
  owner: string | undefined,
  status?: Box["fm"]["status"],
  acceptedBy?: string
): Promise<void> {
  const patch: Record<string, unknown> = { owner: owner ?? undefined };
  if (owner) patch.acceptedBy = undefined;
  else if (acceptedBy) patch.acceptedBy = acceptedBy;
  if (status) patch.status = status;
  await patchFrontmatter(fs, box, patch);
}

async function restoreOwnerState(
  fs: FsAdapter,
  box: Box,
  owner: string | undefined,
  status: Box["fm"]["status"] | undefined,
  acceptedBy: unknown
): Promise<void> {
  await patchFrontmatter(fs, box, {
    owner: owner ?? undefined,
    status: status ?? undefined,
    acceptedBy: acceptedBy ?? undefined,
  });
}

async function patchFrontmatter(fs: FsAdapter, box: Box, patch: Record<string, unknown>): Promise<void> {
  const boxFile = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete data[k];
    else data[k] = v;
  }
  await fs.writeFile(boxFile, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
}

async function ensureDir(fs: FsAdapter, path: string): Promise<void> {
  if (path && !(await fs.exists(path))) await fs.mkdir(path);
}

function normalizeTagPatch(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("tags must be a string array.");
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("tags must be a string array.");
    const tag = normalizeTagName(item);
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags.length > 0 ? tags.sort((a, b) => a.localeCompare(b)) : undefined;
}

function boxKeyOrder(existing: string[]): string[] {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key)),
  ];
}

function assertNotTempPath(path: string): void {
  if (path === "temp" || path.startsWith("temp/")) {
    throw new Error("temp is a system pipe; typed boxes cannot be created or moved there.");
  }
}

function hasOwnerInSubtree(box: Box): boolean {
  if (box.fm.owner) return true;
  return box.children.some(hasOwnerInSubtree);
}

function collectSubtreeIds(box: Box, ids = new Set<string>()): Set<string> {
  ids.add(box.id);
  for (const child of box.children) collectSubtreeIds(child, ids);
  return ids;
}

function assertRoleName(role: string): string {
  const name = role.trim();
  if (!name) throw new Error("Role name cannot be empty.");
  if (/[\/\\\r\n]/.test(name)) throw new Error("Role name cannot contain path separators or newlines.");
  return name;
}

function ownerCovering(box: Box): Box | undefined {
  if (box.fm.owner) return box;
  let parent = box.parent;
  while (parent) {
    if (parent.fm.owner) return parent;
    parent = parent.parent;
  }
  return undefined;
}

async function withMutation<T>(fs: FsAdapter, action: () => Promise<T>): Promise<T> {
  return withTentMutation(fs, action);
}
