import { describe, expect, test } from 'bun:test';
import type { RepoStatus } from '../shared/types';
import { ForgeError, type ForgeClient } from './forges';
import { compilePatterns, emptyRepoStatus, forgeErrorMessage, inspectRepos, matchingBranches, multiMatchError, splitPatterns } from './validate';

describe('splitPatterns', () => {
  test('splits on top-level commas', () => {
    expect(splitPatterns('^main$, ^release/.*$')).toEqual(['^main$', '^release/.*$']);
  });

  test('keeps commas in quantifiers, classes and escapes', () => {
    expect(splitPatterns('a{1,3}')).toEqual(['a{1,3}']);
    expect(splitPatterns('[a,b]c')).toEqual(['[a,b]c']);
    expect(splitPatterns('a\\,b,c')).toEqual(['a\\,b', 'c']);
  });

  test('ignores empty entries', () => {
    expect(splitPatterns('^main$,,  ,^dev$')).toEqual(['^main$', '^dev$']);
  });
});

describe('compilePatterns', () => {
  test('compiles a single pattern', () => {
    expect(compilePatterns('release/.*').patterns).toHaveLength(1);
  });

  test('compiles a comma separated list', () => {
    expect(compilePatterns('^main$, ^release/v2').patterns).toHaveLength(2);
  });

  test('reports which pattern is invalid', () => {
    const result = compilePatterns('^main$, release/(');
    expect(result.error).toContain('release/(');
    expect(result.patterns).toHaveLength(0);
  });

  test('requires at least one pattern', () => {
    expect(compilePatterns(' , ').error).toBeTruthy();
  });
});

describe('matchingBranches', () => {
  test('matches across all patterns', () => {
    const { patterns } = compilePatterns('^main$, ^release/v2');
    expect(matchingBranches(['release/v2.1', 'release/v3', 'main'], patterns)).toEqual(['release/v2.1', 'main']);
  });
});

describe('multiMatchError', () => {
  const repo = { connectionId: 1, repo: 'owner/name', kind: 'github' as const, host: 'github.com', org: null, branch: null, target: null, position: 0 };

  test('flags more than one matching branch', () => {
    const status: RepoStatus = { ...emptyRepoStatus(repo), accessible: true, matches: ['a', 'b'], branch: null };
    expect(multiMatchError(status)).toContain('2 branches match');
  });

  test('accepts zero or one matches', () => {
    expect(multiMatchError({ ...emptyRepoStatus(repo), accessible: true, matches: [] })).toBeNull();
    expect(multiMatchError({ ...emptyRepoStatus(repo), accessible: true, matches: ['a'], branch: 'a' })).toBeNull();
  });
});

describe('forgeErrorMessage', () => {
  test('explains a GitHub App permission gap', () => {
    const error = new ForgeError(403, 'Resource not accessible by integration');
    expect(forgeErrorMessage(error)).toContain('Contents: write');
  });

  test('keeps other forbidden details', () => {
    expect(forgeErrorMessage(new ForgeError(403, 'upgrade required'))).toBe('access forbidden (upgrade required)');
  });

  test('explains a forge server error', () => {
    expect(forgeErrorMessage(new ForgeError(500, 'Server Error'))).toBe(
      'the forge returned HTTP 500 (Server Error) — retry in a moment',
    );
  });
});


describe('inspectRepos', () => {
  test('reads known per-repo branches without listing every branch', async () => {
    let listed = 0;
    const client = {
      async listBranches() {
        listed += 1;
        return [];
      },
      async getBranch(_repo: string, branch: string) {
        return { name: branch, sha: 'abc123' };
      },
    } as unknown as ForgeClient;
    const repo = {
      connectionId: 1,
      repo: 'owner/name',
      kind: 'github' as const,
      host: 'github.com',
      org: null,
      branch: 'feature',
      target: null,
      position: 0,
    };
    const located = await inspectRepos(new Map([[1, client]]), [repo], { patterns: [], perRepo: true });
    expect(listed).toBe(0);
    expect(located[0].status.branch).toBe('feature');
    expect(located[0].sha).toBe('abc123');
  });
});
