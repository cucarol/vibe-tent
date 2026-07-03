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
import type { OpsEnv } from "./ops-context.js";

export type { OpsEnv } from "./ops-context.js";
export {
  applyProposal,
  finishApply,
  propose,
  startApply,
  type ApplyGrant,
  type ProposeResult,
} from "./collaborationOps.js";
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
  if (!userPrompt) throw new Error("派活必须提供 user prompt");
  if (claim.root) {
    const occupied = occupiedBoxes(tent);
    if (occupied.length > 0) {
      throw new Error(`不能派活:帐根下已有认领「${occupied[0].name}」(${occupied[0].fm.owner})`);
    }
  } else {
    const existingOwner = ownerCovering(claim.box);
    if (existingOwner) {
      throw new Error(`不能派活:${existingOwner.name} 已被 ${existingOwner.fm.owner} 认领`);
    }
    const claimable = canClaim(claim.box);
    if (!claimable.ok) throw new Error(`不能派活:${claimable.reason || "框不可认领"}`);
    await setOwner(env.fs, claim.box, roleName, "doing");
    claim.box.fm.owner = roleName;
    claim.box.fm.status = "doing";
  }

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
}

type DispatchClaim =
  | { root: true; id: "root"; name: string }
  | { root: false; id: string; name: string; box: Box };

function resolveDispatchClaim(tent: LoadedTent, claimId: string, tentName: string): DispatchClaim {
  const id = claimId.trim();
  if (id === "." || id === "root" || id === tentName) return { root: true, id: "root", name: "帐根" };
  const box = tent.byId.get(id);
  if (!box) throw new Error(`找不到框 ${claimId}`);
  return { root: false, id: box.id, name: box.name, box };
}

// ---- stamp(盖章 = 验收)----

export async function stamp(env: OpsEnv, boxId: string): Promise<void> {
  await completeClaim(env, boxId);
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
    if (!box) throw new Error(`找不到框 ${boxId}`);
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
    if (report.status !== "ready") throw new Error("只有 ready report 可以确认");
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(report.boxId);
    if (!box) throw new Error(`找不到框 ${report.boxId}`);
    if (box.fm.owner !== report.role) throw new Error("report role 与当前 owner 不一致");
    const commits = options.commits ?? report.commits;
    if (commits.length > 0) {
      if (!options.integrate) throw new Error("report 含 commits,必须完成 workspace 合入");
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
    if (!box) throw new Error(`找不到框 ${boxId}`);
    if (!isUsableBox(box)) throw new Error("失效或归档框不能翻可读");
    await patchFrontmatter(env.fs, box, { readable: true });
  });
}

// ---- clean-temp ----

export async function cleanTemp(env: OpsEnv, role?: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const target = role ? join("temp", role) : "temp";
    if (await env.fs.exists(target)) {
      await env.fs.remove(target);
    }
    if (!role) await ensureDir(env.fs, "temp");
  });
}

// ---- 强清卡死 owner ----

export async function forceRelease(env: OpsEnv, boxId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`找不到框 ${boxId}`);
    if (!box.fm.owner) throw new Error("只能中断直接带 owner 的认领根");
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
  const tent = await loadTent(env.fs);
  if (!typeExists(input.type, tent.typeRegistry)) throw new Error(`未知 type: ${input.type}`);
  if (input.parentPath) {
    const parent = tent.byPath.get(input.parentPath);
    if (!parent || !isUsableBox(parent)) throw new Error("目标父框失效或已归档");
  }
  const existing = new Set(tent.byId.keys());
  const id = makeUniqueBoxId(existing, env.rand);
  const path = join(input.parentPath, input.name);
  assertNotTempPath(path);
  await ensureDir(env.fs, path);
  const fm = { id, type: input.type };
  const content = serializeFrontmatter(fm, `\n# ${input.name}\n`, BOX_FRONTMATTER_KEY_ORDER);
  await env.fs.writeFile(boxNotePath(path), content);
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
  if (!moved) throw new Error(`找不到框 ${fromPath}`);
  if (!isUsableBox(moved)) throw new Error("失效或归档框不可移动");
  if (isFrozen(moved)) throw new Error("认领范围不能移动;先盖章或强清 owner");
  const movedId = moved.id;
  const movedName = fromPath.slice(fromPath.lastIndexOf("/") + 1);

  const parentBox = newParentPath ? before.byPath.get(newParentPath) : null;
  if (newParentPath && (!parentBox || !isUsableBox(parentBox))) throw new Error("目标父框失效或已归档");
  if (parentBox && isFrozen(parentBox)) throw new Error("不能移入认领范围;先盖章或强清 owner");
  if (newParentPath === fromPath || newParentPath.startsWith(fromPath + "/")) {
    throw new Error("不能把框移入自己的子树");
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
        throw new Error(`移动后 order 保存失败,且回滚失败: ${error instanceof Error ? error.message : String(error)}`);
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
  if (!box) throw new Error(`找不到框 ${boxPath}`);
  const reserved = ["id", "owner", "archived", "kind"].filter((key) => key in patch);
  if (reserved.length > 0) throw new Error(`保留字段只能走专用 core API: ${reserved.join(", ")}`);
  if (box.archived) throw new Error("归档框只能恢复或永久删除");
  if (box.invalid) {
    const keys = Object.keys(patch);
    if (box.id !== box.invalidRootId || keys.some((key) => key !== "type")) {
      throw new Error("失效子树只允许在失效根修改 type 以救活");
    }
  }
  if ("type" in patch) {
    if (typeof patch.type !== "string" || !patch.type) throw new Error("一级 type 不允许清空");
    if (!typeExists(patch.type, tent.typeRegistry)) throw new Error(`未知 type: ${patch.type}`);
  }
  if ("status" in patch) {
    if (box.fm.owner) throw new Error("认领中的 status 只能通过完成或中断动作修改");
    if (patch.status !== undefined && !["todo", "doing", "done"].includes(String(patch.status))) {
      throw new Error("status 必须是 todo/doing/done");
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
  if (!box || !isUsableBox(box)) throw new Error("失效或归档框不可编辑正文");
  const boxFile = boxNotePath(boxPath);
  const { data, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, newBody, keyOrder));
}

export async function archiveBox(env: OpsEnv, boxId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`找不到框 ${boxId}`);
    if (!isUsableBox(box)) throw new Error("失效或已归档框不能归档");
    if (isFrozen(box)) throw new Error("认领范围不能归档;先盖章或强清 owner");
    await patchFrontmatter(env.fs, box, { archived: true });
  });
}

export async function restoreBox(env: OpsEnv, boxId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`找不到框 ${boxId}`);
    if (box.fm.archived !== true) throw new Error("只能从显式归档根恢复整棵子树");
    await patchFrontmatter(env.fs, box, { archived: undefined });
  });
}

export async function deleteArchivedBox(env: OpsEnv, boxId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`找不到框 ${boxId}`);
    if (box.fm.archived !== true) throw new Error("node 必须先归档才能永久删除");
    if (hasOwnerInSubtree(box)) throw new Error("归档子树仍有 owner,不能删除");

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
  if (!Array.isArray(value)) throw new Error("tags 必须是字符串数组");
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("tags 必须是字符串数组");
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
    throw new Error("temp 是系统管道,不允许创建或移动 typed box");
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
  if (!name) throw new Error("role 名不能为空");
  if (/[\/\\\r\n]/.test(name)) throw new Error("role 名不能包含路径分隔符或换行");
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
