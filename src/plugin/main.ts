// Tent 插件入口。注册结构编辑器视图、ribbon、命令、状态条。

import { Plugin, WorkspaceLeaf, addIcon, PluginSettingTab, App, Notice, Setting } from "obsidian";
import { TentView, TENT_VIEW_TYPE } from "./view.js";
import {
  DEFAULT_TYPE_REGISTRY,
  TYPE_COLOR_PALETTE,
  normalizeRegistry,
  type TypeDefinition,
  type TypeRegistry,
  type TypeTier,
} from "../core/typeRegistry.js";
import type { RoleDefinition, RolesRegistry } from "../core/skillRoleRegistry.js";
import { typeColorValue } from "./colors.js";
import { dispatchAckKey, rememberDispatchAck } from "./pending-dispatch.js";

export type Appearance = "follow" | "light" | "dark";
export type TriageReminder = "off" | "status" | "notice";

interface NewTentDefaults {
  typeRegistry: TypeRegistry;
  rolesRegistry: RolesRegistry;
  rulesTemplate: string;
}

interface TentSettings {
  /** vault 内存放各帐的根目录。每个子文件夹 = 一个帐。 */
  tentsRoot: string;
  /** 上次打开的帐(tentsRoot 下的子文件夹名)。 */
  activeTent: string;
  /** 面板外观:跟随 Obsidian 主题 / 强制浅 / 强制深。 */
  appearance: Appearance;
  dispatchPrefs: {
    copyPromptToClipboard: boolean;
    acknowledgedTasks: string[];
  };
  triageReminder: TriageReminder;
  newTentDefaults: NewTentDefaults;
}

const DEFAULT_RULES_TEMPLATE =
  "# {tent} · 项目约定\n\n" +
  "> 这顶帐的本地规矩；机制规范由 Tent 与 tent-role skill 提供。\n\n" +
  "- 产出 workspace：<填真实代码仓路径>\n" +
  "- 提交 / 命名约定：<填>\n" +
  "- 其他项目约定：<填>\n";

const DEFAULT_ROLES_REGISTRY: RolesRegistry = { roles: [] };

const DEFAULT_SETTINGS: TentSettings = {
  tentsRoot: "tents",
  activeTent: "",
  appearance: "follow",
  dispatchPrefs: {
    copyPromptToClipboard: true,
    acknowledgedTasks: [],
  },
  triageReminder: "status",
  newTentDefaults: {
    typeRegistry: cloneTypeRegistry(DEFAULT_TYPE_REGISTRY),
    rolesRegistry: { roles: [] },
    rulesTemplate: DEFAULT_RULES_TEMPLATE,
  },
};

const TENT_ICON = `<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M50 14 88 82H12L50 14Z"/><path d="M50 14v68"/><path d="M50 82 35 56"/><path d="M50 82l15-26"/><path d="M22 82h56"/><circle cx="50" cy="14" r="4" fill="currentColor" stroke="none"/><circle cx="22" cy="82" r="4" fill="currentColor" stroke="none"/><circle cx="78" cy="82" r="4" fill="currentColor" stroke="none"/></svg>`;

export default class TentPlugin extends Plugin {
  settings: TentSettings = DEFAULT_SETTINGS;
  statusEl?: HTMLElement;
  private lastPending: number | null = null;

  async onload() {
    await this.loadSettings();
    addIcon("tent", TENT_ICON);

    this.registerView(TENT_VIEW_TYPE, (leaf) => new TentView(leaf, this));

    this.addRibbonIcon("tent", "Open Tent panel", () => this.activateView());
    this.addCommand({
      id: "open-tent-panel",
      name: "Open Tent panel",
      callback: () => this.activateView(),
    });
    // 白板搁置,仅留实验命令;以后再正式做(嵌套 B/C 取舍未定)。
    this.addCommand({
      id: "open-tent-board-experimental",
      name: "Open or refresh experimental board",
      callback: async () => {
        await this.activateView();
        const leaf = this.app.workspace.getLeavesOfType(TENT_VIEW_TYPE)[0];
        const view = leaf?.view as TentView | undefined;
        if (view) await view.openBoard();
      },
    });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("tent-status");
    this.statusEl.onClickEvent(() => this.activateView());
    this.updateStatus(0);

    this.addSettingTab(new TentSettingTab(this.app, this));
  }

  onunload() {
    // Obsidian 自动 detach view
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(TENT_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: TENT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  updateStatus(pending: number) {
    if (!this.statusEl) return;
    const previous = this.lastPending;
    this.lastPending = pending;
    if (this.settings.triageReminder === "off") {
      this.statusEl.hide();
      return;
    }
    this.statusEl.show();
    this.statusEl.empty();
    this.statusEl.createSpan({ text: "⛺ " });
    this.statusEl.createSpan({
      text: pending > 0 ? `${pending} 待裁` : "帐内无事",
      cls: pending > 0 ? "tent-status-hot" : "tent-status-calm",
    });
    if (this.settings.triageReminder === "notice" && previous !== null && pending > previous) {
      new Notice(`Tent 新增 ${pending - previous} 项待裁`);
    }
  }

  refreshStatusPreference() {
    this.updateStatus(this.lastPending ?? 0);
  }

  async loadSettings() {
    this.settings = mergeSettings(await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async acknowledgeDispatchTask(tentName: string, taskPath: string): Promise<void> {
    const key = dispatchAckKey(tentName, taskPath);
    this.settings.dispatchPrefs.acknowledgedTasks = rememberDispatchAck(
      this.settings.dispatchPrefs.acknowledgedTasks,
      key
    );
    await this.saveSettings();
  }
  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(TENT_VIEW_TYPE)) {
      (leaf.view as TentView).refreshAppearance();
    }
  }
}

class TentSettingTab extends PluginSettingTab {
  private openType: string | null = null;
  private openRole: string | null = null;
  private pendingReset: "types" | "roles" | null = null;

  constructor(app: App, private plugin: TentPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("tent-settings");
    containerEl.createEl("h2", { text: "帷幄 / Tent" });

    containerEl.createEl("h3", { text: "帐" });
    new Setting(containerEl)
      .setName("帐根目录")
      .setDesc("vault 内存放各帐的文件夹。Tent 保存上下文与状态，本身不使用 Git。")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.tentsRoot)
          .onChange(async (v) => {
            this.plugin.settings.tentsRoot = v.trim() || "tents";
            await this.plugin.saveSettings();
          })
      );

    this.drawNewTentDefaults(containerEl);

    containerEl.createEl("h3", { text: "外观" });
    new Setting(containerEl)
      .setName("配色模式")
      .setDesc("跟随 Obsidian，或固定使用 Tent 的浅色 / 深色配色。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("follow", "跟随 Obsidian")
          .addOption("light", "浅色")
          .addOption("dark", "深色")
          .setValue(this.plugin.settings.appearance)
          .onChange(async (value) => {
            this.plugin.settings.appearance = value as Appearance;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    containerEl.createEl("h3", { text: "交互" });
    new Setting(containerEl)
      .setName("派活自动复制 prompt")
      .setDesc("dispatch 成功后把接力 prompt 复制到剪贴板。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.dispatchPrefs.copyPromptToClipboard).onChange(async (v) => {
          this.plugin.settings.dispatchPrefs.copyPromptToClipboard = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("待裁提醒")
      .setDesc("控制是否在 Obsidian 状态栏显示待裁数，以及新增待裁时是否通知。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("off", "关闭")
          .addOption("status", "仅状态栏")
          .addOption("notice", "状态栏与通知")
          .setValue(this.plugin.settings.triageReminder)
          .onChange(async (value) => {
            this.plugin.settings.triageReminder = value as TriageReminder;
            await this.plugin.saveSettings();
            this.plugin.refreshStatusPreference();
          })
      );
  }

  private drawNewTentDefaults(parent: HTMLElement) {
    parent.createEl("h3", { text: "新建 Tent 默认值" });
    parent.createEl("p", {
      cls: "setting-item-description tent-settings-intro",
      text: "用于之后新建的 Tent，不覆盖已有 Tent。",
    });
    this.drawDefaultTypes(parent);
    this.drawDefaultRoles(parent);

    parent.createEl("h4", { text: "默认 RULES.md" });
    new Setting(parent)
      .setName("规则模板")
      .setDesc("新建 Tent 时写入 RULES.md；{tent} 会替换为帐名。")
      .addTextArea((textarea) => {
        textarea
          .setValue(this.plugin.settings.newTentDefaults.rulesTemplate)
          .onChange(async (value) => {
            this.plugin.settings.newTentDefaults.rulesTemplate = value || DEFAULT_RULES_TEMPLATE;
            await this.plugin.saveSettings();
          });
        textarea.inputEl.addClass("tent-settings-rules");
      });
  }

  private drawDefaultTypes(parent: HTMLElement) {
    const registry = this.plugin.settings.newTentDefaults.typeRegistry;
    const title = new Setting(parent).setName("默认 Type");
    title.setDesc("内置名称固定；颜色、R/W 与描述可改。");
    title.addButton((button) => {
      const pending = this.pendingReset === "types";
      button
        .setButtonText(pending ? "确认恢复" : "恢复默认")
        .setWarning()
        .onClick(async () => {
          if (!pending) {
            this.pendingReset = "types";
            this.display();
            return;
          }
          this.plugin.settings.newTentDefaults.typeRegistry = cloneTypeRegistry(DEFAULT_TYPE_REGISTRY);
          this.pendingReset = null;
          this.openType = null;
          await this.plugin.saveSettings();
          this.display();
        });
    });

    this.drawTypeTier(parent, registry, "base", "一级");
    this.drawTypeTier(parent, registry, "modifier", "二级");
  }

  private drawTypeTier(parent: HTMLElement, registry: TypeRegistry, tier: TypeTier, label: string) {
    const section = parent.createDiv({ cls: "tent-settings-registry" });
    new Setting(section).setName(label);
    this.drawAddType(section, tier, label);

    for (const [name, definition] of Object.entries(registry)) {
      if ((definition.tier ?? "base") !== tier) continue;
      const row = section.createDiv({ cls: "tent-settings-registry-item" });
      const summary = new Setting(row)
        .setName(name)
        .setDesc(definition.description || "");
      const color = summary.controlEl.createSpan({ cls: "tent-settings-color-dot" });
      color.style.backgroundColor = typeColorValue(definition.color);
      summary.controlEl.createSpan({
        cls: "tent-settings-rw-summary",
        text: `${axisSummary("R", definition.readable)} · ${axisSummary("W", definition.writable)}`,
      });
      summary.addButton((button) =>
        button
          .setIcon("settings")
          .setTooltip(`编辑 ${name}`)
          .onClick(() => {
            this.openType = this.openType === name ? null : name;
            this.display();
          })
      );
      if (this.openType === name) this.drawTypeEditor(row, name, definition);
    }
  }

  private drawTypeEditor(parent: HTMLElement, name: string, definition: TypeDefinition) {
    const editor = parent.createDiv({ cls: "tent-settings-editor" });
    new Setting(editor)
      .setName("描述")
      .addText((text) =>
        text.setValue(definition.description || "").onChange(async (value) => {
          setOptionalText(definition, "description", value);
          await this.plugin.saveSettings();
        })
      );
    this.drawColorControl(editor, definition.color, async (color) => {
      definition.color = color;
      await this.plugin.saveSettings();
      this.display();
    });
    this.drawAxisControl(editor, definition);

    if (!BUILTIN_TYPES.has(name)) {
      new Setting(editor)
        .setName("删除默认 type")
        .setDesc("只影响之后新建的 Tent。")
        .addButton((button) =>
          button.setButtonText("删除").setWarning().onClick(async () => {
            delete this.plugin.settings.newTentDefaults.typeRegistry[name];
            this.openType = null;
            await this.plugin.saveSettings();
            this.display();
          })
        );
    }
  }

  private drawAxisControl(parent: HTMLElement, definition: TypeDefinition) {
    const tier = definition.tier ?? "base";
    const setting = new Setting(parent).setName("R/W");
    for (const [axis, label] of [["readable", "R"], ["writable", "W"]] as const) {
      setting.controlEl.createSpan({ cls: "tent-settings-axis-label", text: label });
      setting.addDropdown((dropdown) => {
        if (tier === "modifier") dropdown.addOption("inherit", "继承");
        dropdown
          .addOption("on", "开")
          .addOption("off", "关")
          .setValue(axisValue(definition[axis], tier))
          .onChange(async (value) => {
            setTypeAxis(definition, axis, value);
            await this.plugin.saveSettings();
            this.display();
          });
      });
    }
  }

  private drawAddType(parent: HTMLElement, tier: TypeTier, label: string) {
    let name = "";
    const form = new Setting(parent)
      .setName(`新建${label}`)
      .setDesc("创建后名称不可修改。");
    form.settingEl.addClass("tent-settings-add-row");
    form.addText((text) => text.setPlaceholder("name").onChange((value) => { name = value; }));
    form.addButton((button) =>
      button.setButtonText("新建").setCta().onClick(async () => {
        const normalized = name.trim();
        if (!validRegistryName(normalized)) {
          new Notice("type 名不能为空，且不能包含空格或连字符");
          return;
        }
        const registry = this.plugin.settings.newTentDefaults.typeRegistry;
        if (registry[normalized]) {
          new Notice(`type 已存在：${normalized}`);
          return;
        }
        registry[normalized] = tier === "base"
          ? { tier: "base", readable: true, writable: false, color: "gray" }
          : { tier: "modifier", color: "gray" };
        this.openType = normalized;
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }

  private drawDefaultRoles(parent: HTMLElement) {
    const roles = this.plugin.settings.newTentDefaults.rolesRegistry.roles;
    const title = new Setting(parent).setName("默认 Role");
    title.setDesc("新帐初始可用的 role；名称创建后不可修改。");
    title.addButton((button) => {
      const pending = this.pendingReset === "roles";
      button
        .setButtonText(pending ? "确认清空" : "清空")
        .setWarning()
        .onClick(async () => {
          if (!pending) {
            this.pendingReset = "roles";
            this.display();
            return;
          }
          this.plugin.settings.newTentDefaults.rolesRegistry = { roles: [] };
          this.pendingReset = null;
          this.openRole = null;
          await this.plugin.saveSettings();
          this.display();
        });
    });

    const section = parent.createDiv({ cls: "tent-settings-registry" });
    this.drawAddRole(section);
    for (const role of roles) {
      const row = section.createDiv({ cls: "tent-settings-registry-item" });
      const summary = new Setting(row).setName(role.name).setDesc(role.description || "");
      const color = summary.controlEl.createSpan({ cls: "tent-settings-color-dot" });
      color.style.backgroundColor = typeColorValue(role.color);
      summary.addButton((button) =>
        button.setIcon("settings").setTooltip(`编辑 ${role.name}`).onClick(() => {
          this.openRole = this.openRole === role.name ? null : role.name;
          this.display();
        })
      );
      if (this.openRole === role.name) this.drawRoleEditor(row, role);
    }
  }

  private drawRoleEditor(parent: HTMLElement, role: RoleDefinition) {
    const editor = parent.createDiv({ cls: "tent-settings-editor" });
    new Setting(editor).setName("描述").addText((text) =>
      text.setValue(role.description || "").onChange(async (value) => {
        setOptionalText(role, "description", value);
        await this.plugin.saveSettings();
      })
    );
    this.drawColorControl(editor, role.color, async (color) => {
      role.color = color;
      await this.plugin.saveSettings();
      this.display();
    });
    new Setting(editor).setName("prompt").addTextArea((textarea) => {
      textarea.setValue(role.prompt || "").onChange(async (value) => {
        setOptionalText(role, "prompt", value);
        await this.plugin.saveSettings();
      });
      textarea.inputEl.addClass("tent-settings-role-prompt");
    });
    new Setting(editor).setName("删除默认 role").addButton((button) =>
      button.setButtonText("删除").setWarning().onClick(async () => {
        const roles = this.plugin.settings.newTentDefaults.rolesRegistry.roles;
        this.plugin.settings.newTentDefaults.rolesRegistry.roles = roles.filter((item) => item.name !== role.name);
        this.openRole = null;
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }

  private drawAddRole(parent: HTMLElement) {
    let name = "";
    const form = new Setting(parent).setName("新建 Role").setDesc("创建后名称不可修改。");
    form.settingEl.addClass("tent-settings-add-row");
    form.addText((text) => text.setPlaceholder("name").onChange((value) => { name = value; }));
    form.addButton((button) =>
      button.setButtonText("新建").setCta().onClick(async () => {
        const normalized = name.trim();
        if (!validRegistryName(normalized)) {
          new Notice("role 名不能为空，且不能包含空格或连字符");
          return;
        }
        const roles = this.plugin.settings.newTentDefaults.rolesRegistry.roles;
        if (roles.some((role) => role.name === normalized)) {
          new Notice(`role 已存在：${normalized}`);
          return;
        }
        roles.push({ name: normalized, color: "gray" });
        this.openRole = normalized;
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }

  private drawColorControl(parent: HTMLElement, current: string | undefined, onChange: (color: string) => Promise<void>) {
    const setting = new Setting(parent).setName("颜色");
    const palette = setting.controlEl.createDiv({ cls: "tent-settings-palette" });
    for (const color of TYPE_COLOR_PALETTE) {
      const swatch = palette.createEl("button", {
        cls: `tent-settings-swatch${color === current ? " is-active" : ""}`,
        attr: { type: "button", "aria-label": color },
      });
      swatch.style.backgroundColor = typeColorValue(color);
      swatch.onclick = () => void onChange(color);
    }
  }
}

const BUILTIN_TYPES = new Set(Object.keys(DEFAULT_TYPE_REGISTRY));

function cloneTypeRegistry(registry: TypeRegistry): TypeRegistry {
  return Object.fromEntries(Object.entries(registry).map(([name, definition]) => [name, { ...definition }]));
}

function cloneRolesRegistry(registry: RolesRegistry): RolesRegistry {
  return { roles: registry.roles.map((role) => ({ ...role })) };
}

function normalizeRoles(value: unknown): RolesRegistry {
  if (typeof value !== "object" || value === null) return cloneRolesRegistry(DEFAULT_ROLES_REGISTRY);
  const raw = value as { roles?: unknown };
  if (!Array.isArray(raw.roles)) return cloneRolesRegistry(DEFAULT_ROLES_REGISTRY);
  const roles: RoleDefinition[] = [];
  for (const item of raw.roles) {
    if (typeof item !== "object" || item === null) continue;
    const source = item as Record<string, unknown>;
    const name = typeof source.name === "string" ? source.name.trim() : "";
    if (!name || roles.some((role) => role.name === name)) continue;
    const role: RoleDefinition = { name };
    if (typeof source.color === "string" && source.color.trim()) role.color = source.color.trim();
    if (typeof source.description === "string" && source.description.trim()) role.description = source.description.trim();
    if (typeof source.prompt === "string" && source.prompt.trim()) role.prompt = source.prompt.trim();
    roles.push(role);
  }
  return { roles };
}

function axisSummary(label: string, value: boolean | undefined): string {
  return `${label}${value === undefined ? "继承" : value ? "开" : "关"}`;
}

function axisValue(value: boolean | undefined, tier: TypeTier): string {
  if (tier === "modifier" && value === undefined) return "inherit";
  return value ? "on" : "off";
}

function setTypeAxis(
  definition: TypeDefinition,
  axis: "readable" | "writable",
  value: string
): void {
  const record = definition as TypeDefinition & Record<string, unknown>;
  if (value === "inherit" && definition.tier === "modifier") delete record[axis];
  else record[axis] = value === "on";
}

function setOptionalText<T extends object>(target: T, key: keyof T, value: string): void {
  const text = value.trim();
  if (text) target[key] = text as T[keyof T];
  else delete target[key];
}

function validRegistryName(name: string): boolean {
  return !!name && name !== "temp" && !/[\s/\\-]/.test(name);
}

function mergeSettings(raw: unknown): TentSettings {
  const saved = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<TentSettings> & {
    newTentTemplate?: {
      typeRegistry?: unknown;
      rolesRegistry?: unknown;
      rulesTemplate?: unknown;
    };
  };
  const appearance: Appearance =
    saved.appearance === "follow" || saved.appearance === "light" || saved.appearance === "dark"
      ? saved.appearance
      : (saved.appearance as string | undefined) === "warm"
        ? "light"
        : DEFAULT_SETTINGS.appearance;
  const legacyDefaults = saved.newTentTemplate;
  const defaults = saved.newTentDefaults;
  const typeRegistry = normalizeRegistry(defaults?.typeRegistry ?? legacyDefaults?.typeRegistry ?? DEFAULT_TYPE_REGISTRY);
  const rolesRegistry = normalizeRoles(defaults?.rolesRegistry ?? legacyDefaults?.rolesRegistry ?? DEFAULT_ROLES_REGISTRY);
  const rulesCandidate = defaults?.rulesTemplate ?? legacyDefaults?.rulesTemplate;
  const rulesTemplate =
    typeof rulesCandidate === "string" && rulesCandidate.trim() ? rulesCandidate : DEFAULT_RULES_TEMPLATE;
  const triageReminder: TriageReminder =
    saved.triageReminder === "off" || saved.triageReminder === "status" || saved.triageReminder === "notice"
      ? saved.triageReminder
      : DEFAULT_SETTINGS.triageReminder;
  return {
    tentsRoot: typeof saved.tentsRoot === "string" && saved.tentsRoot.trim() ? saved.tentsRoot : DEFAULT_SETTINGS.tentsRoot,
    activeTent: typeof saved.activeTent === "string" ? saved.activeTent : "",
    appearance,
    dispatchPrefs: {
      copyPromptToClipboard:
        typeof saved.dispatchPrefs?.copyPromptToClipboard === "boolean"
          ? saved.dispatchPrefs.copyPromptToClipboard
          : DEFAULT_SETTINGS.dispatchPrefs.copyPromptToClipboard,
      acknowledgedTasks: Array.isArray(saved.dispatchPrefs?.acknowledgedTasks)
        ? saved.dispatchPrefs.acknowledgedTasks.filter(
            (item): item is string => typeof item === "string"
          ).slice(-500)
        : [],
    },
    triageReminder,
    newTentDefaults: {
      typeRegistry,
      rolesRegistry,
      rulesTemplate,
    },
  };
}
