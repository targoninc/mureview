import { describe, expect, test } from 'bun:test';
import { Cache, cached, mapLimit } from './cache';

describe('Cache', () => {
  test('stores and evicts oldest entries', () => {
    const cache = new Cache<number>(2, 1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  test('expires entries', () => {
    const cache = new Cache<number>(10, -1);
    cache.set('a', 1);
    expect(cache.get('a')).toBeUndefined();
  });

  test('cached() only loads once', async () => {
    const cache = new Cache<number>(10, 1000);
    let loads = 0;
    const load = async () => {
      loads++;
      return 42;
    };
    expect(await cached(cache, 'key', load)).toBe(42);
    expect(await cached(cache, 'key', load)).toBe(42);
    expect(loads).toBe(1);
  });
});

describe('mapLimit', () => {
  test('keeps order and respects the limit', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return value * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
