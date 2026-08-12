import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DESKTOP_IPC } from "../src/desktop/types.js";
import { DESKTOP_PROJECTION_METHODS, isDesktopProjectionMethod } from "../src/desktop/projection-ipc.js";

test("workspace Inbox is supplied only by workspace.collaboration", async () => {
  assert.deepEqual(DESKTOP_PROJECTION_METHODS, ["graph.projection", "workspace.collaboration", "output.provenance"]);
  assert.equal(isDesktopProjectionMethod("interaction.listPending"), false);
  assert.equal("listPendingInteractions" in DESKTOP_IPC, false);
  const production = await readFile(new URL("../src/desktop/renderer-next/ProductionApp.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(production, /useInboxController|pendingInteractions|listPendingInteractions|nodeCollaborations/);
  assert.match(production, /useCollaborationSurface/);
});

test("preload exposes no independent pending-interaction channel", async () => {
  const preload = await readFile(new URL("../src/desktop/preload/preload.ts", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/desktop/main/ipc.ts", import.meta.url), "utf8");
  assert.doesNotMatch(preload, /listPendingInteractions|list-pending-interactions/);
  assert.doesNotMatch(main, /handleDesktopInboxRequest|listPendingInteractions/);
});
