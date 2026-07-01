// 框 id 生成:bx- + 短随机串。建框时一次性生成,永不变。
// 注意:核心层不能用 Math.random 直接埋进确定性逻辑,但建框是真实副作用动作,
// 这里接受一个随机源参数,默认用平台随机。插件/CLI 传入各自的实现。

export type RandomSource = () => number;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // 去掉易混字符 i l o u

export function makeBoxId(rand: RandomSource = Math.random, len = 6): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return "bx-" + s;
}

/** 确保不撞已有 id。 */
export function makeUniqueBoxId(existing: Set<string>, rand: RandomSource = Math.random): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = makeBoxId(rand);
    if (!existing.has(id)) return id;
  }
  // 极端兜底:加长
  return makeBoxId(rand, 10);
}
