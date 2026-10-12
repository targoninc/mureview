import { describe, expect, test } from 'bun:test';
import type { RepoStatus } from '../shared/types';
import { compileRegex, emptyRepoStatus, matchingBranches, multiMatchError } from './validate';

describe('compileRegex', () => {
  test('compiles valid patterns', () => {
    expect(compileRegex('release/.*')).toBeInstanceOf(RegExp);
  });

  test('returns null for invalid patterns', () => {
    expect(compileRegex('release/(')).toBeNull();
  });
});

describe('matchingBranches', () => {
  test('filters branch names', () => {
    const regex = compileRegex('^release/v2')!;
    expect(matchingBranches(['release/v2.1', 'release/v3', 'main'], regex)).toEqual(['release/v2.1']);
  });
});

describe('multiMatchError', () => {
  const repo = { connectionId: 1, repo: 'owner/name', kind: 'github' as const, host: 'github.com' };

  test('flags patterns matching more than one branch', () => {
    const status: RepoStatus = { ...emptyRepoStatus(repo), accessible: true, matches: ['a', 'b'], branch: null };
    expect(multiMatchError(status)).toContain('2 branches match');
  });

  test('accepts zero or one matches', () => {
    expect(multiMatchError({ ...emptyRepoStatus(repo), accessible: true, matches: [] })).toBeNull();
    expect(multiMatchError({ ...emptyRepoStatus(repo), accessible: true, matches: ['a'], branch: 'a' })).toBeNull();
  });
});
