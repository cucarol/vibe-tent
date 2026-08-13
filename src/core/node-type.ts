/**
 * Canonical Node type marker.
 *
 * Node type is one optional, direct string fact. It has no registry, tier,
 * compound/base/modifier grammar, or lifecycle authority.
 */
export function normalizeOptionalNodeType(
  value: unknown,
  label = "Node type"
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string when present.`);
  }
  const type = value.trim();
  if (!type) {
    throw new Error(`${label} must be non-empty when present.`);
  }
  return type;
}
