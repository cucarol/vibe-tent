/**
 * Lightweight renderer UI contract — class names + small HTML helpers.
 * Not a component framework: modules still render strings / bind events.
 */

import { escapeHtml } from "../../../markdown/render.js";

/** Canonical class tokens used across workbench chrome. */
export const UI = {
  btn: "btn",
  btnPrimary: "btn btn-primary",
  btnSecondary: "btn btn-secondary",
  btnGhost: "btn btn-ghost",
  btnDanger: "btn btn-danger",
  iconBtn: "icon-btn",
  field: "field",
  fieldCompact: "field field-compact",
  tab: "tab",
  tabLabel: "tab-label",
  tabClose: "tab-close",
  treeNode: "tree-node",
  treeName: "tree-name",
  treeMeta: "tree-meta",
  inspSection: "insp-section",
  inspSummary: "insp-summary",
  inspBody: "insp-body",
  collapseEdge: "icon-btn collapse-edge",
  railToggle: "icon-btn rail-toggle",
} as const;

export type BtnVariant = "primary" | "secondary" | "ghost" | "danger";

/** Map variant → class list (always includes base `.btn`). */
export function btnClass(variant: BtnVariant = "secondary", extra?: string): string {
  const base =
    variant === "primary"
      ? UI.btnPrimary
      : variant === "ghost"
        ? UI.btnGhost
        : variant === "danger"
          ? UI.btnDanger
          : UI.btnSecondary;
  return extra ? `${base} ${extra}` : base;
}

export type BtnHtmlOpts = {
  label: string;
  variant?: BtnVariant;
  id?: string;
  title?: string;
  /** Already-escaped attribute string, e.g. `data-act="save"`. */
  attrs?: string;
  disabled?: boolean;
  extraClass?: string;
};

/** Primary / secondary / ghost / danger button markup. */
export function btnHtml(opts: BtnHtmlOpts): string {
  const cls = btnClass(opts.variant ?? "secondary", opts.extraClass);
  const id = opts.id ? ` id="${escapeHtml(opts.id)}"` : "";
  const title = opts.title ? ` title="${escapeHtml(opts.title)}"` : "";
  const disabled = opts.disabled ? " disabled" : "";
  const attrs = opts.attrs ? ` ${opts.attrs}` : "";
  return `<button type="button" class="${cls}"${id}${title}${disabled}${attrs}>${escapeHtml(opts.label)}</button>`;
}

export type IconBtnHtmlOpts = {
  /** Inner SVG (or other) markup — not escaped. */
  icon: string;
  title: string;
  ariaLabel?: string;
  id?: string;
  extraClass?: string;
  /** Already-escaped attribute string. */
  attrs?: string;
  expanded?: boolean | null;
  disabled?: boolean;
};

/** Icon-only control (`.icon-btn` + optional modifiers). */
export function iconBtnHtml(opts: IconBtnHtmlOpts): string {
  const cls = opts.extraClass ? `${UI.iconBtn} ${opts.extraClass}` : UI.iconBtn;
  const id = opts.id ? ` id="${escapeHtml(opts.id)}"` : "";
  const label = opts.ariaLabel ?? opts.title;
  const title = ` title="${escapeHtml(opts.title)}"`;
  const aria = ` aria-label="${escapeHtml(label)}"`;
  const expanded =
    opts.expanded === undefined || opts.expanded === null
      ? ""
      : ` aria-expanded="${opts.expanded ? "true" : "false"}"`;
  const disabled = opts.disabled ? " disabled" : "";
  const attrs = opts.attrs ? ` ${opts.attrs}` : "";
  return `<button type="button" class="${cls}"${id}${title}${aria}${expanded}${disabled}${attrs}>${opts.icon}</button>`;
}

export type DocumentTabHtmlOpts = {
  nodeId: string;
  name: string;
  active: boolean;
  dirty: boolean;
  /** Close icon SVG markup. */
  closeIcon: string;
};

/**
 * One document tab: label (activate) + always-visible close control.
 * Close uses `data-close-tab`; activation uses `data-tab` on the label.
 */
export function documentTabHtml(opts: DocumentTabHtmlOpts): string {
  const cx = escapeHtml(opts.nodeId);
  const name = escapeHtml(opts.name);
  const dirtyMark = opts.dirty ? " ·" : "";
  const closeLabel = `关闭 ${opts.name}`;
  const title = `${opts.name}${opts.dirty ? "（未保存）" : ""}`;
  return `<div class="${UI.tab}${opts.active ? " active" : ""}" role="presentation" data-tab-wrap="${cx}">
        <button type="button" class="${UI.tabLabel}" role="tab" data-tab="${cx}" aria-selected="${opts.active ? "true" : "false"}" title="${escapeHtml(title)}">${name}${dirtyMark}</button>
        <button type="button" class="${UI.tabClose}" data-close-tab="${cx}" title="${escapeHtml(closeLabel)}" aria-label="${escapeHtml(closeLabel)}">${opts.closeIcon}</button>
      </div>`;
}

/** Tree row class list for active / archived states. */
export function treeRowClass(opts: { active?: boolean; archived?: boolean }): string {
  let cls = UI.treeNode;
  if (opts.active) cls += " active";
  if (opts.archived) cls += " is-archived";
  return cls;
}
