import { setIcon } from "obsidian";
import type { RoleDefinition } from "../core/skillRoleRegistry.js";
import { TYPE_COLORS, typeColorValue } from "./colors.js";

export interface SelectOption {
  value: string;
  label?: string;
  selected?: boolean;
}

export function createChevronSelect(
  parent: HTMLElement,
  options: { cls?: string; options: SelectOption[] }
): HTMLSelectElement {
  const wrap = parent.createDiv({ cls: "tent-select-wrap" });
  const select = wrap.createEl("select", { cls: options.cls ?? "" });
  for (const item of options.options) {
    const opt = select.createEl("option", { text: item.label ?? item.value, value: item.value });
    if (item.selected) opt.selected = true;
  }
  const icon = wrap.createSpan({ cls: "tent-select-chevron" });
  setIcon(icon, "chevron-down");
  return select;
}

export function drawRwSegment(
  parent: HTMLElement,
  key: "readable" | "writable",
  declared: boolean | undefined,
  onChange: (value: boolean | undefined) => void,
  allowInherit = true,
  readonly = false
): void {
  const segment = parent.createDiv({
    cls: "tent-status-segment tent-rw-seg" + (readonly ? " is-readonly" : ""),
  });
  segment.createSpan({ cls: "tent-seg-key", text: key === "readable" ? "R" : "W" });
  const states: Array<{ label: string; value: boolean | undefined }> = allowInherit
    ? [
        { label: "继承", value: undefined },
        { label: "开", value: true },
        { label: "关", value: false },
      ]
    : [
        { label: "开", value: true },
        { label: "关", value: false },
      ];
  for (const state of states) {
    const option = segment.createDiv({
      cls: "tent-status-segment-option" + (declared === state.value ? " is-active" : ""),
      text: state.label,
    });
    if (!readonly) option.onclick = () => onChange(state.value);
  }
}

export function roleColorValue(role: RoleDefinition): string {
  if (role.color) return typeColorValue(role.color);
  const normalized = role.name.toLowerCase();
  if (normalized.includes("planner")) return typeColorValue("purple");
  if (normalized.includes("executor")) return typeColorValue("cyan");
  if (normalized.includes("ui")) return typeColorValue("orange");
  const hash = [...role.name].reduce((total, character) => total + character.charCodeAt(0), 0);
  return typeColorValue(TYPE_COLORS[hash % TYPE_COLORS.length]);
}
