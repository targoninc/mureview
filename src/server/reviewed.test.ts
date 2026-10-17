import { describe, expect, test } from 'bun:test';
import type { RepoStatus } from '../shared/types';
import { db } from './db';
import { ForgeError, type ForgeClient } from './forges';
import { listReviewed, resetMarksForNewCommits } from './reviewed';

function addUser(name: string): number {
  const inserted = db.run('INSERT INTO users (name) VALUES (?)', [name]);
  return Number(inserted.lastInsertRowid);
}

let nextId = 50_001;

/** A review set with one open pull request and a tracked layer. */
function setup(headSha: string): { prId: number; connectionId: number; repo: string; owner: number; other: number } {
  const owner = addUser('reset-owner');
  const other = addUser('reset-other');
  const connectionId = nextId++;
  const setId = nextId++;
  const prId = nextId++;
  const repo = 'acme/reset';
  db.run(
    "INSERT INTO review_sets (id, owner_id, name, mode, branch_regex, target_branch) VALUES (?, ?, 'reset set', 'pattern', '^feature$', 'main')",
    [setId, owner],
  );
  db.run('INSERT INTO pull_requests (id, review_set_id) VALUES (?, ?)', [prId, setId]);
  db.run(
    "INSERT INTO pull_request_repos (pr_id, connection_id, repo, position, forge_pr_ref, head_sha) VALUES (?, ?, ?, 0, '1', ?)",
    [prId, connectionId, repo, headSha],
  );
  return { prId, connectionId, repo, owner, other };
}

function mark(prId: number, userId: number, connectionId: number, repo: string, path: string): void {
  db.run('INSERT INTO reviewed_files (pr_id, user_id, connection_id, repo, position, path) VALUES (?, ?, ?, ?, 0, ?)', [
    prId,
    userId,
    connectionId,
    repo,
    path,
  ]);
}

function status(connectionId: number, repo: string, headSha: string): RepoStatus {
  return {
    connectionId,
    kind: 'github',
    host: 'github.com',
    org: null,
    repo,
    accessible: true,
    matches: ['feature'],
    branch: 'feature',
    target: 'main',
    position: 0,
    targetExists: true,
    state: 'open',
    headSha,
  };
}

function clientThatChanges(connectionId: number, paths: string[]): Map<number, ForgeClient> {
  const client = {
    compare: async (_repo: string, baseSha: string, headSha: string) => {
      if (baseSha !== 'oldsha' || headSha !== 'newsha') throw new Error(`unexpected compare ${baseSha}...${headSha}`);
      return {
        merged: false,
        aheadBy: 1,
        behindBy: 0,
        files: paths.map((path) => ({ path, type: 'modified' as const, additions: 1, deletions: 1, patch: null })),
        commits: [],
        truncated: false,
      };
    },
  } as unknown as ForgeClient;
  return new Map([[connectionId, client]]);
}

function storedHead(prId: number, connectionId: number, repo: string): string | null {
  return (
    db
      .query<{ head_sha: string }, [number, number, string]>(
        'SELECT head_sha FROM pull_request_repos WHERE pr_id = ? AND connection_id = ? AND repo = ? AND position = 0',
      )
      .get(prId, connectionId, repo)?.head_sha ?? null
  );
}

describe('resetMarksForNewCommits', () => {
  test('a new commit unmarks the files it changed, for everyone', async () => {
    const { prId, connectionId, repo, owner, other } = setup('oldsha');
    mark(prId, owner, connectionId, repo, 'src/changed.ts');
    mark(prId, owner, connectionId, repo, 'src/unchanged.ts');
    mark(prId, other, connectionId, repo, 'src/changed.ts');

    await resetMarksForNewCommits(clientThatChanges(connectionId, ['src/changed.ts']), [status(connectionId, repo, 'newsha')], prId);

    expect(listReviewed(prId, owner).map((mark) => mark.path)).toEqual(['src/unchanged.ts']);
    expect(listReviewed(prId, other)).toEqual([]);
    expect(storedHead(prId, connectionId, repo)).toBe('newsha');
  });

  test('an unchanged head keeps every mark', async () => {
    const { prId, connectionId, repo, owner } = setup('newsha');
    mark(prId, owner, connectionId, repo, 'src/changed.ts');

    await resetMarksForNewCommits(clientThatChanges(connectionId, ['src/changed.ts']), [status(connectionId, repo, 'newsha')], prId);

    expect(listReviewed(prId, owner).map((mark) => mark.path)).toEqual(['src/changed.ts']);
  });

  test('a force push whose old commit is gone resets the whole layer', async () => {
    const { prId, connectionId, repo, owner, other } = setup('oldsha');
    mark(prId, owner, connectionId, repo, 'src/changed.ts');
    mark(prId, owner, connectionId, repo, 'src/unchanged.ts');
    mark(prId, other, connectionId, repo, 'src/unchanged.ts');

    const broken = { compare: async () => { throw new ForgeError(404, 'commit not found'); } } as unknown as ForgeClient;
    await resetMarksForNewCommits(new Map([[connectionId, broken]]), [status(connectionId, repo, 'rewritten')], prId);

    expect(listReviewed(prId, owner)).toEqual([]);
    expect(listReviewed(prId, other)).toEqual([]);
    expect(storedHead(prId, connectionId, repo)).toBe('rewritten');
  });

  test('a failed compare keeps the marks and the old head for a later retry', async () => {
    const { prId, connectionId, repo, owner } = setup('oldsha');
    mark(prId, owner, connectionId, repo, 'src/changed.ts');

    const broken = { compare: async () => { throw new Error('network down'); } } as unknown as ForgeClient;
    await resetMarksForNewCommits(new Map([[connectionId, broken]]), [status(connectionId, repo, 'newsha')], prId);

    expect(listReviewed(prId, owner).map((mark) => mark.path)).toEqual(['src/changed.ts']);
    expect(storedHead(prId, connectionId, repo)).toBe('oldsha');
  });

  test('marks of other layers and pull requests stay', async () => {
    const { prId, connectionId, repo, owner } = setup('oldsha');
    const otherSet = setup('oldsha');
    mark(prId, owner, connectionId, repo, 'src/changed.ts');
    db.run('INSERT INTO reviewed_files (pr_id, user_id, connection_id, repo, position, path) VALUES (?, ?, ?, ?, 1, ?)', [
      prId,
      owner,
      connectionId,
      repo,
      'src/layer-two.ts',
    ]);
    mark(otherSet.prId, owner, otherSet.connectionId, otherSet.repo, 'src/changed.ts');

    await resetMarksForNewCommits(clientThatChanges(connectionId, ['src/changed.ts']), [status(connectionId, repo, 'newsha')], prId);

    expect(listReviewed(prId, owner).map((mark) => mark.path)).toEqual(['src/layer-two.ts']);
    expect(listReviewed(otherSet.prId, owner).map((mark) => mark.path)).toEqual(['src/changed.ts']);
  });
});
