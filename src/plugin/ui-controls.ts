import { setIcon } from "obsidian";
import { rwSegmentStates } from "./ui-model.js";
export { roleColorValue } from "./ui-model.js";

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
  for (const state of rwSegmentStates(declared, allowInherit)) {
    const option = segment.createDiv({
      cls: "tent-status-segment-option" + (state.active ? " is-active" : ""),
      text: state.label,
    });
    if (!readonly) option.onclick = () => onChange(state.value);
  }
}
