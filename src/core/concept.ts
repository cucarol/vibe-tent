// concept 级操作：promote note→box 等（docs 组命令的 core 实现）。

import { withTentMutation } from "./adapter.js";
import { BOX_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import type { OpsEnv } from "./ops-context.js";
import { typeHasCoordination } from "./typeRegistry.js";
import { boxNotePath, isUsableBox, loadTent, type LoadedTent } from "./tree.js";
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
  const target = toType.trim();
  if (!target) throw new Error("Promote requires a non-empty target type.");
  if (!typeHasCoordination(target, tent.typeRegistry)) {
    throw new Error(`Target type must have coordination capability: ${target}.`);
  }
  if (concept.coordination && concept.type === target) {
    return { id: concept.id, path: concept.path, fromType: concept.type, toType: target };
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

function resolveConcept(tent: LoadedTent, conceptIdOrPath: string): Box {
  const key = conceptIdOrPath.trim();
  const byId = tent.byId.get(key);
  if (byId) return byId;
  const byPath = tent.byPath.get(key.replace(/\\/g, "/"));
  if (byPath) return byPath;
  throw new Error(`Concept not found: ${conceptIdOrPath}.`);
}
