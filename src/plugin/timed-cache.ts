export const GIT_UI_CACHE_TTL_MS = 6_000;

interface TimedCacheEntry<T> {
  expiresAt: number;
  hasValue: boolean;
  value?: T;
  promise?: Promise<T>;
}

export class TimedCache<T> {
  private entries = new Map<string, TimedCacheEntry<T>>();

  constructor(
    private ttlMs = GIT_UI_CACHE_TTL_MS,
    private now: () => number = () => Date.now()
  ) {}

  get(key: string, loader: () => Promise<T>): Promise<T> {
    const now = this.now();
    const hit = this.entries.get(key);
    if (hit?.hasValue && hit.expiresAt > now) return Promise.resolve(hit.value as T);
    if (hit?.promise) return hit.promise;

    const promise = loader()
      .then((value) => {
        this.entries.set(key, {
          value,
          hasValue: true,
          expiresAt: this.now() + this.ttlMs,
        });
        return value;
      })
      .catch((error) => {
        this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, { expiresAt: now + this.ttlMs, hasValue: false, promise });
    return promise;
  }

  clear(): void {
    this.entries.clear();
  }
}
