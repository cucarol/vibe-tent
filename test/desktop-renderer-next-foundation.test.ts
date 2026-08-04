/**
 * Next renderer foundation: identity, intents, gateway invalidation, surfaces, tokens.
 * Pure tests — no Electron, no React DOM render.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import {
  APP_SURFACE_IDS,
  APP_SURFACES,
  OUTLINE_PANEL_ID,
  OUTLINE_TOGGLE_ID,
  PlaceholderCanvasEngine,
  ServiceGateway,
  closeOutline,
  createDefaultOutlineChrome,
  createEmptyCanvasDocument,
  defaultAppSurface,
  focusWorkbenchNode,
  initializeWorkbenchSelection,
  invalidationFromEvent,
  isAppSurfaceId,
  isLayoutIntent,
  isLifecycleIntent,
  isOutlineOpen,
  isReversibleDomainIntent,
  listPlacementIds,
  locateOutlineEntity,
  openOutline,
  placementEntityRef,
  placeEntityInVisibleViewport,
  removeEntityFromCanvas,
  setOutlineExpanded,
  toggleOutline,
  toggleOutlineExpanded,
  undoPolicyOf,
  type UiIntent,
} from "../src/desktop/renderer-next/index.js";
import type { EventEnvelope } from "../src/service/types.js";
import {
  canCreateNodePlacement,
  selectPresentationNode,
  withPresentationDocument,
  type WorkbenchPresentationState,
} from "../src/desktop/renderer-next/shell/workbench-presentation.js";

const root = process.cwd();
const nextRoot = path.join(root, "src/desktop/renderer-next");

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), "utf8");
}

function ev(type: string): EventEnvelope {
  return {
    id: "e1",
    type,
    workspaceId: "ws-1",
    ts: new Date().toISOString(),
    source: "service",
    payload: { shouldNotBecomeTruth: true },
  };
}

test("Outline and Canvas share one focused placement fact", () => {
  const document = {
    ...createEmptyCanvasDocument(),
    focusedPlacementId: "pl-prompt",
    placements: [
      { placementId: "pl-prompt", entityRef: "cx-prompt", kind: "node", x: 0, y: 0 },
      { placementId: "pl-output", entityRef: "cx-output", kind: "node", x: 200, y: 0 },
      { placementId: "pl-output-copy", entityRef: "cx-output", kind: "node", x: 400, y: 0 },
    ],
  };
  assert.equal(focusWorkbenchNode(document, "cx-output").focusedPlacementId, "pl-output");
  assert.equal(
    focusWorkbenchNode(document, "cx-output", "pl-output-copy").focusedPlacementId,
    "pl-output-copy"
  );
  assert.equal(focusWorkbenchNode(document, "cx-not-on-canvas").focusedPlacementId, null);
});

test("initial workbench selection cannot split shell and Canvas focus", () => {
  const document = {
    ...createEmptyCanvasDocument(),
    focusedPlacementId: "pl-prompt",
    placements: [
      { placementId: "pl-prompt", entityRef: "cx-prompt", kind: "node" },
      { placementId: "pl-output", entityRef: "cx-output", kind: "node" },
    ],
  };
  const requested = initializeWorkbenchSelection(document, "cx-output");
  assert.equal(requested.selectedNodeId, "cx-output");
  assert.equal(requested.document.focusedPlacementId, "pl-output");

  const inherited = initializeWorkbenchSelection(document, null);
  assert.equal(inherited.selectedNodeId, "cx-prompt");
  assert.equal(inherited.document.focusedPlacementId, "pl-prompt");
});

test("placement add is visible, focused, idempotent, and local removal preserves Node identity", () => {
  const empty = {
    ...createEmptyCanvasDocument(),
    viewport: { x: 240, y: -60, zoom: 1.5 },
  };
  const first = placeEntityInVisibleViewport(empty, "cx-unplaced", () => "pl-new");
  assert.equal(first.added, true);
  assert.equal(first.placementId, "pl-new");
  assert.equal(first.document.focusedPlacementId, "pl-new");
  assert.equal(first.document.placements.length, 1);
  assert.deepEqual(first.document.placements[0], {
    placementId: "pl-new",
    entityRef: "cx-unplaced",
    kind: "node",
    x: -96,
    y: 140,
    width: 264,
    height: 138,
  });

  const repeated = placeEntityInVisibleViewport(first.document, "cx-unplaced", () => "pl-wrong");
  assert.equal(repeated.added, false);
  assert.equal(repeated.placementId, "pl-new");
  assert.equal(repeated.document.placements.length, 1);

  const removed = removeEntityFromCanvas(repeated.document, "cx-unplaced");
  assert.deepEqual(removed.placements, []);
  assert.equal(removed.focusedPlacementId, null);
  assert.deepEqual(removed.viewport, empty.viewport);
});

test("controlled presentation sequences Canvas removal before selection without reviving stale placements", () => {
  let state: WorkbenchPresentationState = {
    selectedNodeId: "cx-a",
    document: {
      ...createEmptyCanvasDocument(),
      focusedPlacementId: "pl-a",
      placements: [{ placementId: "pl-a", entityRef: "cx-a", kind: "node" }],
    },
  };
  const publish = (
    update: (current: WorkbenchPresentationState) => WorkbenchPresentationState
  ) => {
    state = update(state);
  };
  publish((current) =>
    withPresentationDocument(current, removeEntityFromCanvas(current.document, "cx-a"))
  );
  publish((current) => selectPresentationNode(current, null, null));
  assert.deepEqual(state.document.placements, []);
  assert.equal(state.document.focusedPlacementId, null);
  assert.equal(state.selectedNodeId, null);
});

test("placement creation is permitted only by fresh authoritative graph identity", () => {
  assert.equal(canCreateNodePlacement("fresh", "ready"), true);
  for (const state of ["loading", "stale", "unresolved", "error", "unmounted"] as const) {
    assert.equal(canCreateNodePlacement(state, "ready"), false, state);
  }
  for (const state of ["loading", "stale", "unresolved", "error"] as const) {
    assert.equal(canCreateNodePlacement("fresh", state), false, state);
  }
});

test("new placements choose a visible free slot instead of stacking on existing cards", () => {
  const document = {
    ...createEmptyCanvasDocument(),
    viewport: { x: 0, y: 0, zoom: 1 },
    placements: [
      { placementId: "pl-a", entityRef: "cx-a", kind: "node", x: 96, y: 150, width: 264, height: 138 },
      { placementId: "pl-b", entityRef: "cx-b", kind: "node", x: 392, y: 150, width: 264, height: 138 },
    ],
  };
  const placed = placeEntityInVisibleViewport(document, "cx-c", () => "pl-c");
  assert.equal(placed.document.placements[2]?.x, 96);
  assert.equal(placed.document.placements[2]?.y, 320);
});

test("placement slot search grows beyond twelve occupied candidates", () => {
  const placements = Array.from({ length: 14 }, (_, slot) => ({
    placementId: `pl-${slot}`,
    entityRef: `cx-${slot}`,
    kind: "node",
    x: 96 + (slot % 2) * 296,
    y: 150 + Math.floor(slot / 2) * 170,
    width: 264,
    height: 138,
  }));
  const placed = placeEntityInVisibleViewport({
    ...createEmptyCanvasDocument(),
    viewport: { x: 0, y: 0, zoom: 1 },
    placements,
  }, "cx-late", () => "pl-late");
  assert.equal(placed.document.placements[14]?.x, 96);
  assert.equal(placed.document.placements[14]?.y, 1340);
});

test("entityRef and placementId stay separate on CanvasDocument", () => {
  const doc = createEmptyCanvasDocument();
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.placements, []);

  const withPlacement = {
    ...doc,
    placements: [
      {
        placementId: "pl-1",
        entityRef: "cx-abc",
        kind: "node",
        x: 10,
        y: 20,
      },
      {
        placementId: "pl-2",
        // same entity may appear as another placement later — ids remain distinct
        entityRef: "cx-abc",
        kind: "node-alias",
      },
      {
        placementId: "pl-orphan",
        kind: "note-stub",
        // no entityRef — pure local chrome placement
      },
    ],
  };

  assert.deepEqual(listPlacementIds(withPlacement), [
    "pl-1",
    "pl-2",
    "pl-orphan",
  ]);
  assert.equal(placementEntityRef(withPlacement, "pl-1"), "cx-abc");
  assert.equal(placementEntityRef(withPlacement, "pl-orphan"), undefined);
  assert.notEqual(
    withPlacement.placements[0]!.placementId,
    withPlacement.placements[0]!.entityRef
  );
});

test("UiIntent undoPolicy splits layout / reversible-domain / lifecycle", () => {
  const layout: UiIntent = {
    type: "canvas.pan",
    undoPolicy: "layout",
    payload: { dx: 1 },
  };
  const rev: UiIntent = {
    type: "docs.write",
    undoPolicy: "reversible-domain",
  };
  const life: UiIntent = {
    type: "task.accept",
    undoPolicy: "lifecycle",
  };

  assert.equal(isLayoutIntent(layout), true);
  assert.equal(isReversibleDomainIntent(rev), true);
  assert.equal(isLifecycleIntent(life), true);
  assert.equal(undoPolicyOf(layout), "layout");
  assert.equal(undoPolicyOf(rev), "reversible-domain");
  assert.equal(undoPolicyOf(life), "lifecycle");
  assert.equal(isLifecycleIntent(layout), false);
  assert.equal(isLayoutIntent(life), false);
});

test("ServiceGateway treats events as invalidation only", async () => {
  const gateway = new ServiceGateway();

  const hints: string[] = [];
  gateway.onInvalidation((h) => hints.push(h.reason ?? ""));

  const hint = gateway.handleServiceEvent(ev("task.state"));
  assert.ok(hint.keys.includes("task.list"));
  assert.ok(hint.keys.includes("node.collaboration"));
  assert.ok(hint.keys.includes("node.collaborations"));
  // Payload is notification-only; the gateway owns no opaque projection bags.
  assert.ok(hints.includes("task.state"));

  const conceptHint = invalidationFromEvent(ev("node.changed"));
  assert.ok(conceptHint.keys.includes("docs.tree"));
});

test("layout intents never require Service dispatch handler", async () => {
  const gateway = new ServiceGateway();
  await assert.doesNotReject(async () =>
    gateway.dispatch({ type: "canvas.pan", undoPolicy: "layout" })
  );
  await assert.rejects(
    async () =>
      gateway.dispatch({ type: "task.accept", undoPolicy: "lifecycle" }),
    /no dispatchIntent/
  );
});

test("CanvasEngine placeholder keeps document and separates focus placement", () => {
  const engine = new PlaceholderCanvasEngine();
  const doc = createEmptyCanvasDocument();
  const container = {
    replaceChildren() {},
    appendChild() {
      return null as unknown as Node;
    },
  } as unknown as HTMLElement;

  // mount needs real DOM in browser; unit path only uses setDocument/focus APIs
  engine.setDocument({
    ...doc,
    placements: [{ placementId: "pl-a", entityRef: "cx-1", kind: "node" }],
  });
  engine.focusPlacement("pl-a");
  assert.equal(engine.getDocument().focusedPlacementId, "pl-a");
  assert.equal(engine.id, "placeholder");
  // silence unused in non-DOM env
  assert.ok(container);
});

test("batch-1 production shell exposes Canvas as the sole stage", () => {
  assert.equal(defaultAppSurface(), "canvas");
  assert.equal(isAppSurfaceId("canvas"), true);
  assert.deepEqual(APP_SURFACE_IDS, ["canvas"]);
  assert.equal(isAppSurfaceId("workbench"), false);
  assert.equal(isAppSurfaceId("settings"), false);
  assert.ok(APP_SURFACES.some((s) => s.id === "canvas" && s.defaultStage));
});

test("renderer-next source tree is split and avoids forbidden deps", async () => {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else files.push(p);
    }
  }
  await walk(nextRoot);

  const rel = files.map((f) => path.relative(nextRoot, f).replace(/\\/g, "/"));
  for (const need of [
    "main.tsx",
    "App.tsx",
    "shell/AppShell.tsx",
    "shell/Outline.tsx",
    "shell/SurfaceStage.tsx",
    "surfaces/CanvasSurface.tsx",
    "surfaces/FocusWorkspaceSurface.tsx",
    "surfaces/InboxSurface.tsx",
    "surfaces/SearchSurface.tsx",
    "surfaces/SettingsSurface.tsx",
    "surfaces/ActivitySurface.tsx",
    "gateway/service-gateway.ts",
    "canvas/engine.ts",
    "types/identity.ts",
    "types/intent.ts",
    "types/outline.ts",
    "types/surfaces.ts",
    "styles/tokens.css",
    "styles/shell.css",
    "index.html",
  ]) {
    assert.ok(rel.includes(need), `missing ${need}`);
  }

  // Foundation must not be a single mega-file.
  assert.ok(rel.length >= 15);

  const allSrc = (
    await Promise.all(
      files
        .filter((f) => /\.(ts|tsx|css|html)$/.test(f))
        .map((f) => fs.readFile(f, "utf8"))
    )
  ).join("\n");

  assert.doesNotMatch(allSrc, /@antv\/x6|from ["']x6["']/i);
  assert.doesNotMatch(allSrc, /tailwind/i);
  assert.doesNotMatch(allSrc, /from ["']zustand["']|from ["']redux["']|@reduxjs/i);
  assert.doesNotMatch(allSrc, /from ["']@mui\/|from ["']antd["']/i);
  // Product copy must not claim Outline is a permanent always-on column.
  assert.doesNotMatch(allSrc, /always[- ]?on/i);
  assert.doesNotMatch(allSrc, /always reachable/i);
});

test("tokens.css has one product palette and one primitive entry", async () => {
  const css = await read("src/desktop/renderer-next/styles/tokens.css");
  assert.match(css, /product-tokens\.css/);
  assert.match(css, /ui\/primitives\.css/);
  const product = await read("src/desktop/renderer-next/styles/product-tokens.css");
  for (const token of [
    "--tn-color-app-bg:",
    "--tn-color-text-primary:",
    "--tn-color-accent:",
    "--tn-layout-outline-width:",
    "--tn-space-1:",
    "--tn-size-control:",
    "--tn-focus-ring:",
    "--tn-font-ui:",
  ]) {
    assert.ok(product.includes(token), `missing ${token}`);
  }
  assert.match(product, /--tn-color-accent:\s*#b85235/);
  assert.doesNotMatch(product, /data-theme|theme-id|dark/i);
});

test("Desktop loads renderer-next without exposing Electron as the CLI package main", async () => {
  const windows = await read("src/desktop/main/windows.ts");
  assert.match(
    windows,
    /mainHtml: path\.join\(appRoot, "desktop", "dist", "renderer-next", "index\.html"\)/
  );

  const packageJson = JSON.parse(await read("package.json")) as { main?: string };
  assert.equal(packageJson.main, undefined);
  const desktopPackageJson = JSON.parse(await read("desktop/package.json")) as {
    main: string;
  };
  assert.equal(desktopPackageJson.main, "dist/main/index.cjs");
});

test("production invalidation is immediate and provenance is selected-output only", async () => {
  const main = await read("src/desktop/main/index.ts");
  const eventSend = main.indexOf("DESKTOP_IPC.onServiceEvent");
  const shellRefresh = main.indexOf("refreshDesktopShellForEvent(model, ev.type)", eventSend);
  assert.ok(eventSend >= 0 && shellRefresh > eventSend);
  assert.match(main, /\.catch\(\(error\) =>/);

  const production = await read("src/desktop/renderer-next/ProductionApp.tsx");
  assert.match(production, /selected\?\.type !== "output"/);
  assert.match(production, /gateway\.outputProvenance\(workspace\.workspaceId, selectedNodeId\)/);
  assert.doesNotMatch(production, /outputs\.map|provenanceRows|Promise\.all\([\s\S]*outputProvenance/);
});

test("ADR documents foundation boundary", async () => {
  const adr = await read("docs/desktop/adr-renderer-next-foundation.md");
  assert.match(adr, /Service is the sole fact/);
  assert.match(adr, /entityRef/);
  assert.match(adr, /placementId/);
  assert.match(adr, /renderer-next/);
  assert.match(adr, /production entry/i);
  assert.match(adr, /drawer\/overlay|default-collapsed/i);
  assert.doesNotMatch(adr, /always-on|always reachable/i);
});

test("Outline chrome defaults collapsed with open/expand/locate interfaces", () => {
  const initial = createDefaultOutlineChrome();
  assert.equal(isOutlineOpen(initial), false);
  assert.deepEqual(initial.expandedIds, []);
  assert.equal(initial.currentEntityRef, null);

  const opened = openOutline(initial);
  assert.equal(isOutlineOpen(opened), true);
  assert.equal(isOutlineOpen(closeOutline(opened)), false);

  const toggled = toggleOutline(initial);
  assert.equal(toggled.open, true);
  assert.equal(toggleOutline(toggled).open, false);

  const expanded = setOutlineExpanded(initial, "node-a", true);
  assert.deepEqual(expanded.expandedIds, ["node-a"]);
  assert.deepEqual(
    toggleOutlineExpanded(expanded, "node-a").expandedIds,
    []
  );

  const located = locateOutlineEntity(initial, "cx-demo");
  assert.equal(located.open, true);
  assert.equal(located.currentEntityRef, "cx-demo");
  // Locate does not invent tree nodes — only points chrome at an entityRef.
  assert.deepEqual(located.expandedIds, []);
});

test("Outline and Focus are collapsible trays around one Canvas stage", async () => {
  const shellCss = await read("src/desktop/renderer-next/styles/shell.css");
  assert.match(shellCss, /\.tn-workbench\s*\{[^}]*grid-template-columns:\s*252px minmax\(0, 1fr\) 320px/s);
  assert.match(shellCss, /data-outline-open="false"/);
  assert.match(shellCss, /data-focus-open="false"/);
  assert.match(shellCss, /data-immersive="true"/);

  const shell = await read("src/desktop/renderer-next/shell/AppShell.tsx");
  assert.match(shell, /aria-pressed=\{outlineOpen\}/);
  assert.match(shell, /aria-pressed=\{focusOpen\}/);
  assert.match(shell, /CanvasWorkbench/);
  assert.doesNotMatch(shell, /SettingsSurface|InboxSurface|SearchSurface/);
  assert.equal(OUTLINE_PANEL_ID, "tn-outline-panel");
  assert.equal(OUTLINE_TOGGLE_ID, "tn-outline-toggle");
});

test("React stays a desktop devDependency, not a published runtime dep", async () => {
  const pkg = JSON.parse(await read("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.react, undefined);
  assert.equal(pkg.dependencies?.["react-dom"], undefined);
  assert.ok(pkg.devDependencies?.react);
  assert.ok(pkg.devDependencies?.["react-dom"]);
  assert.ok(pkg.devDependencies?.["@types/react"]);
  assert.ok(pkg.devDependencies?.["@types/react-dom"]);
});

test("renderer-next build target forces production React + minify", async () => {
  const build = await read("scripts/build-desktop.mjs");
  assert.match(build, /renderer-next/);
  assert.match(build, /minify:\s*true/);
  assert.match(build, /process\.env\.NODE_ENV.*production/);
  // Guard against regressing to a dual-effect-less remount-on-every-document path
  // only in the committed source; dist is rebuilt by build:desktop.
  const canvasSrc = await read(
    "src/desktop/renderer-next/surfaces/CanvasSurface.tsx"
  );
  assert.match(canvasSrc, /engine\.setDocument\(document\)/);
  assert.match(canvasSrc, /}, \[engine\]\);/);
});

test("tracked renderer-next dist is production React (no development build)", async () => {
  const distPath = path.join(root, "desktop/dist/renderer-next/main.js");
  const exists = await fs
    .access(distPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    // Full check runs build:desktop first; pure unit runs may skip dist.
    return;
  }
  const dist = await fs.readFile(distPath, "utf8");
  assert.doesNotMatch(dist, /react-dom\.development\.js/);
  assert.doesNotMatch(dist, /react\.development\.js/);
  // Production React still identifies itself; development path must be absent.
  assert.ok(dist.length > 0);
});
