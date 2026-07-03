import { setIcon } from "obsidian";

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
