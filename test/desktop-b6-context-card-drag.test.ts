/**
 * Desktop B6 — Context Card Windows MVP drag.
 *
 * Proves:
 * - payload is stable contextCardToDragText (pointer + fixed prompt)
 * - renderer dragstart path sets only text/plain
 * - drag does not invoke clipboard
 * - IPC surface no longer exposes a fake startDrag/clipboard bridge
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import {
  boxContextCard,
  contextCardToDragText,
  parseContextCardText,
} from "../src/core/context-card.js";
import { DESKTOP_IPC } from "../src/desktop/types.js";
import {
  applyContextCardDragStart,
  bindContextCardDrag,
  copyContextCardText,
} from "../src/desktop/renderer/context-card-drag.js";

/** Minimal DataTransfer stand-in for Node tests (no browser DOM). */
function mockDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: "uninitialized" as string,
    setData(type: string, data: string) {
      store.set(type, data);
    },
    getData(type: string) {
      return store.get(type) ?? "";
    },
    clearData(type?: string) {
      if (type) store.delete(type);
      else store.clear();
    },
    types: {
      // used only for debugging in assertions via getData
    },
    _store: store,
  };
}

/** Minimal HTMLElement stand-in that records listeners. */
function mockElement() {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const el = {
    draggable: false,
    classList: {
      values: new Set<string>(),
      add(c: string) {
        this.values.add(c);
      },
      remove(c: string) {
        this.values.delete(c);
      },
      contains(c: string) {
        return this.values.has(c);
      },
    },
    attrs: new Map<string, string>(),
    setAttribute(name: string, value: string) {
      this.attrs.set(name, value);
    },
    getAttribute(name: string) {
      return this.attrs.get(name) ?? null;
    },
    addEventListener(type: string, handler: (ev: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    dispatch(type: string, ev: unknown) {
      for (const h of listeners.get(type) ?? []) h(ev);
    },
    _listeners: listeners,
  };
  return el;
}

test("contextCardToDragText payload is full v1 pointer prompt (no snapshot body)", () => {
  const card = boxContextCard("cx-b6-1", "inbox/goal", {
    label: "goal card",
    tentRootHint: "C:\\\\tents\\\\demo",
  });
  const text = contextCardToDragText(card);

  assert.equal(text, card.prompt);
  assert.match(text, /^Tent contextCard v1\n/);
  assert.match(text, /contextRef: box\/cx-b6-1/);
  assert.match(text, /path: inbox\/goal/);
  assert.match(text, /tentRoot: C:\\\\tents\\\\demo/);
  assert.match(text, /Read this entity via Tent Task API/);
  assert.match(text, /Do not invent missing content/);
  // Must not smuggle full document bodies / fallback snapshots
  assert.doesNotMatch(text, /snapshot|full body|BEGIN CONTENT|```/i);

  const parsed = parseContextCardText(text);
  assert.equal(parsed?.kind, "box");
  assert.equal(parsed?.id, "cx-b6-1");
  assert.equal(parsed?.path, "inbox/goal");
});

test("applyContextCardDragStart writes only text/plain with full payload", () => {
  const card = boxContextCard("cx-drag", "p/a");
  const text = contextCardToDragText(card);
  const dt = mockDataTransfer();

  applyContextCardDragStart(dt as unknown as DataTransfer, text);

  assert.equal(dt.getData("text/plain"), text);
  assert.equal(dt.effectAllowed, "copy");
  assert.equal(dt._store.size, 1);
  assert.ok(dt._store.has("text/plain"));
  assert.ok(!dt._store.has("text/uri-list"));
  assert.ok(!dt._store.has("Files"));
});

test("applyContextCardDragStart is a no-op when DataTransfer is missing", () => {
  assert.doesNotThrow(() => applyContextCardDragStart(null, "x"));
  assert.doesNotThrow(() => applyContextCardDragStart(undefined, "x"));
});

test("bindContextCardDrag: dragstart sets text/plain and never calls clipboard", () => {
  const text = contextCardToDragText(boxContextCard("cx-bind", "box/path", { label: "L" }));
  const el = mockElement();
  let clipboardCalls = 0;

  bindContextCardDrag(el as unknown as HTMLElement, text, {
    writeClipboard: async () => {
      clipboardCalls += 1;
    },
  });

  assert.equal(el.draggable, true);
  assert.match(el.getAttribute("title") ?? "", /拖/);

  const dt = mockDataTransfer();
  el.dispatch("dragstart", { dataTransfer: dt });
  assert.equal(dt.getData("text/plain"), text);
  assert.equal(dt.effectAllowed, "copy");
  assert.equal(clipboardCalls, 0, "drag must not write clipboard");
  assert.ok(el.classList.contains("is-dragging"));

  el.dispatch("dragend", {});
  assert.ok(!el.classList.contains("is-dragging"));
});

test("bindContextCardDrag: click may copy as auxiliary path only", async () => {
  const text = contextCardToDragText(boxContextCard("cx-click", "c"));
  const el = mockElement();
  const copied: string[] = [];

  bindContextCardDrag(el as unknown as HTMLElement, text, {
    writeClipboard: async (t) => {
      copied.push(t);
    },
    onCopied: (t) => {
      assert.equal(t, text);
    },
  });

  el.dispatch("click", {});
  // click handler is async; flush microtasks
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(copied, [text]);
});

test("copyContextCardText surfaces clipboard errors without throwing", async () => {
  const errs: unknown[] = [];
  await copyContextCardText("payload", {
    writeClipboard: async () => {
      throw new Error("denied");
    },
    onCopyError: (e) => errs.push(e),
  });
  assert.equal(errs.length, 1);
  assert.match(String((errs[0] as Error).message), /denied/);
});

test("DESKTOP_IPC has no startDrag / clipboard-drag channel", () => {
  const values = Object.values(DESKTOP_IPC) as string[];
  assert.ok(!("startDrag" in DESKTOP_IPC));
  assert.ok(!values.includes("tent:start-drag"));
  assert.ok(!values.some((v) => /drag/i.test(v)));
});

test("desktop sources: no clipboard startDrag IPC bridge remains", async () => {
  const root = path.resolve("src/desktop");
  const files = [
    "main/ipc.ts",
    "preload/preload.ts",
    "types.ts",
    "renderer/api-types.ts",
    "renderer/main-ui.ts",
    "renderer/float-ui.ts",
    "renderer/context-card-drag.ts",
  ];
  for (const rel of files) {
    const src = await fs.readFile(path.join(root, rel), "utf8");
    assert.doesNotMatch(
      src,
      /DESKTOP_IPC\.startDrag|tent:start-drag|startDrag:\s*\(/,
      `${rel} must not expose startDrag API`
    );
    // ipc must not clipboard-write under a drag name
    if (rel === "main/ipc.ts") {
      assert.doesNotMatch(src, /clipboard\.writeText/);
      assert.doesNotMatch(src, /ipcMain\.handle\([^)]*drag/i);
    }
  }

  // Renderer drag handlers must set text/plain via helper, not call any startDrag
  const mainUi = await fs.readFile(path.join(root, "renderer/main-ui.ts"), "utf8");
  const floatUi = await fs.readFile(path.join(root, "renderer/float-ui.ts"), "utf8");
  assert.match(mainUi, /bindContextCardDrag/);
  assert.match(floatUi, /bindContextCardDrag/);
  assert.doesNotMatch(mainUi, /startDrag/);
  assert.doesNotMatch(floatUi, /startDrag/);
});

test("Electron capability boundary note: startDrag is file-only (documented in helper)", async () => {
  const helper = await fs.readFile(
    path.resolve("src/desktop/renderer/context-card-drag.ts"),
    "utf8"
  );
  assert.match(helper, /startDrag/);
  assert.match(helper, /file-path only|file only|file-path/i);
  assert.match(helper, /text\/plain/);
  assert.match(helper, /clipboard/i);
});
