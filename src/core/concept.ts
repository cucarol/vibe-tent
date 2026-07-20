// concept 级操作：promote note→box 等（docs 组命令的 core 实现）。

import { withTentMutation } from "./adapter.js";
import { BOX_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import type { OpsEnv } from "./ops-context.js";
import { loadTaskEnvelopes } from "./task.js";
import { typeHasCoordination } from "./typeRegistry.js";
import { assertContentMutable, boxNotePath, isUsableBox, loadTent, type LoadedTent } from "./tree.js";
import type { Box } from "./types.js";

export interface PromoteResult {
  id: string;
  path: string;
  fromType: string;
  toType: string;
}

/**
 * 原地 promote：note → box。
 * 保留 path / body / cx-；仅改 type（与可选 status:todo）。
 * 不移动文件、不新发 id。
 * box→box promote 遇到 active task / owner 时遵守写保护。
 */
export async function promoteConcept(
  env: OpsEnv,
  conceptIdOrPath: string,
  toType: string
): Promise<PromoteResult> {
  return withTentMutation(env.fs, async () => promoteConceptUnlocked(env, conceptIdOrPath, toType));
}

async function promoteConceptUnlocked(
  env: OpsEnv,
  conceptIdOrPath: string,
  toType: string
): Promise<PromoteResult> {
  const tent = await loadTent(env.fs);
  const concept = resolveConcept(tent, conceptIdOrPath);
  if (!isUsableBox(concept)) throw new Error("Invalid or archived concepts cannot be promoted.");
  assertContentMutable(concept, "promoted");
  const target = toType.trim();
  if (!target) throw new Error("Promote requires a non-empty target type.");
  if (!typeHasCoordination(target, tent.typeRegistry)) {
    throw new Error(`Target type must have coordination capability: ${target}.`);
  }
  if (concept.coordination && concept.type === target) {
    return { id: concept.id, path: concept.path, fromType: concept.type, toType: target };
  }

  // box → box：active owner / pending|taken task 时禁止改 type（写保护）
  if (concept.coordination && concept.type !== target) {
    await assertPromoteWriteAllowed(env, tent, concept);
  }

  const notePath = boxNotePath(concept.path);
  const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(notePath));
  const fromType = typeof data.type === "string" ? data.type : concept.type;
  data.type = target;
  if (data.status !== "todo" && data.status !== "doing" && data.status !== "done") {
    data.status = "todo";
  }
  // 保留 id / body / 路径
  await env.fs.writeFile(notePath, serializeFrontmatter(data, body, keyOrder.length ? keyOrder : BOX_FRONTMATTER_KEY_ORDER));
  return { id: concept.id, path: concept.path, fromType, toType: target };
}

async function assertPromoteWriteAllowed(env: OpsEnv, tent: LoadedTent, concept: Box): Promise<void> {
  if (concept.fm.owner || concept.locked) {
    throw new Error(
      `Cannot promote ${concept.name}: active claim/owner write-protects type changes; stamp or force-release first.`
    );
  }
  const tasks = await loadTaskEnvelopes(env.fs);
  for (const task of tasks) {
    if (task.status !== "pending" && task.status !== "taken") continue;
    if (task.claims.includes(concept.id) || task.claims.includes("root")) {
      throw new Error(
        `Cannot promote ${concept.name}: active task ${task.path} write-protects type changes.`
      );
    }
    for (const claimId of task.claims) {
      const claimed = tent.byId.get(claimId);
      if (!claimed) continue;
      if (isAncestorPath(claimed.path, concept.path) || isAncestorPath(concept.path, claimed.path)) {
        throw new Error(
          `Cannot promote ${concept.name}: overlapping active task ${task.path} write-protects type changes.`
        );
      }
    }
  }
}

function isAncestorPath(ancestor: string, child: string): boolean {
  if (!ancestor) return true;
  return child === ancestor || child.startsWith(ancestor + "/");
}

function resolveConcept(tent: LoadedTent, conceptIdOrPath: string): Box {
  const key = conceptIdOrPath.trim();
  const byId = tent.byId.get(key);
  if (byId) return byId;
  const byPath = tent.byPath.get(key.replace(/\\/g, "/"));
  if (byPath) return byPath;
  throw new Error(`Concept not found: ${conceptIdOrPath}.`);
}
