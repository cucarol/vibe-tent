/**
 * Plugin-local type color palette (legacy Obsidian chrome only).
 * Not part of Core TypeDefinition / type registry product contract.
 */
export const TYPE_COLOR_PALETTE = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
  "brown",
] as const;

export const TYPE_COLORS = TYPE_COLOR_PALETTE;

const FALLBACK_COLORS: Record<string, string> = {
  gray: "#8a8678",
  red: "#c14f3c",
  orange: "#d17f2e",
  yellow: "#cba61a",
  green: "#5a9e4f",
  cyan: "#2f9e93",
  blue: "#4f74c4",
  purple: "#8a6bc0",
  pink: "#c8589a",
  brown: "#8a5a34",
};

export function typeColorValue(color?: string): string {
  const value = color?.trim();
  if (!value) return FALLBACK_COLORS.gray;
  if (value in FALLBACK_COLORS) return `var(--color-${value}, ${FALLBACK_COLORS[value]})`;
  return value;
}
