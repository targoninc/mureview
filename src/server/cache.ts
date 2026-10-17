interface Entry<T> {
  value: T;
  expires: number;
  storedAt: number;
}

export class Cache<T> {
  private entries = new Map<string, Entry<T>>();

  constructor(
    private maxEntries = 500,
    private ttlMs = 60_000,
  ) {}

  clear(): void {
    this.entries.clear();
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      // Keep expired entries around so getStale() can still serve them.
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Returns the value even after it expired, as long as it is not too old. */
  getStale(key: string, maxAgeMs: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.storedAt > maxAgeMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.ttlMs): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const now = Date.now();
    this.entries.set(key, { value, expires: now + ttlMs, storedAt: now });
  }
}

export async function cached<T>(cache: Cache<T>, key: string, load: () => Promise<T>, ttlMs?: number): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = await load();
  cache.set(key, value, ttlMs);
  return value;
}

export async function mapLimit<A, B>(items: A[], limit: number, fn: (item: A, index: number) => Promise<B>): Promise<B[]> {
  const results = new Array<B>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
