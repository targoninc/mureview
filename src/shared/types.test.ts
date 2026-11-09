import { expect, test } from 'bun:test';
import { nothingToMerge } from './types';

const file = { path: 'src/example.ts', type: 'added' as const, additions: 1, deletions: 0, patch: null };

test('repositories with nothing to merge are recognised', () => {
  expect(nothingToMerge({ state: 'no-match', files: [] })).toBe('no-branch');
  expect(nothingToMerge({ state: 'merged', files: [] })).toBe('merged');
  expect(nothingToMerge({ state: 'open', files: [] })).toBe('no-changes');
  expect(nothingToMerge({ state: 'open', files: [file] })).toBeNull();
  expect(nothingToMerge({ state: 'open' })).toBeNull();
  expect(nothingToMerge({ state: 'error' })).toBeNull();
});
