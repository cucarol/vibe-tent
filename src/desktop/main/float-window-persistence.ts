import type { DesktopPreferences } from "../types.js";
import type { FloatWindowRect } from "./float-window-layout.js";

export type FloatWindowPersistenceOptions = {
  delayMs?: number;
  loadPrefs: () => Promise<DesktopPreferences>;
  savePrefs: (prefs: DesktopPreferences) => Promise<void>;
  onError?: (error: unknown) => void;
};

/**
 * Serializes machine-local float bounds writes so a slow old write can never
 * finish after and overwrite a newer position. Bounds are captured before
 * scheduling; flush does not depend on a still-live BrowserWindow.
 */
export class FloatWindowBoundsPersistence {
  readonly #delayMs: number;
  readonly #loadPrefs: () => Promise<DesktopPreferences>;
  readonly #savePrefs: (prefs: DesktopPreferences) => Promise<void>;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pendingBounds: FloatWindowRect | null = null;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: FloatWindowPersistenceOptions) {
    this.#delayMs = options.delayMs ?? 240;
    this.#loadPrefs = options.loadPrefs;
    this.#savePrefs = options.savePrefs;
    this.#onError = options.onError ?? (() => undefined);
  }

  schedule(bounds: FloatWindowRect): void {
    this.#pendingBounds = { ...bounds };
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#enqueuePending().catch(() => undefined);
    }, this.#delayMs);
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#enqueuePending();
  }

  #enqueuePending(): Promise<void> {
    const bounds = this.#pendingBounds;
    this.#pendingBounds = null;
    if (!bounds) return this.#writeChain;

    const write = this.#writeChain.then(async () => {
      const current = await this.#loadPrefs();
      await this.#savePrefs({ ...current, floatWindowBounds: bounds });
    });
    this.#writeChain = write.catch((error) => {
      this.#onError(error);
    });
    return write;
  }
}
