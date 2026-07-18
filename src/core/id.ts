// concept / role handle 生成:前缀 + 短随机串。创建时一次性生成,之后不可变。
// 注意:核心层不能用 Math.random 直接埋进确定性逻辑,但建 concept/role 是真实副作用动作,
// 这里接受一个随机源参数,默认用平台随机。插件/CLI 传入各自的实现。
// 旧 roles.json 无 id 时用 name 的确定性哈希补齐,保证同名多次加载得到同一 rl-。

import { createHash } from "node:crypto";

export type RandomSource = () => number;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // 去掉易混字符 i l o u

/** 用户可见 concept handle 前缀（合同冻结）。 */
export const CONCEPT_ID_PREFIX = "cx-";

/** Role 稳定身份前缀（合同冻结）。 */
export const ROLE_ID_PREFIX = "rl-";

/** @deprecated 仅迁移窗口识别旧 handle；新写入只用 cx-。 */
export const LEGACY_BOX_ID_PREFIX = "bx-";

function encodeAlphabetBytes(bytes: Uint8Array, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    // Cycle input bytes; mix index so short digests still expand.
    const b = bytes[i % bytes.length]! ^ ((i * 17) & 0xff);
    s += ALPHABET[b % ALPHABET.length];
  }
  return s;
}

function makePrefixedId(prefix: string, rand: RandomSource = Math.random, len = 6): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return prefix + s;
}

function makeUniquePrefixedId(
  prefix: string,
  existing: Set<string>,
  rand: RandomSource = Math.random
): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = makePrefixedId(prefix, rand);
    if (!existing.has(id)) return id;
  }
  return makePrefixedId(prefix, rand, 10);
}

export function makeConceptId(rand: RandomSource = Math.random, len = 6): string {
  return makePrefixedId(CONCEPT_ID_PREFIX, rand, len);
}

/** 确保不撞已有 id。 */
export function makeUniqueConceptId(existing: Set<string>, rand: RandomSource = Math.random): string {
  return makeUniquePrefixedId(CONCEPT_ID_PREFIX, existing, rand);
}

/** 新 role 写入用随机 rl- handle。 */
export function makeRoleId(rand: RandomSource = Math.random, len = 6): string {
  return makePrefixedId(ROLE_ID_PREFIX, rand, len);
}

/** 确保不撞已有 role id。 */
export function makeUniqueRoleId(existing: Set<string>, rand: RandomSource = Math.random): string {
  return makeUniquePrefixedId(ROLE_ID_PREFIX, existing, rand);
}

/**
 * 旧 roles.json 无 id 时的确定性补齐：同一 name 始终得到同一 rl-（碰撞时加长）。
 * 仅用于迁移/加载；新 create 必须用 makeUniqueRoleId。
 */
export function deterministicRoleIdFromName(name: string, existing: Set<string> = new Set()): string {
  const key = name.trim();
  const digest = createHash("sha256").update(`tent.role.id.v1:${key}`).digest();
  for (let len = 6; len <= 16; len++) {
    const id = ROLE_ID_PREFIX + encodeAlphabetBytes(digest, len);
    if (!existing.has(id)) return id;
  }
  // 极端兜底：带 name 后缀再哈希，避免与已占用 id 冲突。
  const fallback = createHash("sha256")
    .update(`tent.role.id.v1.fallback:${key}:${[...existing].sort().join(",")}`)
    .digest();
  return ROLE_ID_PREFIX + encodeAlphabetBytes(fallback, 12);
}

/** @deprecated 使用 makeConceptId；保留别名以免外部调用瞬间断裂。 */
export const makeBoxId = makeConceptId;

/** @deprecated 使用 makeUniqueConceptId。 */
export const makeUniqueBoxId = makeUniqueConceptId;

export function isConceptId(id: string): boolean {
  return id.startsWith(CONCEPT_ID_PREFIX) && id.length > CONCEPT_ID_PREFIX.length;
}

export function isRoleId(id: string): boolean {
  return id.startsWith(ROLE_ID_PREFIX) && id.length > ROLE_ID_PREFIX.length;
}

export function isLegacyBoxId(id: string): boolean {
  return id.startsWith(LEGACY_BOX_ID_PREFIX) && id.length > LEGACY_BOX_ID_PREFIX.length;
}

/** 任意合法 concept handle（新 cx- 或迁移前遗留 bx-）。 */
export function isHandleId(id: string): boolean {
  return isConceptId(id) || isLegacyBoxId(id);
}
