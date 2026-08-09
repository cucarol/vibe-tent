import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CanvasV5LocalPersistence,
  commitCanvasV5DocumentSync,
  canvasV5LocalPersistenceKey,
  shouldSeedLocalCanvas,
  type CanvasV5LocalSnapshot,
} from "../src/desktop/renderer-next/model/canvas-v5-local-persistence.js";
import {
  NODE_CARD,
  placeEntityInVisibleViewport,
  removeEntityFromCanvas,
} from "../src/desktop/renderer-next/model/canvas-document.js";
import { normalizeCanvasWorkspaceSession } from "../src/desktop/renderer-next/model/canvas-session-store.js";
import {
  CANVAS_SUBTREE_META_KEY,
  canvasDocumentAuthorityDigest,
  createCanvasSubtreeProjectionInstance,
  readCanvasSubtreePlacementMeta,
  type CanvasSubtreeNodeSource,
} from "../src/desktop/renderer-next/model/canvas-subtree-projection.js";
import { captureCanvasNodeSnapshot } from "../src/desktop/renderer-next/model/canvas-node-snapshot.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  raw(key: string, value: string): void {
    this.values.set(key, value);
  }

  peek(key: string): string | null {
    return this.values.get(key) ?? null;
  }
}

function snapshot(workspaceId = "ws-alpha"): CanvasV5LocalSnapshot {
  return {
    version: 1,
    workspaceId,
    document: {
      version: 1,
      backgroundMode: "blank",
      focusedPlacementId: "pl-1",
      viewport: { x: 42, y: -10, zoom: 1.25 },
      placements: [
        {
          placementId: "pl-1",
          entityRef: "cx-1",
          kind: "node",
          x: 100,
          y: 200,
          width: NODE_CARD.width,
          height: NODE_CARD.height,
          meta: { presentation: "expanded" },
        },
        {
          placementId: "pl-local",
          kind: "note-stub",
          x: 420,
          y: 80,
          width: 311,
          height: 177,
        },
      ],
    },
    scene: {
      elements: [{ id: "stroke-1", type: "freedraw", points: [[0, 0], [4, 5]] }],
      appState: { gridModeEnabled: false },
      files: { image: { id: "image", dataURL: "data:image/png;base64,AA" } },
      layerVisible: false,
    },
  };
}

test("V5 local persistence round-trips document and freehand scene after reload", () => {
  const storage = new MemoryStorage();
  const writer = new CanvasV5LocalPersistence(storage, "ws-alpha");
  const pending = writer.beginSave(snapshot());
  assert.equal(pending.kind, "pending");
  assert.equal(pending.status.kind, "pending");
  assert.equal(pending.commit().kind, "saved");

  const reader = new CanvasV5LocalPersistence(storage, "ws-alpha");
  const loaded = reader.load();
  assert.equal(loaded.kind, "loaded");
  assert.deepEqual(loaded.snapshot, snapshot());
});

test("V5 local persistence retains subtree identity and collapsed branches exactly", () => {
  const storage = new MemoryStorage();
  const persistence = new CanvasV5LocalPersistence(storage, "ws-alpha");
  const base = snapshot();
  const subtreeMeta = {
    version: 1,
    instanceId: "subtree-a",
    rootPlacementId: "pl-1",
    parentPlacementId: null,
    depth: 0,
    siblingOrder: 0,
    expandedDirection: null,
    lastDirection: "left",
  } as const;
  const document = {
    ...base.document,
    placements: base.document.placements.map((placement) => placement.placementId === "pl-1"
      ? {
        ...placement,
        meta: {
          ...(placement.meta ?? {}),
          [CANVAS_SUBTREE_META_KEY]: subtreeMeta,
        },
      }
      : placement),
  };

  assert.equal(persistence.save({ ...base, document }).kind, "saved");
  const reloaded = persistence.load();
  assert.equal(reloaded.kind, "loaded");
  const root = reloaded.snapshot.document.placements.find(
    (placement) => placement.placementId === "pl-1"
  );
  assert.deepEqual(root ? readCanvasSubtreePlacementMeta(root) : null, subtreeMeta);
});

test("persisted legacy grid state is hard-cut to the pure white Canvas", () => {
  const storage = new MemoryStorage();
  const legacy = snapshot();
  storage.raw(
    canvasV5LocalPersistenceKey("ws-alpha"),
    JSON.stringify({
      ...legacy,
      document: { ...legacy.document, backgroundMode: "grid" },
    })
  );
  const persistence = new CanvasV5LocalPersistence(storage, "ws-alpha");
  const loaded = persistence.load();
  assert.equal(loaded.kind, "loaded");
  assert.equal(loaded.snapshot.document.backgroundMode, "blank");
  assert.equal(persistence.save(loaded.snapshot).kind, "saved");
  assert.equal(
    JSON.parse(storage.peek(canvasV5LocalPersistenceKey("ws-alpha"))!).document.backgroundMode,
    "blank"
  );
});

test("V5 persistence normalizes legacy Node geometry on read and save only", () => {
  const storage = new MemoryStorage();
  const persistence = new CanvasV5LocalPersistence(storage, "ws-alpha");
  const legacy = snapshot();
  const legacyDocument = {
    ...legacy.document,
    placements: legacy.document.placements.map((placement) =>
      placement.kind === "node"
        ? { ...placement, width: 420, height: 280 }
        : placement
    ),
  };
  storage.raw(
    canvasV5LocalPersistenceKey("ws-alpha"),
    JSON.stringify({ ...legacy, document: legacyDocument })
  );

  const loaded = persistence.load();
  assert.equal(loaded.kind, "loaded");
  assert.equal(loaded.snapshot.document.placements[0]?.width, NODE_CARD.width);
  assert.equal(loaded.snapshot.document.placements[0]?.height, NODE_CARD.height);
  assert.equal(loaded.snapshot.document.placements[1]?.width, 311);
  assert.equal(loaded.snapshot.document.placements[1]?.height, 177);

  const saveCandidate = {
    ...loaded.snapshot,
    document: {
      ...loaded.snapshot.document,
      placements: loaded.snapshot.document.placements.map((placement) =>
        placement.kind === "node"
          ? { ...placement, width: 512, height: 256 }
          : placement
      ),
    },
  };
  assert.equal(persistence.save(saveCandidate).kind, "saved");
  const persisted = JSON.parse(
    storage.peek(canvasV5LocalPersistenceKey("ws-alpha"))!
  ) as CanvasV5LocalSnapshot;
  assert.equal(persisted.document.placements[0]?.width, NODE_CARD.width);
  assert.equal(persisted.document.placements[0]?.height, NODE_CARD.height);
  assert.equal(persisted.document.placements[1]?.width, 311);
  assert.equal(persisted.document.placements[1]?.height, 177);
});

test("legacy tab-session documents cannot preserve a hidden grid preference", () => {
  const normalized = normalizeCanvasWorkspaceSession("ws-alpha", {
    version: 1,
    workspaceId: "ws-alpha",
    tabs: {
      activeId: "tab-1",
      order: ["tab-1"],
      byId: {
        "tab-1": {
          id: "tab-1",
          title: "Canvas",
          document: {
            version: 1,
            backgroundMode: "grid",
            focusedPlacementId: null,
            placements: [{
              placementId: "pl-node",
              entityRef: "cx-node",
              kind: "node",
              width: 420,
              height: 280,
              meta: { presentation: "expanded", retained: "yes" },
            }, {
              placementId: "pl-local",
              kind: "note-stub",
              width: 420,
              height: 280,
            }],
          },
        },
      },
    },
    edgeLayers: {},
  });
  assert.equal(normalized.tabs.byId["tab-1"]?.document.backgroundMode, "blank");
  const normalizedPlacement = normalized.tabs.byId["tab-1"]?.document.placements[0];
  assert.equal(normalizedPlacement?.width, NODE_CARD.width);
  assert.equal(normalizedPlacement?.height, NODE_CARD.height);
  assert.deepEqual(normalizedPlacement?.meta, { retained: "yes" });
  assert.equal(normalized.tabs.byId["tab-1"]?.document.placements[1]?.width, 420);
  assert.equal(normalized.tabs.byId["tab-1"]?.document.placements[1]?.height, 280);
});

test("exact workspace key prevents Canvas document and scene leaking across workspaces", () => {
  const storage = new MemoryStorage();
  const alpha = new CanvasV5LocalPersistence(storage, "ws-alpha");
  assert.equal(alpha.save(snapshot()).kind, "saved");

  const beta = new CanvasV5LocalPersistence(storage, "ws-beta");
  const betaLoad = beta.load();
  assert.equal(betaLoad.kind, "empty");
  assert.equal(betaLoad.snapshot.workspaceId, "ws-beta");
  assert.deepEqual(betaLoad.snapshot.document.placements, []);
  assert.equal(betaLoad.snapshot.scene, null);
  assert.notEqual(canvasV5LocalPersistenceKey("ws-alpha"), canvasV5LocalPersistenceKey("ws-beta"));
});

test("placement add and intentional empty removal both survive reload", () => {
  const storage = new MemoryStorage();
  const persistence = new CanvasV5LocalPersistence(storage, "ws-alpha");
  const base = {
    ...snapshot(),
    document: {
      ...snapshot().document,
      focusedPlacementId: null,
      placements: [],
    },
  };
  const placed = placeEntityInVisibleViewport(base.document, "cx-added", () => "pl-added");
  assert.equal(
    persistence.save({ ...base, document: placed.document }).kind,
    "saved"
  );
  const reloadedPlaced = persistence.load();
  assert.equal(reloadedPlaced.kind, "loaded");
  assert.deepEqual(
    reloadedPlaced.snapshot.document.placements.map((placement) => placement.entityRef),
    ["cx-added"]
  );

  const empty = removeEntityFromCanvas(
    reloadedPlaced.snapshot.document,
    "cx-added"
  );
  assert.equal(persistence.save({ ...reloadedPlaced.snapshot, document: empty }).kind, "saved");
  const reloadedEmpty = persistence.load();
  assert.equal(reloadedEmpty.kind, "loaded", "saved empty Canvas remains intentional state");
  assert.deepEqual(reloadedEmpty.snapshot.document.placements, []);
  assert.equal(shouldSeedLocalCanvas(reloadedEmpty.kind, 0, 1), false);
});

test("malformed or wrong-workspace payload fails closed to an empty local scene", () => {
  const storage = new MemoryStorage();
  storage.raw(canvasV5LocalPersistenceKey("ws-alpha"), "{not json");
  const malformed = new CanvasV5LocalPersistence(storage, "ws-alpha").load();
  assert.equal(malformed.kind, "error");
  assert.equal(malformed.status.kind, "error");
  assert.deepEqual(malformed.snapshot.document.placements, []);
  assert.equal(malformed.snapshot.scene, null);

  storage.raw(
    canvasV5LocalPersistenceKey("ws-beta"),
    JSON.stringify(snapshot("ws-alpha"))
  );
  const mismatched = new CanvasV5LocalPersistence(storage, "ws-beta").load();
  assert.equal(mismatched.kind, "error");
  assert.equal(mismatched.snapshot.workspaceId, "ws-beta");
  assert.equal(mismatched.snapshot.scene, null);
});

test("storage failures retain a retry closure instead of claiming a save", () => {
  let shouldThrow = true;
  const storage = {
    getItem: () => null,
    setItem: () => {
      if (shouldThrow) throw new Error("quota exceeded");
    },
  };
  const persistence = new CanvasV5LocalPersistence(storage, "ws-alpha");
  const first = persistence.save(snapshot());
  assert.equal(first.kind, "error");
  assert.equal(first.status.kind, "quota");
  shouldThrow = false;
  assert.equal(first.retry().kind, "saved");
});

test("global Canvas sync publishes nothing when the complete local snapshot cannot persist", () => {
  const root = captureCanvasNodeSnapshot({
    nodeId: "cx-root", etag: "root-v1", name: "根", path: "根", type: "goal",
    tags: [], mode: "editable", archived: false, invalid: false,
  }) as CanvasSubtreeNodeSource["snapshot"];
  const originalSources: CanvasSubtreeNodeSource[] = [{ nodeId: "cx-root", parentNodeId: null, snapshot: root }];
  const created = createCanvasSubtreeProjectionInstance(
    { ...snapshot().document, placements: [], focusedPlacementId: null },
    "cx-root",
    originalSources,
    { x: 100, y: 120 }
  );
  const currentSnapshot = { ...snapshot(), document: created.document };
  const newerSources: CanvasSubtreeNodeSource[] = [{
    nodeId: "cx-root",
    parentNodeId: null,
    snapshot: { ...root, etag: "root-v2", title: "更新后的根" },
  }];
  const expectedDigest = canvasDocumentAuthorityDigest(created.document, newerSources)!;
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error("quota exceeded"); },
  };
  const result = commitCanvasV5DocumentSync(
    new CanvasV5LocalPersistence(storage, "ws-alpha"),
    currentSnapshot,
    expectedDigest,
    newerSources
  );
  assert.equal(result.committed, false);
  assert.equal(result.status?.kind, "quota");
  assert.equal(result.document, created.document, "failed persistence returns the exact original document");
});
