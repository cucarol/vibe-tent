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
  PlaceholderCanvasEngine,
  ServiceGateway,
  createEmptyCanvasDocument,
  defaultAppSurface,
  invalidationFromEvent,
  isAppSurfaceId,
  isLayoutIntent,
  isLifecycleIntent,
  isReversibleDomainIntent,
  listPlacementIds,
  placementEntityRef,
  undoPolicyOf,
  type UiIntent,
} from "../src/desktop/renderer-next/index.js";
import type { EventEnvelope } from "../src/service/types.js";

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
        kind: "box",
        x: 10,
        y: 20,
      },
      {
        placementId: "pl-2",
        // same entity may appear as another placement later — ids remain distinct
        entityRef: "cx-abc",
        kind: "box-alias",
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
  assert.equal(gateway.isDirty(), true);

  const hints: string[] = [];
  gateway.onInvalidation((h) => hints.push(h.reason ?? ""));

  const hint = gateway.handleServiceEvent(ev("task.state"));
  assert.ok(hint.keys.includes("task.list"));
  assert.ok(hint.keys.includes("box.projection"));
  // Payload must not be merged into projection bags.
  assert.deepEqual(gateway.getProjectionSnapshot().bags, {});
  assert.equal(gateway.isDirty("task.list"), true);

  await gateway.refresh(["task.list"]);
  // Without a fetch handler, bags stay empty — still not event payload.
  assert.deepEqual(gateway.getProjectionSnapshot().bags, {});
  assert.equal(gateway.isDirty("task.list"), false);
  assert.ok(hints.includes("task.state"));

  const conceptHint = invalidationFromEvent(ev("concept.changed"));
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
    placements: [{ placementId: "pl-a", entityRef: "cx-1", kind: "box" }],
  });
  engine.focusPlacement("pl-a");
  assert.equal(engine.getDocument().focusedPlacementId, "pl-a");
  assert.equal(engine.id, "placeholder");
  // silence unused in non-DOM env
  assert.ok(container);
});

test("app surfaces include Canvas-first set and default to canvas", () => {
  assert.equal(defaultAppSurface(), "canvas");
  for (const id of [
    "canvas",
    "focus-workspace",
    "inbox",
    "search",
    "settings",
    "activity",
  ] as const) {
    assert.equal(isAppSurfaceId(id), true);
    assert.ok(APP_SURFACE_IDS.includes(id));
  }
  assert.equal(isAppSurfaceId("workbench"), false);
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
});

test("tokens.css defines semantic structure without a locked brand hex palette", async () => {
  const css = await read("src/desktop/renderer-next/styles/tokens.css");
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
    assert.ok(css.includes(token), `missing ${token}`);
  }
  // No hard-coded brand hex lock-in for the foundation pass.
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
});

test("default Electron main HTML entry is still the legacy renderer", async () => {
  const windows = await read("src/desktop/main/windows.ts");
  assert.match(
    windows,
    /mainHtml: path\.join\(appRoot, "desktop", "dist", "renderer", "index\.html"\)/
  );
  assert.doesNotMatch(windows, /renderer-next/);

  const packageJson = JSON.parse(await read("package.json")) as {
    main: string;
  };
  assert.equal(packageJson.main, "desktop/dist/main/index.cjs");
});

test("ADR documents foundation boundary", async () => {
  const adr = await read("docs/desktop/adr-renderer-next-foundation.md");
  assert.match(adr, /Service is the sole fact/);
  assert.match(adr, /entityRef/);
  assert.match(adr, /placementId/);
  assert.match(adr, /renderer-next/);
  assert.match(adr, /default Electron entry/);
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
