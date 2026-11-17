import { afterAll, expect, test } from 'bun:test';
import type { CompareResult, ForgeClient } from './forges';
import type { ReviewSet } from '../shared/types';
import { type ForgeConnectionRow, db } from './db';
import { buildPrStatus } from './pr';

const userId = 93_001;
const connectionId = 93_001;
const reviewSetId = 93_001;
const repo = 'acme/existing';
let ensureCalls = 0;

const connection = {
  id: connectionId,
  user_id: userId,
  kind: 'github',
  base_url: 'https://github.com',
  access_token: 'token',
  refresh_token: '',
  login: 'me',
} as ForgeConnectionRow;

const reviewSet: ReviewSet = {
  id: reviewSetId,
  name: 'existing PRs',
  mode: 'pull-requests',
  branchRegex: '',
  targetBranch: 'main',
  createdAt: '2026-01-01 00:00:00',
  repos: [
    {
      connectionId,
      repo,
      kind: 'github',
      host: 'github.com',
      org: null,
      branch: 'feature',
      target: 'main',
      position: 0,
      pullRequest: '5',
    },
  ],
};

const comparison: CompareResult = {
  merged: false,
  aheadBy: 1,
  behindBy: 0,
  files: [{ path: 'src/a.ts', type: 'modified', additions: 1, deletions: 0, patch: null }],
  commits: [],
  truncated: false,
  mergeBase: 'base',
};

const client = {
  async pullRequestState() {
    return { state: 'open' as const, head: 'feature', base: 'main' };
  },
  async getBranch(_repo: string, branch: string) {
    return { name: branch, sha: branch === 'main' ? 'base' : 'head' };
  },
  async compare() {
    return comparison;
  },
  async ensurePullRequest() {
    ensureCalls += 1;
    return { ref: '99', created: true };
  },
  pullRequestUrl(_repo: string, ref: string) {
    return `https://github.com/${repo}/pull/${ref}`;
  },
} as unknown as ForgeClient;

afterAll(() => {
  db.run('DELETE FROM diff_cache WHERE connection_id = ?', [connectionId]);
  db.run('DELETE FROM pull_request_repos WHERE connection_id = ?', [connectionId]);
  db.run('DELETE FROM pull_requests WHERE review_set_id = ?', [reviewSetId]);
  db.run('DELETE FROM review_set_repos WHERE review_set_id = ?', [reviewSetId]);
  db.run('DELETE FROM review_sets WHERE id = ?', [reviewSetId]);
  db.run('DELETE FROM forge_connections WHERE id = ?', [connectionId]);
  db.run('DELETE FROM users WHERE id = ?', [userId]);
});

test('a pull-request review set uses the pasted pull request without creating another', async () => {
  db.run("INSERT INTO users (id, name) VALUES (?, 'pr-import-user')", [userId]);
  db.run(
    "INSERT INTO forge_connections (id, user_id, kind, base_url, access_token, login) VALUES (?, ?, 'github', 'https://github.com', 'token', 'me')",
    [connectionId, userId],
  );
  db.run(
    "INSERT INTO review_sets (id, owner_id, name, mode, branch_regex, target_branch) VALUES (?, ?, 'existing PRs', 'pull-requests', '', 'main')",
    [reviewSetId, userId],
  );
  db.run(
    'INSERT INTO review_set_repos (review_set_id, connection_id, repo, position, branch, target_branch, pull_request_ref) VALUES (?, ?, ?, 0, ?, ?, ?)',
    [reviewSetId, connectionId, repo, 'feature', 'main', '5'],
  );

  const status = await buildPrStatus([connection], reviewSet, false, {
    clients: new Map([[connectionId, client]]),
    commits: false,
    discussions: false,
    includeFiles: false,
    ensurePulls: true,
    viewerId: userId,
  });

  expect(ensureCalls).toBe(0);
  expect(status.repos[0].branch).toBe('feature');
  expect(status.repos[0].target).toBe('main');
  expect(status.repos[0].pullRequest?.ref).toBe('5');
  const row = db
    .query<{ forge_pr_ref: string }, [number]>('SELECT forge_pr_ref FROM pull_request_repos WHERE connection_id = ?')
    .get(connectionId);
  expect(row?.forge_pr_ref).toBe('5');
});
