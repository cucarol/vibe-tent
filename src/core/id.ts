// Node / role handle 生成：前缀 + 短随机串。创建时一次性生成，之后不可变。
// 注意：核心层不能用 Math.random 直接埋进确定性逻辑，但创建 Node/role 是真实副作用动作，
// 这里接受一个随机源参数,默认用平台随机。插件/CLI 传入各自的实现。
// 旧 roles.json 无 id 时用 name 的确定性哈希补齐,保证同名多次加载得到同一 rl-。
// 确定性哈希刻意不用 node:crypto，保持 core 可在无 Node crypto 的环境复用。

export type RandomSource = () => number;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // 去掉易混字符 i l o u

/** User-visible Node handle prefix. */
export const NODE_ID_PREFIX = "cx-";
export const CONNECTION_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** Canonical machine Agent Connection id shared by Core, Service, and Session disk. */
export function isConnectionId(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_ID_RE.test(value);
}

export function assertConnectionId(value: string): string {
  const connectionId = value.trim();
  if (!isConnectionId(connectionId)) {
    throw new Error(
      `Invalid connectionId: must match ${CONNECTION_ID_RE} (lowercase letter, then a-z0-9-, max 63).`
    );
  }
  return connectionId;
}

/** Role 稳定身份前缀（合同冻结）。 */
export const ROLE_ID_PREFIX = "rl-";
/** Exact Session identity prefix shared by Task and runtime persistence. */
export const SESSION_ID_PREFIX = "ss-";

/**
 * Platform-neutral deterministic digest (FNV-1a lanes + mix).
 * Used only for legacy role id projection — not cryptographic.
 */
export function deterministicDigest(input: string, byteLen = 32): Uint8Array {
  const out = new Uint8Array(byteLen);
  for (let offset = 0; offset < byteLen; offset += 4) {
    // Distinct lane salt so short inputs still expand across the buffer.
    let h = (0x811c9dc5 ^ Math.imul(offset + 1, 0x9e3779b9)) >>> 0;
    const salted = `${offset}\0${input}`;
    for (let i = 0; i < salted.length; i++) {
      h ^= salted.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    out[offset] = h & 0xff;
    if (offset + 1 < byteLen) out[offset + 1] = (h >>> 8) & 0xff;
    if (offset + 2 < byteLen) out[offset + 2] = (h >>> 16) & 0xff;
    if (offset + 3 < byteLen) out[offset + 3] = (h >>> 24) & 0xff;
  }
  return out;
}

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

export function makeNodeId(rand: RandomSource = Math.random, len = 6): string {
  return makePrefixedId(NODE_ID_PREFIX, rand, len);
}

/** 确保不撞已有 id。 */
export function makeUniqueNodeId(existing: Set<string>, rand: RandomSource = Math.random): string {
  return makeUniquePrefixedId(NODE_ID_PREFIX, existing, rand);
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
 * 仅用于迁移/加载内存投影；新 create 必须用 makeUniqueRoleId。
 * 不依赖 node:crypto。
 */
export function deterministicRoleIdFromName(name: string, existing: Set<string> = new Set()): string {
  const key = name.trim();
  const digest = deterministicDigest(`tent.role.id.v1:${key}`, 32);
  for (let len = 6; len <= 16; len++) {
    const id = ROLE_ID_PREFIX + encodeAlphabetBytes(digest, len);
    if (!existing.has(id)) return id;
  }
  // 极端兜底：带已占用 id 集合再哈希，避免与已占用 id 冲突。
  const fallback = deterministicDigest(
    `tent.role.id.v1.fallback:${key}:${[...existing].sort().join(",")}`,
    32
  );
  return ROLE_ID_PREFIX + encodeAlphabetBytes(fallback, 12);
}

export function isNodeId(id: string): boolean {
  return /^cx-[a-z0-9]+$/i.test(id);
}

export function isRoleId(id: string): boolean {
  return /^rl-[a-z0-9]+$/i.test(id);
}

export function isSessionId(id: string): boolean {
  return /^ss-[a-z0-9]+$/i.test(id);
}
