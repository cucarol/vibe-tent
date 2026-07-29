// Tent 状态动作的统一入口，供 CLI 与插件共同调用。

import { FsAdapter, withTentMutation } from "./adapter.js";
import { loadTent, join, dirName, boxNotePath, LoadedTent } from "./tree.js";
import { buildManifest, manifestToYaml, DispatchInput } from "./manifest.js";
import { makeUniqueConceptId } from "./id.js";
import { BOX_FRONTMATTER_KEY_ORDER, serializeFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { loadOrder, saveOrder, ROOT_KEY } from "./order.js";
import { Box, BoxType, NodeMode } from "./types.js";
import {
  boxHasDirectActiveTask,
  canClaim,
  envelopeIsActiveOccupation,
  structuralClaimGate,
} from "./claim.js";
import { taskDirectlyReferencesNode, taskReferencedNodeIds } from "./task-node-refs.js";
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
  patchTaskEnvelope,
  relayPromptForTask,
  RoleWorkspaceContract,
  taskAssigneeKind,
  TaskEnvelope,
  writeTaskEnvelope,
} from "./task.js";
import { makeTaskId, userTaskActors } from "./task-model.js";
import type { AssigneeKind, DeliveryPolicy } from "./task-model.js";
import {
  agentProfileManifestPath,
  agentProfileTasksDir,
  agentProfileTempRoot,
} from "./paths.js";
import { removeNonAcceptedDeliveriesForBox } from "./delivery.js";
import { validateBoxName } from "./scaffold.js";
import type { OpsEnv } from "./ops-context.js";
import { taskClaim, taskFail, taskInterrupt } from "./task-lifecycle.js";

export type { OpsEnv } from "./ops-context.js";
export { adoptCopiedSubtree, forkNode } from "./forkOps.js";
export { renameNode, type RenameNodeResult } from "./renameOps.js";
export {
  moveNode,
  type MoveNodeResult,
  type MovePosition,
} from "./moveOps.js";

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
  /**
   * Explicit parent actor (V0.2). Required on new dispatch.
   * Role-dispatched Task Agent → parent Role; user-direct → user.
   */
  parentActor: import("./task-model.js").TaskActorRef;
  /**
   * Explicit reviewer (V0.2). Optional: derived equal to parentActor when omitted.
   * When present must equal parentActor (no arbitrary Role A → Role B).
   */
  reviewer?: import("./task-model.js").TaskActorRef;
  /**
   * Sub-dispatch Git lane flag. Missing/false = peer. When true, requires real
   * Git lane and a durable parent Role (validated by service/CLI). asSub is lane-only.
   */
  asSub?: boolean;
  /** Delivery policy for this task (default review). */
  deliveryPolicy?: DeliveryPolicy;
  /**
   * Defaults to role. agentProfile requires profileId and must not register a role.
   */
  assigneeKind?: AssigneeKind;
  /** Required when assigneeKind=agentProfile; stable assignee / delivery label. */
  profileId?: string;
  /**
   * Logical AgentDefinition id for Role-agent dispatch.
   * Persisted on the Task envelope; omitted for user-direct profile one-shots.
   */
  agentId?: string;
  /**
   * Optional preallocated task id (tk-…). Used by asSub profile dispatch so the
   * tent-task/<taskId> lane can be created before the envelope is written.
   */
  taskId?: string;
  /**
   * Optional precomputed contextGeneration (cg-v1-…) from Service stable facts.
   * When omitted, writeTaskEnvelope derives a stable (non-taskId) fallback.
   */
  contextGeneration?: string;
  /** Optional stable fact bag for writeTaskEnvelope when generation is omitted. */
  contextGenerationFacts?: import("./task.js").TaskEnvelopeInput["contextGenerationFacts"];
  /** Optional stable purpose/subKey for Session reuse identity. */
  purpose?: string;
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
  // String shorthand = user-direct Task; translate locally to explicit actors
  // (no dispatchedBy). Object form must already carry parentActor+reviewer.
  const options: DispatchOptions = typeof promptOrOptions === "string"
    ? { userPrompt: promptOrOptions, ...userTaskActors() }
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

  // V0.2 cx-tsw53f: Node refs are non-exclusive. Same Node / ancestor / descendant /
  // workspace context may be referenced by multiple active Tasks. asSub ancestor
  // occupation exception is removed — authority is parentActor/reviewer/roster only.
  // Structural gates only: invalid / archived still deny new dispatch.
  // asSub remains a Git-lane flag only (not an occupation mutex).
  if (!options.parentActor) {
    throw new Error(
      "Dispatch requires explicit parentActor (legacy dispatchedBy is migration-only; reviewer may be derived equal)."
    );
  }
  void options.asSub;
  void tasks;

  if (claim.root) {
    // Workspace/root context is stable context, not a Tent-wide lock.
    // Concurrent root/workspace dispatches are legal.
  } else {
    const structural = structuralClaimGate(claim.box);
    if (!structural.ok) {
      throw new Error(`Cannot dispatch: ${structural.reason || "box cannot be claimed"}`);
    }
    const claimable = canClaim(claim.box, { tent, tasks });
    if (!claimable.ok) {
      throw new Error(`Cannot dispatch: ${claimable.reason || "box cannot be claimed"}`);
    }
  }

  try {
    // Role tasks reuse durable multi-ref aggregation for writable context pointers;
    // profile tasks are one-shot and only select the target box (ephemeral claimBoxes).
    const roleSelection = claim.root
      ? []
      : assigneeKind === "role"
        ? roleManifestSelection(tent, assigneeLabel, claim.box, tasks)
        : [claim.box];
    const input: DispatchInput = claim.root
      ? { tentName: env.tentName, role: assigneeLabel, claimRoot: true, ...options.workspace }
      : { tentName: env.tentName, role: assigneeLabel, claimBoxes: roleSelection, ...options.workspace };
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
      // manifest is the role's dynamic readable/writable context contract (no claims[]).
      // Task envelope is immutable and owns Node refs via contextCard only.
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
    const agentId = options.agentId?.trim() || undefined;
    const taskPath = await writeTaskEnvelope(env.fs, env.clock, {
      role: assigneeLabel,
      claims: taskClaims,
      manifestPath,
      userPrompt,
      workspace: options.workspace,
      parentActor: options.parentActor,
      reviewer: options.reviewer,
      asSub: options.asSub === true,
      deliveryPolicy: options.deliveryPolicy,
      assigneeKind,
      agentId,
      id: taskId,
      tasksDir:
        assigneeKind === "agentProfile" ? agentProfileTasksDir(assigneeLabel) : undefined,
      ...(options.contextGeneration
        ? { contextGeneration: options.contextGeneration }
        : {}),
      ...(options.contextGenerationFacts
        ? { contextGenerationFacts: options.contextGenerationFacts }
        : {}),
      ...(options.purpose?.trim() ? { purpose: options.purpose.trim() } : {}),
    });

    // Load the just-written envelope for an honest relay projection (parent/reviewer included).
    const written = await loadTaskEnvelope(env.fs, taskPath).catch(() => null);
    const parentActor = options.parentActor;
    const reviewer = options.reviewer ?? { ...parentActor };
    // Fallback is relay-only (no claims[] projection). Prefer the loaded envelope with contextCard.
    const relayPrompt = relayPromptForTask(
      written ?? {
        path: taskPath,
        role: assigneeLabel,
        manifest: manifestPath,
        status: "pending" as const,
        state: "queued" as const,
        assigneeKind,
        ...(agentId ? { agentId } : {}),
        id: taskId,
        parentActor,
        reviewer,
        ...(options.asSub === true ? { asSub: true as const } : {}),
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

// ---- stamp / complete (legacy CLI; Node owner/status dual-write retired) ----

const STAMP_RETIRED_MESSAGE =
  "stamp/complete no longer write Node owner/status. Use task.deliver + task.accept (or task.fail) for collaboration completion.";

/**
 * @deprecated Retired: does not dual-write Node frontmatter.
 * Prefer task.deliver / task.accept. Throws with a clear migration message.
 */
export async function stamp(_env: OpsEnv, _boxId: string, _acceptedBy = "user"): Promise<void> {
  void _env;
  void _boxId;
  void _acceptedBy;
  throw new Error(STAMP_RETIRED_MESSAGE);
}

/**
 * @deprecated Retired Node dual-write path.
 * Prefer task lifecycle. Optional integrate still runs only if a non-retired path is restored later;
 * currently always throws after validating the box exists (no FM write).
 */
export async function completeClaim(
  env: OpsEnv,
  boxId: string,
  integrate?: () => Promise<void>,
  _acceptedBy = "user"
): Promise<void> {
  void _acceptedBy;
  // Resolve the box under lock first so a missing/invalid id fails before any work.
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    requireBoxById(tent, boxId);
  });
  void integrate;
  throw new Error(STAMP_RETIRED_MESSAGE);
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

// ---- force-release: cancel/fail active tasks for box (no FM owner clear) ----

/**
 * Release occupation for a box by terminating active tasks that claim it
 * (interrupt running/waiting/delivered; remove queued). Clears non-accepted deliveries.
 * Does not read or write Node frontmatter owner/status.
 */
export async function forceRelease(env: OpsEnv, boxId: string): Promise<void> {
  // Validate box exists first.
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    requireBoxById(tent, boxId);
  });

  const tasks = await loadTaskEnvelopes(env.fs);
  const active = tasks.filter(
    (t) =>
      envelopeIsActiveOccupation(t) &&
      t.contextCard != null &&
      taskDirectlyReferencesNode(t, boxId)
  );
  if (active.length === 0) {
    // Still clean stray non-accepted deliveries for the box.
    await withMutation(env.fs, async () => {
      await removeNonAcceptedDeliveriesForBox(env.fs, boxId);
    });
    return;
  }

  for (const task of active) {
    if (task.state === "queued" || task.status === "pending") {
      await cancelPendingTask(env, task.path);
      continue;
    }
    // Interrupt ends occupation via task state; also clears non-accepted deliveries.
    try {
      await taskInterrupt(env, task.path);
    } catch {
      // If interrupt is invalid for this state, fall through to fail.
      try {
        await taskFail(env, task.path, { summary: "force-release" });
      } catch {
        // Last resort: patch to interrupted + cleanup deliveries under lock.
        await withMutation(env.fs, async () => {
          const current = await loadTaskEnvelope(env.fs, task.path).catch(() => null);
          if (!current) return;
          if (envelopeIsActiveOccupation(current)) {
            await patchTaskEnvelope(env.fs, task.path, {
              state: "interrupted",
              wait: null,
              updatedAt: env.clock.now(),
            });
          }
          await removeNonAcceptedDeliveriesForBox(env.fs, boxId);
        });
      }
    }
  }
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
  // V0.2: new Nodes write only id + type (no owner/status/R/W/mode).
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
  // V0.2: rename/move with stable nodeId remain legal under concurrent Task refs.
  // Context re-resolves by id; path is a refreshable hint. No occupation freeze.
  if (moved.invalid || moved.archived) {
    throw new Error("Invalid or archived boxes cannot be moved.");
  }
  const movedId = moved.id;
  const movedName = fromPath.slice(fromPath.lastIndexOf("/") + 1);

  const parentBox = newParentPath ? before.byPath.get(newParentPath) : null;
  if (newParentPath && (!parentBox || !isUsableBox(parentBox))) throw new Error("Target parent box is invalid or archived.");
  if (parentBox) assertContentMutable(parentBox, "used as move parent");
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
  const reserved = [
    "id",
    "owner",
    "mode",
    "archived",
    "readable",
    "writable",
    "status",
    "relations",
    // Output provenance: only formal task.accept bind path may write deliveryId.
    "deliveryId",
  ].filter((key) => key in patch);
  if (reserved.length > 0) {
    throw new Error(
      `Reserved or retired fields cannot be edited here: ${reserved.join(", ")}. Use docs.setMode for archive; collaboration status lives on Task projection; relations use relation.* RPCs; Output deliveryId binds via task.accept.`
    );
  }
  if (box.archived || box.mode === "archived") {
    throw new Error("Archived boxes can only be restored or permanently deleted.");
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
 * Set Node mode: editable | archived.
 * Dedicated mutation path — ordinary patch/docs.write cannot set mode.
 * V0.2: no read-only mode; archive is the freeze / soft-delete layer.
 */
export async function setNodeMode(env: OpsEnv, boxId: string, mode: NodeMode | string): Promise<void> {
  await withMutation(env.fs, async () => setNodeModeUnlocked(env, boxId, mode));
}

async function setNodeModeUnlocked(env: OpsEnv, boxId: string, mode: NodeMode | string): Promise<void> {
  if (mode === "read-only") {
    throw new Error(
      'read-only mode is retired in V0.2; use "editable" or "archived" (archive freezes the subtree).'
    );
  }
  const next = parseNodeMode(mode);
  if (!next || (next !== "editable" && next !== "archived")) {
    throw new Error('mode must be "editable" or "archived".');
  }
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

  const current: NodeMode = isExplicitArchiveRoot(box) ? "archived" : "editable";
  if (current === next) {
    // Idempotent: ensure disk shape for archived; editable clears keys.
    if (next === "editable") {
      await patchFrontmatter(env.fs, box, { mode: undefined, archived: undefined });
    } else {
      await patchFrontmatter(env.fs, box, { mode: "archived", archived: undefined });
    }
    return;
  }

  // Archive fails only when this exact Node is directly referenced by an active Task.
  // Ancestor/descendant refs do not block. Restore remains free.
  if (next === "archived") {
    const tasks = await loadTaskEnvelopes(env.fs);
    if (boxHasDirectActiveTask(box.id, tasks)) {
      throw new Error(
        "Node is directly referenced by an active task and cannot be archived; complete or interrupt the task first."
      );
    }
  }

  if (next === "archived") {
    await patchFrontmatter(env.fs, box, { mode: "archived", archived: undefined });
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
    const tasks = await loadTaskEnvelopes(env.fs);
    if (hasActiveTaskInSubtree(tent, box, tasks)) {
      throw new Error(
        "Archived subtree still has an active task and cannot be deleted; cancel or fail the task first."
      );
    }

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

/**
 * True when any active task *directly* references a box id in the subtree.
 * Used by purge of archived roots. Workspace context alone does not block purge.
 * Ancestor-only refs outside the subtree do not apply; only direct id matches inside.
 */
function hasActiveTaskInSubtree(
  tent: LoadedTent,
  box: Box,
  tasks: TaskEnvelope[]
): boolean {
  const ids = collectSubtreeIds(box);
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.contextCard == null) continue;
    for (const nodeId of taskReferencedNodeIds(task)) {
      if (ids.has(nodeId)) return true;
    }
  }
  void tent;
  return false;
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

/** Aggregate active role Task Node refs into ephemeral manifest selection boxes. */
function roleManifestSelection(tent: LoadedTent, role: string, current: Box, tasks: TaskEnvelope[]): Box[] {
  const selected = new Map<string, Box>();
  for (const task of tasks) {
    // Only durable role tasks share multi-ref aggregation; profile tasks are one-shot.
    if (taskAssigneeKind(task) !== "role") continue;
    if (task.role !== role) continue;
    // Active tasks only — aggregate direct Node refs (contextCard.refs.nodes).
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.contextCard == null) continue;
    for (const nodeId of taskReferencedNodeIds(task)) {
      const box = tent.byId.get(nodeId);
      if (box) selected.set(box.id, box);
    }
  }
  selected.set(current.id, current);
  return [...selected.values()];
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
