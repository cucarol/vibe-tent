/**
 * Legacy UI-only compatibility shapes.
 *
 * NOT Core/Service public contract. Old renderer/plugin code may use these
 * local helpers while formal Desktop UI is rewritten. Do not re-export from
 * tent-core or Service wire types.
 */

/** Usable for collaboration: not invalid and not archived. */
export function isUsableNode(node: {
  invalid?: boolean;
  archived?: boolean;
  mode?: string;
}): boolean {
  if (node.invalid) return false;
  if (node.archived) return false;
  if (node.mode === "archived") return false;
  return true;
}

/**
 * @deprecated Local UI alias only. Prefer isUsableNode; coordination is not a Core field.
 */
export function nodeLooksCoordinatable(node: {
  invalid?: boolean;
  archived?: boolean;
  mode?: string;
  coordination?: boolean;
}): boolean {
  if (typeof node.coordination === "boolean") return node.coordination && isUsableNode(node);
  return isUsableNode(node);
}

/** Base-tier type names for create/dispatch pickers (registry.types name+tier). */
export function listBaseTypeNames(
  types: Array<{ name: string; tier?: string }>
): string[] {
  return types
    .filter((t) => t.tier === undefined || t.tier === "base")
    .map((t) => t.name)
    .sort((a, b) => a.localeCompare(b));
}

export function pickDefaultBaseType(
  types: Array<{ name: string; tier?: string }>
): string | null {
  const names = listBaseTypeNames(types);
  if (names.includes("goal")) return "goal";
  return names[0] ?? null;
}
