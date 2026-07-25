// Tent 状态动作的统一入口，供 CLI 与插件共同调用。

import { FsAdapter, withTentMutation } from "./adapter.js";
import { loadTent, join, dirName, boxNotePath, LoadedTent } from "./tree.js";
import { buildManifest, manifestToYaml, DispatchInput } from "./manifest.js";
import { makeUniqueConceptId } from "./id.js";
import { BOX_FRONTMATTER_KEY_ORDER, serializeFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { loadOrder, saveOrder, ROOT_KEY } from "./order.js";
import { Box, BoxType, NodeMode } from "./types.js";
import {
  canClaim,
  envelopeIsActiveOccupation,
  findActiveOccupation,
  findAnyActiveTask,
  structuralClaimGate,
} from "./claim.js";
import { assertContentMutable, isExplicitArchiveRoot, isUsableBox, parseNodeMode } from "./tree.js";
import {
  addRegistryTag,
  addTag,
  removeRegistryTag,
  removeTag,
  normalizeTagName,
  syncTagRegistryAfterBoxTagsChangeUnlocked,
} from "./tags.js";
import { typeExists } from "./typeRegistry.js";
import { assertRoleNameAvailable, loadRolesRegistry } from "./skillRoleRegistry.js";
import {
  cancelTaskEnvelope,
  ensureRoleInit,
  loadTaskEnvelope,
  loadTaskEnvelopes,
  relayPromptForTask,
  RoleWorkspaceContract,
  taskAssigneeKind,
  TaskEnvelope,
  writeTaskEnvelope,
} from "./task.js";
import { makeTaskId } from "./task-model.js";
import type { AssigneeKind, DeliveryPolicy } from "./task-model.js";
import {
  agentProfileManifestPath,
  agentProfileTasksDir,
  agentProfileTempRoot,
} from "./paths.js";
import { removeNonAcceptedDeliveriesForBox } from "./delivery.js";
import { validateBoxName } from "./scaffold.js";
import type { OpsEnv } from "./ops-context.js";
import { taskClaim } from "./task-lifecycle.js";

export type { OpsEnv } from "./ops-context.js";
export { adoptCopiedSubtree, forkNode } from "./forkOps.js";
export { renameNode, type RenameNodeResult } from "./renameOps.js";

// ---- dispatch ----

export interface DispatchResult {
  manifestPath: string;
  manifestYaml: string;
  /** Present for role tasks; omitted for one-shot agentProfile tasks. */
  initPath?: string;
  taskPath: string;
  relayPrompt: string;
  assigneeKind: AssigneeKind;
  /** Stable assignee label (role name or profileId). */
  assignee: string;
}

export interface DispatchOptions {
  userPrompt?: string;
  workspace?: RoleWorkspaceContract;
  dispatchedBy?: string;
  /**
   * Sub-dispatch flag. Missing/false = peer. When true, requires real Git lane
   * and a durable dispatcher role in dispatchedBy (validated by service/CLI).
   */
  asSub?: boolean;
  /** Delivery policy for this task (default manual). */
  deliveryPolicy?: DeliveryPolicy;
  /**
   * Defaults to role. agentProfile requires profileId and must not register a role.
   */
  assigneeKind?: AssigneeKind;
  /** Required when assigneeKind=agentProfile; stable assignee / delivery label. */
  profileId?: string;
  /**
   * Optional preallocated task id (tk-…). Used by asSub profile dispatch so the
   * tent-task/<taskId> lane can be created before the envelope is written.
   */
  taskId?: string;
}

export async function dispatch(
  env: OpsEnv,
  claimId: string,
  role: string | undefined,
  promptOrOptions: string | DispatchOptions
): Promise<DispatchResult> {
  return withMutation(env.fs, async () => dispatchUnlocked(env, claimId, role, promptOrOptions));
}

async function dispatchUnlocked(
  env: OpsEnv,
  claimId: string,
  role: string | undefined,
  promptOrOptions: string | DispatchOptions
): Promise<DispatchResult> {
  const tent = await loadTent(env.fs);
  const options: DispatchOptions = typeof promptOrOptions === "string"
    ? { userPrompt: promptOrOptions }
    : promptOrOptions;
  const assigneeKind: AssigneeKind =
    options.assigneeKind === "agentProfile" ? "agentProfile" : "role";
  const userPrompt = options.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");

  let assigneeLabel: string;
  if (assigneeKind === "agentProfile") {
    const profileId = options.profileId?.trim() || "";
    if (!profileId) {
      throw new Error("Dispatch with assigneeKind=agentProfile requires profileId.");
    }
    if (role?.trim() && role.trim() !== profileId) {
      throw new Error(
        "Dispatch with assigneeKind=agentProfile must not pass a different role; use profileId as the assignee label."
      );
    }
    assigneeLabel = assertProfileId(profileId);
  } else {
    const roleName = role?.trim() || "";
    if (!roleName) throw new Error("Dispatch with assigneeKind=role requires role.");
    assigneeLabel = assertRoleName(roleName);
  }

  const claim = resolveDispatchClaim(tent, claimId, env.tentName);
  const tasks = await loadTaskEnvelopes(env.fs);
  // Cleanup only removes what this dispatch creates. Role: temp/<role>/ when new.
  // Profile: temp/agent-profiles/<safe>/ when new (never tent-role/*).
  const createdRoot =
    assigneeKind === "agentProfile"
      ? agentProfileTempRoot(assigneeLabel)
      : join("temp", assigneeLabel);
  const createdRootExisted = await env.fs.exists(createdRoot);

  // asSub: dispatcher may hand a free child under its own active task to a helper.
  // Peer dispatch forbids any active-task overlap (including ancestor claims).
  // Stale frontmatter owner is NOT a mutex — only active Task envelopes are.
  const asSub = options.asSub === true;
  const dispatcher = (options.dispatchedBy || "").trim();
  const subUnderDispatcher =
    asSub && Boolean(dispatcher) && dispatcher !== "user" && dispatcher !== assigneeLabel;

  if (claim.root) {
    // Root occupies the whole tent. Sole oracle: any active Task envelope
    // (including claims=[root], which occupiedBoxesFromTasks intentionally skips).
    const blocker = findAnyActiveTask(tasks);
    if (blocker) {
      const claimLabel = blocker.claims.includes("root")
        ? "root"
        : blocker.claims[0] || "unknown";
      throw new Error(
        `Cannot dispatch: Tent root already has an active claim ${claimLabel} (${blocker.role}).`
      );
    }
  } else {
    if (!claim.box.coordination) {
      throw new Error(
        `Cannot dispatch: ${claim.box.name} has coordination=false (type ${claim.box.type}); only coordination-enabled concepts may enter the task lifecycle.`
      );
    }
    const structural = structuralClaimGate(claim.box);
    if (!structural.ok) {
      throw new Error(`Cannot dispatch: ${structural.reason || "box cannot be claimed"}`);
    }
    // Single occupation oracle: active task envelopes (self / ancestor / descendant).
    const claimable = canClaim(claim.box, {
      tent,
      tasks,
      ...(subUnderDispatcher ? { allowAncestorClaimedBy: dispatcher } : {}),
    });
    if (!claimable.ok) {
      throw new Error(`Cannot dispatch: ${claimable.reason || "box cannot be claimed"}`);
    }
  }

  try {
    // Role tasks reuse durable multi-claim aggregation; profile tasks are one-shot
    // and only claim the target box (do not accumulate other profile tasks as claims).
    const roleClaims = claim.root
      ? []
      : assigneeKind === "role"
        ? roleManifestClaims(tent, assigneeLabel, claim.box, tasks)
        : [claim.box];
    const input: DispatchInput = claim.root
      ? { tentName: env.tentName, role: assigneeLabel, claimRoot: true, ...options.workspace }
      : { tentName: env.tentName, role: assigneeLabel, claimBoxes: roleClaims, ...options.workspace };
    const manifest = buildManifest(tent, input);
    const yaml = manifestToYaml(manifest);

    const taskId =
      options.taskId && options.taskId.trim()
        ? options.taskId.trim()
        : makeTaskId();
    let manifestPath: string;
    let initPath: string | undefined;

    if (assigneeKind === "agentProfile") {
      // Task-scoped immutable manifest; never shared manifest.yml / role init / registry.
      manifestPath = agentProfileManifestPath(assigneeLabel, taskId);
      await ensureDir(env.fs, dirName(manifestPath));
      await env.fs.writeFile(manifestPath, yaml);
    } else {
      // manifest 是 role 当前全部 claims 的动态合同；task 文档不可变。
      manifestPath = join("temp", assigneeLabel, "manifest.yml");
      await ensureDir(env.fs, dirName(manifestPath));
      await env.fs.writeFile(manifestPath, yaml);
      const registry = await loadRolesRegistry(env.fs);
      const roleDefinition =
        registry.roles.find((item) => item.name === assigneeLabel) ?? { name: assigneeLabel };
      initPath = await ensureRoleInit(env.fs, roleDefinition, env.tentName);
    }

    const taskClaims = claim.root
      ? [{ id: "root", path: "./" }]
      : [{ id: claim.box.id, path: claim.box.path }];
    const taskPath = await writeTaskEnvelope(env.fs, env.clock, {
      role: assigneeLabel,
      claims: taskClaims,
      manifestPath,
      userPrompt,
      workspace: options.workspace,
      dispatchedBy: options.dispatchedBy,
      asSub: options.asSub === true,
      deliveryPolicy: options.deliveryPolicy,
      assigneeKind,
      id: taskId,
      tasksDir:
        assigneeKind === "agentProfile" ? agentProfileTasksDir(assigneeLabel) : undefined,
    });

    const relayPrompt = relayPromptForTask(
      {
        path: taskPath,
        role: assigneeLabel,
        claims: taskClaims.map((taskClaim) => taskClaim.id),
        manifest: manifestPath,
        status: "pending",
        state: "queued",
        assigneeKind,
        id: taskId,
      },
      env.tentRoot || env.tentName
    );
    return {
      manifestPath,
      manifestYaml: yaml,
      initPath,
      taskPath,
      relayPrompt,
      assigneeKind,
      assignee: assigneeLabel,
    };
  } catch (error) {
    if (!createdRootExisted && (await env.fs.exists(createdRoot))) {
      await env.fs.remove(createdRoot);
    }
    throw error;
  }
}

function assertProfileId(profileId: string): string {
  const id = profileId.trim();
  if (!id) throw new Error("profileId cannot be empty.");
  if (/[\/\\\r\n]/.test(id)) {
    throw new Error("profileId cannot contain path separators or newlines.");
  }
  return id;
}

// ---- task ack / cancel ----

export async function taskAck(env: OpsEnv, taskPath: string): Promise<void> {
  // Alias of task.claim (B0 / B4 lifecycle).
  await taskClaim(env, taskPath);
}

export async function cancelPendingTask(env: OpsEnv, taskPath: string): Promise<void> {
  await withMutation(env.fs, () => cancelTaskEnvelope(env.fs, taskPath));
}

type DispatchClaim =
  | { root: true; id: "root"; name: string }
  | { root: false; id: string; name: string; box: Box };

function resolveDispatchClaim(tent: LoadedTent, claimId: string, tentName: string): DispatchClaim {
  const id = claimId.trim();
  if (id === "." || id === "root" || id === tentName) {
    throw new Error("Cannot dispatch the whole Tent directly; dispatch a specific box (boxId cannot be ., root, or the Tent name).");
  }
  const box = requireBoxById(tent, id);
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
  // Resolve the box under lock first so a missing/invalid id fails before Git work.
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    requireBoxById(tent, boxId);
  });
  // Git integrate stays outside the cross-process mutation lock (long work).
  if (integrate) await integrate();
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = requireBoxById(tent, boxId);
    await setOwner(env.fs, box, undefined, "done", acceptedBy);
  });
}

/** 翻可读:批准 asset 请求时顺手把目标框 readable 改 true(无需二段落地)。 */
export async function grantReadable(env: OpsEnv, boxId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = requireBoxById(tent, boxId);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be made readable.");
    assertContentMutable(box, "made readable");
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
    const box = requireBoxById(tent, boxId);
    if (!box.fm.owner) throw new Error("Only claim roots with a direct owner can be force-released.");
    await setOwner(env.fs, box, undefined, "todo");
    await removeNonAcceptedDeliveriesForBox(env.fs, box.id);
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
    assertContentMutable(parent, "used as create parent");
  }
  const existing = new Set(tent.byId.keys());
  const id = makeUniqueConceptId(existing, env.rand);
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
  assertContentMutable(moved, "moved");
  // Occupation oracle = active tasks (stale owner / locked-from-owner is not a move lock).
  // Freeze model (matches historical isFrozen): a box is frozen when it is the claim
  // root or sits under a claim root — not when it merely has an occupied descendant.
  // Thus ancestors of an occupied box may still move (the claim moves with the subtree).
  const tasks = await loadTaskEnvelopes(env.fs);
  const movedHit = findActiveOccupation(before, moved, tasks);
  if (
    movedHit &&
    (movedHit.relation === "self" || movedHit.relation === "ancestor" || movedHit.relation === "root")
  ) {
    throw new Error("Ranges with an active task cannot be moved; complete or interrupt the task first.");
  }
  if (moved.invalid || moved.archived) {
    throw new Error("Invalid or archived boxes cannot be moved.");
  }
  const movedId = moved.id;
  const movedName = fromPath.slice(fromPath.lastIndexOf("/") + 1);

  const parentBox = newParentPath ? before.byPath.get(newParentPath) : null;
  if (newParentPath && (!parentBox || !isUsableBox(parentBox))) throw new Error("Target parent box is invalid or archived.");
  if (parentBox) assertContentMutable(parentBox, "used as move parent");
  // Target parent is blocked only when the parent itself (or its ancestor) is occupied —
  // a claimed sibling/descendant under the parent does not freeze the parent slot.
  const parentHit = parentBox ? findActiveOccupation(before, parentBox, tasks) : undefined;
  if (parentHit && (parentHit.relation === "self" || parentHit.relation === "ancestor" || parentHit.relation === "root")) {
    throw new Error("Cannot move into a range occupied by an active task; complete or interrupt the task first.");
  }
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
  const reserved = ["id", "owner", "mode", "archived"].filter((key) => key in patch);
  if (reserved.length > 0) throw new Error(`Reserved fields cannot be edited here: ${reserved.join(", ")}.`);
  if (box.archived || box.mode === "archived") {
    throw new Error("Archived boxes can only be restored or permanently deleted.");
  }
  if (box.mode === "read-only") {
    throw new Error("Read-only boxes cannot be patched; use docs.setMode / setNodeMode first.");
  }
  if (box.invalid) {
    const keys = Object.keys(patch);
    if (box.id !== box.invalidRootId || keys.some((key) => key !== "type")) {
      throw new Error("Invalid subtrees can only be repaired by changing the type at the invalid root.");
    }
  }
  if ("type" in patch) {
    if (typeof patch.type !== "string" || !patch.type) throw new Error("Primary type cannot be cleared.");
    if (!typeExists(patch.type, tent.typeRegistry)) throw new Error(`Unknown type: ${patch.type}.`);
  }
  if ("status" in patch) {
    // Status is a long-lived user summary, not a mutex — but while an active task
    // occupies the box, collaboration status is projected by task.* only.
    const tasks = await loadTaskEnvelopes(env.fs);
    const occupied = findActiveOccupation(tent, box, tasks);
    if (occupied) {
      throw new Error(
        "Status for boxes with an active task can only be changed by completing or interrupting the task."
      );
    }
    if (patch.status !== undefined && !["todo", "doing", "done"].includes(String(patch.status))) {
      throw new Error("Status must be todo, doing, or done.");
    }
  }
  const tagsTouched = "tags" in patch;
  const previousTags = box.tags.slice();
  if (tagsTouched) {
    patch = { ...patch, tags: normalizeTagPatch(patch.tags) };
  }
  const boxFile = boxNotePath(boxPath);
  const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete data[k];
    else data[k] = v;
  }
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
  if (tagsTouched) {
    const nextTags = Array.isArray(patch.tags) ? (patch.tags as string[]) : [];
    await syncTagRegistryAfterBoxTagsChangeUnlocked(env.fs, previousTags, nextTags);
  }
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
  if (!box) throw new Error(`Box not found: ${boxPath}.`);
  if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot have their body edited.");
  assertContentMutable(box, "body-edited");
  const boxFile = boxNotePath(boxPath);
  const { data, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, newBody, keyOrder));
}

/**
 * Set Node mode: editable | read-only | archived.
 * Dedicated mutation path — ordinary patch/docs.write cannot set mode.
 * editable/read-only are node-local; archived cascades like the prior archive root.
 */
export async function setNodeMode(env: OpsEnv, boxId: string, mode: NodeMode): Promise<void> {
  await withMutation(env.fs, async () => setNodeModeUnlocked(env, boxId, mode));
}

async function setNodeModeUnlocked(env: OpsEnv, boxId: string, mode: NodeMode): Promise<void> {
  const next = parseNodeMode(mode);
  if (!next) throw new Error('mode must be "editable", "read-only", or "archived".');
  const tent = await loadTent(env.fs);
  const box = requireBoxById(tent, boxId);

  if (box.invalid) throw new Error("Invalid boxes cannot change mode.");

  // Descendants of an archive root stay archived until the root is restored.
  if (box.archived && !isExplicitArchiveRoot(box)) {
    if (next === "archived") {
      throw new Error("Invalid or already archived boxes cannot be archived.");
    }
    throw new Error("Only an explicit archive root can leave archived mode; restore the archive root first.");
  }

  const current: NodeMode = isExplicitArchiveRoot(box)
    ? "archived"
    : box.mode === "read-only"
      ? "read-only"
      : "editable";
  if (current === next) {
    // Idempotent: ensure disk shape for archived/read-only; editable clears keys.
    if (next === "editable") {
      await patchFrontmatter(env.fs, box, { mode: undefined, archived: undefined });
    } else if (next === "read-only") {
      await patchFrontmatter(env.fs, box, { mode: "read-only", archived: undefined });
    } else {
      await patchFrontmatter(env.fs, box, { mode: "archived", archived: undefined });
    }
    return;
  }

  // archived root may restore to editable without occupation check (same as restoreBox today).
  // Other mode transitions block only while an active task occupies the range.
  if (next === "archived" || current !== "archived") {
    const tasks = await loadTaskEnvelopes(env.fs);
    if (findActiveOccupation(tent, box, tasks)) {
      throw new Error(
        next === "archived"
          ? "Ranges with an active task cannot be archived; complete or interrupt the task first."
          : "Ranges with an active task cannot change mode; complete or interrupt the task first."
      );
    }
  }

  if (next === "archived") {
    await patchFrontmatter(env.fs, box, { mode: "archived", archived: undefined });
    return;
  }
  if (next === "read-only") {
    // archive root → read-only is not supported; restore to editable first.
    if (current === "archived") {
      throw new Error("Archived roots must be restored to editable before setting read-only.");
    }
    await patchFrontmatter(env.fs, box, { mode: "read-only", archived: undefined });
    return;
  }
  // editable (including archive restore)
  await patchFrontmatter(env.fs, box, { mode: undefined, archived: undefined });
}

export async function archiveBox(env: OpsEnv, boxId: string): Promise<void> {
  await setNodeMode(env, boxId, "archived");
}

export async function restoreBox(env: OpsEnv, boxId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = requireBoxById(tent, boxId);
    if (!isExplicitArchiveRoot(box)) {
      throw new Error("Only an explicit archive root can restore the subtree.");
    }
    await patchFrontmatter(env.fs, box, { mode: undefined, archived: undefined });
  });
}

export async function deleteArchivedBox(env: OpsEnv, boxId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = requireBoxById(tent, boxId);
    if (!isExplicitArchiveRoot(box)) throw new Error("Box must be archived before permanent deletion.");
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
  if (!Array.isArray(value)) throw new Error("Tags must be a string array.");
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("Tags must be a string array.");
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
    throw new Error("temp/ is a system pipeline; typed boxes cannot be created or moved there.");
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
  assertRoleNameAvailable(name);
  return name;
}

function roleManifestClaims(tent: LoadedTent, role: string, current: Box, tasks: TaskEnvelope[]): Box[] {
  const claims = new Map<string, Box>();
  for (const task of tasks) {
    // Only durable role tasks share multi-claim aggregation; profile tasks are one-shot.
    if (taskAssigneeKind(task) !== "role") continue;
    if (task.role !== role) continue;
    // Active occupation only — do not re-accumulate from stale frontmatter owner.
    if (!envelopeIsActiveOccupation(task)) continue;
    for (const claimId of task.claims) {
      const box = tent.byId.get(claimId);
      if (box) claims.set(box.id, box);
    }
  }
  claims.set(current.id, current);
  return [...claims.values()];
}

function requireBoxById(tent: LoadedTent, boxId: string): Box {
  if (tent.duplicateIds.has(boxId)) {
    throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  }
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  return box;
}

async function withMutation<T>(fs: FsAdapter, action: () => Promise<T>): Promise<T> {
  return withTentMutation(fs, action);
}
