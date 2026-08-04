export type CanvasV5PersistGate = {
  schedule: (fn: () => void) => void;
  flush: () => void;
  cancel: () => void;
};

/** Debounced persist helper — coalesces pointermove storms. */
export function createCanvasV5PersistGate(ms: number): CanvasV5PersistGate {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: (() => void) | null = null;
  return {
    schedule(fn: () => void) {
      latest = fn;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const run = latest;
        latest = null;
        run?.();
      }, ms);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const run = latest;
      latest = null;
      run?.();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      latest = null;
    },
  };
}

/** Flush the local document before its paired drawing scene on teardown. */
export function flushCanvasV5PersistGates(gates: {
  placement: CanvasV5PersistGate;
  drawing: CanvasV5PersistGate;
}): void {
  gates.placement.flush();
  gates.drawing.flush();
}
