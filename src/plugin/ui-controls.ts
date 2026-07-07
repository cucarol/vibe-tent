import { setIcon, setTooltip } from "obsidian";
import type { Box } from "../core/types.js";
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

export function hasActiveOwnerInScope(box: Box): boolean {
  let current: Box | null = box;
  while (current) {
    if (current.fm.owner) return true;
    current = current.parent;
  }
  return false;
}

export function tentTooltip(
  el: HTMLElement,
  text: string,
  placement: "top" | "right" | "bottom" | "left" = "top"
): void {
  el.removeAttribute("title");
  if (!text) return;
  setTooltip(el, text, {
    placement,
    delay: 300,
    gap: 6,
    classes: ["tent-tooltip"],
  });
}

// 自定义拖拽影像:一个干净的小标签,替掉浏览器默认的半透明整行重影。
export function makeDragLabel(parent: HTMLElement, name: string): HTMLElement {
  const el = parent.createDiv({ cls: "tent-drag-label tent-drag-label-preview", text: name });
  // 拖拽开始后浏览器已截图,下一帧即可移除
  window.setTimeout(() => el.remove(), 0);
  return el;
}
