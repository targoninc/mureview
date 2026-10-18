import type { ReviewMark } from '../../shared/types';

/**
 * The viewed marks are cached in the browser so a review set opens with its
 * checkmarks already in place, instead of waiting for the repository load.
 * The server's answer always replaces the cache once it arrives.
 */
const databaseName = 'mureview';
const storeName = 'viewed-marks';

interface CachedMarks {
  marks: ReviewMark[];
  at: number;
}

let database: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  database ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return database;
}

/** One user's marks on one review set; another account never sees them. */
export function marksKey(userId: number, reviewSetId: string | number): string {
  return `${userId}:${reviewSetId}`;
}

export async function readCachedMarks(key: string): Promise<ReviewMark[] | null> {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      request.onsuccess = () => resolve((request.result as CachedMarks | undefined)?.marks ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function writeCachedMarks(key: string, marks: ReviewMark[]): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  try {
    db.transaction(storeName, 'readwrite')
      .objectStore(storeName)
      .put({ marks, at: Date.now() } satisfies CachedMarks, key);
  } catch {
    // Private mode or a closed database; the cache is optional.
  }
}
