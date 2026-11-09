import { afterAll, expect, test } from 'bun:test';
import type { CompareResult, ForgeClient } from './forges';
import type { ReviewSet as ReviewSetType } from '../shared/types';
import { type ForgeConnectionRow, db } from './db';
import { buildPrStatus } from './pr';

const userId = 92_001;
const connectionId = 92_001;
const reviewSetId = 92_001;
const prId = 92_001;
const repo = 'acme/replace';
let ensured = 0;

const connection = {
  id: connectionId,
  user_id: userId,
  kind: 'github',
  base_url: 'https://github.com',
  client_id: '',
  client_secret: '',
  access_token: 'token',
  refresh_token: '',
  login: 'me',
  avatar_url: '',
  webhook_secret: null,
  installation_id: null,
} as ForgeConnectionRow;

const reviewSet: ReviewSetType = {
  id: reviewSetId,
  name: 'replace set',
  mode: 'pattern',
  branchRegex: '^feature$',
  targetBranch: 'main',
  createdAt: '2026-01-01 00:00:00',
  repos: [{ connectionId, repo, kind: 'github', host: 'github.com', org: null, branch: null, target: null, position: 0 }],
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
  async listBranches() {
    return [
      { name: 'main', sha: 'base' },
      { name: 'feature', sha: 'head' },
    ];
  },
  async getBranch(_repo: string, branch: string) {
    return { name: branch, sha: branch === 'main' ? 'base' : 'head' };
  },
  async compare() {
    return comparison;
  },
  async pullRequestState() {
    return { state: 'closed' as const, head: 'feature', base: 'main' };
  },
  async ensurePullRequest() {
    ensured += 1;
    return { ref: '2', created: true };
  },
  pullRequestUrl(_repo: string, ref: string) {
    return `https://github.com/${repo}/pull/${ref}`;
  },
} as unknown as ForgeClient;

afterAll(() => {
  db.run('DELETE FROM diff_cache WHERE connection_id = ?', [connectionId]);
  db.run('DELETE FROM pull_request_repos WHERE pr_id = ?', [prId]);
  db.run('DELETE FROM pull_requests WHERE id = ?', [prId]);
  db.run('DELETE FROM review_set_repos WHERE review_set_id = ?', [reviewSetId]);
  db.run('DELETE FROM review_sets WHERE id = ?', [reviewSetId]);
  db.run('DELETE FROM forge_connections WHERE id = ?', [connectionId]);
  db.run('DELETE FROM users WHERE id = ?', [userId]);
});

test('a closed tracked pull request is replaced when the branch has new changes', async () => {
  db.run("INSERT INTO users (id, name) VALUES (?, 'replace-user')", [userId]);
  db.run(
    "INSERT INTO forge_connections (id, user_id, kind, base_url, access_token, login) VALUES (?, ?, 'github', 'https://github.com', 'token', 'me')",
    [connectionId, userId],
  );
  db.run(
    "INSERT INTO review_sets (id, owner_id, name, mode, branch_regex, target_branch) VALUES (?, ?, 'replace set', 'pattern', '^feature$', 'main')",
    [reviewSetId, userId],
  );
  db.run('INSERT INTO review_set_repos (review_set_id, connection_id, repo, position) VALUES (?, ?, ?, 0)', [
    reviewSetId,
    connectionId,
    repo,
  ]);
  db.run('INSERT INTO pull_requests (id, review_set_id) VALUES (?, ?)', [prId, reviewSetId]);
  db.run(
    "INSERT INTO pull_request_repos (pr_id, connection_id, repo, position, forge_pr_ref, head_sha) VALUES (?, ?, ?, 0, '1', 'head')",
    [prId, connectionId, repo],
  );

  const status = await buildPrStatus([connection], reviewSet, false, {
    clients: new Map([[connectionId, client]]),
    commits: false,
    discussions: false,
    includeFiles: false,
    ensurePulls: true,
    viewerId: userId,
  });

  expect(ensured).toBe(1);
  expect(status.repos[0].pullRequest?.ref).toBe('2');
  const row = db
    .query<{ forge_pr_ref: string }, [number]>('SELECT forge_pr_ref FROM pull_request_repos WHERE pr_id = ?')
    .get(prId);
  expect(row?.forge_pr_ref).toBe('2');
});
