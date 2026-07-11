import { Notice, setIcon, setTooltip } from "obsidian";
import type { FsAdapter } from "../core/adapter.js";
import {
  createRole,
  deleteRole,
  updateRole,
  type RoleDefinition,
} from "../core/skillRoleRegistry.js";
import {
  createPrimaryType,
  deleteCustomType,
  inspectTypeDeletion,
  updateTypeMetadata,
} from "../core/typeManagement.js";
import {
  baseDefinitionWorkspacePointer,
  type TypeDefinition,
  type TypeRegistry,
  type TypeTier,
} from "../core/typeRegistry.js";
import { TYPE_COLORS, typeColorValue } from "./colors.js";
import { drawRwSegment, roleColorValue } from "./ui-controls.js";
import type { RegistryPaneState, RegistrySection } from "./ui-model.js";
export { createRegistryPaneState } from "./ui-model.js";

export interface RegistryPaneContext {
  fs: FsAdapter;
  registry: TypeRegistry;
  roles: RoleDefinition[];
  redraw(): void;
  refresh(): Promise<void>;
  getPendingDelete(): string | null;
  setPendingDelete(value: string | null): void;
}

export function drawRegistryPane(
  host: HTMLElement,
  context: RegistryPaneContext,
  state: RegistryPaneState
): void {
  host.createDiv({ cls: "registry-title", text: "类型 / 角色 注册表" });
  const list = host.createDiv({ cls: "registry-list" });
  const entries = Object.entries(context.registry);
  const primary = entries.filter(([, definition]) => definition.tier !== "modifier");
  const secondary = entries.filter(([, definition]) => definition.tier === "modifier");

  drawVisibilityPanel(list, context, state, primary, secondary);

  const typeBlock = list.createDiv({ cls: "reg-block" });
  drawBlockHead(typeBlock, context, "类型", state.typeCollapsed, () => {
    state.typeCollapsed = !state.typeCollapsed;
  });
  if (!state.typeCollapsed) {
    drawTypeSection(typeBlock, context, state, "type", "base", "一级", primary);
    drawTypeSection(typeBlock, context, state, "modifier", "modifier", "二级", secondary);
  }

  const roleBlock = list.createDiv({ cls: "reg-block" });
  drawBlockHead(
    roleBlock,
    context,
    "角色",
    state.collapsed.roles,
    () => {
      state.collapsed.roles = !state.collapsed.roles;
    },
    state,
    "roles"
  );
  if (state.collapsed.roles) return;

  const roleContent = roleBlock.createDiv({ cls: "group-content roles-list" });
  if (state.newFormOpen === "roles") drawNewRoleForm(roleContent, context, state);
  if (context.roles.length === 0) {
    roleContent.createDiv({ cls: "registry-empty", text: "暂无 roles" });
    return;
  }
  for (const role of context.roles) drawRoleRow(roleContent, context, state, role);
}

function drawVisibilityPanel(
  host: HTMLElement,
  context: RegistryPaneContext,
  state: RegistryPaneState,
  primary: Array<[string, TypeDefinition]>,
  secondary: Array<[string, TypeDefinition]>
): void {
  const panel = host.createDiv({ cls: "reg-visibility" });
  panel.createDiv({ cls: "reg-vis-title", text: "树内显隐" });
  const drawChip = (
    parent: HTMLElement,
    label: string,
    enabled: boolean,
    color: string,
    toggle: () => void
  ) => {
    const chip = parent.createSpan({
      cls: "tent-mark-chip" + (enabled ? " is-on" : ""),
      text: label,
    });
    chip.style.setProperty("--mark-color", color);
    chip.onclick = () => {
      toggle();
      context.redraw();
    };
  };
  const drawRow = (label: string, build: (chips: HTMLElement) => void) => {
    const row = panel.createDiv({ cls: "reg-vis-row" });
    row.createSpan({ cls: "reg-vis-label", text: label });
    build(row.createDiv({ cls: "reg-vis-chips" }));
  };
  const drawTypeChips = (
    chips: HTMLElement,
    definitions: Array<[string, TypeDefinition]>
  ) => {
    if (definitions.length === 0) {
      chips.createSpan({ cls: "reg-vis-empty", text: "—" });
      return;
    }
    for (const [name, definition] of definitions) {
      drawChip(
        chips,
        name,
        state.markedTypes.has(name),
        typeColorValue(definition.color),
        () => toggleSetValue(state.markedTypes, name)
      );
    }
  };

  drawRow("一级", (chips) => drawTypeChips(chips, primary));
  drawRow("二级", (chips) => drawTypeChips(chips, secondary));
  drawRow("角色", (chips) => {
    if (context.roles.length === 0) {
      chips.createSpan({ cls: "reg-vis-empty", text: "—" });
      return;
    }
    for (const role of context.roles) {
      drawChip(
        chips,
        role.name,
        state.markedRoles.has(role.name),
        roleColorValue(role),
        () => toggleSetValue(state.markedRoles, role.name)
      );
    }
  });
}

function drawBlockHead(
  block: HTMLElement,
  context: RegistryPaneContext,
  title: string,
  collapsed: boolean,
  toggle: () => void,
  state?: RegistryPaneState,
  addKey?: "roles"
): void {
  const head = block.createDiv({ cls: "reg-block-head" });
  const chevron = head.createSpan({ cls: "reg-chev" });
  setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
  head.createSpan({ cls: "reg-block-title", text: title });
  head.createSpan({ cls: "reg-head-rule" });
  if (state && addKey) drawAddButton(head, context, state, addKey);
  head.onclick = () => {
    toggle();
    context.redraw();
  };
}

function drawTypeSection(
  block: HTMLElement,
  context: RegistryPaneContext,
  state: RegistryPaneState,
  key: "type" | "modifier",
  tier: TypeTier,
  label: string,
  entries: Array<[string, TypeDefinition]>
): void {
  const section = block.createDiv({ cls: "reg-sub" });
  const collapsed = state.collapsed[key];
  const head = section.createDiv({ cls: "reg-sub-head" });
  const chevron = head.createSpan({ cls: "reg-chev reg-chev-sm" });
  setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
  head.createSpan({ cls: "reg-sub-label", text: label });
  drawAddButton(head, context, state, key);
  head.onclick = () => {
    state.collapsed[key] = !state.collapsed[key];
    context.redraw();
  };
  if (collapsed) return;

  const content = section.createDiv({ cls: "group-content" });
  if (state.newFormOpen === key) drawNewTypeForm(content, context, state, tier);
  if (entries.length === 0) {
    content.createDiv({
      cls: "registry-empty",
      text: tier === "modifier" ? "暂无二级" : "暂无一级",
    });
    return;
  }
  for (const [name, definition] of entries) {
    drawTypeRow(content, context, state, key, name, definition);
  }
}

function drawAddButton(
  head: HTMLElement,
  context: RegistryPaneContext,
  state: RegistryPaneState,
  key: RegistrySection
): void {
  const add = head.createEl("button", {
    cls: "registry-add-btn" + (state.newFormOpen === key ? " is-open" : ""),
  });
  add.setAttr("type", "button");
  setIcon(add.createSpan({ cls: "rab-ico" }), "plus");
  add.setAttr("aria-label", "新建");
  addTooltip(add, "新建");
  add.onclick = (event) => {
    event.stopPropagation();
    state.newFormOpen = state.newFormOpen === key ? null : key;
    if (state.newFormOpen === key) {
      state.collapsed[key] = false;
      if (key === "type" || key === "modifier") state.typeCollapsed = false;
    }
    context.redraw();
  };
}

function drawTypeRow(
  content: HTMLElement,
  context: RegistryPaneContext,
  state: RegistryPaneState,
  section: "type" | "modifier",
  name: string,
  definition: TypeDefinition
): void {
  const editKey = `${section}:${name}`;
  const open = state.openEditor === editKey;
  const wrapper = content.createDiv({
    cls: "registry-item-wrapper" + (open ? " drawer-open" : ""),
  });
  const row = wrapper.createDiv({ cls: "reg-card" });
  row.style.setProperty("--accent-color", typeColorValue(definition.color));
  row.createSpan({ cls: "item-name", text: name });
  row.createSpan({ cls: "reg-desc", text: definition.description || "" });

  const rightArea = row.createDiv({ cls: "row-right-area" });
  drawRwCapsule(
    rightArea.createDiv({ cls: "item-indicators" }),
    definition.readable,
    definition.writable,
    baseDefinitionWorkspacePointer(definition) === true ? true : definition.tier === "modifier" ? undefined : false
  );
  const actions = rightArea.createDiv({ cls: "row-actions" });
  const edit = actions.createEl("button", {
    cls: "registry-edit-btn" + (open ? " active" : ""),
  });
  edit.setAttr("type", "button");
  setIcon(edit, "settings");
  addTooltip(edit, "编辑颜色 / 读写");
  edit.onclick = (event) => {
    event.stopPropagation();
    state.openEditor = open ? null : editKey;
    context.redraw();
  };

  const deleteKey = `type:${section}:${name}`;
  const deletePending = context.getPendingDelete() === deleteKey;
  const remove = actions.createEl("button", {
    cls: "registry-del-btn" + (deletePending ? " is-confirm" : ""),
  });
  remove.setAttr("type", "button");
  if (deletePending) remove.setText("确认删除");
  else setIcon(remove, "trash-2");
  addTooltip(remove, deletePending ? "再次点击确认删除" : "删除");
  remove.onclick = async (event) => {
    event.stopPropagation();
    const inspection = await inspectTypeDeletion(context.fs, "type", name);
    if (inspection.builtIn) {
      new Notice(`内置类型「${name}」不可删除`);
      return;
    }
    if (inspection.activeOwners.length > 0) {
      new Notice(
        `关联范围仍有 owner,先盖章或强清:${inspection.activeOwners.map((item) => item.path).join(", ")}`
      );
      return;
    }
    if (context.getPendingDelete() === deleteKey) {
      await deleteCustomType(context.fs, "type", name, name);
      await context.refresh();
      return;
    }
    context.setPendingDelete(deleteKey);
    context.redraw();
  };

  if (open) drawTypeEditDrawer(wrapper, context, name, definition);
}

function drawRwCapsule(
  host: HTMLElement,
  readable: boolean | undefined,
  writable: boolean | undefined,
  workspacePointer?: boolean
): void {
  const capsule = host.createSpan({ cls: "rw-cap" });
  const label = (state: boolean | undefined) => (
    state === undefined ? "继承" : state ? "开" : "关"
  );
  const pointerTip =
    workspacePointer === undefined
      ? ""
      : ` · workspace 指针:${label(workspacePointer)}`;
  addTooltip(capsule, `readable:${label(readable)} · writable:${label(writable)}${pointerTip}`);
  const drawPart = (key: string, value: boolean | undefined) => {
    const className = value === undefined ? "is-inherit" : value ? "is-on" : "is-off";
    const symbol = value === undefined ? "—" : value ? "√" : "✕";
    const part = capsule.createSpan({ cls: `rw-part ${className}` });
    part.createSpan({ cls: "rw-k", text: key });
    part.createSpan({ cls: "rw-s", text: symbol });
  };
  drawPart("R", readable);
  capsule.createSpan({ cls: "rw-dot", text: "·" });
  drawPart("W", writable);
  if (workspacePointer !== undefined) {
    capsule.createSpan({ cls: "rw-dot", text: "·" });
    drawPart("针", workspacePointer);
  }
}

function drawPalette(
  host: HTMLElement,
  selected: string,
  onSelect: (color: string) => void | Promise<void>
): HTMLElement {
  const palette = host.createDiv({ cls: "tent-color-palette" });
  for (const color of TYPE_COLORS) {
    const swatch = palette.createEl("button", {
      cls: "tent-color-swatch" + (color === selected ? " is-selected" : ""),
    });
    swatch.setAttr("type", "button");
    addTooltip(swatch, color);
    swatch.style.setProperty("--tent-swatch-color", typeColorValue(color));
    swatch.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      palette.findAll(".tent-color-swatch").forEach((element) => {
        element.removeClass("is-selected");
      });
      swatch.addClass("is-selected");
      void onSelect(color);
    };
  }
  return palette;
}

function drawLabelRow(host: HTMLElement, label: string, extraClass = ""): HTMLElement {
  const normalized =
    label === "名字" ? "name" :
    label === "颜色" ? "color" :
    label === "描述" ? "description" :
    label === "R/W" ? "r-w" :
    label === "指针" ? "workspace-pointer" :
    label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const row = host.createDiv({
    cls: `tent-newform-row tent-newform-row-${normalized}${extraClass ? ` ${extraClass}` : ""}`,
  });
  row.createSpan({ cls: "tent-newform-label", text: label });
  return row;
}

function autoGrowTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function drawTypeEditDrawer(
  wrapper: HTMLElement,
  context: RegistryPaneContext,
  name: string,
  definition: TypeDefinition
): void {
  const drawer = wrapper.createDiv({
    cls: "registry-item-edit-drawer type-drawer",
  });
  const isModifier = definition.tier === "modifier";

  drawPalette(drawLabelRow(drawer, "颜色"), definition.color || "", async (color) => {
    await updateTypeMetadata(context.fs, "type", name, { color });
    await context.refresh();
  });

  const rw = drawLabelRow(drawer, "R/W").createDiv({ cls: "tent-drawer-rw" });
  drawRwSegment(rw, "readable", definition.readable, async (value) => {
    await updateTypeMetadata(context.fs, "type", name, {
      readable: isModifier ? value ?? "inherit" : value ?? false,
    });
    await context.refresh();
  }, isModifier);
  drawRwSegment(rw, "writable", definition.writable, async (value) => {
    await updateTypeMetadata(context.fs, "type", name, {
      writable: isModifier ? value ?? "inherit" : value ?? false,
    });
    await context.refresh();
  }, isModifier);

  if (!isModifier) {
    const pointer = drawLabelRow(drawer, "指针").createDiv({ cls: "tent-drawer-rw" });
    drawRwSegment(
      pointer,
      "workspacePointer",
      baseDefinitionWorkspacePointer(definition) === true,
      async (value) => {
        await updateTypeMetadata(context.fs, "type", name, {
          workspacePointer: value === true,
        });
        await context.refresh();
      },
      false
    );
  }

  const description = drawLabelRow(drawer, "描述").createEl("textarea", {
    cls: "tent-newform-input tent-newform-textarea tent-newform-desc-textarea",
    attr: { rows: "1" },
  });
  description.value = definition.description || "";
  description.oninput = () => autoGrowTextarea(description);
  description.onblur = async () => {
    const value = description.value.trim();
    if (value === (definition.description || "")) return;
    await updateTypeMetadata(context.fs, "type", name, { description: value });
    await context.refresh();
  };
  window.setTimeout(() => autoGrowTextarea(description), 0);
}

function drawNewTypeForm(
  section: HTMLElement,
  context: RegistryPaneContext,
  state: RegistryPaneState,
  tier: TypeTier
): void {
  const card = section.createDiv({ cls: "tent-newform" });
  const form: {
    name: string;
    description: string;
    readable: boolean | undefined;
    writable: boolean | undefined;
    workspacePointer: boolean;
    color: string;
  } = {
    name: "",
    description: "",
    readable: tier === "modifier" ? undefined : true,
    writable: tier === "modifier" ? undefined : false,
    workspacePointer: false,
    color: "gray",
  };
  const isModifier = tier === "modifier";

  const name = drawLabelRow(card, "名字").createEl("input", {
    cls: "tent-newform-input",
    attr: { type: "text" },
  });
  name.oninput = () => {
    form.name = name.value.trim();
  };
  window.setTimeout(() => name.focus(), 0);

  drawPalette(drawLabelRow(card, "颜色"), form.color, (color) => {
    form.color = color;
  });

  const rw = drawLabelRow(card, "R/W").createDiv({ cls: "tent-drawer-rw" });
  drawRwSegment(rw, "readable", form.readable, (value) => {
    form.readable = value;
  }, isModifier);
  drawRwSegment(rw, "writable", form.writable, (value) => {
    form.writable = value;
  }, isModifier);

  if (!isModifier) {
    const pointer = drawLabelRow(card, "指针").createDiv({ cls: "tent-drawer-rw" });
    drawRwSegment(pointer, "workspacePointer", form.workspacePointer, (value) => {
      form.workspacePointer = value === true;
    }, false);
  }

  const description = drawLabelRow(card, "描述").createEl("textarea", {
    cls: "tent-newform-input tent-newform-textarea tent-newform-desc-textarea",
    attr: { rows: "1" },
  });
  description.oninput = () => {
    form.description = description.value.trim();
    autoGrowTextarea(description);
  };

  drawFormActions(card, context, state, async () => {
    if (!form.name || form.name === "temp") {
      new Notice("请填写有效的 type 名");
      return;
    }
    if (context.registry[form.name]) {
      new Notice(`类型「${form.name}」已存在`);
      return;
    }
    const definition: TypeDefinition = isModifier
      ? {
          tier: "modifier",
          ...(form.readable !== undefined ? { readable: form.readable } : {}),
          ...(form.writable !== undefined ? { writable: form.writable } : {}),
        }
      : {
          tier: "base",
          readable: form.readable!,
          writable: form.writable!,
          ...(form.workspacePointer ? { workspacePointer: true } : {}),
        };
    if (form.color) definition.color = form.color;
    if (form.description) definition.description = form.description;
    await createPrimaryType(context.fs, form.name, definition);
    state.newFormOpen = null;
    await context.refresh();
  });
}

function drawNewRoleForm(
  section: HTMLElement,
  context: RegistryPaneContext,
  state: RegistryPaneState
): void {
  const card = section.createDiv({ cls: "tent-newform" });
  const form = { name: "", description: "", prompt: "", color: "purple" };

  const name = drawLabelRow(card, "名字").createEl("input", {
    cls: "tent-newform-input",
    attr: { type: "text" },
  });
  name.oninput = () => {
    form.name = name.value.trim();
  };
  window.setTimeout(() => name.focus(), 0);

  drawPalette(drawLabelRow(card, "颜色"), form.color, (color) => {
    form.color = color;
  });

  const description = drawLabelRow(card, "描述").createEl("textarea", {
    cls: "tent-newform-input tent-newform-textarea tent-newform-desc-textarea",
    attr: { rows: "1" },
  });
  description.oninput = () => {
    form.description = description.value.trim();
    autoGrowTextarea(description);
  };

  const prompt = drawLabelRow(card, "prompt", "tent-newform-textarea-row").createEl("textarea", {
    cls: "tent-newform-input tent-newform-textarea tent-newform-prompt-textarea",
    attr: { rows: "2" },
  });
  prompt.oninput = () => {
    form.prompt = prompt.value.trim();
    autoGrowTextarea(prompt);
  };

  drawFormActions(card, context, state, async () => {
    if (!form.name) {
      new Notice("请填写 role 名");
      return;
    }
    const definition: RoleDefinition = { name: form.name };
    if (form.description) definition.description = form.description;
    if (form.prompt) definition.prompt = form.prompt;
    if (form.color) definition.color = form.color;
    await createRole(context.fs, definition);
    state.newFormOpen = null;
    await context.refresh();
  });
}

function drawFormActions(
  card: HTMLElement,
  context: RegistryPaneContext,
  state: RegistryPaneState,
  submit: () => Promise<void>
): void {
  const actions = card.createDiv({ cls: "tent-newform-acts" });
  const create = actions.createEl("button", { cls: "mod-cta", text: "新建" });
  create.setAttr("type", "button");
  create.onclick = async (event) => {
    event.preventDefault();
    try {
      await submit();
    } catch (error) {
      new Notice("新建失败:" + (error instanceof Error ? error.message : error));
    }
  };
  const cancel = actions.createEl("button", { text: "取消" });
  cancel.setAttr("type", "button");
  cancel.onclick = (event) => {
    event.preventDefault();
    state.newFormOpen = null;
    context.redraw();
  };
}

function drawRoleRow(
  content: HTMLElement,
  context: RegistryPaneContext,
  state: RegistryPaneState,
  role: RoleDefinition
): void {
  const editKey = `role:${role.name}`;
  const open = state.openEditor === editKey;
  const wrapper = content.createDiv({
    cls: "registry-item-wrapper" + (open ? " drawer-open" : ""),
  });
  const row = wrapper.createDiv({ cls: "reg-card role-row" });
  row.style.setProperty("--accent-color", roleColorValue(role));
  row.createSpan({ cls: "item-name", text: role.name });
  row.createSpan({ cls: "reg-desc", text: role.description || "" });

  const actions = row
    .createDiv({ cls: "row-right-area role-right" })
    .createDiv({ cls: "row-actions" });
  const edit = actions.createEl("button", {
    cls: "registry-edit-btn" + (open ? " active" : ""),
  });
  edit.setAttr("type", "button");
  setIcon(edit, "settings");
  addTooltip(edit, "编辑描述 / prompt / 颜色");
  edit.onclick = (event) => {
    event.stopPropagation();
    state.openEditor = open ? null : editKey;
    context.redraw();
  };

  const deleteKey = `role:${role.name}`;
  const deletePending = context.getPendingDelete() === deleteKey;
  const remove = actions.createEl("button", {
    cls: "registry-del-btn" + (deletePending ? " is-confirm" : ""),
  });
  remove.setAttr("type", "button");
  if (deletePending) remove.setText("确认删除");
  else setIcon(remove, "trash-2");
  addTooltip(remove, deletePending ? "再次点击确认删除" : "删除");
  remove.onclick = async (event) => {
    event.stopPropagation();
    if (context.getPendingDelete() === deleteKey) {
      await deleteRole(context.fs, role.name, role.name);
      await context.refresh();
      return;
    }
    context.setPendingDelete(deleteKey);
    context.redraw();
  };

  if (open) drawRoleEditDrawer(wrapper, context, role);
}

function drawRoleEditDrawer(
  wrapper: HTMLElement,
  context: RegistryPaneContext,
  role: RoleDefinition
): void {
  const drawer = wrapper.createDiv({
    cls: "registry-item-edit-drawer role-drawer",
  });

  drawPalette(drawLabelRow(drawer, "颜色"), role.color || "", async (color) => {
    await updateRole(context.fs, role.name, { color });
    await context.refresh();
  });

  const description = drawLabelRow(drawer, "描述").createEl("textarea", {
    cls: "tent-newform-input tent-newform-textarea tent-newform-desc-textarea",
    attr: { rows: "1" },
  });
  description.value = role.description || "";
  description.oninput = () => autoGrowTextarea(description);
  description.onblur = async () => {
    const value = description.value.trim();
    if (value === (role.description || "")) return;
    await updateRole(context.fs, role.name, { description: value });
    await context.refresh();
  };
  window.setTimeout(() => autoGrowTextarea(description), 0);

  const prompt = drawLabelRow(drawer, "prompt", "tent-newform-textarea-row").createEl("textarea", {
    cls: "tent-newform-input tent-newform-textarea tent-newform-prompt-textarea",
    attr: { rows: "2" },
  });
  prompt.value = role.prompt || "";
  prompt.oninput = () => autoGrowTextarea(prompt);
  prompt.onblur = async () => {
    const value = prompt.value.trim();
    if (value === (role.prompt || "")) return;
    await updateRole(context.fs, role.name, { prompt: value });
    await context.refresh();
  };
  window.setTimeout(() => autoGrowTextarea(prompt), 0);
}

function toggleSetValue(values: Set<string>, value: string): void {
  if (values.has(value)) values.delete(value);
  else values.add(value);
}

function addTooltip(element: HTMLElement, text: string): void {
  element.removeAttribute("title");
  if (!text) return;
  setTooltip(element, text, {
    placement: "top",
    delay: 150,
  });
}
