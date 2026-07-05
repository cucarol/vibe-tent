// 结构编辑器视图:可拖拽框树 + 属性面板 + 顶栏收件箱下拉。
// 一切动作落盘 = 文件夹操作 + frontmatter 改写。单框改动增量重载,结构改动全量刷新。

import { ItemView, WorkspaceLeaf, Menu, Notice, TFile, normalizePath, setIcon, FileSystemAdapter } from "obsidian";
import * as nodePath from "node:path";
import type TentPlugin from "./main.js";
import { ObsidianFs, SystemClock } from "./obsidian-fs.js";
import { typeColorValue } from "./colors.js";
import { loadTagRegistry, addTag, removeTag, removeRegistryTag } from "../core/tags.js";
import { loadTent, LoadedTent, boxNotePath, reloadLoadedBox } from "../core/tree.js";
import { Box, Status } from "../core/types.js";
import { splitType, joinType } from "../core/typeRegistry.js";
import { loadRolesRegistry } from "../core/skillRoleRegistry.js";
import type { RoleDefinition } from "../core/skillRoleRegistry.js";
import { canClaim, isFrozen } from "../core/claim.js";
import { buildInbox, pendingCount, InboxItem } from "../core/inbox.js";
import { loadReports, rejectReport, type DeliveryReport } from "../core/report.js";
import { loadTaskEnvelopes, relayPromptForTask, type TaskEnvelope } from "../core/task.js";
import { buildCanvas, preservePositions, parseCanvas, canvasToJson } from "../core/canvas.js";
import { parseOutputPointer } from "../core/output.js";
import {
  ensureRoleWorkspace,
  resolveTentWorkspace,
  integrateWorkspaceCommits,
  listRoleCommitsFor,
  readWorkspaceHead,
} from "../core/workspace.js";
import type { RoleCommit, WorkspaceHead } from "../core/workspace.js";
import {
  createChevronSelect,
  drawRwSegment,
  hasActiveOwnerInScope,
  makeDragLabel,
  roleColorValue,
  tentTooltip,
} from "./ui-controls.js";
import {
  createRegistryPaneState,
  drawRegistryPane,
} from "./registry-pane.js";
import {
  capturePaneScroll,
  bottomTabCounts,
  bottomTabParts,
  restorePaneScroll,
  showsUnstampedState,
  statuslessDirectChildren,
  visibleTreeCount,
} from "./ui-model.js";
import { TimedCache } from "./timed-cache.js";
import {
  pendingDispatches,
  type PendingDispatch,
} from "./pending-dispatch.js";
import {
  OpsEnv,
  dispatch,
  forceRelease,
  createBox,
  placeBox,
  DropPosition,
  patchBox,
  patchBody,
  adoptCopiedSubtree,
  acceptReport,
  stamp,
} from "../core/ops.js";

export const TENT_VIEW_TYPE = "tent-structure-editor";

const STATUSES: Status[] = ["todo", "doing", "done"];
const MIN_TREE_COLUMN = 250;
const MIN_PROPERTY_COLUMN = 320;
const COLUMN_DIVIDER = 6;

export class TentView extends ItemView {
  private tentName = "";
  private selectedId: string | null = null;
  private tent: LoadedTent | null = null;
  private reports: DeliveryReport[] = [];
  private tasks: TaskEnvelope[] = [];
  private inbox: InboxItem[] = [];
  private pendingDispatchItems: PendingDispatch[] = [];
  private pendingDispatchByBox = new Map<string, PendingDispatch[]>();
  private draggedPath: string | null = null;
  private collapsed = new Set<string>();
  private selectedSystem: "temp" | null = null;
  private bottomTab: "note" | "dispatch" | "triage" = "note";
  // 左树热切换:全部 / 只看有待处理(decision、owner 或待投递 task)的框
  private treeFilter: "all" | "pending" = "all";
  private registryUi = createRegistryPaneState();
  private colRatio = 0.58;
  private tentsCache: string[] = [];
  private rightPane: "property" | "registry" = "property";
  private newBoxParentPath: string | null = null;
  // tags 行的内联挑选区是否展开
  private tagPickerOpen = false;
  // 属性面板:二级编辑区是否展开(一级=note+摘要;二级=可编辑控件)
  private propEditExpanded = false;
  // 哪个条目正展开内联删除二次确认(就地,不弹居中浮层);key 唯一标识那条
  private pendingDelete: string | null = null;
  private roles: RoleDefinition[] = [];
  private registryTags: string[] = [];
  // 每个 box 的未决 decision 数；report / 待投递 task 在 boxTriageCount 合并。
  private pendingByTarget: Map<string, number> = new Map();
  private loadError: string | null = null;
  private refreshTimer: number | null = null;
  private ignoredVaultChanges = new Map<string, number>();
  private recentCreates = new Set<string>();
  private columnResizeObserver: ResizeObserver | null = null;
  private columnResizeDrag: {
    cols: HTMLElement;
    rectLeft: number;
    paddingLeft: number;
    available: number;
  } | null = null;
  private workspaceHeadCache = new TimedCache<WorkspaceHead | null>();
  private roleCommitsCache = new TimedCache<RoleCommit[] | null>();

  constructor(leaf: WorkspaceLeaf, private plugin: TentPlugin) {
    super(leaf);
  }

  getViewType() {
    return TENT_VIEW_TYPE;
  }
  getDisplayText() {
    return "帷幄 · Tent";
  }
  getIcon() {
    return "tent";
  }

  async onOpen() {
    this.tentName = this.plugin.settings.activeTent || (await this.firstTent()) || "";
    this.register(() => this.columnResizeObserver?.disconnect());
    this.register(() => this.clearRefreshTimer());
    this.registerDomEvent(document, "mousemove", (event) => this.onColumnResizeMove(event));
    this.registerDomEvent(document, "mouseup", () => this.stopColumnResize());
    // 外部变动(agent 改身份文件 / 写 temp / commit)→ debounce 重载重绘
    this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultChange(f.path)));
    this.registerEvent(this.app.vault.on("create", (f) => {
      this.recentCreates.add(f.path);
      this.onVaultChange(f.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onVaultChange(f.path)));
    this.registerEvent(this.app.vault.on("rename", (f) => this.onVaultChange(f.path)));
    await this.refresh();
  }

  // 外部文件变动 → 刷新面板,但避开"正在面板里打字"与非本帐变动。
  private onVaultChange(path: string) {
    if (!this.tentName) return;
    const root = this.tentRootPath();
    if (path !== root && !path.startsWith(root + "/")) return; // 只管当前帐
    const ignoreUntil = this.ignoredVaultChanges.get(path);
    if (ignoreUntil !== undefined) {
      this.ignoredVaultChanges.delete(path);
      if (ignoreUntil >= Date.now()) return;
    }
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      this.contentEl.contains(active) &&
      (active.tagName === "TEXTAREA" || active.tagName === "INPUT")
    ) {
      return; // 别打断正在编辑;外部变动留到下次交互吸收
    }
    this.clearRefreshTimer();
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 300);
  }

  // ---- 数据 ----

  private get tentsRoot() {
    return this.plugin.settings.tentsRoot;
  }
  private tentRootPath() {
    return normalizePath(`${this.tentsRoot}/${this.tentName}`);
  }

  private env(): OpsEnv {
    return {
      fs: new ObsidianFs(this.app, this.tentRootPath()),
      clock: new SystemClock(),
      tentName: this.tentName,
      tentRoot: this.tentRootAbsolutePath() ?? this.tentRootPath(),
      rand: Math.random,
    };
  }

  private async listTents(): Promise<string[]> {
    const a = this.app.vault.adapter;
    if (!(await a.exists(this.tentsRoot))) return [];
    const listing = await a.list(this.tentsRoot);
    return listing.folders.map((f) => f.slice(f.lastIndexOf("/") + 1));
  }
  private async firstTent(): Promise<string | null> {
    const ts = await this.listTents();
    return ts[0] ?? null;
  }

  private async refresh() {
    // 刷新帐列表缓存
    this.tentsCache = await this.listTents();

    if (this.tentName) {
      try {
        const fs = this.env().fs;
        await this.adoptNativeCopies();
        this.tent = await loadTent(fs);
        this.reports = await loadReports(fs);
        this.tasks = await loadTaskEnvelopes(fs);
        this.inbox = await buildInbox(this.tent);
        this.roles = (await loadRolesRegistry(fs)).roles;
        this.registryTags = (await loadTagRegistry(fs)).tags;
        this.loadError = null;
      } catch (e) {
        this.tent = null;
        this.reports = [];
        this.tasks = [];
        this.inbox = [];
        this.roles = [];
        this.registryTags = [];
        this.loadError = e instanceof Error ? e.message : String(e);
      }
    }
    this.rebuildPendingDispatches();
    const decisions = this.pendingDecisionBoxes();
    this.plugin.updateStatus(
      pendingCount(this.inbox) +
      decisions.length +
      this.reports.filter((report) => report.status === "ready").length +
      this.pendingDispatchItems.length
    );
    this.draw();
  }

  private rebuildPendingDispatches() {
    const tent = this.tent;
    if (!tent) {
      this.pendingDispatchItems = [];
      this.pendingDispatchByBox = new Map();
      return;
    }
    this.pendingDispatchItems = pendingDispatches(this.tasks);
    const byBox = new Map<string, PendingDispatch[]>();
    for (const item of this.pendingDispatchItems) {
      const current = byBox.get(item.boxId) ?? [];
      current.push(item);
      byBox.set(item.boxId, current);
    }
    this.pendingDispatchByBox = byBox;
  }

  private async adoptNativeCopies() {
    if (this.recentCreates.size === 0) return;
    const root = this.tentRootPath();
    const candidates = [...this.recentCreates]
      .map((path) => path.startsWith(root + "/") ? path.slice(root.length + 1) : "")
      .filter(Boolean)
      .map((path) => path.endsWith(".md") ? path.slice(0, path.lastIndexOf("/")) : path);
    this.recentCreates.clear();
    if (candidates.length === 0) return;

    const roots = [...new Set(candidates)]
      .sort((a, b) => a.length - b.length)
      .filter((path, index, all) => !all.slice(0, index).some((parent) => path.startsWith(parent + "/")));
    for (const path of roots) {
      try {
        await adoptCopiedSubtree(this.env(), path);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Copied box not found")) throw error;
      }
    }
  }

  private async patchBoxIncremental(box: Box, patch: Record<string, unknown>) {
    if (!this.tent) return;
    const notePath = normalizePath(`${this.tentRootPath()}/${boxNotePath(box.path)}`);
    this.ignoredVaultChanges.set(notePath, Date.now() + 2000);
    try {
      await patchBox(this.env(), box.path, patch, this.tent);
      await reloadLoadedBox(this.env().fs, this.tent, box.path);
      this.draw();
    } catch (error) {
      this.ignoredVaultChanges.delete(notePath);
      throw error;
    }
  }

  private async patchBodyIncremental(box: Box, body: string) {
    if (!this.tent) return;
    const notePath = normalizePath(`${this.tentRootPath()}/${boxNotePath(box.path)}`);
    this.ignoredVaultChanges.set(notePath, Date.now() + 2000);
    try {
      await patchBody(this.env(), box.path, body, this.tent);
      await reloadLoadedBox(this.env().fs, this.tent, box.path);
      this.draw();
    } catch (error) {
      this.ignoredVaultChanges.delete(notePath);
      throw error;
    }
  }

  // ---- 绘制 ----

  private draw() {
    const root = this.contentEl;
    const paneScroll = capturePaneScroll(root);
    root.empty();
    root.addClass("tent-view");
    root.onclick = (event) => {
      if (!this.pendingDelete) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".is-confirm, .is-confirm-del")) return;
      this.pendingDelete = null;
      this.draw();
    };

    this.applyAppearance(root);

    const header = root.createDiv({ cls: "tent-header" });
    this.drawTopbar(header);

    if (!this.tentName) {
      root.createDiv({ cls: "tent-empty", text: "还没有帐。在设置里配好帐根目录,并在其下建一个帐文件夹。" });
      return;
    }
    if (!this.tent) {
      const detail = this.loadError ? `:${this.loadError}` : `。检查它是否在 ${this.tentsRoot}/ 下。`;
      root.createDiv({ cls: "tent-empty", text: `无法读取帐「${this.tentName}」${detail}` });
      return;
    }

    const cols = root.createDiv({ cls: "tent-cols" });
    const tree = cols.createDiv({ cls: "tent-tree" });
    const divider = cols.createDiv({ cls: "tent-divider" });
    const prop = cols.createDiv({ cls: "tent-prop" });
    this.applyColumnRatio(cols, this.colRatio);
    this.columnResizeObserver?.disconnect();
    this.columnResizeObserver = new ResizeObserver(() => this.applyColumnRatio(cols, this.colRatio));
    this.columnResizeObserver.observe(cols);
    this.wireDivider(cols, divider);
    this.drawTree(tree);
    if (this.rightPane === "registry") {
      drawRegistryPane(prop, {
        fs: this.env().fs,
        registry: this.tent.typeRegistry,
        roles: this.roles,
        redraw: () => this.draw(),
        refresh: () => this.refresh(),
        getPendingDelete: () => this.pendingDelete,
        setPendingDelete: (value) => {
          this.pendingDelete = value;
        },
      }, this.registryUi);
    }
    else this.drawProperty(prop);
    restorePaneScroll(root, paneScroll);
  }

  private wireDivider(cols: HTMLElement, divider: HTMLElement) {
    divider.onmousedown = (e) => {
      e.preventDefault();
      const rect = cols.getBoundingClientRect();
      const style = getComputedStyle(cols);
      const paddingLeft = parseFloat(style.paddingLeft);
      const horizontalPadding = paddingLeft + parseFloat(style.paddingRight);
      const available = Math.max(0, rect.width - horizontalPadding - COLUMN_DIVIDER);
      this.columnResizeDrag = {
        cols,
        rectLeft: rect.left,
        paddingLeft,
        available,
      };
    };
  }

  private onColumnResizeMove(ev: MouseEvent) {
    if (!this.columnResizeDrag) return;
    const { cols, rectLeft, paddingLeft, available } = this.columnResizeDrag;
    const rawTreeWidth = ev.clientX - rectLeft - paddingLeft;
    this.applyColumnRatio(cols, available > 0 ? rawTreeWidth / available : this.colRatio);
  }

  private stopColumnResize() {
    this.columnResizeDrag = null;
  }

  private clearRefreshTimer() {
    if (this.refreshTimer === null) return;
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private applyColumnRatio(cols: HTMLElement, desiredRatio: number) {
    if (getComputedStyle(cols).display !== "grid") return;
    const style = getComputedStyle(cols);
    const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const available = cols.clientWidth - horizontalPadding - COLUMN_DIVIDER;
    if (available <= 0) return;
    const minRatio = MIN_TREE_COLUMN / available;
    const maxRatio = (available - MIN_PROPERTY_COLUMN) / available;
    if (maxRatio < minRatio) return;
    const ratio = Math.max(minRatio, Math.min(maxRatio, desiredRatio));
    this.colRatio = ratio;
    cols.style.gridTemplateColumns = `${ratio}fr ${COLUMN_DIVIDER}px ${1 - ratio}fr`;
  }

  private drawTopbar(host: HTMLElement) {
    const bar = host.createDiv({ cls: "tent-topbar" });
    const left = bar.createDiv({ cls: "tent-topbar-left" });
    this.drawAccountSelect(left);

    if (this.tent) this.drawToolbarInline(bar);

    const right = bar.createDiv({ cls: "tent-topbar-right" });
    // 「角色在帐 / 待裁」chip 已移除:其功能由顶部工具条的过滤/标记接管

    // 类型管理入口
    const typesBtn = right.createEl("button", { cls: "tent-types-btn" });
    typesBtn.setAttr("type", "button");
    setIcon(typesBtn, "settings");
    tentTooltip(typesBtn, "类型管理");
    typesBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.rightPane = this.rightPane === "registry" ? "property" : "registry";
      this.draw();
    });

    // 外观切换：跟随 → 浅色 → 深色。
    const themeBtn = right.createEl("button", { cls: "tent-theme-btn" });
    themeBtn.setAttr("type", "button");
    const appearance = this.plugin.settings.appearance;
    setIcon(themeBtn, appearance === "follow" ? "monitor" : appearance === "dark" ? "moon" : "sun");
    tentTooltip(themeBtn, appearance === "follow" ? "跟随 Obsidian" : appearance === "dark" ? "深色" : "浅色");
    themeBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.plugin.settings.appearance =
        appearance === "follow" ? "light" : appearance === "light" ? "dark" : "follow";
      await this.plugin.saveSettings();
      this.draw();
    });
  }

  refreshAppearance() {
    this.draw();
  }

  private applyAppearance(root: HTMLElement) {
    root.removeClass("tent-theme-follow");
    root.removeClass("tent-theme-light");
    root.removeClass("tent-theme-dark");
    root.removeClass("theme-light");
    root.removeClass("theme-dark");
    root.removeClass("theme-claude");

    const mode = this.plugin.settings.appearance;
    if (mode === "follow") {
      root.addClass("tent-theme-follow");
      return;
    }
    root.addClass(`tent-theme-${mode}`);
  }

  // 帐选择器:挪到左栏「帐结构」标题位。空帐态也复用它,保证还能切/建帐。
  private drawAccountSelect(parent: HTMLElement) {
    const control = parent.createDiv({ cls: "tent-account-control" });
    const select = control.createEl("select", { cls: "tent-select dropdown tent-account-select" });
    const icon = control.createSpan({ cls: "tent-account-chevron" });
    setIcon(icon, "chevron-down");
    if (this.tentsCache.length === 0) {
      select.createEl("option", { text: "(无帐)", value: "" });
    }
    for (const t of this.tentsCache) {
      const opt = select.createEl("option", { text: t, value: t });
      if (t === this.tentName) opt.selected = true;
    }
    select.createEl("option", { text: "＋ 新建帐", value: "__genesis__" });
    select.onchange = async () => {
      if (select.value === "__genesis__") {
        await this.copyGenesisPrompt();
        select.value = this.tentName;
        return;
      }
      this.tentName = select.value;
      this.plugin.settings.activeTent = this.tentName;
      await this.plugin.saveSettings();
      this.selectedId = null;
      this.selectedSystem = null;
      this.tagPickerOpen = false;
      this.registryUi.newFormOpen = null;
      this.newBoxParentPath = null;
      this.pendingDelete = null;
      await this.refresh();
    };
  }

  private async copyGenesisPrompt() {
    const prompt =
      "Please use tent-genesis to create a new Tent. First grill me on the Tent name, goal, workspace pointer, initial top-level boxes, and initial roles (name + prompt), then scaffold the Tent and initialize the real workspace. Tent itself does not use Git.";
    await navigator.clipboard.writeText(prompt);
    new Notice("已复制 tent-genesis 起手 prompt");
  }

  // ---- 树 ----

  private drawTree(el: HTMLElement) {
    this.pendingByTarget = this.countPendingDecisionsByBox();
    const rows = el.createDiv({ cls: "tent-rows" });
    if (this.treeFilter === "pending") rows.addClass("is-pending-filter");
    for (const r of this.tent!.roots) {
      this.drawNode(rows, r, 0);
    }
    if (this.treeFilter !== "pending") {
      // 底部:新建顶层框(整宽虚线行;展开时为内联表单)
      if (this.newBoxParentPath === "") {
        this.drawInlineNewBoxForm(rows, "");
      } else {
        const addRow = rows.createDiv({ cls: "tent-add-top" });
        setIcon(addRow.createSpan({ cls: "tent-add-top-ico" }), "plus");
        addRow.createSpan({ cls: "tent-add-top-label", text: "新建顶层框" });
        addRow.onclick = () => this.openNewBoxForm("");
      }
      this.drawTempSystem(rows);
    } else if (!rows.hasChildNodes()) {
      rows.createDiv({ cls: "tent-prop-empty", text: "没有待处理的框" });
    }
    this.wireDragDelegation(rows);
  }

  // 顶部工具条(内联在 header 浮卡):全部 / 待处理 过滤 + role/一级type/二级type(modifier) 常驻标记
  private drawToolbarInline(host: HTMLElement) {
    if (!this.tent) return;
    const bar = host.createDiv({ cls: "tent-toolbar" });
    const seg = bar.createDiv({ cls: "tent-tree-filter" });
    const mk = (key: "all" | "pending", label: string) => {
      const o = seg.createDiv({
        cls: "tent-tree-filter-opt" + (this.treeFilter === key ? " is-active" : ""),
        text: label,
      });
      o.onclick = () => {
        this.treeFilter = key;
        this.draw();
      };
    };
    mk("all", "全部");
    mk("pending", "待处理");
  }

  private boxHasPending(box: Box): boolean {
    return (this.pendingByTarget.get(box.id) ?? 0) > 0 || !!box.fm.owner;
  }

  private subtreeHasPending(box: Box): boolean {
    if (this.boxHasPending(box)) return true;
    return box.children.some((c) => this.subtreeHasPending(c));
  }

  // 拖拽事件委托到行容器:根除子元素反复触发 dragover/dragleave 的闪烁。
  // 落点三段:上缘=插到前面(同级换序)/ 中段=成为子框(换爹)/ 下缘=插到后面。
  private wireDragDelegation(rows: HTMLElement) {
    const ZONE_CLS = ["tent-drop-before", "tent-drop-inside", "tent-drop-after"];
    const clearHover = () => {
      for (const cls of ZONE_CLS) rows.findAll("." + cls).forEach((r) => r.removeClass(cls));
      rows.removeClass("tent-drop-root");
    };

    // 算落点意图;非法返回 null。
    const intentFor = (row: HTMLElement | null, clientY: number):
      | { zone: "before" | "inside" | "after"; row: HTMLElement; parentPath: string; position: DropPosition }
      | { zone: "root"; parentPath: ""; position: DropPosition }
      | null => {
      const dragged = this.draggedPath;
      if (dragged === null || !this.tent) return null;
      const invalid = (parentPath: string) => parentPath === dragged || parentPath.startsWith(dragged + "/");

      if (row && row.dataset.path !== undefined) {
        const box = this.tent.byPath.get(row.dataset.path);
        if (!box) return null;
        const rect = row.getBoundingClientRect();
        const rel = (clientY - rect.top) / rect.height;
        const parentOfBox = box.parent ? box.parent.path : "";
        if (rel < 0.3) {
          if (invalid(parentOfBox)) return null;
          return { zone: "before", row, parentPath: parentOfBox, position: { mode: "before", siblingId: box.id } };
        }
        if (rel > 0.7) {
          if (invalid(parentOfBox)) return null;
          return { zone: "after", row, parentPath: parentOfBox, position: { mode: "after", siblingId: box.id } };
        }
        if (invalid(box.path)) return null; // 中段=成为它的子框
        return { zone: "inside", row, parentPath: box.path, position: { mode: "inside" } };
      }
      if (row?.dataset.system === "temp") return null;
      return { zone: "root", parentPath: "", position: { mode: "inside" } }; // 空白=升顶层末尾
    };

    rows.addEventListener("dragover", (e) => {
      if (this.draggedPath === null) return;
      e.preventDefault();
      const row = (e.target as HTMLElement).closest(".tent-node") as HTMLElement | null;
      clearHover();
      const intent = intentFor(row, e.clientY);
      if (!intent) return;
      if (intent.zone === "root") rows.addClass("tent-drop-root");
      else intent.row.addClass("tent-drop-" + intent.zone);
    });

    rows.addEventListener("drop", async (e) => {
      if (this.draggedPath === null) return;
      e.preventDefault();
      const row = (e.target as HTMLElement).closest(".tent-node") as HTMLElement | null;
      const intent = intentFor(row, e.clientY);
      const from = this.draggedPath;
      clearHover();
      this.draggedPath = null;
      if (!intent) return;
      try {
        await placeBox(this.env(), from, intent.parentPath, intent.position);
        await this.refresh();
      } catch (err) {
        new Notice("移动失败:" + (err instanceof Error ? err.message : err));
      }
    });

    rows.addEventListener("dragend", () => {
      clearHover();
      rows.removeClass("tent-dragging");
      rows.findAll(".tent-drag-source").forEach((r) => r.removeClass("tent-drag-source"));
      this.draggedPath = null;
    });
  }

  private drawNode(
    parent: HTMLElement,
    box: Box,
    depth: number
  ) {
    // 待处理过滤:本框及子孙都无待处理则整支不渲染
    if (this.treeFilter === "pending" && !this.subtreeHasPending(box)) return;
    // 嵌套容器:wrapper 包住 row + children。
    // 顶层 = 框(zone);goal/prompt/output 着各自色,
    // 其它顶层 = custom。深层有子级的容器框 = 更浅的子框。
    const wrap = parent.createDiv({ cls: "tent-box" });
    const isTop = depth === 0;
    const hasKids = box.children.length > 0;
    if (isTop) {
      wrap.addClass("tent-zone");
      const known = ["goal", "prompt", "output"].includes(box.name);
      wrap.addClass("tent-zone-" + (known ? box.name : "custom"));
      const topTypeDef = this.tent!.typeRegistry[box.type];
      wrap.style.setProperty("--zone-color", typeColorValue(topTypeDef?.color));
    } else if (hasKids) {
      wrap.addClass("tent-subframe");
    }

    const row = wrap.createDiv({ cls: "tent-node" });
    row.dataset.path = box.path;
    if (isTop) row.addClass("tent-node-header");
    if (box.id === this.selectedId) row.addClass("is-selected");
    if (this.treeFilter === "pending" && !this.boxHasPending(box)) row.addClass("tent-node-ghost");
    if (box.archived) row.addClass("tent-node-archived"); // 归档态划线
    if (box.invalid) {
      row.addClass("tent-node-invalid");
      tentTooltip(row, box.invalidReason || "失效框");
    }
    const frozen = isFrozen(box);
    // 待处理过滤态强制展开,保证能看到深处待处理框的路径
    const isCollapsed = this.treeFilter === "pending" ? false : this.collapsed.has(box.id);

    // 折叠箭头(有子级才有);无子级占位对齐
    if (hasKids) {
      const chev = row.createSpan({ cls: "tent-chev" });
      setIcon(chev, isCollapsed ? "chevron-right" : "chevron-down");
      chev.onclick = (e) => {
        e.stopPropagation();
        if (isCollapsed) this.collapsed.delete(box.id);
        else this.collapsed.add(box.id);
        this.draw();
      };
    } else {
      row.createSpan({ cls: "tent-chev tent-chev-spacer" });
    }

    // 拖拽:只处理 dragstart(over/drop/end 由容器委托)
    row.draggable = !frozen;
    row.ondragstart = (e) => {
      this.draggedPath = box.path;
      row.addClass("tent-drag-source");
      row.closest(".tent-rows")?.addClass("tent-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/tent", box.path);
        e.dataTransfer.setDragImage(makeDragLabel(this.contentEl, box.name), 8, 8);
      }
    };

    // 拖拽手柄去掉(整行仍可拖);锁定不再单独标注 —— 唯一锁定逻辑是 role 占用,已由一级 role 徽章表达
    row.createSpan({ cls: "tent-name", text: box.name });

    // 名字后:type / role 标记。聚焦框显示；树内显隐标记可让匹配项常驻。
    const split = splitType(box.type);
    const showType =
      this.registryUi.markedTypes.has(box.type) ||
      this.registryUi.markedTypes.has(split.base) ||
      (!!split.modifier && this.registryUi.markedTypes.has(split.modifier)) ||
      box.id === this.selectedId;
    const owner = box.fm.owner;
    const showRole = !!owner && (
      this.registryUi.markedRoles.has(owner) || box.id === this.selectedId
    );
    if (showType || showRole) {
      const meta = row.createSpan({ cls: "tent-node-meta" });
      meta.createSpan({ cls: "tent-meta-sep", text: "│" });
      if (showType) {
        const showBase = box.id === this.selectedId ||
          this.registryUi.markedTypes.has(box.type) ||
          this.registryUi.markedTypes.has(split.base);
        const showModifier = !!split.modifier && (
          box.id === this.selectedId ||
          this.registryUi.markedTypes.has(box.type) ||
          this.registryUi.markedTypes.has(split.modifier)
        );
        if (showBase) {
          const baseDef = this.tent!.typeRegistry[split.base];
          const tw = meta.createSpan({ cls: "tent-meta-type", text: split.base });
          tw.style.setProperty("--tent-type-color", typeColorValue(baseDef?.color));
        }
        if (showModifier && split.modifier) {
          if (showBase) meta.createSpan({ cls: "tent-meta-type-join", text: "-" });
          const modDef = this.tent!.typeRegistry[split.modifier];
          const tw = meta.createSpan({ cls: "tent-meta-type", text: split.modifier });
          tw.style.setProperty("--tent-type-color", typeColorValue(modDef?.color));
        }
      }
      if (showRole && owner) {
        const role = this.roles.find((r) => r.name === owner);
        const rl = meta.createSpan({ cls: "tent-meta-role", text: owner });
        rl.style.setProperty("--role-color", roleColorValue(role ?? { name: owner }));
      }
    }

    // 右侧槽位:待裁角标 + 状态图标;hover/选中切换显示操作键
    const slot = row.createSpan({ cls: "tent-slot" });
    const rest = slot.createSpan({ cls: "tent-slot-rest" });

    // 待裁数字角标(指向该 box 的待处理项数)
    const pend = visibleTreeCount(box, isCollapsed, (item) => this.boxTriageCount(item));
    if (pend > 0) {
      const nb = rest.createSpan({ cls: "tent-slot-notif", text: String(pend) });
      tentTooltip(nb, isCollapsed ? `${pend} 待裁决策点（含子级）` : `${pend} 待裁决策点`);
    }

    // 状态图标(无底色):doing/done,todo 不显
    const st = box.fm.status;
    if (box.invalid) {
      const pill = rest.createSpan({ cls: "tent-slot-status tent-spill tent-spill-invalid" });
      const ico = pill.createSpan();
      setIcon(ico, "triangle-alert");
      tentTooltip(pill, box.invalidReason || "失效框");
    } else if (box.fm.owner) {
      const pill = rest.createSpan({ cls: "tent-slot-status tent-spill tent-spill-lock" });
      const ico = pill.createSpan();
      setIcon(ico, "lock");
      tentTooltip(pill, `锁定:${box.fm.owner} 认领中`);
    } else if (st && st !== "todo") {
      const pill = rest.createSpan({ cls: `tent-slot-status tent-spill tent-spill-${st}` });
      const ico = pill.createSpan();
      if (st === "doing") setIcon(ico, "circle-dashed");
      else if (st === "done") setIcon(ico, "circle-check");
      tentTooltip(pill, st);
    }

    // 操作键(hover/选中时显示):根据节点状态显示不同操作
    const actionBlocked = hasActiveOwnerInScope(box);
    if (!frozen || box.archived) {
      const ops = slot.createSpan({ cls: "tent-slot-ops" });
      if (actionBlocked) ops.addClass("is-disabled");

      if (box.archived) {
        // 已归档节点:[恢复][删除]
        const restoreBtn = ops.createSpan({ cls: "tent-slot-btn" });
        setIcon(restoreBtn, "rotate-ccw");
        tentTooltip(restoreBtn, actionBlocked ? "认领范围内不能恢复" : "恢复");
        restoreBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          e.preventDefault();
          try {
            if (actionBlocked) {
              new Notice("认领范围内不能恢复;先盖章或强清 owner");
              return;
            }
            const root = this.requireExplicitArchiveRoot(box, "恢复");
            if (!root) return;
            const { restoreBox } = await import("../core/ops.js");
            await restoreBox(this.env(), root.id);
            await this.refresh();
            new Notice(`已恢复「${root.name}」`);
          } catch (err) {
            new Notice("恢复失败:" + (err instanceof Error ? err.message : err));
          }
        });

        const deleteKey = `box:${box.id}`;
        const deletePending = this.pendingDelete === deleteKey;
        const deleteBtn = ops.createSpan({ cls: "tent-slot-btn tent-slot-delete" + (deletePending ? " is-confirm" : "") });
        if (deletePending) deleteBtn.setText("确认删除");
        else setIcon(deleteBtn, "trash-2");
        tentTooltip(deleteBtn, actionBlocked ? "认领范围内不能删除" : deletePending ? "再次点击确认永久删除" : "永久删除");
        deleteBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (actionBlocked) {
            new Notice("认领范围内不能删除;先盖章或强清 owner");
            return;
          }
          const root = this.requireExplicitArchiveRoot(box, "删除");
          if (!root) return;
          const key = `box:${root.id}`;
          if (this.pendingDelete === key) {
            const { deleteArchivedBox } = await import("../core/ops.js");
            await deleteArchivedBox(this.env(), root.id);
            await this.refresh();
            new Notice(`已删除「${root.name}」`);
            return;
          }
          this.pendingDelete = key;
          this.selectedId = root.id;
          this.selectedSystem = null;
          this.draw();
        });
      } else {
        // 普通节点:[归档][＋]
        const archBtn = ops.createSpan({ cls: "tent-slot-btn" });
        setIcon(archBtn, "archive");
        tentTooltip(archBtn, actionBlocked ? "认领范围内不能归档" : "归档");
        archBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (actionBlocked) {
            new Notice("认领范围内不能归档;先盖章或强清 owner");
            return;
          }
          try {
            const { archiveBox } = await import("../core/ops.js");
            await archiveBox(this.env(), box.id);
            await this.refresh();
            new Notice(`已归档「${box.name}」`);
          } catch (err) {
            new Notice("归档失败:" + (err instanceof Error ? err.message : err));
          }
        });

        const plus = ops.createSpan({ cls: "tent-slot-btn tent-slot-plus" });
        setIcon(plus, "plus");
        tentTooltip(plus, "新建子框");
        plus.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.openNewBoxForm(box.path);
        });
      }
    }

    row.onclick = () => {
      if (this.selectedId !== box.id) this.tagPickerOpen = false;
      this.selectedId = box.id;
      this.selectedSystem = null;
      this.draw();
    };
    row.oncontextmenu = (e) => this.nodeMenu(e, box);

    if (this.newBoxParentPath === box.path) this.drawInlineNewBoxForm(wrap, box.path);
    if (hasKids && !isCollapsed) {
      const kids = wrap.createDiv({ cls: "tent-children" });
      for (const c of box.children) this.drawNode(kids, c, depth + 1);
    }
  }

  private drawTempSystem(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "tent-box tent-zone tent-zone-temp tent-zone-sys" });
    const row = wrap.createDiv({ cls: "tent-node tent-node-header tent-system" });
    row.dataset.system = "temp";
    if (this.selectedSystem === "temp") row.addClass("is-selected");
    row.createSpan({ cls: "tent-chev tent-chev-spacer" });
    row.createSpan({ cls: "tent-zdot" });
    row.createSpan({ cls: "tent-name", text: "temp" });
    row.createSpan({ cls: "tent-chip", text: "系统管道" });
    const slot = row.createSpan({ cls: "tent-slot" });
    const lock = slot.createSpan({ cls: "tent-slot-status tent-system-status" });
    setIcon(lock, "lock");
    tentTooltip(lock, "系统只读管道");
    row.onclick = () => {
      this.selectedId = null;
      this.selectedSystem = "temp";
      this.draw();
    };
  }

  private nodeMenu(e: MouseEvent, box: Box) {
    e.preventDefault();
    const menu = new Menu();

    menu.addItem((i) => i.setTitle("打开笔记").setIcon("file-text").onClick(() => this.openBoxFile(box)));

    if (!box.archived && !box.invalid && box.fm.owner) {
      menu.addItem((i) =>
        i
          .setTitle(`中断释放 (${box.fm.owner})`)
          .setIcon("unlock")
          .onClick(() => void this.requestForceRelease(box))
      );
    } else if (!box.archived && !box.invalid) {
      const check = canClaim(box);
      menu.addItem((i) =>
        i
          .setTitle("派活")
          .setIcon("send")
          .setDisabled(!check.ok)
          .onClick(() => {
            this.selectedId = box.id;
            this.selectedSystem = null;
            this.rightPane = "property";
            this.bottomTab = "dispatch";
            this.draw();
          })
      );
    }

    if (!box.archived && !box.invalid) {
      menu.addItem((i) =>
        i
          .setTitle("Fork 副本")
          .setIcon("git-fork")
          .onClick(async () => {
            try {
              const { forkNode } = await import("../core/ops.js");
              const forkId = await forkNode(this.env(), box.id);
              this.selectedId = forkId;
              this.selectedSystem = null;
              this.rightPane = "property";
              await this.refresh();
              new Notice(`已 Fork「${box.name}」`);
            } catch (err) {
              new Notice("Fork 失败:" + (err instanceof Error ? err.message : err));
            }
          })
      );

      menu.addSeparator();

      const structureBlocked = hasActiveOwnerInScope(box);
      menu.addItem((i) =>
        i
          .setTitle("新建子框")
          .setIcon("folder-plus")
          .setDisabled(structureBlocked)
          .onClick(() => this.openNewBoxForm(box.path))
      );
      menu.addItem((i) =>
        i
          .setTitle("归档")
          .setIcon("archive")
          .setDisabled(structureBlocked)
          .onClick(async () => {
            try {
              const { archiveBox } = await import("../core/ops.js");
              await archiveBox(this.env(), box.id);
              await this.refresh();
              new Notice(`已归档「${box.name}」`);
            } catch (err) {
              new Notice("归档失败:" + (err instanceof Error ? err.message : err));
            }
          })
      );
    }

    menu.showAtMouseEvent(e);
  }

  // ---- 属性面板 ----

  private drawProperty(el: HTMLElement) {
    if (this.selectedSystem === "temp") {
      el.createDiv({ cls: "tent-sect", text: "系统管道" });
      el.createDiv({ cls: "tent-prop-title", text: "temp/" });
      el.createDiv({ cls: "tent-prop-empty", text: "系统管道。agent 可读全部 temp,只可写自己的 temp/<role>/；user 可直接读写。" });
      return;
    }
    const box = this.selectedId ? this.tent!.byId.get(this.selectedId) : null;
    if (!box) {
      el.createDiv({ cls: "tent-prop-empty", text: "选一个框查看 / 编辑属性" });
      return;
    }

    const card = el.createDiv({ cls: "tent-prop-card style-a-view" });

    // 标题行:名字 + ID(紧靠标题右)+ owner(最右)+ 展开按钮(开/收二级属性)
    const titleRow = card.createDiv({ cls: "tent-prop-titlerow" });
    titleRow.createSpan({ cls: "tent-card-title", text: box.name });
    titleRow.createSpan({ cls: "tent-prop-id", text: box.id });
    const ownerWrap = titleRow.createDiv({ cls: "tent-titlerow-owner" });
    ownerWrap.createSpan({ cls: "owner-label", text: "owner" });
    const ownerHas = !!box.fm.owner;
    const ownerBadge = ownerWrap.createSpan({ cls: "owner-badge" + (ownerHas ? " active" : " empty") });
    if (ownerHas) {
      const role = this.roles.find((r) => r.name === box.fm.owner);
      ownerBadge.style.setProperty("--role-color", roleColorValue(role ?? { name: box.fm.owner! }));
    }
    ownerBadge.setText(ownerHas ? box.fm.owner! : "—");
    const expandBtn = titleRow.createEl("button", { cls: "tent-prop-expand" });
    expandBtn.setAttr("type", "button");
    setIcon(expandBtn, this.propEditExpanded ? "chevron-up" : "chevron-down");
    tentTooltip(expandBtn, this.propEditExpanded ? "收起属性" : "展开属性");
    expandBtn.onclick = () => {
      this.propEditExpanded = !this.propEditExpanded;
      this.draw();
    };

    if (splitType(box.type).base === "output") this.drawOutputSummary(card, box);

    const reg = this.tent!.typeRegistry;

    // 二级编辑区(展开才显):扁平行,无组卡底框
    if (this.propEditExpanded) {
      const editor = card.createDiv({ cls: "tent-prop-editor" });

      // type(base)— kind(modifier):合成单 type 串(modifier 覆盖 base 的 R/W)
      const { base: curBase, modifier: curMod } = splitType(box.fm.type || "");
      const bases = Object.keys(reg).filter((n) => reg[n].tier !== "modifier");
      const mods = Object.keys(reg).filter((n) => reg[n].tier === "modifier");
      const applyType = async (b: string, m: string) => {
        await this.patchBoxIncremental(box, { type: joinType(b, m || undefined) });
      };
      const tItem = editor.createDiv({ cls: "tent-prop-item tent-type-item" });
      tItem.createSpan({ cls: "tent-item-label", text: "type" });
      const tCtrl = tItem.createDiv({ cls: "tent-type-ctrl" });
      const baseSel = createChevronSelect(tCtrl, {
        cls: "dropdown tent-prop-select",
        options: bases.map((o) => ({ value: o, selected: o === curBase })),
      });
      tCtrl.createSpan({ cls: "tent-tk-dash", text: "—" });
      const modSel = createChevronSelect(tCtrl, {
        cls: "dropdown tent-prop-select",
        options: [
          { value: "", label: "无", selected: !curMod },
          ...mods.map((o) => ({ value: o, selected: o === curMod })),
        ],
      });
      baseSel.onchange = () => applyType(baseSel.value, modSel.value);
      modSel.onchange = () => applyType(baseSel.value, modSel.value);

      // 读写:可视切换(点击循环 继承→开→关),深底,靠右(非下拉)
      const rwItem = editor.createDiv({ cls: "tent-prop-item" });
      rwItem.createSpan({ cls: "tent-item-label", text: "R/W" });
      const rwWrap = rwItem.createDiv({ cls: "tent-rw-mini-wrap" });
      drawRwSegment(rwWrap, "readable", box.fm.readable, async (v) => {
        await this.patchBoxIncremental(box, { readable: v });
      });
      drawRwSegment(rwWrap, "writable", box.fm.writable, async (v) => {
        await this.patchBoxIncremental(box, { writable: v });
      });
      if (box.fm.owner) {
        editor.createDiv({ cls: "tent-prop-snapshot-note", text: "不影响已发出的 manifest,需重新 dispatch" });
      }

      // status:四段可视切换(非下拉),深底,靠右(owner 已移到标题行)
      const soItem = editor.createDiv({ cls: "tent-prop-item" });
      soItem.createSpan({ cls: "tent-item-label", text: "status" });
      const seg = soItem.createDiv({ cls: "tent-status-segment" });
      const curStatus = (box.fm.status || "todo") as Status;
      for (const o of STATUSES) {
        const opt = seg.createDiv({ cls: "tent-status-segment-option" + (o === curStatus ? " is-active" : ""), text: o });
        opt.onclick = async () => {
          await this.patchBoxIncremental(box, { status: o });
        };
      }

      // tags
      this.drawTagsRow(editor, box);
      if (this.tagPickerOpen) this.drawTagPicker(editor, box);
    }

    // 打开笔记 / 派活 / 待裁动作已并入底部 tab 的右上动作键
    this.drawBottom(card, box);
  }

  private async dispatchBox(box: Box, roleName: string, userPrompt: string) {
    const workspacePath = this.tent ? resolveTentWorkspace(this.tent) : undefined;
    const workspace = workspacePath ? await ensureRoleWorkspace(workspacePath, roleName) : undefined;
    return dispatch(this.env(), box.id, roleName, { userPrompt, workspace });
  }

  private tentRootAbsolutePath(): string | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    return nodePath.join(adapter.getBasePath(), this.tentRootPath());
  }

  private drawOutputSummary(el: HTMLElement, box: Box) {
    const pointer = parseOutputPointer(box.fm, box.body);
    const card = el.createDiv({ cls: "tent-output-summary" });
    if (showsUnstampedState(box)) {
      card.createSpan({ cls: "tent-output-pill", text: box.fm.status === "done" ? "已交付" : "未盖章" });
    }
    card.createSpan({ cls: "tent-output-line", text: pointer.workspace ? `workspace: ${pointer.workspace}` : "workspace: 未记录" });
    const refLine = card.createSpan({
      cls: "tent-output-line",
      text: pointer.workspace ? "workspace HEAD: 读取中" : pointer.ref ? `记录 ref: ${pointer.ref}` : "workspace HEAD: 不可用",
    });
    if (pointer.workspace) {
      void this.loadWorkspaceHead(pointer.workspace)
        .then((head) => {
          if (!head) {
            refLine.setText(pointer.ref ? `记录 ref: ${pointer.ref}（HEAD 不可用）` : "workspace HEAD: 不可用");
            return;
          }
          refLine.setText(`workspace HEAD: ${head.shortRef} · ${head.branch}`);
          refLine.title = head.ref;
        })
        .catch(() => {
          refLine.setText(pointer.ref ? `记录 ref: ${pointer.ref}（HEAD 不可用）` : "workspace HEAD: 不可用");
        });
    }
  }

  private requireExplicitArchiveRoot(box: Box, action: "恢复" | "删除"): Box | null {
    const root = this.findExplicitArchiveRoot(box);
    if (!root) {
      new Notice(`无法${action}:找不到显式归档根`);
      return null;
    }
    if (root.id !== box.id) {
      this.selectedId = root.id;
      this.selectedSystem = null;
      new Notice(`「${box.name}」继承自归档根「${root.name}」;请在归档根上${action}`);
      this.draw();
      return null;
    }
    return root;
  }

  private findExplicitArchiveRoot(box: Box): Box | null {
    let cur: Box | null = box;
    while (cur) {
      if (cur.fm.archived === true) return cur;
      cur = cur.parent;
    }
    return null;
  }

  // tags 行:当前 tag chips(读 box.fm.tags)+ 末尾 ＋,＋ 内联展开挑选区
  private drawTagsRow(el: HTMLElement, box: Box) {
    // tags 行(style-a):标签 + 已选 chip(实线,× 删)+ 右侧 +tag/收起 触发器
    const item = el.createDiv({ cls: "tent-prop-item-tags" });
    item.createSpan({ cls: "tent-item-label", text: "tags" });
    const ctrl = item.createDiv({ cls: "tent-item-control" });
    const container = ctrl.createDiv({ cls: "tent-tags-container" });
    const current = box.fm.tags ?? [];
    for (const tag of current) {
      const chip = container.createSpan({ cls: "tent-tag-chip-selected" });
      chip.createSpan({ text: tag });
      const x = chip.createEl("i");
      setIcon(x, "x");
      tentTooltip(x, `移除 #${tag}`);
      x.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await removeTag(this.env().fs, box.id, tag);
          await this.refresh();
        } catch (err) {
          new Notice("移除 tag 失败:" + (err instanceof Error ? err.message : err));
        }
      };
    }
    const trigger = container.createSpan({ cls: "tent-tag-trigger-btn" });
    setIcon(trigger, this.tagPickerOpen ? "chevron-up" : "plus");
    trigger.createSpan({ text: this.tagPickerOpen ? "收起" : "tag" });
    trigger.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.tagPickerOpen = !this.tagPickerOpen;
      this.draw();
    };
  }

  // 展开挑选器(图二):已登记但本框没有的 tag 列成虚线 chip(点即加)+ 新建输入
  private drawTagPicker(host: HTMLElement, box: Box) {
    const current = box.fm.tags ?? [];
    const candidates = this.registryTags.filter((t) => !current.includes(t));
    const picker = host.createDiv({ cls: "tent-tag-picker" });
    picker.createDiv({ cls: "tent-tag-picker-title", text: "选择已有标签" });
    const list = picker.createDiv({ cls: "tent-tag-picker-list" });
    if (candidates.length === 0) {
      list.createSpan({ cls: "tent-tag-picker-empty", text: "没有更多已有标签" });
    } else {
      for (const tag of candidates) {
        const pendKey = `regtag:${tag}`;
        const pending = this.pendingDelete === pendKey;
        const chip = list.createSpan({ cls: "tent-tag-chip-selectable" + (pending ? " is-confirm-del" : "") });
        chip.createSpan({ cls: "ttc-label", text: pending ? "确认删除" : tag });
        const confirmDelete = async () => {
          try {
            await removeRegistryTag(this.env().fs, tag);
            this.pendingDelete = null;
            await this.refresh();
          } catch (err) {
            new Notice("删除失败:" + (err instanceof Error ? err.message : err));
          }
        };
        // 点 chip 本体 = 加到本框;确认删除态下二次点击执行删除
        chip.onclick = async (e) => {
          e.preventDefault();
          if (pending) {
            await confirmDelete();
            return;
          }
          try {
            await addTag(this.env().fs, box.id, tag);
            await this.refresh();
          } catch (err) {
            new Notice("加 tag 失败:" + (err instanceof Error ? err.message : err));
          }
        };
        if (!pending) {
          // x = 从注册表删除(两步:先变确认态,再点确认删除级联剥除所有框)
          const x = chip.createEl("i", { cls: "tent-tag-chip-del" });
          setIcon(x, "x");
          tentTooltip(x, `从注册表删除 #${tag}`);
          x.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.pendingDelete = pendKey;
            this.draw();
          };
        }
      }
    }
    const newRow = picker.createDiv({ cls: "tent-tag-picker-new-row" });
    const input = newRow.createEl("input", { cls: "tent-tag-inline-input", attr: { type: "text", placeholder: "输入新建标签" } });
    const submit = newRow.createEl("button", { cls: "tent-tag-new-submit", text: "新建" });
    const create = async () => {
      const name = input.value.trim();
      if (!name) return;
      try {
        await addTag(this.env().fs, box.id, name);
        await this.refresh();
      } catch (err) {
        new Notice("加 tag 失败:" + (err instanceof Error ? err.message : err));
      }
    };
    submit.onclick = (e) => {
      e.preventDefault();
      void create();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void create();
      } else if (e.key === "Escape") {
        this.tagPickerOpen = false;
        this.draw();
      }
    });
  }

  // status 小圆 chip:与左树同套 icon,色随状态。todo 用空心圈(仅面板,左树不显 todo)。
  // 底部:左上 笔记/派活/待裁 tab 切内容,右上对应动作键
  private drawBottom(el: HTMLElement, box: Box) {
    const wrap = el.createDiv({ cls: "tent-bottom" });
    const head = wrap.createDiv({ cls: "tent-bottom-head" });
    const tabs = head.createDiv({ cls: "tent-bottom-tabs" });
    const counts = bottomTabCounts({
      pendingDispatches: this.pendingDispatchByBox.get(box.id)?.length ?? 0,
      pendingDecisions: this.isPendingDecisionBox(box) ? 1 : 0,
      readyReports: this.reports.filter((report) => report.boxId === box.id && report.status === "ready").length,
    });
    const mkTab = (key: "note" | "dispatch" | "triage", label: string, count = 0) => {
      const t = tabs.createDiv({ cls: "tent-bottom-tab" + (this.bottomTab === key ? " is-active" : "") });
      const parts = bottomTabParts(label, count);
      t.createSpan({ cls: "tent-bottom-tab-label", text: parts.label });
      if (parts.count) t.createSpan({ cls: "tent-bottom-tab-count", text: parts.count });
      t.onclick = () => {
        this.bottomTab = key;
        this.draw();
      };
    };
    mkTab("note", "笔记");
    mkTab("dispatch", "派活", counts.dispatch);
    mkTab("triage", "待裁", counts.triage);
    const actSlot = head.createDiv({ cls: "tent-bottom-act" });
    const body = wrap.createDiv({ cls: "tent-bottom-body" });

    if (this.bottomTab === "dispatch") {
      this.drawDispatchInline(body, actSlot, box);
    } else if (this.bottomTab === "triage") {
      this.drawTriageInline(body, actSlot, box);
    } else {
      const open = actSlot.createEl("button", { cls: "tent-bottom-action", text: "打开笔记" });
      open.onclick = () => this.openBoxFile(box);
      this.drawNote(body, box);
    }
  }

  private boxTriageCount(box: Box): number {
    const decisions = this.isPendingDecisionBox(box) ? 1 : 0;
    const reports = this.reports.filter((report) => report.boxId === box.id && report.status === "ready").length;
    const dispatches = this.pendingDispatchByBox.get(box.id)?.length ?? 0;
    return decisions + reports + dispatches;
  }

  // 待裁 tab:未决 decision + 完成待确认(中断释放 / 确认完成)
  private drawTriageInline(body: HTMLElement, actSlot: HTMLElement, box: Box) {
    const isDecision = this.isPendingDecisionBox(box);
    const owner = box.fm.owner;
    const report = this.reports.find((item) => item.boxId === box.id && item.status === "ready");
    const rejectedReport = this.reports.find((item) => item.boxId === box.id && item.status === "rejected");
    if (owner) {
      const releasePending = this.pendingDelete === `release:${box.id}`;
      const rel = actSlot.createEl("button", {
        cls: "tent-bottom-action tent-bottom-danger" + (releasePending ? " is-confirm" : ""),
        text: releasePending ? "确认释放" : "中断释放",
      });
      rel.setAttr("type", "button");
      rel.onclick = (event) => {
        event.stopPropagation();
        void this.requestForceRelease(box);
      };
    }
    if (!isDecision && !owner && !report) {
      body.createDiv({ cls: "tent-bottom-empty", text: "无待处理" });
      return;
    }

    if (isDecision) {
      body.createDiv({ cls: "tent-triage-sec", text: "待你裁决的决策点" });
      const item = body.createDiv({ cls: "tent-triage-item" });
      const main = item.createDiv({ cls: "tent-triage-main" });
      const first = box.body.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#")) || box.name;
      main.createDiv({ cls: "tent-triage-name", text: first });
      main.createDiv({ cls: "tent-triage-meta", text: "decision · user 选择后盖章解消" });
      const acts = item.createDiv({ cls: "tent-triage-acts" });
      const open = acts.createEl("button", { text: "打开" });
      open.setAttr("type", "button");
      open.onclick = () => this.openBoxFile(box);
      const done = acts.createEl("button", { cls: "mod-cta", text: "盖章" });
      done.setAttr("type", "button");
      done.onclick = async () => {
        done.setAttr("disabled", "true");
        try {
          await stamp(this.env(), box.id);
          await this.refresh();
          new Notice("决策点已解消");
        } catch (e) {
          done.removeAttribute("disabled");
          new Notice("盖章失败:" + (e instanceof Error ? e.message : e));
        }
      };
    }

    if (report) {
      body.createDiv({ cls: "tent-triage-sec", text: "待确认交付" });
      const item = body.createDiv({ cls: "tent-triage-item" });
      const main = item.createDiv({ cls: "tent-triage-main" });
      const first = report.body.split("\n").map((line) => line.trim()).find(Boolean) || "(无说明)";
      main.createDiv({ cls: "tent-triage-name", text: first });
      main.createDiv({
        cls: "tent-triage-meta",
        text: `${report.role} · ${report.commits.length === 0 ? "无代码提交" : `${report.commits.length} 个代码提交`}`,
      });
      const acts = item.createDiv({ cls: "tent-triage-acts" });
      const open = acts.createEl("button", { text: "打开" });
      open.setAttr("type", "button");
      open.onclick = () => this.openVaultFile(report.path);
      const reject = acts.createEl("button", { text: "驳回" });
      reject.setAttr("type", "button");
      reject.onclick = async () => {
        try {
          await rejectReport(this.env().fs, report.path);
          await this.refresh();
          new Notice("已驳回，owner 保留，等待 agent 重新交付");
        } catch (e) {
          new Notice("驳回失败:" + (e instanceof Error ? e.message : e));
        }
      };
      const done = acts.createEl("button", { cls: "mod-cta", text: "确认" });
      done.setAttr("type", "button");
      const statuslessChildren = statuslessDirectChildren(box);

      if (report.commits.length > 0) {
        const pick = body.createDiv({ cls: "tent-commit-pick" });
        pick.createDiv({ cls: "tent-commit-note", text: "读取 report commits…" });
        this.loadRoleCommits(report.role).then((commits) => {
          pick.empty();
          pick.createDiv({ cls: "tent-commit-head", text: "确认后将全部合入:" });
          const byRef = new Map((commits || []).map((commit) => [commit.ref, commit]));
          for (const ref of report.commits) {
            const commit = byRef.get(ref);
            const row = pick.createDiv({ cls: "tent-commit-row" });
            row.createSpan({ cls: "tent-commit-sha", text: commit?.shortRef || ref.slice(0, 8) });
            row.createSpan({ cls: "tent-commit-sub", text: commit?.subject || ref });
          }
        }).catch(() => {
          pick.empty();
          for (const ref of report.commits) {
            const row = pick.createDiv({ cls: "tent-commit-row" });
            row.createSpan({ cls: "tent-commit-sha", text: ref.slice(0, 8) });
            row.createSpan({ cls: "tent-commit-sub", text: ref });
          }
        });
      }

      const accept = async (children: Box[], controls: HTMLButtonElement[] = [done]) => {
        for (const control of controls) control.setAttr("disabled", "true");
        try {
          await acceptReport(
            this.env(),
            report.path,
            {
              integrate: async (refs) => {
                const wp = this.tent ? resolveTentWorkspace(this.tent) : undefined;
                if (!wp) throw new Error("帐内没有 workspace output 指针");
                const contract = await ensureRoleWorkspace(wp, report.role);
                await integrateWorkspaceCommits(contract, refs);
              },
            }
          );
          for (const child of children) await stamp(this.env(), child.id);
          this.clearGitUiCache();
          await this.refresh();
          const childMessage = children.length > 0 ? `，并盖章 ${children.length} 个子级` : "";
          new Notice((report.commits.length
            ? `已确认(合入 ${report.commits.length} commit + 清 owner)`
            : "已确认(done + 清 owner)") + childMessage);
        } catch (e) {
          for (const control of controls) control.removeAttribute("disabled");
          new Notice("确认失败:" + (e instanceof Error ? e.message : e));
        }
      };
      done.onclick = () => {
        if (statuslessChildren.length === 0) {
          void accept([]);
          return;
        }

        done.setAttr("disabled", "true");
        const prompt = body.createDiv({ cls: "tent-child-stamp" });
        prompt.createDiv({
          cls: "tent-child-stamp-title",
          text: `同时盖章 ${statuslessChildren.length} 个直接子级？`,
        });
        const selected = new Set(statuslessChildren.map((child) => child.id));
        for (const child of statuslessChildren) {
          const row = prompt.createEl("label", { cls: "tent-child-stamp-row" });
          const checkbox = row.createEl("input", { type: "checkbox" });
          checkbox.checked = true;
          row.createSpan({ text: child.name });
          checkbox.onchange = () => {
            if (checkbox.checked) selected.add(child.id);
            else selected.delete(child.id);
          };
        }
        const promptActions = prompt.createDiv({ cls: "tent-child-stamp-actions" });
        const parentOnly = promptActions.createEl("button", { text: "仅盖父框" });
        parentOnly.setAttr("type", "button");
        const includeChildren = promptActions.createEl("button", { cls: "mod-cta", text: "同时盖章" });
        includeChildren.setAttr("type", "button");
        const controls = [parentOnly, includeChildren];
        parentOnly.onclick = () => void accept([], controls);
        includeChildren.onclick = () => {
          const children = statuslessChildren.filter((child) => selected.has(child.id));
          void accept(children, controls);
        };
      };
    } else if (owner) {
      body.createDiv({ cls: "tent-triage-sec", text: "处理中" });
      const item = body.createDiv({ cls: "tent-triage-item" });
      const main = item.createDiv({ cls: "tent-triage-main" });
      main.createDiv({ cls: "tent-triage-name", text: `${owner} 正在处理此框` });
      main.createDiv({
        cls: "tent-triage-meta",
        text: rejectedReport ? "上一份交付已驳回，等待重新交付" : "report 到达后可在此确认交付",
      });
    }

  }

  private pendingDecisionBoxes(): Box[] {
    if (!this.tent) return [];
    return [...this.tent.byId.values()].filter((box) => this.isPendingDecisionBox(box));
  }

  private isPendingDecisionBox(box: Box): boolean {
    return box.tags.includes("decision") && box.fm.status !== "done";
  }

  private countPendingDecisionsByBox(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const box of this.pendingDecisionBoxes()) {
      counts.set(box.id, (counts.get(box.id) ?? 0) + 1);
    }
    return counts;
  }

  private loadWorkspaceHead(workspace: string): Promise<WorkspaceHead | null> {
    const key = nodePath.resolve(workspace);
    return this.workspaceHeadCache.get(key, async () => {
      try {
        return await readWorkspaceHead(key);
      } catch {
        return null;
      }
    });
  }

  // 读取某 role lane 尚未合入正式分支的 commit;无 workspace 指针返回 null
  private async loadRoleCommits(owner: string): Promise<RoleCommit[] | null> {
    let wp: string | undefined;
    try {
      wp = this.tent ? resolveTentWorkspace(this.tent) : undefined;
    } catch {
      return null;
    }
    if (!wp) return null;
    const workspace = nodePath.resolve(wp);
    return this.roleCommitsCache.get(`${workspace}\0${owner}`, () => listRoleCommitsFor(workspace, owner));
  }

  private clearGitUiCache() {
    this.workspaceHeadCache.clear();
    this.roleCommitsCache.clear();
  }

  // 派活内联:待投递任务优先；空闲框显示目标 role + user prompt。
  private drawDispatchInline(body: HTMLElement, actSlot: HTMLElement, box: Box) {
    const pendingDispatch = this.pendingDispatchByBox.get(box.id)?.[0];
    if (pendingDispatch) {
      body.createDiv({ cls: "tent-triage-sec", text: "等待投递" });
      const item = body.createDiv({ cls: "tent-triage-item" });
      const main = item.createDiv({ cls: "tent-triage-main" });
      main.createDiv({
        cls: "tent-triage-name",
        text: `等待投递给 ${pendingDispatch.task.role}`,
      });
      main.createDiv({
        cls: "tent-triage-meta",
        text: "复制后可新开或复用目标 role 的会话；只有 agent 执行 task-ack 后，此条目才会清除。",
      });
      const acts = item.createDiv({ cls: "tent-triage-acts" });
      const copy = acts.createEl("button", { text: "复制投递 prompt" });
      copy.setAttr("type", "button");
      copy.onclick = async () => {
        try {
          const tentRoot = this.tentRootAbsolutePath();
          if (!tentRoot) throw new Error("无法解析帐根绝对路径");
          await navigator.clipboard.writeText(relayPromptForTask(pendingDispatch.task, tentRoot));
          new Notice(`已复制，去 ${pendingDispatch.task.role} 的 agent 会话粘贴即可。`);
        } catch (e) {
          new Notice("复制失败:" + (e instanceof Error ? e.message : e));
        }
      };
      return;
    }

    if (box.fm.owner) {
      const state = body.createDiv({ cls: "tent-content-intro is-stacked" });
      state.createDiv({ cls: "tent-content-title", text: `${box.fm.owner} 正在处理此框` });
      state.createDiv({ cls: "tent-content-meta", text: "可在「待裁」中查看交付或中断任务" });
      return;
    }

    const form = body.createDiv({ cls: "tent-dispatch-form style-a-view" });
    const roleRow = form.createDiv({ cls: "tent-dispatch-row tent-dispatch-role-row" });
    roleRow.createSpan({ cls: "tent-prop-key", text: "目标 role" });
    const roleControl = roleRow.createDiv({ cls: "tent-dispatch-control" });
    const roleSelect = createChevronSelect(roleControl, {
      cls: "dropdown tent-prop-select tent-dispatch-select tent-dispatch-role-select",
      options: [
        { value: "", label: this.roles.length ? "(选择)" : "(手动输入)" },
        ...this.roles.map((role) => ({ value: role.name, label: role.name })),
      ],
    });
    const manualRole = roleControl.createEl("input", { cls: "tent-dispatch-role-input", attr: { type: "text" } });
    manualRole.toggleClass("is-hidden", this.roles.length > 0);
    roleSelect.onchange = () => {
      manualRole.toggleClass("is-hidden", !!roleSelect.value || this.roles.length > 0);
    };

    const userSection = form.createDiv({ cls: "tent-dispatch-row tent-dispatch-prompt-row" });
    userSection.createSpan({ cls: "tent-prop-key", text: "user prompt" });
    const prompt = userSection.createEl("textarea", {
      cls: "tent-dispatch-prompt",
      attr: { rows: "1" },
    });
    const resizePrompt = () => {
      prompt.style.height = "auto";
      prompt.style.height = `${Math.max(30, prompt.scrollHeight)}px`;
    };
    prompt.oninput = resizePrompt;

    const claim = canClaim(box);
    const run = actSlot.createEl("button", { cls: "tent-bottom-action", text: "派活接力" });
    run.setAttr("type", "button");
    run.disabled = !claim.ok;
    if (!claim.ok) tentTooltip(run, claim.reason || "");
    run.onclick = async () => {
      const roleName = roleSelect.value.trim() || manualRole.value.trim();
      if (!roleName) {
        new Notice("请选择或输入 role");
        return;
      }
      const localPrompt = prompt.value.trim();
      if (!localPrompt) {
        new Notice("请填写 user prompt");
        return;
      }
      try {
        const r = await this.dispatchBox(box, roleName, localPrompt);
        if (this.plugin.settings.dispatchPrefs.copyPromptToClipboard) {
          await navigator.clipboard.writeText(r.relayPrompt);
          new Notice("已派活。已复制接力 prompt,去目标 agent 会话粘贴。", 6000);
        } else {
          new Notice("已派活。接力 prompt 已生成。", 6000);
        }
        await this.refresh();
      } catch (e) {
        new Notice("派活失败:" + (e instanceof Error ? e.message : e));
      }
    };
  }

  // 正文:可编辑 textarea,blur 落盘。支持拖 Obsidian 文件进来转成帐根相对路径。
  private drawNote(el: HTMLElement, box: Box) {
    const intro = el.createDiv({ cls: "tent-content-intro" });
    intro.createDiv({ cls: "tent-content-title", text: "笔记正文" });
    intro.createDiv({
      cls: "tent-content-meta",
      text: box.readable.value ? "派活时作为此框上下文提供给 agent" : "仅供 user 查看",
    });
    const ta = el.createEl("textarea", { cls: "tent-notebox" });
    ta.value = box.body.trim();
    ta.onblur = async () => {
      if (ta.value.trim() === box.body.trim()) return;
      await this.patchBodyIncremental(box, ta.value.trim() + "\n");
    };
    // 拖 Obsidian 文件进来:把 obsidian:// URI / [[双链]] 换成干净的文件路径
    ta.addEventListener("drop", (e) => {
      const raw = e.dataTransfer?.getData("text/plain") || "";
      const uriM = raw.match(/[?&]file=([^&\s]+)/);
      const wikiM = raw.match(/^\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/);
      const name = uriM ? decodeURIComponent(uriM[1]) : wikiM ? wikiM[1] : null;
      if (!name) return; // 不是 Obsidian 文件拖入,走默认行为
      e.preventDefault();
      e.stopPropagation();
      const vaultPath = /\.\w+$/.test(name) ? name : name + ".md";
      // 文件是 vault 相对路径;agent 的 cwd = 帐根,要从帐根爬回 vault 根再找它
      const up = "../".repeat(this.tentRootPath().split("/").filter(Boolean).length);
      const rel = up + vaultPath;
      const s = ta.selectionStart ?? ta.value.length;
      const en = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, s) + rel + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + rel.length;
      ta.focus();
    });
  }

  // ---- 动作处理 ----

  private openNewBoxForm(parentPath: string) {
    this.newBoxParentPath = this.newBoxParentPath === parentPath ? null : parentPath;
    this.pendingDelete = null;
    this.draw();
  }

  private drawInlineNewBoxForm(parent: HTMLElement, parentPath: string) {
    const card = parent.createDiv({ cls: "tent-newform tent-inline-newbox" });
    const reg = this.tent!.typeRegistry;
    const bases = Object.keys(reg).filter((n) => reg[n].tier !== "modifier");
    const mods = Object.keys(reg).filter((n) => reg[n].tier === "modifier");
    const defaultType = parentPath ? this.tent!.byPath.get(parentPath)?.type : undefined;
    const sp = defaultType ? splitType(defaultType) : { base: "", modifier: "" };
    const state = {
      name: "",
      base: sp.base && bases.includes(sp.base) ? sp.base : bases[0] ?? "",
      kind: sp.modifier && mods.includes(sp.modifier) ? sp.modifier : "",
    };

    // 单行:名字 input · type 一级—二级 两个下拉 · 新建 / 取消
    const row = card.createDiv({ cls: "tent-newbox-row" });
    row.createSpan({ cls: "tent-newform-label", text: "名字" });
    const nameInput = row.createEl("input", {
      cls: "tent-newform-input",
      attr: { type: "text" },
    });
    nameInput.oninput = () => (state.name = nameInput.value.trim());

    row.createSpan({ cls: "tent-newform-label", text: "type" });
    const baseSel = row.createEl("select", { cls: "dropdown tent-newbox-type" });
    for (const b of bases) {
      const o = baseSel.createEl("option", { text: b, value: b });
      if (b === state.base) o.selected = true;
    }
    baseSel.onchange = () => (state.base = baseSel.value);

    row.createSpan({ cls: "tent-tk-dash", text: "—" });

    const kindSel = row.createEl("select", { cls: "dropdown tent-newbox-type" });
    const none = kindSel.createEl("option", { text: "无", value: "" });
    if (!state.kind) none.selected = true;
    for (const m of mods) {
      const o = kindSel.createEl("option", { text: m, value: m });
      if (m === state.kind) o.selected = true;
    }
    kindSel.onchange = () => (state.kind = kindSel.value);

    const create = row.createEl("button", { cls: "mod-cta", text: "新建" });
    create.setAttr("type", "button");
    create.onclick = async () => {
      if (!state.name) {
        new Notice("请填写框名");
        return;
      }
      const type = joinType(state.base, state.kind || undefined);
      await createBox(this.env(), { parentPath, name: state.name, type });
      this.newBoxParentPath = null;
      await this.refresh();
      new Notice(`已建框「${state.name}」`);
    };
    const cancel = row.createEl("button", { text: "取消" });
    cancel.setAttr("type", "button");
    cancel.onclick = () => {
      this.newBoxParentPath = null;
      this.draw();
    };

    nameInput.focus();
  }

  private async requestForceRelease(box: Box) {
    const key = `release:${box.id}`;
    if (this.pendingDelete === key) {
      this.pendingDelete = null;
      try {
        await forceRelease(this.env(), box.id);
        await this.refresh();
        new Notice(`已中断「${box.name}」并释放 owner`);
      } catch (error) {
        new Notice("释放失败:" + (error instanceof Error ? error.message : error));
      }
      return;
    }
    this.pendingDelete = key;
    this.selectedId = box.id;
    this.selectedSystem = null;
    this.rightPane = "property";
    this.bottomTab = "triage";
    this.draw();
  }

  // ---- 白板:生成原生 .canvas 并打开 ----

  async openBoard() {
    if (!this.tent) {
      new Notice("先选一个帐");
      return;
    }
    const fs = this.env().fs;
    const canvasRel = "_tent.canvas";
    try {
      const old = (await fs.exists(canvasRel)) ? parseCanvas(await fs.readFile(canvasRel)) : null;
      const fresh = buildCanvas(this.tent, this.tentRootPath());
      preservePositions(fresh, old, this.tent);
      await fs.writeFile(canvasRel, canvasToJson(fresh));
      await this.openVaultFile(canvasRel, 200);
      new Notice("白板已刷新");
    } catch (e) {
      new Notice("生成白板失败:" + (e instanceof Error ? e.message : e));
    }
  }

  // ---- 打开文件 ----

  private async openBoxFile(box: Box) {
    await this.openVaultFile(boxNotePath(box.path));
  }
  private async openVaultFile(tentRelPath: string, retryMs = 0) {
    const vaultPath = normalizePath(`${this.tentRootPath()}/${tentRelPath}`);
    let file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!file && retryMs > 0) {
      await new Promise((r) => window.setTimeout(r, retryMs));
      file = this.app.vault.getAbstractFileByPath(vaultPath);
    }
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(file);
    } else {
      new Notice("找不到文件:" + vaultPath);
    }
  }

}
