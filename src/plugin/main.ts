// Tent 插件入口。注册结构编辑器视图、ribbon、命令、状态条。

import { Plugin, WorkspaceLeaf, addIcon, Notice } from "obsidian";
import { TentView, TENT_VIEW_TYPE } from "./view.js";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type TentSettings,
} from "./settings-model.js";
import { TentSettingTab } from "./settings.js";

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
      id: "open-panel",
      name: "Open panel",
      callback: () => this.activateView(),
    });
    // 白板搁置,仅留实验命令;以后再正式做(嵌套 B/C 取舍未定)。
    this.addCommand({
      id: "open-board-experimental",
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
      text: pending > 0 ? `${pending} 待处理` : "帐内无事",
      cls: pending > 0 ? "tent-status-hot" : "tent-status-calm",
    });
    if (this.settings.triageReminder === "notice" && previous !== null && pending > previous) {
      new Notice(`Tent 新增 ${pending - previous} 项待处理`);
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
  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(TENT_VIEW_TYPE)) {
      (leaf.view as TentView).refreshAppearance();
    }
  }
}
