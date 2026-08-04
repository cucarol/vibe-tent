import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CanvasV5LocalPersistence,
  canvasV5LocalPersistenceKey,
  shouldSeedLocalCanvas,
  type CanvasV5LocalSnapshot,
} from "../src/desktop/renderer-next/model/canvas-v5-local-persistence.js";
import {
  placeEntityInVisibleViewport,
  removeEntityFromCanvas,
} from "../src/desktop/renderer-next/model/canvas-document.js";

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
          width: 240,
          height: 96,
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
