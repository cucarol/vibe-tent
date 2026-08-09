import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, _electron as electronDriver } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "output", "playwright");
const storyTitle = "E2E/Production Canvas Interactions";
const storyPort = Number(process.env.TENT_E2E_STORYBOOK_PORT || 6107);
const storybookUrl = process.env.TENT_E2E_STORYBOOK_URL || `http://127.0.0.1:${storyPort}`;
const packageSmoke = process.argv.includes("--package-smoke");
const packagedOnly = process.argv.includes("--packaged-only");
const packageOutputOption = optionValue("--package-output");
if (packagedOnly && !packageSmoke) throw new Error("--packaged-only requires --package-smoke");
if (packageOutputOption && !packageSmoke) throw new Error("--package-output requires --package-smoke");
const deadlineMs = Number(process.env.TENT_E2E_DEADLINE_MS || (packageSmoke ? 600_000 : 180_000));
const runAbortController = new AbortController();
const runAbortSignal = runAbortController.signal;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function waitFor(check, label, timeout = 30_000, observeRunAbort = true) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    if (observeRunAbort) runAbortSignal.throwIfAborted();
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError}` : ""}`);
}

function browserExecutable() {
  const candidates = [
    process.env.TENT_E2E_BROWSER,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("No system Chrome or Edge executable found");
  return found;
}

function storybookEntry() {
  return path.join(root, "node_modules", "storybook", "dist", "bin", "dispatcher.js");
}

async function startStorybook() {
  if (process.env.TENT_E2E_STORYBOOK_URL) return null;
  const entry = storybookEntry();
  assert.ok(fs.existsSync(entry), `Storybook entry missing: ${entry}`);
  const child = spawn(process.execPath, [
    entry,
    "dev",
    "-p",
    String(storyPort),
    "--no-open",
    "--ci",
    "--exact-port",
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log = `${log}${chunk}`.slice(-16_000); });
  child.stderr.on("data", (chunk) => { log = `${log}${chunk}`.slice(-16_000); });
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Storybook exited ${child.exitCode}\n${log}`);
      const response = await fetch(`${storybookUrl}/index.json`);
      return response.ok;
    }, "isolated Storybook", 45_000);
    return child;
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(3_000),
  ]);
  if (child.exitCode === null && process.platform === "win32") {
    const info = await processInfo(child.pid);
    assert.ok(info, `Storybook PID disappeared before cleanup: ${child.pid}`);
    assert.match(info.commandLine, /storybook[\\/]dist[\\/]bin[\\/]dispatcher\.js/i);
    assert.ok(info.commandLine.toLowerCase().includes(root.toLowerCase()));
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  }
  await waitFor(async () => !(await pidAlive(child.pid)), `Storybook PID ${child.pid} exit`, 5_000, false);
}

async function storyId() {
  const response = await fetch(`${storybookUrl}/index.json`);
  assert.equal(response.ok, true, "Storybook index must be readable");
  const index = await response.json();
  const entry = Object.values(index.entries ?? {}).find(
    (candidate) => candidate?.title === storyTitle && candidate?.name === "Production Canvas E2E"
  );
  assert.ok(entry?.id, `Story not found: ${storyTitle}`);
  return entry.id;
}

async function readState(page) {
  const raw = await page.getByTestId("canvas-e2e-state").textContent();
  assert.ok(raw, "E2E state output must be present");
  return JSON.parse(raw);
}

function subtreeMeta(placement) {
  return placement.meta?.tentSubtreeProjection ?? null;
}

function placementMap(document) {
  return new Map(document.placements.map((placement) => [placement.placementId, placement]));
}

function instanceMembers(document, instanceId) {
  return document.placements.filter(
    (placement) => subtreeMeta(placement)?.instanceId === instanceId
  );
}

async function waitState(page, predicate, label) {
  return waitFor(async () => {
    const state = await readState(page);
    return predicate(state) ? state : null;
  }, label);
}

async function dragOutlineNode(page, title, targetPosition) {
  const source = page.getByRole("treeitem", { name: new RegExp(title) });
  const target = page.locator(".tn-canvas-host");
  await source.waitFor({ state: "visible" });
  await source.dragTo(target, { targetPosition });
}

async function dispatchBackgroundOutlineDrag(page, accessibleName, targetPosition) {
  const source = page.getByRole("treeitem", { name: accessibleName });
  const target = page.locator(".tn-canvas-host");
  assert.equal(await source.getAttribute("draggable"), "true", "authoritative Outline row must be draggable");
  const targetRect = await target.boundingBox();
  assert.ok(targetRect, "Canvas drop target must have layout bounds");
  const point = {
    clientX: targetRect.x + targetPosition.x,
    clientY: targetRect.y + targetPosition.y,
  };
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer, ...point });
  const types = await dataTransfer.evaluate((value) => [...value.types]);
  assert.ok(types.includes("application/x-tent-node-ref"), `Outline drag must populate Tent MIME: ${types.join(",")}`);
  await target.dispatchEvent("dragenter", { dataTransfer, ...point });
  await target.dispatchEvent("dragover", { dataTransfer, ...point });
  await target.dispatchEvent("drop", { dataTransfer, ...point });
  await source.dispatchEvent("dragend", { dataTransfer, ...point });
  await dataTransfer.dispose();
  await target.locator("[data-state=success]").waitFor({ state: "attached", timeout: 5_000 });
}

async function dragPlacement(page, placementId, dx, dy, beforeUp) {
  const card = page.locator(`[data-tent-placement-id="${placementId}"]`);
  const rect = await card.boundingBox();
  assert.ok(rect, `Placement must be visible: ${placementId}`);
  const start = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 1 });
  if (beforeUp) await beforeUp();
  await page.mouse.up();
}

async function visibleBranchIds(page) {
  return page.locator("[data-testid=canvas-subtree-lines] g[data-branch-id]").evaluateAll(
    (groups) => groups.map((group) => group.getAttribute("data-branch-id"))
  );
}

async function assertPathsAvoidVisibleCards(page) {
  const violations = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-tent-placement-id]")]
      .map((element) => ({
        placementId: element.getAttribute("data-tent-placement-id"),
        rect: element.getBoundingClientRect(),
      }));
    const result = [];
    for (const group of document.querySelectorAll("[data-testid=canvas-subtree-lines] g[data-branch-id]")) {
      const branchId = group.getAttribute("data-branch-id") ?? "";
      const path = group.querySelector("path:not(.tn-canvas-subtree-lines__path--highlight)");
      if (!(path instanceof SVGPathElement)) continue;
      const matrix = path.getScreenCTM();
      if (!matrix) continue;
      const length = path.getTotalLength();
      for (let index = 0; index <= 80; index += 1) {
        const local = path.getPointAtLength(length * index / 80);
        const point = new DOMPoint(local.x, local.y).matrixTransform(matrix);
        for (const card of cards) {
          if (!card.placementId || branchId.includes(card.placementId)) continue;
          const inset = 2;
          if (
            point.x > card.rect.left + inset && point.x < card.rect.right - inset &&
            point.y > card.rect.top + inset && point.y < card.rect.bottom - inset
          ) {
            result.push({ branchId, placementId: card.placementId, x: point.x, y: point.y });
          }
        }
      }
    }
    return result;
  });
  assert.deepEqual(violations, [], "Structural paths must not cross visible cards");
}

async function selectedControls(page, placementId) {
  const card = page.locator(`[data-tent-placement-id="${placementId}"]`);
  const cardRect = await card.boundingBox();
  assert.ok(cardRect, `Selected placement must be visible: ${placementId}`);
  const controls = page.getByRole("group", { name: "子树投影方向" });
  const boxes = await controls.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }));
  assert.ok(boxes.length > 0, "Subtree controls must exist");
  let index = 0;
  let distance = Number.POSITIVE_INFINITY;
  boxes.forEach((box, candidate) => {
    const next = Math.abs(box.left - cardRect.x) + Math.abs(box.top - cardRect.y);
    if (next < distance) {
      distance = next;
      index = candidate;
    }
  });
  const selected = controls.nth(index);
  await selected.waitFor({ state: "visible" });
  return selected;
}

async function selectPlacement(page, placementId) {
  const card = page.locator(`[data-tent-placement-id="${placementId}"]`);
  const rect = await card.boundingBox();
  assert.ok(rect, `Placement must be visible: ${placementId}`);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.locator(`[data-tent-placement-id="${placementId}"][data-selected=true]`).waitFor();
}

async function syncButtonForPlacement(page, placementId) {
  const cardRect = await page.locator(`[data-tent-placement-id="${placementId}"]`).boundingBox();
  assert.ok(cardRect, `Sync placement must be visible: ${placementId}`);
  const containers = page.locator(".tn-canvas-projection-sync");
  const boxes = await containers.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }));
  assert.ok(boxes.length > 0, "Projection sync controls must exist");
  let index = 0;
  let distance = Number.POSITIVE_INFINITY;
  boxes.forEach((box, candidate) => {
    const next = Math.abs(box.left - cardRect.x) + Math.abs(box.top - cardRect.y);
    if (next < distance) {
      distance = next;
      index = candidate;
    }
  });
  return containers.nth(index).getByRole("button", { name: /^同步投影/ });
}

async function exerciseBrowser() {
  const browser = await chromium.launch({
    executablePath: browserExecutable(),
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleProblems = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) consoleProblems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleProblems.push(`pageerror: ${error.stack ?? error}`));
  try {
    const id = await storyId();
    await page.goto(`${storybookUrl}/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`, {
      waitUntil: "commit",
      timeout: 20_000,
    });
    await page.getByTestId("canvas-v5-host").waitFor({ state: "visible", timeout: 60_000 });
    await page.locator("[data-testid=canvas-v5-scene] canvas.excalidraw__canvas.interactive").waitFor({
      state: "visible",
      timeout: 60_000,
    });
    await page.getByTestId("e2e-reset").click();
    await waitState(page, (state) => state.presentation.document.placements.length === 0, "empty Canvas reset");

    const rootTitle = "把复杂协作变成可见的工作";
    await dragOutlineNode(page, rootTitle, { x: 250, y: 220 });
    let state = await waitState(
      page,
      (candidate) => candidate.presentation.document.placements.length === 4,
      "first complete subtree projection"
    );
    await waitFor(
      async () => (await page.locator("[data-tent-placement-id]").count()) === 3,
      "first subtree cards"
    );
    const firstRoot = state.presentation.document.placements.find(
      (placement) => placement.entityRef === "cx-product"
    );
    assert.ok(firstRoot, "first subtree root must exist");
    const firstInstanceId = subtreeMeta(firstRoot)?.instanceId;
    assert.ok(firstInstanceId, "first subtree instance id must exist");
    assert.equal(instanceMembers(state.presentation.document, firstInstanceId).length, 4);

    await dragOutlineNode(page, rootTitle, { x: 570, y: 430 });
    state = await waitState(
      page,
      (candidate) => candidate.presentation.document.placements.length === 8,
      "second isolated subtree projection"
    );
    await waitFor(
      async () => (await page.locator("[data-tent-placement-id]").count()) === 6,
      "second subtree cards"
    );
    const roots = state.presentation.document.placements.filter(
      (placement) => placement.entityRef === "cx-product"
    );
    assert.equal(roots.length, 2);
    const instanceIds = roots.map((placement) => subtreeMeta(placement)?.instanceId);
    assert.equal(new Set(instanceIds).size, 2, "duplicate drags must create independent instances");
    const memberInstanceById = new Map(
      state.presentation.document.placements.map((placement) => [
        placement.placementId,
        subtreeMeta(placement)?.instanceId,
      ])
    );
    const branchIds = await visibleBranchIds(page);
    assert.equal(branchIds.length, 4, "two expanded roots must render two pairs of direct-child relationships");
    for (const branchId of branchIds) {
      const match = branchId.match(/:([^:>]+)->([^:]+)$/);
      assert.ok(match, `branch id must include exact placements: ${branchId}`);
      assert.equal(memberInstanceById.get(match[1]), memberInstanceById.get(match[2]), "branch must stay inside one instance");
    }

    const firstMembers = instanceMembers(state.presentation.document, firstInstanceId);
    const workbench = firstMembers.find((placement) => placement.entityRef === "cx-workbench");
    assert.ok(workbench, "workbench child must exist");
    const branchSelector = `[data-branch-id$="${firstRoot.placementId}->${workbench.placementId}"] path:not(.tn-canvas-subtree-lines__path--highlight)`;
    const originalPath = await page.locator(branchSelector).getAttribute("d");
    const beforeChild = placementMap(state.presentation.document).get(workbench.placementId);
    await dragPlacement(page, workbench.placementId, 52, -34, async () => {
      const livePath = await page.locator(branchSelector).getAttribute("d");
      assert.notEqual(livePath, originalPath, "SVG path must reroute in the pointermove frame");
      await assertPathsAvoidVisibleCards(page);
    });
    state = await waitState(page, (candidate) => {
      const current = placementMap(candidate.presentation.document).get(workbench.placementId);
      return current?.x !== beforeChild.x || current?.y !== beforeChild.y;
    }, "child movement commit");
    await assertPathsAvoidVisibleCards(page);

    // Every direction is available after collapse; switching direction is an
    // explicit relayout while same-direction reopen preserves manual geometry.
    await selectPlacement(page, firstRoot.placementId);
    for (const direction of ["right", "down", "left", "up"]) {
      let controls = await selectedControls(page, firstRoot.placementId);
      const expanded = await controls.getAttribute("data-expanded");
      if (expanded !== "collapsed") {
        await controls.locator(`button[data-direction="${expanded}"]`).click();
        await waitFor(async () => (await selectedControls(page, firstRoot.placementId)).getAttribute("data-expanded").then((value) => value === "collapsed"), "subtree collapse");
      }
      controls = await selectedControls(page, firstRoot.placementId);
      await controls.locator(`button[data-direction="${direction}"]`).click();
      await waitFor(async () => (await selectedControls(page, firstRoot.placementId)).getAttribute("data-expanded").then((value) => value === direction), `expand ${direction}`);
    }

    // Free child position survives a same-direction collapse/reopen.
    state = await readState(page);
    const childBeforeFreeMove = placementMap(state.presentation.document).get(workbench.placementId);
    await dragPlacement(page, workbench.placementId, -41, 27);
    state = await waitState(page, (candidate) => {
      const current = placementMap(candidate.presentation.document).get(workbench.placementId);
      return current?.x !== childBeforeFreeMove.x || current?.y !== childBeforeFreeMove.y;
    }, "free child movement");
    const freeChild = placementMap(state.presentation.document).get(workbench.placementId);
    await selectPlacement(page, firstRoot.placementId);
    let controls = await selectedControls(page, firstRoot.placementId);
    const lastDirection = await controls.getAttribute("data-expanded");
    await controls.locator(`button[data-direction="${lastDirection}"]`).click();
    controls = await selectedControls(page, firstRoot.placementId);
    await controls.locator(`button[data-direction="${lastDirection}"]`).click();
    state = await readState(page);
    const reopenedChild = placementMap(state.presentation.document).get(workbench.placementId);
    assert.deepEqual(
      { x: reopenedChild.x, y: reopenedChild.y },
      { x: freeChild.x, y: freeChild.y },
      "same-direction reopen must preserve free manual coordinates"
    );

    // Collapsed root carries every hidden descendant by the exact same delta.
    controls = await selectedControls(page, firstRoot.placementId);
    await controls.locator(`button[data-direction="${lastDirection}"]`).click();
    const beforeCarryState = await readState(page);
    const beforeCarry = placementMap(beforeCarryState.presentation.document);
    await dragPlacement(page, firstRoot.placementId, 37, 23);
    const afterCarryState = await waitState(page, (candidate) => {
      const root = placementMap(candidate.presentation.document).get(firstRoot.placementId);
      return root.x !== beforeCarry.get(firstRoot.placementId).x;
    }, "collapsed subtree carry");
    const afterCarry = placementMap(afterCarryState.presentation.document);
    const rootDx = afterCarry.get(firstRoot.placementId).x - beforeCarry.get(firstRoot.placementId).x;
    const rootDy = afterCarry.get(firstRoot.placementId).y - beforeCarry.get(firstRoot.placementId).y;
    for (const member of firstMembers.filter((placement) => placement.placementId !== firstRoot.placementId)) {
      assert.equal(afterCarry.get(member.placementId).x - beforeCarry.get(member.placementId).x, rootDx);
      assert.equal(afterCarry.get(member.placementId).y - beforeCarry.get(member.placementId).y, rootDy);
    }
    controls = await selectedControls(page, firstRoot.placementId);
    await controls.locator(`button[data-direction="${lastDirection}"]`).click();

    // Authority drift marks both instances. Sync reconciles exactly one and
    // preserves survivor coordinates; the other remains pending.
    await page.getByTestId("e2e-drift").click();
    await page.locator(`[data-tent-placement-id="${firstRoot.placementId}"][data-projection-sync="pending-sync"]`).waitFor();
    const secondRoot = roots.find((placement) => placement.placementId !== firstRoot.placementId);
    assert.ok(secondRoot);
    await page.locator(`[data-tent-placement-id="${secondRoot.placementId}"][data-projection-sync="pending-sync"]`).waitFor();
    state = await readState(page);
    const beforeSyncMembers = instanceMembers(state.presentation.document, firstInstanceId);
    const survivorCoords = new Map(beforeSyncMembers.map((placement) => [placement.entityRef, { x: placement.x, y: placement.y }]));
    await selectPlacement(page, firstRoot.placementId);
    await (await syncButtonForPlacement(page, firstRoot.placementId)).click();
    await page.locator(`[data-tent-placement-id="${firstRoot.placementId}"][data-projection-sync="current"]`).waitFor();
    await page.locator(`[data-tent-placement-id="${secondRoot.placementId}"][data-projection-sync="pending-sync"]`).waitFor();
    state = await readState(page);
    const afterSyncMembers = instanceMembers(state.presentation.document, firstInstanceId);
    assert.equal(afterSyncMembers.some((placement) => placement.entityRef === "cx-research"), false);
    assert.equal(afterSyncMembers.some((placement) => placement.entityRef === "cx-evidence"), true);
    for (const placement of afterSyncMembers) {
      const before = survivorCoords.get(placement.entityRef);
      if (before) assert.deepEqual({ x: placement.x, y: placement.y }, before, "sync must preserve survivor coordinates");
    }
    const persistedGeometry = state.presentation.document.placements
      .map((placement) => ({ placementId: placement.placementId, x: placement.x, y: placement.y }))
      .sort((left, right) => left.placementId.localeCompare(right.placementId));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("canvas-v5-host").waitFor({ state: "visible", timeout: 30_000 });
    state = await waitState(page, (candidate) => candidate.authorityMode === "drifted", "authority reload");
    assert.deepEqual(
      state.presentation.document.placements
        .map((placement) => ({ placementId: placement.placementId, x: placement.x, y: placement.y }))
        .sort((left, right) => left.placementId.localeCompare(right.placementId)),
      persistedGeometry,
      "reload must preserve exact placement identity and manual coordinates"
    );

    await selectPlacement(page, secondRoot.placementId);
    const beforeOffline = JSON.stringify((await readState(page)).presentation.document.placements);
    await page.getByTestId("e2e-stale").click();
    await page.locator("[data-shell=renderer-next][data-connection=reconnecting]").waitFor();
    assert.equal(await page.locator('button[aria-label^="同步"]:not([disabled])').count(), 0);
    assert.equal(JSON.stringify((await readState(page)).presentation.document.placements), beforeOffline, "stale authority must not mutate local placements");
    await page.getByTestId("e2e-online").click();
    await page.locator("[data-shell=renderer-next][data-connection=online]").waitFor();

    // Canvas selection reveals the left tree and right detail without moving
    // the camera. First expose the grandchild on Canvas, then hide it in the
    // Outline only.
    state = await readState(page);
    let firstCurrentMembers = instanceMembers(state.presentation.document, firstInstanceId);
    let currentRoot = firstCurrentMembers.find((placement) => placement.entityRef === "cx-product");
    let currentWorkbench = firstCurrentMembers.find((placement) => placement.entityRef === "cx-workbench");
    let delivery = firstCurrentMembers.find((placement) => placement.entityRef === "cx-delivery");
    assert.ok(currentRoot && currentWorkbench && delivery);
    await selectPlacement(page, currentRoot.placementId);
    controls = await selectedControls(page, currentRoot.placementId);
    let currentDirection = await controls.getAttribute("data-expanded");
    if (currentDirection !== "collapsed") {
      await controls.locator(`button[data-direction="${currentDirection}"]`).click();
      controls = await selectedControls(page, currentRoot.placementId);
    }
    await controls.locator("button[data-direction=down]").click();
    state = await readState(page);
    firstCurrentMembers = instanceMembers(state.presentation.document, firstInstanceId);
    currentWorkbench = firstCurrentMembers.find((placement) => placement.entityRef === "cx-workbench");
    delivery = firstCurrentMembers.find((placement) => placement.entityRef === "cx-delivery");
    assert.ok(currentWorkbench && delivery);
    await selectPlacement(page, currentWorkbench.placementId);
    controls = await selectedControls(page, currentWorkbench.placementId);
    if ((await controls.getAttribute("data-expanded")) === "collapsed") {
      await controls.locator("button[data-direction=down]").click();
    }
    await page.locator(`[data-tent-placement-id="${delivery.placementId}"]`).waitFor();
    const workbenchTree = page.getByRole("treeitem", { name: /主界面：Canvas、节点与焦点/ });
    const disclosure = workbenchTree.locator(".tn-outline-disclosure");
    if ((await workbenchTree.getAttribute("aria-expanded")) === "true") await disclosure.click();
    await page.getByRole("treeitem", { name: /主界面视觉与交互证据/ }).waitFor({ state: "hidden" });
    const cameraBefore = await page.locator("[data-testid=canvas-subtree-lines] > g").getAttribute("transform");
    await selectPlacement(page, delivery.placementId);
    const deliveryTree = page.getByRole("treeitem", { name: /主界面视觉与交互证据/ });
    await deliveryTree.waitFor({ state: "visible" });
    assert.equal(await deliveryTree.getAttribute("aria-selected"), "true");
    assert.equal(await deliveryTree.evaluate((element) => document.activeElement === element), true);
    assert.match(await page.locator("#tn-focus-panel").innerText(), /主界面视觉与交互证据/);
    const cameraAfter = await page.locator("[data-testid=canvas-subtree-lines] > g").getAttribute("transform");
    assert.equal(cameraAfter, cameraBefore, "Canvas selection must not move the camera");

    await fsp.mkdir(outputDir, { recursive: true });
    await page.screenshot({ path: path.join(outputDir, "canvas-production-e2e-1440x900.png") });
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.screenshot({ path: path.join(outputDir, "canvas-production-e2e-1280x840.png") });
    assert.equal(consoleProblems.length, 0, `Browser console must stay clean:\n${consoleProblems.join("\n")}`);
    return {
      placements: state.presentation.document.placements.length,
      branchCount: await page.locator("[data-testid=canvas-subtree-lines] g[data-branch-id]").count(),
      screenshots: [
        path.join(outputDir, "canvas-production-e2e-1440x900.png"),
        path.join(outputDir, "canvas-production-e2e-1280x840.png"),
      ],
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processInfo(pid) {
  if (!(await pidAlive(pid))) return null;
  if (process.platform !== "win32") return { pid, executablePath: "", commandLine: "" };
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if (-not $p) { exit 3 }",
    "[pscustomobject]@{ pid = [int]$p.ProcessId; executablePath = $p.ExecutablePath; commandLine = $p.CommandLine } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status === 3) return null;
  assert.equal(result.status, 0, `Cannot inspect PID ${pid}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

async function processInfosContaining(needle) {
  if (process.platform !== "win32") return [];
  const escaped = needle.replaceAll("'", "''");
  const script = [
    `$needle = '${escaped}'`,
    "$rows = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($needle, [StringComparison]::OrdinalIgnoreCase) }",
    "$rows | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; executablePath = $_.ExecutablePath; commandLine = $_.CommandLine } } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, `Cannot inspect process ownership for ${needle}: ${result.stderr}`);
  const raw = result.stdout.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function stopOwnedPidTree(pid, validateOwnership) {
  if (!(await pidAlive(pid))) return;
  const info = await processInfo(pid);
  assert.ok(info, `Owned PID disappeared before inspection: ${pid}`);
  validateOwnership(info);
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, `taskkill failed for owned PID ${pid}: ${result.stderr}`);
  } else {
    process.kill(pid, "SIGTERM");
  }
  await waitFor(async () => !(await pidAlive(pid)), `owned PID ${pid} exit`, 5_000, false);
}

async function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function authenticatedServiceHealth(endpoint) {
  assert.equal(typeof endpoint?.host, "string", "Service endpoint host is required");
  assert.equal(Number.isInteger(endpoint?.port), true, "Service endpoint port is required");
  assert.equal(typeof endpoint?.token, "string", "Service endpoint token is required");
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tent-token": endpoint.token,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "service.health", params: {} }),
  });
  assert.equal(response.ok, true, `Authenticated Service health HTTP ${response.status}`);
  const payload = await response.json();
  assert.equal(payload.error, undefined, `Authenticated Service health failed: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

function runCli(args, serviceDataDir, timeout = 30_000) {
  const result = spawnSync(process.execPath, [path.join(root, "cli.mjs"), ...args], {
    cwd: root,
    env: { ...process.env, TENT_SERVICE_DATA_DIR: serviceDataDir },
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });
  assert.equal(result.status, 0, `CLI failed: tent ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function parseCliJson(output) {
  const start = output.indexOf("{");
  assert.ok(start >= 0, `CLI JSON output missing: ${output}`);
  return JSON.parse(output.slice(start));
}

async function runNodeScriptBounded(script, args, timeout) {
  runAbortSignal.throwIfAborted();
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  let timer;
  let abortHandler;
  try {
    const exitCode = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeout}ms: ${script}`)), timeout);
      }),
      new Promise((_, reject) => {
        abortHandler = () => reject(runAbortSignal.reason);
        runAbortSignal.addEventListener("abort", abortHandler, { once: true });
      }),
    ]);
    assert.equal(exitCode, 0, `Command failed (${exitCode}): ${script}`);
  } catch (error) {
    if (await pidAlive(child.pid)) {
      await stopOwnedPidTree(child.pid, (info) => {
        assert.equal(path.resolve(info.executablePath).toLowerCase(), path.resolve(process.execPath).toLowerCase());
        assert.ok(info.commandLine.toLowerCase().includes(path.resolve(script).toLowerCase()));
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (abortHandler) runAbortSignal.removeEventListener("abort", abortHandler);
  }
}

async function rejectReparsePoints(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const stat = await fsp.lstat(target);
    assert.equal(stat.isSymbolicLink(), false, `Refusing cleanup across reparse/symlink: ${target}`);
    if (stat.isDirectory()) await rejectReparsePoints(target);
  }
}

async function safeRemoveRunDirectory(directory, runId) {
  const resolved = path.resolve(directory);
  const temp = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), temp.toLowerCase(), "E2E run dir must be a direct os.tmpdir child");
  assert.ok(path.basename(resolved).startsWith(`tent-canvas-e2e-${runId}-`), "E2E run dir prefix mismatch");
  const marker = await readJsonIfExists(path.join(resolved, ".tent-e2e-owned.json"));
  assert.deepEqual(marker, { owner: "test-renderer-next-canvas-e2e", runId });
  const rootStat = await fsp.lstat(resolved);
  assert.equal(rootStat.isSymbolicLink(), false, "E2E run dir must not be a reparse/symlink");
  await rejectReparsePoints(resolved);
  const dips = path.join(resolved, "electron-user-data", "DIPS");
  if (fs.existsSync(dips)) {
    await waitFor(async () => {
      const probe = `${dips}.tent-e2e-probe`;
      try {
        await fsp.rename(dips, probe);
        await fsp.rename(probe, dips);
        return true;
      } catch {
        return false;
      }
    }, "isolated Chromium storage unlock", 30_000, false);
  }
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fsp.rm(resolved, { recursive: true, force: false });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
      await sleep(250);
    }
  }
  if (lastError) throw lastError;
  assert.equal(fs.existsSync(resolved), false, "E2E run dir cleanup must complete");
}

function persistedCanvas(page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("tent.desktop.canvasV5Local.v1:"));
    if (!key) return null;
    return JSON.parse(localStorage.getItem(key));
  });
}

async function findPortableExecutable(packageOutput) {
  const candidates = (await fsp.readdir(packageOutput))
    .filter((entry) => /^Tent-.+-portable\.exe$/i.test(entry))
    .sort((left, right) => left.localeCompare(right));
  assert.equal(candidates.length, 1, `Expected one final portable executable in ${packageOutput}: ${candidates.join(", ")}`);
  return path.join(packageOutput, candidates[0]);
}

async function exercisePortableLaunch(portable, temp, defaultBefore) {
  if (process.platform !== "win32") return { skipped: true, reason: "Windows portable smoke" };
  const serviceDataDir = path.join(temp, "portable-service");
  const appData = path.join(temp, "portable-appdata");
  const localAppData = path.join(temp, "portable-localappdata");
  const home = path.join(temp, "portable-home");
  const userData = path.join(temp, "portable-user-data");
  await Promise.all([serviceDataDir, appData, localAppData, home, userData].map((entry) => fsp.mkdir(entry, { recursive: true })));
  const defaultEndpointPath = path.join(process.env.APPDATA ?? "", "Tent", "service.json");
  const endpointPath = path.join(serviceDataDir, "service.json");
  const env = {
    ...process.env,
    TENT_SERVICE_DATA_DIR: serviceDataDir,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    USERPROFILE: home,
    HOME: home,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TENT_SERVICE_ENTRY;
  delete env.TENT_DESKTOP_DEVTOOLS;

  let wrapper = null;
  let launchError = null;
  let primaryError = null;
  const cleanupErrors = [];
  let evidence = null;
  try {
    wrapper = spawn(portable, ["--headless", `--user-data-dir=${userData}`], {
      cwd: path.dirname(portable),
      env,
      stdio: "ignore",
      windowsHide: true,
    });
    wrapper.once("error", (error) => {
      launchError = error;
    });
    const endpoint = await waitFor(async () => {
      if (launchError) throw launchError;
      const candidate = await readJsonIfExists(endpointPath);
      if (!candidate || !(await portOpen(candidate.host, candidate.port))) return null;
      return candidate;
    }, "portable first-launch Service endpoint", 60_000);
    const appProcesses = await waitFor(async () => {
      const matches = await processInfosContaining(path.resolve(userData));
      return matches.length > 0 ? matches : null;
    }, "portable owned app process", 30_000);
    const health = await authenticatedServiceHealth(endpoint);
    assert.equal(health.protocolVersion, 5);
    assert.equal(health.pid, endpoint.pid);
    assert.notEqual(endpoint.pid, defaultBefore?.pid, "portable smoke must not reuse the default Service");
    evidence = {
      skipped: false,
      executable: path.basename(portable),
      servicePid: endpoint.pid,
      appProcessCount: appProcesses.length,
      protocolVersion: health.protocolVersion,
    };
  } catch (error) {
    primaryError = error;
  }

  try {
    if (wrapper?.pid && await pidAlive(wrapper.pid)) {
      await stopOwnedPidTree(wrapper.pid, (info) => {
        assert.equal(path.basename(info.executablePath).toLowerCase(), path.basename(portable).toLowerCase());
        assert.ok(info.commandLine.toLowerCase().includes(path.resolve(userData).toLowerCase()));
      });
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const matches = await processInfosContaining(path.resolve(userData));
      if (matches.length === 0) break;
      const info = matches[0];
      await stopOwnedPidTree(info.pid, (fresh) => {
        assert.ok(fresh.commandLine.toLowerCase().includes(path.resolve(userData).toLowerCase()));
        const executable = path.resolve(fresh.executablePath).toLowerCase();
        assert.ok(
          executable === path.resolve(portable).toLowerCase() || path.basename(executable) === "tent.exe",
          `Unexpected portable child executable: ${fresh.executablePath}`,
        );
      });
    }
    assert.deepEqual(await processInfosContaining(path.resolve(userData)), [], "No portable app process may remain");
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    const endpoint = await readJsonIfExists(endpointPath);
    if (endpoint?.pid && await pidAlive(endpoint.pid)) {
      await stopOwnedPidTree(endpoint.pid, (info) => {
        assert.notEqual(info.pid, defaultBefore?.pid);
        assert.match(info.commandLine, /service\.mjs/i);
        assert.ok(info.commandLine.toLowerCase().includes(path.resolve(serviceDataDir).toLowerCase()));
      });
      await waitFor(() => portOpen(endpoint.host, endpoint.port).then((open) => !open), "portable Service listener close", 8_000, false);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const matches = await processInfosContaining(path.resolve(serviceDataDir));
      if (matches.length === 0) break;
      const info = matches[0];
      await stopOwnedPidTree(info.pid, (fresh) => {
        assert.notEqual(fresh.pid, defaultBefore?.pid);
        assert.match(fresh.commandLine, /service\.mjs/i);
        assert.ok(fresh.commandLine.toLowerCase().includes(path.resolve(serviceDataDir).toLowerCase()));
      });
    }
    assert.deepEqual(await processInfosContaining(path.resolve(serviceDataDir)), [], "No portable Service process may remain");
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    assert.deepEqual(await readJsonIfExists(defaultEndpointPath), defaultBefore, "portable smoke must not touch the default Service endpoint");
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors].filter(Boolean),
      "Portable launch smoke or exact cleanup failed",
    );
  }
  return evidence;
}

function isKnownBlockedExcalidrawFontFallback(message) {
  const text = message.text();
  return message.type() === "error" &&
    text.includes("https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/") &&
    text.includes("violates the following Content Security Policy directive") &&
    text.includes("font-src 'self' data:") &&
    text.includes("The action has been blocked");
}

async function launchHiddenPackagedElectron(executable, env, userData, consoleProblems, consoleDisclosures) {
  const electron = await electronDriver.launch({
    executablePath: executable,
    args: ["--headless", `--user-data-dir=${userData}`],
    env,
    timeout: 25_000,
  });
  const appPid = electron.process().pid;
  const window = await waitFor(async () => {
    for (const candidate of electron.windows()) {
      if (await candidate.locator('[data-shell="renderer-next"]').count()) return candidate;
    }
    return null;
  }, "packaged renderer main window", 30_000);
  const visible = await electron.evaluate(({ BrowserWindow }) => {
    for (const candidate of BrowserWindow.getAllWindows()) candidate.hide();
    return BrowserWindow.getAllWindows().some((candidate) => candidate.isVisible() || candidate.isFocused());
  });
  assert.equal(visible, false, "Packaged E2E windows must stay hidden and unfocused");
  window.on("console", (message) => {
    if (isKnownBlockedExcalidrawFontFallback(message)) {
      consoleDisclosures.push(message.text());
    } else if (["warning", "error"].includes(message.type())) {
      consoleProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  window.on("pageerror", (error) => consoleProblems.push(`pageerror: ${error.stack ?? error}`));
  await window.locator('[data-shell="renderer-next"]').waitFor({ state: "attached", timeout: 20_000 });
  return { electron, window, appPid };
}

async function closePackagedElectron(run, executable, userData) {
  if (!run) return;
  await Promise.race([run.electron.close(), sleep(4_000)]);
  if (await pidAlive(run.appPid)) {
    await stopOwnedPidTree(run.appPid, (info) => {
      assert.equal(path.resolve(info.executablePath).toLowerCase(), path.resolve(executable).toLowerCase());
      assert.ok(info.commandLine.toLowerCase().includes(path.resolve(userData).toLowerCase()));
    });
  }
  assert.equal(await pidAlive(run.appPid), false, `Packaged app PID ${run.appPid} must be gone`);
  const stragglers = await processInfosContaining(path.resolve(userData));
  for (const info of stragglers) {
    await stopOwnedPidTree(info.pid, (fresh) => {
      assert.ok(fresh.commandLine.toLowerCase().includes(path.resolve(userData).toLowerCase()));
      assert.ok(path.resolve(fresh.executablePath).toLowerCase().startsWith(path.dirname(path.resolve(executable)).toLowerCase()));
    });
  }
  assert.deepEqual(await processInfosContaining(path.resolve(userData)), [], "No packaged Electron process may retain the isolated userData");
}

async function exercisePackagedElectron() {
  if (!packageSmoke) return { skipped: true };
  const runId = `${process.pid}-${Date.now()}`;
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), `tent-canvas-e2e-${runId}-`));
  await fsp.writeFile(
    path.join(temp, ".tent-e2e-owned.json"),
    JSON.stringify({ owner: "test-renderer-next-canvas-e2e", runId }),
    "utf8"
  );
  const packageOutput = packageOutputOption
    ? path.resolve(root, packageOutputOption)
    : path.join(temp, "package");
  const packageDir = path.join(packageOutput, "win-unpacked");
  const executable = path.join(packageDir, "Tent.exe");
  const serviceDataDir = path.join(temp, "service");
  const workspace = path.join(temp, "workspace");
  const appData = path.join(temp, "appdata");
  const localAppData = path.join(temp, "localappdata");
  const home = path.join(temp, "home");
  const userData = path.join(temp, "electron-user-data");
  const defaultEndpointPath = path.join(process.env.APPDATA ?? "", "Tent", "service.json");
  const defaultBefore = await readJsonIfExists(defaultEndpointPath);
  let run = null;
  let servicePid = null;
  let serviceEndpoint = null;
  let serviceEntryHeld = false;
  const serviceEntry = path.join(packageDir, "resources", "service.mjs");
  const serviceEntryHold = `${serviceEntry}.e2e-hold`;
  const consoleProblems = [];
  const consoleDisclosures = [];
  const cleanupErrors = [];
  let primaryError = null;
  let evidence = null;
  try {
    if (!packageOutputOption) {
      await runNodeScriptBounded(path.join(root, "scripts", "build-desktop.mjs"), [], 120_000);
      await runNodeScriptBounded(path.join(root, "esbuild.config.mjs"), ["production"], 120_000);
      await runNodeScriptBounded(path.join(root, "node_modules", "electron-builder", "cli.js"), [
        "--win",
        "portable",
        "--config",
        "electron-builder.yml",
        `--config.directories.output=${packageOutput}`,
      ], 240_000);
    }
    assert.ok(fs.existsSync(executable), `Packaged executable missing: ${executable}`);
    const portable = await findPortableExecutable(packageOutput);
    const portableEvidence = await exercisePortableLaunch(portable, temp, defaultBefore);
    runCli(["new", workspace], serviceDataDir);
    const rootNode = parseCliJson(runCli([
      "node", "create", "E2E Root", "--type", "goal", "--parent", "root",
      "--body", "# E2E Root", "--workspace", workspace, "--data-dir", serviceDataDir, "--json",
    ], serviceDataDir)).node;
    const childNode = parseCliJson(runCli([
      "node", "create", "E2E Child", "--type", "prompt", "--parent", rootNode.nodeId,
      "--body", "# E2E Child", "--workspace", workspace, "--data-dir", serviceDataDir, "--json",
    ], serviceDataDir)).node;
    parseCliJson(runCli([
      "node", "create", "E2E Grandchild", "--type", "output", "--parent", childNode.nodeId,
      "--body", "# E2E Grandchild", "--workspace", workspace, "--data-dir", serviceDataDir, "--json",
    ], serviceDataDir));
    serviceEndpoint = await waitFor(
      () => readJsonIfExists(path.join(serviceDataDir, "service.json")),
      "isolated Service endpoint",
      15_000
    );
    servicePid = serviceEndpoint.pid;
    assert.notEqual(servicePid, defaultBefore?.pid, "isolated Service PID must differ from default Service PID");
    const serviceProcess = await processInfo(servicePid);
    assert.ok(serviceProcess);
    assert.match(serviceProcess.commandLine, /service\.mjs/i);
    assert.ok(serviceProcess.commandLine.toLowerCase().includes(path.resolve(serviceDataDir).toLowerCase()));

    const env = {
      ...process.env,
      TENT_SERVICE_DATA_DIR: serviceDataDir,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      USERPROFILE: home,
      HOME: home,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.TENT_SERVICE_ENTRY;
    delete env.TENT_DESKTOP_DEVTOOLS;
    run = await launchHiddenPackagedElectron(executable, env, userData, consoleProblems, consoleDisclosures);
    const { window } = run;
    await window.locator('[data-shell="renderer-next"][data-connection="online"]').waitFor({ timeout: 30_000 });
    const health = await window.evaluate(() => window.tentDesktop.health());
    assert.equal(health?.protocolVersion, 5);
    assert.equal(health.pid, servicePid);
    await window.evaluate((workspaceRoot) => window.tentDesktop.mountWorkspace(workspaceRoot), workspace);
    const desktopPrefs = await window.evaluate(() => window.tentDesktop.getPrefs());
    assert.equal(
      path.resolve(desktopPrefs.lastWorkspaceRoot),
      path.resolve(workspace),
      "production Desktop mount must persist the exact remembered workspace before recovery",
    );

    await dispatchBackgroundOutlineDrag(window, /E2E Root/, { x: 260, y: 220 });
    // Production preserves the first-node seed placement. One explicit parent
    // projection entry therefore adds an isolated root + direct-child instance
    // alongside that seed: three cards total, with one instance-scoped branch.
    await waitFor(async () => (await window.locator("[data-tent-placement-id]").count()) === 3, "packaged subtree cards");
    assert.equal(await window.locator("[data-testid=canvas-subtree-lines] g[data-branch-id]").count(), 1);
    let persisted = await waitFor(async () => {
      const snapshot = await persistedCanvas(window);
      // The folded grandchild remains a persisted member of the projection
      // instance even though only root + direct child are initially visible.
      return snapshot?.document?.placements?.length === 4 ? snapshot : null;
    }, "packaged subtree persistence");
    const rootPlacement = persisted.document.placements.find(
      (placement) => placement.entityRef === rootNode.nodeId && subtreeMeta(placement)?.rootPlacementId === placement.placementId
    );
    assert.ok(rootPlacement, "explicit projection entry must persist an instance root separate from the seed copy");
    const instanceId = subtreeMeta(rootPlacement)?.instanceId;
    assert.ok(instanceId);
    const childPlacement = persisted.document.placements.find(
      (placement) => placement.entityRef === childNode.nodeId && subtreeMeta(placement)?.instanceId === instanceId
    );
    assert.ok(childPlacement, "explicit projection instance must persist its exact direct child");
    const beforeRestartGeometry = persisted.document.placements
      .map((placement) => ({ placementId: placement.placementId, x: placement.x, y: placement.y }))
      .sort((left, right) => left.placementId.localeCompare(right.placementId));

    await closePackagedElectron(run, executable, userData);
    run = null;
    run = await launchHiddenPackagedElectron(executable, env, userData, consoleProblems, consoleDisclosures);
    await run.window.locator('[data-shell="renderer-next"][data-connection="online"]').waitFor({ timeout: 30_000 });
    const afterRestart = await waitFor(async () => {
      const snapshot = await persistedCanvas(run.window);
      return snapshot?.document?.placements?.length === 4 ? snapshot : null;
    }, "packaged restart persistence");
    assert.equal(subtreeMeta(afterRestart.document.placements.find((placement) => placement.placementId === rootPlacement.placementId))?.instanceId, instanceId);
    assert.deepEqual(
      afterRestart.document.placements
        .map((placement) => ({ placementId: placement.placementId, x: placement.x, y: placement.y }))
        .sort((left, right) => left.placementId.localeCompare(right.placementId)),
      beforeRestartGeometry,
      "packaged restart must preserve instance identity and exact manual coordinates"
    );

    runCli([
      "node", "write", rootNode.nodeId, "--body", "# E2E Root changed",
      "--workspace", workspace, "--data-dir", serviceDataDir, "--json",
    ], serviceDataDir);
    await run.window.locator(`[data-tent-placement-id="${rootPlacement.placementId}"][data-projection-sync="pending-sync"]`).waitFor({ timeout: 20_000 });
    const beforeLossDocument = JSON.stringify((await persistedCanvas(run.window)).document);
    await fsp.rename(serviceEntry, serviceEntryHold);
    serviceEntryHeld = true;
    await stopOwnedPidTree(servicePid, (info) => {
      assert.notEqual(info.pid, defaultBefore?.pid);
      assert.match(info.commandLine, /service\.mjs/i);
      assert.ok(info.commandLine.toLowerCase().includes(path.resolve(serviceDataDir).toLowerCase()));
    });
    await waitFor(() => portOpen(serviceEndpoint.host, serviceEndpoint.port).then((open) => !open), "isolated Service listener close", 8_000);
    await run.window.locator('[data-shell="renderer-next"][data-connection="reconnecting"]').waitFor({ timeout: 20_000 });
    assert.equal(await run.window.locator('button[aria-label^="同步"]:not([disabled])').count(), 0);
    assert.equal(
      JSON.stringify((await persistedCanvas(run.window)).document),
      beforeLossDocument,
      "Service loss must preserve the complete persisted local Canvas document byte-for-byte"
    );
    await fsp.rename(serviceEntryHold, serviceEntry);
    serviceEntryHeld = false;
    const recoveredEndpoint = await waitFor(async () => {
      try {
        await run.window.evaluate(() => window.tentDesktop.getState());
      } catch {
        return null;
      }
      const candidate = await readJsonIfExists(path.join(serviceDataDir, "service.json"));
      if (!candidate || candidate.pid === serviceEndpoint.pid) return null;
      if (!(await portOpen(candidate.host, candidate.port))) return null;
      return candidate;
    }, "replacement packaged Service endpoint", 60_000);
    assert.notEqual(recoveredEndpoint.token, serviceEndpoint.token, "replacement Service token must change");
    assert.notEqual(recoveredEndpoint.startedAt, serviceEndpoint.startedAt, "replacement Service start identity must change");
    if (serviceEndpoint.instanceId && recoveredEndpoint.instanceId) {
      assert.notEqual(recoveredEndpoint.instanceId, serviceEndpoint.instanceId, "replacement Service instance must change");
    }
    await run.window.locator('[data-shell="renderer-next"][data-connection="online"]').waitFor({ timeout: 30_000 });
    const recoveredHealth = await run.window.evaluate(() => window.tentDesktop.health());
    assert.equal(recoveredHealth.protocolVersion, 5);
    assert.equal(recoveredHealth.pid, recoveredEndpoint.pid);
    assert.notEqual(recoveredHealth.pid, servicePid);
    const recoveredWorkspaces = await waitFor(async () => {
      const workspaces = await run.window.evaluate(() => window.tentDesktop.listWorkspaces());
      return workspaces.length === 1
        && workspaces[0].foreground === true
        && path.resolve(workspaces[0].workspaceRoot) === path.resolve(workspace)
        ? workspaces
        : null;
    }, "replacement Service remembered workspace remount", 30_000);
    assert.equal(recoveredWorkspaces.length, 1, "replacement Service must remount exactly one remembered workspace");
    assert.equal(path.resolve(recoveredWorkspaces[0].workspaceRoot), path.resolve(workspace));
    assert.equal(recoveredWorkspaces[0].foreground, true);
    const recoveredCanvasDocument = await waitFor(async () => {
      const serialized = JSON.stringify((await persistedCanvas(run.window)).document);
      return serialized === beforeLossDocument ? serialized : null;
    }, "stable Canvas viewport after Service recovery", 20_000);
    assert.equal(
      recoveredCanvasDocument,
      beforeLossDocument,
      "Service recovery must not rewrite the persisted local Canvas document",
    );
    await run.window.locator('button[aria-label="同步快照"]:not([disabled])').first().waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await run.window.locator(
      `[data-tent-placement-id="${rootPlacement.placementId}"][data-projection-sync="pending-sync"]`,
    ).waitFor({ timeout: 20_000 });
    runCli([
      "node", "write", childNode.nodeId, "--body", "# E2E Child changed after recovery",
      "--workspace", workspace, "--data-dir", serviceDataDir, "--json",
    ], serviceDataDir);
    await run.window.locator(
      `[data-tent-placement-id="${childPlacement.placementId}"][data-projection-sync="pending-sync"]`,
    ).waitFor({ timeout: 20_000 });
    assert.equal(
      JSON.stringify((await persistedCanvas(run.window)).document),
      beforeLossDocument,
      "reattached Service events must not mutate the frozen Canvas document",
    );
    assert.equal(consoleProblems.length, 0, `Packaged renderer console must stay clean:\n${consoleProblems.join("\n")}`);
    evidence = {
      skipped: false,
      protocolVersion: health.protocolVersion,
      workspace,
      rootNodeId: rootNode.nodeId,
      childNodeId: childNode.nodeId,
      instanceId,
      placementGeometry: beforeRestartGeometry,
      serviceLossFailClosed: true,
      serviceRecovery: {
        oldPid: servicePid,
        newPid: recoveredEndpoint.pid,
        rememberedWorkspaceCount: recoveredWorkspaces.length,
        eventsRestored: true,
      },
      portable: portableEvidence,
      blockedExcalidrawFontFallbacks: consoleDisclosures.length,
    };
  } catch (error) {
    primaryError = error;
  }
  try {
    await closePackagedElectron(run, executable, userData);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (serviceEntryHeld) await fsp.rename(serviceEntryHold, serviceEntry);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    const latestEndpoint = await readJsonIfExists(path.join(serviceDataDir, "service.json"));
    const latestPid = latestEndpoint?.pid;
    if (latestPid && await pidAlive(latestPid)) {
      await stopOwnedPidTree(latestPid, (info) => {
        assert.notEqual(info.pid, defaultBefore?.pid);
        assert.match(info.commandLine, /service\.mjs/i);
        assert.ok(info.commandLine.toLowerCase().includes(path.resolve(serviceDataDir).toLowerCase()));
      });
      await waitFor(() => portOpen(latestEndpoint.host, latestEndpoint.port).then((open) => !open), "cleanup Service listener close", 8_000, false);
    }
    const serviceStragglers = await processInfosContaining(path.resolve(serviceDataDir));
    for (const info of serviceStragglers) {
      await stopOwnedPidTree(info.pid, (fresh) => {
        assert.notEqual(fresh.pid, defaultBefore?.pid);
        assert.match(fresh.commandLine, /service\.mjs/i);
        assert.ok(fresh.commandLine.toLowerCase().includes(path.resolve(serviceDataDir).toLowerCase()));
      });
    }
    assert.deepEqual(await processInfosContaining(path.resolve(serviceDataDir)), [], "No isolated Service process may remain");
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    const defaultAfter = await readJsonIfExists(defaultEndpointPath);
    assert.deepEqual(defaultAfter, defaultBefore, "default Service endpoint must remain untouched");
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await safeRemoveRunDirectory(temp, runId);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors].filter(Boolean),
      "Packaged Canvas E2E or exact cleanup failed"
    );
  }
  return evidence;
}

let storybook = null;
const deadline = setTimeout(() => {
  runAbortController.abort(new Error(`Canvas E2E exceeded ${deadlineMs}ms deadline`));
}, deadlineMs);
try {
  runAbortSignal.throwIfAborted();
  if (!packagedOnly) storybook = await startStorybook();
  const browserEvidence = packagedOnly ? { skipped: true } : await exerciseBrowser();
  const packagedEvidence = await exercisePackagedElectron();
  runAbortSignal.throwIfAborted();
  console.log(JSON.stringify({ ok: true, browserEvidence, packagedEvidence }, null, 2));
} finally {
  clearTimeout(deadline);
  await stopChild(storybook);
}
