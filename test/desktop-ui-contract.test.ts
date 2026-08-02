/**
 * Desktop renderer UI contract: control class tokens, left-click close / collapse,
 * and shared helper markup. Static source + pure helper tests (no Electron).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import {
  UI,
  btnClass,
  btnHtml,
  documentTabHtml,
  iconBtnHtml,
  treeRowClass,
} from "../src/desktop/renderer/main/ui.js";

const root = process.cwd();
const renderer = path.join(root, "src/desktop/renderer");

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), "utf8");
}

test("UI class tokens cover Button / IconButton / Field / Tab / Tree / Section / PaneCollapse", () => {
  assert.equal(UI.btnPrimary, "btn btn-primary");
  assert.equal(UI.btnSecondary, "btn btn-secondary");
  assert.equal(UI.btnGhost, "btn btn-ghost");
  assert.equal(UI.btnDanger, "btn btn-danger");
  assert.equal(UI.iconBtn, "icon-btn");
  assert.equal(UI.field, "field");
  assert.equal(UI.fieldCompact, "field field-compact");
  assert.equal(UI.tab, "tab");
  assert.equal(UI.tabLabel, "tab-label");
  assert.equal(UI.tabClose, "tab-close");
  assert.equal(UI.treeNode, "tree-node");
  assert.equal(UI.inspSection, "insp-section");
  assert.equal(UI.inspSummary, "insp-summary");
  assert.equal(UI.collapseEdge, "icon-btn collapse-edge");
  assert.equal(UI.railToggle, "icon-btn rail-toggle");
});

test("btnClass / btnHtml / iconBtnHtml produce stable, escapable markup", () => {
  assert.equal(btnClass("primary"), "btn btn-primary");
  assert.equal(btnClass("danger", "extra"), "btn btn-danger extra");
  const primary = btnHtml({ label: "派活", variant: "primary", id: "btn-dispatch", disabled: true });
  assert.match(primary, /class="btn btn-primary"/);
  assert.match(primary, /id="btn-dispatch"/);
  assert.match(primary, /\bdisabled\b/);
  assert.match(primary, />派活</);

  const danger = btnHtml({ label: '确认"驳回"', variant: "danger", attrs: 'data-reject="p"' });
  assert.match(danger, /class="btn btn-danger"/);
  assert.match(danger, /data-reject="p"/);
  assert.match(danger, /确认&quot;驳回&quot;/);

  const icon = iconBtnHtml({
    icon: "<svg></svg>",
    title: "收起左侧栏",
    extraClass: "collapse-edge",
    id: "btn-collapse-left",
    expanded: true,
  });
  assert.match(icon, /class="icon-btn collapse-edge"/);
  assert.match(icon, /id="btn-collapse-left"/);
  assert.match(icon, /aria-expanded="true"/);
  assert.match(icon, /aria-label="收起左侧栏"/);
  assert.match(icon, /<svg><\/svg>/);
});

test("documentTabHtml always exposes a clickable close control with data-close-tab", () => {
  const html = documentTabHtml({
    nodeId: 'cx-1"x',
    name: "笔记 <A>",
    active: true,
    dirty: true,
    closeIcon: '<svg class="ico ico-close"></svg>',
  });
  assert.match(html, /class="tab active"/);
  assert.match(html, /class="tab-label"/);
  assert.match(html, /class="tab-close"/);
  assert.match(html, /data-close-tab="cx-1&quot;x"/);
  assert.match(html, /data-tab="cx-1&quot;x"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /aria-label="关闭 笔记 &lt;A&gt;"/);
  assert.match(html, /笔记 &lt;A&gt; ·/);
  assert.match(html, /ico-close/);
});

test("treeRowClass encodes active and archived without magic strings", () => {
  assert.equal(treeRowClass({}), "tree-node");
  assert.equal(treeRowClass({ active: true }), "tree-node active");
  assert.equal(treeRowClass({ archived: true }), "tree-node is-archived");
  assert.equal(treeRowClass({ active: true, archived: true }), "tree-node active is-archived");
});

test("primitives.css defines shared hover/active/focus-visible/disabled/danger states", async () => {
  const css = await read("src/desktop/renderer/styles/primitives.css");
  for (const sel of [
    ".btn",
    ".btn-primary",
    ".btn-secondary",
    ".btn-ghost",
    ".btn-danger",
    ".icon-btn",
    ".field",
  ]) {
    assert.match(css, new RegExp(sel.replace(".", "\\.") + "\\b"));
  }
  assert.match(css, /\.btn:focus-visible/);
  assert.match(css, /\.btn:disabled/);
  assert.match(css, /\.btn-primary:hover:not\(:disabled\)/);
  assert.match(css, /\.btn-primary:active:not\(:disabled\)/);
  assert.match(css, /\.icon-btn:hover:not\(:disabled\)/);
  assert.match(css, /\.icon-btn:disabled/);
  assert.match(css, /\.icon-btn\.danger:hover:not\(:disabled\)|\.icon-btn\.is-danger:hover:not\(:disabled\)/);
  assert.match(css, /\.field:disabled/);
  assert.match(css, /\.btn-danger:hover:not\(:disabled\)/);
});

test("tokens.css exposes control geometry and focus/disabled semantic tokens", async () => {
  const css = await read("src/desktop/renderer/styles/tokens.css");
  for (const token of [
    "--size-icon:",
    "--size-control:",
    "--size-control-compact:",
    "--size-tab-close:",
    "--size-tree-row:",
    "--size-section-head:",
    "--control-pad-x:",
    "--font-weight-ui:",
    "--font-weight-strong:",
    "--focus-ring:",
    "--control-disabled-opacity:",
    "--radius-sm:",
  ]) {
    assert.ok(css.includes(token), `missing token ${token}`);
  }
});

test("document / tree / inspector / layout CSS keep Discoverable Tab close and PaneCollapse", async () => {
  const documentCss = await read("src/desktop/renderer/styles/document.css");
  const treeCss = await read("src/desktop/renderer/styles/tree.css");
  const inspectorCss = await read("src/desktop/renderer/styles/inspector.css");
  const layoutCss = await read("src/desktop/renderer/styles/layout.css");

  assert.match(documentCss, /\.tab-close\b/);
  assert.match(documentCss, /opacity:\s*0\.72/);
  assert.match(documentCss, /var\(--size-tab-close\)/);
  assert.match(documentCss, /\.tab-close:focus-visible/);
  assert.match(documentCss, /\.tab-close:hover/);
  assert.match(documentCss, /\.tab-close:active/);

  assert.match(treeCss, /\.tree-node\b/);
  assert.match(treeCss, /var\(--size-tree-row\)/);
  assert.match(treeCss, /\.tree-node:hover/);
  assert.match(treeCss, /\.tree-node:active/);
  assert.match(treeCss, /\.tree-node:focus-visible/);
  assert.match(treeCss, /\.tree-node\.active/);

  assert.match(inspectorCss, /\.insp-summary\b/);
  assert.match(inspectorCss, /var\(--size-section-head\)/);
  assert.match(inspectorCss, /\.insp-summary:focus-visible/);

  assert.match(layoutCss, /\.collapse-edge\b/);
  assert.match(layoutCss, /\.rail-toggle\b/);
  assert.match(layoutCss, /opacity:\s*0\.72/);
  assert.match(layoutCss, /is-left-collapsed/);
  assert.match(layoutCss, /is-right-collapsed/);
  assert.match(layoutCss, /#btn-expand-left/);
  assert.match(layoutCss, /#btn-expand-right/);
});

test("index.html wires left-click collapse/expand controls with labels", async () => {
  const html = await read("src/desktop/renderer/index.html");
  assert.match(html, /id="btn-collapse-left"[^>]*aria-label="收起左侧栏"/);
  assert.match(html, /id="btn-collapse-right"[^>]*aria-label="收起右侧栏"/);
  assert.match(html, /id="btn-expand-left"[^>]*aria-label="展开左侧栏"/);
  assert.match(html, /id="btn-expand-right"[^>]*aria-label="展开右侧栏"/);
  assert.match(html, /class="icon-btn collapse-edge"/);
  assert.match(html, /class="icon-btn rail-toggle"/);
  assert.match(html, /class="insp-section"/);
  assert.match(html, /class="insp-summary"/);
  // No false claims in chrome copy for this round's left-click scope.
  assert.doesNotMatch(html, /中键关闭|Ctrl\+W 关闭|快捷键关闭/);
});

test("document.ts left-click close path uses documentTabHtml and data-close-tab", async () => {
  const documentTs = await read("src/desktop/renderer/main/document.ts");
  const layoutTs = await read("src/desktop/renderer/main/layout.ts");
  assert.match(documentTs, /documentTabHtml/);
  assert.match(documentTs, /from "\.\/ui\.js"/);
  assert.match(documentTs, /data-close-tab/);
  assert.match(documentTs, /closeTab/);
  // Primary close affordance is left-click on .tab-close (click handler).
  assert.match(documentTs, /el\.tabs\.addEventListener\("click"/);
  assert.match(layoutTs, /btnCollapseLeft/);
  assert.match(layoutTs, /btnExpandLeft/);
  assert.match(layoutTs, /btnCollapseRight/);
  assert.match(layoutTs, /btnExpandRight/);
  assert.match(layoutTs, /toggleCollapsed/);
  assert.match(layoutTs, /addEventListener\("click"/);
});

test("tree.ts uses treeRowClass contract for row markup", async () => {
  const treeTs = await read("src/desktop/renderer/main/tree.ts");
  assert.match(treeTs, /treeRowClass/);
  assert.match(treeTs, /from "\.\/ui\.js"/);
  assert.match(treeTs, /UI\.treeName|UI\.treeMeta/);
  assert.match(treeTs, /data-open/);
});

test("layered styles entry still imports all parts including tokens/primitives", async () => {
  const entry = await fs.readFile(path.join(renderer, "styles.css"), "utf8");
  for (const part of ["tokens", "primitives", "layout", "tree", "document", "inspector", "surfaces"]) {
    assert.match(entry, new RegExp(`@import\\s+"\\./styles/${part}\\.css"`));
  }
});
