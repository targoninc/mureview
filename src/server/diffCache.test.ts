import { afterAll, expect, test } from 'bun:test';
import type { CommitInfo } from '../shared/types';
import { db } from './db';
import { cachedCompare } from './diffCache';
import type { CompareResult, ForgeClient } from './forges';

const userId = 91_001;
const connectionId = 91_001;
const base = 'base'.repeat(10);
const old = 'old0'.repeat(10);
const next = 'new0'.repeat(10);
const other = 'other'.repeat(8);

function commit(sha: string, date: string): CommitInfo {
  return { sha, message: sha, author: 'me', date };
}

const compareCalls: string[] = [];

const full: CompareResult = {
  merged: false,
  aheadBy: 1,
  behindBy: 0,
  files: [
    { path: 'a.txt', type: 'modified', additions: 1, deletions: 1, patch: 'a-patch' },
    { path: 'unchanged.txt', type: 'modified', additions: 1, deletions: 0, patch: 'unchanged-patch' },
  ],
  commits: [commit(old, '2026-01-01T00:00:00Z')],
  truncated: false,
  mergeBase: base,
};

const delta: CompareResult = {
  merged: false,
  aheadBy: 1,
  behindBy: 0,
  files: [
    { path: 'a.txt', type: 'modified', additions: 1, deletions: 1, patch: 'a-delta' },
    { path: 'b.txt', type: 'added', additions: 1, deletions: 0, patch: 'b-patch' },
  ],
  commits: [commit(next, '2026-01-02T00:00:00Z')],
  truncated: false,
  mergeBase: old,
};

const client = {
  async compare(_repo: string, baseSha: string, headSha: string): Promise<CompareResult> {
    compareCalls.push(`${baseSha}...${headSha}`);
    if (baseSha === base && headSha === old) return full;
    if (baseSha === old && headSha === next) return delta;
    if (baseSha === base && headSha === next) return { ...full, aheadBy: 2, commits: [commit(next, '2026-01-02T00:00:00Z'), ...full.commits] };
    if (baseSha === next && headSha === other) return { ...delta, behindBy: 1, mergeBase: next };
    return { merged: false, aheadBy: 0, behindBy: 0, files: [], commits: [], truncated: false };
  },
  async listBlobs(_repo: string, sha: string) {
    if (sha === base) {
      return { blobs: [{ path: 'a.txt', sha: 'a-base', size: 10 }, { path: 'unchanged.txt', sha: 'u-base', size: 10 }], truncated: false };
    }
    return {
      blobs: [
        { path: 'a.txt', sha: 'a-next', size: 10 },
        { path: 'b.txt', sha: 'b-next', size: 10 },
        { path: 'unchanged.txt', sha: 'u-next', size: 10 },
      ],
      truncated: false,
    };
  },
  async getBlobText(_repo: string, sha: string) {
    if (sha === 'a-base') return 'one\n';
    if (sha === 'a-next') return 'two\n';
    if (sha === 'b-next') return 'bee\n';
    return 'same\n';
  },
  async mergeBase() {
    return old;
  },
} as unknown as ForgeClient;

afterAll(() => {
  db.run('DELETE FROM diff_cache WHERE connection_id = ?', [connectionId]);
  db.run('DELETE FROM forge_connections WHERE id = ?', [connectionId]);
  db.run('DELETE FROM users WHERE id = ?', [userId]);
});

test('a comparison is cached and a new head only recomputes the delta', async () => {
  db.run("INSERT OR IGNORE INTO users (id, name) VALUES (?, 'diff-cache')", [userId]);
  db.run(
    "INSERT OR IGNORE INTO forge_connections (id, user_id, kind, base_url, access_token, login) VALUES (?, ?, 'github', 'https://github.com', 'token', 'me')",
    [connectionId, userId],
  );

  const first = await cachedCompare(client, connectionId, 'acme/repo', base, old);
  expect(first.comparison.files.map((file) => file.path)).toEqual(['a.txt', 'unchanged.txt']);
  expect(first.commits.map((entry) => entry.sha)).toEqual([old]);
  const callsAfterFull = compareCalls.length;

  const same = await cachedCompare(client, connectionId, 'acme/repo', base, old);
  expect(same.comparison.files.map((file) => file.path)).toEqual(['a.txt', 'unchanged.txt']);
  expect(compareCalls.length).toBe(callsAfterFull);

  const updated = await cachedCompare(client, connectionId, 'acme/repo', base, next);
  expect(compareCalls).toContain(`${old}...${next}`);
  expect(compareCalls).not.toContain(`${base}...${next}`);
  expect(updated.comparison.aheadBy).toBe(2);
  expect(updated.comparison.files.find((file) => file.path === 'a.txt')?.patch).toContain('two');
  expect(updated.comparison.files.some((file) => file.path === 'b.txt')).toBe(true);
  expect(updated.comparison.files.some((file) => file.path === 'unchanged.txt')).toBe(true);
  expect(updated.commits.map((entry) => entry.sha)).toEqual([next, old]);
});

test('a non-ancestor head falls back to a full comparison', async () => {
  await cachedCompare(client, connectionId, 'acme/repo', base, next);
  const calls = compareCalls.length;
  const result = await cachedCompare(client, connectionId, 'acme/repo', base, other);
  expect(compareCalls.length).toBeGreaterThan(calls);
  expect(compareCalls).toContain(`${base}...${other}`);
  expect(result.comparison.aheadBy).toBe(0);
});
