// Tent 状态动作的统一入口，供 CLI 与插件共同调用。

import { FsAdapter, withTentMutation } from "./adapter.js";
import { loadTent, join, dirName, nodeNotePath, LoadedTent } from "./tree.js";
import { buildManifest, manifestToYaml, DispatchInput } from "./manifest.js";
import { assertRouteId, makeUniqueNodeId } from "./id.js";
import { NODE_FRONTMATTER_KEY_ORDER, serializeFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { loadOrder, saveOrder, ROOT_KEY } from "./order.js";
import { Node, NodeType, NodeMode } from "./types.js";
import {
  canClaim,
  envelopeIsActiveOccupation,
  structuralClaimGate,
} from "./claim.js";
import { taskDirectlyReferencesNode, taskReferencedNodeIds } from "./task-node-refs.js";
import { assertContentMutable, isExplicitArchiveRoot, isUsableNode, parseNodeMode } from "./tree.js";
import {
  addRegistryTag,
  addTag,
  removeRegistryTag,
  removeTag,
  normalizeTagName,
  syncTagRegistryAfterNodeTagsChangeUnlocked,
} from "./tags.js";
import { assertValidNodeType } from "./typeRegistry.js";
import { assertRoleNameAvailable, loadRolesRegistry } from "./skillRoleRegistry.js";
import {
  cancelTaskEnvelope,
  ensureRoleInit,
  loadTaskEnvelope,
  loadTaskEnvelopes,
  patchTaskEnvelope,
  relayPromptForTask,
  RoleWorkspaceContract,
  TaskEnvelope,
  writeTaskEnvelope,
} from "./task.js";
import { makeTaskId } from "./task-model.js";
import type { AssigneeKind, DeliveryPolicy } from "./task-model.js";
import {
  routeManifestPath,
  routeTasksDir,
  routeTempRoot,
} from "./paths.js";
import { removeNonAcceptedDeliveriesForNode } from "./delivery.js";
import { validateNodeName } from "./scaffold.js";
import type { OpsEnv } from "./ops-context.js";
import { taskClaim, taskFail, taskInterrupt } from "./task-lifecycle.js";
import { assertNoActiveTaskRefsInSubtree } from "./renameOps.js";

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
  /** Present for Role tasks; omitted for temporary route tasks. */
  initPath?: string;
  taskPath: string;
  relayPrompt: string;
  assigneeKind: AssigneeKind;
  assigneeId: string;
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
   * Canonical executor kind. Responsibility remains parentActor/reviewer.
   */
  assigneeKind: AssigneeKind;
  /** Stable Role name or Settings route id, selected by assigneeKind. */
  assigneeId: string;
  /**
   * Optional preallocated task id (tk-…). Used by asSub route dispatch so the
   * tent-task/<taskId> lane can be created before the envelope is written.
   */
  taskId?: string;
  /**
   * Authoritative transient multi-Node dispatch source (durable Node IDs).
   * Non-empty; order-preserving dedupe; each id resolved + structurally gated
   * before any Task/manifest write. Persisted only as Task.contextCard.refs.nodes[].
   * When omitted, the dispatch primary Node
   * is used as a one-element list.
   */
  nodeIds?: string[];
}

/**
 * Resolve the authoritative ordered Node id list for dispatch.
 * Prefers `nodeIds` when present; otherwise uses the required primary Node.
 * When both are present, the primary must equal the first deduped nodeId.
 * Rejects empty/malformed lists and root/workspace tokens (no fake root Node).
 */
export function resolveDispatchNodeIds(input: {
  nodeIds?: string[] | null;
  primaryNodeId?: string | null;
  tentName: string;
}): string[] {
  const tentName = input.tentName.trim();
  const primaryNodeId = input.primaryNodeId?.trim() ?? "";

  if (input.nodeIds !== undefined && input.nodeIds !== null) {
    if (!Array.isArray(input.nodeIds)) {
      throw new Error("Dispatch nodeIds must be a non-empty string array of durable Node IDs.");
    }
    if (input.nodeIds.length === 0) {
      throw new Error("Dispatch nodeIds must be a non-empty string array of durable Node IDs.");
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < input.nodeIds.length; i++) {
      const raw = input.nodeIds[i];
      if (typeof raw !== "string" || !raw.trim()) {
        throw new Error(
          `Dispatch nodeIds[${i}] must be a non-empty durable Node ID string.`
        );
      }
      const id = raw.trim();
      if (isForbiddenRootDispatchToken(id, tentName)) {
        throw new Error(
          "Cannot dispatch the whole Tent directly; dispatch specific Nodes " +
            "(nodeIds cannot include ., root, or the Tent name)."
        );
      }
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    if (out.length === 0) {
      throw new Error("Dispatch nodeIds must be a non-empty string array of durable Node IDs.");
    }
    if (primaryNodeId) {
      if (isForbiddenRootDispatchToken(primaryNodeId, tentName)) {
        throw new Error(
          "Cannot dispatch the whole Tent directly; dispatch a specific Node " +
            "(primary Node cannot be ., root, or the Tent name)."
        );
      }
      if (primaryNodeId !== out[0]) {
        throw new Error(
          `Dispatch primary Node '${primaryNodeId}' conflicts with nodeIds[0] '${out[0]}'.`
        );
      }
    }
    return out;
  }

  if (!primaryNodeId) {
    throw new Error("Dispatch requires at least one Node.");
  }
  if (isForbiddenRootDispatchToken(primaryNodeId, tentName)) {
    throw new Error(
      "Cannot dispatch the whole Tent directly; dispatch a specific Node " +
        "(primary Node cannot be ., root, or the Tent name)."
    );
  }
  return [primaryNodeId];
}

function isForbiddenRootDispatchToken(id: string, tentName: string): boolean {
  return id === "." || id === "root" || (tentName !== "" && id === tentName);
}

/**
 * Dispatch a Task from one or more Nodes. The primary Node is always the first
 * selected Node; `options.nodeIds` carries an ordered multi-Node selection.
 */
export async function dispatch(
  env: OpsEnv,
  primaryNodeId: string,
  options: DispatchOptions
): Promise<DispatchResult> {
  return withMutation(env.fs, async () =>
    dispatchUnlocked(env, primaryNodeId, options)
  );
}

async function dispatchUnlocked(
  env: OpsEnv,
  primaryNodeId: string,
  options: DispatchOptions
): Promise<DispatchResult> {
  const tent = await loadTent(env.fs);
  const assigneeKind = options.assigneeKind;
  const userPrompt = options.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");

  const rawAssigneeId = options.assigneeId.trim();
  const assigneeId =
    assigneeKind === "route" ? assertRouteId(rawAssigneeId) : assertRoleName(rawAssigneeId);

  // Resolve and gate every selected Node before writes.
  const nodeIds = resolveDispatchNodeIds({
    nodeIds: options.nodeIds,
    primaryNodeId,
    tentName: env.tentName,
  });
  const tasks = await loadTaskEnvelopes(env.fs);
  // Cleanup only removes what this dispatch creates. Role: temp/<role>/ when new.
  // Route: temp/routes/<safe>/ when new (never tent-role/*).
  const createdRoot =
    assigneeKind === "route" ? routeTempRoot(assigneeId) : join("temp", assigneeId);
  const createdRootExisted = await env.fs.exists(createdRoot);

  // Exact Nodes are exclusive across active Tasks. Ancestors, descendants, siblings,
  // and workspace context remain independent. asSub is a Git-lane flag only.
  if (!options.parentActor) {
    throw new Error(
      "Dispatch requires explicit parentActor; reviewer may be derived equal."
    );
  }
  void options.asSub;

  // Resolve every requested Node under this mutation; fail loud before any write.
  // Exact ordered refs only — no silent ancestry/descendant expansion into Context Card
  // and no aggregation of other active Role Task refs into this Task's selection.
  const selectedNodes: Node[] = [];
  for (const id of nodeIds) {
    const node = requireNodeById(tent, id);
    const structural = structuralClaimGate(node);
    if (!structural.ok) {
      throw new Error(`Cannot dispatch: ${structural.reason || "Node cannot be claimed"}`);
    }
    const claimable = canClaim(node, { tasks });
    if (!claimable.ok) {
      throw new Error(`Cannot dispatch: ${claimable.reason || "Node cannot be claimed"}`);
    }
    selectedNodes.push(node);
  }

  try {
    // Manifest is auxiliary and must snapshot the same exact requested Node set
    // (one fact with Context Card). Do not pull in other active Role Task refs.
    const input: DispatchInput = {
      tentName: env.tentName,
      assigneeKind,
      assigneeId,
      claimNodes: selectedNodes,
      ...options.workspace,
    };
    const manifest = buildManifest(tent, input);
    const yaml = manifestToYaml(manifest);

    const taskId =
      options.taskId && options.taskId.trim()
        ? options.taskId.trim()
        : makeTaskId();
    let manifestPath: string;
    let initPath: string | undefined;

    if (assigneeKind === "route") {
      manifestPath = routeManifestPath(assigneeId, taskId);
      await ensureDir(env.fs, dirName(manifestPath));
      await env.fs.writeFile(manifestPath, yaml);
    } else {
      // Every Task owns an immutable manifest snapshot. A shared Role manifest would
      // let concurrent sibling Tasks overwrite each other's writable Node selection.
      manifestPath = join("temp", assigneeId, "manifests", `${taskId}.yml`);
      await ensureDir(env.fs, dirName(manifestPath));
      await env.fs.writeFile(manifestPath, yaml);
      const registry = await loadRolesRegistry(env.fs);
      const roleDefinition =
        registry.roles.find((item) => item.name === assigneeId) ?? { name: assigneeId };
      initPath = await ensureRoleInit(env.fs, roleDefinition, env.tentName);
    }

    // Sole persisted Node-ref source is contextCard.refs.nodes via writeTaskEnvelope.
    // Pass exact ordered selection only.
    const taskNodeRefs = selectedNodes.map((node) => ({ id: node.id, path: node.path }));
    const taskPath = await writeTaskEnvelope(env.fs, env.clock, {
      assigneeKind,
      assigneeId,
      nodeRefs: taskNodeRefs,
      manifestPath,
      userPrompt,
      workspace: options.workspace,
      parentActor: options.parentActor,
      reviewer: options.reviewer,
      asSub: options.asSub === true,
      deliveryPolicy: options.deliveryPolicy,
      id: taskId,
      tasksDir:
        assigneeKind === "route" ? routeTasksDir(assigneeId) : undefined,
    });

    // Load the just-written envelope for an honest relay projection (parent/reviewer included).
    const written = await loadTaskEnvelope(env.fs, taskPath);
    const relayPrompt = relayPromptForTask(written, env.tentRoot || env.tentName);
    return {
      manifestPath,
      manifestYaml: yaml,
      initPath,
      taskPath,
      relayPrompt,
      assigneeKind,
      assigneeId,
    };
  } catch (error) {
    if (!createdRootExisted && (await env.fs.exists(createdRoot))) {
      await env.fs.remove(createdRoot);
    }
    throw error;
  }
}

// ---- task ack / cancel ----

export async function taskAck(env: OpsEnv, taskPath: string): Promise<void> {
  // Alias of task.claim (B0 / B4 lifecycle).
  await taskClaim(env, taskPath);
}

export async function cancelPendingTask(env: OpsEnv, taskPath: string): Promise<void> {
  await withMutation(env.fs, () => cancelTaskEnvelope(env.fs, taskPath));
}

// ---- stamp / complete (legacy CLI; Node owner/status dual-write retired) ----

const STAMP_RETIRED_MESSAGE =
  "stamp/complete no longer write Node owner/status. Use task.deliver + task.accept (or task.fail) for collaboration completion.";

/**
 * @deprecated Retired: does not dual-write Node frontmatter.
 * Prefer task.deliver / task.accept. Throws with a clear migration message.
 */
export async function stamp(_env: OpsEnv, _nodeId: string, _acceptedBy = "user"): Promise<void> {
  void _env;
  void _nodeId;
  void _acceptedBy;
  throw new Error(STAMP_RETIRED_MESSAGE);
}

/**
 * @deprecated Retired Node dual-write path.
 * Prefer task lifecycle. Optional integrate still runs only if a non-retired path is restored later;
 * currently always throws after validating the node exists (no FM write).
 */
export async function completeClaim(
  env: OpsEnv,
  nodeId: string,
  integrate?: () => Promise<void>,
  _acceptedBy = "user"
): Promise<void> {
  void _acceptedBy;
  // Resolve the node under lock first so a missing/invalid id fails before any work.
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    requireNodeById(tent, nodeId);
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

// ---- force-release: cancel/fail active tasks for node (no FM owner clear) ----

/**
 * Release occupation for a node by terminating active tasks that claim it
 * (interrupt running/waiting/delivered; remove queued). Clears non-accepted deliveries.
 * Does not read or write Node frontmatter owner/status.
 */
export async function forceRelease(env: OpsEnv, nodeId: string): Promise<void> {
  // Validate node exists first.
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    requireNodeById(tent, nodeId);
  });

  const tasks = await loadTaskEnvelopes(env.fs);
  const active = tasks.filter(
    (t) =>
      envelopeIsActiveOccupation(t) &&
      t.contextCard != null &&
      taskDirectlyReferencesNode(t, nodeId)
  );
  if (active.length === 0) {
    // Still clean stray non-accepted deliveries for the node.
    await withMutation(env.fs, async () => {
      await removeNonAcceptedDeliveriesForNode(env.fs, nodeId);
    });
    return;
  }

  for (const task of active) {
    if (task.state === "queued") {
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
          await removeNonAcceptedDeliveriesForNode(env.fs, nodeId);
        });
      }
    }
  }

  // force-release is the explicit Node-wide cleanup operation. Ordinary
  // task.fail/task.interrupt cleanup is deliberately exact-Task only.
  await withMutation(env.fs, async () => {
    await removeNonAcceptedDeliveriesForNode(env.fs, nodeId);
  });
}

// ---- tags ----

export async function tagNode(env: OpsEnv, nodeId: string, name: string): Promise<void> {
  await addTag(env.fs, nodeId, normalizeTagName(name));
}

export async function untagNode(env: OpsEnv, nodeId: string, name: string): Promise<void> {
  await removeTag(env.fs, nodeId, normalizeTagName(name));
}

export async function createTag(env: OpsEnv, name: string): Promise<void> {
  await addRegistryTag(env.fs, normalizeTagName(name));
}

export async function deleteTag(env: OpsEnv, name: string): Promise<void> {
  await removeRegistryTag(env.fs, normalizeTagName(name));
}

// ---- 结构编辑(建框/移动/改属性)----
// 这些是 user 的即时编辑；Tent 本身不使用 Git。

export interface NewNodeInput {
  parentPath: string; // "" = 顶层
  name: string;
  type: NodeType;
}

export async function createNode(env: OpsEnv, input: NewNodeInput): Promise<string> {
  return withMutation(env.fs, async () => createNodeUnlocked(env, input));
}

async function createNodeUnlocked(env: OpsEnv, input: NewNodeInput): Promise<string> {
  assertNotTempPath(input.parentPath);
  const name = validateNodeName(input.name);
  const tent = await loadTent(env.fs);
  assertValidNodeType(input.type, tent.typeRegistry);
  if (input.parentPath) {
    const parent = tent.byPath.get(input.parentPath);
    if (!parent || !isUsableNode(parent)) throw new Error("Target parent node is invalid or archived.");
    assertContentMutable(parent, "used as create parent");
  }
  const existing = new Set(tent.byId.keys());
  const id = makeUniqueNodeId(existing, env.rand);
  const path = join(input.parentPath, name);
  assertNotTempPath(path);
  await ensureDir(env.fs, path);
  // V0.2: new Nodes write only id + type (no owner/status/R/W/mode).
  const fm = { id, type: input.type };
  const content = serializeFrontmatter(fm, `\n# ${name}\n`, NODE_FRONTMATTER_KEY_ORDER);
  await env.fs.writeFile(nodeNotePath(path), content);
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
export async function placeNode(
  env: OpsEnv,
  fromPath: string,
  newParentPath: string,
  position: DropPosition
): Promise<void> {
  await withMutation(env.fs, async () => placeNodeUnlocked(env, fromPath, newParentPath, position));
}

async function placeNodeUnlocked(
  env: OpsEnv,
  fromPath: string,
  newParentPath: string,
  position: DropPosition
): Promise<void> {
  assertNotTempPath(newParentPath);
  const before = await loadTent(env.fs);
  const moved = before.byPath.get(fromPath);
  if (!moved) throw new Error(`Node not found: ${fromPath}.`);
  if (!isUsableNode(moved)) throw new Error("Invalid or archived nodes cannot be moved.");
  assertContentMutable(moved, "moved");
  if (moved.invalid || moved.archived) {
    throw new Error("Invalid or archived nodes cannot be moved.");
  }
  await assertNoActiveTaskRefsInSubtree(env, moved, "move");
  const movedId = moved.id;
  const movedName = fromPath.slice(fromPath.lastIndexOf("/") + 1);

  const parentNode = newParentPath ? before.byPath.get(newParentPath) : null;
  if (newParentPath && (!parentNode || !isUsableNode(parentNode))) throw new Error("Target parent node is invalid or archived.");
  if (parentNode) assertContentMutable(parentNode, "used as move parent");
  if (newParentPath === fromPath || newParentPath.startsWith(fromPath + "/")) {
    throw new Error("Cannot move a node into its own subtree.");
  }
  const parentKey = parentNode ? parentNode.id : ROOT_KEY;
  const oldParentKey = moved.parent ? moved.parent.id : ROOT_KEY;

  // 目标父级现有子框(已按当前 order 排好),排除被移动者 → 期望 id 序列
  const siblings = (parentNode ? parentNode.children : before.roots)
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

export async function patchNode(
  env: OpsEnv,
  nodePath: string,
  patch: Record<string, unknown>,
  loadedTent?: LoadedTent
): Promise<void> {
  await withMutation(env.fs, async () => patchNodeUnlocked(env, nodePath, patch, loadedTent));
}

async function patchNodeUnlocked(
  env: OpsEnv,
  nodePath: string,
  patch: Record<string, unknown>,
  loadedTent?: LoadedTent
): Promise<void> {
  const tent = loadedTent ?? await loadTent(env.fs);
  const node = tent.byPath.get(nodePath);
  if (!node) throw new Error(`Node not found: ${nodePath}.`);
  const reserved = [
    "id",
    "owner",
    "assignee",
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
  if (node.archived || node.mode === "archived") {
    throw new Error("Archived nodes can only be restored or permanently deleted.");
  }
  if (node.invalid) {
    const keys = Object.keys(patch);
    if (node.id !== node.invalidRootId || keys.some((key) => key !== "type")) {
      throw new Error("Invalid subtrees can only be repaired by changing the type at the invalid root.");
    }
  }
  if ("type" in patch) {
    if (typeof patch.type !== "string" || !patch.type) throw new Error("Primary type cannot be cleared.");
    assertValidNodeType(patch.type, tent.typeRegistry);
  }
  const tagsTouched = "tags" in patch;
  const previousTags = node.tags.slice();
  if (tagsTouched) {
    patch = { ...patch, tags: normalizeTagPatch(patch.tags) };
  }
  const boxFile = nodeNotePath(nodePath);
  const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete data[k];
    else data[k] = v;
  }
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, body, nodeKeyOrder(keyOrder)));
  if (tagsTouched) {
    const nextTags = Array.isArray(patch.tags) ? (patch.tags as string[]) : [];
    await syncTagRegistryAfterNodeTagsChangeUnlocked(env.fs, previousTags, nextTags);
  }
}

/** 改框正文(note)。保留 frontmatter 原样。 */
export async function patchBody(
  env: OpsEnv,
  nodePath: string,
  newBody: string,
  loadedTent?: LoadedTent
): Promise<void> {
  await withMutation(env.fs, async () => patchBodyUnlocked(env, nodePath, newBody, loadedTent));
}

async function patchBodyUnlocked(
  env: OpsEnv,
  nodePath: string,
  newBody: string,
  loadedTent?: LoadedTent
): Promise<void> {
  const tent = loadedTent ?? await loadTent(env.fs);
  const node = tent.byPath.get(nodePath);
  if (!node) throw new Error(`Node not found: ${nodePath}.`);
  if (!isUsableNode(node)) throw new Error("Invalid or archived nodes cannot have their body edited.");
  assertContentMutable(node, "body-edited");
  const boxFile = nodeNotePath(nodePath);
  const { data, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, newBody, keyOrder));
}

/**
 * Set Node mode: editable | archived.
 * Dedicated mutation path — ordinary patch/docs.write cannot set mode.
 * V0.2: no read-only mode; archive is the freeze / soft-delete layer.
 */
export async function setNodeMode(env: OpsEnv, nodeId: string, mode: NodeMode | string): Promise<void> {
  await withMutation(env.fs, async () => setNodeModeUnlocked(env, nodeId, mode));
}

async function setNodeModeUnlocked(env: OpsEnv, nodeId: string, mode: NodeMode | string): Promise<void> {
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
  const node = requireNodeById(tent, nodeId);

  if (node.invalid) throw new Error("Invalid nodes cannot change mode.");

  // Descendants of an archive root stay archived until the root is restored.
  if (node.archived && !isExplicitArchiveRoot(node)) {
    if (next === "archived") {
      throw new Error("Invalid or already archived nodes cannot be archived.");
    }
    throw new Error("Only an explicit archive root can leave archived mode; restore the archive root first.");
  }

  const current: NodeMode = isExplicitArchiveRoot(node) ? "archived" : "editable";
  if (current === next) {
    // Idempotent: ensure disk shape for archived; editable clears keys.
    if (next === "editable") {
      await patchFrontmatter(env.fs, node, { mode: undefined, archived: undefined });
    } else {
      await patchFrontmatter(env.fs, node, { mode: "archived", archived: undefined });
    }
    return;
  }

  // Archive freezes the entire subtree, so any active Task inside that subtree
  // blocks the structural mutation. Tasks on ancestors or unrelated branches do not.
  if (next === "archived") {
    const tasks = await loadTaskEnvelopes(env.fs);
    if (hasActiveTaskInSubtree(tent, node, tasks)) {
      throw new Error(
        "Node subtree has an active task and cannot be archived; complete or interrupt the task first."
      );
    }
  }

  if (next === "archived") {
    await patchFrontmatter(env.fs, node, { mode: "archived", archived: undefined });
    return;
  }
  // editable (including archive restore)
  await patchFrontmatter(env.fs, node, { mode: undefined, archived: undefined });
}

export async function archiveNode(env: OpsEnv, nodeId: string): Promise<void> {
  await setNodeMode(env, nodeId, "archived");
}

export async function restoreNode(env: OpsEnv, nodeId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const node = requireNodeById(tent, nodeId);
    if (!isExplicitArchiveRoot(node)) {
      throw new Error("Only an explicit archive root can restore the subtree.");
    }
    await patchFrontmatter(env.fs, node, { mode: undefined, archived: undefined });
  });
}

export async function deleteArchivedNode(env: OpsEnv, nodeId: string): Promise<void> {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const node = requireNodeById(tent, nodeId);
    if (!isExplicitArchiveRoot(node)) throw new Error("Node must be archived before permanent deletion.");
    const tasks = await loadTaskEnvelopes(env.fs);
    if (hasActiveTaskInSubtree(tent, node, tasks)) {
      throw new Error(
        "Archived subtree still has an active task and cannot be deleted; cancel or fail the task first."
      );
    }

    const removedIds = collectSubtreeIds(node);
    await env.fs.remove(node.path);
    const order = await loadOrder(env.fs);
    for (const key of Object.keys(order)) {
      if (removedIds.has(key)) delete order[key];
      else order[key] = order[key].filter((id) => !removedIds.has(id));
    }
    await saveOrder(env.fs, order);
  });
}

// ---- 内部工具 ----

async function patchFrontmatter(fs: FsAdapter, node: Node, patch: Record<string, unknown>): Promise<void> {
  const boxFile = nodeNotePath(node.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete data[k];
    else data[k] = v;
  }
  await fs.writeFile(boxFile, serializeFrontmatter(data, body, nodeKeyOrder(keyOrder)));
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

function nodeKeyOrder(existing: string[]): string[] {
  return [
    ...NODE_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !NODE_FRONTMATTER_KEY_ORDER.includes(key)),
  ];
}

function assertNotTempPath(path: string): void {
  if (path === "temp" || path.startsWith("temp/")) {
    throw new Error("temp/ is a system pipeline; typed nodes cannot be created or moved there.");
  }
}

/**
 * True when any active task *directly* references a node id in the subtree.
 * Used by purge of archived roots. Workspace context alone does not block purge.
 * Ancestor-only refs outside the subtree do not apply; only direct id matches inside.
 */
function hasActiveTaskInSubtree(
  tent: LoadedTent,
  node: Node,
  tasks: TaskEnvelope[]
): boolean {
  const ids = collectSubtreeIds(node);
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

function collectSubtreeIds(node: Node, ids = new Set<string>()): Set<string> {
  ids.add(node.id);
  for (const child of node.children) collectSubtreeIds(child, ids);
  return ids;
}

function assertRoleName(role: string): string {
  const name = role.trim();
  if (!name) throw new Error("Role name cannot be empty.");
  if (/[\/\\\r\n]/.test(name)) throw new Error("Role name cannot contain path separators or newlines.");
  assertRoleNameAvailable(name);
  return name;
}

function requireNodeById(tent: LoadedTent, nodeId: string): Node {
  if (tent.duplicateIds.has(nodeId)) {
    throw new Error(`Duplicate node id '${nodeId}' found; repair or fork the duplicate nodes before using this id.`);
  }
  const node = tent.byId.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}.`);
  return node;
}

async function withMutation<T>(fs: FsAdapter, action: () => Promise<T>): Promise<T> {
  return withTentMutation(fs, action);
}
