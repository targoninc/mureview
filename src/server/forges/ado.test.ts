import { afterAll, expect, test } from 'bun:test';
import { AdoClient } from './ado';

interface AdoCommit {
  commitId: string;
  comment: string;
  author: { name: string; date: string };
  remoteUrl: string;
}

const commit = (id: number, date: string): AdoCommit => ({
  commitId: `sha${String(id).padStart(4, '0')}`,
  comment: `commit ${id}\n\nmore detail`,
  author: { name: `author ${id}`, date },
  remoteUrl: `https://dev.azure.com/acme/Proj/_git/Repo/commit/${id}`,
});

const requests: string[] = [];
const bodies: { method: string; body?: { description?: string; sourceRefName?: string }; source?: string | null }[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    requests.push(url.pathname + url.search);

    if (url.pathname === '/_apis/identities/8c8c8c8c-1a2b-3c4d-5e6f-7a8b9c0d1e2f') {
      return Response.json({ id: '8c8c8c8c-1a2b-3c4d-5e6f-7a8b9c0d1e2f', providerDisplayName: 'Lena Muster' });
    }

    if (url.pathname.endsWith('/_apis/connectionData')) {
      const credentials = req.headers.get('authorization') ?? '';
      const plain = credentials === `Basic ${Buffer.from(':no-avatar').toString('base64')}`;
      return Response.json({
        instanceId: 'org-1',
        authenticatedUser: {
          id: 'user-1',
          providerDisplayName: 'Loudar',
          customDisplayName: 'loudar',
          ...(plain ? {} : { _links: { avatar: { href: `http://localhost:${url.port}/avatars/self.png` } } }),
        },
      });
    }

    if (url.pathname.endsWith('/_apis/tokens/pats')) {
      const credentials = req.headers.get('authorization') ?? '';
      if (credentials === `Basic ${Buffer.from(':empty-token').toString('base64')}`) {
        return Response.json({ patTokens: [] });
      }
      const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
      return Response.json({
        patTokens: [
          { displayName: 'expired', scope: 'vso.code', validTo: inDays(-1), targetAccounts: null },
          { displayName: 'other-org', scope: 'vso.code', validTo: inDays(1), targetAccounts: ['org-9'] },
          { displayName: 'work-only', scope: 'vso.work', validTo: inDays(2), targetAccounts: ['org-1'] },
          { displayName: 'mureview', scope: 'vso.code_write vso.project', validTo: inDays(5), targetAccounts: ['org-1'] },
          { displayName: 'full', scope: 'app_token', validTo: inDays(30), targetAccounts: null },
        ],
      });
    }

    if (url.pathname === '/Proj/_apis/git/repositories/Repo/pullrequests/7/threads') {
      return Response.json({
        id: 12,
        comments: [
          {
            id: 34,
            author: {
              displayName: 'Lena Muster',
              _links: { avatar: { href: `http://localhost:${url.port}/avatars/lena.png` } },
            },
          },
        ],
      });
    }

    if (url.pathname === '/Proj/_apis/git/repositories/Repo/pullrequests/7/threads/12/comments') {
      return Response.json({
        id: 35,
        author: { displayName: 'Lena Muster', imageUrl: `http://localhost:${url.port}/avatars/lena.png` },
      });
    }

    if (url.pathname === '/Proj/_apis/git/repositories/Repo/pullrequests/7/threads/12/comments/35' && req.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/Proj/_apis/git/repositories/Repo/pullrequests') {
      if (req.method === 'POST') {
        const body = (await req.json()) as { sourceRefName?: string; description?: string };
        bodies.push({ method: 'POST', body });
        if (body.sourceRefName !== 'refs/heads/feature/new') return Response.json({ message: 'exists' }, { status: 409 });
        return Response.json({ pullRequestId: 21, status: 'active', description: body.description });
      }
      const source = url.searchParams.get('searchCriteria.sourceRefName');
      bodies.push({ method: 'GET', source });
      return Response.json({
        value: [
          {
            pullRequestId: 12,
            status: 'active',
            description: source?.includes('feature/already')
              ? 'Has https://mureview.example.com/review-sets/1 inside'
              : 'Existing description',
          },
        ],
      });
    }

    if (url.pathname === '/Proj/_apis/git/repositories/Repo/pullrequests/12' && req.method === 'PATCH') {
      const body = (await req.json()) as { description?: string };
      bodies.push({ method: 'PATCH', body });
      return Response.json({ pullRequestId: 12, status: 'active', description: body.description });
    }

    if (url.pathname === '/Proj/_apis/git/repositories/Repo/pullrequests/7/commits') {
      const skip = Number(url.searchParams.get('$skip') ?? 0);
      if (skip === 0) {
        const page = Array.from({ length: 100 }, (_, index) => commit(index + 20, '2026-01-02T00:00:00Z'));
        return Response.json(page);
      }
      return Response.json(Array.from({ length: 20 }, (_, index) => commit(index, '2026-01-01T00:00:00Z')));
    }

    if (url.pathname === '/Proj/_apis/git/repositories/Repo/pullrequests/8/commits') {
      return Response.json({ message: 'not found' }, { status: 404 });
    }

    if (url.pathname === '/Proj/_apis/git/repositories/Repo/commits') {
      if (url.searchParams.get('continuationToken')) {
        return Response.json({ value: [commit(1, '2026-01-01T00:00:00Z')] });
      }
      return Response.json(
        { count: 3, value: [commit(4, '2026-01-04T00:00:00Z'), commit(3, '2026-01-03T00:00:00Z'), commit(2, '2026-01-02T00:00:00Z')] },
        { headers: { 'x-ms-continuationtoken': 'next' } },
      );
    }

    return Response.json({ message: 'unexpected request' }, { status: 500 });
  },
});

const client = new AdoClient(`http://localhost:${server.port}`, 'token');

test('uses the pull request commits endpoint and pages through them, newest first', async () => {
  requests.length = 0;
  const commits = await client.listCommits('Proj/Repo', { headSha: 'head', pullRequest: '7', limit: 200 });

  expect(commits).toHaveLength(120);
  expect(commits[0]!.sha).toBe('sha0020');
  expect(commits.at(-1)!.sha).toBe('sha0019');
  expect(requests).toEqual([
    '/Proj/_apis/git/repositories/Repo/pullrequests/7/commits?$top=100&$skip=0&api-version=7.1',
    '/Proj/_apis/git/repositories/Repo/pullrequests/7/commits?$top=100&$skip=100&api-version=7.1',
  ]);
});

test('falls back to the branch comparison when the pull request is gone', async () => {
  requests.length = 0;
  const commits = await client.listCommits('Proj/Repo', { headSha: 'head', baseSha: 'base', pullRequest: '8' });

  expect(commits.map((entry) => entry.sha)).toEqual(['sha0004', 'sha0003', 'sha0002', 'sha0001']);
  expect(requests[0]).toContain('/pullrequests/8/commits');
  expect(requests[1]).toContain('searchCriteria.compareVersion.version=base');
  expect(requests).toHaveLength(3);
});

test('reports the account a comment was posted under', async () => {
  const avatar = `http://localhost:${server.port}/avatars/lena.png`;
  const posted = await client.postReviewComment('Proj/Repo', '7', { body: 'hi', path: 'src/a.ts', line: 3, side: 'additions' });
  expect(posted).toEqual({ kind: 'line', id: '12:34', author: { name: 'Lena Muster', avatarUrl: avatar } });

  const reply = await client.postReviewComment('Proj/Repo', '7', {
    body: 're',
    path: 'src/a.ts',
    line: 3,
    side: 'additions',
    replyTo: '12:34',
  });
  expect(reply).toEqual({ kind: 'line', id: '12:35', author: { name: 'Lena Muster', avatarUrl: avatar } });
});

const url = 'https://mureview.example.com/review-sets/1';

test('creates a pull request with the mureview link in the description', async () => {
  bodies.length = 0;
  const pull = await client.ensurePullRequest('Proj/Repo', 'main', 'feature/new', 'Merge feature', 'Review set: X', url);
  expect(pull).toEqual({ ref: '21', created: true });
  const post = bodies.find((entry) => entry.method === 'POST');
  expect(post?.body?.description).toBe(`Review set: X\n\nOpen in mureview: ${url}`);
});

test('appends the mureview link to an existing description', async () => {
  bodies.length = 0;
  const pull = await client.ensurePullRequest('Proj/Repo', 'main', 'feature/cool', 'Merge feature', 'Review set: X', url);
  expect(pull).toEqual({ ref: '12', created: false });
  const patch = bodies.find((entry) => entry.method === 'PATCH');
  expect(patch?.body?.description).toBe(`Existing description\n\nOpen in mureview: ${url}`);
});

test('leaves a description that already links to mureview alone', async () => {
  bodies.length = 0;
  const pull = await client.ensurePullRequest('Proj/Repo', 'main', 'feature/already', 'Merge feature', 'Review set: X', url);
  expect(pull).toEqual({ ref: '12', created: false });
  expect(bodies.some((entry) => entry.method === 'PATCH')).toBe(false);
});

test('deletes a thread comment on the forge', async () => {
  requests.length = 0;
  await client.deleteComment('Proj/Repo', '7', '12:35');
  expect(requests[0]).toContain('/pullrequests/7/threads/12/comments/35');
  expect(requests[0]).toContain('api-version=7.1');
});

test('names the account behind a mention id', async () => {
  requests.length = 0;
  const mention = await client.resolveMention('8c8c8c8c-1a2b-3c4d-5e6f-7a8b9c0d1e2f');
  expect(mention).toEqual({ name: 'Lena Muster' });
  expect(requests[0]).toContain('/_apis/identities/8c8c8c8c-1a2b-3c4d-5e6f-7a8b9c0d1e2f');
  expect(requests[0]).toContain('api-version=7.1');
  expect(await client.resolveMention('not-an-id')).toBeNull();
});

test('finds the account avatar from connectionData', async () => {
  const account = await client.currentUser();
  expect(account).toEqual({ id: 'user-1', name: 'loudar', avatarUrl: `http://localhost:${server.port}/avatars/self.png` });
});

test('falls back to the identity image endpoint without an avatar link', async () => {
  const plain = new AdoClient(`http://localhost:${server.port}`, 'no-avatar');
  expect((await plain.currentUser()).avatarUrl).toBe(`http://localhost:${server.port}/_api/_common/identityImage?id=user-1`);
});

test('picks the soonest expiring code token for the organization', async () => {
  const expiry = await client.tokenExpiry();

  expect(expiry?.displayName).toBe('mureview');
  const days = Math.round((new Date(expiry!.validTo).getTime() - Date.now()) / 86_400_000);
  expect(days).toBe(5);
});

test('reports no expiry when no suitable token exists', async () => {
  const empty = new AdoClient(`http://localhost:${server.port}`, 'empty-token');
  expect(await empty.tokenExpiry()).toBeNull();
});

afterAll(() => {
  server.stop(true);
});
