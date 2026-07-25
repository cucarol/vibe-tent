import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import {
  DEFAULT_TYPE_REGISTRY,
  type TypeRegistry,
  type TypeTier,
} from "../core/typeRegistry.js";
import type { RoleDefinition } from "../core/skillRoleRegistry.js";
import { TYPE_COLOR_PALETTE, typeColorValue } from "./colors.js";
import type TentPlugin from "./main.js";
import {
  DEFAULT_RULES_TEMPLATE,
  cloneTypeRegistry,
  type Appearance,
  type TriageReminder,
} from "./settings-model.js";

export class TentSettingTab extends PluginSettingTab {
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
    settingHeading(containerEl, "帷幄 / Tent");

    settingHeading(containerEl, "帐");
    new Setting(containerEl)
      .setName("帐根目录")
      .setDesc("vault 内存放各帐的文件夹。帐保存上下文与状态，本身不使用 Git。")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.tentsRoot)
          .onChange(async (v) => {
            this.plugin.settings.tentsRoot = v.trim() || "tents";
            await this.plugin.saveSettings();
          })
      );

    this.drawNewTentDefaults(containerEl);

    settingHeading(containerEl, "外观");
    new Setting(containerEl)
      .setName("配色模式")
      .setDesc("跟随 Obsidian，或固定使用帐的浅色 / 深色配色。")
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

    settingHeading(containerEl, "交互");
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
    settingHeading(parent, "新建帐默认值");
    parent.createEl("p", {
      cls: "setting-item-description tent-settings-intro",
      text: "用于之后新建的帐，不覆盖已有帐。",
    });
    this.drawDefaultTypes(parent);
    this.drawDefaultRoles(parent);

    settingHeading(parent, "默认 RULES.md");
    const rules = new Setting(parent)
      .setName("规则模板")
      .setDesc("新建帐时写入 RULES.md；{tent} 会替换为帐名。");
    rules.settingEl.addClass("tent-settings-rules-row");
    rules.addTextArea((textarea) => {
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
    settingHeading(section, label);
    this.drawAddType(section, tier, label);

    for (const [name, definition] of Object.entries(registry)) {
      if ((definition.tier ?? "base") !== tier) continue;
      const row = section.createDiv({ cls: "tent-settings-registry-item" });
      const summary = new Setting(row)
        .setName(name)
        .setDesc(tier === "base" ? "一级（固定语义）" : "二级修饰");
      summary.controlEl.createSpan({
        cls: "tent-settings-rw-summary",
        text: `tier:${definition.tier ?? "base"}`,
      });
      if (!BUILTIN_TYPES.has(name) && tier === "modifier") {
        summary.addButton((button) =>
          button
            .setIcon("trash")
            .setTooltip(`删除 ${name}`)
            .onClick(async () => {
              delete this.plugin.settings.newTentDefaults.typeRegistry[name];
              this.openType = null;
              await this.plugin.saveSettings();
              this.display();
            })
        );
      }
    }
  }

  private drawAddType(parent: HTMLElement, tier: TypeTier, label: string) {
    let name = "";
    const form = new Setting(parent)
      .setName(`新建${label}`)
      .setDesc(
        tier === "base"
          ? "V0.2 一级 type 固定为 goal|prompt|output，不可在此新建。"
          : "创建后名称不可修改。仅支持自定义二级（modifier）。"
      );
    form.settingEl.addClass("tent-settings-add-row");
    if (tier === "base") {
      return;
    }
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
        registry[normalized] = { tier: "modifier" };
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

function setOptionalText<T extends object>(target: T, key: keyof T, value: string): void {
  const text = value.trim();
  if (text) target[key] = text as T[keyof T];
  else delete target[key];
}

function validRegistryName(name: string): boolean {
  return !!name && name !== "temp" && !/[\s/\\-]/.test(name);
}

function settingHeading(parent: HTMLElement, name: string): Setting {
  return new Setting(parent).setName(name).setHeading();
}
