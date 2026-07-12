// concept handle 生成:cx- + 短随机串。创建时一次性生成,之后不可变。
// 注意:核心层不能用 Math.random 直接埋进确定性逻辑,但建 concept 是真实副作用动作,
// 这里接受一个随机源参数,默认用平台随机。插件/CLI 传入各自的实现。

export type RandomSource = () => number;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // 去掉易混字符 i l o u

/** 用户可见 concept handle 前缀（合同冻结）。 */
export const CONCEPT_ID_PREFIX = "cx-";

/** @deprecated 仅迁移窗口识别旧 handle；新写入只用 cx-。 */
export const LEGACY_BOX_ID_PREFIX = "bx-";

export function makeConceptId(rand: RandomSource = Math.random, len = 6): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return CONCEPT_ID_PREFIX + s;
}

/** 确保不撞已有 id。 */
export function makeUniqueConceptId(existing: Set<string>, rand: RandomSource = Math.random): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = makeConceptId(rand);
    if (!existing.has(id)) return id;
  }
  // 极端兜底:加长
  return makeConceptId(rand, 10);
}

/** @deprecated 使用 makeConceptId；保留别名以免外部调用瞬间断裂。 */
export const makeBoxId = makeConceptId;

/** @deprecated 使用 makeUniqueConceptId。 */
export const makeUniqueBoxId = makeUniqueConceptId;

export function isConceptId(id: string): boolean {
  return id.startsWith(CONCEPT_ID_PREFIX) && id.length > CONCEPT_ID_PREFIX.length;
}

export function isLegacyBoxId(id: string): boolean {
  return id.startsWith(LEGACY_BOX_ID_PREFIX) && id.length > LEGACY_BOX_ID_PREFIX.length;
}

/** 任意合法 handle（新 cx- 或迁移前遗留 bx-）。 */
export function isHandleId(id: string): boolean {
  return isConceptId(id) || isLegacyBoxId(id);
}
