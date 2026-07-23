/**
 * One-shot Chromium probe against vite preview.
 * Usage: node scripts/browser-metrics.mjs [url]
 */
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:4179/";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const tNav0 = Date.now();
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
const navMs = Date.now() - tNav0;

// Wait for status bar to report node count (graph mounted).
await page.waitForFunction(
  () => {
    const foot = document.querySelector(".status");
    return foot && /entities/.test(foot.textContent || "");
  },
  { timeout: 30000 }
);

// Extra settle for X6 layout.
await page.waitForTimeout(500);

const metrics = await page.evaluate(() => {
  const host = document.querySelector(".canvas-host");
  const status = document.querySelector(".status")?.textContent?.trim() || "";
  const svgCount = host ? host.querySelectorAll("svg").length : 0;
  const domUnder = host ? host.querySelectorAll("*").length + 1 : 0;
  const allDom = document.querySelectorAll("*").length;
  const x6Nodes = host ? host.querySelectorAll(".x6-node").length : 0;
  const x6Edges = host ? host.querySelectorAll(".x6-edge").length : 0;
  const mem = performance.memory
    ? Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) / 10
    : null;
  const paint = performance.getEntriesByType("paint");
  const nav = performance.getEntriesByType("navigation")[0];
  return {
    status,
    svgCount,
    domUnderCanvas: domUnder,
    domDocument: allDom,
    x6NodeElements: x6Nodes,
    x6EdgeElements: x6Edges,
    heapUsedMb: mem,
    fcpMs: paint.find((p) => p.name === "first-contentful-paint")?.startTime,
    domContentLoadedMs: nav?.domContentLoadedEventEnd,
    loadEventMs: nav?.loadEventEnd,
  };
});

// Interaction feel: pan (drag blank) + programmatic node move via mouse on first node.
const tPan0 = Date.now();
await page.mouse.move(700, 450);
await page.mouse.down();
await page.mouse.move(760, 500, { steps: 8 });
await page.mouse.up();
const panMs = Date.now() - tPan0;

// Outline open
const tOut0 = Date.now();
await page.getByRole("button", { name: "Outline" }).click();
await page.waitForSelector(".outline-drawer", { timeout: 5000 });
const outlineMs = Date.now() - tOut0;
await page.getByRole("button", { name: "关闭" }).first().click();

// Screenshot for evidence
await page.screenshot({
  path: new URL("../evidence/spike-overview.png", import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1"
  ),
  fullPage: false,
});

const report = {
  url,
  navToIdleMs: navMs,
  panGestureMs: panMs,
  outlineOpenMs: outlineMs,
  ...metrics,
};

console.log(JSON.stringify(report, null, 2));
await browser.close();
