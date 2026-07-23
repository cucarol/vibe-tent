/**
 * Lightweight perf / DOM / memory probes for the spike README evidence.
 */

export type PerfSample = {
  label: string;
  ms: number;
  at: number;
};

export type ScaleSnapshot = {
  domainNodeCount: number;
  placementCount: number;
  edgeCount: number;
  /** Approximate X6/DOM cell count if known. */
  cellCount?: number;
  /** document.querySelectorAll('*').length under canvas host */
  domNodeCount?: number;
  /** performance.memory.usedJSHeapSize when available (Chrome) */
  heapUsedMb?: number;
  firstRenderMs?: number;
  lastInteractionMs?: number;
};

export function nowMs(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

export function measureSync<T>(label: string, fn: () => T): { result: T; sample: PerfSample } {
  const t0 = nowMs();
  const result = fn();
  const ms = nowMs() - t0;
  return {
    result,
    sample: { label, ms, at: Date.now() },
  };
}

export async function measureAsync<T>(
  label: string,
  fn: () => Promise<T>
): Promise<{ result: T; sample: PerfSample }> {
  const t0 = nowMs();
  const result = await fn();
  const ms = nowMs() - t0;
  return {
    result,
    sample: { label, ms, at: Date.now() },
  };
}

export function readHeapUsedMb(): number | undefined {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number };
  };
  if (perf.memory && typeof perf.memory.usedJSHeapSize === "number") {
    return Math.round((perf.memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10;
  }
  return undefined;
}

export function countDomUnder(el: Element | null): number | undefined {
  if (!el) return undefined;
  return el.querySelectorAll("*").length + 1;
}

export function formatScaleReport(s: ScaleSnapshot): string {
  const lines = [
    `domainNodes: ${s.domainNodeCount}`,
    `placements: ${s.placementCount}`,
    `edges: ${s.edgeCount}`,
    s.cellCount != null ? `x6Cells: ${s.cellCount}` : null,
    s.domNodeCount != null ? `domUnderCanvas: ${s.domNodeCount}` : null,
    s.heapUsedMb != null ? `heapUsedMb: ${s.heapUsedMb}` : null,
    s.firstRenderMs != null ? `firstRenderMs: ${s.firstRenderMs.toFixed(1)}` : null,
    s.lastInteractionMs != null
      ? `lastInteractionMs: ${s.lastInteractionMs.toFixed(1)}`
      : null,
  ].filter(Boolean);
  return lines.join("\n");
}
