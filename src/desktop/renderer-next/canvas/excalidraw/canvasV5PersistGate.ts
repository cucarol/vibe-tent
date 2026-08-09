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

/**
 * Capture the live Excalidraw frame before starting a durable Canvas sync.
 *
 * Placement writes are sampled directly because pointer-up may have cancelled
 * the debounce while its final frame is still queued. Drawing writes retain
 * their ordering, then the same live frame is persisted as the final snapshot.
 */
export function captureCanvasV5SyncBaseline<
  TDocument,
  TElements extends readonly unknown[],
  TAppState,
  TFiles,
>(input: {
  placement: CanvasV5PersistGate;
  drawing: CanvasV5PersistGate;
  readScene: () => {
    elements: TElements;
    appState: TAppState;
    files: TFiles;
  };
  commitPlacement: (elements: TElements, appState: TAppState) => void;
  persistDrawing: (elements: TElements, appState: TAppState, files: TFiles) => void;
  readDocument: () => TDocument;
}): TDocument {
  input.placement.cancel();
  const scene = input.readScene();
  input.commitPlacement(scene.elements, scene.appState);
  input.drawing.flush();
  input.persistDrawing(scene.elements, scene.appState, scene.files);
  return input.readDocument();
}
