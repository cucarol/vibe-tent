// 认领与 owner。核心不变量:认领不重叠 —— 一框一 owner,认领父框=独占整棵子树,
// 祖先或子孙已被占用的框不能再认领。互不重叠 → 免锁。

import { Box } from "./types.js";
import { LoadedTent } from "./tree.js";

export interface ClaimCheck {
  ok: boolean;
  /** 不 ok 时,挡路的那个已认领框。 */
  blocker?: Box;
  reason?: string;
}

/** 能否把 box 认领给某角色?检查 box 自身、祖先、子孙是否已被占。 */
export function canClaim(box: Box): ClaimCheck {
  if (box.invalid) return { ok: false, blocker: box, reason: `失效子树:${box.invalidReason || "类型定义缺失"}` };
  if (box.archived) return { ok: false, blocker: box, reason: "归档子树不可认领" };
  if (box.fm.owner) {
    return { ok: false, blocker: box, reason: `已被 ${box.fm.owner} 认领` };
  }
  // 祖先被占?
  let anc = box.parent;
  while (anc) {
    if (anc.fm.owner) {
      return { ok: false, blocker: anc, reason: `祖先「${anc.name}」已被 ${anc.fm.owner} 认领` };
    }
    anc = anc.parent;
  }
  // 子孙被占?
  const occupiedChild = findOccupied(box.children);
  if (occupiedChild) {
    return {
      ok: false,
      blocker: occupiedChild,
      reason: `子孙「${occupiedChild.name}」已被 ${occupiedChild.fm.owner} 认领`,
    };
  }
  return { ok: true };
}

function findOccupied(boxes: Box[]): Box | undefined {
  for (const b of boxes) {
    if (b.fm.owner) return b;
    const deep = findOccupied(b.children);
    if (deep) return deep;
  }
  return undefined;
}

/** 收集帐内全部被占框(用于面板"N 角色在帐"与卡死检测)。 */
export function occupiedBoxes(tent: LoadedTent): Box[] {
  const out: Box[] = [];
  for (const root of tent.roots) collect(root, out);
  return out;
}

function collect(box: Box, out: Box[]): void {
  if (box.fm.owner) out.push(box);
  for (const c of box.children) collect(c, out);
}

/** 认领期间被冻结(自身或祖先被占)的框不能拖动。 */
export function isFrozen(box: Box): boolean {
  return box.invalid || box.archived || box.locked;
}
