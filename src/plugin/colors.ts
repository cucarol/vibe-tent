import { TYPE_COLOR_PALETTE } from "../core/typeRegistry.js";

// 单一色名来源 = core 的注册表色板;FALLBACK 给每个名一个 hex 兜底(Obsidian 无 --color-gray/brown)。
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
