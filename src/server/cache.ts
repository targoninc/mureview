interface Entry<T> {
  value: T;
  expires: number;
}

export class Cache<T> {
  private entries = new Map<string, Entry<T>>();

  constructor(
    private maxEntries = 500,
    private ttlMs = 60_000,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  clear(): void {
    this.entries.clear();
  }

  set(key: string, value: T, ttlMs = this.ttlMs): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
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
