import { afterAll, expect, test } from 'bun:test';
import { upsertConnection } from './auth/identities';
import { type ForgeConnectionRow, type UserRow, db } from './db';
import { mergeReviewSet, streamMergePreview } from './merge';
import { canManageRepoList } from './permissions';
import { updateReviewSet } from './reviewSets';
import type { Ctx } from './router';

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Answers the GitHub calls a review set load makes, with the given repo permissions. */
function stubGithub(permissions: { push?: boolean; admin?: boolean; maintain?: boolean } | null): void {
  globalThis.fetch = (async (input: unknown) => {
    const path = new URL(String(input)).pathname;
    if (/\/branches\/[^/]+$/.test(path)) return Response.json({ name: 'main', commit: { sha: 'sha1' } });
    if (/\/branches$/.test(path)) return Response.json([{ name: 'main', commit: { sha: 'sha1' } }]);
    if (path.includes('/compare/')) {
      return Response.json({ status: 'identical', ahead_by: 0, behind_by: 0, files: [], commits: [], merge_base_commit: { sha: 'sha1' } });
    }
    return Response.json({ full_name: 'acme/repo', permissions });
  }) as unknown as typeof fetch;
}

function addUser(name: string): number {
  const inserted = db.run('INSERT INTO users (name) VALUES (?)', [name]);
  return Number(inserted.lastInsertRowid);
}

function githubConnection(userId: number, login: string, host: string): ForgeConnectionRow {
  return upsertConnection(userId, { kind: 'github', baseUrl: host, accessToken: `token-${login}`, login });
}

let nextReviewSetId = 10_001;

function insertReviewSet(ownerId: number, connectionId: number, repo: string): number {
  // Explicit ids keep clear of the preload's dangling repository row.
  const id = nextReviewSetId++;
  db.run("INSERT INTO review_sets (id, owner_id, name, mode, branch_regex, target_branch) VALUES (?, ?, 'perm set', 'pattern', '^main$', 'main')", [
    id,
    ownerId,
  ]);
  db.run('INSERT INTO review_set_repos (review_set_id, connection_id, repo, position) VALUES (?, ?, ?, 0)', [id, connectionId, repo]);
  return id;
}

function userCtx(userId: number, params: Record<string, string> = {}, body?: unknown): Ctx {
  const url = new URL('http://localhost/api/review-sets');
  const user = db.query<UserRow, [number]>('SELECT * FROM users WHERE id = ?').get(userId)!;
  return {
    req: new Request(url, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
    url,
    path: '/api/review-sets',
    params,
    user,
  };
}

test('canManageRepoList requires write permission on every repository', async () => {
  const owner = addUser('perm-owner-a');
  const ownerConnection = githubConnection(owner, 'perm-owner-a', 'https://perm-a.example');
  const repos = [
    { connectionId: ownerConnection.id, repo: 'acme/perm-a-1' },
    { connectionId: ownerConnection.id, repo: 'acme/perm-a-2' },
  ];

  stubGithub({ push: true });
  expect(await canManageRepoList(owner, repos, [ownerConnection])).toBe(true);

  const reader = addUser('perm-reader-a');
  const readerConnection = githubConnection(reader, 'perm-reader-a', 'https://perm-a.example');
  stubGithub({});
  expect(await canManageRepoList(reader, repos, [ownerConnection, readerConnection])).toBe(false);
});

test('canManageRepoList refuses without a matching connection or when the forge cannot tell', async () => {
  const owner = addUser('perm-owner-b');
  const actor = addUser('perm-actor-b');
  const ownerConnection = githubConnection(owner, 'perm-owner-b', 'https://perm-b.example');
  const repos = [{ connectionId: ownerConnection.id, repo: 'acme/perm-b' }];

  stubGithub({ push: true });
  expect(await canManageRepoList(actor, repos, [ownerConnection])).toBe(false);

  const otherHost = githubConnection(actor, 'perm-actor-b', 'https://perm-b-other.example');
  expect(await canManageRepoList(actor, repos, [ownerConnection, otherHost])).toBe(false);

  const matching = githubConnection(actor, 'perm-actor-b2', 'https://perm-b.example');
  stubGithub(null);
  expect(await canManageRepoList(actor, repos, [ownerConnection, matching])).toBe(true);
});

test('updateReviewSet is refused without merge permission, also for the owner', async () => {
  const owner = addUser('perm-owner-c');
  const reader = addUser('perm-actor-c');
  const ownerConnection = githubConnection(owner, 'perm-owner-c', 'https://perm-c.example');
  githubConnection(reader, 'perm-actor-c', 'https://perm-c.example');
  const id = insertReviewSet(owner, ownerConnection.id, 'acme/perm-c');
  const body = {
    name: 'renamed',
    mode: 'pattern',
    repos: [{ connectionId: ownerConnection.id, repo: 'acme/perm-c' }],
    branchRegex: '^main$',
    targetBranch: 'main',
  };

  stubGithub({});
  await expect(updateReviewSet(userCtx(reader, { id: String(id) }, body))).rejects.toThrow('merge permission');
  await expect(updateReviewSet(userCtx(owner, { id: String(id) }, body))).rejects.toThrow('merge permission');
});

test('a non-owner with merge permission edits settings and repos stay bound to the owner', async () => {
  const owner = addUser('perm-owner-d');
  const manager = addUser('perm-actor-d');
  const ownerConnection = githubConnection(owner, 'perm-owner-d', 'https://perm-d.example');
  const managerConnection = githubConnection(manager, 'perm-actor-d', 'https://perm-d.example');
  const id = insertReviewSet(owner, ownerConnection.id, 'acme/perm-d');

  stubGithub({ push: true });
  const response = await updateReviewSet(
    userCtx(manager, { id: String(id) }, {
      name: 'edited by a manager',
      mode: 'pattern',
      repos: [{ connectionId: managerConnection.id, repo: 'acme/perm-d' }],
      branchRegex: '^main$',
      targetBranch: 'main',
    }),
  );
  const { detail } = (await response.json()) as { detail: { reviewSet: { name: string }; owned: boolean; canManage: boolean } };
  expect(detail.reviewSet.name).toBe('edited by a manager');
  expect(detail.owned).toBe(false);
  expect(detail.canManage).toBe(true);

  const row = db
    .query<{ connection_id: number }, [number]>('SELECT connection_id FROM review_set_repos WHERE review_set_id = ?')
    .get(id);
  expect(row?.connection_id).toBe(ownerConnection.id);
});

test('merging is refused without merge permission', async () => {
  const owner = addUser('perm-owner-e');
  const reader = addUser('perm-actor-e');
  const ownerConnection = githubConnection(owner, 'perm-owner-e', 'https://perm-e.example');
  githubConnection(reader, 'perm-actor-e', 'https://perm-e.example');
  const id = insertReviewSet(owner, ownerConnection.id, 'acme/perm-e');

  stubGithub({});
  await expect(mergeReviewSet(userCtx(reader, { id: String(id) }))).rejects.toThrow('merge permission');
  await expect(streamMergePreview(userCtx(reader, { id: String(id) }))).rejects.toThrow('merge permission');
});
