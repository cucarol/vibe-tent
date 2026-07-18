import type { LoadedTent } from "./tree.js";

/** 收件箱条目:当前认领。Delivery 由 temp/<role>/deliveries 独立聚合。 */
export type InboxItem =
  | { state: "stale"; role: string; boxPath: string; boxId: string };

/** 聚合收件箱:当前认领中的框。 */
export async function buildInbox(tent: LoadedTentLike): Promise<InboxItem[]> {
  const items: InboxItem[] = [];
  for (const box of tent.byId.values()) {
    if (box.invalid || box.archived) continue;
    const role = box.fm.owner;
    if (!role) continue;
    items.push({ state: "stale", role, boxPath: box.path, boxId: box.id });
  }
  return items;
}

/** 需要 user 裁定的条目数。认领中不计。 */
export function pendingCount(_items: InboxItem[]): number {
  return 0;
}

// 避免循环依赖:只需要 byId 这一面。
interface LoadedTentLike {
  byId: LoadedTent["byId"];
}
